import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { membershipRole } from './enums.js';
import { users } from './identity.js';

/**
 * The tenant boundary.
 *
 * Every tenant-owned table in this schema carries `workspace_id` and links back
 * here. Nothing tenant-owned exists outside a workspace.
 */
export const workspaces = pgTable(
  'workspaces',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),

    /**
     * AC-19 (public demo) foundation. The flag exists so the demo workspace is
     * identifiable without a separate table. No demo behaviour is implemented.
     */
    demoEnabled: boolean('demo_enabled').notNull().default(false),

    /**
     * Stable, NON-SECRET public identifier for the demo workspace, e.g. used in
     * a public URL. Nullable because only demo workspaces have one. Unique so a
     * public lookup is unambiguous.
     *
     * This carries no authority: it identifies, it does not authorise.
     */
    demoSlug: text('demo_slug'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('workspaces_demo_slug_key').on(table.demoSlug),
    check('workspaces_name_nonempty_check', sql`length(${table.name}) > 0`),
    // A slug is only meaningful on a demo-enabled workspace.
    check(
      'workspaces_demo_slug_requires_demo_check',
      sql`${table.demoSlug} is null or ${table.demoEnabled}`,
    ),
  ],
);

/**
 * Membership links a global user to a workspace.
 *
 * The composite primary key makes duplicate membership impossible, so a user
 * cannot hold two conflicting roles in the same workspace.
 *
 * Deletion cascades from both sides: a membership is a pure link, not audit
 * history, so removing a user or workspace should remove the link rather than
 * leave a dangling row. Audit tables (events, receipts, blocks, ledger) use
 * RESTRICT instead - see docs/architecture.md.
 */
export const workspaceMemberships = pgTable(
  'workspace_memberships',
  {
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: membershipRole('role').notNull().default('member'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: 'workspace_memberships_pkey',
      columns: [table.workspaceId, table.userId],
    }),
    // "Which workspaces does this user belong to?" - the sign-in path.
    index('workspace_memberships_user_idx').on(table.userId),
  ],
);
