import type {
  BlockSummary,
  EventDetail,
  EventSummary,
  ReceiptSummary,
  ShareAgent,
} from '@hybrid/contracts';
import { useEffect, useState, type JSX } from 'react';

import {
  fetchSharedAgents,
  fetchSharedBlocks,
  fetchSharedEvent,
  fetchSharedEvents,
  fetchSharedReceipts,
  openShare,
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
 * The public read-only shared workspace view (AC-18).
 *
 * ─── READ-ONLY IS ENFORCED, NOT HIDDEN ────────────────────────────────────
 *
 * This page renders no policy editor, no save button, no pause control, no API
 * keys, no share management and no sign-out. That is not merely a matter of
 * hiding controls: the server refuses every mutation for a share token, and
 * this page has no code that could attempt one. A guard test asserts both
 * halves - the absent UI and the absent capability.
 *
 * ─── THE TOKEN LIVES FOR ONE REQUEST ──────────────────────────────────────
 *
 * It arrives in the URL, because the recipient has nowhere else to carry it.
 * This component immediately:
 *
 *   1. POSTs it to the exchange endpoint, which sets an HttpOnly cookie;
 *   2. strips it from the address bar with `replaceState`;
 *   3. drops its own copy.
 *
 * It is never written to localStorage, sessionStorage or IndexedDB - all
 * readable by any script on the page - and never appended to a later request.
 * Every read after the exchange is authenticated by the cookie.
 *
 * ─── REVOCATION SHOWS UP ON REFRESH ───────────────────────────────────────
 *
 * The server re-resolves the token on every read, so a revoked link starts
 * failing immediately. Any read returning null puts this page into its `dead`
 * state, which is what an operator sees when they revoke and the viewer
 * refreshes.
 *
 * ─── NO `dangerouslySetInnerHTML` ─────────────────────────────────────────
 *
 * Everything - including runtime-authored rules, reasons and raw event JSON -
 * is a React text child and therefore escaped.
 */

interface SharedViewProps {
  /** Read from the address bar by the shell, before it was stripped. */
  readonly token: string;
}

type ViewState =
  | { status: 'opening' }
  | { status: 'ready'; workspaceName: string }
  /** Unknown, malformed or revoked - deliberately indistinguishable. */
  | { status: 'dead' };

type Tab = 'fleet' | 'events' | 'governance';

/** Raw validated event JSON, rendered as a text child so it is escaped. */
function RawJson({ raw }: { readonly raw: unknown }): JSX.Element {
  return (
    <pre className="max-h-96 overflow-auto rounded-md border border-slate-800 bg-slate-950 p-3 font-mono text-xs leading-relaxed text-slate-300">
      {JSON.stringify(raw, null, 2)}
    </pre>
  );
}

function FleetPanel(): JSX.Element {
  const [agents, setAgents] = useState<ShareAgent[] | null>(null);
  const [dead, setDead] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const page = await fetchSharedAgents();
      if (cancelled) return;
      if (page === null) {
        setDead(true);
        return;
      }
      setAgents(page.agents);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (dead) {
    return <p className="text-sm text-red-400">This shared link is no longer active.</p>;
  }
  if (agents === null) {
    return <p className="text-sm text-slate-400">Loading agents…</p>;
  }
  if (agents.length === 0) {
    return <p className="text-sm text-slate-500">No agents in this workspace yet.</p>;
  }

  return (
    <ul className="divide-y divide-slate-800 rounded-md border border-slate-800">
      {agents.map((agent) => (
        <li key={agent.id} className="space-y-2 px-4 py-3">
          <div className="flex items-center justify-between gap-4">
            <span className="min-w-0">
              <span className="block truncate text-sm text-slate-100">
                {agent.name ?? agent.agentId}
              </span>
              <span className="block font-mono text-xs text-slate-500">{agent.agentId}</span>
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
              <dd className="font-mono text-slate-300">{describePublishes(agent.governance)}</dd>
            </dl>
          )}

          <p className="text-xs text-slate-600">
            Last seen {agent.lastSeenAt === null ? 'never' : formatInstant(agent.lastSeenAt)} ·
            usage for {agent.governance.accountingDay} (UTC)
          </p>
        </li>
      ))}
    </ul>
  );
}

function EventsPanel(): JSX.Element {
  const [events, setEvents] = useState<EventSummary[] | null>(null);
  const [selected, setSelected] = useState<EventDetail | null>(null);
  const [dead, setDead] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const page = await fetchSharedEvents();
      if (cancelled) return;
      if (page === null) {
        setDead(true);
        return;
      }
      setEvents(page.events);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (dead) {
    return <p className="text-sm text-red-400">This shared link is no longer active.</p>;
  }
  if (events === null) {
    return <p className="text-sm text-slate-400">Loading events…</p>;
  }
  if (events.length === 0) {
    return <p className="text-sm text-slate-500">No events yet.</p>;
  }

  return (
    <div className="space-y-4">
      <ul className="divide-y divide-slate-800 rounded-md border border-slate-800">
        {events.map((event) => (
          <li key={event.id}>
            <button
              type="button"
              onClick={() => {
                void (async () => {
                  setSelected(await fetchSharedEvent(event.id));
                })();
              }}
              className="flex w-full items-center justify-between gap-4 px-4 py-3 text-left hover:bg-slate-900"
            >
              <span className="min-w-0">
                <span className="block truncate text-sm text-slate-100">{event.type}</span>
                <span className="block truncate font-mono text-xs text-slate-500">
                  {event.agent.name ?? event.agent.agentId} · {event.eventId}
                </span>
              </span>
              <span className="shrink-0 text-xs text-slate-400">
                {formatInstant(event.receivedAt)}
              </span>
            </button>
          </li>
        ))}
      </ul>

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
    </div>
  );
}

