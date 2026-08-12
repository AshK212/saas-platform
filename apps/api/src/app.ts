import { Hono } from 'hono';

import { createHealthRoutes } from './routes/health.js';
import { createReadinessRoutes, type DatabaseReadinessProbe } from './routes/ready.js';

/**
 * Everything the application needs from the outside world.
 *
 * Dependencies are explicit and required so that wiring is visible at the call
 * site, and so no route can quietly reach for a global client.
 */
export interface AppDependencies {
  /** Reports database readiness. Must resolve; failures are reported, not thrown. */
  readonly probeDatabase: DatabaseReadinessProbe;
}

/**
 * Composes the control-plane API.
 *
 * Route groups are mounted here and implemented in `src/routes/*`. This keeps
 * the server entry point free of routing detail and lets later steps add
 * governance surfaces without growing a single large file.
 *
 * STEP 2 SCOPE
 * ------------
 * Liveness and readiness only. Authentication, workspaces, API keys, agents,
 * events, policies, prechecks, ledger, receipts, sharing and demo surfaces are
 * intentionally absent and belong to later steps.
 */
export function createApp(dependencies: AppDependencies): Hono {
  const app = new Hono();

  // Liveness is mounted with no dependencies at all - that independence is the
  // point of the endpoint, and is asserted by tests.
  app.route('/', createHealthRoutes());
  app.route('/', createReadinessRoutes(dependencies.probeDatabase));

  return app;
}
