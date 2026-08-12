import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  integer,
  numeric,
  pgTable,
  primaryKey,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { agents } from './agents.js';
import { agentMode } from './enums.js';
import { workspaces } from './workspaces.js';

/**
 * Workspace policy version.
 *
 * One row per workspace holding a monotonically increasing version counter.
 * Every policy mutation will later increment this in the same transaction as
 * the change itself, and every precheck receipt records the exact version it
 * evaluated against.
 *
 * WHY A COUNTER AND NOT A SNAPSHOT HISTORY
 * ----------------------------------------
 * A full historical snapshot system is not required by the Credit criteria.
 * The receipt preserves the values that explain its own decision (see
 * `receipts.ts`), so an old decision is fully explicable without replaying
 * policy history. Adding snapshots now would be speculative.
 *
 * Monotonicity is enforced by the application inside the mutating transaction;
 * the database guarantees the floor (`version >= 1`) and single-row-per-
 * workspace ownership.
 */
export const workspacePolicyState = pgTable(
  'workspace_policy_state',
  {
    workspaceId: uuid('workspace_id')
      .primaryKey()
      .references(() => workspaces.id, { onDelete: 'cascade' }),

    version: bigint('version', { mode: 'number' }).notNull().default(1),

    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [check('workspace_policy_state_version_check', sql`${table.version} >= 1`)],
);

/**
 * Per-agent policy values.
 *
 * The composite primary key `(workspace_id, agent_id)` gives exactly one policy
 * row per agent and makes the row inherently workspace-anchored.
 *
 * Caps are nullable: NULL means "no cap of this kind", which is distinct from
 * a cap of 0 (meaning "nothing is permitted"). Collapsing those two would make
 * a zero cap unrepresentable.
 *
 * Caps cascade on agent deletion because a policy is a property of its agent,
 * not audit history. The audit trail of decisions lives in receipts and blocks,
 * which use RESTRICT.
 */
export const agentPolicies = pgTable(
  'agent_policies',
  {
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id').notNull(),

    mode: agentMode('mode').notNull().default('watch'),

    /** Daily USD spend cap. NULL = uncapped. See money notes in ledger.ts. */
    dailySpendCapUsd: numeric('daily_spend_cap_usd', { precision: 14, scale: 6 }),

    /** Daily publish-count cap. NULL = uncapped. */
    dailyPublishCap: integer('daily_publish_cap'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: 'agent_policies_pkey', columns: [table.workspaceId, table.agentId] }),
    foreignKey({
      name: 'agent_policies_workspace_agent_fkey',
      columns: [table.workspaceId, table.agentId],
      foreignColumns: [agents.workspaceId, agents.id],
    }).onDelete('cascade'),
    check(
      'agent_policies_daily_spend_cap_nonnegative_check',
      sql`${table.dailySpendCapUsd} is null or ${table.dailySpendCapUsd} >= 0`,
    ),
    check(
      'agent_policies_daily_publish_cap_nonnegative_check',
      sql`${table.dailyPublishCap} is null or ${table.dailyPublishCap} >= 0`,
    ),
  ],
);
