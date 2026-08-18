import { createHash, randomBytes } from 'node:crypto';

import { eq, inArray } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { closeDatabasePool, createDatabaseClient, createDatabasePool } from '../src/client';
import {
  consumeMagicLink,
  findActiveAuthSession,
  insertAuthSession,
  insertMagicLink,
  revokeAuthSession,
} from '../src/identity/index';
import { authMagicLinks, authSessions } from '../src/schema/auth';
import { users } from '../src/schema/identity';

/**
 * LIVE authentication suite against real PostgreSQL.
 *
 * SAFETY - READ BEFORE CHANGING THE GATE
 * --------------------------------------
 * This suite WRITES DATA. It is gated on `TEST_DATABASE_URL` and **never falls
 * back to `DATABASE_URL`**. That fallback is how a data-writing suite ends up
 * pointed at production, so the omission is deliberate.
 *
 * Every write happens inside a transaction that is always rolled back, so no
 * residue survives even on failure. Nothing is dropped or truncated.
 *
 * The connection string is never logged.
 *
 * Runs only via `pnpm test:db`; skips when the variable is absent, reporting
 * SKIPPED rather than a false PASS.
 *
 * WHY THIS SUITE EXISTS SEPARATELY FROM THE UNIT TESTS
 * ----------------------------------------------------
 * The in-memory store in `apps/api/tests` proves the service's logic, but it is
 * single-threaded JavaScript and CANNOT prove PostgreSQL's concurrency
 * behaviour. Only the race test below establishes that two simultaneous
 * callbacks cannot both redeem one token.
 */

const testDatabaseUrl = process.env['TEST_DATABASE_URL']?.trim();
const hasTestDatabase = testDatabaseUrl !== undefined && testDatabaseUrl !== '';

const EMAIL_A = 'live-auth-a@example.test';
const EMAIL_B = 'live-auth-b@example.test';

class Rollback extends Error {}

