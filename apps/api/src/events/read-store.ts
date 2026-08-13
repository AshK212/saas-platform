import {
  createAgentRepository,
  createEventRepository,
  type AuthorizedWorkspace,
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
 * SCOPE, NOT A WORKSPACE ID
 * -------------------------
 * Every method takes an `AuthorizedWorkspace` - the product of a proven
 * membership - and never a workspace id. There is no method that could be
 * called without one.
 *
 * The underlying repository takes a `WorkspaceScope`, which is the seam that
 * will later let AC-18 share links and AC-19 demo read the same data through a
 * different trusted resolution. Neither is implemented, and no route here
 * accepts anything but a browser session.
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
    authorized: AuthorizedWorkspace,
    options: TimelineQueryOptions,
  ): Promise<TimelinePage>;

  /** One event by INTERNAL uuid. Null when it is not in this workspace. */
  findDetail(authorized: AuthorizedWorkspace, eventId: string): Promise<EventDetailRow | null>;
}

export function createDrizzleEventReadStore(db: DatabaseClient): EventReadStore {
  return {
    async listTimeline(
      authorized: AuthorizedWorkspace,
      options: TimelineQueryOptions,
    ): Promise<TimelinePage> {
      const scope = authorized.scope;

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
      authorized: AuthorizedWorkspace,
      eventId: string,
    ): Promise<EventDetailRow | null> {
      return createEventRepository(db, authorized.scope).findDetailById(eventId);
    },
  };
}
