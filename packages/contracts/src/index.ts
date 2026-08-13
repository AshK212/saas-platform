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
  actionBlockedEventSchema,
  actionCategorySchema,
  agentActionEventSchema,
  decimalUsdSchema,
  EVENT_INGEST_PATH,
  eventIngestErrorSchema,
  eventIngestRequestSchema,
  eventIngestResponseSchema,
  eventSchema,
  eventTypeSchema,
  heartbeatEventSchema,
  MAX_EVENTS_PER_BATCH,
  MAX_REPORTED_ISSUES,
  spendRecordedEventSchema,
  toValidationIssues,
  validationIssueSchema,
} from './events.js';
export type {
  ActionBlockedEvent,
  ActionCategory,
  AgentActionEvent,
  DecimalUsd,
  EventIngestError,
  EventIngestRequest,
  EventIngestResponse,
  EventType,
  HeartbeatEvent,
  IngestEvent,
  SpendRecordedEvent,
  ValidationIssue,
} from './events.js';
export {
  AGENT_REGISTER_PATH,
  agentListResponseSchema,
  agentResponseSchema,
  agentSummarySchema,
  registerAgentRequestSchema,
  registerAgentResponseSchema,
  workspaceAgentPath,
  workspaceAgentsPath,
} from './agents.js';
export type {
  AgentListResponse,
  AgentResponse,
  AgentSummary,
  RegisterAgentRequest,
  RegisterAgentResponse,
} from './agents.js';
export {
  API_KEY_IDENTITY_PATH,
  apiKeyIdentityResponseSchema,
  apiKeyListResponseSchema,
  apiKeyStatusSchema,
  apiKeySummarySchema,
  createApiKeyRequestSchema,
  createApiKeyResponseSchema,
  issuedApiKeySchema,
  revokeApiKeyPath,
  revokeApiKeyResponseSchema,
  workspaceApiKeysPath,
  WORKSPACE_API_KEYS_SEGMENT,
} from './api-keys.js';
export type {
  ApiKeyIdentityResponse,
  ApiKeyListResponse,
  ApiKeyStatus,
  ApiKeySummary,
  CreateApiKeyRequest,
  CreateApiKeyResponse,
  IssuedApiKey,
  RevokeApiKeyResponse,
} from './api-keys.js';
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
