import type {
  BlockSummary,
  EventDetail,
  EventSummary,
  ReceiptSummary,
  ShareAgent,
} from '@hybrid/contracts';
import { useCallback, useEffect, useRef, useState, type JSX } from 'react';

import {
  fetchDemoAgents,
  fetchDemoBlocks,
  fetchDemoEvent,
  fetchDemoEvents,
  fetchDemoReceipts,
  fetchDemoWorkspace,
} from './api';
import {
  MODE_DESCRIPTION,
  MODE_LABEL,
  capsApply,
  describePublishes,
  describeRule,
  describeSpend,
  formatInstant,
} from './governance-format';

/**
 * The public demo page (AC-19).
 *
 * ─── EVERY NUMBER HERE IS REAL ────────────────────────────────────────────
 *
 * There is no fixture, no sample array and no placeholder anywhere in this
 * file. Agents, governance state, events, receipts and blocks all come from
 * the public demo API, which is driven by the SAME read stores the operator
 * dashboard uses.
 *
 * That is the substance of the criterion: "uses the real control-plane read
 * path, not a fake dashboard". A demo showing invented numbers would be a
 * brochure, and it would be indistinguishable from a working one right up
 * until someone asked whether the blocks were genuine.
 *
 * A guard test asserts no hard-coded agent/event/block dataset exists here.
 *
 * ─── TODAY'S SPEND COMES FROM THE LEDGER ──────────────────────────────────
 *
 * It arrives already computed on `governance`, read from `ledger_daily` for
 * the SERVER's UTC day. This page does not sum events to derive it - that is
 * the Step 17 invariant, and summing here would show a number the plane does
 * not enforce against.
 *
 * ─── READ-ONLY, WITH NOTHING TO PRESS ─────────────────────────────────────
 *
 * No policy editor, no pause control, no API keys, no share management, no
 * demo toggle, no sign-out. Not hidden - absent. The server refuses every
 * mutation for a demo visitor regardless, but a control that looked live would
 * misrepresent what the page is.
 *
 * ─── IT REFRESHES ─────────────────────────────────────────────────────────
 *
 * A visitor should see the fleet move and new blocks appear without reloading,
 * because "recurring" is the point. A modest interval poll does that; a
 * WebSocket would be machinery this does not need.
 *
 * ─── NO `dangerouslySetInnerHTML` ─────────────────────────────────────────
 *
 * Every value - including runtime-authored rules and raw event JSON - is a
 * React text child and therefore escaped.
 */

interface DemoViewProps {
  /** Read from the address bar by the shell. Public, not a credential. */
  readonly slug: string;
}

type ViewState =
  | { status: 'loading' }
  | { status: 'ready'; workspaceName: string }
  /** Unknown, malformed or DISABLED - deliberately indistinguishable. */
  | { status: 'unavailable' };

/** Modest enough to be polite to the plane, brisk enough to feel live. */
const REFRESH_INTERVAL_MS = 15_000;

/** Raw validated event JSON, rendered as a text child so it is escaped. */
function RawJson({ raw }: { readonly raw: unknown }): JSX.Element {
  return (
    <pre className="max-h-80 overflow-auto rounded-md border border-slate-800 bg-slate-950 p-3 font-mono text-xs leading-relaxed text-slate-300">
      {JSON.stringify(raw, null, 2)}
    </pre>
  );
}

interface DemoData {
  readonly agents: ShareAgent[];
  readonly events: EventSummary[];
  readonly receipts: ReceiptSummary[];
  readonly blocks: BlockSummary[];
}

