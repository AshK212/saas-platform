import type { AgentGovernance, AgentSummary } from '@hybrid/contracts';
import { useEffect, useState, type JSX } from 'react';

import { AgentPolicy } from './AgentPolicy';
import { listAgents } from './api';
import {
  MODE_DESCRIPTION,
  MODE_LABEL,
  capsApply,
  describePublishes,
  describeSpend,
} from './governance-format';

/**
 * Workspace agent roster (AC-04) with fleet enforcement state (AC-07).
 *
 * READ-ONLY. Agents register themselves with an API key; the browser never
 * creates or modifies one, and there is no rename or delete control here.
 *
 * ENFORCEMENT STATE IS SERVER-COMPUTED. Mode, caps and today's committed usage
 * all arrive on the roster response, already resolved against effective policy
 * and the authoritative daily ledger for the SERVER's UTC accounting day. This
 * component formats them and nothing else - it does not sum events, does not
 * compare a total to a cap, and does not decide what "today" means. A browser
 * in UTC+13 must see the same day boundary the plane enforces against.
 *
 * WORDING IS FACTUAL. A cap being configured is not a guarantee that anything
 * was stopped; nothing here says "protected" or "safe" on the strength of a
 * number being set.
 *
 * Still deliberately absent: gone-dark and stale-agent alerting (AC-14).
 */

interface AgentsProps {
  readonly workspaceId: string;
  /** False for `member`: policy is readable but the controls are disabled. */
  readonly canManagePolicy: boolean;
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

/** Mode pill. Paused is the only state given emphasis, because it stops work. */
function ModeBadge({ mode }: { readonly mode: AgentGovernance['mode'] }): JSX.Element {
  const tone =
    mode === 'paused'
      ? 'bg-amber-950 text-amber-300'
      : mode === 'budgeted'
        ? 'bg-sky-950 text-sky-300'
        : 'bg-slate-800 text-slate-300';

  return (
    <span
      className={`rounded px-1.5 py-0.5 text-xs font-medium ${tone}`}
      title={MODE_DESCRIPTION[mode]}
    >
      {MODE_LABEL[mode]}
    </span>
  );
}

/**
 * One agent's current enforcement state.
 *
 * Caps are shown only under `budgeted`. A leftover cap under `watch` is not
 * applied to anything, and printing `$0.00 / $25.00` beside a watching agent
 * would read as a budget being enforced when it is not.
 *
 * The accounting day is labelled UTC so a total that looks "wrong" late in the
 * evening is explicable rather than alarming.
 */
function GovernanceSummary({
  governance,
}: {
  readonly governance: AgentGovernance;
}): JSX.Element {
  return (
    <div className="space-y-1 rounded-md border border-slate-800 bg-slate-900/40 px-3 py-2 text-xs">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <ModeBadge mode={governance.mode} />
        <span className="text-slate-500">{MODE_DESCRIPTION[governance.mode]}</span>
      </div>

      {capsApply(governance.mode) && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 pt-1">
          <dt className="text-slate-500">Today&rsquo;s spend</dt>
          <dd className="font-mono text-slate-300">{describeSpend(governance)}</dd>
          <dt className="text-slate-500">Publishes today</dt>
          <dd className="font-mono text-slate-300">{describePublishes(governance)}</dd>
        </dl>
      )}

      <p className="pt-0.5 text-slate-600">
        Usage for {governance.accountingDay} (UTC), as recorded by the control plane.
      </p>
    </div>
  );
}

export function Agents({ workspaceId, canManagePolicy }: AgentsProps): JSX.Element {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  /** Captured once per load so every row measures against the same instant. */
  const [loadedAt, setLoadedAt] = useState(() => Date.now());
  /** Which agent's policy editor is open. One at a time keeps the page calm. */
  const [editing, setEditing] = useState<string | null>(null);

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
            <li key={agent.id} className="space-y-3 px-4 py-3">
              <div className="flex items-center justify-between gap-4">
                <span className="min-w-0">
                  <span className="block truncate text-sm text-slate-100">
                    {agent.name ?? agent.agentId}
                  </span>
                  <span className="block font-mono text-xs text-slate-500">{agent.agentId}</span>
                </span>
                <span className="flex shrink-0 items-center gap-3">
                  <span className="text-xs text-slate-400" title={agent.lastSeenAt ?? 'never seen'}>
                    {describeLastSeen(agent.lastSeenAt, loadedAt)}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setEditing((current) => (current === agent.id ? null : agent.id));
                    }}
                    className="rounded-md border border-slate-700 px-3 py-1.5 text-xs text-slate-200 hover:bg-slate-800"
                  >
                    {editing === agent.id ? 'Close' : 'Policy'}
                  </button>
                </span>
              </div>

              {agent.governance !== undefined && (
                <GovernanceSummary governance={agent.governance} />
              )}

              {editing === agent.id && (
                <AgentPolicy
                  key={`policy-${agent.id}`}
                  workspaceId={workspaceId}
                  agentId={agent.id}
                  agentLabel={agent.name ?? agent.agentId}
                  canManage={canManagePolicy}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
