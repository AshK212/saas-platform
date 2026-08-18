import type { WorkspaceSummary } from '@hybrid/contracts';
import { useState, type JSX } from 'react';

import { Agents } from './Agents';
import { ApiKeys } from './ApiKeys';
import { AppShell, type NavKey } from './AppShell';
import { DemoSettingsPanel } from './DemoSettings';
import { Governance } from './Governance';
import { Overview } from './Overview';
import { PageHeader } from './ui';
import { ShareLinks } from './ShareLinks';
import { Timeline } from './Timeline';

/**
 * The signed-in workspace application.
 *
 * ─── WHY NAVIGATION REPLACED A SINGLE SCROLLING COLUMN ────────────────────
 *
 * Every panel used to render at once, stacked: roster, governance audit,
 * timeline, share links, demo settings and credentials on one page. That is
 * fine for proving the surfaces exist and poor for operating them - the
 * timeline alone can be a hundred rows, so the audit below it was effectively
 * unreachable, and every workspace switch re-fetched all six.
 *
 * Now one destination renders at a time. The panels themselves are unchanged
 * components with unchanged props; only their arrangement moved.
 *
 * ─── ROUTING IS STATE, NOT HISTORY ────────────────────────────────────────
 *
 * Deliberately: the app has no router, and the two public surfaces
 * (`/share/:token`, `/demo/:slug`) are matched on pathname before any session
 * is consulted. Introducing history routing here would have meant touching
 * that matching, which is load-bearing for AC-18 and AC-19 - a large risk for
 * a cosmetic gain during a UI pass.
 */

/** Descriptions shown under each page title. Copy only; no behaviour. */
const PAGE_DESCRIPTION: Record<NavKey, string> = {
  overview: 'Current enforcement state across this workspace.',
  fleet: 'Every registered runtime, with the caps it is being held to.',
  timeline: 'Everything agents reported, newest first.',
  policies: 'What each agent is allowed to do, and how much.',
  receipts: 'Evidence for every decision the control plane made.',
  keys: 'Credentials runtimes use to reach the control plane.',
  sharing: 'Read-only links to this workspace.',
  demo: 'A public, read-only view of this workspace.',
};

export function WorkspaceApp({
  workspace,
  workspaces,
  email,
  onSwitchWorkspace,
  onSignOut,
}: {
  workspace: WorkspaceSummary;
  workspaces: readonly WorkspaceSummary[];
  email: string;
  onSwitchWorkspace: (id: string) => void;
  onSignOut: () => void;
}): JSX.Element {
  const [active, setActive] = useState<NavKey>('overview');
  const isOperator = workspace.role === 'operator';

  // A member who somehow lands on an operator-only page is shown the overview
  // rather than an error: the server would refuse the data anyway, and the
  // sidebar never offered the destination.
  const resolved: NavKey =
    !isOperator && (active === 'keys' || active === 'sharing' || active === 'demo')
      ? 'overview'
      : active;

  return (
    <AppShell
      workspace={workspace}
      workspaces={workspaces}
      active={resolved}
      onNavigate={setActive}
      onSwitchWorkspace={onSwitchWorkspace}
      email={email}
      onSignOut={onSignOut}
    >
      {resolved === 'overview' && (
        <>
          <PageHeader title="Overview" description={PAGE_DESCRIPTION.overview} />
        <Overview
          key={`overview-${workspace.id}`}
          workspaceId={workspace.id}
          onNavigateFleet={() => {
            setActive('fleet');
          }}
          onNavigateReceipts={() => {
            setActive('receipts');
          }}
        />
        </>
      )}

      {/* Fleet and Policies are the same component: the roster IS where policy
          is edited, and splitting them would have meant two ways to reach one
          control. The page title differs; the surface does not. */}
      {(resolved === 'fleet' || resolved === 'policies') && (
        <Agents
          key={`agents-${workspace.id}`}
          workspaceId={workspace.id}
          canManagePolicy={isOperator}
        />
      )}

      {resolved === 'timeline' && (
        <Timeline key={`timeline-${workspace.id}`} workspaceId={workspace.id} />
      )}

      {resolved === 'receipts' && (
        <Governance key={`governance-${workspace.id}`} workspaceId={workspace.id} />
      )}

      {resolved === 'keys' && (
        <ApiKeys key={`keys-${workspace.id}`} workspaceId={workspace.id} canManage={isOperator} />
      )}

      {resolved === 'sharing' && (
        <ShareLinks
          key={`shares-${workspace.id}`}
          workspaceId={workspace.id}
          canManage={isOperator}
        />
      )}

      {resolved === 'demo' && (
        <DemoSettingsPanel
          key={`demo-${workspace.id}`}
          workspaceId={workspace.id}
          canManage={isOperator}
        />
      )}
    </AppShell>
  );
}
