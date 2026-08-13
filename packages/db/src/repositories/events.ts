import { and, desc, eq, sql, type SQL } from 'drizzle-orm';

import { agents } from '../schema/agents.js';
import { blocks } from '../schema/blocks.js';
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

  /**
   * One page of the workspace timeline, newest first (AC-05).
   *
   * ORDERING. `received_at DESC, id DESC`. `received_at` is server-assigned and
   * therefore the only trustworthy axis - ordering by the client's
   * `occurred_at` would let a caller rewrite its own position in the history.
   * Two events can share a `received_at` (they routinely do: one batch is one
   * transaction stamped from one clock read), so `id` breaks the tie. Without
   * that tiebreaker the sort is non-deterministic and pagination can repeat or
   * skip rows.
   *
   * INDEX USE. The predicate leads with `workspace_id` and orders by
   * `received_at`, matching `events_workspace_received_idx`. With an agent
   * filter it leads with `workspace_id, agent_id`, matching
   * `events_workspace_agent_received_idx`. Both were created in Step 3.
   *
   * The agent filter takes an INTERNAL uuid that the caller has already
   * resolved inside this workspace - see `AgentRepository.findByExternalId`.
   * Resolving an external id here would risk a join that forgets the scope.
   */
  listTimeline: (
    executor: DatabaseExecutor,
    scope: WorkspaceScope,
    options: {
      readonly limit: number;
      readonly agentId?: string | undefined;
      readonly cursor?: { readonly receivedAt: Date; readonly id: string } | undefined;
    },
  ) => {
    const predicates: SQL[] = [eventScopePredicate(scope)];

    if (options.agentId !== undefined) {
      predicates.push(eq(events.agentId, options.agentId));
    }

    if (options.cursor !== undefined) {
      // Row-value comparison, which is exactly the ordering boundary: it means
      // "strictly older than the last row I showed you" in one expression that
      // cannot disagree with the ORDER BY. The equivalent OR-expansion is easy
      // to get subtly wrong. Both sides are BOUND PARAMETERS with explicit
      // casts - nothing from the cursor is concatenated into SQL text.
      predicates.push(
        sql`(${events.receivedAt}, ${events.id}) < (${options.cursor.receivedAt}::timestamptz, ${options.cursor.id}::uuid)`,
      );
    }

    return executor
      .select({
        id: events.id,
        eventId: events.eventId,
        type: events.type,
        category: events.category,
        occurredAt: events.occurredAt,
        receivedAt: events.receivedAt,
        precheckReceiptId: events.precheckReceiptId,
        agentUuid: agents.id,
        agentExternalId: agents.externalId,
        agentDisplayName: agents.displayName,
        blockUuid: blocks.id,
        blockExternalId: blocks.externalBlockId,
        blockSource: blocks.source,
      })
      .from(events)
      // Inner join: `events.agent_id` is NOT NULL with a composite FK to
      // `(workspace_id, id)`, so every event has an agent in this workspace.
      // The join condition repeats the workspace column, so the join itself
      // cannot reach across tenants even if the outer predicate were dropped.
      .innerJoin(
        agents,
        and(eq(agents.id, events.agentId), eq(agents.workspaceId, events.workspaceId)),
      )
      // Left join: most events have no block.
      .leftJoin(
        blocks,
        and(eq(blocks.id, events.blockId), eq(blocks.workspaceId, events.workspaceId)),
      )
      .where(and(...predicates))
      .orderBy(desc(events.receivedAt), desc(events.id))
      .limit(options.limit);
  },

  /**
   * One event with its display linkage, by INTERNAL uuid (AC-06).
   *
   * Workspace-scoped like every other read. A UUID is not authorization: an id
   * belonging to another tenant returns nothing, indistinguishable from an id
   * that does not exist.
   */
  findDetailById: (executor: DatabaseExecutor, scope: WorkspaceScope, id: string) =>
    executor
      .select({
        id: events.id,
        eventId: events.eventId,
        type: events.type,
        category: events.category,
        payload: events.payload,
        occurredAt: events.occurredAt,
        receivedAt: events.receivedAt,
        precheckReceiptId: events.precheckReceiptId,
        agentUuid: agents.id,
        agentExternalId: agents.externalId,
        agentDisplayName: agents.displayName,
        blockUuid: blocks.id,
        blockExternalId: blocks.externalBlockId,
        blockSource: blocks.source,
      })
      .from(events)
      .innerJoin(
        agents,
        and(eq(agents.id, events.agentId), eq(agents.workspaceId, events.workspaceId)),
      )
      .leftJoin(
        blocks,
        and(eq(blocks.id, events.blockId), eq(blocks.workspaceId, events.workspaceId)),
      )
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

