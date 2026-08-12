import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { agents } from './agents.js';
import { actionCategory, blockSource } from './enums.js';
import { precheckReceipts } from './receipts.js';
import { workspaces } from './workspaces.js';

/**
 * Durable blocked actions.
 *
 * WHOEVER DENIES, RECORDS. A plane-owned denial will later write a block in the
 * same transaction as its denying receipt. A runtime/client-side denial is also
 * valid and is recorded as reported, distinguished by `source`.
 *
 * WHY THE RECEIPT LINK LIVES HERE, AND ONLY HERE
 * ----------------------------------------------
 * Receipts and blocks are conceptually linked in both directions, but the
 * foreign key is modelled once, on the block. Two reasons:
 *
 *   1. A mutual foreign key would be circular - unresolvable at insert time
 *      without a deferred constraint, and a genuine import cycle in TypeScript.
 *   2. Receipts must stay insert-only. Storing `block_id` on the receipt would
 *      require updating the receipt after the block is written, contradicting
 *      the immutability that makes a receipt trustworthy evidence.
 *
 * Both directions remain queryable: a receipt's block is
 * `blocks WHERE precheck_receipt_id = :receipt`. Because the pair is written in
 * one transaction, the linkage is atomic either way.
 *
 * EXTERNAL DEDUPLICATION
 * ----------------------
 * `external_block_id` is a client-supplied identifier, unique WITHIN a
 * workspace, which is the constraint a later ingest path needs to deduplicate
 * replayed blocks. It is nullable because plane-owned blocks have no external
 * id; PostgreSQL treats NULLs as distinct, so any number of plane blocks
 * coexist under this constraint.
 *
 * No deduplication, emission or enforcement behaviour is implemented here.
 */
export const blocks = pgTable(
  'blocks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'restrict' }),
    agentId: uuid('agent_id').notNull(),

    /** Client-supplied id, unique per workspace. NULL for plane-owned blocks. */
    externalBlockId: text('external_block_id'),

    /** Who denied: the control plane, or a runtime/client. */
    source: blockSource('source').notNull(),

    category: actionCategory('category').notNull(),

    /** Machine-readable rule identifier, e.g. `daily_spend_cap`. */
    rule: text('rule').notNull(),

    /** Human-readable explanation. */
    reason: text('reason').notNull(),

    /** Metadata about what was refused. Both nullable. */
    amountUsd: numeric('amount_usd', { precision: 14, scale: 6 }),
    count: integer('count'),

    /** Set when this block accompanies a plane-owned denial. */
    precheckReceiptId: uuid('precheck_receipt_id'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Target of the composite foreign key from events.
    unique('blocks_workspace_id_id_key').on(table.workspaceId, table.id),
    // Deduplication boundary for externally supplied block ids.
    unique('blocks_workspace_external_block_id_key').on(table.workspaceId, table.externalBlockId),

    foreignKey({
      name: 'blocks_workspace_agent_fkey',
      columns: [table.workspaceId, table.agentId],
      foreignColumns: [agents.workspaceId, agents.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'blocks_workspace_precheck_receipt_fkey',
      columns: [table.workspaceId, table.precheckReceiptId],
      foreignColumns: [precheckReceipts.workspaceId, precheckReceipts.id],
    }).onDelete('restrict'),

    check('blocks_rule_nonempty_check', sql`length(${table.rule}) > 0`),
    check('blocks_reason_nonempty_check', sql`length(${table.reason}) > 0`),
    check(
      'blocks_amount_nonnegative_check',
      sql`${table.amountUsd} is null or ${table.amountUsd} >= 0`,
    ),
    check('blocks_count_nonnegative_check', sql`${table.count} is null or ${table.count} >= 0`),

    // AC-19 / operator timeline: recent blocks for a workspace.
    index('blocks_workspace_created_idx').on(table.workspaceId, table.createdAt),
    // Reverse lookup "which block accompanied this receipt?". The receipt->block
    // direction has no foreign key by design (see above), so this index is what
    // makes that documented query path efficient. Partial, because only
    // plane-owned denials carry a receipt reference.
    index('blocks_workspace_precheck_receipt_idx')
      .on(table.workspaceId, table.precheckReceiptId)
      .where(sql`precheck_receipt_id is not null`),
  ],
);
