import { and, desc, eq, sql, type SQL } from 'drizzle-orm';

import { normalizeUsd } from '../accounting/money.js';
import type { UtcAccountingDay } from '../accounting/utc-day.js';
import { agents } from '../schema/agents.js';
import { blocks } from '../schema/blocks.js';
import { precheckReceipts } from '../schema/receipts.js';
import type { DatabaseExecutor } from './executor.js';
import type { WorkspaceScope } from './workspace-scope.js';

/**
 * Workspace-scoped precheck receipts.
 *
 * RECEIPTS ARE IMMUTABLE HISTORICAL EVIDENCE.
 *
 * There is exactly one write method - `insert` - and deliberately NO update
 * and NO delete. A receipt explains a decision that was already made; altering
 * one would destroy the only record of what the plane actually did, and a
 * "latest receipt" that could be overwritten would be worthless as evidence.
 * A guardrail test enforces the absence of both.
 *
 * SELF-EXPLAINING WITHOUT CURRENT STATE
 * -------------------------------------
 * Every receipt stores the policy values that PRODUCED it - the exact version,
 * the applied mode and caps, and the ledger state it read. An operator can
 * change policy the next minute and the receipt still explains itself. Reading
 * today's `agent_policies` to explain last week's denial would be wrong by
 * construction.
 */

/**
 * The tenant predicate every query in this file must carry.
 *
 * Named rather than inlined so the boundary guardrail can count occurrences
 * against the number of selects and prove none was written without it.
 */
function receiptScopePredicate(scope: WorkspaceScope): SQL {
  return eq(precheckReceipts.workspaceId, scope.workspaceId);
}

/** Everything a decision must record to remain explicable. */
export interface InsertReceiptInput {
  /** Runtime-supplied action identity. The idempotency key. */
  readonly actionId: string;
  /** Internal agent UUID, already resolved inside this workspace. */
  readonly agentId: string;
  readonly category: 'llm_call' | 'tool_call' | 'spend' | 'publish' | 'other';
  /** Decimal string for a spend request, else null. */
  readonly requestedAmountUsd: string | null;
  /** 1 for a publish request, else null. One precheck is one publish. */
  readonly requestedPublishCount: number | null;
  readonly decision: 'allow' | 'deny';
  /** EXACT decimal string. Passed straight to `bigint` without a JS number. */
  readonly policyVersion: string;
  readonly appliedMode: 'watch' | 'budgeted' | 'paused';
  readonly appliedSpendCapUsd: string | null;
  readonly appliedPublishCap: number | null;
  readonly accountingDay: UtcAccountingDay;
  /** Committed usage READ during the decision, or null when no ledger was consulted. */
  readonly ledgerSpendBeforeUsd: string | null;
  readonly ledgerPublishBefore: number | null;
  readonly remainingSpendUsd: string | null;
  readonly remainingPublishCount: number | null;
  /** Required when the decision is a denial; the column check enforces it. */
  readonly denyReason: string | null;
}

/** A stored receipt, normalised for application use. */
export interface ReceiptRow {
  /** The plane-generated UUID returned to the caller as `precheck_id`. */
  readonly id: string;
  readonly actionId: string;
  readonly agentId: string;
  readonly category: InsertReceiptInput['category'];
  readonly decision: 'allow' | 'deny';
  /** Exact decimal string; the `bigint` never passes through a JS number. */
  readonly policyVersion: string;
  readonly appliedMode: InsertReceiptInput['appliedMode'];
  readonly appliedSpendCapUsd: string | null;
  readonly appliedPublishCap: number | null;
  readonly requestedAmountUsd: string | null;
  readonly requestedPublishCount: number | null;
  readonly remainingSpendUsd: string | null;
  readonly remainingPublishCount: number | null;
  readonly denyReason: string | null;
}

