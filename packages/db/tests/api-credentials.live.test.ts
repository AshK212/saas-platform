import { createHash, randomBytes } from 'node:crypto';

import { eq, inArray } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { closeDatabasePool, createDatabaseClient, createDatabasePool } from '../src/client';
import { createApiCredentialRepository } from '../src/repositories/api-credentials';
import { createWorkspaceScope } from '../src/repositories/workspace-scope';
import { authenticateApiCredential } from '../src/resolvers/api-credentials';
import { apiCredentials } from '../src/schema/credentials';
import { workspaces } from '../src/schema/workspaces';

/**
 * LIVE API-credential suite against real PostgreSQL.
 *
 * SAFETY - READ BEFORE CHANGING THE GATE
 * --------------------------------------
 * This suite WRITES DATA. It is gated on `TEST_DATABASE_URL` and **never falls
 * back to `DATABASE_URL`**. All writes happen inside transactions that are
 * always rolled back; nothing is dropped or truncated. No key or digest is
 * logged, and the connection string is never logged.
 *
 * WHY IT EXISTS SEPARATELY
 * ------------------------
 * The in-memory store used by route tests reproduces the semantics but cannot
 * prove the UNIQUE constraints on `key_prefix` and `secret_hash`, nor real
 * persistence of the hash-only representation.
 */

const testDatabaseUrl = process.env['TEST_DATABASE_URL']?.trim();
const hasTestDatabase = testDatabaseUrl !== undefined && testDatabaseUrl !== '';

const WORKSPACE_A_NAME = 'live-cred-alpha';
const WORKSPACE_B_NAME = 'live-cred-bravo';

class Rollback extends Error {}

/** Mirrors apps/api key generation without importing across the app boundary. */
function makeKey(): { key: string; keyPrefix: string; secretHash: string } {
  const keyId = randomBytes(9).toString('base64url');
  const keyPrefix = `hmp_live_${keyId}`;
  const key = `${keyPrefix}_${randomBytes(32).toString('base64url')}`;
  return { key, keyPrefix, secretHash: createHash('sha256').update(key).digest('hex') };
}

let pool: ReturnType<typeof createDatabasePool> | undefined;

afterAll(async () => {
  if (pool !== undefined) {
    await closeDatabasePool(pool);
  }
});

describe.skipIf(!hasTestDatabase)('live API credentials', () => {
  function getDb(): ReturnType<typeof createDatabaseClient> {
    pool ??= createDatabasePool({
      connectionString: testDatabaseUrl as string,
      maxConnections: 3,
      applicationName: 'hybrid-api-credentials-live-test',
    });
    return createDatabaseClient(pool);
  }

  it('persists only the hash, never the plaintext key', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const [ws] = await tx.insert(workspaces).values({ name: WORKSPACE_A_NAME }).returning();
        const scope = createWorkspaceScope(ws?.id ?? '');
        const generated = makeKey();

        await createApiCredentialRepository(tx, scope).issue({
          name: 'Simulator',
          keyPrefix: generated.keyPrefix,
          secretHash: generated.secretHash,
        });

        const stored = await tx
          .select()
          .from(apiCredentials)
          .where(eq(apiCredentials.workspaceId, ws?.id ?? ''));

        expect(stored[0]?.secretHash).toBe(generated.secretHash);
        // The full row must contain no fragment of the plaintext.
        expect(JSON.stringify(stored)).not.toContain(generated.key);
        expect(JSON.stringify(stored)).not.toContain(generated.key.slice(22));

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('authenticates by prefix and hash, deriving the workspace from the row', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const [ws] = await tx.insert(workspaces).values({ name: WORKSPACE_A_NAME }).returning();
        const scope = createWorkspaceScope(ws?.id ?? '');
        const generated = makeKey();

        await createApiCredentialRepository(tx, scope).issue({
          name: 'Simulator',
          keyPrefix: generated.keyPrefix,
          secretHash: generated.secretHash,
        });

        const authenticated = await authenticateApiCredential(
          tx,
          generated.keyPrefix,
          generated.secretHash,
        );

        expect(authenticated?.workspaceId).toBe(ws?.id);
        expect(authenticated?.scope.workspaceId).toBe(ws?.id);

        // A correct prefix with the wrong digest must not authenticate: the
        // prefix is an identifier, never authority.
        expect(
          await authenticateApiCredential(tx, generated.keyPrefix, 'f'.repeat(64)),
        ).toBeNull();

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('rejects a revoked credential immediately', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const [ws] = await tx.insert(workspaces).values({ name: WORKSPACE_A_NAME }).returning();
        const scope = createWorkspaceScope(ws?.id ?? '');
        const repo = createApiCredentialRepository(tx, scope);
        const generated = makeKey();

        const issued = await repo.issue({
          name: 'Simulator',
          keyPrefix: generated.keyPrefix,
          secretHash: generated.secretHash,
        });

        expect(
          await authenticateApiCredential(tx, generated.keyPrefix, generated.secretHash),
        ).not.toBeNull();

        await repo.revoke(issued.id, new Date());

        expect(
          await authenticateApiCredential(tx, generated.keyPrefix, generated.secretHash),
        ).toBeNull();

        // The row survives for audit.
        const rows = await tx
          .select()
          .from(apiCredentials)
          .where(eq(apiCredentials.id, issued.id));
        expect(rows).toHaveLength(1);
        expect(rows[0]?.revokedAt).not.toBeNull();

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('enforces the UNIQUE constraints on prefix and hash', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const [ws] = await tx.insert(workspaces).values({ name: WORKSPACE_A_NAME }).returning();
        const scope = createWorkspaceScope(ws?.id ?? '');
        const repo = createApiCredentialRepository(tx, scope);
        const generated = makeKey();

        await repo.issue({
          name: 'First',
          keyPrefix: generated.keyPrefix,
          secretHash: generated.secretHash,
        });

        // Same prefix, different hash - must be rejected by the database.
        await expect(
          repo.issue({
            name: 'Duplicate prefix',
            keyPrefix: generated.keyPrefix,
            secretHash: makeKey().secretHash,
          }),
        ).rejects.toThrow();

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('CROSS-TENANT: management is bounded by workspace', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const [wsA] = await tx.insert(workspaces).values({ name: WORKSPACE_A_NAME }).returning();
        const [wsB] = await tx.insert(workspaces).values({ name: WORKSPACE_B_NAME }).returning();
        const scopeA = createWorkspaceScope(wsA?.id ?? '');
        const scopeB = createWorkspaceScope(wsB?.id ?? '');
        const generated = makeKey();

        const issued = await createApiCredentialRepository(tx, scopeB).issue({
          name: 'Bravo key',
          keyPrefix: generated.keyPrefix,
          secretHash: generated.secretHash,
        });

        const repoA = createApiCredentialRepository(tx, scopeA);

        // Workspace A sees nothing of B's credential, even holding its id.
        expect(await repoA.listAll()).toEqual([]);
        expect(await repoA.findById(issued.id)).toBeNull();
        expect(await repoA.revoke(issued.id, new Date())).toBeNull();

        // And B's credential is untouched.
        const rows = await tx
          .select()
          .from(apiCredentials)
          .where(eq(apiCredentials.id, issued.id));
        expect(rows[0]?.revokedAt).toBeNull();

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('leaves no residue', async () => {
    const db = getDb();

    const remaining = await db
      .select()
      .from(workspaces)
      .where(inArray(workspaces.name, [WORKSPACE_A_NAME, WORKSPACE_B_NAME]));

    expect(remaining).toEqual([]);
  });
});
