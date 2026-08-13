import type { AgentSummary, EventDetail, EventSummary } from '@hybrid/contracts';
import { useCallback, useEffect, useState, type JSX } from 'react';

import { fetchEventDetail, fetchTimeline, listAgents } from './api';

/**
 * Workspace event timeline (AC-05) with raw JSON drill-through (AC-06).
 *
 * READ-ONLY. There is no dismiss, edit, delete, retry or replay control, and no
 * export button. The event stream is an append-only audit record; AC-16 (CSV
 * export) and AC-17 (rollups) are deferred.
 *
 * FILTERING IS SERVER-SIDE. Selecting an agent re-queries with `agent_id`
 * rather than filtering the loaded page in memory - otherwise "Agent A" would
 * show only the subset of A's events that happened to fall in the first page.
 *
 * RECEIVED, NOT OCCURRED. `receivedAt` is shown as the event's time because it
 * is server-assigned and authoritative. The client-reported `occurredAt` is
 * secondary metadata, labelled as such.
 */

interface TimelineProps {
  readonly workspaceId: string;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'ready' }
  | { status: 'error'; message: string };

/** Timestamp rendered in full, with the raw ISO value on hover. */
function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

/** Human label for a machine event type. */
function describeType(type: EventSummary['type']): string {
  switch (type) {
    case 'agent.action':
      return 'Action';
    case 'spend.recorded':
      return 'Spend';
    case 'action.blocked':
      return 'Blocked';
    case 'heartbeat':
      return 'Heartbeat';
    default:
      return type;
  }
}

/**
 * Raw validated event JSON (AC-06).
 *
 * Rendered as a React text child, so every character - including
 * `<script>alert(1)</script>` inside a payload string - is escaped and appears
 * as text. There is deliberately no `dangerouslySetInnerHTML` anywhere in this
 * file, and no HTML is constructed from event data.
 */
function RawJson({ raw }: { readonly raw: unknown }): JSX.Element {
  return (
    <pre className="max-h-96 overflow-auto rounded-md border border-slate-800 bg-slate-950 p-3 font-mono text-xs leading-relaxed text-slate-300">
      {JSON.stringify(raw, null, 2)}
    </pre>
  );
}

function EventDetailPanel({
  detail,
  onClose,
}: {
  readonly detail: EventDetail;
  readonly onClose: () => void;
}): JSX.Element {
  return (
    <div className="space-y-3 rounded-md border border-slate-700 bg-slate-900/80 p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <h4 className="text-sm font-medium text-slate-100">{describeType(detail.type)}</h4>
          <p className="truncate font-mono text-xs text-slate-400">{detail.eventId}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 rounded-md border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800"
        >
          Close
        </button>
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
        <dt className="text-slate-500">Agent</dt>
        <dd className="truncate text-slate-300">
          {detail.agent.name ?? detail.agent.agentId}{' '}
          <span className="font-mono text-slate-500">({detail.agent.agentId})</span>
        </dd>

        <dt className="text-slate-500">Received</dt>
        <dd className="text-slate-300" title={detail.receivedAt}>
          {formatTime(detail.receivedAt)} <span className="text-slate-500">(server)</span>
        </dd>

        {detail.occurredAt !== null && (
          <>
            <dt className="text-slate-500">Occurred</dt>
            <dd className="text-slate-400" title={detail.occurredAt}>
              {formatTime(detail.occurredAt)}{' '}
              <span className="text-slate-500">(reported by client)</span>
            </dd>
          </>
        )}

        {detail.category !== null && (
          <>
            <dt className="text-slate-500">Category</dt>
            <dd className="text-slate-300">{detail.category}</dd>
          </>
        )}

        {detail.precheckId !== null && (
          <>
            <dt className="text-slate-500">Precheck</dt>
            <dd className="truncate font-mono text-slate-400">{detail.precheckId}</dd>
          </>
        )}

        {detail.block !== null && (
          <>
            <dt className="text-slate-500">Block</dt>
            <dd className="truncate font-mono text-slate-400">
              {detail.block.externalBlockId ?? detail.block.id}{' '}
              <span className="text-slate-500">({detail.block.source})</span>
            </dd>
          </>
        )}
      </dl>

      <div className="space-y-1">
        <p className="text-xs text-slate-500">
          Raw event as validated and stored. This is the event object, not the HTTP request.
        </p>
        <RawJson raw={detail.raw} />
      </div>
    </div>
  );
}

/**
 * The paged result for ONE (workspace, filter) combination.
 *
 * Split out and given a `key` derived from both, so changing the filter
 * REMOUNTS it with fresh state. That is what discards the previous cursor: a
 * cursor taken under "all agents" is a boundary in a different result set, and
 * replaying it against a filtered query would start the page in an arbitrary
 * place. Remounting also clears the open detail panel and any stale error.
 *
 * Doing the same reset with `setState` inside an effect would work but causes a
 * cascading render, and React's own guidance is to reset state with a key.
 */