/** A timeline row: the event plus the minimum needed to display it. */
export interface TimelineEventRow {
  readonly id: string;
  readonly eventId: string;
  readonly type: EventRow['type'];
  readonly category: EventRow['category'];
  readonly occurredAt: Date | null;
  readonly receivedAt: Date;
  readonly precheckReceiptId: string | null;
  readonly agent: {
    readonly id: string;
    readonly externalId: string;
    readonly displayName: string | null;
  };
  readonly block: {
    readonly id: string;
    readonly externalBlockId: string | null;
    readonly source: 'plane' | 'runtime';
  } | null;
}

/** A timeline row plus the stored validated event (AC-06). */
export interface EventDetailRow extends TimelineEventRow {
  /** The validated event object as stored. NOT raw HTTP request data. */
  readonly payload: unknown;
}

/** The ordering boundary a page resumes from. */
export interface TimelineCursor {
  readonly receivedAt: Date;
  readonly id: string;
}

export interface ListTimelineOptions {
  /** Already bounded by the caller against the contract's maximum. */
  readonly limit: number;
  /** INTERNAL agent uuid, already resolved inside this workspace. */
  readonly agentId?: string | undefined;
  readonly cursor?: TimelineCursor | undefined;
}

export interface EventRepository {
  /** Returns null when no such client event id exists IN THIS WORKSPACE. */
  findByEventId(eventId: string): Promise<EventRow | null>;
  findById(id: string): Promise<EventRow | null>;
  /** One page of the workspace timeline, newest first. */
  listTimeline(options: ListTimelineOptions): Promise<TimelineEventRow[]>;
  /** One event with its raw payload, by internal uuid. Null when not in scope. */
  findDetailById(id: string): Promise<EventDetailRow | null>;
  /**
   * Inserts an event, or reports it as an already-seen duplicate.
   *
   * @returns the stored row when newly inserted, or null when
   *   `(workspace_id, event_id)` already existed. Null is a normal outcome,
   *   not an error - it is how replay is detected.
   */
  insertIfNew(input: InsertEventInput): Promise<EventRow | null>;
}

/** Flattens the joined projection into the nested display shape. */
function toTimelineRow(row: {
  id: string;
  eventId: string;
  type: EventRow['type'];
  category: EventRow['category'];
  occurredAt: Date | null;
  receivedAt: Date;
  precheckReceiptId: string | null;
  agentUuid: string;
  agentExternalId: string;
  agentDisplayName: string | null;
  blockUuid: string | null;
  blockExternalId: string | null;
  blockSource: 'plane' | 'runtime' | null;
}): TimelineEventRow {
  return {
    id: row.id,
    eventId: row.eventId,
    type: row.type,
    category: row.category,
    occurredAt: row.occurredAt,
    receivedAt: row.receivedAt,
    precheckReceiptId: row.precheckReceiptId,
    agent: {
      id: row.agentUuid,
      externalId: row.agentExternalId,
      displayName: row.agentDisplayName,
    },
    // The left join produced no block when the event has none.
    block:
      row.blockUuid === null || row.blockSource === null
        ? null
        : {
            id: row.blockUuid,
            externalBlockId: row.blockExternalId,
            source: row.blockSource,
          },
  };
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

    async listTimeline(options: ListTimelineOptions): Promise<TimelineEventRow[]> {
      const rows = await eventQueries.listTimeline(executor, scope, options);
      return rows.map(toTimelineRow);
    },

    async findDetailById(id: string): Promise<EventDetailRow | null> {
      const rows = await eventQueries.findDetailById(executor, scope, id);
      const row = rows[0];
      if (row === undefined) {
        return null;
      }
      return { ...toTimelineRow(row), payload: row.payload };
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
