/**
 * The UTC accounting day.
 *
 * WHY UTC, AND ONLY UTC
 * ---------------------
 * A daily cap needs one unambiguous boundary. Local time gives a different one
 * per server, per operator and per agent, and shifts twice a year under
 * daylight saving - so "today's spend" would depend on who was asking and in
 * which month. UTC has no such ambiguity: it never shifts, and every party
 * computes the same boundary from the same instant.
 *
 * WHY A BRANDED TYPE
 * ------------------
 * Same reasoning as `WorkspaceScope`. The accounting day is SERVER AUTHORITY:
 * no HTTP caller may choose which day their spend lands on, or they could
 * charge today's overspend to tomorrow. A bare `string` would let a future
 * route pass `req.query.day` straight through and nobody would notice in
 * review. The brand makes that a compile error, because the only way to obtain
 * one is from a `Date` the server produced or from a value PostgreSQL returned.
 */

declare const utcAccountingDayBrand: unique symbol;

/** A validated 'YYYY-MM-DD' UTC accounting day. */
export type UtcAccountingDay = string & { readonly [utcAccountingDayBrand]: true };

export class UtcAccountingDayError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'UtcAccountingDayError';
  }
}

/** Exactly 'YYYY-MM-DD'. Matches the PostgreSQL `date` text representation. */
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Derives the UTC accounting day from a server instant.
 *
 * THE ONLY WAY A DAY ENTERS THE SYSTEM.
 *
 * `toISOString()` is defined to render in UTC regardless of the host's zone, so
 * this result cannot vary with a developer's laptop, a container's `TZ`, or a
 * daylight-saving transition. No `getFullYear`, `getMonth`, `getDate`,
 * `toLocaleDateString` or `Intl` anywhere - every one of those is local-time.
 *
 * @param instant - a SERVER clock reading. Never a client timestamp, and never
 *   an event's `occurred_at`, which is untrusted client metadata.
 */
export function toUtcAccountingDay(instant: Date): UtcAccountingDay {
  const time = instant.getTime();
  if (Number.isNaN(time)) {
    throw new UtcAccountingDayError('Cannot derive an accounting day from an invalid date.');
  }

  // '2026-08-12T23:59:59.999Z' -> '2026-08-12'
  return instant.toISOString().slice(0, 10) as UtcAccountingDay;
}

/**
 * Re-brands a 'YYYY-MM-DD' value that came back from PostgreSQL.
 *
 * The `day` column is mapped in string mode precisely so it never passes
 * through a JavaScript `Date` and gets shifted by a local zone. This validates
 * the shape and hands the value back as a day.
 *
 * NOT for request input. A route calling this with `req.query.day` would defeat
 * the brand, so a guardrail test asserts no HTTP contract carries a day field.
 */
export function parseUtcAccountingDay(value: string): UtcAccountingDay {
  if (!DAY_PATTERN.test(value)) {
    throw new UtcAccountingDayError('Accounting day must be formatted YYYY-MM-DD.');
  }

  // Rejects '2026-13-01' and '2026-02-30': re-rendering a real instant is the
  // cheapest correctness check, and round-tripping through UTC keeps it
  // zone-independent.
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new UtcAccountingDayError('Accounting day is not a real calendar date.');
  }

  return value as UtcAccountingDay;
}
