import { and, eq, sql } from 'drizzle-orm';

import { blocks } from '../schema/blocks.js';
import type { BlockRow } from './blocks.js';
import type { DatabaseExecutor } from './executor.js';
import type { WorkspaceScope } from './workspace-scope.js';

/**
 * PLANE-OWNED blocks - the control plane's own denials.
 *
 * WHOEVER DENIES, RECORDS.
 *
 * ─── WHY THIS IS A SEPARATE MODULE FROM `blocks.ts` ───────────────────────
 *
 * There are two block owners and they must never be confusable:
 *
 *   runtime  the plugin refused and is REPORTING it. Deduplicated on a
 *            client-supplied `external_block_id`, written by event ingest.
 *   plane    the control plane DECIDED to refuse. Written only inside the
 *            precheck decision transaction, alongside the receipt that
 *            explains it.
 *
 * Keeping them in separate modules with separate operations means neither can
 * accidentally produce the other's `source`. `blocks.ts` hardcodes `'runtime'`
 * and this file hardcodes `'plane'`; in both cases `source` is not a parameter,
 * so no caller - and no future refactor that passes an input object through -
 * can fabricate enforcement authority the plane never exercised.
 *
 * ─── WHY THERE IS NO GENERIC `createBlock` ────────────────────────────────
 *
 * A generic writer would eventually be called from a route, and a block that
 * claims the plane denied something it never evaluated is worse than no block:
 * it is false evidence in the audit trail an operator relies on.
 *
 * ─── TRANSACTION COMPOSITION ──────────────────────────────────────────────
 *
 * Takes the caller's `DatabaseExecutor` and never opens a transaction. The
 * block and its receipt must commit or roll back together; a block written on
 * a different connection could survive a rolled-back decision.
 */

/**
 * Everything a plane denial records.
 *
 * `source` is deliberately absent - see above. So is `externalBlockId`: a
 * plane block has no external identity, and the column is nullable precisely
 * so plane blocks can leave it NULL. PostgreSQL treats NULLs as distinct under
 * `UNIQUE (workspace_id, external_block_id)`, so any number of plane blocks
 * coexist without a synthetic key that would falsely imply a runtime origin.
 */
export interface PlaneBlockInput {
  /** Internal agent UUID, already resolved within this workspace. */
  readonly agentId: string;
  /** The receipt this denial explains. Same transaction, same workspace. */
  readonly precheckReceiptId: string;
  readonly category: BlockRow['category'];
  /** Governance control that fired, from the shared denial vocabulary. */
  readonly rule: string;
  /** Human-readable explanation, from the same vocabulary. */
  readonly reason: string;
  /** Decimal string for a spend denial; the column is numeric(14,6). */
  readonly amountUsd?: string | undefined;
  /** Count for a publish denial. */
  readonly count?: number | undefined;
  /** SERVER decision instant, shared with the receipt. */
  readonly createdAt: Date;
}

export interface PlaneBlockRepository {
  /**
   * Records one plane-owned denial.
   *
   * Must run inside the SAME transaction as the receipt it references. There
   * is no update and no delete: a block is historical evidence of a refusal,
   * and a rewritable one would be worthless.
   */
  createForDeniedPrecheck(input: PlaneBlockInput): Promise<BlockRow>;

  /** The block accompanying a receipt, if any. Reverse lookup for audit. */
  findByReceiptId(precheckReceiptId: string): Promise<BlockRow | null>;
}

export function createPlaneBlockRepository(
  executor: DatabaseExecutor,
  scope: WorkspaceScope,
): PlaneBlockRepository {
  return {
    async createForDeniedPrecheck(input: PlaneBlockInput): Promise<BlockRow> {
      const inserted = await executor
        .insert(blocks)
        .values({
          // Workspace from the SCOPE, never from caller input.
          workspaceId: scope.workspaceId,
          agentId: input.agentId,
          // NOT A PARAMETER. Only this function may mint a plane block, and it
          // always means the plane itself decided.
          source: 'plane',
          // NULL: a plane block has no external identity. Synthesising one
          // would falsely imply a runtime reported it.
          externalBlockId: null,
          precheckReceiptId: input.precheckReceiptId,
          category: input.category,
          rule: input.rule,
          reason: input.reason,
          amountUsd: input.amountUsd ?? null,
          count: input.count ?? null,
          // The SAME instant as the receipt, so the pair describes one
          // decision rather than two events milliseconds apart.
          createdAt: input.createdAt,
        })
        .returning();

      const row = inserted[0];
      if (row === undefined) {
        // Rolls the whole decision back: a denial that cannot be recorded must
        // not be reported as having happened.
        throw new Error('Failed to record the plane block.');
      }
      return row;
    },

    async findByReceiptId(precheckReceiptId: string): Promise<BlockRow | null> {
      const rows = await executor
        .select()
        .from(blocks)
        .where(
          and(
            eq(blocks.workspaceId, scope.workspaceId),
            eq(blocks.precheckReceiptId, precheckReceiptId),
            // Only plane denials carry a receipt reference, but the predicate
            // is explicit so a future runtime block that gained one could not
            // be mistaken for a plane decision.
            eq(blocks.source, 'plane'),
          ),
        )
        .limit(1);

      return rows[0] ?? null;
    },
  };
}

/** Query builders, separated so architecture tests can render the SQL. */
export const planeBlockQueries = {
  findByReceiptId: (
    executor: DatabaseExecutor,
    scope: WorkspaceScope,
    precheckReceiptId: string,
  ) =>
    executor
      .select()
      .from(blocks)
      .where(
        and(
          eq(blocks.workspaceId, scope.workspaceId),
          eq(blocks.precheckReceiptId, precheckReceiptId),
          eq(blocks.source, 'plane'),
        ),
      )
      .limit(1),

  /** Counts plane blocks in a workspace. Used only by tests and diagnostics. */
  countForWorkspace: (executor: DatabaseExecutor, scope: WorkspaceScope) =>
    executor
      .select({ total: sql<string>`count(*)::text` })
      .from(blocks)
      .where(and(eq(blocks.workspaceId, scope.workspaceId), eq(blocks.source, 'plane'))),
} as const;
