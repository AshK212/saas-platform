import type { WorkspaceSummary } from '@hybrid/contracts';
import { useEffect, useState, type FormEvent, type JSX } from 'react';

import { createWorkspace, listWorkspaces } from './api';
import { Badge, Button, Card, EmptyState, ErrorState, Field, inputClass, LoadingState } from './ui';

/**
 * Workspace selection, and the first screen a signed-in operator sees.
 *
 * ─── WHAT THE COPY DOES NOT SAY ───────────────────────────────────────────
 *
 * The previous version explained here that "being signed in authorizes no
 * workspace on its own" and that membership is re-checked server-side on every
 * request. Both statements are true and neither belongs on a landing screen:
 * it is an architecture note addressed to a reviewer, not to the person
 * choosing where to work.
 *
 * The BEHAVIOUR is untouched. Membership is still proven by the server on
 * every request, the chosen workspace still lives in component state only, and
 * nothing is persisted to storage. Removing the sentence changed no security
 * property - only who the screen appears to be written for.
 */

type State =
  | { status: 'loading' }
  | { status: 'ready'; workspaces: WorkspaceSummary[] }
  | { status: 'error'; message: string };

export function WorkspacePicker({
  email,
  onOpen,
  onSignOut,
}: {
  email: string;
  onOpen: (workspace: WorkspaceSummary) => void;
  onSignOut: () => void;
}): JSX.Element {
  const [state, setState] = useState<State>({ status: 'loading' });
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState('');

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
    const trimmed = name.trim();
    if (trimmed === '') {
      setFormError('Enter a workspace name.');
      return;
    }

    setCreating(true);
    setFormError('');
    try {
      const created = await createWorkspace(trimmed);
      setName('');
      // Straight in: creating a workspace is an act of intent to use it.
      onOpen(created);
    } catch (error: unknown) {
      setFormError(error instanceof Error ? error.message : 'Could not create the workspace.');
    } finally {
      setCreating(false);
    }
  }

  return (
    <main className="min-h-screen bg-canvas">
      <div className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center gap-8 px-6 py-16">
        <header className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <span
              aria-hidden="true"
              className="grid h-10 w-10 place-items-center rounded-lg bg-accent text-base font-bold text-white"
            >
              H
            </span>
            <div>
              <p className="text-base font-semibold text-ink">Hybrid Control</p>
              <p className="text-sm text-ink-muted">AI Agent Control Plane</p>
            </div>
          </div>
          <div className="text-right">
            <p className="text-sm text-ink" title={email}>
              {email}
            </p>
            <button
              type="button"
              onClick={onSignOut}
              className="mt-0.5 text-sm text-ink-muted hover:text-ink hover:underline"
            >
              Sign out
            </button>
          </div>
        </header>

        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">Choose a workspace</h1>
          <p className="mt-1.5 text-sm text-ink-muted">
            Select an existing workspace or create one to start monitoring your agents.
          </p>
        </div>

        <Card>
          {state.status === 'loading' && <LoadingState label="Loading workspaces…" />}
          {state.status === 'error' && <ErrorState message={state.message} />}

          {state.status === 'ready' &&
            (state.workspaces.length === 0 ? (
              <EmptyState
                title="No workspaces yet"
                description="Create your first workspace below. It becomes the boundary every agent, policy and audit record lives inside."
              />
            ) : (
              <ul className="divide-y divide-line">
                {state.workspaces.map((workspace) => (
                  <li key={workspace.id}>
                    <button
                      type="button"
                      onClick={() => {
                        onOpen(workspace);
                      }}
                      className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left transition-colors hover:bg-canvas"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-ink">
                          {workspace.name}
                        </span>
                        <span className="mt-0.5 block text-xs text-ink-faint">
                          Joined as {workspace.role}
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-3">
                        <Badge tone={workspace.role === 'operator' ? 'accent' : 'neutral'}>
                          {workspace.role === 'operator' ? 'Operator' : 'Member'}
                        </Badge>
                        <span aria-hidden="true" className="text-ink-faint">
                          →
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ))}
        </Card>

        <Card className="p-5">
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(event) => {
              void onCreate(event);
            }}
          >
            <div className="min-w-56 flex-1">
              <Field label="New workspace" htmlFor="workspace-name">
                <input
                  id="workspace-name"
                  value={name}
                  onChange={(event) => {
                    setName(event.target.value);
                  }}
                  placeholder="Acme Production"
                  disabled={creating}
                  className={inputClass}
                />
              </Field>
            </div>
            <Button type="submit" tone="primary" disabled={creating}>
              {creating ? 'Creating…' : 'Create workspace'}
            </Button>
          </form>
          {formError !== '' && (
            <p role="alert" className="mt-3 text-sm text-deny">
              {formError}
            </p>
          )}
        </Card>
      </div>
    </main>
  );
}
