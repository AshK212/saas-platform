import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

import { workspaces } from './workspaces.js';

/**
 * Revocable read-only share tokens (AC-18 foundation).
 *
 * SECRET HANDLING - AUDITED
 * -------------------------
 * As with API credentials, there is NO column capable of holding a reusable
 * plaintext token. The high-entropy token is shown once at issuance; only its
 * hash and a non-secret prefix are stored.
 *
 * READ-ONLY IS STRUCTURAL, NOT A FLAG
 * -----------------------------------
 * There is deliberately no scope or permission column. A share token grants
 * read-only access by construction - the routes it will unlock (a later step)
 * are read-only. Modelling a permission set here would invite a future
 * writable share, which the Credit requirements do not allow.
 *
 * Revocation is a timestamp rather than a delete, so a revoked share remains
 * auditable.
 */
export const shareTokens = pgTable(
  'share_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'restrict' }),

    /** Non-secret public prefix used to locate the token. */
    tokenPrefix: text('token_prefix').notNull(),

    /** Hash of the token. Plaintext is never stored. */
    tokenHash: text('token_hash').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    unique('share_tokens_token_prefix_key').on(table.tokenPrefix),
    unique('share_tokens_token_hash_key').on(table.tokenHash),
    check('share_tokens_token_prefix_nonempty_check', sql`length(${table.tokenPrefix}) > 0`),
    // Listing a workspace's active shares; the partial predicate keeps the
    // index small since revoked tokens accumulate but are rarely queried.
    // The predicate is written unqualified on purpose - an index predicate is
    // always evaluated against the indexed table, and unqualified is the
    // portable form.
    index('share_tokens_workspace_active_idx')
      .on(table.workspaceId)
      .where(sql`revoked_at is null`),
  ],
);
