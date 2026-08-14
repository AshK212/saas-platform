import {
  GOVERNANCE_DEFAULT_LIMIT,
  SHARE_ACCESS_PATH,
  SHARE_AGENTS_PATH,
  SHARE_BLOCKS_PATH,
  SHARE_EVENTS_PATH,
  SHARE_RECEIPTS_PATH,
  SHARE_WORKSPACE_PATH,
  TIMELINE_DEFAULT_LIMIT,
  blockListQuerySchema,
  eventDetailResponseSchema,
  receiptListQuerySchema,
  shareAccessRequestSchema,
  shareAccessResponseSchema,
  shareAgentListResponseSchema,
  shareBlockListResponseSchema,
  shareEventListResponseSchema,
  shareReceiptListResponseSchema,
  timelineQuerySchema,
} from '@hybrid/contracts';
import { Hono, type Context } from 'hono';

import { decodeAuditCursor, encodeAuditCursor } from '../governance/cursor.js';
import type { GovernanceReadStore } from '../governance/read-store.js';
import { decodeCursor as decodeTimelineCursor, encodeCursor as encodeTimelineCursor } from '../events/cursor.js';
import type { EventReadStore } from '../events/read-store.js';
import type { Clock } from '../auth/clock.js';
import { readShareCookie, writeShareCookie } from '../share/cookie.js';
import type { ReadOnlyShareContext, ShareResolverStore } from '../share/store.js';
import {
  toAgentSummary,
  toBlockSummary,
  toEventDetail,
  toEventSummary,
  toReceiptSummary,
} from '../read-models.js';

/**
 * The public read-only share surface (AC-18).
 *
 * ─── THE THIRD AUTHORITY ──────────────────────────────────────────────────
 *
 * Every route here is authenticated by a SHARE TOKEN and nothing else. There
 * is no session, no user, no membership and no role. `requireShare` produces a
 * `ReadOnlyShareContext`, which has no field a handler could inspect to decide
 * it may write - the restriction is in the type, not in a check.
 *
 * The operator session cookie is never consulted, and the share cookie is
 * `Path=/v1/share`, so a browser will not even offer it to an operator route.
 * Neither credential can be mistaken for the other.
 *
 * ─── GET ONLY, WITH ONE EXCEPTION ─────────────────────────────────────────
 *
 * Every read is a GET. The single POST is the token exchange, which carries
 * the credential in its own body - CSRF against it achieves nothing, because
 * an attacker who already has the token does not need a victim's browser.
 *
 * No route here can mutate anything. A guard test asserts this module imports
 * no policy-mutation, credential, ingest or precheck store.
 *
 * ─── THE TOKEN APPEARS IN ONE REQUEST ─────────────────────────────────────
 *
 * The obvious design is `/v1/share/:token/events`. That writes a live bearer
 * credential into every access log line, proxy log, browser history entry and
 * outbound `Referer` for the life of the session. Instead the token is POSTed
 * once, in a body, and exchanged for an HttpOnly cookie that holds the SAME
 * token - not a derived session.
 *
 * Holding the same token is what keeps revocation authoritative: every read
 * below re-resolves it against the database, including `revoked_at IS NULL`.
 * A signed session carrying a share id would be a second credential that could
 * outlive the first, and a viewer holding one after revocation is precisely
 * the failure this criterion exists to prevent.
 *
 * ─── VIEWING IS NOT ACTIVITY ──────────────────────────────────────────────
 *
 * Reading a shared view moves no `last_seen_at`, no ledger, no policy version.
 * The read stores this module calls are the same ones the operator UI uses,
 * and none of them writes.
 */

const NOT_FOUND = 404;
const BAD_REQUEST = 400;
const SERVICE_UNAVAILABLE = 503;

/**
 * THE ONLY PUBLIC FAILURE.
 *
 * Unknown, malformed, revoked, and belonging-to-another-workspace all produce
 * this. Distinguishing them would let the holder of a dead link learn whether
 * it ever existed, and would let anyone probe for live prefixes.
 */
const INVALID_SHARE_BODY = { error: 'invalid_share' } as const;
const UNAVAILABLE_BODY = { error: 'share_unavailable' } as const;

