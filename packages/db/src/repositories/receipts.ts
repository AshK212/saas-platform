import { and, eq, sql, type SQL } from 'drizzle-orm';

import { normalizeUsd } from '../accounting/money.js';
import type { UtcAccountingDay } from '../accounting/utc-day.js';
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
} as const;

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
  };
}
