import {
  DEMO_PUBLIC_PREFIX,
  GOVERNANCE_DEFAULT_LIMIT,
  TIMELINE_DEFAULT_LIMIT,
  blockListQuerySchema,
  demoAgentListResponseSchema,
  demoBlockListResponseSchema,
  demoEventDetailResponseSchema,
  demoEventListResponseSchema,
  demoReceiptListResponseSchema,
  demoSlugSchema,
  demoWorkspaceResponseSchema,
  receiptListQuerySchema,
  timelineQuerySchema,
} from '@hybrid/contracts';
import { Hono, type Context } from 'hono';

import type { Clock } from '../auth/clock.js';
import type { DemoResolverStore, ReadOnlyDemoContext } from '../demo/store.js';
import { decodeCursor as decodeTimelineCursor, encodeCursor as encodeTimelineCursor } from '../events/cursor.js';
import type { EventReadStore } from '../events/read-store.js';
import { decodeAuditCursor, encodeAuditCursor } from '../governance/cursor.js';
import type { GovernanceReadStore } from '../governance/read-store.js';
import {
  toAgentSummary,
  toBlockSummary,
  toEventDetail,
  toEventSummary,
  toReceiptSummary,
} from '../read-models.js';

/**
 * The public demo read surface (AC-19).
 *
 * ─── NO CREDENTIAL AT ALL ─────────────────────────────────────────────────
 *
 * No session, no API key, no share token, no cookie. A visitor arrives with a
 * slug in the URL and nothing else, which is the entire point: the demo has to
 * open in a private window for someone who has never heard of the product.
 *
 * The authorization is `demo_enabled = true`, checked in SQL on every single
 * request. That is why the slug being public costs nothing - it identifies,
 * and the flag authorises.
 *
 * ─── THE SLUG IS IN THE PATH, AND THAT IS CORRECT ─────────────────────────
 *
 * AC-18 goes to lengths to keep a share token out of URLs, because a token is
 * a secret and every log line holding one is an exposure. The reasoning does
 * not transfer: a demo slug is meant to be published. Hiding it would be
 * ceremony, and it would cost the demo its most useful property - a
 * bookmarkable, copy-pasteable, sendable URL.
 *
 * ─── GET ONLY ─────────────────────────────────────────────────────────────
 *
 * Every route here is a GET. There is no exchange step, no cookie to set and
 * nothing to write. A guard test asserts this module imports no policy,
 * credential, share, demo-settings, ingest or precheck store - so there is no
 * mutation for a public visitor to reach even by mistake.
 *
 * ─── REAL DATA, THE SAME DATA ─────────────────────────────────────────────
 *
 * These handlers call the SAME read stores and the SAME row mappers the
 * operator UI and the AC-18 share surface use. Nothing here is a fixture, a
 * sample or a second read model. A demo that showed invented numbers would be
 * a brochure, and the criterion asks for a live control plane.
 *
 * ─── VIEWING IS NOT ACTIVITY ──────────────────────────────────────────────
 *
 * No `last_seen_at`, no ledger row, no policy version, no receipt. Every read
 * store on this path is write-free.
 */

const NOT_FOUND = 404;
const BAD_REQUEST = 400;
const SERVICE_UNAVAILABLE = 503;

/**
 * THE ONLY PUBLIC FAILURE.
 *
 * Unknown slug, malformed slug, DISABLED demo and another tenant's record all
 * produce this. A visitor has no need to learn that a workspace exists but is
 * private, and distinguishing the cases would let anyone probe for it.
 */
const NOT_FOUND_BODY = { error: 'demo_not_found' } as const;
const UNAVAILABLE_BODY = { error: 'demo_unavailable' } as const;

const WORKSPACE_PATH = `${DEMO_PUBLIC_PREFIX}/:slug`;
const AGENTS_PATH = `${WORKSPACE_PATH}/agents`;
const EVENTS_PATH = `${WORKSPACE_PATH}/events`;
const EVENT_PATH = `${EVENTS_PATH}/:eventId`;
const RECEIPTS_PATH = `${WORKSPACE_PATH}/receipts`;
const BLOCKS_PATH = `${WORKSPACE_PATH}/blocks`;

export interface DemoPublicRouteOptions {
  readonly demoResolverStore: DemoResolverStore | undefined;
  readonly eventReadStore: EventReadStore | undefined;
  readonly governanceReadStore: GovernanceReadStore | undefined;
  readonly clock: Clock;
}

