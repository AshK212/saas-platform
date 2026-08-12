import { describe, expect, it } from 'vitest';

import {
  closeDatabasePool,
  createDatabaseClient,
  createDatabasePool,
  DatabaseConfigError,
} from '../src/client';

const FAKE_URL = 'postgresql://user:secret@db.invalid.test:5432/appdb';

/**
 * `pg.Pool` connects lazily, so a pool can be constructed and torn down against
 * an unroutable host without any network access. That is exactly the property
 * these tests rely on - and the property that keeps startup independent of
 * database availability.
 */
describe('createDatabasePool', () => {
  it('rejects an empty connection string', () => {
    expect(() => createDatabasePool({ connectionString: '' })).toThrow(DatabaseConfigError);
  });

  it('rejects a whitespace-only connection string', () => {
    expect(() => createDatabasePool({ connectionString: '   ' })).toThrow(DatabaseConfigError);
  });

  it('constructs a pool without opening a connection', async () => {
    const pool = createDatabasePool({ connectionString: FAKE_URL });

    // No query has run, so no connection exists yet.
    expect(pool.totalCount).toBe(0);

    await closeDatabasePool(pool);
  });

  it('applies the configured pool limit', async () => {
    const pool = createDatabasePool({ connectionString: FAKE_URL, maxConnections: 3 });

    expect(pool.options.max).toBe(3);

    await closeDatabasePool(pool);
  });

  it('always attaches an error handler so a dropped connection cannot kill the process', async () => {
    const pool = createDatabasePool({ connectionString: FAKE_URL });

    // An unhandled 'error' event on a pg.Pool is fatal to the process.
    expect(pool.listenerCount('error')).toBeGreaterThan(0);

    await closeDatabasePool(pool);
  });

  it('routes asynchronous pool errors to the injected handler', async () => {
    const received: string[] = [];
    const pool = createDatabasePool({
      connectionString: FAKE_URL,
      onPoolError: (message) => received.push(message),
    });

    pool.emit('error', new Error('connection terminated unexpectedly'));

    expect(received).toEqual(['connection terminated unexpectedly']);

    await closeDatabasePool(pool);
  });
});

describe('createDatabaseClient', () => {
  it('returns a Drizzle client bound to the injected pool', async () => {
    const pool = createDatabasePool({ connectionString: FAKE_URL });

    const client = createDatabaseClient(pool);

    // The transactional API must be present - this is the capability the
    // neon-http driver could not provide.
    expect(typeof client.transaction).toBe('function');
    expect(typeof client.execute).toBe('function');

    await closeDatabasePool(pool);
  });
});
