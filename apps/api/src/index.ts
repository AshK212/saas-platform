import { serve } from '@hono/node-server';
import { loadServerConfig, type ServerConfig } from '@hybrid/config/server';
import {
  checkDatabaseReadiness,
  closeDatabasePool,
  createDatabasePool,
  describeConnectionTarget,
  type DatabasePool,
} from '@hybrid/db';

import { createApp } from './app.js';
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

function main(): void {
  const config = loadServerConfig();
  const pool = createPoolIfConfigured(config);

  const probeDatabase: DatabaseReadinessProbe = async () => {
    const result = await checkDatabaseReadiness(pool);
    if (result.status !== 'ok' && result.diagnostic !== undefined) {
      // Diagnostics stay server-side; the HTTP response carries only a status.
      console.warn(`[api] readiness: database ${result.status} - ${result.diagnostic}`);
    }
    return result.status;
  };

  const app = createApp({ probeDatabase });

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
