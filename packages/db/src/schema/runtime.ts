import { sql } from 'drizzle-orm';
import { check, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

import { workspaces } from './workspaces.js';

/**
 * Runtime profiles - the vendor-neutral runtime reference.
 *
 * WHY WORKSPACE-OWNED RATHER THAN GLOBAL
 * --------------------------------------
 * Both designs were considered. Workspace-owned wins on the two criteria that
 * matter here:
 *
 *   1. Tenant isolation stays uniform. Agents reference a profile through the
 *      same composite `(workspace_id, id)` foreign key used everywhere else, so
 *      there is no exception to the isolation rule to remember or audit.
 *      A global table would force agent -> profile to be a bare global FK,
 *      i.e. the one shape section 15 warns against.
 *   2. No shared mutable cross-tenant state. A global profile edited by one
 *      party would silently change behaviour for every other tenant.
 *
 * The cost is duplicated rows when two workspaces use the same runtime, which
 * is negligible and avoids a shared-ownership problem.
 *
 * VENDOR NEUTRALITY
 * -----------------
 * `adapter_key` is free-form text, not an enum, so adding a runtime never
 * requires a migration and no vendor name is baked into the schema. This
 * mirrors the `RuntimeProfile` contract in @hybrid/runtime-core.
 *
 * NO SECRETS HERE. `config` holds non-secret metadata only (endpoints, model
 * names, limits). Runtime credentials belong in the environment, never in a
 * tenant-readable table.
 */
export const runtimeProfiles = pgTable(
  'runtime_profiles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'restrict' }),

    /** Stable operator-facing name, unique within the workspace. */
    name: text('name').notNull(),

    /** Vendor-neutral adapter identifier, e.g. `local-dev`, `hosted-default`. */
    adapterKey: text('adapter_key').notNull(),

    /** Non-secret configuration metadata. */
    config: jsonb('config').notNull().default({}),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('runtime_profiles_workspace_name_key').on(table.workspaceId, table.name),
    // Target of the composite foreign key from agents and sessions. This is
    // what makes a cross-workspace runtime reference structurally impossible.
    unique('runtime_profiles_workspace_id_id_key').on(table.workspaceId, table.id),
    check('runtime_profiles_name_nonempty_check', sql`length(${table.name}) > 0`),
    check('runtime_profiles_adapter_key_nonempty_check', sql`length(${table.adapterKey}) > 0`),
  ],
);