export interface SharePublicRouteOptions {
  readonly shareResolverStore: ShareResolverStore | undefined;
  readonly eventReadStore: EventReadStore | undefined;
  readonly governanceReadStore: GovernanceReadStore | undefined;
  readonly secureCookies: boolean;
  readonly clock: Clock;
}

export function createSharePublicRoutes(options: SharePublicRouteOptions): Hono {
  const routes = new Hono();
  const {
    shareResolverStore,
    eventReadStore,
    governanceReadStore,
    secureCookies,
    clock,
  } = options;

  /**
   * Resolves the share cookie to a read-only authority.
   *
   * RE-RESOLVED ON EVERY REQUEST. There is no cache and no memoisation, so an
   * operator's revocation takes effect on the viewer's very next read - which
   * is exactly what "refresh is dead" requires.
   */
  async function requireShare(
    c: Context,
  ): Promise<{ ok: true; share: ReadOnlyShareContext } | { ok: false; response: Response }> {
    if (shareResolverStore === undefined) {
      return { ok: false, response: c.json(UNAVAILABLE_BODY, SERVICE_UNAVAILABLE) };
    }

    const token = readShareCookie(c);
    if (token === undefined || token === '') {
      return { ok: false, response: c.json(INVALID_SHARE_BODY, NOT_FOUND) };
    }

    const share = await shareResolverStore.resolve(token);
    if (share === null) {
      return { ok: false, response: c.json(INVALID_SHARE_BODY, NOT_FOUND) };
    }
    return { ok: true, share };
  }

  /**
   * POST /v1/share/access - trade a token for a viewing cookie.
   *
   * The token arrives in the BODY. Never a query string: those land in access
   * logs, browser history and `Referer` headers, which is the whole thing this
   * exchange exists to avoid.
   */
  routes.post(SHARE_ACCESS_PATH, async (c) => {
    if (shareResolverStore === undefined) {
      return c.json(UNAVAILABLE_BODY, SERVICE_UNAVAILABLE);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(INVALID_SHARE_BODY, NOT_FOUND);
    }

    const parsed = shareAccessRequestSchema.safeParse(body);
    if (!parsed.success) {
      // Reported as an invalid share, not a validation error: a malformed
      // token and an unknown one must be indistinguishable.
      return c.json(INVALID_SHARE_BODY, NOT_FOUND);
    }

    const share = await shareResolverStore.resolve(parsed.data.token);
    if (share === null) {
      return c.json(INVALID_SHARE_BODY, NOT_FOUND);
    }

    writeShareCookie(c, parsed.data.token, { secure: secureCookies });

    // The NAME only. No workspace id: a viewer has no use for one, and
    // publishing an internal identifier invites someone to try it elsewhere.
    return c.json(
      shareAccessResponseSchema.parse({ workspace: { name: share.workspaceName } }),
    );
  });

  /** GET /v1/share/workspace - confirms the cookie still resolves. */
  routes.get(SHARE_WORKSPACE_PATH, async (c) => {
    const gate = await requireShare(c);
    if (!gate.ok) {
      return gate.response;
    }
    return c.json(
      shareAccessResponseSchema.parse({ workspace: { name: gate.share.workspaceName } }),
    );
  });

  /** GET /v1/share/agents - the fleet with its governance state. */
  routes.get(SHARE_AGENTS_PATH, async (c) => {
    if (governanceReadStore === undefined) {
      return c.json(UNAVAILABLE_BODY, SERVICE_UNAVAILABLE);
    }
    const gate = await requireShare(c);
    if (!gate.ok) {
      return gate.response;
    }

    // THE SAME read store the operator roster uses, driven by a scope the
    // share resolver produced. Not a parallel implementation.
    const fleet = await governanceReadStore.listFleet(gate.share.scope, clock.now());

    return c.json(
      shareAgentListResponseSchema.parse({
        agents: fleet.map((entry) => ({
          ...toAgentSummary(entry.agent),
          governance: entry.governance,
        })),
      }),
    );
  });

  /** GET /v1/share/events - the workspace timeline. */
  routes.get(SHARE_EVENTS_PATH, async (c) => {
    if (eventReadStore === undefined) {
      return c.json(UNAVAILABLE_BODY, SERVICE_UNAVAILABLE);
    }
    const gate = await requireShare(c);
    if (!gate.ok) {
      return gate.response;
    }

    const parsed = timelineQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ error: 'invalid_query' }, BAD_REQUEST);
    }

    let cursor;
    if (parsed.data.cursor !== undefined) {
      const decoded = decodeTimelineCursor(parsed.data.cursor);
      if (decoded === null) {
        return c.json({ error: 'invalid_query' }, BAD_REQUEST);
      }
      cursor = decoded;
    }

    // The agent filter resolves inside the SHARE's workspace. A cursor is a
    // position, never an authority - it cannot move the reader to another
    // tenant because the scope came from the token, not the query.
    const page = await eventReadStore.listTimeline(gate.share.scope, {
      limit: parsed.data.limit ?? TIMELINE_DEFAULT_LIMIT,
      agentExternalId: parsed.data.agent_id,
      cursor,
    });

    return c.json(
      shareEventListResponseSchema.parse({
        events: page.events.map(toEventSummary),
        nextCursor: page.nextCursor === null ? null : encodeTimelineCursor(page.nextCursor),
      }),
    );
  });

  /** GET /v1/share/events/:eventId - the validated raw event. */
  routes.get(`${SHARE_EVENTS_PATH}/:eventId`, async (c) => {
    if (eventReadStore === undefined) {
      return c.json(UNAVAILABLE_BODY, SERVICE_UNAVAILABLE);
    }
    const gate = await requireShare(c);
    if (!gate.ok) {
      return gate.response;
    }

    const row = await eventReadStore.findDetail(gate.share.scope, c.req.param('eventId') ?? '');
    if (row === null) {
      // Another workspace's event reads exactly like one that never existed.
      return c.json(INVALID_SHARE_BODY, NOT_FOUND);
    }

    return c.json(eventDetailResponseSchema.parse({ event: toEventDetail(row) }));
  });

  /** GET /v1/share/receipts - the decision audit. */
  routes.get(SHARE_RECEIPTS_PATH, async (c) => {
    if (governanceReadStore === undefined) {
      return c.json(UNAVAILABLE_BODY, SERVICE_UNAVAILABLE);
    }
    const gate = await requireShare(c);
    if (!gate.ok) {
      return gate.response;
    }

    const parsed = receiptListQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ error: 'invalid_query' }, BAD_REQUEST);
    }

    let cursor;
    if (parsed.data.cursor !== undefined) {
      const decoded = decodeAuditCursor(parsed.data.cursor);
      if (decoded === null) {
        return c.json({ error: 'invalid_query' }, BAD_REQUEST);
      }
      cursor = decoded;
    }

    const page = await governanceReadStore.listReceipts(gate.share.scope, {
      limit: parsed.data.limit ?? GOVERNANCE_DEFAULT_LIMIT,
      agentExternalId: parsed.data.agent_id,
      decision: parsed.data.decision,
      cursor,
    });

    return c.json(
      shareReceiptListResponseSchema.parse({
        receipts: page.receipts.map(toReceiptSummary),
        nextCursor: page.nextCursor === null ? null : encodeAuditCursor(page.nextCursor),
      }),
    );
  });

  /** GET /v1/share/blocks - runtime and plane blocks alike. */
  routes.get(SHARE_BLOCKS_PATH, async (c) => {
    if (governanceReadStore === undefined) {
      return c.json(UNAVAILABLE_BODY, SERVICE_UNAVAILABLE);
    }
    const gate = await requireShare(c);
    if (!gate.ok) {
      return gate.response;
    }

    const parsed = blockListQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ error: 'invalid_query' }, BAD_REQUEST);
    }

    let cursor;
    if (parsed.data.cursor !== undefined) {
      const decoded = decodeAuditCursor(parsed.data.cursor);
      if (decoded === null) {
        return c.json({ error: 'invalid_query' }, BAD_REQUEST);
      }
      cursor = decoded;
    }

    const page = await governanceReadStore.listBlocks(gate.share.scope, {
      limit: parsed.data.limit ?? GOVERNANCE_DEFAULT_LIMIT,
      agentExternalId: parsed.data.agent_id,
      source: parsed.data.source,
      cursor,
    });

    return c.json(
      shareBlockListResponseSchema.parse({
        blocks: page.blocks.map(toBlockSummary),
        nextCursor: page.nextCursor === null ? null : encodeAuditCursor(page.nextCursor),
      }),
    );
  });

  return routes;
}