export function DemoView({ slug }: DemoViewProps): JSX.Element {
  const [state, setState] = useState<ViewState>({ status: 'loading' });
  const [data, setData] = useState<DemoData | null>(null);
  const [selected, setSelected] = useState<EventDetail | null>(null);
  /** Set once the demo is gone, so the poll stops rather than hammering. */
  const stopped = useRef(false);

  const load = useCallback(async (): Promise<void> => {
    const [workspace, agents, events, receipts, blocks] = await Promise.all([
      fetchDemoWorkspace(slug),
      fetchDemoAgents(slug),
      fetchDemoEvents(slug),
      fetchDemoReceipts(slug),
      fetchDemoBlocks(slug),
    ]);

    // Any null means the demo is no longer reachable - most likely an operator
    // just disabled it. The server re-checks the flag on every request, so
    // this is exactly how a withdrawal reaches an open tab.
    if (workspace === null || agents === null || events === null || receipts === null || blocks === null) {
      stopped.current = true;
      setState({ status: 'unavailable' });
      return;
    }

    setState({ status: 'ready', workspaceName: workspace.name });
    setData({
      agents: agents.agents,
      events: events.events,
      receipts: receipts.receipts,
      blocks: blocks.blocks,
    });
  }, [slug]);

  useEffect(() => {
    let cancelled = false;
    stopped.current = false;

    const tick = async (): Promise<void> => {
      if (cancelled || stopped.current) return;
      await load();
    };

    void tick();
    const timer = setInterval(() => {
      void tick();
    }, REFRESH_INTERVAL_MS);
    // Cleared on unmount, so a closed page leaves no timer behind.
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [load]);

  if (state.status === 'loading') {
    return (
      <main className="min-h-screen bg-slate-950 px-6 py-16 text-slate-100">
        <p className="mx-auto max-w-4xl text-sm text-slate-400">Loading demo…</p>
      </main>
    );
  }

  if (state.status === 'unavailable') {
    return (
      <main className="min-h-screen bg-slate-950 px-6 py-16 text-slate-100">
        <div className="mx-auto max-w-4xl space-y-3">
          <h1 className="text-xl font-semibold">This demo is not available</h1>
          {/* One message for every cause. A visitor does not need to learn
              that a workspace exists but is private. */}
          <p className="text-sm text-slate-400">
            The demo may have been turned off, or this address may never have been valid.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto max-w-4xl space-y-8 px-6 py-12">
        <header className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-[0.2em] text-emerald-400">
            Public demo &middot; read-only
          </p>
          <h1 className="text-2xl font-semibold tracking-tight">{state.workspaceName}</h1>
          <p className="max-w-prose text-sm text-slate-400">
            A live control plane governing a small agent fleet. Everything below is real: the
            spend totals are the authoritative daily ledger, and each block was written by the
            plane when it refused an action. Updates every {String(REFRESH_INTERVAL_MS / 1000)}{' '}
            seconds.
          </p>
        </header>

        <section className="space-y-3">
          <h2 className="text-base font-medium">Fleet</h2>
          {data === null || data.agents.length === 0 ? (
            <p className="text-sm text-slate-500">No agents are reporting yet.</p>
          ) : (
            <ul className="divide-y divide-slate-800 rounded-md border border-slate-800">
              {data.agents.map((agent) => (
                <li key={agent.id} className="space-y-2 px-4 py-3">
                  <div className="flex items-center justify-between gap-4">
                    <span className="min-w-0">
                      <span className="block truncate text-sm text-slate-100">
                        {agent.name ?? agent.agentId}
                      </span>
                      <span className="block font-mono text-xs text-slate-500">
                        {agent.agentId}
                      </span>
                    </span>
                    <span
                      className="shrink-0 rounded bg-slate-800 px-1.5 py-0.5 text-xs text-slate-300"
                      title={MODE_DESCRIPTION[agent.governance.mode]}
                    >
                      {MODE_LABEL[agent.governance.mode]}
                    </span>
                  </div>

                  {capsApply(agent.governance.mode) && (
                    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
                      <dt className="text-slate-500">Today&rsquo;s spend</dt>
                      <dd className="font-mono text-slate-300">{describeSpend(agent.governance)}</dd>
                      <dt className="text-slate-500">Publishes today</dt>
                      <dd className="font-mono text-slate-300">
                        {describePublishes(agent.governance)}
                      </dd>
                    </dl>
                  )}

                  <p className="text-xs text-slate-600">
                    Last seen{' '}
                    {agent.lastSeenAt === null ? 'never' : formatInstant(agent.lastSeenAt)}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="space-y-3">
          <h2 className="text-base font-medium">Blocks</h2>
          <p className="max-w-prose text-sm text-slate-400">
            Each of these is a real refusal. The plane evaluated the request against the
            configured policy, denied it, and recorded the decision.
          </p>
          {data === null || data.blocks.length === 0 ? (
            <p className="text-sm text-slate-500">Nothing has been blocked yet.</p>
          ) : (
            <ul className="divide-y divide-slate-800 rounded-md border border-slate-800">
              {data.blocks.map((block) => (
                <li key={block.id} className="flex items-center justify-between gap-4 px-4 py-2">
                  <span className="min-w-0 text-sm">
                    <span
                      className={`mr-2 rounded px-1.5 py-0.5 text-xs ${
                        block.source === 'plane'
                          ? 'bg-sky-950 text-sky-300'
                          : 'bg-slate-800 text-slate-300'
                      }`}
                    >
                      {block.source === 'plane' ? 'Control plane' : 'Runtime'}
                    </span>
                    <span className="text-slate-300">{describeRule(block.rule)}</span>
                    <span className="ml-2 font-mono text-xs text-slate-500">
                      {block.agent.name ?? block.agent.agentId}
                    </span>
                  </span>
                  <span className="shrink-0 text-xs text-slate-400">
                    {formatInstant(block.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="space-y-3">
          <h2 className="text-base font-medium">Decisions</h2>
          {data === null || data.receipts.length === 0 ? (
            <p className="text-sm text-slate-500">No decisions recorded yet.</p>
          ) : (
            <ul className="divide-y divide-slate-800 rounded-md border border-slate-800">
              {data.receipts.slice(0, 10).map((receipt) => (
                <li key={receipt.id} className="flex items-center justify-between gap-4 px-4 py-2">
                  <span className="min-w-0 text-sm">
                    <span
                      className={`mr-2 rounded px-1.5 py-0.5 text-xs ${
                        receipt.decision === 'allow'
                          ? 'bg-slate-800 text-slate-300'
                          : 'bg-red-950 text-red-300'
                      }`}
                    >
                      {receipt.decision === 'allow' ? 'Allowed' : 'Denied'}
                    </span>
                    <span className="text-slate-300">{receipt.category}</span>
                  </span>
                  <span className="shrink-0 text-xs text-slate-400">
                    {formatInstant(receipt.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="space-y-3">
          <h2 className="text-base font-medium">Activity</h2>
          {data === null || data.events.length === 0 ? (
            <p className="text-sm text-slate-500">No events yet.</p>
          ) : (
            <ul className="divide-y divide-slate-800 rounded-md border border-slate-800">
              {data.events.slice(0, 15).map((event) => (
                <li key={event.id}>
                  <button
                    type="button"
                    onClick={() => {
                      void (async () => {
                        setSelected(await fetchDemoEvent(slug, event.id));
                      })();
                    }}
                    className="flex w-full items-center justify-between gap-4 px-4 py-2 text-left hover:bg-slate-900"
                  >
                    <span className="min-w-0 text-sm">
                      <span className="text-slate-100">{event.type}</span>
                      <span className="ml-2 font-mono text-xs text-slate-500">
                        {event.agent.name ?? event.agent.agentId}
                      </span>
                    </span>
                    <span className="shrink-0 text-xs text-slate-400">
                      {formatInstant(event.receivedAt)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {selected !== null && (
            <div className="space-y-2 rounded-md border border-slate-700 bg-slate-900/80 p-4">
              <div className="flex items-start justify-between gap-4">
                <p className="truncate font-mono text-xs text-slate-400">{selected.eventId}</p>
                <button
                  type="button"
                  onClick={() => {
                    setSelected(null);
                  }}
                  className="shrink-0 rounded-md border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800"
                >
                  Close
                </button>
              </div>
              <RawJson raw={selected.raw} />
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
