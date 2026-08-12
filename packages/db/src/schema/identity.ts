import { sql } from 'drizzle-orm';
import { check, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

/**
 * Identity.
 *
 * Users are GLOBAL, not workspace-owned: one human has one identity and may
 * belong to many workspaces via `workspace_memberships`. Tenant scoping is
 * therefore a property of membership, never of the user record.
 *
 * NO AUTHENTICATION HERE. There is no password column, no session column and
 * no magic-link column by design - magic-link sign-in (AC-01) is a later step,
 * and passwords are never part of this platform.
 */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /**
     * Stored already normalised to lowercase; the check constraint below makes
     * that a database invariant rather than a convention. Combined with the
     * unique constraint this yields case-insensitive uniqueness without
     * needing the `citext` extension or an expression index.
     */
    email: text('email').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('users_email_key').on(table.email),
    check('users_email_lowercase_check', sql`${table.email} = lower(${table.email})`),
    check('users_email_nonempty_check', sql`length(${table.email}) > 0`),
  ],
);
