import {
  createShareLinkRequestSchema,
  shareLinkCreatedResponseSchema,
  shareLinkListResponseSchema,
  type ShareLinkSummary,
} from '@hybrid/contracts';
import type { AuthorizedWorkspace, ShareTokenRow } from '@hybrid/db';
import { Hono, type Context } from 'hono';

import type { Clock } from '../auth/clock.js';
import { requireAuthenticatedUser } from '../auth/middleware.js';
import type { AuthService } from '../auth/service.js';
import type { ShareManagementStore } from '../share/store.js';
import type { WorkspaceStore } from '../workspaces/store.js';

/**
 * Share-link management (AC-18) - OPERATOR ONLY.
 *
 * ─── WHY OPERATOR AND NOT MEMBER ──────────────────────────────────────────
 *
 * A member may read everything in the workspace already, so this is not about
 * withholding data from them. It is about who may create a durable, external,
 * unauthenticated door into the tenant.
 *
 * Reading is a decision about yourself. Issuing a share link is a decision on
 * behalf of everyone in the workspace, and it survives the person who made it.
 * That is the same reasoning that makes API-key issuance operator-only, and
 * the two should not disagree.
 *
 * ─── SHOW-ONCE ────────────────────────────────────────────────────────────
 *
 * The plaintext token is generated during issuance, returned in that one
 * response, and never persisted. The list endpoint returns metadata only, and
 * there is deliberately no recovery route - not as a policy, but because the
 * server kept only a digest and genuinely cannot reproduce the token. A lost
 * link is revoked and reissued.
 *
 * ─── CSRF ─────────────────────────────────────────────────────────────────
 *
 * Both mutations are cookie-authenticated, so the Step 6 origin guard applies
 * unchanged: a foreign origin can neither mint nor revoke a share link.
 */

const WORKSPACE_SHARES_PATH = '/v1/workspaces/:workspaceId/share-links';
const REVOKE_PATH = `${WORKSPACE_SHARES_PATH}/:shareId/revoke`;

const SERVICE_UNAVAILABLE = 503;
const FORBIDDEN = 403;
const NOT_FOUND = 404;
const BAD_REQUEST = 400;
const CREATED = 201;

const UNAVAILABLE_BODY = { error: 'share_links_unavailable' } as const;
/** Step 6 convention: unreachable is `not_found`, never 403. */
const NOT_FOUND_BODY = { error: 'not_found' } as const;
const FORBIDDEN_ROLE_BODY = { error: 'insufficient_role' } as const;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Maps a stored share to its safe client shape.
 *
 * There is no branch here that could include a token, because `ShareTokenRow`
 * has no field for one.
 */
function toSummary(row: ShareTokenRow): ShareLinkSummary {
  return {
    id: row.id,
    tokenPrefix: row.tokenPrefix,
    createdAt: row.createdAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}

export interface ShareManagementRouteOptions {
  readonly shareManagementStore: ShareManagementStore | undefined;
  readonly workspaceStore: WorkspaceStore | undefined;
  readonly authService: AuthService | undefined;
  readonly clock: Clock;
}

export function createShareManagementRoutes(options: ShareManagementRouteOptions): Hono {
  const routes = new Hono();
  const { shareManagementStore, workspaceStore, authService, clock } = options;

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

  /**
   * POST .../share-links - issue a link.
   *
   * THE ONLY RESPONSE IN THE SYSTEM THAT CARRIES A USABLE SHARE TOKEN.
   */
  routes.post(WORKSPACE_SHARES_PATH, async (c) => {
    if (shareManagementStore === undefined) {
      return c.json(UNAVAILABLE_BODY, SERVICE_UNAVAILABLE);
    }
    const gate = await requireOperatorWorkspace(c);
    if (!gate.ok) {
      return gate.response;
    }

    // A body is optional, but if one is sent it must be empty. Strict, so a
    // caller inventing `{"scope":"write"}` or `{"workspace_id":"..."}` gets a
    // loud 400 rather than a silently ignored field they might rely on.
    let body: unknown = {};
    const raw = await c.req.text();
    if (raw.trim() !== '') {
      try {
        body = JSON.parse(raw);
      } catch {
        return c.json({ error: 'invalid_request' }, BAD_REQUEST);
      }
    }
    if (!createShareLinkRequestSchema.safeParse(body).success) {
      return c.json({ error: 'invalid_request' }, BAD_REQUEST);
    }

    const issued = await shareManagementStore.issue(gate.authorized);

    return c.json(
      shareLinkCreatedResponseSchema.parse({
        shareLink: toSummary(issued.share),
        // Shown once. The server kept only a digest.
        token: issued.token,
      }),
      CREATED,
    );
  });

  /** GET .../share-links - metadata only, active and revoked alike. */
  routes.get(WORKSPACE_SHARES_PATH, async (c) => {
    if (shareManagementStore === undefined) {
      return c.json(UNAVAILABLE_BODY, SERVICE_UNAVAILABLE);
    }
    const gate = await requireOperatorWorkspace(c);
    if (!gate.ok) {
      return gate.response;
    }

    const shares = await shareManagementStore.list(gate.authorized);
    return c.json(shareLinkListResponseSchema.parse({ shareLinks: shares.map(toSummary) }));
  });

  /**
   * POST .../share-links/:shareId/revoke
   *
   * IDEMPOTENT. Revoking an already-revoked link returns the same 200 and the
   * ORIGINAL revocation instant. An error would tell a caller nothing useful
   * and would tempt a client into treating "already safe" as a failure.
   */
  routes.post(REVOKE_PATH, async (c) => {
    if (shareManagementStore === undefined) {
      return c.json(UNAVAILABLE_BODY, SERVICE_UNAVAILABLE);
    }
    const gate = await requireOperatorWorkspace(c);
    if (!gate.ok) {
      return gate.response;
    }

    // Screened before SQL: comparing a non-UUID to a uuid column raises a type
    // error, which would surface as a 500 and distinguish "malformed" from
    // "not yours".
    const shareId = c.req.param('shareId') ?? '';
    if (!UUID_PATTERN.test(shareId)) {
      return c.json(NOT_FOUND_BODY, NOT_FOUND);
    }

    const revoked = await shareManagementStore.revoke(gate.authorized, shareId, clock.now());
    if (revoked === null) {
      // Another workspace's share reads exactly like one that never existed.
      return c.json(NOT_FOUND_BODY, NOT_FOUND);
    }

    return c.json(shareLinkListResponseSchema.parse({ shareLinks: [toSummary(revoked)] }));
  });

  return routes;
}
