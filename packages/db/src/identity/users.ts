import { eq } from 'drizzle-orm';

import type { DatabaseExecutor } from '../repositories/executor.js';
import { users } from '../schema/identity.js';

/**
 * Global identity data access.
 *
 * WHY THIS IS NOT IN `repositories/`
 * ----------------------------------
 * `repositories/` holds tenant-owned data and every method there requires a
 * `WorkspaceScope`. `users` is GLOBAL - one human, one identity, many
 * workspaces - so a workspace scope is meaningless here and demanding one
 * would be circular.
 *
 * `identity/` is therefore a third, deliberately narrow category: global,
 * user-owned records that exist upstream of any tenant. Nothing in this
 * directory may read or write tenant-owned data.
 *
 * Every function is anchored on a specific email or user id. There is no
 * "list all users", and none may be added.
 */

export type UserRow = typeof users.$inferSelect;

/**
 * Normalises an email to the form the database enforces.
 *
 * The `users_email_lowercase_check` constraint requires `email = lower(email)`,
 * so normalisation is not a convention here - an un-normalised insert is
 * rejected by PostgreSQL. Doing it in one place keeps lookup and insert
 * agreeing on what "the same address" means.
 */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function findUserByEmail(
  executor: DatabaseExecutor,
  email: string,
): Promise<UserRow | null> {
  const rows = await executor
    .select()
    .from(users)
    .where(eq(users.email, normaliseEmail(email)))
    .limit(1);

  return rows[0] ?? null;
}

export async function findUserById(
  executor: DatabaseExecutor,
  userId: string,
): Promise<UserRow | null> {
  const rows = await executor.select().from(users).where(eq(users.id, userId)).limit(1);

  return rows[0] ?? null;
}

/**
 * Returns the existing identity for an email, creating one if absent.
 *
 * PASSWORDLESS ONBOARDING: requesting a link for an unknown address creates the
 * identity. There is no separate registration step, which is what allows the
 * request endpoint to respond identically for known and unknown addresses - a
 * distinct "register first" path would itself be an enumeration oracle.
 *
 * Creating an identity grants nothing: a user with no membership can reach no
 * workspace. Onboarding into a workspace is Step 6.
 *
 * Race-safe by construction: concurrent requests for the same new address both
 * attempt the insert, the unique constraint on `email` lets exactly one win,
 * and `onConflictDoNothing` turns the loser into a re-read rather than an error.
 */
export async function findOrCreateUserByEmail(
  executor: DatabaseExecutor,
  email: string,
): Promise<UserRow> {
  const normalised = normaliseEmail(email);

  const existing = await findUserByEmail(executor, normalised);
  if (existing !== null) {
    return existing;
  }

  const inserted = await executor
    .insert(users)
    .values({ email: normalised })
    .onConflictDoNothing({ target: users.email })
    .returning();

  const created = inserted[0];
  if (created !== undefined) {
    return created;
  }

  // Lost the insert race: the winner's row is now visible.
  const raced = await findUserByEmail(executor, normalised);
  if (raced === null) {
    throw new Error('Failed to create or resolve user identity.');
  }
  return raced;
}
