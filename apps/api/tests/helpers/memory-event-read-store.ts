import { randomUUID } from 'node:crypto';

import type { EventDetailRow, TimelineEventRow, WorkspaceScope } from '@hybrid/db';

import type {
  EventReadStore,
  TimelinePage,
  TimelineQueryOptions,
} from '../../src/events/read-store';

/**
 * In-memory `EventReadStore` mirroring the production read algorithm.
 *
 * Reproduces the semantics that matter: workspace scoping on every read,
 * `received_at DESC, id DESC` ordering, the `(received_at, id)` cursor
 * boundary, limit+1 page probing, and agent filtering resolved INSIDE the
 * workspace.
 *
 * WHAT IT CANNOT PROVE
 * --------------------
 * That the emitted SQL really carries the workspace predicate, that PostgreSQL
 * orders row-value comparisons the way this does, or that the Step 3 indexes
 * are used. Those are `packages/db/tests/timeline.test.ts` (compiled SQL) and
 * `packages/db/tests/timeline.live.test.ts` (real PostgreSQL).
 */

export interface SeedAgent {
  readonly workspaceId: string;
  readonly externalId: string;
  readonly displayName?: string | null;
}

export interface SeedEvent {
  readonly workspaceId: string;
  readonly eventId: string;
  readonly agentExternalId: string;
  readonly type: TimelineEventRow['type'];
  readonly category?: TimelineEventRow['category'];
  readonly receivedAt: Date;
  readonly occurredAt?: Date | null;
  readonly payload?: unknown;
  readonly precheckReceiptId?: string | null;
  readonly block?: {
    readonly externalBlockId: string | null;
    readonly source: 'plane' | 'runtime';
  };
}

interface StoredAgent {
  id: string;
  workspaceId: string;
  externalId: string;
  displayName: string | null;
}

interface StoredEvent extends EventDetailRow {
  workspaceId: string;
}

export interface MemoryEventReadStore extends EventReadStore {
  readonly agents: StoredAgent[];
  readonly rows: StoredEvent[];
  seedAgent(agent: SeedAgent): StoredAgent;
  seedEvent(event: SeedEvent): StoredEvent;
}

export function createMemoryEventReadStore(): MemoryEventReadStore {
  const agents: StoredAgent[] = [];
  const rows: StoredEvent[] = [];

  function resolveAgent(workspaceId: string, externalId: string): StoredAgent {
    const existing = agents.find(
      (a) => a.workspaceId === workspaceId && a.externalId === externalId,
    );
    if (existing !== undefined) {
      return existing;
    }
    const created: StoredAgent = {
      id: randomUUID(),
      workspaceId,
      externalId,
      displayName: null,
    };
    agents.push(created);
    return created;
  }

  return {
    agents,
    rows,

    seedAgent(agent: SeedAgent): StoredAgent {
      const resolved = resolveAgent(agent.workspaceId, agent.externalId);
      if (agent.displayName !== undefined) {
        resolved.displayName = agent.displayName;
      }
      return resolved;
    },

    seedEvent(event: SeedEvent): StoredEvent {
      const agent = resolveAgent(event.workspaceId, event.agentExternalId);
      const stored: StoredEvent = {
        workspaceId: event.workspaceId,
        id: randomUUID(),
        eventId: event.eventId,
        type: event.type,
        category: event.category ?? null,
        occurredAt: event.occurredAt ?? null,
        receivedAt: event.receivedAt,
        precheckReceiptId: event.precheckReceiptId ?? null,
        agent: { id: agent.id, externalId: agent.externalId, displayName: agent.displayName },
        block:
          event.block === undefined
            ? null
            : {
                id: randomUUID(),
                externalBlockId: event.block.externalBlockId,
                source: event.block.source,
              },
        payload: event.payload ?? {
          event_id: event.eventId,
          agent_id: event.agentExternalId,
          type: event.type,
        },
      };
      rows.push(stored);
      return stored;
    },

    listTimeline(
      scope: WorkspaceScope,
      options: TimelineQueryOptions,
    ): Promise<TimelinePage> {
      const workspaceId = scope.workspaceId;

      let agentId: string | undefined;
      if (options.agentExternalId !== undefined) {
        // Resolved inside the authorized workspace only.
        const agent = agents.find(
          (a) => a.workspaceId === workspaceId && a.externalId === options.agentExternalId,
        );
        if (agent === undefined) {
          return Promise.resolve({ events: [], nextCursor: null });
        }
        agentId = agent.id;
      }

      const ordered = rows
        .filter((row) => row.workspaceId === workspaceId)
        .filter((row) => agentId === undefined || row.agent.id === agentId)
        .filter((row) => {
          if (options.cursor === undefined) return true;
          // The same (received_at, id) row-value boundary as production.
          const at = row.receivedAt.getTime();
          const boundary = options.cursor.receivedAt.getTime();
          if (at !== boundary) return at < boundary;
          return row.id < options.cursor.id;
        })
        .sort((a, b) => {
          const delta = b.receivedAt.getTime() - a.receivedAt.getTime();
          if (delta !== 0) return delta;
          return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
        });

      // limit+1 probe, exactly as production does.
      const window = ordered.slice(0, options.limit + 1);
      const hasMore = window.length > options.limit;
      const events = hasMore ? window.slice(0, options.limit) : window;
      const last = events.at(-1);

      return Promise.resolve({
        events,
        nextCursor:
          hasMore && last !== undefined ? { receivedAt: last.receivedAt, id: last.id } : null,
      });
    },

    findDetail(
      scope: WorkspaceScope,
      eventId: string,
    ): Promise<EventDetailRow | null> {
      const workspaceId = scope.workspaceId;
      // Scoped: another tenant's uuid resolves to null, not to their row.
      const row = rows.find((r) => r.workspaceId === workspaceId && r.id === eventId);
      return Promise.resolve(row ?? null);
    },
  };
}
