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

export {
  AUTH_CALLBACK_PATH,
  AUTH_CALLBACK_RESULT_PARAM,
  AUTH_CALLBACK_TOKEN_PARAM,
  AUTH_LOGOUT_PATH,
  AUTH_MAGIC_LINK_PATH,
  AUTH_ME_PATH,
  authCallbackResultSchema,
  currentUserResponseSchema,
  logoutResponseSchema,
  magicLinkRequestSchema,
  magicLinkResponseSchema,
} from './auth.js';
export type {
  AuthCallbackResult,
  CurrentUserResponse,
  LogoutResponse,
  MagicLinkRequest,
  MagicLinkResponse,
} from './auth.js';
export {
  createWorkspaceRequestSchema,
  membershipRoleSchema,
  workspaceListResponseSchema,
  workspacePath,
  workspaceResponseSchema,
  workspaceSummarySchema,
  WORKSPACES_PATH,
} from './workspaces.js';
export type {
  CreateWorkspaceRequest,
  MembershipRoleValue,
  WorkspaceListResponse,
  WorkspaceResponse,
  WorkspaceSummary,
} from './workspaces.js';
export { healthResponseSchema, HEALTH_PATH } from './health.js';
export type { HealthResponse } from './health.js';
export {
  dependencyReadinessSchema,
  readinessResponseSchema,
  READINESS_PATH,
} from './readiness.js';
export type { DependencyReadiness, ReadinessResponse } from './readiness.js';
export { PLATFORM_NAME, CONTRACTS_VERSION } from './platform.js';
