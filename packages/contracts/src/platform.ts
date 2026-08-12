/**
 * Stable, non-secret identifiers for the platform itself.
 *
 * These exist so the API, web app and simulator agree on naming without any of
 * them importing another application's internals.
 */

export const PLATFORM_NAME = 'AI Hybrid Multi-Agent Platform' as const;

/**
 * Contract revision of this package. Bumped when a shared contract changes
 * shape in a way consumers must react to.
 */
export const CONTRACTS_VERSION = '0.1.0' as const;
