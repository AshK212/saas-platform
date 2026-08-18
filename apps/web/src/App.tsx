import {
  AUTH_CALLBACK_RESULT_PARAM,
  authCallbackResultSchema,
  type CurrentUserResponse,
  type WorkspaceSummary,
} from '@hybrid/contracts';
import { useEffect, useState, type JSX } from 'react';

import { fetchCurrentUser, logout } from './api';
import { DemoView } from './DemoView';
import { SharedView } from './SharedView';
import { SignIn } from './SignIn';
import { WorkspaceApp } from './WorkspaceApp';
import { WorkspacePicker } from './WorkspacePicker';

/**
 * Application root.
 *
 * Decides which of four experiences the visitor gets, in strict order:
 *
 *   1. a public SHARED view      (/share/:token)   - no session consulted
 *   2. a public DEMO view        (/demo/:slug)     - no session consulted
 *   3. sign-in                   (no session)
 *   4. the workspace application (signed in)
 *
 * The two public surfaces are matched on pathname BEFORE any authenticated
 * request is made, because both must render for a visitor who has no session
 * and must never be redirected to a login screen.
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

/**
 * Reads a public demo slug from `/demo/<slug>`.
 *
 * Read once during initialisation, before any authenticated request. A public
 * demo must render for a visitor with no session, so the shell must not try to
 * sign anyone in first.
 *
 * Unlike a share token this is NOT stripped from the URL: the slug is public
 * by design and a bookmarkable address is the point.
 */
function readDemoSlug(): string | null {
  const match = /^\/demo\/([^/?#]+)/.exec(window.location.pathname);
  return match?.[1] === undefined ? null : decodeURIComponent(match[1]);
}

export function App(): JSX.Element {
  // Captured before anything else: the SharedView strips it from the URL.
  const [shareToken] = useState(readShareToken);
  const [demoSlug] = useState(readDemoSlug);
  const [auth, setAuth] = useState<AuthState>({ status: 'loading' });
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [openWorkspaceId, setOpenWorkspaceId] = useState<string | null>(null);
  const callbackResult = useCallbackResult();

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
    // Every trace of the previous session's context goes with it.
    setOpenWorkspaceId(null);
    setWorkspaces([]);
    const user = await fetchCurrentUser();
    setAuth(user === null ? { status: 'signed-out' } : { status: 'signed-in', user });
  }

  // THE PUBLIC SHARED VIEW. Returned before any session is consulted, so the
  // page renders with no login and no operator chrome whatsoever.
  if (shareToken !== null) {
    return <SharedView token={shareToken} />;
  }

  // THE PUBLIC DEMO. Also returned before any session is consulted.
  if (demoSlug !== null) {
    return <DemoView slug={demoSlug} />;
  }

  if (auth.status === 'loading') {
    return (
      <main className="grid min-h-screen place-items-center bg-canvas">
        <p role="status" aria-live="polite" className="text-sm text-ink-muted">
          Loading…
        </p>
      </main>
    );
  }

  if (auth.status === 'signed-out') {
    return <SignIn invalidLink={callbackResult === 'invalid_link'} />;
  }

  const open = workspaces.find((workspace) => workspace.id === openWorkspaceId) ?? null;

  if (open === null) {
    return (
      <WorkspacePicker
        email={auth.user.email}
        onOpen={(workspace) => {
          // The picker already holds the authorized summary; keeping it here
          // avoids a second round trip just to learn the name and role.
          setWorkspaces((current) =>
            current.some((entry) => entry.id === workspace.id) ? current : [...current, workspace],
          );
          setOpenWorkspaceId(workspace.id);
        }}
        onSignOut={() => {
          void onSignOut();
        }}
      />
    );
  }

  return (
    <WorkspaceApp
      workspace={open}
      workspaces={workspaces}
      email={auth.user.email}
      onSwitchWorkspace={setOpenWorkspaceId}
      onSignOut={() => {
        void onSignOut();
      }}
    />
  );
}
