import { sql } from 'drizzle-orm';
import {
  check,
  date,
  foreignKey,
  integer,
  numeric,
  pgTable,
  primaryKey,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { agents } from './agents.js';
import { workspaces } from './workspaces.js';

/**
 * Authoritative UTC-day ledger.
 *
 * THE PLANE IS THE LEDGER. This table is the authoritative record of what has
 * been committed. A runtime never writes here; the control plane does, inside
 * the transaction that allows an action.
 *
 * MONEY REPRESENTATION
 * --------------------
 * `numeric(14, 6)` - fixed precision, never floating point. Scale 6 records
 * micro-dollars, which matters because per-call AI costs are routinely
 * fractions of a cent; rounding at cent precision would systematically lose
 * spend. Precision 14 allows values up to 99,999,999.999999, far beyond any
 * Credit-phase need.
 *
 * Drizzle maps `numeric` to a JavaScript **string**, not a number. That is
 * intentional and must be preserved: converting to `number` would reintroduce
 * IEEE-754 error into authoritative accounting.
 *
 * UTC ACCOUNTING DAY
 * ------------------
 * `day` is a PostgreSQL `date`, which carries no timezone, and is defined as
 * the UTC accounting day. Local-time daily boundaries are never stored. The
 * column is mapped in `string` mode ('YYYY-MM-DD') so it can never be silently
 * shifted by a JavaScript `Date` in the server's local zone.
 *
 * ROW IDENTITY
 * ------------
 * The composite primary key `(workspace_id, agent_id, day)` is the uniqueness
 * guarantee required for commit-on-allow: exactly one authoritative row per
 * agent per UTC day. Later enforcement locks precisely this row
 * (`SELECT … FOR UPDATE`) to serialize concurrent cap decisions.
 *
 * No mutation, debit, precheck or retry logic is implemented here.
 */
export const ledgerDaily = pgTable(
  'ledger_daily',
  {
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'restrict' }),
    agentId: uuid('agent_id').notNull(),

    /** UTC accounting day, 'YYYY-MM-DD'. */
    day: date('day', { mode: 'string' }).notNull(),

    spendCommittedUsd: numeric('spend_committed_usd', { precision: 14, scale: 6 })
      .notNull()
      .default('0'),

    /**
     * `integer` deliberately, matching every other publish count and cap in the
     * schema. A single agent's publishes within one UTC day cannot approach
     * 2,147,483,647, and one consistent type avoids silent widening surprises
     * when caps and counters are compared during enforcement.
     */
    publishCountCommitted: integer('publish_count_committed').notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Exactly one authoritative row per workspace/agent/UTC-day.
    primaryKey({
      name: 'ledger_daily_pkey',
      columns: [table.workspaceId, table.agentId, table.day],
    }),
    foreignKey({
      name: 'ledger_daily_workspace_agent_fkey',
      columns: [table.workspaceId, table.agentId],
      foreignColumns: [agents.workspaceId, agents.id],
    }).onDelete('restrict'),
    check('ledger_daily_spend_nonnegative_check', sql`${table.spendCommittedUsd} >= 0`),
    check('ledger_daily_publish_nonnegative_check', sql`${table.publishCountCommitted} >= 0`),
  ],
);
