import type { JSX, ReactNode } from 'react';

import { Badge } from './ui';

/**
 * The authenticated application shell.
 *
 * ─── WHY THE NAVIGATION IS A CLOSED SET ───────────────────────────────────
 *
 * Every destination below maps to a surface the API actually serves. There is
 * no Billing, no Integrations, no Alerts and no Reports, because none of those
 * exist - and a sidebar entry that leads to a placeholder is worse than an
 * absent one. It teaches an operator to distrust the navigation.
 *
 * The list is data, not markup, so adding a destination is a one-line change
 * when the surface behind it becomes real.
 *
 * ─── WHY THERE IS NO "ADD AGENT" BUTTON ───────────────────────────────────
 *
 * Agents are DISCOVERED. A runtime registers itself through the machine API
 * with a workspace key; there is no operator-side create flow, and inventing
 * one would imply a capability the product does not have.
 */

export type NavKey =
  | 'overview'
  | 'fleet'
  | 'timeline'
  | 'policies'
  | 'receipts'
  | 'keys'
  | 'sharing'
  | 'demo';

interface NavItem {
  readonly key: NavKey;
  readonly label: string;
  /** Operator-only destinations are hidden from a member entirely. */
  readonly operatorOnly?: boolean;
}

const NAV: readonly NavItem[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'fleet', label: 'Fleet' },
  { key: 'timeline', label: 'Timeline' },
  { key: 'policies', label: 'Policies' },
  { key: 'receipts', label: 'Receipts & blocks' },
  { key: 'keys', label: 'API keys', operatorOnly: true },
  { key: 'sharing', label: 'Sharing', operatorOnly: true },
  { key: 'demo', label: 'Public demo', operatorOnly: true },
];

export const NAV_TITLE: Record<NavKey, string> = {
  overview: 'Overview',
  fleet: 'Fleet',
  timeline: 'Timeline',
  policies: 'Policies',
  receipts: 'Receipts & blocks',
  keys: 'API keys',
  sharing: 'Sharing',
  demo: 'Public demo',
};

/** The product mark. Wordmark only - no robot, no sparkle, no gradient. */
function Wordmark(): JSX.Element {
  return (
    <div className="flex items-center gap-2.5">
      <span
        aria-hidden="true"
        className="grid h-8 w-8 place-items-center rounded-md bg-accent text-sm font-bold text-white"
      >
        H
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-semibold text-white">Hybrid Control</span>
        <span className="block truncate text-xs text-nav-400">AI Agent Control Plane</span>
      </span>
    </div>
  );
}

export interface ShellWorkspace {
  readonly id: string;
  readonly name: string;
  readonly role: string;
}

export function AppShell({
  workspace,
  workspaces,
  active,
  onNavigate,
  onSwitchWorkspace,
  email,
  onSignOut,
  children,
}: {
  workspace: ShellWorkspace;
  workspaces: readonly ShellWorkspace[];
  active: NavKey;
  onNavigate: (key: NavKey) => void;
  onSwitchWorkspace: (id: string) => void;
  email: string;
  onSignOut: () => void;
  children: ReactNode;
}): JSX.Element {
  const isOperator = workspace.role === 'operator';
  const visible = NAV.filter((item) => item.operatorOnly !== true || isOperator);

  return (
    <div className="min-h-screen bg-canvas text-ink">
      {/* Skip link: the first tab stop on the page, for keyboard users who do
          not want to walk the whole sidebar to reach content. */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-50 focus:rounded-md focus:bg-accent focus:px-3 focus:py-2 focus:text-sm focus:text-white"
      >
        Skip to content
      </a>

      <div className="flex min-h-screen">
        {/* ── Sidebar ─────────────────────────────────────────────────── */}
        <aside className="hidden w-60 shrink-0 flex-col justify-between bg-nav-950 lg:flex">
          <div className="min-w-0">
            <div className="px-4 py-5">
              <Wordmark />
            </div>

            <div className="px-3 pb-3">
              <label htmlFor="workspace-switcher" className="sr-only">
                Workspace
              </label>
              <select
                id="workspace-switcher"
                value={workspace.id}
                onChange={(event) => {
                  onSwitchWorkspace(event.target.value);
                }}
                className="w-full rounded-md border border-nav-700 bg-nav-900 px-2.5 py-2 text-sm text-white focus:border-accent focus:outline-none"
              >
                {workspaces.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name}
                  </option>
                ))}
              </select>
            </div>

            <nav aria-label="Workspace" className="px-3">
              <ul className="space-y-0.5">
                {visible.map((item) => {
                  const selected = item.key === active;
                  return (
                    <li key={item.key}>
                      <button
                        type="button"
                        // aria-current, not just colour, so assistive tech
                        // reports which destination is open.
                        aria-current={selected ? 'page' : undefined}
                        onClick={() => {
                          onNavigate(item.key);
                        }}
                        className={`w-full rounded-md px-3 py-2 text-left text-sm transition-colors ${
                          selected
                            ? 'bg-nav-800 font-medium text-white'
                            : 'text-nav-300 hover:bg-nav-900 hover:text-white'
                        }`}
                      >
                        {item.label}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </nav>
          </div>

          <div className="border-t border-nav-800 px-4 py-4">
            <p className="truncate text-sm text-white" title={email}>
              {email}
            </p>
            <p className="mt-0.5 text-xs text-nav-400">
              {isOperator ? 'Operator' : 'Member'} · {workspace.name}
            </p>
            <button
              type="button"
              onClick={onSignOut}
              className="mt-3 w-full rounded-md border border-nav-700 px-3 py-1.5 text-sm text-nav-300 transition-colors hover:bg-nav-900 hover:text-white"
            >
              Sign out
            </button>
          </div>
        </aside>

        {/* ── Main column ─────────────────────────────────────────────── */}
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-10 border-b border-line bg-surface/95 backdrop-blur">
            <div className="flex items-center justify-between gap-4 px-5 py-3 sm:px-8">
              <div className="flex min-w-0 items-center gap-3">
                <h2 className="truncate text-sm font-semibold text-ink">{NAV_TITLE[active]}</h2>
                <Badge tone="neutral">{workspace.name}</Badge>
              </div>
              <Badge tone={isOperator ? 'accent' : 'neutral'}>
                {isOperator ? 'Operator' : 'Member'}
              </Badge>
            </div>

            {/* Narrow viewports lose the sidebar, so navigation moves here
                rather than disappearing. Scrolls horizontally; the page never
                does. */}
            <nav aria-label="Workspace" className="overflow-x-auto border-t border-line lg:hidden">
              <ul className="flex min-w-max gap-1 px-3 py-2">
                {visible.map((item) => (
                  <li key={item.key}>
                    <button
                      type="button"
                      aria-current={item.key === active ? 'page' : undefined}
                      onClick={() => {
                        onNavigate(item.key);
                      }}
                      className={`rounded-md px-3 py-1.5 text-sm whitespace-nowrap ${
                        item.key === active
                          ? 'bg-accent-soft font-medium text-accent'
                          : 'text-ink-muted hover:bg-canvas'
                      }`}
                    >
                      {item.label}
                    </button>
                  </li>
                ))}
              </ul>
            </nav>
          </header>

          <main id="main" className="flex-1 px-5 py-6 sm:px-8 sm:py-8">
            <div className="mx-auto w-full max-w-6xl space-y-6">{children}</div>
          </main>
        </div>
      </div>
    </div>
  );
}
