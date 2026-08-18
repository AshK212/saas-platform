import { describe, expect, it } from 'vitest';

import { PG, constraintName, expectRefused, sqlState } from './helpers/pg-errors';

/**
 * Coverage for the SQLSTATE assertion helper.
 *
 * The helper is only exercised by live suites, which skip without a database -
 * so without this file the thing every constraint assertion depends on would
 * itself be untested on the ordinary run. That is how the original defect
 * survived: `.rejects.toMatchObject({ code })` looked right, and nothing
 * checked it against an error shaped the way Drizzle actually throws.
 *
 * These tests need no database. They construct the error shapes directly.
 */

/** A pg driver error, as node-postgres produces it. */
function pgError(code: string, constraint?: string): Error {
  return Object.assign(new Error(`duplicate key value violates constraint`), {
    code,
    ...(constraint === undefined ? {} : { constraint }),
  });
}

/** The same error as Drizzle rethrows it: wrapped, with the driver on `cause`. */
function drizzleWrapped(inner: Error): Error {
  const wrapper = new Error('Failed query: insert into "events" ...');
  wrapper.name = 'DrizzleQueryError';
  return Object.assign(wrapper, { cause: inner });
}

describe('sqlState', () => {
  it('reads the code from a bare driver error', () => {
    expect(sqlState(pgError('23503'))).toBe('23503');
  });

  it('READS THROUGH DRIZZLE’S WRAPPER', () => {
    // The defect that failed the first real CI run: PostgreSQL rejected the
    // insert correctly with 23503, and the assertion looked at the wrapper.
    expect(sqlState(drizzleWrapped(pgError('23503')))).toBe('23503');
  });

  it('reads through several layers of wrapping', () => {
    expect(sqlState(drizzleWrapped(drizzleWrapped(pgError('23505'))))).toBe('23505');
  });

  it('returns undefined for an error carrying no SQLSTATE', () => {
    // A connection failure is the important case: `ECONNREFUSED` is a string
    // `code` too, and treating it as a SQLSTATE is how a constraint test comes
    // to pass with no database at all.
    const connectionRefused = Object.assign(new Error('connect ECONNREFUSED'), {
      code: 'ECONNREFUSED',
    });

    expect(sqlState(connectionRefused)).toBeUndefined();
  });

  it('terminates on a self-referential cause chain', () => {
    const looping = new Error('loop') as Error & { cause?: unknown };
    looping.cause = looping;

    expect(sqlState(looping)).toBeUndefined();
  });

  it('is undefined for null and undefined', () => {
    expect(sqlState(null)).toBeUndefined();
    expect(sqlState(undefined)).toBeUndefined();
  });
});

describe('constraintName', () => {
  it('reads the constraint through the wrapper', () => {
    expect(constraintName(drizzleWrapped(pgError('23503', 'events_workspace_agent_fkey')))).toBe(
      'events_workspace_agent_fkey',
    );
  });

  it('is undefined when the driver reported none', () => {
    expect(constraintName(pgError('23503'))).toBeUndefined();
  });
});

describe('expectRefused', () => {
  const reject = (error: unknown) => () => Promise.reject(error);

  it('accepts a rejection carrying the expected SQLSTATE', async () => {
    await expectRefused(reject(drizzleWrapped(pgError('23503'))), {
      code: PG.foreignKeyViolation,
    });
  });

  it('accepts a rejection carrying the expected constraint too', async () => {
    await expectRefused(reject(drizzleWrapped(pgError('23503', 'events_workspace_agent_fkey'))), {
      code: PG.foreignKeyViolation,
      constraint: 'events_workspace_agent_fkey',
    });
  });

  it('REJECTS a connection failure', async () => {
    // The regression that matters most: without this, every constraint test in
    // the repository passes when the database is unreachable.
    const connectionRefused = Object.assign(new Error('connect ECONNREFUSED'), {
      code: 'ECONNREFUSED',
    });

    await expect(
      expectRefused(reject(connectionRefused), { code: PG.foreignKeyViolation }),
    ).rejects.toThrow();
  });

  it('REJECTS a different SQLSTATE', async () => {
    // A unique violation must not satisfy a foreign-key assertion.
    await expect(
      expectRefused(reject(drizzleWrapped(pgError('23505'))), { code: PG.foreignKeyViolation }),
    ).rejects.toThrow();
  });

  it('REJECTS the right code from the wrong constraint', async () => {
    // Otherwise a test could pass because some unrelated foreign key fired.
    await expect(
      expectRefused(reject(drizzleWrapped(pgError('23503', 'blocks_workspace_agent_fkey'))), {
        code: PG.foreignKeyViolation,
        constraint: 'events_workspace_agent_fkey',
      }),
    ).rejects.toThrow();
  });

  it('REJECTS work that did not throw at all', async () => {
    // PostgreSQL accepting a row a constraint should have refused is the whole
    // failure these assertions exist to catch.
    await expect(
      expectRefused(() => Promise.resolve('accepted'), { code: PG.foreignKeyViolation }),
    ).rejects.toThrow();
  });

  it('names the actual error in its failure message', async () => {
    // "expected 23503, got: connect ECONNREFUSED" is the difference between a
    // diagnosable CI log and another round of guessing.
    const connectionRefused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), {
      code: 'ECONNREFUSED',
    });

    await expect(
      expectRefused(reject(connectionRefused), { code: PG.foreignKeyViolation }),
    ).rejects.toThrow(/ECONNREFUSED/);
  });
});