/** The projection every read shares, so no path returns a different shape. */
const RECEIPT_COLUMNS = {
  id: precheckReceipts.id,
  actionId: precheckReceipts.actionId,
  agentId: precheckReceipts.agentId,
  category: precheckReceipts.category,
  decision: precheckReceipts.decision,
  // Rendered by PostgreSQL so the bigint never becomes a lossy JS number.
  policyVersion: sql<string>`${precheckReceipts.policyVersion}::text`,
  appliedMode: precheckReceipts.appliedMode,
  appliedSpendCapUsd: precheckReceipts.appliedSpendCapUsd,
  appliedPublishCap: precheckReceipts.appliedPublishCap,
  requestedAmountUsd: precheckReceipts.requestedAmountUsd,
  requestedPublishCount: precheckReceipts.requestedPublishCount,
  remainingSpendUsd: precheckReceipts.remainingSpendUsd,
  remainingPublishCount: precheckReceipts.remainingPublishCount,
  denyReason: precheckReceipts.denyReason,
} as const;

/**
 * The projection the OPERATOR audit views share.
 *
 * Joins the agent for display and LEFT joins the plane block, so a list row
 * can show "this denial produced a block" without a second query per row. The
 * join condition repeats `workspace_id`, so it cannot pair a receipt with
 * another tenant's block even if the outer predicate were dropped.
 */
const AUDIT_COLUMNS = {
  ...RECEIPT_COLUMNS,
  accountingDay: precheckReceipts.accountingDay,
  ledgerSpendBeforeUsd: precheckReceipts.ledgerSpendBeforeUsd,
  ledgerPublishBefore: precheckReceipts.ledgerPublishBefore,
  createdAt: precheckReceipts.createdAt,
  agentUuid: agents.id,
  agentExternalId: agents.externalId,
  agentDisplayName: agents.displayName,
  blockUuid: blocks.id,
  blockRule: blocks.rule,
} as const;

/** Applies the shared joins. Extracted so list and detail cannot diverge. */
function auditSelect(executor: DatabaseExecutor) {
  return executor
    .select(AUDIT_COLUMNS)
    .from(precheckReceipts)
    .innerJoin(
      agents,
      and(
        eq(agents.id, precheckReceipts.agentId),
        eq(agents.workspaceId, precheckReceipts.workspaceId),
      ),
    )
    .leftJoin(
      blocks,
      and(
        eq(blocks.precheckReceiptId, precheckReceipts.id),
        eq(blocks.workspaceId, precheckReceipts.workspaceId),
      ),
    );
}

export const receiptQueries = {
  /** Existence check used by event ingest to validate a `precheck_id`. */
  exists: (executor: DatabaseExecutor, scope: WorkspaceScope, receiptId: string) =>
    executor
      .select({ id: precheckReceipts.id })
      .from(precheckReceipts)
      .where(and(receiptScopePredicate(scope), eq(precheckReceipts.id, receiptId)))
      .limit(1),

  /**
   * THE IDEMPOTENCY LOOKUP.
   *
   * `action_id` is client-supplied and unique only within a workspace, so the
   * predicate is composite. Two tenants may both use `act-1`.
   */
  findByActionId: (executor: DatabaseExecutor, scope: WorkspaceScope, actionId: string) =>
    executor
      .select(RECEIPT_COLUMNS)
      .from(precheckReceipts)
      .where(and(receiptScopePredicate(scope), eq(precheckReceipts.actionId, actionId)))
      .limit(1),

  /**
   * One page of the workspace audit stream, newest first.
   *
   * ORDERING. `created_at DESC, id DESC`. The timestamp is server-assigned;
   * `id` breaks ties, because a burst of decisions can share an instant and
   * without a tiebreaker cursor pagination repeats or skips rows. Same
   * convention as the event timeline.
   *
   * The agent filter takes an INTERNAL uuid the caller has already resolved
   * inside this workspace.
   */
  listAudit: (
    executor: DatabaseExecutor,
    scope: WorkspaceScope,
    options: {
      readonly limit: number;
      readonly agentId?: string | undefined;
      readonly decision?: 'allow' | 'deny' | undefined;
      readonly cursor?: { readonly createdAt: Date; readonly id: string } | undefined;
    },
  ) => {
    const predicates: SQL[] = [receiptScopePredicate(scope)];
    if (options.agentId !== undefined) {
      predicates.push(eq(precheckReceipts.agentId, options.agentId));
    }
    if (options.decision !== undefined) {
      predicates.push(eq(precheckReceipts.decision, options.decision));
    }
    if (options.cursor !== undefined) {
      // Row-value comparison: exactly the ordering boundary, in one expression
      // that cannot disagree with the ORDER BY. Both sides are bound
      // parameters with explicit casts - nothing is concatenated into SQL.
      predicates.push(
        sql`(${precheckReceipts.createdAt}, ${precheckReceipts.id}) < (${options.cursor.createdAt}::timestamptz, ${options.cursor.id}::uuid)`,
      );
    }

    return auditSelect(executor)
      .where(and(...predicates))
      .orderBy(desc(precheckReceipts.createdAt), desc(precheckReceipts.id))
      .limit(options.limit);
  },

  /** One receipt with its display linkage, by internal uuid. */
  findAuditById: (executor: DatabaseExecutor, scope: WorkspaceScope, receiptId: string) =>
    auditSelect(executor)
      .where(and(receiptScopePredicate(scope), eq(precheckReceipts.id, receiptId)))
      .limit(1),
} as const;

