/**
 * Opaque audit pagination cursor.
 *
 * Identical in shape and reasoning to the event-timeline cursor: it encodes
 * the ordering boundary of the last row returned - `(created_at, id)` - so the
 * next page resumes with "strictly older than that". Reproducing the sort key
 * exactly is what makes paging a static audit stream return no duplicates and
 * skip no rows.
 *
 * NOT AUTHORITY. The workspace is deliberately absent. A cursor is client-held
 * and therefore attacker-controlled; if tenancy could be read from it, forging
 * one would be a cross-tenant read of the audit trail. Scope comes only from
 * the membership check, and the cursor is applied INSIDE it - so the worst a
 * forged cursor can do is move the caller's own page boundary within their own
 * workspace.
 *
 * It carries no secret and no session data; base64url is encoding, not
 * encryption.
 */

/**
 * The decoded shape is `{ c, i }` - short keys because the value travels in a
 * URL on every page request and the client never reads them.
 *
 *   c  ISO-8601 `created_at` of the last row on the previous page
 *   i  internal uuid of that row, the ordering tiebreaker
 *
 * Validated by hand: `apps/api` does not depend on Zod directly, and the shape
 * is two fields.
 */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The ordering boundary shared by the receipt and block streams. */
export interface AuditPageCursor {
  readonly createdAt: Date;
  readonly id: string;
}

export function encodeAuditCursor(cursor: AuditPageCursor): string {
  const payload = JSON.stringify({ c: cursor.createdAt.toISOString(), i: cursor.id });
  return Buffer.from(payload, 'utf8').toString('base64url');
}

/**
 * Decodes a client-supplied cursor.
 *
 * EVERY step is treated as hostile input: the base64 may not decode, the
 * result may not be UTF-8 JSON, it may not be an object, the fields may be
 * missing or the wrong type, and the date may be unparseable. Returns null for
 * all of them, which the route turns into one safe 400 - never a silent
 * fallback to page one, which would restart a paging loop.
 */
export function decodeAuditCursor(raw: string): AuditPageCursor | null {
  let decoded: string;
  try {
    decoded = Buffer.from(raw, 'base64url').toString('utf8');
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return null;
  }

  // Rejects null (typeof null === 'object'), arrays and primitives.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const candidate = parsed as Record<string, unknown>;
  const keys = Object.keys(candidate);
  // Strict: an extra key means this is not a cursor we issued.
  if (keys.length !== 2 || !keys.includes('c') || !keys.includes('i')) {
    return null;
  }

  const { c, i } = candidate;
  if (typeof c !== 'string' || typeof i !== 'string' || !UUID_PATTERN.test(i)) {
    return null;
  }

  const createdAt = new Date(c);
  // Catches unparseable text and values that look like dates but are not real
  // instants; `new Date('nonsense')` yields an Invalid Date rather than throwing.
  if (Number.isNaN(createdAt.getTime())) {
    return null;
  }

  // `i` is a validated UUID and reaches SQL as a bound, cast parameter.
  return { createdAt, id: i };
}
