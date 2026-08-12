import { randomUUID } from 'node:crypto';

import type {
  ActiveSession,
  AuthStore,
  AuthStoreUser,
  CreatedSession,
} from '../../src/auth/store';

/**
 * In-memory `AuthStore` for the default test suite.
 *
 * It faithfully reproduces the *semantics* the production store relies on -
 * single-use consumption, expiry, revocation - so the service's security logic
 * is genuinely exercised without a database.
 *
 * WHAT IT DOES NOT PROVE
 * ----------------------
 * It is single-threaded JavaScript. It cannot prove PostgreSQL's concurrency
 * behaviour, and a passing replay test here is NOT a substitute for the live
 * race test in `packages/db/tests/auth-isolation.live.test.ts`. That
 * distinction is stated wherever these results are reported.
 */

interface MagicLinkRecord {
  userId: string;
  email: string;
  tokenHash: string;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
}

interface SessionRecord {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
}

export interface MemoryAuthStore extends AuthStore {
  readonly users: Map<string, AuthStoreUser>;
  readonly magicLinks: MagicLinkRecord[];
  readonly sessions: SessionRecord[];
  /** Number of live (unconsumed, unexpired) links for an address. */
  countUsableLinks(email: string, now: Date): number;
}

export function createMemoryAuthStore(): MemoryAuthStore {
  const users = new Map<string, AuthStoreUser>();
  const magicLinks: MagicLinkRecord[] = [];
  const sessions: SessionRecord[] = [];
  /**
   * Real UUIDs, matching what PostgreSQL's `gen_random_uuid()` produces.
   * The `/v1/auth/me` contract validates `z.uuid()`, so a placeholder id here
   * would fail validation for a reason that has nothing to do with the code
   * under test.
   */
  function nextId(): string {
    return randomUUID();
  }

  return {
    users,
    magicLinks,
    sessions,

    countUsableLinks(email: string, now: Date): number {
      return magicLinks.filter(
        (link) =>
          link.email === email && link.consumedAt === null && link.expiresAt.getTime() > now.getTime(),
      ).length;
    },

    findLatestMagicLinkIssuedAt(email: string): Promise<Date | null> {
      const forEmail = magicLinks
        .filter((link) => link.email === email)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      return Promise.resolve(forEmail[0]?.createdAt ?? null);
    },

    findOrCreateUser(email: string): Promise<AuthStoreUser> {
      const existing = users.get(email);
      if (existing !== undefined) {
        return Promise.resolve(existing);
      }
      const created: AuthStoreUser = { id: nextId(), email };
      users.set(email, created);
      return Promise.resolve(created);
    },

    insertMagicLink(input): Promise<void> {
      magicLinks.push({
        userId: input.userId,
        email: input.email,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
        consumedAt: null,
        createdAt: new Date(input.expiresAt.getTime() - 15 * 60 * 1_000),
      });
      return Promise.resolve();
    },

    consumeMagicLinkAndCreateSession(input): Promise<CreatedSession | null> {
      // Mirrors the production conditional UPDATE: match only an unconsumed,
      // unexpired row, and mark it consumed in the same step.
      const link = magicLinks.find(
        (candidate) =>
          candidate.tokenHash === input.magicLinkTokenHash &&
          candidate.consumedAt === null &&
          candidate.expiresAt.getTime() > input.now.getTime(),
      );

      if (link === undefined) {
        return Promise.resolve(null);
      }

      link.consumedAt = input.now;
      sessions.push({
        id: nextId(),
        userId: link.userId,
        tokenHash: input.sessionTokenHash,
        expiresAt: input.sessionExpiresAt,
        revokedAt: null,
      });

      return Promise.resolve({ userId: link.userId });
    },

    findActiveSession(tokenHash: string, now: Date): Promise<ActiveSession | null> {
      const session = sessions.find(
        (candidate) =>
          candidate.tokenHash === tokenHash &&
          candidate.revokedAt === null &&
          candidate.expiresAt.getTime() > now.getTime(),
      );

      if (session === undefined) {
        return Promise.resolve(null);
      }

      const user = [...users.values()].find((candidate) => candidate.id === session.userId);

      return Promise.resolve({
        sessionId: session.id,
        userId: session.userId,
        email: user?.email ?? 'unknown@example.test',
      });
    },

    revokeSession(tokenHash: string, now: Date): Promise<void> {
      const session = sessions.find(
        (candidate) => candidate.tokenHash === tokenHash && candidate.revokedAt === null,
      );
      if (session !== undefined) {
        session.revokedAt = now;
      }
      return Promise.resolve();
    },
  };
}
