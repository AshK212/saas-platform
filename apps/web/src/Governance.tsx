import type {
  AgentSummary,
  BlockDetail,
  BlockSummary,
  ReceiptDetail,
  ReceiptSummary,
} from '@hybrid/contracts';
import { useCallback, useEffect, useState, type JSX, type ReactNode } from 'react';

import { fetchBlock, fetchBlocks, fetchReceipt, fetchReceipts, listAgents } from './api';
import {
  MODE_LABEL,
  REASON_LABEL,
  describeBlockOwner,
  describeRule,
  formatInstant,
  formatUsd,
} from './governance-format';

/**
 * Governance audit: decisions (AC-07) and blocks (AC-10).
 *
 * READ-ONLY, WITH NO EXCEPTION. There is no acknowledge, dismiss, override,
 * retry, delete or export control anywhere in this file. A receipt is what the
 * plane decided and a block is what it refused; both are historical evidence,
 * and a UI affordance that appeared to change one would misrepresent the
 * record even if the server refused the write.
 *
 * NOTHING IS RECOMPUTED HERE. Every value shown on a receipt was persisted at
 * decision time - the mode, the caps, the ledger reading, the headroom. The
 * browser never re-evaluates a past decision against current policy, so an
 * operator who raised a cap this morning still sees exactly why yesterday's
 * action was denied.
 *
 * FILTERING IS SERVER-SIDE, as in the timeline: filtering a loaded page in
 * memory would show only the subset of matches that happened to fall in the
 * first page and read as a complete answer.
 *
 * NO `dangerouslySetInnerHTML`. Every value - including a runtime-authored
 * `rule` and `reason`, which are free text from a plugin we do not control - is
 * rendered as a React text child and therefore escaped.
 */

interface GovernanceProps {
  readonly workspaceId: string;
}

type LoadState = { status: 'loading' } | { status: 'ready' } | { status: 'error'; message: string };

/** `allow` / `deny`, coloured but never editorialised. */
function DecisionBadge({ decision }: { readonly decision: 'allow' | 'deny' }): JSX.Element {
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-xs font-medium ${
        decision === 'allow' ? 'bg-slate-800 text-slate-300' : 'bg-red-950 text-red-300'
      }`}
    >
      {decision === 'allow' ? 'Allowed' : 'Denied'}
    </span>
  );
}

/** Who owns a block. Read from persisted `source`, never inferred. */
function SourceBadge({ source }: { readonly source: 'plane' | 'runtime' }): JSX.Element {
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-xs font-medium ${
        source === 'plane' ? 'bg-sky-950 text-sky-300' : 'bg-slate-800 text-slate-300'
      }`}
    >
      {source === 'plane' ? 'Control plane' : 'Runtime'}
    </span>
  );
}

function Field({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <>
      <dt className="text-slate-500">{label}</dt>
      <dd className="min-w-0 break-words text-slate-300">{children}</dd>
    </>
  );
}

/**
 * Full decision evidence.
 *
 * The "policy applied" block is labelled AT DECISION TIME on purpose. Without
 * that wording an operator reading a denial after changing policy would
 * reasonably assume the caps shown are the ones in force now.
 */