function GovernancePanel(): JSX.Element {
  const [receipts, setReceipts] = useState<ReceiptSummary[] | null>(null);
  const [blocks, setBlocks] = useState<BlockSummary[] | null>(null);
  const [dead, setDead] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [receiptPage, blockPage] = await Promise.all([
        fetchSharedReceipts(),
        fetchSharedBlocks(),
      ]);
      if (cancelled) return;
      if (receiptPage === null || blockPage === null) {
        setDead(true);
        return;
      }
      setReceipts(receiptPage.receipts);
      setBlocks(blockPage.blocks);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (dead) {
    return <p className="text-sm text-red-400">This shared link is no longer active.</p>;
  }
  if (receipts === null || blocks === null) {
    return <p className="text-sm text-slate-400">Loading governance…</p>;
  }

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h4 className="text-sm font-medium text-slate-200">Decisions</h4>
        {receipts.length === 0 ? (
          <p className="text-sm text-slate-500">No decisions recorded yet.</p>
        ) : (
          <ul className="divide-y divide-slate-800 rounded-md border border-slate-800">
            {receipts.map((receipt) => (
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
                  <span className="ml-2 font-mono text-xs text-slate-500">
                    {receipt.agent.name ?? receipt.agent.agentId}
                  </span>
                </span>
                <span className="shrink-0 text-xs text-slate-400">
                  {formatInstant(receipt.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="space-y-2">
        <h4 className="text-sm font-medium text-slate-200">Blocks</h4>
        {blocks.length === 0 ? (
          <p className="text-sm text-slate-500">No blocks recorded yet.</p>
        ) : (
          <ul className="divide-y divide-slate-800 rounded-md border border-slate-800">
            {blocks.map((block) => (
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
                </span>
                <span className="shrink-0 text-xs text-slate-400">
                  {formatInstant(block.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export function SharedView({ token }: SharedViewProps): JSX.Element {
  const [state, setState] = useState<ViewState>({ status: 'opening' });
  const [tab, setTab] = useState<Tab>('fleet');

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const opened = await openShare(token);

      // Strip the token from the address bar whatever the outcome, so a
      // screenshot, a shoulder-surfer or a copied URL does not carry it.
      // Everything after this is cookie-authenticated.
      window.history.replaceState({}, '', '/share');

      if (cancelled) return;
      setState(
        opened === null ? { status: 'dead' } : { status: 'ready', workspaceName: opened.workspace.name },
      );
    })();

    return () => {
      cancelled = true;
    };
  }, [token]);

  if (state.status === 'opening') {
    return (
      <main className="min-h-screen bg-slate-950 px-6 py-16 text-slate-100">
        <p className="mx-auto max-w-3xl text-sm text-slate-400">Opening shared view…</p>
      </main>
    );
  }

  if (state.status === 'dead') {
    return (
      <main className="min-h-screen bg-slate-950 px-6 py-16 text-slate-100">
        <div className="mx-auto max-w-3xl space-y-3">
          <h1 className="text-xl font-semibold">This shared link is not available</h1>
          {/* One message for every cause. Distinguishing "revoked" from "never
              existed" would tell a holder something they should not learn. */}
          <p className="text-sm text-slate-400">
            The link may have been revoked, or it may never have been valid. Ask whoever shared it
            for a new one.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto max-w-3xl space-y-6 px-6 py-12">
        <header className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-[0.2em] text-amber-400">
            Read-only shared view
          </p>
          <h1 className="text-2xl font-semibold tracking-tight">{state.workspaceName}</h1>
          <p className="max-w-prose text-sm text-slate-400">
            You are viewing this workspace through a shared link. Nothing here can be changed, and
            no sign-in is required. The link can be revoked at any time by an operator.
          </p>
        </header>

        <nav className="flex gap-2" aria-label="Shared sections">
          {(['fleet', 'events', 'governance'] as const).map((name) => (
            <button
              key={name}
              type="button"
              aria-current={tab === name}
              onClick={() => {
                setTab(name);
              }}
              className={`rounded-md border px-3 py-1.5 text-sm capitalize ${
                tab === name
                  ? 'border-slate-500 bg-slate-800 text-slate-100'
                  : 'border-slate-700 text-slate-300 hover:bg-slate-800'
              }`}
            >
              {name}
            </button>
          ))}
        </nav>

        {tab === 'fleet' && <FleetPanel />}
        {tab === 'events' && <EventsPanel />}
        {tab === 'governance' && <GovernancePanel />}
      </div>
    </main>
  );
}
