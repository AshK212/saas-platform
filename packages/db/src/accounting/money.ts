/**
 * Exact USD arithmetic for authoritative accounting.
 *
 * MICRO-DOLLAR INTEGERS
 * ---------------------
 * Every authoritative amount is a `bigint` count of micro-dollars:
 *
 *   1 USD = 1_000_000 micros
 *
 * The database column is `numeric(14, 6)`, so scale is fixed at 6 and every
 * storable value is an exact whole number of micros. That makes the mapping
 * lossless in both directions, and makes addition and comparison ordinary
 * integer operations that cannot drift.
 *
 * WHY NOT FLOATS
 * --------------
 * A single amount at this scale does survive a double - 14 significant digits
 * fit. The hazard is ARITHMETIC, and a ledger exists to do arithmetic:
 *
 *   0.1 added ten times      -> 0.9999999999999999, not 1
 *   10.10 + 10.20 + 4.70     -> 24.999999999999996, not 25
 *
 * The second is the dangerous direction: committed spend that is exactly at a
 * $25 cap reads as under it, so the ledger believes headroom remains and allows
 * a further spend past the cap.
 *
 * A ledger deciding whether a cap is exceeded cannot tolerate that at any level
 * of unlikeliness. There is no `parseFloat`, `Number()`, `toFixed()` or float
 * addition anywhere in this module, and a guardrail test enforces it.
 *
 * WHY NOT A DECIMAL LIBRARY
 * -------------------------
 * A fixed scale of 6 makes the problem integer arithmetic, which `bigint`
 * already does exactly and without a dependency. A general decimal library
 * would add supply-chain surface to solve a problem the fixed scale has
 * already removed.
 */

/** Micro-dollars per USD. The `numeric(14, 6)` scale, as an integer factor. */
export const MICROS_PER_USD = 1_000_000n;

/** Fractional digits in the canonical representation. Matches the DB scale. */
const SCALE = 6;

/**
 * The largest value `numeric(14, 6)` can hold: 99999999.999999.
 *
 * Precision 14 minus scale 6 leaves 8 integer digits.
 */
export const MAX_USD_MICROS = 99_999_999_999_999n;

/**
 * The canonical wire/storage shape.
 *
 * Non-negative, at most 8 integer and 6 fractional digits, no sign, no
 * exponent, no leading zeros, no bare `.5` or trailing `1.`. Deliberately
 * identical to `decimalUsdSchema` in `@hybrid/contracts`; `packages/db` cannot
 * import that package, so an agreement test in `apps/api` - which depends on
 * both - proves the two never drift.
 */
const DECIMAL_USD_PATTERN = /^(?:0|[1-9]\d{0,7})(?:\.\d{1,6})?$/;

export class MoneyError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

/** Raised when an amount would exceed what `numeric(14, 6)` can store. */
export class LedgerCapacityError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'LedgerCapacityError';
  }
}

/**
 * Parses a decimal USD string into exact micro-dollars.
 *
 * String manipulation only: the integer and fractional halves are split on the
 * decimal point, the fraction is right-padded to scale, and the two are
 * combined with `BigInt`. The value never becomes a JavaScript number, so
 * nothing can round.
 *
 * A seventh decimal is REJECTED, never rounded. Silently discarding a fraction
 * of a cent is exactly the loss this module exists to prevent.
 */
export function parseUsdToMicros(value: string): bigint {
  if (!DECIMAL_USD_PATTERN.test(value)) {
    throw new MoneyError(
      'Amount must be a non-negative decimal string with at most 8 integer and 6 fractional digits.',
    );
  }

  const [whole = '0', fraction = ''] = value.split('.');
  const micros = BigInt(whole) * MICROS_PER_USD + BigInt(fraction.padEnd(SCALE, '0'));

  if (micros > MAX_USD_MICROS) {
    throw new LedgerCapacityError('Amount exceeds the maximum storable value.');
  }
  return micros;
}

/**
 * Formats micro-dollars as the canonical decimal string.
 *
 * ALWAYS six fractional digits, so `25`, `25.0` and `25.000000` can never all
 * appear depending on which query path produced the value. Comparisons and
 * test expectations stay simple because there is exactly one representation.
 */
export function formatUsdFromMicros(micros: bigint): string {
  if (micros < 0n) {
    throw new MoneyError('Authoritative amounts are never negative.');
  }
  if (micros > MAX_USD_MICROS) {
    throw new LedgerCapacityError('Amount exceeds the maximum storable value.');
  }

  const whole = micros / MICROS_PER_USD;
  const fraction = micros % MICROS_PER_USD;

  return `${whole.toString()}.${fraction.toString().padStart(SCALE, '0')}`;
}

/**
 * Normalises any accepted decimal form to the canonical one.
 *
 * PostgreSQL may hand back `0` for a column defaulted to `'0'`, or `25.0` from
 * some code paths. Everything crossing the repository boundary is passed
 * through here so the rest of the application only ever sees one shape.
 */
export function normalizeUsd(value: string): string {
  return formatUsdFromMicros(parseUsdToMicros(value));
}

/**
 * Adds two micro-dollar amounts, refusing to exceed storage capacity.
 *
 * Fails BEFORE the write rather than letting PostgreSQL raise a numeric
 * overflow, so the caller gets a typed error instead of a driver string. The
 * column's own precision remains defense in depth.
 */
export function addMicros(a: bigint, b: bigint): bigint {
  if (a < 0n || b < 0n) {
    throw new MoneyError('Authoritative amounts are never negative.');
  }

  const total = a + b;
  if (total > MAX_USD_MICROS) {
    throw new LedgerCapacityError('Resulting amount exceeds the maximum storable value.');
  }
  return total;
}

/**
 * Remaining headroom, floored at zero.
 *
 * A cap can legitimately be lowered BELOW what is already committed - an
 * operator dropping a $100 cap to $25 after $41 is spent. The honest answer is
 * "no headroom", not "-16": a negative remaining would read as credit, and
 * would underflow any later subtraction.
 *
 * Lowering a cap never reduces committed usage. Policy and accounting are
 * separate state, and this function is the only place the two meet.
 */
export function remainingMicros(capMicros: bigint, committedMicros: bigint): bigint {
  if (capMicros < 0n || committedMicros < 0n) {
    throw new MoneyError('Authoritative amounts are never negative.');
  }
  const remaining = capMicros - committedMicros;
  return remaining > 0n ? remaining : 0n;
}

/**
 * Remaining publish headroom, floored at zero.
 *
 * The integer counterpart of `remainingMicros`, for the same reason: a publish
 * cap lowered below today's count must report 0, never a negative.
 */
export function remainingCount(cap: number, committed: number): number {
  if (!Number.isSafeInteger(cap) || !Number.isSafeInteger(committed)) {
    throw new MoneyError('Publish counts must be safe integers.');
  }
  if (cap < 0 || committed < 0) {
    throw new MoneyError('Publish counts are never negative.');
  }
  return Math.max(cap - committed, 0);
}
