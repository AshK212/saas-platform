import {
  AGENT_REGISTER_PATH,
  agentListResponseSchema,
  agentResponseSchema,
  registerAgentRequestSchema,
  registerAgentResponseSchema,
  type AgentSummary,
} from '@hybrid/contracts';
import type { AgentRow } from '@hybrid/db';
import { Hono, type Context } from 'hono';

import type { AgentStore } from '../agents/store.js';
import { apiKeyUnauthorizedBody, authenticateApiKeyRequest } from '../api-keys/authenticate.js';
import type { ApiKeyStore } from '../api-keys/store.js';
import type { Clock } from '../auth/clock.js';
import { requireAuthenticatedUser } from '../auth/middleware.js';
import type { AuthService } from '../auth/service.js';
import type { GovernanceReadStore } from '../governance/read-store.js';
import type { WorkspaceStore } from '../workspaces/store.js';

/**
 * Agent registry routes.
 *
 * TWO AUTHENTICATION DOMAINS, PRESERVED FROM STEP 7
 * -------------------------------------------------
 *   Machine registration   Authorization: Bearer <key> -> credential row
 *                          -> credential.workspace_id -> WorkspaceScope
 *
 *   Operator reads         session cookie -> AuthenticatedUser -> membership
 *                          -> AuthorizedWorkspace -> WorkspaceScope
 *
 * A session cookie cannot register an agent, and an API key cannot read the
 * operator roster. Tests assert both directions.
 *
 * WHY OPERATOR READS DO NOT REQUIRE THE `operator` ROLE
 * -----------------------------------------------------
 * API-key management is operator-only because credentials are secret-adjacent.
 * The agent roster is ordinary tenant data, so any proven member may read it.
 * That difference is deliberate, not an oversight.
 *
 * NO POLICY, EVER
 * ---------------
 * Nothing here creates or mutates policy, caps, mode or pause state - and there
 * is no generic agent update route through which a future caller could acquire
 * that authority.
 */

const SERVICE_UNAVAILABLE = 503;
const UNAUTHORIZED = 401;
const NOT_FOUND = 404;
const BAD_REQUEST = 400;

const UNAVAILABLE_BODY = { error: 'agents_unavailable' } as const;

/**
 * A workspace or agent the caller cannot reach is `not_found`, matching the
 * convention set in Step 6: a 403 would confirm existence and enable
 * enumeration of another tenant's ids.
 */
const NOT_FOUND_BODY = { error: 'not_found' } as const;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Maps a stored row to the operator-facing shape. */
function toSummary(agent: AgentRow): AgentSummary {
  return {
    id: agent.id,
    // Transport calls the client-supplied identifier `agentId`; the column is
    // `external_id`. Same value, different name.
    agentId: agent.externalId,
    name: agent.displayName,
    lastSeenAt: agent.lastSeenAt?.toISOString() ?? null,
    createdAt: agent.createdAt.toISOString(),
  };
}

export interface AgentRouteOptions {
  readonly agentStore: AgentStore | undefined;
  readonly apiKeyStore: ApiKeyStore | undefined;
  readonly workspaceStore: WorkspaceStore | undefined;
  readonly authService: AuthService | undefined;
  /** Step 17. Absent leaves the roster as bare agent metadata. */
  readonly governanceReadStore?: GovernanceReadStore | undefined;
  readonly clock: Clock;
}

