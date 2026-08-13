import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { decimalUsdSchema } from '@hybrid/contracts';
import { MAX_USD_MICROS, MoneyError, formatUsdFromMicros, parseUsdToMicros } from '@hybrid/db';
import { describe, expect, it } from 'vitest';

/**
 * CROSS-PACKAGE ACCOUNTING AGREEMENT.
 *
 * `@hybrid/contracts` validates money on the wire; `@hybrid/db` does the
 * authoritative arithmetic. The two define the same shape independently,
 * because contracts is browser-safe and zod-only and cannot import the
 * database package.
 *
 * Independent definitions can drift, and a drift here is a real defect in
 * either direction:
 *
 *   contract stricter than storage -> a storable amount is rejected at the API
 *   storage stricter than contract -> an accepted amount explodes at persistence
 *
 * `apps/api` depends on both, so this is the only place the two can be compared.
 * This file exists purely to keep them in agreement.
 */

const API_ROOT = path.resolve(import.meta.dirname, '..');

/** Every value both layers must accept. */
const VALID = [
  '0',
  '0.000001',
  '0.1',
  '0.100000',
  '1',
  '25',
  '25.000000',
  '41.000000',
  '25.123456',
  '99999999.999999',
];

/** Every value both layers must reject, for the same reason. */
const INVALID = [
  '-5.000000',
  '+5',
  '4.1e1',
  '0.0000009',
  '100000000',
  '01.5',
  '.5',
  '25.',
  '1,000',
  '$25',
  ' 25 ',
  '',
  'twenty',
  'NaN',
  'Infinity',
  '0x19',
];

describe('the wire contract and the ledger agree on what money is', () => {
  it.each(VALID)('both accept %s', (value) => {
    expect(decimalUsdSchema.safeParse(value).success, `contract rejected ${value}`).toBe(true);
    expect(() => parseUsdToMicros(value), `ledger rejected ${value}`).not.toThrow();
  });

  it.each(INVALID)('both reject %s', (value) => {
    expect(decimalUsdSchema.safeParse(value).success, `contract accepted ${value}`).toBe(false);
    expect(() => parseUsdToMicros(value), `ledger accepted ${value}`).toThrow(MoneyError);
  });

  it('agree on the storage maximum', () => {
    const max = '99999999.999999';

    expect(decimalUsdSchema.safeParse(max).success).toBe(true);
    expect(parseUsdToMicros(max)).toBe(MAX_USD_MICROS);
    // And one micro-dollar beyond it is refused by both.
    expect(decimalUsdSchema.safeParse('100000000.000000').success).toBe(false);
    expect(() => parseUsdToMicros('100000000.000000')).toThrow();
  });

  it('a contract-valid amount always survives the ledger round trip', () => {
    // Anything the API accepts must be storable and readable back unchanged.
    for (const value of VALID) {
      const canonical = formatUsdFromMicros(parseUsdToMicros(value));
      expect(decimalUsdSchema.safeParse(canonical).success, canonical).toBe(true);
      expect(parseUsdToMicros(canonical)).toBe(parseUsdToMicros(value));
    }
  });

  it('the canonical form is always six fractional digits', () => {
    // One shape everywhere, so a cap set as `25` and a committed total read
    // back as `25.000000` compare equal without normalisation at every site.
    for (const value of VALID) {
      expect(formatUsdFromMicros(parseUsdToMicros(value))).toMatch(/^\d+\.\d{6}$/);
    }
  });
});

describe('the accounting day is server authority', () => {
  /** Every contract and route source file in the API and contracts packages. */
  function sourceFiles(): string[] {
    const roots = [
      path.join(API_ROOT, 'src'),
      path.resolve(API_ROOT, '..', '..', 'packages', 'contracts', 'src'),
    ];
    const found: string[] = [];

    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === 'dist') continue;
          walk(full);
          continue;
        }
        if (/\.ts$/.test(entry.name)) found.push(full);
      }
    };
    for (const root of roots) walk(root);
    return found;
  }

  it('NO HTTP CONTRACT ACCEPTS A DAY FROM THE CALLER', () => {
    // A caller choosing their accounting day could charge today's overspend to
    // tomorrow, or replay yesterday's headroom. The day is derived server-side
    // from the injected clock and nowhere else.
    const offenders: string[] = [];

    for (const file of sourceFiles()) {
      const code = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');

      if (/\b(day|utc_day|utcDay|accounting_day|accountingDay)\s*:\s*z\./.test(code)) {
        offenders.push(path.relative(API_ROOT, file));
      }
    }

    expect(offenders, 'no request schema may carry an accounting day').toEqual([]);
  });

  it('no route reads a day from request input', () => {
    const offenders: string[] = [];

    for (const file of sourceFiles()) {
      const code = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');

      if (/req\.(param|query)\(\s*['"](day|utc_day|date|accounting_day)['"]/.test(code)) {
        offenders.push(path.relative(API_ROOT, file));
      }
    }

    expect(offenders).toEqual([]);
  });

  it('no application code derives a day from local time', () => {
    const offenders: string[] = [];

    for (const file of sourceFiles()) {
      const code = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');

      // These read the HOST timezone. An accounting boundary derived from them
      // would differ per deployment and shift twice a year.
      if (/toLocaleDateString|getTimezoneOffset|new Intl\.DateTimeFormat/.test(code)) {
        offenders.push(path.relative(API_ROOT, file));
      }
    }

    expect(offenders).toEqual([]);
  });
});
