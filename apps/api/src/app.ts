import { Hono } from 'hono';
import { cors } from 'hono/cors';

import type { AgentStore } from './agents/store.js';
import type { ApiKeyStore } from './api-keys/store.js';
import { systemClock, type Clock } from './auth/clock.js';
import type { AuthService } from './auth/service.js';
import type { EventReadStore } from './events/read-store.js';
import type { EventIngestStore } from './events/store.js';
import { createAgentPolicyRoutes } from './routes/agent-policy.js';
import { createAgentRoutes } from './routes/agents.js';
import { createEventRoutes } from './routes/events.js';
import { createPolicyRoutes } from './routes/policy.js';
import { createTimelineRoutes } from './routes/timeline.js';
import type { PolicyMutationStore } from './policy/mutation-store.js';
import type { PolicyStore } from './policy/store.js';
import { createApiKeyRoutes } from './routes/api-keys.js';
import { createAuthRoutes } from './routes/auth.js';
import { createHealthRoutes } from './routes/health.js';
import { createReadinessRoutes, type DatabaseReadinessProbe } from './routes/ready.js';
import { createWorkspaceRoutes } from './routes/workspaces.js';
import { buildAllowedOrigins, originGuard } from './security/origin.js';
import type { WorkspaceStore } from './workspaces/store.js';

/**
 * Everything the application needs from the outside world.
 *
 * Dependencies are explicit and required so that wiring is visible at the call
 * site, and so no route can quietly reach for a global client.
 */
export interface AppDependencies {
  /** Reports database readiness. Must resolve; failures are reported, not thrown. */
  readonly probeDatabase: DatabaseReadinessProbe;

  /**
   * Authentication service. `undefined` when the database is not configured -
   * auth routes then answer 503 while liveness stays unaffected.
   */
  readonly authService?: AuthService | undefined;

  /** Absolute browser-app origin, used for the post-callback redirect. */
  readonly appUrl?: string | undefined;

  /** True in production; drives the cookie Secure attribute. */
  readonly secureCookies?: boolean;

  /**
   * Explicit cross-origin allowlist for the browser app.
   *
   * Left undefined in the preferred same-site deployment, where the web app and
   * API share an origin and no CORS is involved at all. When set, exactly one
   * origin is allowed with credentials - never a wildcard, which browsers
   * reject alongside credentials anyway.
   */
  readonly webOrigin?: string | undefined;

  /**
   * Workspace persistence. `undefined` when the database is unconfigured -
   * those routes then answer 503 while liveness stays unaffected.
   */
  readonly workspaceStore?: WorkspaceStore | undefined;

  /**
   * API-credential persistence. `undefined` when the database is unconfigured -
   * those routes then answer 503 while liveness stays unaffected.
   */
  readonly apiKeyStore?: ApiKeyStore | undefined;

  /**
   * Agent registry persistence. `undefined` when the database is unconfigured -
   * those routes then answer 503 while liveness stays unaffected.
   */
  readonly agentStore?: AgentStore | undefined;

  /**
   * Event ingest persistence. `undefined` when the database is unconfigured -
   * `POST /v1/events` then answers 503 while liveness stays unaffected.
   */
  readonly eventStore?: EventIngestStore | undefined;

  /**
   * Event timeline reads. `undefined` when the database is unconfigured -
   * those routes then answer 503 while liveness stays unaffected.
   *
   * Separate from `eventStore`: ingest is machine-authenticated and writes,
   * this is operator-authenticated and only reads.
   */
  readonly eventReadStore?: EventReadStore | undefined;

  /**
   * Policy reads for machine polling. `undefined` when the database is
   * unconfigured - `GET /v1/policy` then answers 503 while liveness stays
   * unaffected.
   *
   * Read-only by construction: there is no policy writer anywhere in Step 12.
   */
  readonly policyStore?: PolicyStore | undefined;

  /**
   * Operator policy WRITES. `undefined` when the database is unconfigured.
   *
   * The only policy writer wired into the application. It is deliberately a
   * separate dependency from `policyStore`, so the machine polling route
   * cannot reach a mutator.
   */
  readonly policyMutationStore?: PolicyMutationStore | undefined;

