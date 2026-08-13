import { and, eq, type SQL } from 'drizzle-orm';

import { events } from '../schema/events.js';
import type { DatabaseExecutor } from './executor.js';
import type { WorkspaceScope } from './workspace-scope.js';

/**
 * Workspace-scoped event access.
 *
 * APPEND-ONLY AUDIT STREAM
 * ------------------------
 * There is exactly one write method, `insertIfNew`, and there is deliberately
 * NO `update` or `delete`. Events are the audit record of what a runtime
 * reported; rewriting one would destroy the thing it exists to preserve. A
 * duplicate replay must leave the original row byte-identical, which is why the
 * insert uses `DO NOTHING` rather than `DO UPDATE`.
 *
 * STEP 10 SCOPE: ingest only. No timeline, no pagination, no raw-detail route
 * (Step 11), and no ledger effect whatsoever (Step 19).
 */

export type EventRow = typeof events.$inferSelect;

/** The scope predicate every event query is anchored on. */
export function eventScopePredicate(scope: WorkspaceScope): SQL {
  return eq(events.workspaceId, scope.workspaceId);
}

export const eventQueries = {
  /**
   * THE CLEAREST CASE FOR SCOPING.
   *
   * `event_id` is client-supplied and unique only per workspace, so two tenants
   * can legitimately both hold event `evt-123`. A lookup on `event_id` alone
   * would be a direct cross-tenant read. The emitted SQL is equivalent to:
   *
   *   WHERE workspace_id = :workspace_id AND event_id = :event_id
   */
  findByEventId: (executor: DatabaseExecutor, scope: WorkspaceScope, eventId: string) =>
    executor
      .select()
      .from(events)
      .where(and(eventScopePredicate(scope), eq(events.eventId, eventId)))
      .limit(1),

  /** Internal surrogate id lookup. Still workspace-scoped: a UUID is not authorization. */
  findById: (executor: DatabaseExecutor, scope: WorkspaceScope, id: string) =>
    executor
      .select()
      .from(events)
      .where(and(eventScopePredicate(scope), eq(events.id, id)))
      .limit(1),
} as const;

/**
 * One validated event, ready for persistence.
 *
 * Every reference is already resolved to an internal id INSIDE the scope's
 * workspace - this type cannot express a cross-tenant reference because it
 * carries no workspace of its own.
 */
export interface InsertEventInput {
  /** Client-supplied idempotency key, unique per workspace. */
  readonly eventId: string;
  /** Internal agent UUID, resolved within this workspace. */
  readonly agentId: string;
  readonly type: EventRow['type'];
  readonly category: EventRow['category'];
  /** The entire validated event, stored verbatim for audit (AC-06). */
  readonly payload: unknown;
  /** Internal receipt UUID, resolved within this workspace. */
  readonly precheckReceiptId?: string | undefined;
  /** Internal block UUID, resolved within this workspace. */
  readonly blockId?: string | undefined;
  /** Client-reported time. Untrusted metadata. */
  readonly occurredAt?: Date | undefined;
  /** SERVER time. Never client-supplied. */
  readonly receivedAt: Date;
}

export interface EventRepository {
  /** Returns null when no such client event id exists IN THIS WORKSPACE. */
  findByEventId(eventId: string): Promise<EventRow | null>;
  findById(id: string): Promise<EventRow | null>;
  /**
   * Inserts an event, or reports it as an already-seen duplicate.
   *
   * @returns the stored row when newly inserted, or null when
   *   `(workspace_id, event_id)` already existed. Null is a normal outcome,
   *   not an error - it is how replay is detected.
   */
  insertIfNew(input: InsertEventInput): Promise<EventRow | null>;
}

export function createEventRepository(
  executor: DatabaseExecutor,
  scope: WorkspaceScope,
): EventRepository {
  return {
    async findByEventId(eventId: string): Promise<EventRow | null> {
      const rows = await eventQueries.findByEventId(executor, scope, eventId);
      return rows[0] ?? null;
    },

    async findById(id: string): Promise<EventRow | null> {
      const rows = await eventQueries.findById(executor, scope, id);
      return rows[0] ?? null;
    },

    /**
     * Atomic idempotent insert.
     *
     *   INSERT INTO events (...) VALUES (...)
     *   ON CONFLICT (workspace_id, event_id) DO NOTHING
     *   RETURNING *
     *
     * THE IDEMPOTENCY BOUNDARY IS THE DATABASE, NOT APPLICATION LOGIC.
     *
     * There is deliberately no `SELECT ... then INSERT if absent`: that has a
     * read-modify-write window in which two concurrent requests both observe
     * "absent" and both insert. Here the unique index on
     * `(workspace_id, event_id)` arbitrates - PostgreSQL serialises the
     * conflicting inserts and the loser matches the conflict target, inserting
     * nothing and returning no row.
     *
     * `DO NOTHING`, never `DO UPDATE`. A replay must leave the original row
     * completely untouched: same payload, same occurred_at, same received_at,
     * same agent linkage. Rewriting it on replay would let a later, possibly
     * altered, submission silently overwrite the original audit record.
     *
     * An empty result therefore means "already present", which the caller
     * counts as a duplicate rather than treating as a failure.
     */
    async insertIfNew(input: InsertEventInput): Promise<EventRow | null> {
      const rows = await executor
        .insert(events)
        .values({
          // Workspace comes from the SCOPE, never from caller input.
          workspaceId: scope.workspaceId,
          eventId: input.eventId,
          agentId: input.agentId,
          type: input.type,
          category: input.category,
          payload: input.payload,
          precheckReceiptId: input.precheckReceiptId ?? null,
          blockId: input.blockId ?? null,
          occurredAt: input.occurredAt ?? null,
          receivedAt: input.receivedAt,
        })
        .onConflictDoNothing({ target: [events.workspaceId, events.eventId] })
        .returning();

      return rows[0] ?? null;
    },
  };
}
