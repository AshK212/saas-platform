import { CONTRACTS_VERSION, PLATFORM_NAME } from '@hybrid/contracts';
import type { JSX } from 'react';

/**
 * Application shell.
 *
 * STEP 1 SCOPE
 * ------------
 * This exists to prove the frontend toolchain (React + Vite + Tailwind +
 * workspace package resolution) compiles and builds. It deliberately contains
 * no dashboard, no fleet data, no policy UI, no charts and no authentication.
 * Those arrive in their own steps.
 */
export function App(): JSX.Element {
  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center gap-6 px-6 py-16">
        <p className="text-xs font-medium uppercase tracking-[0.2em] text-slate-400">
          Credit Phase &middot; Step 1 Foundation
        </p>

        <h1 className="text-4xl font-semibold tracking-tight">{PLATFORM_NAME}</h1>

        <p className="max-w-prose text-slate-300">
          Control-plane foundation. The toolchain, workspace boundaries and build path are in
          place; product functionality is intentionally not implemented yet.
        </p>

        <dl className="grid gap-3 border-t border-slate-800 pt-6 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-slate-400">Shared contracts</dt>
            <dd className="font-mono text-slate-200">v{CONTRACTS_VERSION}</dd>
          </div>
          <div>
            <dt className="text-slate-400">API liveness</dt>
            <dd className="font-mono text-slate-200">GET /healthz</dd>
          </div>
        </dl>
      </div>
    </main>
  );
}
