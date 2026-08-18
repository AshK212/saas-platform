import type { AgentSummary, BlockListResponse } from '@hybrid/contracts';
import { useEffect, useState, type JSX } from 'react';

import { fetchBlocks, listAgents } from './api';
import { describeSpend, formatInstant, MODE_LABEL } from './governance-format';
import { Badge, Card, CardHeader, EmptyState, ErrorState, LoadingState, MetricCard } from './ui';

/**
 * The workspace overview.
 *
 * ─── EVERY NUMBER HERE IS A COUNT, NOT AN AGGREGATE ───────────────────────
 *
 * There is deliberately no "total spend today" tile, and its absence is the
 * most considered decision on this screen.
 *
 * Committed spend is an exact decimal string per agent, held in micro-dollars
 * by the ledger. Summing several of them in the browser would mean parsing
 * money into a float - the one thing the frontend is forbidden to do, because
 * a float total can disagree with the exact comparison the precheck actually
 * made. The API exposes no workspace-level total, so an honest one cannot be
 * shown, and an approximate one would be worse than none: it would appear in a
 * screenshot next to a receipt that contradicted it.
 *
 * What IS shown are counts of things - agents, paused agents, recent blocks -
 * which are exact by construction, and per-agent spend rendered by the same
 * server-formatted string the fleet view uses.
 */

const RECENT_BLOCK_LIMIT = 5;

type State =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; agents: AgentSummary[]; blocks: BlockListResponse['blocks'] };

export function Overview({
  workspaceId,
  onNavigateFleet,
  onNavigateReceipts,
}: {
  workspaceId: string;
  onNavigateFleet: () => void;
  onNavigateReceipts: () => void;
}): JSX.Element {
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        // Sequential rather than concurrent: two reads on one connection are
        // cheap, and ordering keeps the failure attributable to one call.
        const agents = await listAgents(workspaceId);
        const blocks = await fetchBlocks(workspaceId);
        if (!cancelled) {
          setState({ status: 'ready', agents, blocks: blocks.blocks.slice(0, RECENT_BLOCK_LIMIT) });
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
  }, [workspaceId]);

  if (state.status === 'loading') {
    return (
      <Card>
        <LoadingState label="Loading workspace…" />
      </Card>
    );
  }

  if (state.status === 'error') {
    return (
      <Card>
        <ErrorState message={state.message} />
      </Card>
    );
  }

  const { agents, blocks } = state;
  const paused = agents.filter((agent) => agent.governance?.mode === 'paused');
  const budgeted = agents.filter((agent) => agent.governance?.mode === 'budgeted');

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Agents"
          value={String(agents.length)}
          hint={agents.length === 1 ? 'registered runtime' : 'registered runtimes'}
        />
        <MetricCard
          label="Budgeted"
          value={String(budgeted.length)}
          hint="enforcing daily caps"
        />
        <MetricCard
          label="Paused"
          value={String(paused.length)}
          tone={paused.length > 0 ? 'deny' : 'neutral'}
          hint={paused.length > 0 ? 'denying every action' : 'none halted'}
        />
        <MetricCard
          label="Recent blocks"
          value={blocks.length >= RECENT_BLOCK_LIMIT ? `${String(RECENT_BLOCK_LIMIT)}+` : String(blocks.length)}
          tone={blocks.length > 0 ? 'deny' : 'neutral'}
          hint="most recent refusals"
        />
      </div>

      {paused.length > 0 && (
        <div role="status" className="rounded-card border border-line-strong bg-warn-soft px-4 py-3">
          <p className="text-sm font-medium text-ink">
            {paused.length === 1 ? '1 agent is paused' : `${String(paused.length)} agents are paused`}
          </p>
          <p className="mt-0.5 text-sm text-ink-muted">
            A paused agent is refused every action it asks the control plane to approve.
          </p>
        </div>
      )}

      <Card>
        <CardHeader
          title="Fleet"
          description="Enforcement state as the control plane currently records it."
        />
        {agents.length === 0 ? (
          <EmptyState
            title="No agents yet"
            description="A runtime appears here the first time it registers with a workspace API key."
          />
        ) : (
          <ul className="divide-y divide-line">
            {agents.slice(0, 6).map((agent) => (
              <li key={agent.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-ink">
                    {agent.name ?? agent.agentId}
                  </span>
                  <span className="block truncate font-mono text-xs text-ink-faint">
                    {agent.agentId}
                  </span>
                </span>
                {agent.governance !== undefined && agent.governance !== null && (
                  <>
                    <Badge tone={agent.governance.mode === 'paused' ? 'deny' : 'neutral'}>
                      {MODE_LABEL[agent.governance.mode]}
                    </Badge>
                    {agent.governance.mode === 'budgeted' && (
                      <span className="tnum text-xs text-ink-muted">
                        {describeSpend(agent.governance)}
                      </span>
                    )}
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
        {agents.length > 6 && (
          <div className="border-t border-line px-5 py-3">
            <button
              type="button"
              onClick={onNavigateFleet}
              className="text-sm font-medium text-accent hover:underline"
            >
              View all {agents.length} agents
            </button>
          </div>
        )}
      </Card>

      <Card>
        <CardHeader
          title="Recent blocks"
          description="Actions the control plane refused, newest first."
        />
        {blocks.length === 0 ? (
          <EmptyState
            title="No blocks recorded"
            description="Refusals appear here when an action exceeds a cap or an agent is paused."
          />
        ) : (
          <ul className="divide-y divide-line">
            {blocks.map((block) => (
              <li key={block.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-5 py-3">
                <Badge tone="deny">Blocked</Badge>
                <span className="min-w-0 flex-1 truncate text-sm text-ink">{block.reason}</span>
                <span className="text-xs text-ink-faint">{formatInstant(block.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="border-t border-line px-5 py-3">
          <button
            type="button"
            onClick={onNavigateReceipts}
            className="text-sm font-medium text-accent hover:underline"
          >
            View receipts and blocks
          </button>
        </div>
      </Card>
    </div>
  );
}
