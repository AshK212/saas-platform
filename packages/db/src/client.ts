import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';

import * as schema from './schema/index.js';

const { Pool } = pg;

/**
 * Database client boundary for Neon PostgreSQL + Drizzle.
 *
 * DRIVER CHOICE - node-postgres over TCP
 * --------------------------------------
 * The platform deploys to Render as a long-lived Node process, and the Credit
 * phase requires transaction-sensitive enforcement (ledger decisions, atomic
 * receipt + block creation, policy version changes).
 *
 * `drizzle-orm/neon-http` - the Step 1 choice - CANNOT support this. Its session
 * implementation throws `No transactions support in neon-http driver` for any
 * `transaction()` call, because each statement is an independent HTTP request
 * with no session continuity. That rules out `BEGIN`/`COMMIT`, `SELECT ... FOR
 * UPDATE`, and `SERIALIZABLE` isolation.
 *
 * `pg` holds a real, stateful PostgreSQL session over TCP, so the full
 * transactional feature set is available. Neon supports standard TCP+TLS
 * connections; the serverless HTTP/WebSocket driver exists for edge runtimes
 * that cannot open TCP sockets, which is not our deployment model.
 *
 * OWNERSHIP
 * ---------
 * This module is the only place a driver or pool is constructed. It never reads
 * `process.env`, so a credential can never be picked up implicitly - the caller
 * must pass one in from validated server configuration.
 *
 * There is deliberately no global client, no ambient tenant context and no
 * implicit workspace scoping. Workspace scoping is applied by query code once
 * the schema exists, and must always be explicit.
 */

/** Typed Drizzle client. Schema is empty until Step 3; the type tracks it. */
export type DatabaseClient = NodePgDatabase<typeof schema>;

/** Connection pool handle. Owned by the composing application, not by this module. */
export type DatabasePool = pg.Pool;

export interface DatabasePoolOptions {
  /** Postgres connection string, supplied from validated server configuration. */
  readonly connectionString: string;
  /** Maximum pooled connections. Keep well under the Neon plan's limit. */
  readonly maxConnections?: number;
  /** How long to wait for a connection before failing. */
  readonly connectionTimeoutMillis?: number;
  /** How long an idle connection is retained. */
  readonly idleTimeoutMillis?: number;
  /** Reported to Postgres as `application_name`, useful in `pg_stat_activity`. */
  readonly applicationName?: string;
  /**
   * Invoked on asynchronous pool errors (for example, an idle connection
   * dropped by the server).
   *
   * An unhandled `error` event on a `pg.Pool` terminates the process, so a
   * handler is always attached. The default is a no-op; the observability step
   * replaces it with a structured logger. Messages passed here have already had
   * credentials redacted.
   */
  readonly onPoolError?: (message: string) => void;
}

/** Thrown when a database client is requested without usable connection input. */
export class DatabaseConfigError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'DatabaseConfigError';
  }
}

const DEFAULT_MAX_CONNECTIONS = 10;
const DEFAULT_CONNECTION_TIMEOUT_MS = 10_000;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;

/**
 * Creates a connection pool.
 *
 * No connection is opened here - `pg.Pool` connects lazily on first query - so
 * constructing a pool never blocks process startup or fails a deploy.
 *
 * @throws {DatabaseConfigError} when the connection string is empty.
 */
export function createDatabasePool(options: DatabasePoolOptions): DatabasePool {
  const connectionString = options.connectionString.trim();
  if (connectionString.length === 0) {
    throw new DatabaseConfigError(
      'A non-empty connection string is required to create a database pool.',
    );
  }

  const pool = new Pool({
    connectionString,
    max: options.maxConnections ?? DEFAULT_MAX_CONNECTIONS,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? DEFAULT_CONNECTION_TIMEOUT_MS,
    idleTimeoutMillis: options.idleTimeoutMillis ?? DEFAULT_IDLE_TIMEOUT_MS,
    application_name: options.applicationName ?? 'hybrid-control-plane',
  });

  const onPoolError = options.onPoolError;
  pool.on('error', (error: Error) => {
    onPoolError?.(error.message);
  });

  return pool;
}

/**
 * Wraps a pool in a typed Drizzle client.
 *
 * The pool is injected rather than created here so that connection lifetime is
 * owned by the composing application, and so tests can supply a fake.
 */
export function createDatabaseClient(pool: DatabasePool): DatabaseClient {
  return drizzle(pool, { schema });
}

/** Closes a pool and releases its connections. Safe to call during shutdown. */
export async function closeDatabasePool(pool: DatabasePool): Promise<void> {
  await pool.end();
}
