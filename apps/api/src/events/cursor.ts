import type { TimelineCursor } from '@hybrid/db';

/**
 * Opaque timeline pagination cursor.
 *
 * WHAT IT IS
 * ----------
 * The ordering boundary of the last row returned - `(received_at, id)` - so the
 * next page can resume with "strictly older than that". It reproduces the sort
 * key exactly, which is what makes paging a static dataset return no duplicates
 * and skip no rows. Offset pagination cannot promise that: rows arriving during
 * paging shift every subsequent offset.
 *
 * WHAT IT IS NOT
 * --------------
 * NOT AUTHORITY. The workspace is deliberately absent. A cursor is client-held
 * and therefore attacker-controlled; if tenancy could be read from it, forging
 * one would be a cross-tenant read. Scope comes only from the membership check
 * on each request, and the cursor is applied INSIDE that scope. So the worst a
 * forged cursor can do is move the caller's own page boundary within their own
 * workspace.
 *
 * It also carries no secret, no session data and no user identity - it is
 * base64url, which is encoding, not encryption. Anything placed here is
 * readable by the client.
 *
 * The filter is not encoded either. Applying an all-agents cursor to an
 * agent-filtered query would still be workspace-safe but would produce a
 * confusing page, so the client resets pagination when the filter changes - see
 * the timeline component.
 */

/**
 * The decoded shape is `{ r, i }` - short keys because the value travels in a
 * URL on every page request, and the client never reads them.
 *
 *   r  ISO-8601 `received_at` of the last row on the previous page
 *   i  internal event uuid of that row, the ordering tiebreaker
 *
 * Validated by hand rather than with Zod: `apps/api` does not depend on Zod
 * directly (schemas arrive through `@hybrid/contracts`), and adding the
 * dependency for a two-field internal shape would widen the app's surface for
 * no benefit. The checks below are exhaustive for that shape.
 */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Encodes the boundary of the last row on a page. */
export function encodeCursor(cursor: TimelineCursor): string {
  const payload = JSON.stringify({ r: cursor.receivedAt.toISOString(), i: cursor.id });
  return Buffer.from(payload, 'utf8').toString('base64url');
}

/**
 * Decodes a client-supplied cursor.
 *
 * EVERY step is treated as hostile input: the base64 may not decode, the result
 * may not be UTF-8 JSON, the JSON may not be an object, the fields may be
 * missing, misspelled or the wrong type, and the date may be unparseable.
 * Returns null for all of them, which the route turns into one safe 400.
 *
 * @returns the boundary, or null when the cursor is not one we issued.
 */
export function decodeCursor(raw: string): TimelineCursor | null {
  let decoded: string;
  try {
    decoded = Buffer.from(raw, 'base64url').toString('utf8');
  } catch {
    return null;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(decoded);
  } catch {
    return null;
  }

  // Rejects null (typeof null === 'object'), arrays, and primitives.
  if (typeof parsedJson !== 'object' || parsedJson === null || Array.isArray(parsedJson)) {
    return null;
  }

  const candidate = parsedJson as Record<string, unknown>;

  // Strict: an extra key means this is not a cursor we issued.
  const keys = Object.keys(candidate);
  if (keys.length !== 2 || !keys.includes('r') || !keys.includes('i')) {
    return null;
  }

  const { r, i } = candidate;
  if (typeof r !== 'string' || typeof i !== 'string') {
    return null;
  }

  if (!UUID_PATTERN.test(i)) {
    return null;
  }

  const receivedAt = new Date(r);
  // Catches both unparseable text and values that look like dates but are not
  // real instants. `new Date('nonsense')` yields an Invalid Date, not a throw.
  if (Number.isNaN(receivedAt.getTime())) {
    return null;
  }

  // `i` is a validated UUID and reaches SQL as a bound, cast parameter - never
  // as concatenated text.
  return { receivedAt, id: i };
}
