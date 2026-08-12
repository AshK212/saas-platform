/**
 * @hybrid/db - database boundary.
 *
 * TARGET STACK
 * ------------
 *   Neon PostgreSQL, reached over TCP with `pg` (node-postgres), through
 *   Drizzle ORM. See `client.ts` for why the HTTP driver was rejected.
 *
 * LAYOUT
 * ------
 *   src/client.ts     - pool + typed Drizzle client (the only driver construction site)
 *   src/readiness.ts  - schema-independent `SELECT 1` readiness probe
 *   src/redact.ts     - credential redaction for diagnostics
 *   src/migrate.ts    - migration runner CLI (runtime dependencies only)
 *   src/schema/       - Drizzle table definitions (empty until Step 3)
 *   migrations/       - generated SQL migrations, checked into Git
 *   drizzle.config.ts - drizzle-kit configuration
 *
 * STEP 2 SCOPE
 * ------------
 * Infrastructure only. No domain tables, no repositories, no tenant-scoped
 * queries. Those begin in Step 3, once a schema exists.
 */

export {
  closeDatabasePool,
  createDatabaseClient,
  createDatabasePool,
  DatabaseConfigError,
} from './client.js';
export type { DatabaseClient, DatabasePool, DatabasePoolOptions } from './client.js';

export { checkDatabaseReadiness } from './readiness.js';
export type {
  DatabaseReadinessOptions,
  DatabaseReadinessResult,
  DatabaseReadinessStatus,
  ReadinessQueryable,
} from './readiness.js';

export { describeConnectionTarget, redactConnectionStrings } from './redact.js';

export * as schema from './schema/index.js';
