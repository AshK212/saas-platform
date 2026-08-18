import { expect } from 'vitest';

/**
 * Asserting that PostgreSQL refused something, and refused it for the RIGHT
 * reason.
 *
 * ─── WHY THIS IS NOT `.rejects.toThrow()` ─────────────────────────────────
 *
 * A bare `.rejects.toThrow()` is satisfied by ANY error. Two real incidents in
 * this repository made that concrete:
 *
 *   - Pointing a live suite at a closed port made a cross-tenant foreign-key
 *     test PASS, because `ECONNREFUSED` is a throw too. A constraint test that
 *     passes when there is no database is not a constraint test.
 *   - The same assertion is satisfied by a typo in the INSERT, a renamed
 *     column, or a NOT NULL violation on an unrelated field — so it could
 *     report "the composite foreign key protects us" while the foreign key had
 *     been dropped.
 *
 * Asserting the SQLSTATE fixes both at once: 23503 means a foreign key refused
 * the row, and nothing else produces it. Asserting the CONSTRAINT NAME as well
 * pins *which* foreign key, so a test cannot start passing because a different
 * constraint happened to fire.
 *
 * ─── WHY THE ERROR HAS TO BE UNWRAPPED ────────────────────────────────────
 *
 * Drizzle wraps driver errors in a `DrizzleQueryError`, so the pg error object
 * — and its `code` and `constraint` — is on `.cause`, not on the error itself.
 * The first CI run against real PostgreSQL proved it: PostgreSQL correctly
 * rejected a cross-workspace insert with 23503, and the test still failed,
 * because it asserted `error.code` on the wrapper.
 *
 * That is an assertion-layer problem and never an isolation failure, which is
 * exactly why it is worth a shared helper rather than a fix repeated per file
 * and got subtly wrong in one of them.
 */

/** PostgreSQL error classes these suites assert on. */
export const PG = {
  uniqueViolation: '23505',
  foreignKeyViolation: '23503',
  checkViolation: '23514',
  notNullViolation: '23502',
} as const;

/** A five-character SQLSTATE, e.g. `23503`. */
const SQLSTATE_PATTERN = /^[0-9A-Z]{5}$/;

/**
 * Walks an error and its `cause` chain for a field the pg driver sets.
 *
 * Bounded, so a self-referential cause cannot spin.
 */
function fromErrorChain(error: unknown, field: 'code' | 'constraint'): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && current !== undefined; depth += 1) {
    const value = (current as Record<string, unknown>)[field];
    if (typeof value === 'string' && (field !== 'code' || SQLSTATE_PATTERN.test(value))) {
      return value;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** The SQLSTATE carried by an error, unwrapping Drizzle's wrapper. */
export function sqlState(error: unknown): string | undefined {
  return fromErrorChain(error, 'code');
}

/** The constraint name carried by an error, unwrapping Drizzle's wrapper. */
export function constraintName(error: unknown): string | undefined {
  return fromErrorChain(error, 'constraint');
}

export interface RefusalExpectation {
  /** Required. One of `PG`, so the test names the class it depends on. */
  readonly code: string;
  /**
   * Optional but preferred: the exact constraint that must have fired.
   *
   * Without it, a test asserting 23503 passes if ANY foreign key refused the
   * row - including one that has nothing to do with the isolation property
   * under test.
   */
  readonly constraint?: string;
}

/**
 * Asserts that `work` is refused by PostgreSQL with a specific SQLSTATE, and
 * optionally by a specific named constraint.
 *
 * Deliberately does NOT use `expect(...).rejects`: catching manually lets the
 * failure message carry the actual error text, which is the difference between
 * "expected 23503" and "expected 23503, got: connect ECONNREFUSED".
 */
export async function expectRefused(
  work: () => Promise<unknown>,
  expected: RefusalExpectation,
): Promise<void> {
  let caught: unknown;
  try {
    await work();
  } catch (error) {
    caught = error;
  }

  const describe = (): string =>
    caught instanceof Error ? `${caught.name}: ${caught.message}` : String(caught);

  expect(caught, 'expected PostgreSQL to refuse this statement').toBeDefined();
  expect(sqlState(caught), `expected SQLSTATE ${expected.code}, got: ${describe()}`).toBe(
    expected.code,
  );

  if (expected.constraint !== undefined) {
    expect(
      constraintName(caught),
      `expected constraint ${expected.constraint}, got: ${describe()}`,
    ).toBe(expected.constraint);
  }
}