/** A receipt as the operator audit views present it. */
export interface AuditReceiptRow extends ReceiptRow {
  readonly accountingDay: string | null;
  readonly ledgerSpendBeforeUsd: string | null;
  readonly ledgerPublishBefore: number | null;
  readonly createdAt: Date;
  readonly agent: {
    readonly id: string;
    readonly externalId: string;
    readonly displayName: string | null;
  };
  /** The plane block this denial produced, if any. */
  readonly block: { readonly id: string; readonly rule: string } | null;
}

/** The ordering boundary an audit page resumes from. */
export interface AuditCursor {
  readonly createdAt: Date;
  readonly id: string;
}

export interface ListAuditOptions {
  readonly limit: number;
  /** INTERNAL agent uuid, already resolved inside this workspace. */
  readonly agentId?: string | undefined;
  readonly decision?: 'allow' | 'deny' | undefined;
  readonly cursor?: AuditCursor | undefined;
}

export interface PrecheckReceiptRepository {
  /**
   * True when the receipt exists IN THIS WORKSPACE.
   *
   * A receipt in another workspace returns false, exactly like one that does
   * not exist - the caller must not be able to probe another tenant's ids.
   */
  exists(receiptId: string): Promise<boolean>;

  /**
   * The receipt already recorded for this action, if any.
   *
   * @returns null when this workspace has never decided this action.
   */
  findByActionId(actionId: string): Promise<ReceiptRow | null>;

  /**
   * Records one decision, permanently.
   *
   * Must run inside the SAME transaction as any ledger mutation it explains -
   * see `apps/api/src/precheck/store.ts`. A receipt that committed while its
   * debit rolled back would claim spend that never happened, and a debit
   * without a receipt would be unexplainable money.
   */
  insert(input: InsertReceiptInput): Promise<ReceiptRow>;

  /** One page of the audit stream, newest first. Read-only. */
  listAudit(options: ListAuditOptions): Promise<AuditReceiptRow[]>;

  /**
   * One receipt with full persisted evidence.
   *
   * @returns null when the receipt is not in this workspace - indistinguishable
   *   from one that does not exist.
   */
  findAuditById(receiptId: string): Promise<AuditReceiptRow | null>;
}

/** Normalises a raw row so driver numeric behaviour never escapes this module. */
function toReceiptRow(row: {
  id: string;
  actionId: string;
  agentId: string;
  category: InsertReceiptInput['category'];
  decision: 'allow' | 'deny';
  policyVersion: string;
  appliedMode: InsertReceiptInput['appliedMode'];
  appliedSpendCapUsd: string | null;
  appliedPublishCap: number | null;
  requestedAmountUsd: string | null;
  requestedPublishCount: number | null;
  remainingSpendUsd: string | null;
  remainingPublishCount: number | null;
  denyReason: string | null;
}): ReceiptRow {
  return {
    ...row,
    // Canonical six-decimal form, so a receipt read back never differs in
    // shape from the value the decision reported to the caller.
    appliedSpendCapUsd:
      row.appliedSpendCapUsd === null ? null : normalizeUsd(row.appliedSpendCapUsd),
    requestedAmountUsd:
      row.requestedAmountUsd === null ? null : normalizeUsd(row.requestedAmountUsd),
    remainingSpendUsd:
      row.remainingSpendUsd === null ? null : normalizeUsd(row.remainingSpendUsd),
  };
}

