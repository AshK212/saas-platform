import { and, eq, type SQL } from 'drizzle-orm';

import { events } from '../schema/events.js';
import type { DatabaseExecutor } from './executor.js';
import type { WorkspaceScope } from './workspace-scope.js';

/**
 * Workspace-scoped event reads.
 *
 * STEP 4 SCOPE: READS ONLY, and only enough to prove the isolation pattern.
 * No ingest, no idempotency handling, no timeline, no pagination, no raw-detail
 * route. Those belong to their own steps.
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

export interface EventRepository {
  /** Returns null when no such client event id exists IN THIS WORKSPACE. */
  findByEventId(eventId: string): Promise<EventRow | null>;
  findById(id: string): Promise<EventRow | null>;
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
  };
}
