import { describe, expect, it } from 'vitest';

import { compareLockKeys, eventIngestLockKey } from '../src/repositories/lock-keys';

/**
 * Advisory-lock key derivation.
 *
 * These properties are not cosmetic. The key is the only thing making two
 * requests on different Render instances agree that they are talking about the
 * same event identity, and the ordering is the only thing preventing two
 * overlapping batches from deadlocking.
 */

const WORKSPACE_A = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_B = '22222222-2222-4222-8222-222222222222';

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

describe('key derivation', () => {
  it('is deterministic', () => {
    // Same identity, same key - forever, in every process.
    expect(eventIngestLockKey(WORKSPACE_A, 'evt-1')).toBe(
      eventIngestLockKey(WORKSPACE_A, 'evt-1'),
    );
  });

  it('is pinned to an exact value', () => {
    // A golden value. Changing the derivation would mean a deploy in which old
    // and new instances lock DIFFERENT keys for the same event and stop
    // excluding each other - so this must break loudly if anyone edits it.
    expect(eventIngestLockKey(WORKSPACE_A, 'evt-1')).toMatchInlineSnapshot(
      `6315783559430028429n`,
    );
  });

  it('separates workspaces using the same event id', () => {
    // Two tenants replaying `evt-1` must not serialize against each other.
    expect(eventIngestLockKey(WORKSPACE_A, 'evt-1')).not.toBe(
      eventIngestLockKey(WORKSPACE_B, 'evt-1'),
    );
  });

  it('separates event ids within one workspace', () => {
    expect(eventIngestLockKey(WORKSPACE_A, 'evt-1')).not.toBe(
      eventIngestLockKey(WORKSPACE_A, 'evt-2'),
    );
  });

  it('cannot be confused by concatenation', () => {
    // Without a separator, ('ws-a', 'b-c') and ('ws-a-b', 'c') would collide
    // and two unrelated identities would share a lock.
    expect(eventIngestLockKey('ws-a', 'b-c')).not.toBe(eventIngestLockKey('ws-a-b', 'c'));
    expect(eventIngestLockKey('a', 'bc')).not.toBe(eventIngestLockKey('ab', 'c'));
  });

  it('stays inside the PostgreSQL signed bigint range', () => {
    // pg_advisory_xact_lock takes a bigint; an out-of-range value is an error
    // at runtime, not a compile-time one.
    for (let i = 0; i < 2_000; i += 1) {
      const key = eventIngestLockKey(WORKSPACE_A, `evt-${String(i)}`);
      expect(typeof key).toBe('bigint');
      expect(key).toBeGreaterThanOrEqual(INT64_MIN);
      expect(key).toBeLessThanOrEqual(INT64_MAX);
    }
  });

  it('produces both negative and positive keys', () => {
    // Proves the signed fold is real. If everything were positive, half the
    // key space would be unused and collisions would be twice as likely.
    const keys = Array.from({ length: 500 }, (_v, i) =>
      eventIngestLockKey(WORKSPACE_A, `evt-${String(i)}`),
    );

    expect(keys.some((k) => k < 0n)).toBe(true);
    expect(keys.some((k) => k > 0n)).toBe(true);
  });

  it('does not collide across a large sample', () => {
    const keys = new Set<bigint>();
    for (let i = 0; i < 5_000; i += 1) {
      keys.add(eventIngestLockKey(WORKSPACE_A, `evt-${String(i)}`));
    }

    expect(keys.size).toBe(5_000);
  });

  it('handles the full range of legal event ids', () => {
    // event_id is an opaque client string up to 200 chars, not a UUID.
    for (const eventId of ['a', 'x'.repeat(200), 'evt/with:punctuation', 'ULID01HZY', '🙂']) {
      expect(() => eventIngestLockKey(WORKSPACE_A, eventId)).not.toThrow();
    }
  });

  it('depends on nothing process-local', () => {
    // No clock, no randomness, no counter - the same call in a fresh process on
    // another Render instance must yield the same key.
    const source = eventIngestLockKey.toString();

    expect(source).not.toMatch(/Math\.random|Date\.now|process\.pid|randomUUID/);
  });
});

describe('lock ordering', () => {
  const entry = (eventId: string): { lockKey: bigint; eventId: string } => ({
    eventId,
    lockKey: eventIngestLockKey(WORKSPACE_A, eventId),
  });

  it('sorts two overlapping batches into the same sequence', () => {
    // THE DEADLOCK GUARD. Request A sends [E1, E2]; request B sends [E2, E1].
    // Both must acquire in one order.
    const a = [entry('E1'), entry('E2')].sort(compareLockKeys);
    const b = [entry('E2'), entry('E1')].sort(compareLockKeys);

    expect(a.map((x) => x.eventId)).toEqual(b.map((x) => x.eventId));
  });

  it('agrees on order regardless of input permutation', () => {
    const ids = ['E1', 'E2', 'E3', 'E4', 'E5'];
    const canonical = ids.map(entry).sort(compareLockKeys).map((x) => x.eventId);

    for (const permutation of [
      ['E5', 'E4', 'E3', 'E2', 'E1'],
      ['E3', 'E1', 'E5', 'E2', 'E4'],
      ['E2', 'E5', 'E1', 'E4', 'E3'],
    ]) {
      expect(permutation.map(entry).sort(compareLockKeys).map((x) => x.eventId)).toEqual(canonical);
    }
  });

  it('is a TOTAL order even when keys collide', () => {
    // A hash collision must still yield a deterministic sequence; a partial
    // order would leave the deadlock window open for exactly those pairs.
    const collided = [
      { eventId: 'zebra', lockKey: 42n },
      { eventId: 'apple', lockKey: 42n },
    ];

    expect([...collided].sort(compareLockKeys).map((x) => x.eventId)).toEqual(['apple', 'zebra']);
    expect([...collided].reverse().sort(compareLockKeys).map((x) => x.eventId)).toEqual([
      'apple',
      'zebra',
    ]);
  });

  it('orders negative keys before positive ones', () => {
    // Numeric comparison, not string comparison - "-1" < "0" lexically too, but
    // "-9" > "-10" lexically, which would break the total order.
    const sorted = [
      { eventId: 'a', lockKey: 5n },
      { eventId: 'b', lockKey: -10n },
      { eventId: 'c', lockKey: -9n },
      { eventId: 'd', lockKey: 0n },
    ].sort(compareLockKeys);

    expect(sorted.map((x) => x.lockKey)).toEqual([-10n, -9n, 0n, 5n]);
  });

  it('reports equality as 0 for the identical entry', () => {
    const only = entry('E1');

    expect(compareLockKeys(only, only)).toBe(0);
  });
});
