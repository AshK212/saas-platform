import {
  demoSettingsResponseSchema,
  demoViewPath,
  setDemoRequestSchema,
} from '@hybrid/contracts';
import type { AuthorizedWorkspace, DemoSettingsRow } from '@hybrid/db';
import { Hono, type Context } from 'hono';

import type { Clock } from '../auth/clock.js';
import { requireAuthenticatedUser } from '../auth/middleware.js';
import type { AuthService } from '../auth/service.js';
import type { DemoManagementStore } from '../demo/store.js';
import type { WorkspaceStore } from '../workspaces/store.js';

/**
 * Public-demo management (AC-19) - OPERATOR ONLY.
 *
 * ─── THE MOST CONSEQUENTIAL SWITCH IN THE PRODUCT ─────────────────────────
 *
 * Enabling the demo turns a private tenant into an unauthenticated public
 * page. Not a link handed to one person - a page anyone can open.
 *
 * So this is operator-only, for the same reason share issuance and API-key
 * issuance are: a member reading the workspace is a decision about themselves,
 * while publishing it is a decision on behalf of everyone in the tenant, and
 * it outlives the person who made it.
 *
 * ─── ONE FLAG, TWO VERBS, NO GENERIC UPDATE ───────────────────────────────
 *
 * The request carries `{ enabled }` and nothing else. In particular it does
 * NOT accept a slug: the server mints one. Letting a caller choose would
 * invite squatting on recognisable names across tenants, and would make the
 * slug feel like an identity the operator owns rather than a locator the plane
 * assigns.
 *
 * There is deliberately no general `PATCH /workspaces/:id`. A switch this
 * consequential should never sit in a bag of fields where a future caller
 * flips it while renaming something.
 *
 * ─── CSRF ─────────────────────────────────────────────────────────────────
 *
 * A cookie-authenticated mutation, so the Step 6 origin guard applies: a
 * foreign origin cannot publish a private workspace.
 */

const WORKSPACE_DEMO_PATH = '/v1/workspaces/:workspaceId/demo';

const SERVICE_UNAVAILABLE = 503;
const FORBIDDEN = 403;
const NOT_FOUND = 404;
const BAD_REQUEST = 400;

const UNAVAILABLE_BODY = { error: 'demo_unavailable' } as const;
/** Step 6 convention: unreachable is `not_found`, never 403. */
const NOT_FOUND_BODY = { error: 'not_found' } as const;
const FORBIDDEN_ROLE_BODY = { error: 'insufficient_role' } as const;

/** Maps stored state to the operator-facing shape. */
function toSettings(row: DemoSettingsRow): {
  enabled: boolean;
  slug: string | null;
  publicPath: string | null;
} {
  return {
    enabled: row.demoEnabled,
    slug: row.demoSlug,
    // Built only when there is a slug. Convenience for the operator UI - the
    // URL is not a secret and carries no authority of its own.
    publicPath: row.demoSlug === null ? null : demoViewPath(row.demoSlug),
  };
}

export interface DemoManagementRouteOptions {
  readonly demoManagementStore: DemoManagementStore | undefined;
  readonly workspaceStore: WorkspaceStore | undefined;
  readonly authService: AuthService | undefined;
  readonly clock: Clock;
}

export function createDemoManagementRoutes(options: DemoManagementRouteOptions): Hono {
  const routes = new Hono();
  const { demoManagementStore, workspaceStore, authService, clock } = options;

  /** Session cookie -> user -> membership -> operator role. */
  async function requireOperatorWorkspace(
    c: Context,
  ): Promise<{ ok: true; authorized: AuthorizedWorkspace } | { ok: false; response: Response }> {
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
    if (authorized.workspace.role !== 'operator') {
      // The caller is a proven member, so 403 reveals nothing new.
      return { ok: false, response: c.json(FORBIDDEN_ROLE_BODY, FORBIDDEN) };
    }

    return { ok: true, authorized };
  }

  /** GET .../demo - current state, for the operator UI. */
  routes.get(WORKSPACE_DEMO_PATH, async (c) => {
    if (demoManagementStore === undefined) {
      return c.json(UNAVAILABLE_BODY, SERVICE_UNAVAILABLE);
    }
    const gate = await requireOperatorWorkspace(c);
    if (!gate.ok) {
      return gate.response;
    }

    const settings = await demoManagementStore.read(gate.authorized);
    if (settings === null) {
      return c.json(NOT_FOUND_BODY, NOT_FOUND);
    }
    return c.json(demoSettingsResponseSchema.parse({ demo: toSettings(settings) }));
  });

  /**
   * PUT .../demo - publish or withdraw.
   *
   * Enabling twice keeps the existing slug: pressing the button again is not a
   * request for a new URL. DISABLING clears the slug, so re-enabling mints a
   * new one and every previously-published URL stays dead - see
   * `packages/db/src/repositories/demo-settings.ts` for why the schema makes
   * that the only honest option.
   */
  routes.put(WORKSPACE_DEMO_PATH, async (c) => {
    if (demoManagementStore === undefined) {
      return c.json(UNAVAILABLE_BODY, SERVICE_UNAVAILABLE);
    }
    const gate = await requireOperatorWorkspace(c);
    if (!gate.ok) {
      return gate.response;
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_request' }, BAD_REQUEST);
    }

    // Strict: a caller sending `{ slug: "acme" }` or `{ enabled: "true" }`
    // gets a loud 400 rather than a silently ignored field.
    const parsed = setDemoRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid_request' }, BAD_REQUEST);
    }

    const updated = parsed.data.enabled
      ? await demoManagementStore.enable(gate.authorized, clock.now())
      : await demoManagementStore.disable(gate.authorized, clock.now());

    return c.json(demoSettingsResponseSchema.parse({ demo: toSettings(updated) }));
  });

  return routes;
}
