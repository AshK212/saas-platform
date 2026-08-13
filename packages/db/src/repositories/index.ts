/**
 * Workspace-scoped repositories.
 *
 * THE RULE FOR THIS DIRECTORY
 * ---------------------------
 * Every data-access function exported from `repositories/` requires a
 * `WorkspaceScope`. There is no exception, and none may be added.
 *
 * There is deliberately NO escape hatch: no `unsafeDb()`, no
 * `withoutWorkspace()`, no `allTenants()`, no `adminQuery()`. No Credit-phase
 * requirement needs one, and providing one would make the invariant
 * unenforceable the moment someone is in a hurry.
 *
 * WHY FACTORIES AND NOT A GENERIC BaseRepository<T>
 * -------------------------------------------------
 * A universal CRUD base class would hand every future caller an
 * `update(table, id, patch)` capability. That is precisely the shape that would
 * let event ingest, a runtime call, a read-only share or the public demo mutate
 * policy - which the architecture forbids. Concrete, named, read-only methods
 * cannot be repurposed that way.
 *
 * Operations that legitimately span workspaces - resolving which workspaces a
 * user belongs to - live in `../resolvers/`, not here.
 */

export { createAgentRepository, agentQueries, agentScopePredicate } from './agents.js';

export {
  apiCredentialScopePredicate,
  createApiCredentialRepository,
} from './api-credentials.js';
export type {
  ApiCredentialRepository,
  ApiCredentialRow,
  ApiCredentialSummary,
  IssueApiCredentialInput,
} from './api-credentials.js';
export type { AgentRepository, AgentRow } from './agents.js';

export { createBlockRepository } from './blocks.js';
export type { BlockRepository, BlockRow, ResolveRuntimeBlockInput } from './blocks.js';

export { createEventRepository, eventQueries, eventScopePredicate } from './events.js';
export type {
  EventDetailRow,
  EventRepository,
  EventRow,
  InsertEventInput,
  ListTimelineOptions,
  TimelineCursor,
  TimelineEventRow,
} from './events.js';

export { createIngestLockRepository } from './ingest-locks.js';
export type { EventLockRequest, IngestLockRepository } from './ingest-locks.js';
export { compareLockKeys, eventIngestLockKey } from './lock-keys.js';

export {
  agentPolicyScopePredicate,
  createPolicyReadRepository,
  policyQueries,
  policyStateScopePredicate,
} from './policy.js';
export type { EffectiveAgentPolicyRow, PolicyReadRepository } from './policy.js';

export { createPolicyMutationService, MissingPolicyStateError } from './policy-mutation.js';
export type {
  AgentPolicyValues,
  CommittedAgentPolicy,
  PolicyMutationService,
} from './policy-mutation.js';

export { createPrecheckReceiptRepository } from './receipts.js';
export type { PrecheckReceiptRepository } from './receipts.js';

export {
  createRuntimeProfileRepository,
  runtimeProfileQueries,
  runtimeProfileScopePredicate,
} from './runtime-profiles.js';
export type { RuntimeProfileRepository, RuntimeProfileRow } from './runtime-profiles.js';

export { createWorkspaceScope, isSameWorkspace, WorkspaceScopeError } from './workspace-scope.js';
export type { WorkspaceScope } from './workspace-scope.js';

export type { DatabaseExecutor, DatabaseTransaction } from './executor.js';
