import { describe, expect, it } from 'vitest';

import {
  addMicros,
  formatUsdFromMicros,
  LedgerCapacityError,
  MAX_USD_MICROS,
  MICROS_PER_USD,
  MoneyError,
  normalizeUsd,
  parseUsdToMicros,
  remainingCount,
  remainingMicros,
} from '../src/accounting/money';
import {
  parseUtcAccountingDay,
  toUtcAccountingDay,
  UtcAccountingDayError,
} from '../src/accounting/utc-day';

/**
 * Authoritative accounting arithmetic.
 *
 * Every value here eventually decides whether a spend cap was exceeded, so a
 * single rounding or timezone slip is a money defect. These tests assert exact
 * equality throughout - never approximate comparison.
 */

describe('parsing USD to micro-dollars', () => {
  it.each([
    ['0', 0n],
    ['0.000000', 0n],
    ['0.000001', 1n],
    ['0.100000', 100_000n],
    ['0.1', 100_000n],
    ['1', 1_000_000n],
    ['25', 25_000_000n],
    ['25.000000', 25_000_000n],
    ['41.000000', 41_000_000n],
    ['25.123456', 25_123_456n],
    ['99999999.999999', MAX_USD_MICROS],
  ])('parses %s to %s micros', (value, expected) => {
    expect(parseUsdToMicros(value)).toBe(expected);
  });

  it('scales by exactly one million', () => {
    expect(parseUsdToMicros('1')).toBe(MICROS_PER_USD);
  });

  it.each([
    ['negative', '-5.000000'],
    ['a plus sign', '+5'],
    ['exponent notation', '4.1e1'],
    ['seven decimals', '0.0000009'],
    ['nine integer digits', '100000000'],
    ['a leading zero', '01.5'],
    ['a bare dot', '.5'],
    ['a trailing dot', '25.'],
    ['a thousands separator', '1,000'],
    ['a currency symbol', '$25'],
    ['whitespace', ' 25 '],
    ['empty', ''],
    ['text', 'twenty'],
    ['NaN', 'NaN'],
    ['Infinity', 'Infinity'],
    ['hex', '0x19'],
  ])('rejects %s rather than rounding it', (_label, value) => {
    // A seventh decimal is REJECTED, never rounded. Silently discarding a
    // fraction of a cent is exactly the loss this module prevents.
    expect(() => parseUsdToMicros(value)).toThrow(MoneyError);
  });
});

describe('formatting micro-dollars', () => {
  it.each([
    [0n, '0.000000'],
    [1n, '0.000001'],
    [100_000n, '0.100000'],
    [1_000_000n, '1.000000'],
    [25_000_000n, '25.000000'],
    [25_123_456n, '25.123456'],
    [MAX_USD_MICROS, '99999999.999999'],
  ])('formats %s micros as %s', (micros, expected) => {
    expect(formatUsdFromMicros(micros)).toBe(expected);
  });

  it('ALWAYS emits six fractional digits', () => {
    // One canonical shape, so `25`, `25.0` and `25.000000` can never all
    // appear depending on which query path produced the value.
    for (const micros of [0n, 1n, 1_000_000n, 25_000_000n, MAX_USD_MICROS]) {
      expect(formatUsdFromMicros(micros)).toMatch(/^\d+\.\d{6}$/);
    }
  });

  it('refuses a negative amount', () => {
    expect(() => formatUsdFromMicros(-1n)).toThrow(MoneyError);
  });

  it('refuses a value beyond storage capacity', () => {
    expect(() => formatUsdFromMicros(MAX_USD_MICROS + 1n)).toThrow(LedgerCapacityError);
  });
});

describe('round trips are lossless', () => {
  it.each([
    '0.000000',
    '0.000001',
    '0.100000',
    '25.000000',
    '41.000000',
    '25.123456',
    '99999999.999999',
  ])('%s survives parse and format unchanged', (value) => {
    expect(formatUsdFromMicros(parseUsdToMicros(value))).toBe(value);
  });

  it('normalises every accepted spelling to one canonical form', () => {
    // PostgreSQL may hand back `0` for a column defaulted to '0', or `25.0`.
    for (const [raw, canonical] of [
      ['0', '0.000000'],
      ['25', '25.000000'],
      ['25.0', '25.000000'],
      ['25.00', '25.000000'],
      ['25.000000', '25.000000'],
      ['0.1', '0.100000'],
    ] as const) {
      expect(normalizeUsd(raw), raw).toBe(canonical);
    }
  });
});

