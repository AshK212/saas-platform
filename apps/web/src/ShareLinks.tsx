import type { ShareLinkSummary } from '@hybrid/contracts';
import { useEffect, useState, type JSX } from 'react';

import { createShareLink, listShareLinks, revokeShareLink } from './api';

/**
 * Share-link management (AC-18) - OPERATOR ONLY.
 *
 * ─── SHOW ONCE, AND MEAN IT ───────────────────────────────────────────────
 *
 * The plaintext URL is rendered exactly once, immediately after issuance, and
 * held only in this component's state until the panel is dismissed. It is
 * never written to localStorage, never re-fetched, and never reconstructable
 * from the list - the server kept only a digest, so there is no endpoint that
 * could return it and none can be added.
 *
 * The copy is the operator's responsibility. A lost link is revoked and
 * reissued, which is cheap; a recoverable secret is not.
 *
 * ─── WHY THE WARNING IS BLUNT ─────────────────────────────────────────────
 *
 * A share link is an unauthenticated door into the workspace. Anyone holding
 * the URL can read the fleet, the timeline and the governance record without
 * signing in. The copy below says that plainly rather than reassuring.
 */

interface ShareLinksProps {
  readonly workspaceId: string;
  /** False for `member`: links are listed but cannot be created or revoked. */
  readonly canManage: boolean;
}

export function ShareLinks({ workspaceId, canManage }: ShareLinksProps): JSX.Element {
  const [links, setLinks] = useState<ShareLinkSummary[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  /** The one-time plaintext URL. Cleared on dismiss and never re-derived. */
  const [issuedUrl, setIssuedUrl] = useState<string | null>(null);

  async function refresh(): Promise<void> {
    try {
      setLinks(await listShareLinks(workspaceId));
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : 'Something went wrong.');
    }
  }

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const loaded = await listShareLinks(workspaceId);
        if (!cancelled) setLinks(loaded);
      } catch {
        if (!cancelled) setLinks([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  async function onCreate(): Promise<void> {
    setBusy(true);
    setError('');
    try {
      const created = await createShareLink(workspaceId);
      // Built HERE, from the plaintext, and nowhere else. The list endpoint
      // cannot reconstruct this.
      setIssuedUrl(`${window.location.origin}/share/${created.token}`);
      await refresh();
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  async function onRevoke(shareId: string): Promise<void> {
    setBusy(true);
    setError('');
    try {
      await revokeShareLink(workspaceId, shareId);
      await refresh();
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h3 className="text-base font-medium">Share links</h3>
        <p className="max-w-prose text-sm text-slate-400">
          A share link gives read-only access to this workspace to anyone who has the URL, without
          signing in. Revoking a link ends that access immediately.
        </p>
      </div>

      {error !== '' && (
        <p role="alert" className="text-sm text-red-400">
          {error}
        </p>
      )}

      {issuedUrl !== null && (
        <div className="space-y-2 rounded-md border border-amber-900 bg-amber-950/30 px-4 py-3">
          <p className="text-sm font-medium text-amber-200">
            Copy this link now &mdash; it will not be shown again.
          </p>
          <p className="break-all rounded bg-slate-950 px-3 py-2 font-mono text-xs text-slate-200">
            {issuedUrl}
          </p>
          <p className="text-xs text-amber-200/80">
            Anyone with this URL can read this workspace. Store it somewhere you would store a
            password. If you lose it, revoke the link and create another.
          </p>
          <button
            type="button"
            onClick={() => {
              setIssuedUrl(null);
            }}
            className="rounded-md border border-amber-800 px-3 py-1.5 text-xs text-amber-100 hover:bg-amber-900/40"
          >
            I have copied it
          </button>
        </div>
      )}

      {canManage && (
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            void onCreate();
          }}
          className="rounded-md border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:bg-slate-800 disabled:opacity-60"
        >
          {busy ? 'Working…' : 'Create share link'}
        </button>
      )}

      {links !== null && links.length === 0 && (
        <p className="text-sm text-slate-500">No share links yet.</p>
      )}

      {links !== null && links.length > 0 && (
        <ul className="divide-y divide-slate-800 rounded-md border border-slate-800">
          {links.map((link) => (
            <li key={link.id} className="flex items-center justify-between gap-4 px-4 py-3">
              <span className="min-w-0">
                {/* The prefix is independent random material, not part of the
                    secret. It exists so two links can be told apart. */}
                <span className="block truncate font-mono text-xs text-slate-300">
                  {link.tokenPrefix}…
                </span>
                <span className="block text-xs text-slate-500">
                  {link.revokedAt === null
                    ? `Active · created ${new Date(link.createdAt).toLocaleString()}`
                    : `Revoked ${new Date(link.revokedAt).toLocaleString()}`}
                </span>
              </span>
              {canManage && link.revokedAt === null && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    void onRevoke(link.id);
                  }}
                  className="shrink-0 rounded-md border border-red-900 px-3 py-1.5 text-xs text-red-300 hover:bg-red-950/40 disabled:opacity-60"
                >
                  Revoke
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
