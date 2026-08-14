import {
  AUTH_CALLBACK_RESULT_PARAM,
  authCallbackResultSchema,
  CONTRACTS_VERSION,
  PLATFORM_NAME,
  type CurrentUserResponse,
} from '@hybrid/contracts';
import { useCallback, useEffect, useState, type JSX } from 'react';

import { fetchCurrentUser, logout } from './api';
import { SharedView } from './SharedView';
import { SignIn } from './SignIn';
import { Workspaces } from './Workspaces';

/**
 * Application shell.
 *
 * STEP 5 SCOPE
 * ------------
 * Enough UI to prove the authentication flow end to end: request a link, land
 * back from the callback, see the signed-in identity, sign out.
 *
 * There is deliberately no dashboard, no workspace picker, no fleet data, no
 * policy UI and no charts. Being signed in grants access to no workspace -
 * workspace selection is Step 6.
 */

type AuthState =
  | { status: 'loading' }
  | { status: 'signed-out' }
  | { status: 'signed-in'; user: CurrentUserResponse['user'] };

/**
 * Reads and then strips the callback outcome from the address bar.
 *
 * The API already redirected to a token-free URL; this additionally removes the
 * outcome marker via `replaceState`, so a refresh or a shared URL carries no
 * authentication artefacts at all.
 */
function readCallbackResult(): 'success' | 'invalid_link' | null {
  const raw = new URLSearchParams(window.location.search).get(AUTH_CALLBACK_RESULT_PARAM);
  if (raw === null) {
    return null;
  }
  const parsed = authCallbackResultSchema.safeParse(raw);
  // An unrecognised value is treated as a failure rather than ignored.
  return parsed.success ? parsed.data : 'invalid_link';
}

function useCallbackResult(): 'success' | 'invalid_link' | null {
  // Read once during initialisation. Deriving it in an effect would set state
  // during the first commit and trigger a cascading render.
  const [result] = useState(readCallbackResult);

  useEffect(() => {
    // The effect only updates an external system (the address bar), never state.
    const params = new URLSearchParams(window.location.search);
    if (!params.has(AUTH_CALLBACK_RESULT_PARAM)) {
      return;
    }
    params.delete(AUTH_CALLBACK_RESULT_PARAM);
    const query = params.toString();
    window.history.replaceState(
      {},
      '',
      `${window.location.pathname}${query === '' ? '' : `?${query}`}`,
    );
  }, []);

  return result;
}

/**
 * Reads a share token from `/share/<token>`.
 *
 * Read ONCE during initialisation, before any authenticated request is made.
 * A shared view must work in a private window with no session, so the shell
 * must not try to sign anyone in first.
 */
function readShareToken(): string | null {
  const match = /^\/share\/([^/?#]+)/.exec(window.location.pathname);
  return match?.[1] === undefined ? null : decodeURIComponent(match[1]);
}

export function App(): JSX.Element {
  // Captured before anything else: the SharedView strips it from the URL.
  const [shareToken] = useState(readShareToken);
  const [auth, setAuth] = useState<AuthState>({ status: 'loading' });
  const callbackResult = useCallbackResult();

  const refresh = useCallback(async () => {
    const user = await fetchCurrentUser();
    setAuth(user === null ? { status: 'signed-out' } : { status: 'signed-in', user });
  }, []);

  useEffect(() => {
    // State is set only after the await resolves, and only if this component is
    // still mounted - so no synchronous set during the effect, and no update
    // against an unmounted tree.
    let cancelled = false;

    void (async () => {
      const user = await fetchCurrentUser();
      if (!cancelled) {
        setAuth(user === null ? { status: 'signed-out' } : { status: 'signed-in', user });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  async function onSignOut(): Promise<void> {
    await logout();
    await refresh();
  }

  // THE PUBLIC SHARED VIEW. Returned before any session is consulted, so the
  // page renders with no login and no operator chrome whatsoever.
  if (shareToken !== null) {
    return <SharedView token={shareToken} />;
  }

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-8 px-6 py-16">
        <header className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-[0.2em] text-slate-400">
            Credit Phase &middot; Step 11 Event Timeline
          </p>
          <h1 className="text-3xl font-semibold tracking-tight">{PLATFORM_NAME}</h1>
        </header>

        {callbackResult === 'invalid_link' && (
          <p role="alert" className="rounded-md border border-red-900 bg-red-950/40 px-4 py-3 text-sm text-red-300">
            That sign-in link is no longer valid. Links can be used once and expire after 15
            minutes. Request a new one below.
          </p>
        )}

        <section className="rounded-lg border border-slate-800 bg-slate-900/40 p-6">
          {auth.status === 'loading' && <p className="text-sm text-slate-400">Loading…</p>}

          {auth.status === 'signed-out' && <SignIn />}

          {auth.status === 'signed-in' && (
            <div className="space-y-4">
              <div className="space-y-1">
                <h2 className="text-lg font-medium">Signed in</h2>
                <p className="font-mono text-sm text-slate-300">{auth.user.email}</p>
              </div>
              <p className="max-w-prose text-sm text-slate-400">
                Being signed in authorizes no workspace on its own. Every workspace action below
                is re-checked against your membership by the server.
              </p>
              <button
                type="button"
                onClick={() => {
                  void onSignOut();
                }}
                className="rounded-md border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:bg-slate-800"
              >
                Sign out
              </button>
            </div>
          )}
        </section>

        {auth.status === 'signed-in' && (
          <section className="rounded-lg border border-slate-800 bg-slate-900/40 p-6">
            <Workspaces />
          </section>
        )}

        <footer className="border-t border-slate-800 pt-6 text-sm text-slate-500">
          Contracts v{CONTRACTS_VERSION} &middot; business features are intentionally not
          implemented yet.
        </footer>
      </div>
    </main>
  );
}