export function createAgentRoutes(options: AgentRouteOptions): Hono {
  const routes = new Hono();
  const { agentStore, apiKeyStore, workspaceStore, authService, governanceReadStore, clock } =
    options;

  /**
   * POST /v1/agents/register - machine registration and discovery.
   *
   * Idempotent: the same `agent_id` in the same workspace always resolves to
   * the same agent. The same `agent_id` in a different workspace is a different
   * agent entirely.
   *
   * The route takes no workspace input at all - the URL has no workspace
   * segment and the body schema has no workspace field - so there is nothing
   * for a caller to point elsewhere.
   */
  routes.post(AGENT_REGISTER_PATH, async (c) => {
    if (agentStore === undefined || apiKeyStore === undefined) {
      return c.json(UNAVAILABLE_BODY, SERVICE_UNAVAILABLE);
    }

    // Bearer only. A session cookie is never consulted here.
    const auth = await authenticateApiKeyRequest(c, { store: apiKeyStore, clock });
    if (!auth.ok) {
      return c.json(apiKeyUnauthorizedBody(), UNAUTHORIZED);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_request' }, BAD_REQUEST);
    }

    const parsed = registerAgentRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid_agent' }, BAD_REQUEST);
    }

    // SERVER time. Any `last_seen_at` a caller tried to send was already
    // discarded by the schema, which has no such field.
    const now = clock.now();

    const agent = await agentStore.register(
      auth.credential,
      { externalId: parsed.data.agent_id, displayName: parsed.data.name },
      now,
    );

    return c.json(
      registerAgentResponseSchema.parse({
        agent: {
          agent_id: agent.externalId,
          name: agent.displayName,
          last_seen_at: (agent.lastSeenAt ?? now).toISOString(),
        },
      }),
    );
  });

  /**
   * Resolves the caller to a workspace they are a member of.
   *
   * Any role suffices - see the note at the top of this file.
   */
  async function requireWorkspace(
    c: Context,
  ): Promise<
    | { ok: true; authorized: NonNullable<Awaited<ReturnType<WorkspaceStore['authorize']>>> }
    | { ok: false; response: Response }
  > {
    const auth = await requireAuthenticatedUser(c, authService);
    if (!auth.ok) {
      return { ok: false, response: auth.response };
    }
    if (workspaceStore === undefined) {
      return { ok: false, response: c.json(UNAVAILABLE_BODY, SERVICE_UNAVAILABLE) };
    }

    // Membership is the authorization; the path parameter is only a lookup.
    const authorized = await workspaceStore.authorize(
      auth.user.userId,
      c.req.param('workspaceId') ?? '',
    );
    if (authorized === null) {
      return { ok: false, response: c.json(NOT_FOUND_BODY, NOT_FOUND) };
    }

    return { ok: true, authorized };
  }

  /**
   * GET /v1/workspaces/:workspaceId/agents - the AC-04 roster.
   *
   * STEP 17: when the governance read store is wired, each agent also carries
   * its EFFECTIVE policy and today's authoritative committed usage, so the
   * operator can see enforcement state without a request per agent.
   *
   * The roster degrades to bare agent metadata when that store is absent,
   * rather than failing: the registry is older than governance visibility and
   * must not start depending on it.
   */
  routes.get('/v1/workspaces/:workspaceId/agents', async (c) => {
    if (agentStore === undefined) {
      return c.json(UNAVAILABLE_BODY, SERVICE_UNAVAILABLE);
    }

    const gate = await requireWorkspace(c);
    if (!gate.ok) {
      return gate.response;
    }

    if (governanceReadStore !== undefined) {
      // SERVER time. The UTC accounting day derives from it, never from a
      // browser clock - an operator in another zone must not be shown a
      // different day's usage than the plane enforces against.
      const fleet = await governanceReadStore.listFleet(gate.authorized, clock.now());

      return c.json(
        agentListResponseSchema.parse({
          agents: fleet.map((entry) => ({
            ...toSummary(entry.agent),
            governance: entry.governance,
          })),
        }),
      );
    }

    const agents = await agentStore.list(gate.authorized);

    return c.json(agentListResponseSchema.parse({ agents: agents.map(toSummary) }));
  });

  /**
   * GET /v1/workspaces/:workspaceId/agents/:agentId - one agent by internal id.
   *
   * A malformed id, an unknown id and another tenant's id are all 404.
   */
  routes.get('/v1/workspaces/:workspaceId/agents/:agentId', async (c) => {
    if (agentStore === undefined) {
      return c.json(UNAVAILABLE_BODY, SERVICE_UNAVAILABLE);
    }

    const gate = await requireWorkspace(c);
    if (!gate.ok) {
      return gate.response;
    }

    const agentId = c.req.param('agentId') ?? '';

    // PostgreSQL rejects a non-UUID comparison against a uuid column with a
    // type error, which would surface as a 500 and thereby distinguish
    // "malformed" from "not yours". Screening here keeps every failure a 404.
    if (!UUID_PATTERN.test(agentId)) {
      return c.json(NOT_FOUND_BODY, NOT_FOUND);
    }

    const agent = await agentStore.findById(gate.authorized, agentId);
    if (agent === null) {
      return c.json(NOT_FOUND_BODY, NOT_FOUND);
    }

    return c.json(agentResponseSchema.parse({ agent: toSummary(agent) }));
  });

  return routes;
}
