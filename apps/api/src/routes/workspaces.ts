import {
  createWorkspaceRequestSchema,
  workspaceListResponseSchema,
  workspaceResponseSchema,
  WORKSPACES_PATH,
} from '@hybrid/contracts';
import { Hono } from 'hono';

import { requireAuthenticatedUser } from '../auth/middleware.js';
import type { AuthService } from '../auth/service.js';
import type { WorkspaceStore } from '../workspaces/store.js';

/**
 * Workspace routes.
 *
 * THE AUTHORIZATION CHAIN, ENFORCED ON EVERY REQUEST
 * --------------------------------------------------
 *   session cookie -> AuthenticatedUser -> membership proven in SQL
 *                  -> AuthorizedWorkspace -> WorkspaceScope
 *
 * The `:workspaceId` in the URL is a LOOKUP ARGUMENT, never authorization.
 * These handlers cannot construct a `WorkspaceScope` even if they wanted to:
 * `createWorkspaceScope` is not exported from `@hybrid/db`. The only way to
 * obtain one is `authorizeWorkspaceForUser`, which requires a membership row.
 *
 * Membership is re-proven on every call. There is no cached grant, no
 * server-side "current workspace", and nothing the browser sends is trusted as
 * authorization.
 */

export interface WorkspaceRouteOptions {
  /** Absent when the database is not configured; routes then report 503. */
  readonly store: WorkspaceStore | undefined;
  readonly authService: AuthService | undefined;
}

const SERVICE_UNAVAILABLE = 503;
const BAD_REQUEST = 400;
const NOT_FOUND = 404;
const CREATED = 201;

const UNAVAILABLE_BODY = { error: 'workspaces_unavailable' } as const;

/**
 * A workspace the caller cannot reach is reported as `not_found`, never
 * `forbidden`.
 *
 * 403 would confirm the workspace exists, turning any endpoint into an oracle
 * for enumerating other tenants' ids. 404 collapses "no such workspace" and
 * "not yours" into one indistinguishable answer.
 */
const NOT_FOUND_BODY = { error: 'not_found' } as const;

export function createWorkspaceRoutes(options: WorkspaceRouteOptions): Hono {
  const routes = new Hono();
  const { store, authService } = options;

  /**
   * POST /v1/workspaces - create a workspace.
   *
   * The creator becomes an `operator` member in the same transaction; see
   * `createWorkspaceWithOperator`. CSRF is handled by the origin guard mounted
   * in `createApp`.
   */
  routes.post(WORKSPACES_PATH, async (c) => {
    if (store === undefined) {
      return c.json(UNAVAILABLE_BODY, SERVICE_UNAVAILABLE);
    }

    const auth = await requireAuthenticatedUser(c, authService);
    if (!auth.ok) {
      return auth.response;
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_request' }, BAD_REQUEST);
    }

    const parsed = createWorkspaceRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid_workspace_name' }, BAD_REQUEST);
    }

    // demo_enabled and demo_slug are not settable here - new workspaces take
    // the schema's private defaults.
    const workspace = await store.create({
      name: parsed.data.name,
      creatorUserId: auth.user.userId,
    });

    return c.json(workspaceResponseSchema.parse({ workspace }), CREATED);
  });

  /**
   * GET /v1/workspaces - list the caller's workspaces.
   *
   * Bounded by `user_id` in SQL through the membership join. Nothing is read
   * broadly and filtered in memory.
   */
  routes.get(WORKSPACES_PATH, async (c) => {
    if (store === undefined) {
      return c.json(UNAVAILABLE_BODY, SERVICE_UNAVAILABLE);
    }

    const auth = await requireAuthenticatedUser(c, authService);
    if (!auth.ok) {
      return auth.response;
    }

    const workspaces = await store.listForUser(auth.user.userId);

    return c.json(workspaceListResponseSchema.parse({ workspaces }));
  });

  /**
   * GET /v1/workspaces/:workspaceId - open one workspace.
   *
   * This is the operator "select a workspace" path. The membership join decides
   * access; a malformed id, an unknown id and another tenant's id are all 404.
   */
  routes.get(`${WORKSPACES_PATH}/:workspaceId`, async (c) => {
    if (store === undefined) {
      return c.json(UNAVAILABLE_BODY, SERVICE_UNAVAILABLE);
    }

    const auth = await requireAuthenticatedUser(c, authService);
    if (!auth.ok) {
      return auth.response;
    }

    const authorized = await store.authorize(auth.user.userId, c.req.param('workspaceId'));

    if (authorized === null) {
      return c.json(NOT_FOUND_BODY, NOT_FOUND);
    }

    // `authorized.scope` is a trusted WorkspaceScope, available to later steps
    // for workspace-bound repository calls. Step 6 has no tenant data to read,
    // so it is intentionally not used yet.
    return c.json(workspaceResponseSchema.parse({ workspace: authorized.workspace }));
  });

  return routes;
}
