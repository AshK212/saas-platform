import { and, desc, eq, gt, isNull } from 'drizzle-orm';

import type { DatabaseExecutor } from '../repositories/executor.js';
import { authMagicLinks } from '../schema/auth.js';

/**
 * Magic-link data access.
 *
 * The plaintext token never reaches this module. Callers hash it first, so a
 * bearer credential cannot be logged by a query logger or captured in a stack
 * trace from the data layer.
 */

export type MagicLinkRow = typeof authMagicLinks.$inferSelect;

export interface IssueMagicLinkInput {
  readonly userId: string;
  /** Already normalised to lowercase by the caller. */
  readonly email: string;
  /** SHA-256 hex digest of the plaintext token. */
  readonly tokenHash: string;
  readonly expiresAt: Date;
}

export async function insertMagicLink(
  executor: DatabaseExecutor,
  input: IssueMagicLinkInput,
): Promise<{ id: string }> {
  const rows = await executor
    .insert(authMagicLinks)
    .values({
      userId: input.userId,
      email: input.email,
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt,
    })
    .returning({ id: authMagicLinks.id });

  const row = rows[0];
  if (row === undefined) {
    throw new Error('Failed to persist magic link challenge.');
  }
  return row;
}

/** The consuming transaction's view of a redeemed challenge. */
export interface ConsumedMagicLink {
  readonly id: string;
  readonly userId: string;
  readonly email: string;
}

/**
 * Atomically redeems a magic link.
 *
 * SINGLE-USE UNDER CONCURRENCY - HOW THIS IS SAFE
 * -----------------------------------------------
 * This is ONE statement:
 *
 *   UPDATE auth_magic_links
 *      SET consumed_at = $now
 *    WHERE token_hash  = $hash
 *      AND consumed_at IS NULL
 *      AND expires_at  > $now
 *   RETURNING id, user_id, email
 *
 * There is deliberately no `SELECT` followed by a later `UPDATE`; that pattern
 * has a read-modify-write window in which two callbacks can both observe an
 * unconsumed token.
 *
 * With two concurrent callbacks presenting the same token, PostgreSQL
 * serialises them on the row lock. Under READ COMMITTED the second `UPDATE`
 * blocks until the first commits, then re-evaluates its `WHERE` clause against
 * the newly committed row version (EvalPlanQual). It now sees
 * `consumed_at IS NOT NULL`, matches zero rows, and returns nothing.
 *
 * Exactly one caller therefore receives a row, so exactly one session is
 * created. Expiry is evaluated inside the same statement against the same
 * `$now`, so a token cannot expire between the check and the update.
 *
 * @param now - server-supplied instant; never a client-supplied time.
 * @returns the redeemed challenge, or null if unknown, expired or already used.
 *   The three failure modes are deliberately indistinguishable to the caller.
 */
export async function consumeMagicLink(
  executor: DatabaseExecutor,
  tokenHash: string,
  now: Date,
): Promise<ConsumedMagicLink | null> {
  const rows = await executor
    .update(authMagicLinks)
    .set({ consumedAt: now })
    .where(
      and(
        eq(authMagicLinks.tokenHash, tokenHash),
        isNull(authMagicLinks.consumedAt),
        gt(authMagicLinks.expiresAt, now),
      ),
    )
    .returning({
      id: authMagicLinks.id,
      userId: authMagicLinks.userId,
      email: authMagicLinks.email,
    });

  return rows[0] ?? null;
}

/**
 * Most recent issuance time for an email, used by the abuse cooldown.
 *
 * Queried by email rather than user id so the cooldown applies uniformly,
 * including to the first request for an address that has just been created.
 */
export async function findLatestMagicLinkIssuedAt(
  executor: DatabaseExecutor,
  email: string,
): Promise<Date | null> {
  const rows = await executor
    .select({ createdAt: authMagicLinks.createdAt })
    .from(authMagicLinks)
    .where(eq(authMagicLinks.email, email))
    .orderBy(desc(authMagicLinks.createdAt))
    .limit(1);

  return rows[0]?.createdAt ?? null;
}
