/**
 * @hybrid/config - BROWSER-SAFE entry point.
 *
 * SECURITY BOUNDARY
 * -----------------
 * Anything exported from this module may end up in a browser bundle. It must
 * therefore contain only non-secret, non-sensitive values.
 *
 * Server-only configuration (anything reading `process.env`, anything that
 * could carry a credential) lives behind the separate `@hybrid/config/server`
 * export and must never be re-exported from here.
 *
 * STEP 1 SCOPE
 * ------------
 * Establishes the boundary only. Full environment validation for the platform
 * arrives with the database foundation in Step 2.
 */

/** Runtime environments the platform is deployed into. */
export const RUNTIME_ENVIRONMENTS = ['development', 'test', 'production'] as const;

export type RuntimeEnvironment = (typeof RUNTIME_ENVIRONMENTS)[number];

/** Default port the API binds to when `PORT` is not supplied. */
export const DEFAULT_API_PORT = 3000;

/** Default interface the API binds to in local development. */
export const DEFAULT_API_HOST = '127.0.0.1';