function token(): string {
  return randomBytes(32).toString('base64url');
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

let pool: ReturnType<typeof createDatabasePool> | undefined;

afterAll(async () => {
  if (pool !== undefined) {
    await closeDatabasePool(pool);
  }
});

describe.skipIf(!hasTestDatabase)('live authentication', () => {
  function getDb(): ReturnType<typeof createDatabaseClient> {
    pool ??= createDatabasePool({
      connectionString: testDatabaseUrl as string,
      maxConnections: 4,
      applicationName: 'hybrid-auth-live-test',
    });
    return createDatabaseClient(pool);
  }

  it('persists a magic link as a hash and redeems it exactly once', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const [user] = await tx.insert(users).values({ email: EMAIL_A }).returning();
        const plaintext = token();
        const now = new Date();

        await insertMagicLink(tx, {
          userId: user?.id ?? '',
          email: EMAIL_A,
          tokenHash: hash(plaintext),
          expiresAt: new Date(now.getTime() + 15 * 60 * 1_000),
        });

        // The plaintext must not appear anywhere in the stored row.
        const stored = await tx
          .select()
          .from(authMagicLinks)
          .where(eq(authMagicLinks.email, EMAIL_A));
        expect(stored[0]?.tokenHash).toBe(hash(plaintext));
        expect(JSON.stringify(stored)).not.toContain(plaintext);

        // First redemption succeeds; second is rejected by the conditional UPDATE.
        expect(await consumeMagicLink(tx, hash(plaintext), new Date())).not.toBeNull();
        expect(await consumeMagicLink(tx, hash(plaintext), new Date())).toBeNull();

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('refuses an expired magic link', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const [user] = await tx.insert(users).values({ email: EMAIL_A }).returning();
        const plaintext = token();

        // ─── A LINK THAT WAS VALID WHEN ISSUED, AND IS EXPIRED NOW ────────
        //
        // The point of this test is redemption-time expiry, so the fixture has
        // to be a link that was legitimate at T0 and has since lapsed:
        //
        //   T0  issued two hours ago
        //   T1  expired one hour ago      (T1 > T0, so the row is legal)
        //   T2  redeemed now              (T2 > T1, so redemption must refuse)
        //
        // The previous version wrote `expires_at` in the past while letting
        // `created_at` default to now(), then tried to push `created_at` back
        // with a follow-up UPDATE. That UPDATE never ran: the CHECK
        // `auth_magic_links_expiry_after_creation_check` is evaluated at INSERT,
        // so the row was rejected with 23514 before it existed. The first real
        // PostgreSQL run caught it.
        //
        // The constraint is correct and is left alone - a link must never be
        // born already expired. Only the fixture was wrong.
        const issuedAt = new Date(Date.now() - 2 * 60 * 60 * 1_000);
        const expiredAt = new Date(Date.now() - 60 * 60 * 1_000);

        // Inserted directly rather than through `insertMagicLink`, which takes
        // no `createdAt` by design: production always issues links now, and
        // widening that signature to backdate one would be a test convenience
        // leaking into the authentication surface.
        await tx.insert(authMagicLinks).values({
          userId: user?.id ?? '',
          email: EMAIL_A,
          tokenHash: hash(plaintext),
          createdAt: issuedAt,
          expiresAt: expiredAt,
        });

        expect(await consumeMagicLink(tx, hash(plaintext), new Date())).toBeNull();

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('CONCURRENCY: two simultaneous redemptions of one token yield exactly one winner', async () => {
    // THE test this suite exists for. Requires real PostgreSQL row locking and
    // cannot be simulated in single-threaded JavaScript.
    const db = getDb();
    const plaintext = token();
    const tokenHash = hash(plaintext);

    // Committed setup, removed in the finally block: the two racing
    // transactions must see the same committed row, so it cannot live inside a
    // rolled-back transaction.
    try {
      const [user] = await db.insert(users).values({ email: EMAIL_B }).returning();
      const userId = user?.id ?? '';
      await insertMagicLink(db, {
        userId,
        email: EMAIL_B,
        tokenHash,
        expiresAt: new Date(Date.now() + 15 * 60 * 1_000),
      });

      const redeem = async (): Promise<boolean> =>
        db.transaction(async (tx) => {
          const consumed = await consumeMagicLink(tx, tokenHash, new Date());
          if (consumed === null) {
            return false;
          }
          await insertAuthSession(tx, {
            userId: consumed.userId,
            tokenHash: hash(token()),
            expiresAt: new Date(Date.now() + 60_000),
          });
          return true;
        });

      const [first, second] = await Promise.all([redeem(), redeem()]);

      // Exactly one winner - never zero, never two.
      expect([first, second].filter(Boolean)).toHaveLength(1);

      const sessions = await db.select().from(authSessions).where(eq(authSessions.userId, userId));
      expect(sessions).toHaveLength(1);
    } finally {
      // Cascade from users removes the link and any session.
      await db.delete(users).where(inArray(users.email, [EMAIL_B]));
    }
  });

  it('resolves, expires and revokes a session', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const [user] = await tx.insert(users).values({ email: EMAIL_A }).returning();
        const sessionToken = token();
        const now = new Date();

        await insertAuthSession(tx, {
          userId: user?.id ?? '',
          tokenHash: hash(sessionToken),
          expiresAt: new Date(now.getTime() + 60_000),
        });

        // Active.
        expect(await findActiveAuthSession(tx, hash(sessionToken), now)).not.toBeNull();

        // Evaluated as expired at a later instant.
        const later = new Date(now.getTime() + 120_000);
        expect(await findActiveAuthSession(tx, hash(sessionToken), later)).toBeNull();

        // Revocation invalidates it even before expiry.
        expect(await revokeAuthSession(tx, hash(sessionToken), now)).toBe(true);
        expect(await findActiveAuthSession(tx, hash(sessionToken), now)).toBeNull();

        // Revoking again is a no-op, so logout cannot leak session existence.
        expect(await revokeAuthSession(tx, hash(sessionToken), now)).toBe(false);

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('leaves no residue behind', async () => {
    const db = getDb();

    const remaining = await db
      .select()
      .from(users)
      .where(inArray(users.email, [EMAIL_A, EMAIL_B]));

    expect(remaining).toEqual([]);
  });
});
