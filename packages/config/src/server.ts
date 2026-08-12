import { z } from 'zod';

import { DEFAULT_API_HOST, DEFAULT_API_PORT, RUNTIME_ENVIRONMENTS } from './index.js';

/**
 * @hybrid/config/server - SERVER-ONLY configuration.
 *
 * SECURITY BOUNDARY
 * -----------------
 * This module reads `process.env` and is the module that will eventually carry
 * credential-bearing configuration (DATABASE_URL, RESEND_API_KEY, signing
 * secrets). It must never be imported by browser code, and must never be
 * re-exported from the browser-safe `@hybrid/config` root entry point.
 *
 * SCOPE
 * -----
 * Only the variables the platform genuinely needs today are validated. Email
 * credentials and auth secrets are deliberately NOT validated here yet - they
 * are introduced by the step that actually consumes them, so that a missing
 * variable never fails a deploy for a feature that does not exist.
 *
 * DATABASE_URL IS OPTIONAL, AND VALIDATED WHEN PRESENT
 * ----------------------------------------------------
 * It is deliberately not required at process start. `GET /healthz` is a
 * liveness endpoint that does not touch the database, so the API must remain
 * startable - and truthfully report itself alive - when the database is absent.
 * Database-dependent operations call `requireDatabaseUrl()` and fail loudly at
 * the point of use instead.
 *
 * There is no fallback value. A missing DATABASE_URL stays missing; it is never
 * silently replaced with localhost or any other default, in any environment.
 */

/**
 * Accepts only a syntactically valid Postgres URL.
 *
 * Note this validates *shape*, not reachability - a well-formed URL pointing at
 * a dead host still passes here and is caught by the readiness probe instead.
 */
function isPostgresUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (url.protocol === 'postgres:' || url.protocol === 'postgresql:') && url.hostname !== '';
}

/**
 * An unset variable and one set to the empty string mean the same thing.
 * Render and `.env` files both surface "not configured" as `""`.
 */
function emptyStringToUndefined(value: unknown): unknown {
  return typeof value === 'string' && value.trim() === '' ? undefined : value;
}

const serverEnvSchema = z.object({
  NODE_ENV: z.enum(RUNTIME_ENVIRONMENTS).default('development'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(DEFAULT_API_PORT),
  HOST: z.string().min(1).default(DEFAULT_API_HOST),
  DATABASE_URL: z.preprocess(
    emptyStringToUndefined,
    z
      .string()
      .refine(isPostgresUrl, {
        // The message must never quote the value - it carries a password.
        message: 'must be a valid postgres:// or postgresql:// connection URL',
      })
      .optional(),
  ),
});

export interface ServerConfig {
  readonly nodeEnv: (typeof RUNTIME_ENVIRONMENTS)[number];
  readonly port: number;
  readonly host: string;
  readonly isProduction: boolean;
  /**
   * Validated Postgres connection URL, or `undefined` when no database is
   * configured. Server-side only - this value must never cross into a browser
   * bundle.
   */
  readonly databaseUrl?: string;
}

/** Thrown when the process environment does not satisfy the server schema. */
export class ServerConfigError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ServerConfigError';
  }
}

function assertServerRuntime(): void {
  // The DOM lib is deliberately not loaded in this server-only package, so
  // `window` is narrowed explicitly rather than assumed to exist.
  const maybeBrowserGlobal = globalThis as { window?: unknown };
  if (typeof maybeBrowserGlobal.window !== 'undefined') {
    throw new ServerConfigError(
      '@hybrid/config/server was imported in a browser context. Server configuration must never reach the client bundle.',
    );
  }
}

/**
 * Validates and returns server configuration from the given environment.
 *
 * @param env - Environment source. Defaults to `process.env`; injectable so
 *   tests never have to mutate global process state.
 * @throws {ServerConfigError} when validation fails or when called in a browser.
 */
export function loadServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  assertServerRuntime();

  const parsed = serverEnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new ServerConfigError(`Invalid server environment configuration - ${issues}`);
  }

  const { NODE_ENV, PORT, HOST, DATABASE_URL } = parsed.data;
  return {
    nodeEnv: NODE_ENV,
    port: PORT,
    host: HOST,
    isProduction: NODE_ENV === 'production',
    // Spread-or-omit rather than assigning `undefined`, to satisfy
    // `exactOptionalPropertyTypes` and keep "absent" distinct from "set to undefined".
    ...(DATABASE_URL === undefined ? {} : { databaseUrl: DATABASE_URL }),
  };
}

/**
 * Returns the configured database URL, or fails loudly.
 *
 * Call this at the point a database-dependent operation actually needs a
 * connection. That keeps the failure specific and actionable ("this operation
 * needs a database") instead of taking down an entire process at boot for a
 * dependency that liveness does not require.
 *
 * @throws {ServerConfigError} when no database URL is configured.
 */
export function requireDatabaseUrl(config: ServerConfig): string {
  if (config.databaseUrl === undefined) {
    throw new ServerConfigError(
      'DATABASE_URL is required for this operation but is not configured. Supply it through the environment; it is never read from source control.',
    );
  }
  return config.databaseUrl;
}
