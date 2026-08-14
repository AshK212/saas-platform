import {
  createAgentRepository,
  createEventRepository,
  type WorkspaceScope,
  type DatabaseClient,
  type EventDetailRow,
  type TimelineCursor,
  type TimelineEventRow,
} from '@hybrid/db';

/**
 * Read-side persistence port for the event timeline (AC-05, AC-06).
 *
 * SEPARATE FROM THE INGEST STORE, DELIBERATELY
 * --------------------------------------------
 * Ingest is machine-authenticated and writes; this is operator-authenticated
 * and only reads. Keeping them apart means the read path has no method that
 * could write, and Step 10's corrected idempotency ordering cannot be disturbed
 * by anything added here.
 *
 * A SCOPE, NOT A WORKSPACE ID - AND NOT AN AUTHORITY EITHER
 * ---------------------------------------------------------
 * Every method takes a `WorkspaceScope`, which can only be produced by a
 * resolver that has already proven a right to it. It never takes a workspace
 * id, so there is no method that could be called without that proof.
 *
 * It deliberately does NOT take the authority itself. Three different
 * resolutions now end in a scope - operator membership, an API credential, and
 * an AC-18 share token - and this module is correct for all three without
 * knowing which one it is serving. Accepting an `AuthorizedWorkspace` here
 * would have forced the share path to manufacture a fake membership, handing a
 * read-only viewer a synthetic role that some later route might trust.
 *
 * WHO may read is settled before this module is reached. WHAT they may read is
 * settled by the scope.
 */

export interface TimelineQueryOptions {
  /** Already bounded against the contract maximum by the route. */
  readonly limit: number;
  /** EXTERNAL agent id as the operator typed it. Resolved inside the scope. */
  readonly agentExternalId?: string | undefined;
  readonly cursor?: TimelineCursor | undefined;
}

export interface TimelinePage {
  readonly events: readonly TimelineEventRow[];
  /** The boundary to resume from, or null on the last page. */
  readonly nextCursor: TimelineCursor | null;
}

export interface EventReadStore {
  listTimeline(
    scope: WorkspaceScope,
    options: TimelineQueryOptions,
  ): Promise<TimelinePage>;

  /** One event by INTERNAL uuid. Null when it is not in this workspace. */
  findDetail(scope: WorkspaceScope, eventId: string): Promise<EventDetailRow | null>;
}

export function createDrizzleEventReadStore(db: DatabaseClient): EventReadStore {
  return {
    async listTimeline(
      scope: WorkspaceScope,
      options: TimelineQueryOptions,
    ): Promise<TimelinePage> {

      let agentId: string | undefined;
      if (options.agentExternalId !== undefined) {
        // Resolved INSIDE the authorized workspace. Workspace A's `agent-1` and
        // workspace B's `agent-1` are different rows, and this lookup can only
        // ever find A's.
        const agent = await createAgentRepository(db, scope).findByExternalId(
          options.agentExternalId,
        );

        if (agent === null) {
          // An external id this workspace does not have yields an empty page -
          // identical to an agent that exists but has no events. Reporting 404
          // would tell the caller whether the id exists somewhere, which is a
          // cross-tenant hint.
          return { events: [], nextCursor: null };
        }
        agentId = agent.id;
      }

      // One extra row is the page-boundary probe: if it comes back there is
      // more to read. Asking for a count instead would be a second scan of the
      // same index for information the client does not need.
      const rows = await createEventRepository(db, scope).listTimeline({
        limit: options.limit + 1,
        agentId,
        cursor: options.cursor,
      });

      const hasMore = rows.length > options.limit;
      const events = hasMore ? rows.slice(0, options.limit) : rows;
      const last = events.at(-1);

      return {
        events,
        nextCursor:
          hasMore && last !== undefined
            ? { receivedAt: last.receivedAt, id: last.id }
            : null,
      };
    },

    async findDetail(
      scope: WorkspaceScope,
      eventId: string,
    ): Promise<EventDetailRow | null> {
      return createEventRepository(db, scope).findDetailById(eventId);
    },
  };
}