export function createDemoPublicRoutes(options: DemoPublicRouteOptions): Hono {
  const routes = new Hono();
  const { demoResolverStore, eventReadStore, governanceReadStore, clock } = options;

  /**
   * Resolves the path slug to a read-only authority.
   *
   * RE-RESOLVED ON EVERY REQUEST, including the `demo_enabled` predicate. An
   * operator disabling the demo takes effect on the visitor's very next
   * request - there is no cache and nothing to invalidate.
   */
  async function requireDemo(
    c: Context,
  ): Promise<{ ok: true; demo: ReadOnlyDemoContext } | { ok: false; response: Response }> {
    if (demoResolverStore === undefined) {
      return { ok: false, response: c.json(UNAVAILABLE_BODY, SERVICE_UNAVAILABLE) };
    }

    // Screened before SQL. A malformed slug is reported exactly like an
    // unknown one rather than as a validation error.
    const parsed = demoSlugSchema.safeParse(c.req.param('slug') ?? '');
    if (!parsed.success) {
      return { ok: false, response: c.json(NOT_FOUND_BODY, NOT_FOUND) };
    }

    const demo = await demoResolverStore.resolve(parsed.data);
    if (demo === null) {
      return { ok: false, response: c.json(NOT_FOUND_BODY, NOT_FOUND) };
    }
    return { ok: true, demo };
  }

  /** GET /v1/demo/:slug - the workspace name, and nothing else. */
  routes.get(WORKSPACE_PATH, async (c) => {
    const gate = await requireDemo(c);
    if (!gate.ok) {
      return gate.response;
    }
    return c.json(
      demoWorkspaceResponseSchema.parse({
        // No workspace id: a visitor has no use for an internal identifier.
        workspace: { name: gate.demo.workspaceName, slug: gate.demo.demoSlug },
      }),
    );
  });

  /** GET /v1/demo/:slug/agents - the live fleet with its governance state. */
  routes.get(AGENTS_PATH, async (c) => {
    if (governanceReadStore === undefined) {
      return c.json(UNAVAILABLE_BODY, SERVICE_UNAVAILABLE);
    }
    const gate = await requireDemo(c);
    if (!gate.ok) {
      return gate.response;
    }

    // The SAME fleet read the operator roster uses. Today's spend and publish
    // count come from `ledger_daily` - never summed from events here or in the
    // browser, which is the Step 17 invariant.
    const fleet = await governanceReadStore.listFleet(gate.demo.scope, clock.now());

    return c.json(
      demoAgentListResponseSchema.parse({
        agents: fleet.map((entry) => ({
          ...toAgentSummary(entry.agent),
          governance: entry.governance,
        })),
      }),
    );
  });

  /** GET /v1/demo/:slug/events - the real timeline. */
  routes.get(EVENTS_PATH, async (c) => {
    if (eventReadStore === undefined) {
      return c.json(UNAVAILABLE_BODY, SERVICE_UNAVAILABLE);
    }
    const gate = await requireDemo(c);
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

    // The agent filter resolves inside the DEMO's workspace. A cursor is a
    // position, never an authority: the scope came from the slug lookup.
    const page = await eventReadStore.listTimeline(gate.demo.scope, {
      limit: parsed.data.limit ?? TIMELINE_DEFAULT_LIMIT,
      agentExternalId: parsed.data.agent_id,
      cursor,
    });

    return c.json(
      demoEventListResponseSchema.parse({
        events: page.events.map(toEventSummary),
        nextCursor: page.nextCursor === null ? null : encodeTimelineCursor(page.nextCursor),
      }),
    );
  });

  /** GET /v1/demo/:slug/events/:eventId - the validated raw event. */
  routes.get(EVENT_PATH, async (c) => {
    if (eventReadStore === undefined) {
      return c.json(UNAVAILABLE_BODY, SERVICE_UNAVAILABLE);
    }
    const gate = await requireDemo(c);
    if (!gate.ok) {
      return gate.response;
    }

    const row = await eventReadStore.findDetail(gate.demo.scope, c.req.param('eventId') ?? '');
    if (row === null) {
      // Another workspace's event reads exactly like one that never existed.
      return c.json(NOT_FOUND_BODY, NOT_FOUND);
    }
    return c.json(demoEventDetailResponseSchema.parse({ event: toEventDetail(row) }));
  });

  /** GET /v1/demo/:slug/receipts - real precheck decisions. */
  routes.get(RECEIPTS_PATH, async (c) => {
    if (governanceReadStore === undefined) {
      return c.json(UNAVAILABLE_BODY, SERVICE_UNAVAILABLE);
    }
    const gate = await requireDemo(c);
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

    const page = await governanceReadStore.listReceipts(gate.demo.scope, {
      limit: parsed.data.limit ?? GOVERNANCE_DEFAULT_LIMIT,
      agentExternalId: parsed.data.agent_id,
      decision: parsed.data.decision,
      cursor,
    });

    return c.json(
      demoReceiptListResponseSchema.parse({
        receipts: page.receipts.map(toReceiptSummary),
        nextCursor: page.nextCursor === null ? null : encodeAuditCursor(page.nextCursor),
      }),
    );
  });

  /**
   * GET /v1/demo/:slug/blocks - REAL persisted blocks.
   *
   * This is what AC-19 exists to show: recurring plane-owned denials, written
   * by the precheck engine when the generator's over-cap attempt was refused.
   * Never reconstructed from events, and never fabricated.
   */
  routes.get(BLOCKS_PATH, async (c) => {
    if (governanceReadStore === undefined) {
      return c.json(UNAVAILABLE_BODY, SERVICE_UNAVAILABLE);
    }
    const gate = await requireDemo(c);
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

    const page = await governanceReadStore.listBlocks(gate.demo.scope, {
      limit: parsed.data.limit ?? GOVERNANCE_DEFAULT_LIMIT,
      agentExternalId: parsed.data.agent_id,
      source: parsed.data.source,
      cursor,
    });

    return c.json(
      demoBlockListResponseSchema.parse({
        blocks: page.blocks.map(toBlockSummary),
        nextCursor: page.nextCursor === null ? null : encodeAuditCursor(page.nextCursor),
      }),
    );
  });

  return routes;
}