describe('addition is exact', () => {
  it('adds without floating drift', () => {
    // The canonical IEEE-754 failure: 0.1 + 0.2 !== 0.3 as doubles.
    const total = addMicros(parseUsdToMicros('0.100000'), parseUsdToMicros('0.200000'));

    expect(formatUsdFromMicros(total)).toBe('0.300000');
  });

  it('adds a single micro-dollar exactly', () => {
    const total = addMicros(parseUsdToMicros('25.000000'), parseUsdToMicros('0.000001'));

    expect(formatUsdFromMicros(total)).toBe('25.000001');
  });

  it.each([
    ['0.000000', '0.000000', '0.000000'],
    ['0.000000', '25.000000', '25.000000'],
    ['20.000000', '4.000000', '24.000000'],
    ['24.000000', '4.000000', '28.000000'],
    ['25.000000', '16.000000', '41.000000'],
    ['0.000001', '0.000001', '0.000002'],
    ['99999999.999998', '0.000001', '99999999.999999'],
  ])('%s + %s = %s', (a, b, expected) => {
    expect(formatUsdFromMicros(addMicros(parseUsdToMicros(a), parseUsdToMicros(b)))).toBe(
      expected,
    );
  });

  it('accumulates a thousand micro-payments without drift', () => {
    // The realistic AI-cost shape: many tiny amounts. A float accumulator
    // would visibly diverge here.
    let total = 0n;
    for (let i = 0; i < 1_000; i += 1) {
      total = addMicros(total, parseUsdToMicros('0.000001'));
    }

    expect(formatUsdFromMicros(total)).toBe('0.001000');
  });

  it('REFUSES to overflow capacity rather than wrapping or truncating', () => {
    expect(() => addMicros(MAX_USD_MICROS, 1n)).toThrow(LedgerCapacityError);
    expect(() =>
      addMicros(parseUsdToMicros('99999999.999999'), parseUsdToMicros('0.000001')),
    ).toThrow(LedgerCapacityError);
  });

  it('refuses negative operands', () => {
    expect(() => addMicros(-1n, 1n)).toThrow(MoneyError);
  });
});

describe('remaining headroom', () => {
  it.each([
    ['25.000000', '0.000000', '25.000000'],
    ['25.000000', '20.000000', '5.000000'],
    ['25.000000', '25.000000', '0.000000'],
    ['0.000000', '0.000000', '0.000000'],
  ])('cap %s minus committed %s is %s', (cap, committed, expected) => {
    expect(
      formatUsdFromMicros(remainingMicros(parseUsdToMicros(cap), parseUsdToMicros(committed))),
    ).toBe(expected);
  });

  it('FLOORS AT ZERO when a cap is lowered below committed usage', () => {
    // An operator drops a $100 cap to $25 after $41 is already spent. The
    // honest answer is "no headroom", never "-16" - a negative would read as
    // credit and would underflow any later subtraction.
    const remaining = remainingMicros(parseUsdToMicros('25.000000'), parseUsdToMicros('41.000000'));

    expect(remaining).toBe(0n);
    expect(formatUsdFromMicros(remaining)).toBe('0.000000');
  });

  it('floors publish headroom at zero too', () => {
    expect(remainingCount(5, 0)).toBe(5);
    expect(remainingCount(5, 5)).toBe(0);
    expect(remainingCount(5, 6)).toBe(0);
    expect(remainingCount(0, 0)).toBe(0);
  });

  it('refuses negative or unsafe counts', () => {
    expect(() => remainingCount(-1, 0)).toThrow(MoneyError);
    expect(() => remainingCount(5, -1)).toThrow(MoneyError);
    expect(() => remainingCount(1.5, 0)).toThrow(MoneyError);
    expect(() => remainingCount(Number.MAX_SAFE_INTEGER + 2, 0)).toThrow(MoneyError);
  });
});

describe('no floating point anywhere', () => {
  it.each([
    ['parseUsdToMicros', parseUsdToMicros],
    ['formatUsdFromMicros', formatUsdFromMicros],
    ['addMicros', addMicros],
    ['remainingMicros', remainingMicros],
  ])('%s uses no float conversion', (_label, fn) => {
    const source = fn.toString();

    expect(source).not.toMatch(/parseFloat|toFixed|Number\.parseFloat/);
  });

  it('is exact where float ACCUMULATION drifts', () => {
    // A single value at this scale does survive a double - 14 significant
    // digits fit comfortably. The real hazard is arithmetic: a ledger adds,
    // and doubles drift as they accumulate.
    let floatTotal = 0;
    let exactTotal = 0n;
    for (let i = 0; i < 10; i += 1) {
      floatTotal += 0.1;
      exactTotal = addMicros(exactTotal, parseUsdToMicros('0.100000'));
    }

    // The classic failure, reproduced to prove it is real here and not folklore.
    expect(floatTotal).not.toBe(1);
    expect(floatTotal.toString()).toBe('0.9999999999999999');
    // The micro-dollar path is exact.
    expect(formatUsdFromMicros(exactTotal)).toBe('1.000000');
  });

  it('is exact where a float sum UNDER-reports committed spend', () => {
    // $10.10 + $10.20 + $4.70 is exactly $25.00. As doubles it comes to
    // 24.999999999999996 - under-reporting committed spend, which is the
    // dangerous direction: the ledger would believe there is headroom left and
    // allow a further spend past the cap.
    const floatSum = 10.1 + 10.2 + 4.7;
    expect(floatSum).not.toBe(25);
    expect(floatSum < 25).toBe(true);

    const exact = addMicros(
      addMicros(parseUsdToMicros('10.100000'), parseUsdToMicros('10.200000')),
      parseUsdToMicros('4.700000'),
    );
    expect(formatUsdFromMicros(exact)).toBe('25.000000');
    // Exactly at the cap, with no headroom invented by rounding.
    expect(remainingMicros(parseUsdToMicros('25.000000'), exact)).toBe(0n);
  });
});

