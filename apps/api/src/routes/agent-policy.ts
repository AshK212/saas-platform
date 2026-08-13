import {
  agentPolicyMutationRequestSchema,
  agentPolicyResponseSchema,
} from '@hybrid/contracts';
import type { AuthorizedWorkspace } from '@hybrid/db';
import { Hono, type Context } from 'hono';

import { requireAuthenticatedUser } from '../auth/middleware.js';
import type { AuthService } from '../auth/service.js';
import type { PolicyMutationStore } from '../policy/mutation-store.js';
import type { WorkspaceStore } from '../workspaces/store.js';

/**
 * Operator agent-policy read and mutation (Step 13).
 *
 * THE ONLY POLICY WRITE SURFACE IN THE SYSTEM
 * -------------------------------------------
 *   session cookie -> AuthenticatedUser -> membership -> role == operator
 *                  -> AuthorizedWorkspace -> WorkspaceScope
 *                  -> versioned mutation transaction
 *
 * Every other path that touches the data layer - event ingest, agent
 * registration, API-key authentication, `/v1/policy` polling, and the future
 * share and demo routes - can only read policy. A runtime must never be able to
 * edit the governance it is subject to, which is why the write requires a
 * BROWSER SESSION and an API key is refused outright.
 *
 * OPERATOR-ONLY FOR WRITES, MEMBER-OK FOR READS
 * ---------------------------------------------
 * Reading a policy is ordinary tenant data, like the agent roster. Changing one
 * is governance, so it follows the API-key management rule: `operator` only,
 * and a `member` gets 403 rather than 404 - they already legitimately know the
 * workspace exists, so hiding it would be theatre.
 *
 * CSRF: the app-level origin guard covers PUT on `/v1/*`, so a cross-origin
 * form post carrying the victim's cookie is rejected before this handler runs.
 *
 * NOT ENFORCEMENT. Storing `paused` pauses nothing; storing a cap blocks
 * nothing. No ledger row is created, adjusted or reset - raising a cap must not
 * erase today's committed spend. No receipts, no blocks, no events.
 */

const SERVICE_UNAVAILABLE = 503;
const NOT_FOUND = 404;
const FORBIDDEN = 403;
const BAD_REQUEST = 400;

const UNAVAILABLE_BODY = { error: 'policy_unavailable' } as const;
const NOT_FOUND_BODY = { error: 'not_found' } as const;
const FORBIDDEN_ROLE_BODY = { error: 'insufficient_role' } as const;
const INVALID_POLICY_BODY = { error: 'invalid_policy' } as const;

const AGENT_POLICY_PATH = '/v1/workspaces/:workspaceId/agents/:agentId/policy';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface AgentPolicyRouteOptions {
  readonly policyMutationStore: PolicyMutationStore | undefined;
  readonly workspaceStore: WorkspaceStore | undefined;
  readonly authService: AuthService | undefined;
}

export function createAgentPolicyRoutes(options: AgentPolicyRouteOptions): Hono {
  const routes = new Hono();
  const { policyMutationStore, workspaceStore, authService } = options;

  /**
   * Session -> membership -> optional role check.
   *
   * @param requireOperator - true for writes. Reads accept any member.
   */
  async function requireWorkspace(
    c: Context,
    requireOperator: boolean,
  ): Promise<{ ok: true; authorized: AuthorizedWorkspace } | { ok: false; response: Response }> {
    // Cookie only. An API key is never consulted on this route, so a machine
    // credential cannot reach the mutation path at all.
    const auth = await requireAuthenticatedUser(c, authService);
    if (!auth.ok) {
      return { ok: false, response: auth.response };
    }
    if (workspaceStore === undefined) {
      return { ok: false, response: c.json(UNAVAILABLE_BODY, SERVICE_UNAVAILABLE) };
    }

    const authorized = await workspaceStore.authorize(
      auth.user.userId,
      c.req.param('workspaceId') ?? '',
    );
    if (authorized === null) {
      // Covers "no such workspace" and "not yours" alike.
      return { ok: false, response: c.json(NOT_FOUND_BODY, NOT_FOUND) };
    }

    if (requireOperator && authorized.workspace.role !== 'operator') {
      return { ok: false, response: c.json(FORBIDDEN_ROLE_BODY, FORBIDDEN) };
    }

    return { ok: true, authorized };
  }

  /**
   * Screens the agent id before it reaches SQL.
   *
   * PostgreSQL raises a type error comparing a non-UUID to a uuid column, which
   * would surface as a 500 and thereby distinguish "malformed" from "not
   * yours". Screening here keeps every failure an identical 404.
   */
  function readAgentId(c: Context): string | null {
    const agentId = c.req.param('agentId') ?? '';
    return UUID_PATTERN.test(agentId) ? agentId : null;
  }

  /**
   * GET .../policy - the current EFFECTIVE policy, for the operator editor.
   *
   * Any member may read. Deliberately minimal: one agent, the same effective
   * values `GET /v1/policy` would report, so the editor cannot show something
   * different from what the agent sees.
   */
  routes.get(AGENT_POLICY_PATH, async (c) => {
    if (policyMutationStore === undefined) {
      return c.json(UNAVAILABLE_BODY, SERVICE_UNAVAILABLE);
    }

    const gate = await requireWorkspace(c, false);
    if (!gate.ok) {
      return gate.response;
    }

    const agentId = readAgentId(c);
    if (agentId === null) {
      return c.json(NOT_FOUND_BODY, NOT_FOUND);
    }

    const result = await policyMutationStore.getAgentPolicy(gate.authorized, agentId);
    if (result === null) {
      return c.json(NOT_FOUND_BODY, NOT_FOUND);
    }

    return c.json(agentPolicyResponseSchema.parse(result));
  });

  /**
   * PUT .../policy - replace one agent's complete policy.
   *
   * PUT rather than PATCH: the body is the whole policy, so "clear the spend
   * cap" is expressible and cannot be confused with "leave it unchanged".
   *
   * The response carries the committed version, produced by the SAME
   * transaction as the policy write - so a caller can never see a changed
   * policy reported at a stale version.
   */
  routes.put(AGENT_POLICY_PATH, async (c) => {
    if (policyMutationStore === undefined) {
      return c.json(UNAVAILABLE_BODY, SERVICE_UNAVAILABLE);
    }

    const gate = await requireWorkspace(c, true);
    if (!gate.ok) {
      return gate.response;
    }

    const agentId = readAgentId(c);
    if (agentId === null) {
      return c.json(NOT_FOUND_BODY, NOT_FOUND);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(INVALID_POLICY_BODY, BAD_REQUEST);
    }

    // Strict: unknown fields, a client-supplied `version`, a `workspace_id` or
    // a float spend cap are all rejected before anything is written.
    const parsed = agentPolicyMutationRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(INVALID_POLICY_BODY, BAD_REQUEST);
    }

    const result = await policyMutationStore.setAgentPolicy(
      gate.authorized,
      agentId,
      parsed.data,
    );
    if (result === null) {
      // Another tenant's agent id reads exactly like a nonexistent one, and
      // nothing was written or incremented.
      return c.json(NOT_FOUND_BODY, NOT_FOUND);
    }

    return c.json(agentPolicyResponseSchema.parse(result));
  });

  return routes;
}
