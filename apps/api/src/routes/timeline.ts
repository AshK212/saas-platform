import {
  eventDetailResponseSchema,
  TIMELINE_DEFAULT_LIMIT,
  timelineQuerySchema,
  timelineResponseSchema,
} from '@hybrid/contracts';
import type { EventDetailRow } from '@hybrid/db';
import { Hono, type Context } from 'hono';

import { requireAuthenticatedUser } from '../auth/middleware.js';
import type { AuthService } from '../auth/service.js';
import { decodeCursor, encodeCursor } from '../events/cursor.js';
import type { EventReadStore } from '../events/read-store.js';
import { toEventDetail, toEventSummary } from '../read-models.js';
import type { WorkspaceStore } from '../workspaces/store.js';

/**
 * Operator event timeline and detail (AC-05, AC-06).
 *
 * BROWSER SESSIONS READ; MACHINE KEYS WRITE
 * -----------------------------------------
 * These routes consult ONLY the session cookie. An API key is never accepted -
 * not as a fallback, not as an alternative. That mirrors the agent roster: the
 * ingest path is bearer-only, and the read path is cookie-only. A machine that
 * can submit events cannot read the tenant's history back.
 *
 * Any workspace MEMBER may read. Reads are ordinary tenant data, unlike API-key
 * management, which is operator-only because credentials are secret-adjacent.
 * That difference follows the rule already set for the agent roster.
 *
 * READ-ONLY, PERMANENTLY
 * ----------------------
 * There is no PATCH, no DELETE and no "dismiss". The event stream is the audit
 * record; a route that could alter it would destroy the thing it exists to
 * preserve. No route here writes anything at all - reading a `spend.recorded`
 * event performs no accounting, no reconciliation and no ledger backfill.
 *
 * NO BULK EXPORT, NO ROLLUPS
 * --------------------------
 * Pages are hard-capped and raw payloads appear only on the single-event detail
 * route. CSV/JSON export is the deferred AC-16 and daily rollups are the
 * deferred AC-17; neither is reachable from here.
 */

const SERVICE_UNAVAILABLE = 503;
const NOT_FOUND = 404;
const BAD_REQUEST = 400;

const UNAVAILABLE_BODY = { error: 'events_unavailable' } as const;

/** Convention from Step 6: unreachable is `not_found`, never 403. */
const NOT_FOUND_BODY = { error: 'not_found' } as const;

const INVALID_QUERY_BODY = { error: 'invalid_query' } as const;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface TimelineRouteOptions {
  readonly eventReadStore: EventReadStore | undefined;
  readonly workspaceStore: WorkspaceStore | undefined;
  readonly authService: AuthService | undefined;
}

export function createTimelineRoutes(options: TimelineRouteOptions): Hono {
  const routes = new Hono();
  const { eventReadStore, workspaceStore, authService } = options;

  /** Session cookie -> user -> membership -> AuthorizedWorkspace. */
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
   * GET /v1/workspaces/:workspaceId/events - the AC-05 timeline.
   *
   * Newest first by SERVER receipt time, optionally filtered to one agent,
   * paginated by an opaque cursor.
   */
  routes.get('/v1/workspaces/:workspaceId/events', async (c) => {
    if (eventReadStore === undefined) {
      return c.json(UNAVAILABLE_BODY, SERVICE_UNAVAILABLE);
    }

    const gate = await requireWorkspace(c);
    if (!gate.ok) {
      return gate.response;
    }

    // Strict: an unknown query parameter is a 400 rather than being ignored, so
    // a misspelled `agent-id` cannot silently return the unfiltered stream.
    const parsed = timelineQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json(INVALID_QUERY_BODY, BAD_REQUEST);
    }

    let cursor;
    if (parsed.data.cursor !== undefined) {
      const decoded = decodeCursor(parsed.data.cursor);
      if (decoded === null) {
        // A tampered or truncated cursor is a client error, not a server one,
        // and never a reason to fall back to page one - that would silently
        // restart a paging loop.
        return c.json(INVALID_QUERY_BODY, BAD_REQUEST);
      }
      cursor = decoded;
    }

    const page = await eventReadStore.listTimeline(gate.authorized.scope, {
      limit: parsed.data.limit ?? TIMELINE_DEFAULT_LIMIT,
      agentExternalId: parsed.data.agent_id,
      cursor,
    });

    return c.json(
      timelineResponseSchema.parse({
        events: page.events.map(toEventSummary),
        nextCursor: page.nextCursor === null ? null : encodeCursor(page.nextCursor),
      }),
    );
  });

  /**
   * GET /v1/workspaces/:workspaceId/events/:eventId - AC-06 raw detail.
   *
   * `:eventId` is the INTERNAL uuid, which is what timeline rows carry. The
   * client-supplied `event_id` is only unique per workspace and may contain any
   * character, so it makes a poor path segment.
   *
   * A malformed id, an unknown id and another tenant's id are all 404.
   */
  routes.get('/v1/workspaces/:workspaceId/events/:eventId', async (c) => {
    if (eventReadStore === undefined) {
      return c.json(UNAVAILABLE_BODY, SERVICE_UNAVAILABLE);
    }

    const gate = await requireWorkspace(c);
    if (!gate.ok) {
      return gate.response;
    }

    const eventId = c.req.param('eventId') ?? '';

    // PostgreSQL raises a type error comparing a non-UUID to a uuid column,
    // which would surface as a 500 and distinguish "malformed" from "not
    // yours". Screening here keeps every failure identical.
    if (!UUID_PATTERN.test(eventId)) {
      return c.json(NOT_FOUND_BODY, NOT_FOUND);
    }

    const row: EventDetailRow | null = await eventReadStore.findDetail(gate.authorized.scope, eventId);
    if (row === null) {
      return c.json(NOT_FOUND_BODY, NOT_FOUND);
    }

    return c.json(
      eventDetailResponseSchema.parse({ event: toEventDetail(row) }),
    );
  });

  return routes;
}
