import { and, eq, gt, isNull } from 'drizzle-orm';

import type { DatabaseExecutor } from '../repositories/executor.js';
import { authSessions } from '../schema/auth.js';
import { users } from '../schema/identity.js';

/**
 * Browser authentication session data access.
 *
 * As with magic links, only hashes cross this boundary. The plaintext session
 * token lives in the cookie and in memory during a request, never at rest.
 */

export type AuthSessionRow = typeof authSessions.$inferSelect;

export interface CreateAuthSessionInput {
  readonly userId: string;
  /** SHA-256 hex digest of the plaintext session token. */
  readonly tokenHash: string;
  readonly expiresAt: Date;
}

export async function insertAuthSession(
  executor: DatabaseExecutor,
  input: CreateAuthSessionInput,
): Promise<{ id: string }> {
  const rows = await executor
    .insert(authSessions)
    .values({
      userId: input.userId,
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt,
    })
    .returning({ id: authSessions.id });

  const row = rows[0];
  if (row === undefined) {
    throw new Error('Failed to persist authentication session.');
  }
  return row;
}

/** A live session joined to the identity it authenticates. */
export interface ActiveAuthSession {
  readonly sessionId: string;
  readonly userId: string;
  readonly email: string;
  readonly expiresAt: Date;
}

/**
 * Resolves a session that is present, unexpired and unrevoked.
 *
 * All three conditions are evaluated in SQL against a server-supplied `now`.
 * Doing the expiry comparison in the database keeps a single clock authority
 * and removes any window between reading a row and judging it.
 *
 * @returns the session, or null. Expired, revoked and unknown are deliberately
 *   indistinguishable - the caller must not be able to probe which applies.
 */
export async function findActiveAuthSession(
  executor: DatabaseExecutor,
  tokenHash: string,
  now: Date,
): Promise<ActiveAuthSession | null> {
  const rows = await executor
    .select({
      sessionId: authSessions.id,
      userId: authSessions.userId,
      email: users.email,
      expiresAt: authSessions.expiresAt,
    })
    .from(authSessions)
    .innerJoin(users, eq(users.id, authSessions.userId))
    .where(
      and(
        eq(authSessions.tokenHash, tokenHash),
        isNull(authSessions.revokedAt),
        gt(authSessions.expiresAt, now),
      ),
    )
    .limit(1);

  return rows[0] ?? null;
}

/**
 * Revokes a session by token hash.
 *
 * This is what makes logout real. Clearing the browser cookie alone is a UI
 * gesture, not a security boundary - a copy of the cookie taken beforehand
 * would still authenticate until expiry. Revocation invalidates the credential
 * itself.
 *
 * Idempotent: revoking an already-revoked or unknown session is a no-op, so a
 * repeated logout cannot error or leak whether the session existed.
 *
 * @returns true when a live session was revoked by this call.
 */
export async function revokeAuthSession(
  executor: DatabaseExecutor,
  tokenHash: string,
  now: Date,
): Promise<boolean> {
  const rows = await executor
    .update(authSessions)
    .set({ revokedAt: now })
    .where(and(eq(authSessions.tokenHash, tokenHash), isNull(authSessions.revokedAt)))
    .returning({ id: authSessions.id });

  return rows.length > 0;
}

/** Records session activity. Best-effort; never gates authentication. */
export async function touchAuthSession(
  executor: DatabaseExecutor,
  sessionId: string,
  now: Date,
): Promise<void> {
  await executor
    .update(authSessions)
    .set({ lastUsedAt: now })
    .where(eq(authSessions.id, sessionId));
}
