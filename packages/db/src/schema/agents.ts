import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { runtimeProfiles } from './runtime.js';
import { workspaces } from './workspaces.js';

/**
 * Agents are workspace-owned.
 *
 * TENANT-SAFE RUNTIME REFERENCE
 * -----------------------------
 * `runtime_profile_id` is NOT a bare global foreign key. It is enforced through
 * the composite `(workspace_id, runtime_profile_id)` -> `runtime_profiles
 * (workspace_id, id)`, so an agent in workspace A cannot reference a profile in
 * workspace B - the database rejects it.
 *
 * The reference is nullable. PostgreSQL foreign keys default to MATCH SIMPLE,
 * so when `runtime_profile_id` is NULL the constraint is simply not checked,
 * which is the intended "no runtime assigned yet" state.
 *
 * DELETION
 * --------
 * RESTRICT on both parents. An agent accumulates events, receipts, blocks and
 * ledger rows; deleting its workspace or runtime profile out from under that
 * history must fail loudly rather than cascade.
 *
 * No discovery, heartbeat or last-seen behaviour is implemented here.
 */
export const agents = pgTable(
  'agents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'restrict' }),

    /**
     * Client-supplied stable identifier. Unique WITHIN a workspace, not
     * globally: two tenants must be free to name an agent `worker-1` without
     * colliding, and a global unique would leak one tenant's naming into
     * another's failure modes.
     */
    externalId: text('external_id').notNull(),

    displayName: text('display_name'),

    runtimeProfileId: uuid('runtime_profile_id'),

    /** Drives AC-04 ("last seen within 60 seconds"). Null until first contact. */
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('agents_workspace_external_id_key').on(table.workspaceId, table.externalId),
    // Target of every composite foreign key that points at an agent.
    unique('agents_workspace_id_id_key').on(table.workspaceId, table.id),
    foreignKey({
      name: 'agents_workspace_runtime_profile_fkey',
      columns: [table.workspaceId, table.runtimeProfileId],
      foreignColumns: [runtimeProfiles.workspaceId, runtimeProfiles.id],
    }).onDelete('restrict'),
    check('agents_external_id_nonempty_check', sql`length(${table.externalId}) > 0`),
    // AC-04: the agent roster for a workspace, ordered by liveness.
    index('agents_workspace_last_seen_idx').on(table.workspaceId, table.lastSeenAt),
  ],
);
