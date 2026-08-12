import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadServerConfig, requireDatabaseUrl } from '@hybrid/config/server';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

import { closeDatabasePool, createDatabaseClient, createDatabasePool } from './client.js';
import { describeConnectionTarget } from './redact.js';

/**
 * Migration runner CLI.
 *
 * WHY NOT `drizzle-kit migrate`
 * -----------------------------
 * `drizzle-kit` is a devDependency and a build-time tool. Production and
 * staging deploys should not have to install dev tooling to apply schema
 * changes, so migrations are applied through Drizzle's runtime migrator, which
 * needs only `drizzle-orm` and `pg`.
 *
 * `drizzle-kit generate` remains the authoring tool - it writes the SQL that
 * this runner applies.
 *
 * SAFETY
 * ------
 * Fails immediately and clearly when DATABASE_URL is absent. Only the redacted
 * connection target is ever printed.
 */

/* eslint-disable no-console -- CLI entry point; stdout is its interface */

const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));

/** `dist/migrate.js` -> `packages/db/migrations`. */
const MIGRATIONS_FOLDER = path.resolve(CURRENT_DIR, '..', 'migrations');

async function main(): Promise<void> {
  const config = loadServerConfig();
  const connectionString = requireDatabaseUrl(config);

  console.log(`[migrate] target   ${describeConnectionTarget(connectionString)}`);
  console.log(`[migrate] folder   ${MIGRATIONS_FOLDER}`);

  // A single connection is sufficient and avoids concurrent DDL.
  const pool = createDatabasePool({
    connectionString,
    maxConnections: 1,
    applicationName: 'hybrid-migrate',
  });

  try {
    await migrate(createDatabaseClient(pool), { migrationsFolder: MIGRATIONS_FOLDER });
    console.log('[migrate] migrations applied successfully.');
  } finally {
    await closeDatabasePool(pool);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[migrate] FAILED: ${message}`);
  process.exitCode = 1;
});
