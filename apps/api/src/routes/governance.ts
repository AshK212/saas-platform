import {
  blockDetailResponseSchema,
  blockListQuerySchema,
  blockListResponseSchema,
  GOVERNANCE_DEFAULT_LIMIT,
  receiptDetailResponseSchema,
  receiptListQuerySchema,
  receiptListResponseSchema,
  type BlockDetail,
  type ReceiptDetail,
} from '@hybrid/contracts';
import type { AuditBlockRow, AuditReceiptRow, AuthorizedWorkspace } from '@hybrid/db';
import { Hono, type Context } from 'hono';

import { requireAuthenticatedUser } from '../auth/middleware.js';
import type { AuthService } from '../auth/service.js';
import { decodeAuditCursor, encodeAuditCursor } from '../governance/cursor.js';
import { toBlockSummary, toReceiptSummary } from '../read-models.js';
import type { GovernanceReadStore } from '../governance/read-store.js';
import type { WorkspaceStore } from '../workspaces/store.js';

/**
 * Operator governance visibility: receipts and blocks (Step 17).
 *
 * BROWSER SESSIONS ONLY
 * ---------------------
 * These are operator audit surfaces and consult only the session cookie. An
 * API key is refused: a runtime that can be denied must not also be able to
 * read the whole tenant's denial history, which would let a compromised agent
 * enumerate every other agent's governance.
 *
 * ANY MEMBER MAY READ
 * -------------------
 * Governance history is ordinary tenant data, like the agent roster and the
 * event timeline. Policy MUTATION remains operator-only; nothing here widens
 * that, because nothing here writes.
 *
 * READ-ONLY, PERMANENTLY
 * ----------------------
 * GET only. There is no PATCH, PUT or DELETE on a receipt or a block: they are
 * the evidence of what the plane decided, and an editable audit trail is not
 * an audit trail. No route here writes anything at all - no ledger row, no
 * policy row, no last-seen refresh.
 *
 * NO HISTORICAL RECOMPUTATION. A receipt is rendered from what was PERSISTED
 * at decision time. Nothing asks "what would this decision be under today's
 * policy?" - a cap changed this morning must not rewrite yesterday's
 * explanation.
 */

const SERVICE_UNAVAILABLE = 503;
const NOT_FOUND = 404;
const BAD_REQUEST = 400;

const UNAVAILABLE_BODY = { error: 'governance_unavailable' } as const;
/** Convention from Step 6: unreachable is `not_found`, never 403. */
const NOT_FOUND_BODY = { error: 'not_found' } as const;
const INVALID_QUERY_BODY = { error: 'invalid_query' } as const;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const RECEIPTS_PATH = '/v1/workspaces/:workspaceId/receipts';
const RECEIPT_PATH = '/v1/workspaces/:workspaceId/receipts/:receiptId';
const BLOCKS_PATH = '/v1/workspaces/:workspaceId/blocks';
const BLOCK_PATH = '/v1/workspaces/:workspaceId/blocks/:blockId';

export interface GovernanceRouteOptions {
  readonly governanceReadStore: GovernanceReadStore | undefined;
  readonly workspaceStore: WorkspaceStore | undefined;
  readonly authService: AuthService | undefined;
}

/**
 * Adds the full persisted decision evidence.
 *
 * Every field below was written at decision time. None is recalculated.
 */
function toReceiptDetail(row: AuditReceiptRow): ReceiptDetail {
  return {
    ...toReceiptSummary(row),
    policyVersion: row.policyVersion,
    appliedMode: row.appliedMode,
    appliedSpendCapUsd: row.appliedSpendCapUsd,
    appliedPublishCap: row.appliedPublishCap,
    requestedAmountUsd: row.requestedAmountUsd,
    requestedPublishCount: row.requestedPublishCount,
    ledgerSpendBeforeUsd: row.ledgerSpendBeforeUsd,
    ledgerPublishBefore: row.ledgerPublishBefore,
    remainingSpendUsd: row.remainingSpendUsd,
    remainingPublishCount: row.remainingPublishCount,
  };
}

function toBlockDetail(row: AuditBlockRow): BlockDetail {
  return { ...toBlockSummary(row), amountUsd: row.amountUsd, count: row.count };
}

