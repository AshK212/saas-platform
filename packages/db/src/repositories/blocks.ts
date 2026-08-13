import { and, eq } from 'drizzle-orm';

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

export interface BlockRepository {
  findByExternalId(externalBlockId: string): Promise<BlockRow | null>;
  /**
   * Resolves an existing runtime block by its external id, or creates it.
   *
   * Idempotent by database constraint - see the implementation note.
   */
  resolveOrCreateRuntimeBlock(input: ResolveRuntimeBlockInput): Promise<BlockRow>;
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