function ReceiptDetailPanel({
  detail,
  onClose,
}: {
  readonly detail: ReceiptDetail;
  readonly onClose: () => void;
}): JSX.Element {
  return (
    <div className="space-y-4 rounded-md border border-slate-700 bg-slate-900/80 p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <h4 className="flex items-center gap-2 text-sm font-medium text-slate-100">
            <DecisionBadge decision={detail.decision} />
            {detail.category}
          </h4>
          <p className="truncate font-mono text-xs text-slate-400">{detail.id}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 rounded-md border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800"
        >
          Close
        </button>
      </div>

      {detail.reason !== null && (
        <p className="rounded-md border border-red-900/60 bg-red-950/30 px-3 py-2 text-sm text-red-200">
          {REASON_LABEL[detail.reason]}
        </p>
      )}

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
        <Field label="Agent">
          {detail.agent.name ?? detail.agent.agentId}{' '}
          <span className="font-mono text-slate-500">({detail.agent.agentId})</span>
        </Field>
        <Field label="Action">
          <span className="font-mono">{detail.actionId}</span>
        </Field>
        <Field label="Decided">
          <span title={detail.createdAt}>{formatInstant(detail.createdAt)}</span>
        </Field>
        <Field label="Accounting day">
          {detail.accountingDay} <span className="text-slate-500">(UTC)</span>
        </Field>
      </dl>

      <div className="space-y-1">
        <h5 className="text-xs font-medium text-slate-300">Policy applied at decision time</h5>
        <p className="text-xs text-slate-500">
          Recorded when the decision was made. Current policy may differ.
        </p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 pt-1 text-xs">
          <Field label="Mode">{MODE_LABEL[detail.appliedMode]}</Field>
          <Field label="Policy version">
            <span className="font-mono">{detail.policyVersion}</span>
          </Field>
          <Field label="Spend cap">
            {detail.appliedSpendCapUsd === null
              ? 'Uncapped'
              : formatUsd(detail.appliedSpendCapUsd)}
          </Field>
          <Field label="Publish cap">
            {detail.appliedPublishCap === null ? 'Uncapped' : String(detail.appliedPublishCap)}
          </Field>
        </dl>
      </div>

      <div className="space-y-1">
        <h5 className="text-xs font-medium text-slate-300">Request and ledger</h5>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 pt-1 text-xs">
          {detail.requestedAmountUsd !== null && (
            <Field label="Requested">{formatUsd(detail.requestedAmountUsd)}</Field>
          )}
          {detail.requestedPublishCount !== null && (
            <Field label="Requested">
              {String(detail.requestedPublishCount)} publish
              {detail.requestedPublishCount === 1 ? '' : 'es'}
            </Field>
          )}
          {detail.ledgerSpendBeforeUsd !== null && (
            <Field label="Spend before">{formatUsd(detail.ledgerSpendBeforeUsd)}</Field>
          )}
          {detail.ledgerPublishBefore !== null && (
            <Field label="Publishes before">{String(detail.ledgerPublishBefore)}</Field>
          )}
          {detail.remainingSpendUsd !== null && (
            <Field label="Spend remaining">{formatUsd(detail.remainingSpendUsd)}</Field>
          )}
          {detail.remainingPublishCount !== null && (
            <Field label="Publishes remaining">{String(detail.remainingPublishCount)}</Field>
          )}
          {detail.requestedAmountUsd === null &&
            detail.requestedPublishCount === null &&
            detail.ledgerSpendBeforeUsd === null &&
            detail.ledgerPublishBefore === null && (
              <Field label="Ledger">
                <span className="text-slate-500">
                  No daily ledger applied to this decision.
                </span>
              </Field>
            )}
        </dl>
      </div>

      {detail.block !== null && (
        <p className="text-xs text-slate-400">
          Recorded a block under <span className="text-slate-300">{describeRule(detail.block.rule)}</span>{' '}
          <span className="font-mono text-slate-500">({detail.block.id})</span>
        </p>
      )}
    </div>
  );
}

/**
 * Full block evidence.
 *
 * A runtime block carries no receipt, and that absence is stated rather than
 * papered over: fabricating a decision record for a refusal the plane never
 * made would be a lie about who enforced what.
 */
function BlockDetailPanel({
  detail,
  onClose,
}: {
  readonly detail: BlockDetail;
  readonly onClose: () => void;
}): JSX.Element {
  return (
    <div className="space-y-4 rounded-md border border-slate-700 bg-slate-900/80 p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <h4 className="flex items-center gap-2 text-sm font-medium text-slate-100">
            <SourceBadge source={detail.source} />
            {describeRule(detail.rule)}
          </h4>
          <p className="truncate font-mono text-xs text-slate-400">{detail.id}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 rounded-md border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800"
        >
          Close
        </button>
      </div>

      <p className="text-sm text-slate-200">{detail.reason}</p>

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
        <Field label="Owner">{describeBlockOwner(detail.source)}</Field>
        <Field label="Agent">
          {detail.agent.name ?? detail.agent.agentId}{' '}
          <span className="font-mono text-slate-500">({detail.agent.agentId})</span>
        </Field>
        <Field label="Category">{detail.category}</Field>
        <Field label="Recorded">
          <span title={detail.createdAt}>{formatInstant(detail.createdAt)}</span>
        </Field>

        {detail.amountUsd !== null && (
          <Field label="Amount refused">{formatUsd(detail.amountUsd)}</Field>
        )}
        {detail.count !== null && <Field label="Count refused">{String(detail.count)}</Field>}
        {detail.externalBlockId !== null && (
          <Field label="Client block id">
            <span className="font-mono">{detail.externalBlockId}</span>
          </Field>
        )}

        <Field label="Decision">
          {detail.precheckId === null ? (
            <span className="text-slate-500">
              Reported by the runtime. The control plane made no decision for this block.
            </span>
          ) : (
            <span className="font-mono">{detail.precheckId}</span>
          )}
        </Field>
      </dl>
    </div>
  );
}

/**
 * One page of receipts for ONE (workspace, agent, decision) combination.
 *
 * Keyed on all three by the parent so a filter change REMOUNTS it, discarding
 * the cursor. A cursor is a boundary in the result set it came from; replaying
 * it against a different filter would start the page in an arbitrary place.
 */