  /** Time source. Injectable so credential tests can control timestamps. */
  readonly clock?: Clock;
}

/**
 * Composes the control-plane API.
 *
 * STEP 13 SCOPE
 * -------------
 * Liveness, readiness, authentication, workspace membership authorization,
 * workspace API credentials, the agent registry, idempotent event INGEST, the
 * operator event TIMELINE and raw detail, machine policy POLLING, and operator
 * policy MUTATION.
 *
 * Prechecks, the ledger, receipts, enforcement of any kind, exports, rollups,
 * sharing and demo are intentionally absent. Exactly one route writes policy,
 * and it requires a browser session and the `operator` role.
 */
export function createApp(dependencies: AppDependencies): Hono {
  const app = new Hono();

  /**
   * Uniform failure response.
   *
   * Hono's default handler returns the raw error text, which for a database
   * failure can carry SQL, table names or a connection target. Every unhandled
   * error therefore collapses to one opaque JSON body. The error itself is
   * deliberately not logged here - structured logging arrives with the
   * observability step, and an ad-hoc `console.error(error)` would be exactly
   * the sort of thing that leaks a query containing tenant data.
   */
  app.onError((_error, c) => c.json({ error: 'internal_error' }, 500));

  // Same-site deployment needs no CORS; this activates only when an explicit
  // browser origin is configured.
  if (dependencies.webOrigin !== undefined) {
    app.use(
      '/v1/*',
      cors({
        origin: dependencies.webOrigin,
        credentials: true,
        allowMethods: ['GET', 'POST', 'OPTIONS'],
        allowHeaders: ['content-type'],
      }),
    );
  }

  // CSRF: reject cross-origin state-changing requests before any handler runs.
  // Mounted on /v1/* only - /healthz and /readyz are safe GETs and must stay
  // reachable by uptime probes that send no Origin.
  app.use(
    '/v1/*',
    originGuard({
      allowedOrigins: buildAllowedOrigins(dependencies.appUrl, dependencies.webOrigin),
    }),
  );

  // Liveness is mounted with no dependencies at all - that independence is the
  // point of the endpoint, and is asserted by tests.
  app.route('/', createHealthRoutes());
  app.route('/', createReadinessRoutes(dependencies.probeDatabase));
  app.route(
    '/',
    createAuthRoutes({
      service: dependencies.authService,
      appUrl: dependencies.appUrl,
      secureCookies: dependencies.secureCookies ?? false,
    }),
  );
  app.route(
    '/',
    createWorkspaceRoutes({
      store: dependencies.workspaceStore,
      authService: dependencies.authService,
    }),
  );
  app.route(
    '/',
    createApiKeyRoutes({
      apiKeyStore: dependencies.apiKeyStore,
      workspaceStore: dependencies.workspaceStore,
      authService: dependencies.authService,
      clock: dependencies.clock ?? systemClock,
    }),
  );
  app.route(
    '/',
    createAgentRoutes({
      agentStore: dependencies.agentStore,
      apiKeyStore: dependencies.apiKeyStore,
      workspaceStore: dependencies.workspaceStore,
      authService: dependencies.authService,
      clock: dependencies.clock ?? systemClock,
    }),
  );
  app.route(
    '/',
    createEventRoutes({
      eventStore: dependencies.eventStore,
      apiKeyStore: dependencies.apiKeyStore,
      clock: dependencies.clock ?? systemClock,
    }),
  );
  app.route(
    '/',
    createPolicyRoutes({
      policyStore: dependencies.policyStore,
      apiKeyStore: dependencies.apiKeyStore,
      clock: dependencies.clock ?? systemClock,
    }),
  );
  app.route(
    '/',
    createAgentPolicyRoutes({
      policyMutationStore: dependencies.policyMutationStore,
      workspaceStore: dependencies.workspaceStore,
      authService: dependencies.authService,
    }),
  );
  app.route(
    '/',
    createTimelineRoutes({
      eventReadStore: dependencies.eventReadStore,
      workspaceStore: dependencies.workspaceStore,
      authService: dependencies.authService,
    }),
  );

  return app;
}