/** Flattens the joined audit projection into the nested display shape. */
function toAuditRow(row: {
  accountingDay: string | null;
  ledgerSpendBeforeUsd: string | null;
  ledgerPublishBefore: number | null;
  createdAt: Date;
  agentUuid: string;
  agentExternalId: string;
  agentDisplayName: string | null;
  blockUuid: string | null;
  blockRule: string | null;
  id: string;
  actionId: string;
  agentId: string;
  category: InsertReceiptInput['category'];
  decision: 'allow' | 'deny';
  policyVersion: string;
  appliedMode: InsertReceiptInput['appliedMode'];
  appliedSpendCapUsd: string | null;
  appliedPublishCap: number | null;
  requestedAmountUsd: string | null;
  requestedPublishCount: number | null;
  remainingSpendUsd: string | null;
  remainingPublishCount: number | null;
  denyReason: string | null;
}): AuditReceiptRow {
  return {
    ...toReceiptRow(row),
    accountingDay: row.accountingDay,
    // Canonical six-decimal form, so evidence read back never differs in shape
    // from what the decision reported at the time.
    ledgerSpendBeforeUsd:
      row.ledgerSpendBeforeUsd === null ? null : normalizeUsd(row.ledgerSpendBeforeUsd),
    ledgerPublishBefore: row.ledgerPublishBefore,
    createdAt: row.createdAt,
    agent: {
      id: row.agentUuid,
      externalId: row.agentExternalId,
      displayName: row.agentDisplayName,
    },
    // The left join produced no block: an allow, or a denial from before
    // plane blocks existed.
    block:
      row.blockUuid === null || row.blockRule === null
        ? null
        : { id: row.blockUuid, rule: row.blockRule },
  };
}

export function createPrecheckReceiptRepository(
  executor: DatabaseExecutor,
  scope: WorkspaceScope,
): PrecheckReceiptRepository {
  return {
    async exists(receiptId: string): Promise<boolean> {
      const rows = await receiptQueries.exists(executor, scope, receiptId);
      return rows.length > 0;
    },

    async findByActionId(actionId: string): Promise<ReceiptRow | null> {
      const rows = await receiptQueries.findByActionId(executor, scope, actionId);
      const row = rows[0];
      return row === undefined ? null : toReceiptRow(row);
    },

    async insert(input: InsertReceiptInput): Promise<ReceiptRow> {
      const inserted = await executor
        .insert(precheckReceipts)
        .values({
          // Workspace from the SCOPE, never from caller input.
          workspaceId: scope.workspaceId,
          actionId: input.actionId,
          agentId: input.agentId,
          category: input.category,
          requestedAmountUsd: input.requestedAmountUsd,
          requestedPublishCount: input.requestedPublishCount,
          decision: input.decision,
          // The exact version as text, parsed by PostgreSQL into `bigint`.
          // Routing it through a JS number would lose precision above 2^53.
          policyVersion: sql`${input.policyVersion}::bigint`,
          appliedMode: input.appliedMode,
          appliedSpendCapUsd: input.appliedSpendCapUsd,
          appliedPublishCap: input.appliedPublishCap,
          accountingDay: input.accountingDay,
          ledgerSpendBeforeUsd: input.ledgerSpendBeforeUsd,
          ledgerPublishBefore: input.ledgerPublishBefore,
          remainingSpendUsd: input.remainingSpendUsd,
          remainingPublishCount: input.remainingPublishCount,
          denyReason: input.denyReason,
        })
        .returning(RECEIPT_COLUMNS);

      const row = inserted[0];
      if (row === undefined) {
        throw new Error('Failed to record the precheck receipt.');
      }
      return toReceiptRow(row);
    },

    async listAudit(options: ListAuditOptions): Promise<AuditReceiptRow[]> {
      const rows = await receiptQueries.listAudit(executor, scope, options);
      return rows.map(toAuditRow);
    },

    async findAuditById(receiptId: string): Promise<AuditReceiptRow | null> {
      const rows = await receiptQueries.findAuditById(executor, scope, receiptId);
      const row = rows[0];
      return row === undefined ? null : toAuditRow(row);
    },
  };
}
