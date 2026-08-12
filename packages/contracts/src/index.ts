/**
 * @hybrid/contracts - shared transport/domain contracts.
 *
 * STEP 1 SCOPE
 * ------------
 * Only the foundational contracts needed to prove cross-package compilation and
 * to type the liveness endpoint live here.
 *
 * The real Credit-phase contracts (events, prechecks, policies, receipts,
 * blocks, ledger entries, share links) are defined in their own dedicated
 * implementation steps and are intentionally absent.
 */

export { healthResponseSchema, HEALTH_PATH } from './health.js';
export type { HealthResponse } from './health.js';
export {
  dependencyReadinessSchema,
  readinessResponseSchema,
  READINESS_PATH,
} from './readiness.js';
export type { DependencyReadiness, ReadinessResponse } from './readiness.js';
export { PLATFORM_NAME, CONTRACTS_VERSION } from './platform.js';
