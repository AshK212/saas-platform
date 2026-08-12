import { redactConnectionStrings } from './redact.js';

/**
 * Database readiness probing.
 *
 * Readiness is distinct from liveness. The process can be perfectly healthy
 * while the database is unconfigured or unreachable; conflating the two makes a
 * platform restart itself over a dependency outage it cannot fix.
 */

export type DatabaseReadinessStatus = 'ok' | 'unconfigured' | 'unreachable';

export interface DatabaseReadinessResult {
  readonly status: DatabaseReadinessStatus;
  /** Round-trip time of the probe query, present only when `status` is `ok`. */
  readonly latencyMs?: number;
  /**
   * SERVER-SIDE DIAGNOSTIC ONLY.
   *
   * Credentials are redacted and the length is capped, but this may still name
   * a host. It must never be placed in an HTTP response body.
   */
  readonly diagnostic?: string;
}

/**
 * The minimum surface readiness needs.
 *
 * Depending on this rather than on `pg.Pool` keeps the probe unit-testable with
 * a fake, so the normal test suite never requires live credentials.
 */
export interface ReadinessQueryable {
  query(sql: string): Promise<unknown>;
}

/** The probe statement. Deliberately schema-independent. */
const PROBE_STATEMENT = 'SELECT 1';

const DEFAULT_PROBE_TIMEOUT_MS = 5_000;
const MAX_DIAGNOSTIC_LENGTH = 300;

function toDiagnostic(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return redactConnectionStrings(raw).slice(0, MAX_DIAGNOSTIC_LENGTH);
}

export interface DatabaseReadinessOptions {
  readonly timeoutMs?: number;
}

/**
 * Runs `SELECT 1` against the database and reports readiness.
 *
 * Never throws and never rejects: readiness is a report, not a control-flow
 * exception. A missing queryable is reported as `unconfigured` rather than as a
 * failure, because "no database configured" and "database is broken" are
 * operationally different conditions.
 *
 * @param queryable - Pool or fake. `undefined` means no database is configured.
 */
export async function checkDatabaseReadiness(
  queryable: ReadinessQueryable | undefined,
  options: DatabaseReadinessOptions = {},
): Promise<DatabaseReadinessResult> {
  if (queryable === undefined) {
    return { status: 'unconfigured', diagnostic: 'DATABASE_URL is not configured.' };
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const startedAt = Date.now();

  let timeoutHandle: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(`Readiness probe exceeded ${String(timeoutMs)}ms.`));
    }, timeoutMs);
  });

  try {
    await Promise.race([queryable.query(PROBE_STATEMENT), timeout]);
    return { status: 'ok', latencyMs: Date.now() - startedAt };
  } catch (error: unknown) {
    return { status: 'unreachable', diagnostic: toDiagnostic(error) };
  } finally {
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle);
    }
  }
}