export function createGovernanceRoutes(options: GovernanceRouteOptions): Hono {
  const routes = new Hono();
  const { governanceReadStore, workspaceStore, authService } = options;

  /** Session cookie -> user -> membership. Any role may read. */
  async function requireWorkspace(
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
    return { ok: true, authorized };
  }

  /**
   * Screens an id before it reaches SQL.
   *
   * PostgreSQL raises a type error comparing a non-UUID to a uuid column,
   * which would surface as a 500 and distinguish "malformed" from "not yours".
   * Screening here keeps every failure an identical 404.
   */
  function readUuid(c: Context, param: string): string | null {
    const value = c.req.param(param) ?? '';
    return UUID_PATTERN.test(value) ? value : null;
  }

  /** GET .../receipts - the decision audit stream. */
  routes.get(RECEIPTS_PATH, async (c) => {
    if (governanceReadStore === undefined) {
      return c.json(UNAVAILABLE_BODY, SERVICE_UNAVAILABLE);
    }
    const gate = await requireWorkspace(c);
    if (!gate.ok) {
      return gate.response;
    }

    // Strict: an unknown parameter is a 400, so a misspelled filter cannot
    // silently return the unfiltered stream and be read as a complete answer.
    const parsed = receiptListQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json(INVALID_QUERY_BODY, BAD_REQUEST);
    }

    let cursor;
    if (parsed.data.cursor !== undefined) {
      const decoded = decodeAuditCursor(parsed.data.cursor);
      if (decoded === null) {
        return c.json(INVALID_QUERY_BODY, BAD_REQUEST);
      }
      cursor = decoded;
    }

    const page = await governanceReadStore.listReceipts(gate.authorized.scope, {
      limit: parsed.data.limit ?? GOVERNANCE_DEFAULT_LIMIT,
      agentExternalId: parsed.data.agent_id,
      decision: parsed.data.decision,
      cursor,
    });

    return c.json(
      receiptListResponseSchema.parse({
        receipts: page.receipts.map(toReceiptSummary),
        nextCursor: page.nextCursor === null ? null : encodeAuditCursor(page.nextCursor),
      }),
    );
  });

  /** GET .../receipts/:receiptId - full immutable decision evidence. */
  routes.get(RECEIPT_PATH, async (c) => {
    if (governanceReadStore === undefined) {
      return c.json(UNAVAILABLE_BODY, SERVICE_UNAVAILABLE);
    }
    const gate = await requireWorkspace(c);
    if (!gate.ok) {
      return gate.response;
    }

    const receiptId = readUuid(c, 'receiptId');
    if (receiptId === null) {
      return c.json(NOT_FOUND_BODY, NOT_FOUND);
    }

    const row = await governanceReadStore.findReceipt(gate.authorized.scope, receiptId);
    if (row === null) {
      // Another tenant's receipt reads exactly like one that does not exist.
      return c.json(NOT_FOUND_BODY, NOT_FOUND);
    }

    return c.json(receiptDetailResponseSchema.parse({ receipt: toReceiptDetail(row) }));
  });

  /** GET .../blocks - runtime AND plane blocks. */
  routes.get(BLOCKS_PATH, async (c) => {
    if (governanceReadStore === undefined) {
      return c.json(UNAVAILABLE_BODY, SERVICE_UNAVAILABLE);
    }
    const gate = await requireWorkspace(c);
    if (!gate.ok) {
      return gate.response;
    }

    const parsed = blockListQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json(INVALID_QUERY_BODY, BAD_REQUEST);
    }

    let cursor;
    if (parsed.data.cursor !== undefined) {
      const decoded = decodeAuditCursor(parsed.data.cursor);
      if (decoded === null) {
        return c.json(INVALID_QUERY_BODY, BAD_REQUEST);
      }
      cursor = decoded;
    }

    const page = await governanceReadStore.listBlocks(gate.authorized.scope, {
      limit: parsed.data.limit ?? GOVERNANCE_DEFAULT_LIMIT,
      agentExternalId: parsed.data.agent_id,
      source: parsed.data.source,
      cursor,
    });

    return c.json(
      blockListResponseSchema.parse({
        blocks: page.blocks.map(toBlockSummary),
        nextCursor: page.nextCursor === null ? null : encodeAuditCursor(page.nextCursor),
      }),
    );
  });

  /** GET .../blocks/:blockId - one block, with the quantity it refused. */
  routes.get(BLOCK_PATH, async (c) => {
    if (governanceReadStore === undefined) {
      return c.json(UNAVAILABLE_BODY, SERVICE_UNAVAILABLE);
    }
    const gate = await requireWorkspace(c);
    if (!gate.ok) {
      return gate.response;
    }

    const blockId = readUuid(c, 'blockId');
    if (blockId === null) {
      return c.json(NOT_FOUND_BODY, NOT_FOUND);
    }

    const row = await governanceReadStore.findBlock(gate.authorized.scope, blockId);
    if (row === null) {
      return c.json(NOT_FOUND_BODY, NOT_FOUND);
    }

    return c.json(blockDetailResponseSchema.parse({ block: toBlockDetail(row) }));
  });

  return routes;
}
