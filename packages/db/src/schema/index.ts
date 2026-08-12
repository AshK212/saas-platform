/**
 * Drizzle schema barrel.
 *
 * Every table and enum is re-exported here so `drizzle-kit` and
 * `createDatabaseClient` see one complete schema.
 *
 * TENANT ISOLATION IS STRUCTURAL
 * ------------------------------
 * Every tenant-owned table carries `workspace_id`. Where a tenant-owned row
 * references another tenant-owned row, the foreign key is COMPOSITE -
 * `(workspace_id, parent_id) -> parent(workspace_id, id)` - so a cross-workspace
 * reference is rejected by PostgreSQL, not merely avoided by application code.
 * See docs/architecture.md for the full matrix.
 *
 * SCOPE: STEP 3 IS SCHEMA ONLY
 * ----------------------------
 * These tables define structure and invariants. No repository, query helper,
 * ingest path, enforcement rule or API exists yet. A table existing does not
 * mean its feature exists - see docs/acceptance-traceability.md.
 */

// Enums
export {
  actionCategory,
  agentMode,
  blockSource,
  eventType,
  membershipRole,
  precheckDecision,
  sessionStatus,
  taskStatus,
} from './enums.js';

// Identity and tenancy
export { users } from './identity.js';
export { workspaceMemberships, workspaces } from './workspaces.js';

// Authentication (global, user-owned - NOT the runtime `sessions` table)
export { authMagicLinks, authSessions } from './auth.js';

// Credentials and sharing
export { apiCredentials } from './credentials.js';
export { shareTokens } from './sharing.js';

// Runtime and agents
export { runtimeProfiles } from './runtime.js';
export { agents } from './agents.js';
export { sessions, tasks } from './sessions.js';

// Governance
export { agentPolicies, workspacePolicyState } from './policy.js';
export { ledgerDaily } from './ledger.js';
export { precheckReceipts } from './receipts.js';
export { blocks } from './blocks.js';

// Audit stream
export { events } from './events.js';

// Relational metadata (emits no SQL)
export * from './relations.js';
