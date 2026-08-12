import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  date,
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
import { actionCategory, agentMode, precheckDecision } from './enums.js';
import { workspaces } from './workspaces.js';

/**
 * Durable precheck receipts.
 *
 * EVERY precheck produces a receipt, allow or deny. The receipt is the
 * plane's evidence of a decision.
 *
 * IMMUTABLE AND SELF-EXPLAINING
 * -----------------------------
 * A receipt must explain an old decision without consulting anything that can
 * change afterwards. It therefore snapshots, as historical values:
 *
 *   - `policy_version`   - the exact workspace policy version evaluated;
 *   - `applied_mode`,
 *     `applied_*_cap`    - the policy values actually applied, so a later cap
 *                          change cannot rewrite the explanation of this
 *                          decision;
 *   - `ledger_*_before`  - the authoritative ledger state at decision time;
 *   - `remaining_*`      - the headroom returned to the caller.
 *
 * Reading the current `agent_policies` row to explain a past receipt would be
 * wrong by construction; that is exactly what these columns prevent.
 *
 * Rows are insert-only. Nothing in this schema updates a receipt - see the
 * note on block linkage in `blocks.ts`.
 *
 * Money uses `numeric(14, 6)`; see the notes in `ledger.ts`.
 */
export const precheckReceipts = pgTable(
  'precheck_receipts',
  {
    /** This id IS the precheck_id referenced by events and blocks. */
    id: uuid('id').primaryKey().defaultRandom(),

    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'restrict' }),
    agentId: uuid('agent_id').notNull(),

    category: actionCategory('category').notNull(),

    /** What was asked for. Both nullable: a request is spend, publish, or neither. */
    requestedAmountUsd: numeric('requested_amount_usd', { precision: 14, scale: 6 }),
    requestedPublishCount: integer('requested_publish_count'),

    decision: precheckDecision('decision').notNull(),

    /** Historical snapshot of the policy that produced this decision. */
    policyVersion: bigint('policy_version', { mode: 'number' }).notNull(),
    appliedMode: agentMode('applied_mode').notNull(),
    appliedSpendCapUsd: numeric('applied_spend_cap_usd', { precision: 14, scale: 6 }),
    appliedPublishCap: integer('applied_publish_cap'),

    /** UTC accounting day the decision was evaluated against. */
    accountingDay: date('accounting_day', { mode: 'string' }),

    /** Authoritative ledger state read during the decision. */
    ledgerSpendBeforeUsd: numeric('ledger_spend_before_usd', { precision: 14, scale: 6 }),
    ledgerPublishBefore: integer('ledger_publish_before'),

    /** Headroom returned to the caller. */
    remainingSpendUsd: numeric('remaining_spend_usd', { precision: 14, scale: 6 }),
    remainingPublishCount: integer('remaining_publish_count'),

    /** Required when the decision is a denial. */
    denyReason: text('deny_reason'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Target of the composite foreign keys from blocks and events.
    unique('precheck_receipts_workspace_id_id_key').on(table.workspaceId, table.id),
    foreignKey({
      name: 'precheck_receipts_workspace_agent_fkey',
      columns: [table.workspaceId, table.agentId],
      foreignColumns: [agents.workspaceId, agents.id],
    }).onDelete('restrict'),

    // A denial must always carry a reason. An allow may omit one.
    check(
      'precheck_receipts_deny_requires_reason_check',
      sql`${table.decision} <> 'deny' or ${table.denyReason} is not null`,
    ),
    check(
      'precheck_receipts_requested_amount_nonnegative_check',
      sql`${table.requestedAmountUsd} is null or ${table.requestedAmountUsd} >= 0`,
    ),
    check(
      'precheck_receipts_requested_publish_nonnegative_check',
      sql`${table.requestedPublishCount} is null or ${table.requestedPublishCount} >= 0`,
    ),
    check(
      'precheck_receipts_ledger_spend_nonnegative_check',
      sql`${table.ledgerSpendBeforeUsd} is null or ${table.ledgerSpendBeforeUsd} >= 0`,
    ),
    check(
      'precheck_receipts_ledger_publish_nonnegative_check',
      sql`${table.ledgerPublishBefore} is null or ${table.ledgerPublishBefore} >= 0`,
    ),
    check('precheck_receipts_policy_version_check', sql`${table.policyVersion} >= 1`),

    // Receipt history for an agent, newest first.
    index('precheck_receipts_workspace_agent_created_idx').on(
      table.workspaceId,
      table.agentId,
      table.createdAt,
    ),
  ],
);
