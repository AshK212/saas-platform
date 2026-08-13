import { and, eq, type SQL } from 'drizzle-orm';

import { precheckReceipts } from '../schema/receipts.js';
import type { DatabaseExecutor } from './executor.js';
import type { WorkspaceScope } from './workspace-scope.js';

/**
 * Workspace-scoped precheck receipt access.
 *
 * STEP 10 SCOPE: EXISTENCE CHECK ONLY.
 *
 * Event ingest needs to answer one question - "does this precheck_id name a
 * receipt in MY workspace?" - so it can link the event or reject the batch.
 * It does not read the decision, the amounts or the policy snapshot, and it
 * creates nothing.
 *
 * Receipt CREATION and the no-double-debit settlement behaviour belong to the
 * precheck steps. There is deliberately no insert here.
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

export interface PrecheckReceiptRepository {
  /**
   * True when the receipt exists IN THIS WORKSPACE.
   *
   * A receipt in another workspace returns false, exactly like one that does
   * not exist - the caller must not be able to probe another tenant's ids.
   */
  exists(receiptId: string): Promise<boolean>;
}

export function createPrecheckReceiptRepository(
  executor: DatabaseExecutor,
  scope: WorkspaceScope,
): PrecheckReceiptRepository {
  return {
    async exists(receiptId: string): Promise<boolean> {
      const rows = await executor
        .select({ id: precheckReceipts.id })
        .from(precheckReceipts)
        .where(and(receiptScopePredicate(scope), eq(precheckReceipts.id, receiptId)))
        .limit(1);

      return rows.length > 0;
    },
  };
}
