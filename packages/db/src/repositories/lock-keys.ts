import { createHash } from 'node:crypto';

/**
 * Deterministic PostgreSQL advisory-lock keys.
 *
 * WHY A DERIVED KEY AND NOT A ROW LOCK
 * ------------------------------------
 * The thing ingest must serialize on is an event that DOES NOT EXIST YET. There
 * is no row to `SELECT ... FOR UPDATE`, so the mutual exclusion has to be keyed
 * on the identity itself: `(workspace_id, event_id)`.
 *
 * REQUIREMENTS THIS SATISFIES
 * ---------------------------
 * - Deterministic: the same identity always yields the same key, in any
 *   process, on any Render instance, across restarts. Nothing here reads
 *   process-local memory, a counter, a clock or a random source.
 * - Workspace-qualified: the workspace id is part of the hash input, so two
 *   tenants using the same `event_id` do not contend with each other.
 * - Unambiguous: components are joined with a NUL separator and a domain tag,
 *   so `('ws-a', 'b\0c')` and `('ws-a\0b', 'c')` cannot collide by
 *   concatenation.
 *
 * COLLISION CHARACTERISTICS
 * -------------------------
 * The key space is the full signed 64-bit range. A collision between two
 * DIFFERENT identities is not a correctness problem - it costs an unnecessary
 * serialization between two unrelated events, nothing more. Correctness still
 * rests on `UNIQUE (workspace_id, event_id)`, which the advisory lock
 * supplements rather than replaces.
 */

/** Domain tag, so these keys can never collide with a future lock family. */
const EVENT_INGEST_DOMAIN = 'hybrid:event-ingest:v1';

const TWO_POW_64 = 1n << 64n;
const TWO_POW_63 = 1n << 63n;

/**
 * The advisory-lock key for one event identity.
 *
 * Returns a `bigint` in the signed 64-bit range, because `pg_advisory_xact_lock`
 * takes a PostgreSQL `bigint`. The first 8 bytes of SHA-256 are read big-endian
 * as an unsigned integer and then folded into the signed range - a
 * representation change, not a narrowing, so no entropy is discarded.
 */
export function eventIngestLockKey(workspaceId: string, eventId: string): bigint {
  const digest = createHash('sha256')
    .update(`${EVENT_INGEST_DOMAIN}\0${workspaceId}\0${eventId}`, 'utf8')
    .digest();

  const unsigned = digest.readBigUInt64BE(0);
  return unsigned >= TWO_POW_63 ? unsigned - TWO_POW_64 : unsigned;
}

/**
 * Orders lock keys so concurrent batches acquire them in the same sequence.
 *
 * THIS IS THE DEADLOCK GUARD.
 *
 * Advisory locks taken with `pg_advisory_xact_lock` are held until COMMIT, so a
 * batch holding several at once can deadlock against another batch that wants
 * the same locks in the opposite order:
 *
 *   A = [E1, E2]   holds E1, waits for E2
 *   B = [E2, E1]   holds E2, waits for E1        -> deadlock
 *
 * Acquiring in a total order that both batches compute identically removes the
 * cycle by construction. The event id is the tiebreaker so that even a hash
 * collision between two distinct ids still yields a total - not merely partial
 * - order.
 */
export function compareLockKeys(
  a: { readonly lockKey: bigint; readonly eventId: string },
  b: { readonly lockKey: bigint; readonly eventId: string },
): number {
  if (a.lockKey < b.lockKey) return -1;
  if (a.lockKey > b.lockKey) return 1;
  return a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0;
}
