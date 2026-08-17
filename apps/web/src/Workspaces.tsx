import type { WorkspaceSummary } from '@hybrid/contracts';
import { useCallback, useEffect, useState, type FormEvent, type JSX } from 'react';

import { Agents } from './Agents';
import { createWorkspace, listWorkspaces, openWorkspace } from './api';
import { ApiKeys } from './ApiKeys';
import { Governance } from './Governance';
import { DemoSettingsPanel } from './DemoSettings';
import { ShareLinks } from './ShareLinks';
import { Timeline } from './Timeline';

/**
 * Workspace selection and creation.
 *
 * THE SELECTED WORKSPACE IS A CONVENIENCE, NOT AUTHORITY
 * ------------------------------------------------------
 * The chosen workspace id lives in component state only. It is not persisted to
 * localStorage, and even if it were, it would grant nothing: the server
 * re-proves membership on every request. Nothing the browser holds is trusted.
 *
 * SCOPE: create, list, open, and - once open - the agent roster with its
 * enforcement state, the governance audit, the event timeline with raw
 * drill-through, and API credentials. No exports, no charts, no rollups.
 */

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; workspaces: WorkspaceSummary[] }
  | { status: 'error'; message: string };

export function Workspaces(): JSX.Element {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [selected, setSelected] = useState<WorkspaceSummary | null>(null);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState('');

  const load = useCallback(async (): Promise<void> => {
    try {
      setState({ status: 'ready', workspaces: await listWorkspaces() });
    } catch (error: unknown) {
      setState({
        status: 'error',
        message: error instanceof Error ? error.message : 'Something went wrong.',
      });
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const workspaces = await listWorkspaces();
        if (!cancelled) {
          setState({ status: 'ready', workspaces });
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
  }, []);

  async function onCreate(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setCreating(true);
    setFormError('');
    try {
      const workspace = await createWorkspace(name);
      setName('');
      setSelected(workspace);
      await load();
    } catch (error: unknown) {
      setFormError(error instanceof Error ? error.message : 'Something went wrong.');
    } finally {
      setCreating(false);
    }
  }

  async function onOpen(workspaceId: string): Promise<void> {
    // Re-fetch rather than reuse the list entry: this exercises the real
    // authorization path on the server for the selected workspace.
    const workspace = await openWorkspace(workspaceId);
    if (workspace === null) {
      setFormError('That workspace is no longer available.');
      await load();
      return;
    }
    setSelected(workspace);
  }

  if (state.status === 'loading') {
    return <p className="text-sm text-slate-400">Loading workspaces…</p>;
  }

  if (state.status === 'error') {
    return (
      <p role="alert" className="text-sm text-red-400">
        {state.message}
      </p>
    );
  }

  return (
    <div className="space-y-6">
      {state.workspaces.length === 0 ? (
        <div className="space-y-2">
          <h2 className="text-lg font-medium">Create your workspace</h2>
          <p className="max-w-prose text-sm text-slate-400">
            You do not belong to a workspace yet. Creating one makes you its operator.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          <h2 className="text-lg font-medium">Your workspaces</h2>
          <ul className="divide-y divide-slate-800 rounded-md border border-slate-800">
            {state.workspaces.map((workspace) => (
              <li key={workspace.id} className="flex items-center justify-between gap-4 px-4 py-3">
                <span className="min-w-0">
                  <span className="block truncate text-slate-100">{workspace.name}</span>
                  <span className="text-xs uppercase tracking-wide text-slate-500">
                    {workspace.role}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => {
                    void onOpen(workspace.id);
                  }}
                  className="shrink-0 rounded-md border border-slate-700 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-800"
                >
                  {selected?.id === workspace.id ? 'Selected' : 'Open'}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {selected !== null && (
        <div className="space-y-5">
          <div className="rounded-md border border-slate-800 bg-slate-900/60 px-4 py-3 text-sm">
            <p className="text-slate-200">
              Authorized for <span className="font-medium">{selected.name}</span> as{' '}
              {selected.role}.
            </p>
            <p className="mt-1 text-slate-500">
              Policy applies to actions that ask the control plane for a decision before acting.
              Reported spend events are recorded, but do not draw down the daily ledger.
            </p>
          </div>

          <div className="border-t border-slate-800 pt-5">
            <Agents
              key={`agents-${selected.id}`}
              workspaceId={selected.id}
              canManagePolicy={selected.role === 'operator'}
            />
          </div>

          <div className="border-t border-slate-800 pt-5">
            <Governance key={`governance-${selected.id}`} workspaceId={selected.id} />
          </div>

          <div className="border-t border-slate-800 pt-5">
            <Timeline key={`timeline-${selected.id}`} workspaceId={selected.id} />
          </div>

          <div className="border-t border-slate-800 pt-5">
            <ShareLinks
              key={`shares-${selected.id}`}
              workspaceId={selected.id}
              canManage={selected.role === 'operator'}
            />
          </div>

          <div className="border-t border-slate-800 pt-5">
            <DemoSettingsPanel
              key={`demo-${selected.id}`}
              workspaceId={selected.id}
              canManage={selected.role === 'operator'}
            />
          </div>

          <div className="border-t border-slate-800 pt-5">
            <ApiKeys
              key={`keys-${selected.id}`}
              workspaceId={selected.id}
              canManage={selected.role === 'operator'}
            />
          </div>
        </div>
      )}

      <form
        className="flex flex-wrap items-end gap-3 border-t border-slate-800 pt-6"
        onSubmit={(event) => {
          void onCreate(event);
        }}
      >
        <div className="min-w-0 flex-1 space-y-2">
          <label htmlFor="workspace-name" className="block text-sm text-slate-300">
            New workspace name
          </label>
          <input
            id="workspace-name"
            type="text"
            required
            maxLength={120}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
            className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-slate-100 outline-none focus:border-slate-500"
            placeholder="Ashir AI Lab"
          />
        </div>
        <button
          type="submit"
          disabled={creating}
          className="rounded-md bg-slate-100 px-4 py-2 text-sm font-medium text-slate-900 disabled:opacity-60"
        >
          {creating ? 'Creating…' : 'Create workspace'}
        </button>
      </form>

      {formError !== '' && (
        <p role="alert" className="text-sm text-red-400">
          {formError}
        </p>
      )}
    </div>
  );
}
