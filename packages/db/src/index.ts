/**
 * @hybrid/db - database boundary.
 *
 * TARGET STACK
 * ------------
 *   Neon PostgreSQL, reached over TCP with `pg` (node-postgres), through
 *   Drizzle ORM. See `client.ts` for why the HTTP driver was rejected.
 *
 * LAYOUT
 * ------
 *   src/client.ts       - pool + typed Drizzle client (the only driver construction site)
 *   src/readiness.ts    - schema-independent `SELECT 1` readiness probe
 *   src/redact.ts       - credential redaction for diagnostics
 *   src/migrate.ts      - migration runner CLI (runtime dependencies only)
 *   src/schema/         - Drizzle table definitions
 *   src/accounting/     - exact money arithmetic and the UTC accounting day
 *   src/repositories/   - workspace-SCOPED data access (every method needs a scope)
 *   src/resolvers/      - READ-ONLY; establish which workspace a caller may enter
 *   src/provisioning/   - tenant creation; the only writes outside identity/
 *   src/identity/       - global, user-owned records (users, auth)
 *   migrations/         - generated SQL migrations, checked into Git
 *
 * TENANT ISOLATION
 * ----------------
 * Tenant-owned data is reachable only through `repositories/`, and every method
 * there is bound to exactly one `WorkspaceScope`. See
 * docs/adr/0001-workspace-isolation.md.
 *
 * Raw schema tables are NOT re-exported from this entry point. They are
 * available at `@hybrid/db/schema` for migrations and database tooling only;
 * ESLint forbids application code from importing that path, because
 * `db.select().from(events)` with no workspace predicate is exactly the
 * cross-tenant leak this package exists to prevent.
 *
 * STEP 14 SCOPE
 * -------------
 * Adds the authoritative accounting primitives: exact micro-dollar arithmetic,
 * the UTC accounting day, and the workspace/agent/day ledger with its row-lock
 * concurrency primitive.
 *
 * DECISIONS ARE NOT HERE. Nothing compares a cap to committed usage, allows or
 * denies an action, writes a receipt or creates a block. Those compose these
 * primitives in Step 15.
 */

// Authoritative accounting primitives
export {
  addMicros,
  formatUsdFromMicros,
  LedgerCapacityError,
  MAX_USD_MICROS,
  MICROS_PER_USD,
  MoneyError,
  normalizeUsd,
  parseUsdToMicros,
  remainingCount,
  remainingMicros,
} from './accounting/money.js';
export {
  parseUtcAccountingDay,
  toUtcAccountingDay,
  UtcAccountingDayError,
} from './accounting/utc-day.js';
export type { UtcAccountingDay } from './accounting/utc-day.js';

// Connection and lifecycle
export {
  closeDatabasePool,
  createDatabaseClient,
  createDatabasePool,
  DatabaseConfigError,
} from './client.js';
export type { DatabaseClient, DatabasePool, DatabasePoolOptions } from './client.js';

// Operational
export { checkDatabaseReadiness } from './readiness.js';
export type {
  DatabaseReadinessOptions,
  DatabaseReadinessResult,
  DatabaseReadinessStatus,
  ReadinessQueryable,
} from './readiness.js';
export { describeConnectionTarget, redactConnectionStrings } from './redact.js';

// Tenant-scoped data access
/**
 * NOTE: `createWorkspaceScope` is deliberately NOT exported.
 *
 * It is the raw structural constructor and performs no authorization. Exposing
 * it would let an HTTP handler write `createWorkspaceScope(req.params.id)` and
 * mint tenant access straight from request input, defeating ADR 0001 and
 * ADR 0003. Application code obtains a scope only from
 * `authorizeWorkspaceForUser`, which requires a proven membership.
 *
 * The `WorkspaceScope` TYPE is still exported, so callers can name the value
 * they receive without being able to fabricate one.
 */
export {
  agentQueries,
  agentScopePredicate,
  apiCredentialScopePredicate,
  createAgentRepository,
  createApiCredentialRepository,
  blockAuditQueries,
  createBlockRepository,
  createEventRepository,
  createIngestLockRepository,
  createLedgerRepository,
  createPlaneBlockRepository,
  planeBlockQueries,
  ledgerQueries,
  ledgerScopePredicate,
  LedgerRowMissingError,
  createPolicyMutationService,
  createPolicyReadRepository,
  createPrecheckReceiptRepository,
  MissingPolicyStateError,
  createRuntimeProfileRepository,
  eventQueries,
  eventScopePredicate,
  precheckActionLockKey,
  createPrecheckLockRepository,
  receiptQueries,
  isSameWorkspace,
  runtimeProfileQueries,
  runtimeProfileScopePredicate,
  WorkspaceScopeError,
} from './repositories/index.js';
export type {
  AgentRepository,
  AgentRow,
  ApiCredentialRepository,
  ApiCredentialRow,
  ApiCredentialSummary,
  AuditBlockRow,
  AuditCursor,
  AuditReceiptRow,
  BlockCursor,
  BlockRepository,
  BlockRow,
  ListAuditOptions,
  ListBlocksOptions,
  PlaneBlockInput,
  PlaneBlockRepository,
  DatabaseExecutor,
  InsertEventInput,
  IssueApiCredentialInput,
  PrecheckReceiptRepository,
  ResolveRuntimeBlockInput,
  AgentPolicyValues,
  CommittedAgentPolicy,
  DailyLedgerState,
  LedgerRepository,
  LockedDailyLedger,
  DatabaseTransaction,
  EffectiveAgentPolicyRow,
  EffectivePolicyForDecision,
  InsertReceiptInput,
  ReceiptRow,
  PolicyMutationService,
  PolicyReadRepository,
  EventDetailRow,
  EventRepository,
  EventRow,
  ListTimelineOptions,
  TimelineCursor,
  TimelineEventRow,
  RuntimeProfileRepository,
  RuntimeProfileRow,
  WorkspaceScope,
} from './repositories/index.js';

// Global identity (users, magic links, auth sessions - no workspace involved)
export {
  consumeMagicLink,
  findActiveAuthSession,
  findLatestMagicLinkIssuedAt,
  findOrCreateUserByEmail,
  findUserByEmail,
  findUserById,
  insertAuthSession,
  insertMagicLink,
  normaliseEmail,
  revokeAuthSession,
  touchAuthSession,
} from './identity/index.js';
export type {
  ActiveAuthSession,
  AuthSessionRow,
  ConsumedMagicLink,
  CreateAuthSessionInput,
  IssueMagicLinkInput,
  MagicLinkRow,
  UserRow,
} from './identity/index.js';

// Scope resolvers (deliberately not workspace-scoped - they establish scope).
// `authorizeWorkspaceForUser` is the ONLY sanctioned way for application code
// to obtain a WorkspaceScope; see resolvers/authorization.ts.
export {
  authenticateApiCredential,
  authorizeWorkspaceForUser,
  findDemoWorkspaceBySlug,
  findMembership,
  findWorkspaceById,
  listMembershipsForUser,
  listWorkspacesForUser,
} from './resolvers/index.js';
export type {
  AuthenticatedApiCredential,
  AuthorizedWorkspace,
  AuthorizedWorkspaceSummary,
  MembershipRole,
  MembershipRow,
  WorkspaceRow,
} from './resolvers/index.js';

// Tenant provisioning (the only writes outside identity/)
export { createWorkspaceWithOperator } from './provisioning/index.js';
export type { CreateWorkspaceInput } from './provisioning/index.js';
