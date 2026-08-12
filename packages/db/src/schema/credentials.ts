import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

import { workspaces } from './workspaces.js';

/**
 * Workspace API credentials (AC-02 foundation).
 *
 * SECRET HANDLING - AUDITED
 * -------------------------
 * There is deliberately NO column capable of holding reusable secret material.
 * The plaintext key is shown once at issuance and never persisted. Only:
 *   - `key_prefix`: a short, NON-SECRET lookup hint (the public half of the
 *     key), unique so a presented key resolves to exactly one row in a single
 *     indexed read, before any hash comparison;
 *   - `secret_hash`: the hash of the secret half. Never reversible.
 *
 * The prefix is globally unique rather than workspace-unique on purpose: an
 * inbound request presents only a key, so the workspace is not yet known at
 * lookup time. Resolving the workspace is precisely what this lookup does.
 *
 * No issuance, hashing or authentication behaviour is implemented here.
 */
export const apiCredentials = pgTable(
  'api_credentials',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'restrict' }),

    /** Operator-facing label, e.g. "CI simulator". Not a secret. */
    name: text('name').notNull(),

    /** Non-secret public prefix used to locate the credential. */
    keyPrefix: text('key_prefix').notNull(),

    /** Hash of the secret half. Plaintext is never stored. */
    secretHash: text('secret_hash').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),

    /** Revocation is a timestamp, not a delete, so history is preserved. */
    revokedAt: timestamp('revoked_at', { withTimezone: true }),

    /** Supports "last used" in the operator UI and stale-key review. */
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  },
  (table) => [
    unique('api_credentials_key_prefix_key').on(table.keyPrefix),
    unique('api_credentials_secret_hash_key').on(table.secretHash),
    check('api_credentials_name_nonempty_check', sql`length(${table.name}) > 0`),
    check('api_credentials_key_prefix_nonempty_check', sql`length(${table.keyPrefix}) > 0`),
    // Listing a workspace's active credentials.
    index('api_credentials_workspace_idx').on(table.workspaceId),
  ],
);
