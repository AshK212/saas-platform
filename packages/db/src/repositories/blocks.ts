import { and, desc, eq, sql, type SQL } from 'drizzle-orm';

import { normalizeUsd } from '../accounting/money.js';
import { agents } from '../schema/agents.js';
import { blocks } from '../schema/blocks.js';
import type { DatabaseExecutor } from './executor.js';
import type { WorkspaceScope } from './workspace-scope.js';

/**
 * Workspace-scoped block access.
 *
 * STEP 10 SCOPE: runtime/client-reported blocks only.
 *
 * A block recorded here has `source = 'runtime'` - the runtime denied the
 * action and is reporting it. PLANE-OWNED blocks (denials the control plane
 * decides) are written by the precheck path in a later step, in the same
 * transaction as their receipt. Nothing in this file may create one, and
 * `source` is not a parameter for exactly that reason.
 */

export type BlockRow = typeof blocks.$inferSelect;

export interface ResolveRuntimeBlockInput {
  /** Client/runtime-supplied identifier. The deduplication key. */
  readonly externalBlockId: string;
  /** Internal agent UUID, already resolved within this workspace. */
  readonly agentId: string;
  readonly category: BlockRow['category'];
  readonly rule: string;
  readonly reason: string;
  /** Decimal string for a spend denial; the column is numeric(14,6). */
  readonly amountUsd?: string | undefined;
  /** Count for a publish denial. */
  readonly count?: number | undefined;
}

/** A block as the operator audit views present it. */
export interface AuditBlockRow {
  readonly id: string;
  /** PERSISTED ownership. Never inferred by a caller. */
  readonly source: 'plane' | 'runtime';
  readonly category: BlockRow['category'];
  readonly rule: string;
  readonly reason: string;
  /** The client's own identity. Always null for a plane block. */
  readonly externalBlockId: string | null;
  /** The denial receipt this block explains. Null for runtime blocks. */
  readonly precheckReceiptId: string | null;
  readonly amountUsd: string | null;
  readonly count: number | null;
  readonly createdAt: Date;
  readonly agent: {
    readonly id: string;
    readonly externalId: string;
    readonly displayName: string | null;
  };
}

/** The ordering boundary a block page resumes from. */
export interface BlockCursor {
  readonly createdAt: Date;
  readonly id: string;
}

export interface ListBlocksOptions {
  readonly limit: number;
  /** INTERNAL agent uuid, already resolved inside this workspace. */
  readonly agentId?: string | undefined;
  readonly source?: 'plane' | 'runtime' | undefined;
  readonly cursor?: BlockCursor | undefined;
}

export interface BlockRepository {
  findByExternalId(externalBlockId: string): Promise<BlockRow | null>;
  /** One page of the workspace block stream, newest first. Read-only. */
  listAudit(options: ListBlocksOptions): Promise<AuditBlockRow[]>;
  /** One block by internal uuid. Null when not in this workspace. */
  findAuditById(blockId: string): Promise<AuditBlockRow | null>;
  /**
   * Resolves an existing runtime block by its external id, or creates it.
   *
   * Idempotent by database constraint - see the implementation note.
   */
  resolveOrCreateRuntimeBlock(input: ResolveRuntimeBlockInput): Promise<BlockRow>;
}

/**
 * The projection the operator block views share.
 *
 * The agent join repeats `workspace_id`, so it cannot pair a block with
 * another tenant's agent even if the outer predicate were dropped.
 */
const AUDIT_BLOCK_COLUMNS = {
  id: blocks.id,
  source: blocks.source,
  category: blocks.category,
  rule: blocks.rule,
  reason: blocks.reason,
  externalBlockId: blocks.externalBlockId,
  precheckReceiptId: blocks.precheckReceiptId,
  amountUsd: blocks.amountUsd,
  count: blocks.count,
  createdAt: blocks.createdAt,
  agentUuid: agents.id,
  agentExternalId: agents.externalId,
  agentDisplayName: agents.displayName,
} as const;

function auditBlockSelect(executor: DatabaseExecutor) {
  return executor
    .select(AUDIT_BLOCK_COLUMNS)
    .from(blocks)
    .innerJoin(
      agents,
      and(eq(agents.id, blocks.agentId), eq(agents.workspaceId, blocks.workspaceId)),
    );
}

