import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

import { users } from './identity.js';

/**
 * Authentication schema (Step 5).
 *
 * NOT THE RUNTIME `sessions` TABLE
 * --------------------------------
 * `schema/sessions.ts` defines *runtime/agent* sessions - a workspace-owned
 * record of an agent's execution context. These tables are entirely separate:
 * they are GLOBAL, user-owned browser-authentication artifacts with no
 * workspace column at all. The `auth_` prefix keeps the distinction visible in
 * SQL, logs and query plans.
 *
 * WHY THESE TABLES CARRY NO workspace_id
 * --------------------------------------
 * Authenticating proves *who* someone is. It grants access to no workspace.
 * Putting a workspace column here would invite exactly the conflation the
 * architecture forbids - see docs/adr/0002-authentication.md.
 *
 * SECRET HANDLING - AUDITED
 * -------------------------
 * Neither table can hold a reusable bearer credential. Both store only a
 * SHA-256 hash of high-entropy random material. The plaintext exists in the
 * emailed URL and in the browser cookie, never at rest.
 */

/**
 * Magic-link challenges.
 *
 * A row is a single-use, time-limited invitation to establish a session.
 * Consumption is an atomic conditional UPDATE - see `identity/magic-links.ts`.
 */
export const authMagicLinks = pgTable(
  'auth_magic_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    userId: uuid('user_id')
      .notNull()
      // A magic link is an ephemeral auth artifact, not tenant audit history,
      // so removing an identity should remove its pending challenges.
      .references(() => users.id, { onDelete: 'cascade' }),

    /**
     * Normalised email snapshot at issuance.
     *
     * Denormalised on purpose: the issuance cooldown queries by email and must
     * not have to join `users`, and an audit of "who was a link sent to" should
     * survive a later address change.
     */
    email: text('email').notNull(),

    /** SHA-256 of the plaintext token. The token itself is never stored. */
    tokenHash: text('token_hash').notNull(),

    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),

    /** Set exactly once, by the consuming transaction. NULL means unused. */
    consumedAt: timestamp('consumed_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Lookup is by hash, so it must be unique and indexed. Uniqueness also
    // makes a hash collision a loud failure rather than a silent ambiguity.
    unique('auth_magic_links_token_hash_key').on(table.tokenHash),
    check('auth_magic_links_expiry_after_creation_check', sql`${table.expiresAt} > ${table.createdAt}`),
    check('auth_magic_links_email_lowercase_check', sql`${table.email} = lower(${table.email})`),
    // Serves the per-email issuance cooldown (abuse control).
    index('auth_magic_links_email_created_idx').on(table.email, table.createdAt),
    index('auth_magic_links_user_idx').on(table.userId),
  ],
);

/**
 * Browser authentication sessions.
 *
 * The cookie carries high-entropy plaintext; only its hash lives here, so a
 * database disclosure cannot be replayed as a login.
 */
export const authSessions = pgTable(
  'auth_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    /** SHA-256 of the session token held in the cookie. */
    tokenHash: text('token_hash').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),

    /**
     * Set on logout. Revocation is server-side state, which is what makes
     * logout real: clearing the browser cookie alone would leave a stolen
     * cookie valid until expiry.
     */
    revokedAt: timestamp('revoked_at', { withTimezone: true }),

    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  },
  (table) => [
    unique('auth_sessions_token_hash_key').on(table.tokenHash),
    check('auth_sessions_expiry_after_creation_check', sql`${table.expiresAt} > ${table.createdAt}`),
    // "Sign out everywhere" and per-user session listing.
    index('auth_sessions_user_idx').on(table.userId),
    // Active-session sweep; partial so revoked rows do not bloat the index.
    index('auth_sessions_active_idx')
      .on(table.expiresAt)
      .where(sql`revoked_at is null`),
  ],
);
