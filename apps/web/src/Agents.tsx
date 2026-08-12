import type { AgentSummary } from '@hybrid/contracts';
import { useEffect, useState, type JSX } from 'react';

import { listAgents } from './api';

/**
 * Workspace agent roster (AC-04).
 *
 * READ-ONLY. Agents register themselves with an API key; the browser never
 * creates or modifies one, and there is no rename or delete control here.
 *
 * Deliberately absent: mode, caps, pause state, spend, and any gone-dark or
 * stale-agent alerting. Policy belongs to a later step, and gone-dark is the
 * deferred AC-14.
 */

interface AgentsProps {
  readonly workspaceId: string;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; agents: AgentSummary[] }
  | { status: 'error'; message: string };

/**
 * Renders a last-seen timestamp with honest precision.
 *
 * Coarse buckets rather than a live-updating counter: the value is only as
 * fresh as the last fetch, so second-by-second precision would imply a
 * currency the page does not have. The exact timestamp is available on hover.
 */
function describeLastSeen(iso: string | null, now: number): string {
  if (iso === null) {
    return 'never';
  }

  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1_000));
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${String(seconds)} seconds ago`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)} minute${minutes === 1 ? '' : 's'} ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)} hour${hours === 1 ? '' : 's'} ago`;

  const days = Math.floor(hours / 24);
  return `${String(days)} day${days === 1 ? '' : 's'} ago`;
}

export function Agents({ workspaceId }: AgentsProps): JSX.Element {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  /** Captured once per load so every row measures against the same instant. */
  const [loadedAt, setLoadedAt] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const agents = await listAgents(workspaceId);
        if (!cancelled) {
          setLoadedAt(Date.now());
          setState({ status: 'ready', agents });
        }
      } catch (caught: unknown) {
        if (!cancelled) {
          setState({
            status: 'error',
            message: caught instanceof Error ? caught.message : 'Something went wrong.',
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h3 className="text-base font-medium">Agents</h3>
        <p className="max-w-prose text-sm text-slate-400">
          Agents register themselves using a workspace API key. Last seen is recorded by the
          server.
        </p>
      </div>

      {state.status === 'loading' && <p className="text-sm text-slate-400">Loading agents…</p>}

      {state.status === 'error' && (
        <p role="alert" className="text-sm text-red-400">
          {state.message}
        </p>
      )}

      {state.status === 'ready' && state.agents.length === 0 && (
        <p className="text-sm text-slate-500">No agents connected yet.</p>
      )}

      {state.status === 'ready' && state.agents.length > 0 && (
        <ul className="divide-y divide-slate-800 rounded-md border border-slate-800">
          {state.agents.map((agent) => (
            <li key={agent.id} className="flex items-center justify-between gap-4 px-4 py-3">
              <span className="min-w-0">
                <span className="block truncate text-sm text-slate-100">
                  {agent.name ?? agent.agentId}
                </span>
                <span className="block font-mono text-xs text-slate-500">{agent.agentId}</span>
              </span>
              <span
                className="shrink-0 text-xs text-slate-400"
                title={agent.lastSeenAt ?? 'never seen'}
              >
                {describeLastSeen(agent.lastSeenAt, loadedAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
