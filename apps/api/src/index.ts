import { serve } from '@hono/node-server';
import { loadServerConfig, type ServerConfig } from '@hybrid/config/server';
import {
  checkDatabaseReadiness,
  closeDatabasePool,
  createDatabaseClient,
  createDatabasePool,
  describeConnectionTarget,
  type DatabasePool,
} from '@hybrid/db';
import { AUTH_CALLBACK_PATH } from '@hybrid/contracts';

import { createApp } from './app.js';
import { systemClock } from './auth/clock.js';
import { createResendEmailSender } from './auth/email.js';
import { createAuthService, type AuthService } from './auth/service.js';
import { createDrizzleAgentStore } from './agents/store.js';
import { createDrizzleApiKeyStore } from './api-keys/store.js';
import { createDrizzleAuthStore } from './auth/store.js';
import { createDrizzleEventReadStore } from './events/read-store.js';
import { createDrizzlePolicyMutationStore } from './policy/mutation-store.js';
import { createDrizzlePolicyStore } from './policy/store.js';
import { createDrizzlePrecheckStore } from './precheck/store.js';
import { createDrizzleEventIngestStore } from './events/store.js';
import { createDrizzleWorkspaceStore } from './workspaces/store.js';
import { type DatabaseReadinessProbe } from './routes/ready.js';

/**
 * Server entry point.
 *
 * Separated from `createApp()` so the application can be exercised in tests
 * without binding a port or touching a database.
 */

/* eslint-disable no-console -- process entry point; stdout is its only log sink until the observability step */

/**
 * Builds the pool only when a database is actually configured.
 *
 * `pg.Pool` connects lazily, so this never blocks startup or fails a deploy on
 * an unreachable database - it is a readiness concern, not a liveness one.
 */
function createPoolIfConfigured(config: ServerConfig): DatabasePool | undefined {
  if (config.databaseUrl === undefined) {
    console.warn('[api] DATABASE_URL is not configured; /readyz will report "unconfigured".');
    return undefined;
  }

  // Only ever log the redacted target, never the connection string.
  console.log(`[api] database target ${describeConnectionTarget(config.databaseUrl)}`);

  return createDatabasePool({
    connectionString: config.databaseUrl,
    applicationName: 'hybrid-api',
    onPoolError: (message) => {
      console.error(`[api] database pool error: ${message}`);
    },
  });
}

/**
 * Wires authentication when its prerequisites exist.
 *
 * Auth needs a database, an application origin and a verified sender. If any is
 * missing the service is simply absent and the auth routes answer 503 - the
 * process still starts and `/healthz` still returns 200, because liveness must
 * never depend on a feature's configuration.
 *
 * The production Resend adapter is the ONLY sender constructed here. The
 * capturing test sender is never reachable from this path, so a magic-link
 * token cannot be diverted into logs in a deployed environment.
 */
function createAuthServiceIfConfigured(
  config: ServerConfig,
  pool: DatabasePool | undefined,
): AuthService | undefined {
  const missing: string[] = [];
  if (pool === undefined) missing.push('DATABASE_URL');
  if (config.appUrl === undefined) missing.push('APP_URL');
  if (config.resendApiKey === undefined) missing.push('RESEND_API_KEY');
  if (config.authFromEmail === undefined) missing.push('AUTH_FROM_EMAIL');

  if (pool === undefined || config.appUrl === undefined) {
    console.warn(`[api] authentication disabled; missing: ${missing.join(', ')}`);
    return undefined;
  }
  if (config.resendApiKey === undefined || config.authFromEmail === undefined) {
    console.warn(`[api] authentication disabled; missing: ${missing.join(', ')}`);
    return undefined;
  }

  return createAuthService({
    store: createDrizzleAuthStore(createDatabaseClient(pool)),
    // Never log the key; it is passed straight into the Authorization header.
    mailer: createResendEmailSender({
      apiKey: config.resendApiKey,
      from: config.authFromEmail,
    }),
    clock: systemClock,
    appUrl: config.appUrl,
    callbackPath: AUTH_CALLBACK_PATH,
  });
}

function main(): void {
  const config = loadServerConfig();
  const pool = createPoolIfConfigured(config);
  const authService = createAuthServiceIfConfigured(config, pool);

  // One client shared by the workspace and credential stores.
  const db = pool === undefined ? undefined : createDatabaseClient(pool);

  const probeDatabase: DatabaseReadinessProbe = async () => {
    const result = await checkDatabaseReadiness(pool);
    if (result.status !== 'ok' && result.diagnostic !== undefined) {
      // Diagnostics stay server-side; the HTTP response carries only a status.
      console.warn(`[api] readiness: database ${result.status} - ${result.diagnostic}`);
    }
    return result.status;
  };

  const app = createApp({
    probeDatabase,
    authService,
    appUrl: config.appUrl,
    secureCookies: config.isProduction,
    webOrigin: config.webOrigin,
    workspaceStore: db === undefined ? undefined : createDrizzleWorkspaceStore(db),
    apiKeyStore: db === undefined ? undefined : createDrizzleApiKeyStore(db),
    agentStore: db === undefined ? undefined : createDrizzleAgentStore(db),
    eventStore: db === undefined ? undefined : createDrizzleEventIngestStore(db),
    eventReadStore: db === undefined ? undefined : createDrizzleEventReadStore(db),
    policyStore: db === undefined ? undefined : createDrizzlePolicyStore(db),
    policyMutationStore: db === undefined ? undefined : createDrizzlePolicyMutationStore(db),
    precheckStore: db === undefined ? undefined : createDrizzlePrecheckStore(db),
  });

  const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
    console.log(`[api] listening on http://${config.host}:${String(info.port)} (${config.nodeEnv})`);
  });

  const shutdown = (signal: string): void => {
    console.log(`[api] ${signal} received, shutting down.`);
    server.close(() => {
      void (async (): Promise<void> => {
        if (pool !== undefined) {
          await closeDatabasePool(pool);
        }
        process.exit(0);
      })();
    });
  };

  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });
}

main();