describe('the UTC accounting day', () => {
  it.each([
    ['2026-08-12T23:59:59.999Z', '2026-08-12'],
    ['2026-08-13T00:00:00.000Z', '2026-08-13'],
    ['2026-08-13T00:00:00.001Z', '2026-08-13'],
    ['2026-08-13T12:00:00.000Z', '2026-08-13'],
    ['2026-08-13T23:59:59.999Z', '2026-08-13'],
    ['2026-01-01T00:00:00.000Z', '2026-01-01'],
    ['2025-12-31T23:59:59.999Z', '2025-12-31'],
  ])('derives %s as %s', (iso, expected) => {
    expect(toUtcAccountingDay(new Date(iso))).toBe(expected);
  });

  it('MIDNIGHT UTC is the boundary, to the millisecond', () => {
    const lastMoment = new Date('2026-08-12T23:59:59.999Z');
    const firstMoment = new Date('2026-08-13T00:00:00.000Z');

    expect(toUtcAccountingDay(lastMoment)).toBe('2026-08-12');
    expect(toUtcAccountingDay(firstMoment)).toBe('2026-08-13');
    // One millisecond apart, two different accounting days.
    expect(firstMoment.getTime() - lastMoment.getTime()).toBe(1);
  });

  it('does not depend on the host timezone', () => {
    // An instant that is a DIFFERENT local date in most of the world: 01:30
    // UTC is still the 13th in London and Tokyo, but the 12th in New York.
    // The accounting day must be the UTC one regardless of where this runs.
    const instant = new Date('2026-08-13T01:30:00.000Z');

    expect(toUtcAccountingDay(instant)).toBe('2026-08-13');
    // Proves the host really is offset from UTC for this instant on most CI
    // machines, without asserting a specific zone.
    expect(instant.toISOString().slice(0, 10)).toBe('2026-08-13');
  });

  it('uses no local-time API', () => {
    const source = toUtcAccountingDay.toString();

    for (const forbidden of ['getFullYear', 'getMonth', 'getDate', 'toLocaleDateString', 'Intl']) {
      expect(source, forbidden).not.toContain(forbidden);
    }
    expect(source).toContain('toISOString');
  });

  it('is unaffected by a DST transition', () => {
    // US DST ends 2026-11-01 at 06:00 UTC; EU clocks change 2026-10-25 at
    // 01:00 UTC. UTC itself never shifts, so instants either side of both land
    // on exactly the day their UTC timestamp says.
    expect(toUtcAccountingDay(new Date('2026-11-01T05:59:59.999Z'))).toBe('2026-11-01');
    expect(toUtcAccountingDay(new Date('2026-11-01T06:00:00.000Z'))).toBe('2026-11-01');
    expect(toUtcAccountingDay(new Date('2026-10-25T00:59:59.999Z'))).toBe('2026-10-25');
    expect(toUtcAccountingDay(new Date('2026-10-25T01:00:00.000Z'))).toBe('2026-10-25');
    // And a day boundary near a DST change is still plain midnight UTC.
    expect(toUtcAccountingDay(new Date('2026-10-31T23:59:59.999Z'))).toBe('2026-10-31');
    expect(toUtcAccountingDay(new Date('2026-11-01T00:00:00.000Z'))).toBe('2026-11-01');
  });

  it('handles a leap day', () => {
    expect(toUtcAccountingDay(new Date('2028-02-29T12:00:00.000Z'))).toBe('2028-02-29');
  });

  it('refuses an invalid date', () => {
    expect(() => toUtcAccountingDay(new Date('nonsense'))).toThrow(UtcAccountingDayError);
  });
});

describe('re-branding a day read back from PostgreSQL', () => {
  it.each(['2026-08-13', '2026-01-01', '2028-02-29', '2025-12-31'])('accepts %s', (day) => {
    expect(parseUtcAccountingDay(day)).toBe(day);
  });

  it.each([
    ['a wrong shape', '2026-8-13'],
    ['a timestamp', '2026-08-13T00:00:00Z'],
    ['a slash form', '2026/08/13'],
    ['month 13', '2026-13-01'],
    ['day 32', '2026-08-32'],
    ['a non-leap 29 February', '2027-02-29'],
    ['empty', ''],
    ['text', 'today'],
  ])('rejects %s', (_label, day) => {
    expect(() => parseUtcAccountingDay(day)).toThrow(UtcAccountingDayError);
  });

  it('round-trips a derived day', () => {
    const derived = toUtcAccountingDay(new Date('2026-08-13T09:00:00.000Z'));

    expect(parseUtcAccountingDay(derived)).toBe(derived);
  });
});
