import { sql } from 'drizzle-orm';

import type { DatabaseExecutor } from './executor.js';
import { compareLockKeys, eventIngestLockKey, precheckActionLockKey } from './lock-keys.js';
import type { WorkspaceScope } from './workspace-scope.js';

/**
 * Transaction-scoped serialization for event ingest.
 *
 * WHY THIS EXISTS
 * ---------------
 * `INSERT ... ON CONFLICT DO NOTHING` makes the INSERT itself idempotent, but it
 * only reveals the duplicate at the moment of insertion - by which time the
 * caller has already resolved the agent, verified the receipt and created the
 * runtime block. Those are one-time side effects performed on behalf of an
 * event that was never accepted.
 *
 * To decide "is this a duplicate?" BEFORE doing any of that work, the check has
 * to be a read - and a bare read is race-prone, because two concurrent
 * transactions can both observe absence. The advisory lock closes that window:
 * whoever holds it is the only transaction that can be evaluating this event
 * identity, so its SELECT is authoritative.
 *
 * WHY TRANSACTION-SCOPED, NOT SESSION-SCOPED
 * ------------------------------------------
 * `pg_advisory_xact_lock` releases automatically at COMMIT or ROLLBACK, with no
 * unlock call to leak on an error path. Session-scoped `pg_advisory_lock` must
 * NOT be used here: Neon and PgBouncer run in transaction pooling mode, where a
 * connection is returned to the pool between statements. A session-held lock
 * would outlive the request, attach to whatever request next borrowed that
 * connection, and eventually wedge the pool.
 *
 * ISOLATION ASSUMPTION
 * --------------------
 * This relies on READ COMMITTED (the PostgreSQL default, and what the driver
 * uses): each statement takes a fresh snapshot, so once the lock is acquired the
 * subsequent SELECT sees the winner's committed row. Under REPEATABLE READ the
 * snapshot would predate the winner's commit and the SELECT would miss it -
 * which is precisely why `UNIQUE (workspace_id, event_id)` and
 * `ON CONFLICT DO NOTHING` are RETAINED as defense in depth rather than
 * replaced by this lock.
 */

export interface EventLockRequest {
  readonly eventId: string;
  readonly lockKey: bigint;
}

export interface PrecheckLockRepository {
  /**
   * Serializes concurrent requests carrying the same precheck action identity.
   *
   * THE FIRST LOCK a decision takes - see the global lock order in
   * docs/precheck.md. Two simultaneous retries of one action both block here,
   * so only one can reach the decision and the other finds the committed
   * receipt waiting.
   */
  lockAction(actionId: string): Promise<void>;
}

export function createPrecheckLockRepository(
  executor: DatabaseExecutor,
  scope: WorkspaceScope,
): PrecheckLockRepository {
  return {
    async lockAction(actionId: string): Promise<void> {
      // Workspace from the SCOPE, so a caller cannot aim a lock at another
      // tenant's key space.
      const key = precheckActionLockKey(scope.workspaceId, actionId);
      await executor.execute(sql`select pg_advisory_xact_lock(${key})`);
    },
  };
}

export interface IngestLockRepository {
  /**
   * Locks every event identity in the batch, in a deterministic global order.
   *
   * Ordering is what prevents two batches containing the same ids in different
   * sequences from deadlocking. See `compareLockKeys`.
   */
  lockEvents(eventIds: readonly string[]): Promise<void>;
}

export function createIngestLockRepository(
  executor: DatabaseExecutor,
  scope: WorkspaceScope,
): IngestLockRepository {
  return {
    async lockEvents(eventIds: readonly string[]): Promise<void> {
      // Deduplicated because acquiring the same advisory lock twice in one
      // transaction is legal but pointlessly increments a reference count.
      const requests = new Map<string, EventLockRequest>();
      for (const eventId of eventIds) {
        // The workspace comes from the SCOPE, so a caller cannot aim a lock at
        // another tenant's key space.
        requests.set(eventId, {
          eventId,
          lockKey: eventIngestLockKey(scope.workspaceId, eventId),
        });
      }

      const ordered = [...requests.values()].sort(compareLockKeys);

      // Sequential, not concurrent: acquisition ORDER is the whole point, and
      // firing these in parallel would forfeit it.
      for (const request of ordered) {
        await executor.execute(sql`select pg_advisory_xact_lock(${request.lockKey})`);
      }
    },
  };
}