function ReceiptResults({
  workspaceId,
  agentFilter,
  decisionFilter,
}: {
  readonly workspaceId: string;
  readonly agentFilter: string;
  readonly decisionFilter: '' | 'allow' | 'deny';
}): JSX.Element {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [receipts, setReceipts] = useState<ReceiptSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selected, setSelected] = useState<ReceiptDetail | null>(null);
  const [detailError, setDetailError] = useState('');

  const query = {
    ...(agentFilter === '' ? {} : { agentId: agentFilter }),
    ...(decisionFilter === '' ? {} : { decision: decisionFilter }),
  };

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const page = await fetchReceipts(workspaceId, query);
        if (!cancelled) {
          setReceipts(page.receipts);
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
    // The filters are the mount key, so this runs once per result set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, agentFilter, decisionFilter]);

  const loadMore = useCallback(async (): Promise<void> => {
    if (nextCursor === null) {
      return;
    }
    setLoadingMore(true);
    try {
      const page = await fetchReceipts(workspaceId, { ...query, cursor: nextCursor });
      setReceipts((current) => [...current, ...page.receipts]);
      setNextCursor(page.nextCursor);
    } catch (error: unknown) {
      setState({
        status: 'error',
        message: error instanceof Error ? error.message : 'Something went wrong.',
      });
    } finally {
      setLoadingMore(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, agentFilter, decisionFilter, nextCursor]);

  const openDetail = useCallback(
    async (receiptId: string): Promise<void> => {
      setDetailError('');
      const detail = await fetchReceipt(workspaceId, receiptId);
      if (detail === null) {
        setSelected(null);
        setDetailError('Could not load that decision.');
        return;
      }
      setSelected(detail);
    },
    [workspaceId],
  );

  return (
    <div className="space-y-4">
      {state.status === 'loading' && <p className="text-sm text-slate-400">Loading decisions…</p>}

      {state.status === 'error' && (
        <p role="alert" className="text-sm text-red-400">
          {state.message}
        </p>
      )}

      {state.status === 'ready' && receipts.length === 0 && (
        <p className="text-sm text-slate-500">No decisions recorded yet.</p>
      )}

      {state.status === 'ready' && receipts.length > 0 && (
        <ul className="divide-y divide-slate-800 rounded-md border border-slate-800">
          {receipts.map((receipt) => (
            <li key={receipt.id}>
              <button
                type="button"
                onClick={() => {
                  void openDetail(receipt.id);
                }}
                className="flex w-full items-center justify-between gap-4 px-4 py-3 text-left hover:bg-slate-900"
              >
                <span className="min-w-0">
                  <span className="flex items-center gap-2 text-sm text-slate-100">
                    <DecisionBadge decision={receipt.decision} />
                    <span className="truncate">{receipt.category}</span>
                    {receipt.reason !== null && (
                      <span className="truncate text-xs text-red-300">
                        {REASON_LABEL[receipt.reason]}
                      </span>
                    )}
                  </span>
                  <span className="block truncate font-mono text-xs text-slate-500">
                    {receipt.agent.name ?? receipt.agent.agentId} · {receipt.actionId}
                  </span>
                </span>
                <span className="shrink-0 text-xs text-slate-400" title={receipt.createdAt}>
                  {formatInstant(receipt.createdAt)}
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
        <ReceiptDetailPanel
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

/** One page of blocks. Same remount-on-filter discipline as the receipts list. */
function BlockResults({
  workspaceId,
  agentFilter,
  sourceFilter,
}: {
  readonly workspaceId: string;
  readonly agentFilter: string;
  readonly sourceFilter: '' | 'plane' | 'runtime';
}): JSX.Element {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [blocks, setBlocks] = useState<BlockSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selected, setSelected] = useState<BlockDetail | null>(null);
  const [detailError, setDetailError] = useState('');

  const query = {
    ...(agentFilter === '' ? {} : { agentId: agentFilter }),
    ...(sourceFilter === '' ? {} : { source: sourceFilter }),
  };

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const page = await fetchBlocks(workspaceId, query);
        if (!cancelled) {
          setBlocks(page.blocks);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, agentFilter, sourceFilter]);

  const loadMore = useCallback(async (): Promise<void> => {
    if (nextCursor === null) {
      return;
    }
    setLoadingMore(true);
    try {
      const page = await fetchBlocks(workspaceId, { ...query, cursor: nextCursor });
      setBlocks((current) => [...current, ...page.blocks]);
      setNextCursor(page.nextCursor);
    } catch (error: unknown) {
      setState({
        status: 'error',
        message: error instanceof Error ? error.message : 'Something went wrong.',
      });
    } finally {
      setLoadingMore(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, agentFilter, sourceFilter, nextCursor]);

  const openDetail = useCallback(
    async (blockId: string): Promise<void> => {
      setDetailError('');
      const detail = await fetchBlock(workspaceId, blockId);
      if (detail === null) {
        setSelected(null);
        setDetailError('Could not load that block.');
        return;
      }
      setSelected(detail);
    },
    [workspaceId],
  );

  return (
    <div className="space-y-4">
      {state.status === 'loading' && <p className="text-sm text-slate-400">Loading blocks…</p>}

      {state.status === 'error' && (
        <p role="alert" className="text-sm text-red-400">
          {state.message}
        </p>
      )}

      {state.status === 'ready' && blocks.length === 0 && (
        <p className="text-sm text-slate-500">No blocks recorded yet.</p>
      )}

      {state.status === 'ready' && blocks.length > 0 && (
        <ul className="divide-y divide-slate-800 rounded-md border border-slate-800">
          {blocks.map((block) => (
            <li key={block.id}>
              <button
                type="button"
                onClick={() => {
                  void openDetail(block.id);
                }}
                className="flex w-full items-center justify-between gap-4 px-4 py-3 text-left hover:bg-slate-900"
              >
                <span className="min-w-0">
                  <span className="flex items-center gap-2 text-sm text-slate-100">
                    <SourceBadge source={block.source} />
                    <span className="truncate">{describeRule(block.rule)}</span>
                  </span>
                  <span className="block truncate font-mono text-xs text-slate-500">
                    {block.agent.name ?? block.agent.agentId} · {block.category}
                  </span>
                </span>
                <span className="shrink-0 text-xs text-slate-400" title={block.createdAt}>
                  {formatInstant(block.createdAt)}
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
        <BlockDetailPanel
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

export function Governance({ workspaceId }: GovernanceProps): JSX.Element {
  const [view, setView] = useState<'receipts' | 'blocks'>('receipts');
  const [agentFilter, setAgentFilter] = useState('');
  const [decisionFilter, setDecisionFilter] = useState<'' | 'allow' | 'deny'>('');
  const [sourceFilter, setSourceFilter] = useState<'' | 'plane' | 'runtime'>('');
  const [agents, setAgents] = useState<AgentSummary[]>([]);

  // The roster only populates the filter control; a failure must not take the
  // audit view down with it.
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
      <div className="space-y-1">
        <h3 className="text-base font-medium">Governance</h3>
        <p className="max-w-prose text-sm text-slate-400">
          Every precheck decision the control plane made, and every block recorded. Newest first.
          Each record shows the policy that applied when it was made.
        </p>
      </div>

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex gap-2" role="tablist" aria-label="Governance records">
          {(['receipts', 'blocks'] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={view === tab}
              onClick={() => {
                setView(tab);
              }}
              className={`rounded-md border px-3 py-1.5 text-sm ${
                view === tab
                  ? 'border-slate-500 bg-slate-800 text-slate-100'
                  : 'border-slate-700 text-slate-300 hover:bg-slate-800'
              }`}
            >
              {tab === 'receipts' ? 'Decisions' : 'Blocks'}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <label htmlFor="governance-agent" className="block text-xs text-slate-400">
              Agent
            </label>
            <select
              id="governance-agent"
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

          {view === 'receipts' ? (
            <div className="space-y-1">
              <label htmlFor="governance-decision" className="block text-xs text-slate-400">
                Decision
              </label>
              <select
                id="governance-decision"
                value={decisionFilter}
                onChange={(event) => {
                  setDecisionFilter(event.target.value as '' | 'allow' | 'deny');
                }}
                className="rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-100 outline-none focus:border-slate-500"
              >
                <option value="">All decisions</option>
                <option value="allow">Allowed</option>
                <option value="deny">Denied</option>
              </select>
            </div>
          ) : (
            <div className="space-y-1">
              <label htmlFor="governance-source" className="block text-xs text-slate-400">
                Recorded by
              </label>
              <select
                id="governance-source"
                value={sourceFilter}
                onChange={(event) => {
                  setSourceFilter(event.target.value as '' | 'plane' | 'runtime');
                }}
                className="rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-100 outline-none focus:border-slate-500"
              >
                <option value="">Anyone</option>
                <option value="plane">Control plane</option>
                <option value="runtime">Runtime</option>
              </select>
            </div>
          )}
        </div>
      </div>

      {/* The key is the pagination reset: a new filter is a new result set. */}
      {view === 'receipts' ? (
        <ReceiptResults
          key={`receipts:${workspaceId}:${agentFilter}:${decisionFilter}`}
          workspaceId={workspaceId}
          agentFilter={agentFilter}
          decisionFilter={decisionFilter}
        />
      ) : (
        <BlockResults
          key={`blocks:${workspaceId}:${agentFilter}:${sourceFilter}`}
          workspaceId={workspaceId}
          agentFilter={agentFilter}
          sourceFilter={sourceFilter}
        />
      )}
    </div>
  );
}
