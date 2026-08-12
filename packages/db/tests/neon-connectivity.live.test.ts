import { afterAll, describe, expect, it } from 'vitest';

import {
  closeDatabasePool,
  createDatabaseClient,
  createDatabasePool,
  type DatabasePool,
} from '../src/client';
import { checkDatabaseReadiness } from '../src/readiness';

/**
 * LIVE Neon connectivity suite.
 *
 * Excluded from the default `pnpm test` run and executed only by `pnpm test:db`
 * (see vitest.live.config.ts). It skips itself when `DATABASE_URL` is absent,
 * so an unconfigured run reports SKIPPED - never a false pass.
 *
 * Nothing here creates or mutates a table: Step 2 is infrastructure only.
 */
const databaseUrl = process.env['DATABASE_URL']?.trim();
const hasCredential = databaseUrl !== undefined && databaseUrl !== '';

let pool: DatabasePool | undefined;

afterAll(async () => {
  if (pool !== undefined) {
    await closeDatabasePool(pool);
  }
});

describe.skipIf(!hasCredential)('live Neon connectivity', () => {
  function getPool(): DatabasePool {
    pool ??= createDatabasePool({
      // Guarded by skipIf above.
      connectionString: databaseUrl as string,
      maxConnections: 2,
      applicationName: 'hybrid-live-test',
    });
    return pool;
  }

  it('answers the readiness probe', async () => {
    const result = await checkDatabaseReadiness(getPool(), { timeoutMs: 20_000 });

    expect(result.status).toBe('ok');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('reports a PostgreSQL server version', async () => {
    const { rows } = await getPool().query<{ version: string }>('SELECT version() AS version');

    expect(rows[0]?.version).toMatch(/PostgreSQL/i);
  });

  it('executes a real interactive transaction with COMMIT', async () => {
    // This is the capability the neon-http driver could not provide. It is the
    // whole reason the driver was changed in Step 2.
    const db = createDatabaseClient(getPool());

    const result = await db.transaction(async (tx) => {
      const inner = await tx.execute('SELECT 42 AS answer');
      return inner.rows[0];
    });

    expect(result).toMatchObject({ answer: 42 });
  });

  it('rolls a transaction back when the callback throws', async () => {
    const db = createDatabaseClient(getPool());

    await expect(
      db.transaction(async (tx) => {
        await tx.execute('SELECT 1');
        throw new Error('force rollback');
      }),
    ).rejects.toThrow('force rollback');

    // The pool must remain usable after a rollback.
    const after = await checkDatabaseReadiness(getPool(), { timeoutMs: 20_000 });
    expect(after.status).toBe('ok');
  });

  it('supports the isolation level required for serialized ledger decisions', async () => {
    const client = await getPool().connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      const { rows } = await client.query<{ level: string }>('SHOW transaction_isolation');
      expect(rows[0]?.level).toBe('serializable');
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('supports advisory locks for cross-request serialization', async () => {
    const client = await getPool().connect();
    try {
      const { rows } = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock(982451653) AS locked',
      );
      expect(rows[0]?.locked).toBe(true);
      await client.query('SELECT pg_advisory_unlock(982451653)');
    } finally {
      client.release();
    }
  });
});
