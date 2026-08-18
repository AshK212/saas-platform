import type { ApiKeySummary, IssuedApiKey } from '@hybrid/contracts';
import { useEffect, useState, type FormEvent, type JSX } from 'react';

import { createApiKey, listApiKeys, revokeApiKey } from './api';

/**
 * Workspace API-key management.
 *
 * SHOW-ONCE HANDLING
 * ------------------
 * The plaintext key returned by issuance lives in ONE piece of transient React
 * state (`issued`). It is never written to localStorage, sessionStorage or
 * IndexedDB, never placed in the URL, and is dropped on dismiss or reload.
 * There is no retrieval endpoint, so once it is gone it is gone - the only
 * remedy is to revoke and issue a new one.
 *
 * Only operators can manage credentials; a `member` sees a clear message rather
 * than a broken screen.
 */

interface ApiKeysProps {
  readonly workspaceId: string;
  readonly canManage: boolean;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; keys: ApiKeySummary[] }
  | { status: 'error'; message: string };

export function ApiKeys({ workspaceId, canManage }: ApiKeysProps): JSX.Element {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  /** The one and only place plaintext exists on the client. */
  const [issued, setIssued] = useState<IssuedApiKey | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      if (!canManage) {
        if (!cancelled) {
          setState({ status: 'ready', keys: [] });
        }
        return;
      }
      try {
        const keys = await listApiKeys(workspaceId);
        if (!cancelled) {
          setState({ status: 'ready', keys });
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
  }, [workspaceId, canManage]);

  async function reload(): Promise<void> {
    try {
      setState({ status: 'ready', keys: await listApiKeys(workspaceId) });
    } catch (caught: unknown) {
      setState({
        status: 'error',
        message: caught instanceof Error ? caught.message : 'Something went wrong.',
      });
    }
  }

  async function onCreate(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError('');
    setCopied(false);
    try {
      const apiKey = await createApiKey(workspaceId, name);
      setName('');
      setIssued(apiKey);
      await reload();
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  async function onRevoke(credentialId: string): Promise<void> {
    setError('');
    try {
      await revokeApiKey(workspaceId, credentialId);
      await reload();
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : 'Something went wrong.');
    }
  }

  async function onCopy(): Promise<void> {
    if (issued === null) {
      return;
    }
    try {
      // Explicit user action only - nothing is copied automatically.
      await navigator.clipboard.writeText(issued.key);
      setCopied(true);
    } catch {
      // Never surface the key in an error message or a log.
      setError('Could not copy automatically. Select the key and copy it manually.');
    }
  }

  if (!canManage) {
    return (
      <p className="text-sm text-ink-muted">
        Only workspace operators can view and manage API keys.
      </p>
    );
  }

  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight text-ink">API keys</h1>
        <p className="max-w-prose text-sm text-ink-muted">
          Keys authenticate agents and the simulator. They are bound to this workspace and cannot
          reach any other.
        </p>
      </div>

      {issued !== null && (
        <div className="space-y-3 rounded-md border border-line-strong bg-warn-soft p-4">
          <p className="text-sm font-medium text-warn">
            Copy this key now. It will not be shown again.
          </p>
          <code className="block break-all rounded bg-canvas px-3 py-2 font-mono text-xs text-ink">
            {issued.key}
          </code>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => {
                void onCopy();
              }}
              className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white"
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
            <button
              type="button"
              onClick={() => {
                // Dropping the state is what makes it unrecoverable.
                setIssued(null);
                setCopied(false);
              }}
              className="rounded-md border border-line-strong px-3 py-1.5 text-sm text-ink"
            >
              Done
            </button>
          </div>
        </div>
      )}

      {state.status === 'loading' && <p className="text-sm text-ink-muted">Loading keys…</p>}

      {state.status === 'error' && (
        <p role="alert" className="text-sm text-deny">
          {state.message}
        </p>
      )}

      {state.status === 'ready' && state.keys.length > 0 && (
        <ul className="divide-y divide-line rounded-md border border-line">
          {state.keys.map((key) => (
            <li key={key.id} className="flex items-center justify-between gap-4 px-4 py-3">
              <span className="min-w-0">
                <span className="block truncate text-sm text-ink">{key.name}</span>
                <span className="block font-mono text-xs text-ink-faint">{key.keyPrefix}…</span>
                <span className="text-xs uppercase tracking-wide text-ink-faint">
                  {key.status}
                  {key.lastUsedAt !== null && ` · last used ${key.lastUsedAt.slice(0, 10)}`}
                </span>
              </span>
              {key.status === 'active' ? (
                <button
                  type="button"
                  onClick={() => {
                    void onRevoke(key.id);
                  }}
                  className="shrink-0 rounded-md border border-line-strong px-3 py-1.5 text-sm text-deny hover:bg-deny-soft"
                >
                  Revoke
                </button>
              ) : (
                <span className="shrink-0 text-xs text-ink-faint">revoked</span>
              )}
            </li>
          ))}
        </ul>
      )}

      {state.status === 'ready' && state.keys.length === 0 && (
        <p className="text-sm text-ink-faint">No API keys yet.</p>
      )}

      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          void onCreate(event);
        }}
      >
        <div className="min-w-0 flex-1 space-y-2">
          <label htmlFor="api-key-name" className="block text-sm text-ink-muted">
            New key name
          </label>
          <input
            id="api-key-name"
            type="text"
            required
            maxLength={120}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
            className="w-full rounded-md border border-line-strong bg-surface px-3 py-2 text-ink outline-none focus:border-accent"
            placeholder="Simulator"
          />
        </div>
        <button
          type="submit"
          disabled={busy}
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
        >
          {busy ? 'Creating…' : 'Create key'}
        </button>
      </form>

      {error !== '' && (
        <p role="alert" className="text-sm text-deny">
          {error}
        </p>
      )}
    </div>
  );
}