function TimelineResults({
  workspaceId,
  agentFilter,
}: {
  readonly workspaceId: string;
  readonly agentFilter: string;
}): JSX.Element {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [events, setEvents] = useState<EventSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selected, setSelected] = useState<EventDetail | null>(null);
  const [detailError, setDetailError] = useState('');

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const page = await fetchTimeline(workspaceId, { agentId: agentFilter });
        if (!cancelled) {
          setEvents(page.events);
          setNextCursor(page.nextCursor);
          setState({ status: 'ready' });
        }
      } catch (error: unknown) {
        if (!cancelled) {
          setState({
            status: 'error',
            message: error instanceof Error ? error.message : 'Something went wrong.',
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [workspaceId, agentFilter]);

  const loadMore = useCallback(async (): Promise<void> => {
    if (nextCursor === null) {
      return;
    }
    setLoadingMore(true);
    try {
      const page = await fetchTimeline(workspaceId, {
        agentId: agentFilter,
        cursor: nextCursor,
      });
      setEvents((current) => [...current, ...page.events]);
      setNextCursor(page.nextCursor);
    } catch (error: unknown) {
      setState({
        status: 'error',
        message: error instanceof Error ? error.message : 'Something went wrong.',
      });
    } finally {
      setLoadingMore(false);
    }
  }, [workspaceId, agentFilter, nextCursor]);

  const openDetail = useCallback(
    async (eventId: string): Promise<void> => {
      setDetailError('');
      try {
        setSelected(await fetchEventDetail(workspaceId, eventId));
      } catch (error: unknown) {
        setSelected(null);
        setDetailError(error instanceof Error ? error.message : 'Something went wrong.');
      }
    },
    [workspaceId],
  );

  return (
    <div className="space-y-4">
      {state.status === 'loading' && <p className="text-sm text-slate-400">Loading events…</p>}

      {state.status === 'error' && (
        <p role="alert" className="text-sm text-red-400">
          {state.message}
        </p>
      )}

      {state.status === 'ready' && events.length === 0 && (
        <p className="text-sm text-slate-500">
          {agentFilter === '' ? 'No events yet.' : 'No events for this agent.'}
        </p>
      )}

      {state.status === 'ready' && events.length > 0 && (
        <ul className="divide-y divide-slate-800 rounded-md border border-slate-800">
          {events.map((event) => (
            <li key={event.id}>
              <button
                type="button"
                onClick={() => {
                  void openDetail(event.id);
                }}
                className="flex w-full items-center justify-between gap-4 px-4 py-3 text-left hover:bg-slate-900"
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm text-slate-100">
                    {describeType(event.type)}
                    {event.category !== null && (
                      <span className="ml-2 text-xs text-slate-400">{event.category}</span>
                    )}
                  </span>
                  <span className="block truncate font-mono text-xs text-slate-500">
                    {event.agent.name ?? event.agent.agentId} · {event.eventId}
                  </span>
                </span>
                <span className="shrink-0 text-xs text-slate-400" title={event.receivedAt}>
                  {formatTime(event.receivedAt)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {detailError !== '' && (
        <p role="alert" className="text-sm text-red-400">
          {detailError}
        </p>
      )}

      {selected !== null && (
        <EventDetailPanel
          detail={selected}
          onClose={() => {
            setSelected(null);
          }}
        />
      )}

      {state.status === 'ready' && nextCursor !== null && (
        <button
          type="button"
          disabled={loadingMore}
          onClick={() => {
            void loadMore();
          }}
          className="rounded-md border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:bg-slate-800 disabled:opacity-60"
        >
          {loadingMore ? 'Loading…' : 'Load more'}
        </button>
      )}
    </div>
  );
}

export function Timeline({ workspaceId }: TimelineProps): JSX.Element {
  const [agentFilter, setAgentFilter] = useState('');
  const [agents, setAgents] = useState<AgentSummary[]>([]);

  // The roster only populates the filter control. A failure here must not take
  // the timeline down with it, so it is deliberately not surfaced as an error.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const roster = await listAgents(workspaceId);
        if (!cancelled) {
          setAgents(roster);
        }
      } catch {
        if (!cancelled) {
          setAgents([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h3 className="text-base font-medium">Events</h3>
          <p className="max-w-prose text-sm text-slate-400">
            Newest first, by the time the control plane received them.
          </p>
        </div>

        <div className="space-y-1">
          <label htmlFor="agent-filter" className="block text-xs text-slate-400">
            Agent
          </label>
          <select
            id="agent-filter"
            value={agentFilter}
            onChange={(event) => {
              setAgentFilter(event.target.value);
            }}
            className="rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-100 outline-none focus:border-slate-500"
          >
            <option value="">All agents</option>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.agentId}>
                {agent.name ?? agent.agentId}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* The key is the pagination reset: a new filter is a new result set. */}
      <TimelineResults
        key={`${workspaceId}:${agentFilter}`}
        workspaceId={workspaceId}
        agentFilter={agentFilter}
      />
    </div>
  );
}