/** Query builders, separated so architecture tests can render the SQL. */
export const blockAuditQueries = {
  /**
   * One page of the block stream, newest first.
   *
   * `created_at DESC, id DESC` - matching the audit convention. Both runtime
   * and plane blocks are visible; ownership is a filter, never a hidden
   * exclusion.
   */
  list: (
    executor: DatabaseExecutor,
    scope: WorkspaceScope,
    options: ListBlocksOptions,
  ) => {
    const predicates: SQL[] = [eq(blocks.workspaceId, scope.workspaceId)];
    if (options.agentId !== undefined) {
      predicates.push(eq(blocks.agentId, options.agentId));
    }
    if (options.source !== undefined) {
      predicates.push(eq(blocks.source, options.source));
    }
    if (options.cursor !== undefined) {
      predicates.push(
        sql`(${blocks.createdAt}, ${blocks.id}) < (${options.cursor.createdAt}::timestamptz, ${options.cursor.id}::uuid)`,
      );
    }

    return auditBlockSelect(executor)
      .where(and(...predicates))
      .orderBy(desc(blocks.createdAt), desc(blocks.id))
      .limit(options.limit);
  },

  findById: (executor: DatabaseExecutor, scope: WorkspaceScope, blockId: string) =>
    auditBlockSelect(executor)
      .where(and(eq(blocks.workspaceId, scope.workspaceId), eq(blocks.id, blockId)))
      .limit(1),
} as const;

/** Flattens the joined projection into the nested display shape. */
function toAuditBlockRow(row: {
  id: string;
  source: 'plane' | 'runtime';
  category: BlockRow['category'];
  rule: string;
  reason: string;
  externalBlockId: string | null;
  precheckReceiptId: string | null;
  amountUsd: string | null;
  count: number | null;
  createdAt: Date;
  agentUuid: string;
  agentExternalId: string;
  agentDisplayName: string | null;
}): AuditBlockRow {
  return {
    id: row.id,
    source: row.source,
    category: row.category,
    rule: row.rule,
    reason: row.reason,
    externalBlockId: row.externalBlockId,
    precheckReceiptId: row.precheckReceiptId,
    // Canonical six-decimal form, matching every other money surface.
    amountUsd: row.amountUsd === null ? null : normalizeUsd(row.amountUsd),
    count: row.count,
    createdAt: row.createdAt,
    agent: {
      id: row.agentUuid,
      externalId: row.agentExternalId,
      displayName: row.agentDisplayName,
    },
  };
}

export function createBlockRepository(
  executor: DatabaseExecutor,
  scope: WorkspaceScope,
): BlockRepository {
  async function findByExternalId(externalBlockId: string): Promise<BlockRow | null> {
    const rows = await executor
      .select()
      .from(blocks)
      .where(
        and(
          eq(blocks.workspaceId, scope.workspaceId),
          eq(blocks.externalBlockId, externalBlockId),
        ),
      )
      .limit(1);

    return rows[0] ?? null;
  }

  return {
    findByExternalId,

    async listAudit(options: ListBlocksOptions): Promise<AuditBlockRow[]> {
      const rows = await blockAuditQueries.list(executor, scope, options);
      return rows.map(toAuditBlockRow);
    },

    async findAuditById(blockId: string): Promise<AuditBlockRow | null> {
      const rows = await blockAuditQueries.findById(executor, scope, blockId);
      const row = rows[0];
      return row === undefined ? null : toAuditBlockRow(row);
    },

    /**
     * Atomic resolve-or-create.
     *
     *   INSERT INTO blocks (...) VALUES (...)
     *   ON CONFLICT (workspace_id, external_block_id) DO NOTHING
     *   RETURNING *
     *   -- then, if nothing came back, SELECT the winner
     *
     * The unique index on `(workspace_id, external_block_id)` is the
     * deduplication boundary, so the same runtime block id reported twice
     * yields ONE row. Two workspaces reporting `block-123` remain independent,
     * because the constraint is composite.
     *
     * `DO NOTHING` rather than `DO UPDATE`: a re-report must not rewrite the
     * original rule, reason or amount. The first report is the audit record.
     *
     * The follow-up SELECT is not a race window - it runs only after the insert
     * has already lost the conflict, meaning the winning row is committed and
     * visible within this transaction's snapshot.
     */
    async resolveOrCreateRuntimeBlock(input: ResolveRuntimeBlockInput): Promise<BlockRow> {
      const inserted = await executor
        .insert(blocks)
        .values({
          // Workspace from the SCOPE, never from caller input.
          workspaceId: scope.workspaceId,
          agentId: input.agentId,
          externalBlockId: input.externalBlockId,
          // Not a parameter: this repository only records runtime denials.
          source: 'runtime',
          category: input.category,
          rule: input.rule,
          reason: input.reason,
          amountUsd: input.amountUsd ?? null,
          count: input.count ?? null,
        })
        .onConflictDoNothing({ target: [blocks.workspaceId, blocks.externalBlockId] })
        .returning();

      const created = inserted[0];
      if (created !== undefined) {
        return created;
      }

      const existing = await findByExternalId(input.externalBlockId);
      if (existing === null) {
        throw new Error('Failed to resolve runtime block after conflict.');
      }
      return existing;
    },
  };
}
