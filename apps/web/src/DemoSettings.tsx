import type { DemoSettings as DemoSettingsValue } from '@hybrid/contracts';
import { useEffect, useState, type JSX } from 'react';

import { fetchDemoSettings, setDemoEnabled } from './api';

/**
 * Public demo mode (AC-19) - OPERATOR ONLY.
 *
 * ─── THE COPY IS BLUNT ON PURPOSE ─────────────────────────────────────────
 *
 * This is the only control in the product that makes a private tenant readable
 * by anyone on the internet with no sign-in. Not a link handed to one person -
 * a page. The wording says that plainly rather than reassuring, because an
 * operator who misreads this switch cannot un-publish what was already seen.
 *
 * ─── DISABLING RETIRES THE URL ────────────────────────────────────────────
 *
 * The schema forbids a slug on a private workspace, so turning the demo off
 * clears it and turning it back on mints a new one. That is stated here rather
 * than left to be discovered, because an operator who expects the old URL to
 * resume will otherwise think something is broken.
 *
 * Pressing enable while already enabled keeps the existing slug: that is not a
 * request for a new address.
 */

interface DemoSettingsProps {
  readonly workspaceId: string;
  /** False for `member`: the state is visible but the switch is not. */
  readonly canManage: boolean;
}

export function DemoSettingsPanel({ workspaceId, canManage }: DemoSettingsProps): JSX.Element {
  const [demo, setDemo] = useState<DemoSettingsValue | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const loaded = await fetchDemoSettings(workspaceId);
      if (!cancelled) {
        setDemo(loaded);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  async function onToggle(enabled: boolean): Promise<void> {
    setBusy(true);
    setError('');
    try {
      setDemo(await setDemoEnabled(workspaceId, enabled));
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  const publicUrl =
    demo?.slug === null || demo?.slug === undefined
      ? null
      : `${window.location.origin}/demo/${demo.slug}`;

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight text-ink">Public demo</h1>
        <p className="max-w-prose text-sm text-ink-muted">
          Public demo mode makes this workspace readable by <strong>anyone</strong> with the URL,
          with no sign-in. It is read-only &mdash; no policy, credential or workspace changes are
          possible through it &mdash; but the fleet, spend totals, events and blocks are all
          visible.
        </p>
      </div>

      {error !== '' && (
        <p role="alert" className="text-sm text-deny">
          {error}
        </p>
      )}

      {demo === null ? (
        <p className="text-sm text-ink-muted">Loading…</p>
      ) : (
        <div className="space-y-3">
          <p className="text-sm">
            Status:{' '}
            <span className={demo.enabled ? 'text-ok' : 'text-ink-muted'}>
              {demo.enabled ? 'Public' : 'Private'}
            </span>
          </p>

          {demo.enabled && publicUrl !== null && (
            <div className="space-y-2 rounded-md border border-emerald-900 bg-emerald-950/20 px-4 py-3">
              <p className="text-xs text-emerald-200/80">
                Anyone with this address can read this workspace.
              </p>
              <p className="break-all rounded bg-canvas px-3 py-2 font-mono text-xs text-ink">
                {publicUrl}
              </p>
            </div>
          )}

          {canManage && (
            <div className="space-y-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  void onToggle(!demo.enabled);
                }}
                className={`rounded-md border px-4 py-2 text-sm disabled:opacity-60 ${
                  demo.enabled
                    ? 'border-line-strong text-deny hover:bg-deny-soft'
                    : 'border-line-strong text-ink hover:bg-canvas'
                }`}
              >
                {busy ? 'Working…' : demo.enabled ? 'Turn off public demo' : 'Turn on public demo'}
              </button>
              <p className="max-w-prose text-xs text-ink-faint">
                Turning the demo off retires its address. Turning it back on creates a new one, so
                any URL you have already shared stays dead.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
