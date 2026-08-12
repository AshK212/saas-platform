import { and, desc, eq, isNull, type SQL } from 'drizzle-orm';

import { apiCredentials } from '../schema/credentials.js';
import type { DatabaseExecutor } from './executor.js';
import type { WorkspaceScope } from './workspace-scope.js';

/**
 * Workspace-scoped API-credential MANAGEMENT.
 *
 * Every query here is anchored on `workspace_id = :scope`, so an operator in
 * one workspace can never list or revoke another tenant's credentials.
 *
 * WHY THIS FILE WRITES, UNLIKE THE OTHER REPOSITORIES
 * ---------------------------------------------------
 * `agents.ts`, `events.ts` and `runtime-profiles.ts` are read-only because
 * nothing needed to mutate them yet. Tenant-scoped writes belong here by
 * design: issuance and revocation are workspace-owned mutations, and doing
 * them through a scoped repository is what keeps them inside the tenant
 * boundary. Every mutation below carries the scope predicate.
 *
 * NOT AN AUTHENTICATION PATH. Verifying a presented key happens in
 * `resolvers/api-credentials.ts`, because that lookup must DISCOVER the
 * workspace and therefore cannot already have a scope.
 */

export type ApiCredentialRow = typeof apiCredentials.$inferSelect;

/** Safe metadata. Deliberately omits `secretHash`. */
export interface ApiCredentialSummary {
  readonly id: string;
  readonly name: string;
  readonly keyPrefix: string;
  readonly createdAt: Date;
  readonly lastUsedAt: Date | null;
  readonly revokedAt: Date | null;
}

/**
 * Column projection used by every read here.
 *
 * `secret_hash` is excluded at the SQL level, not filtered afterwards, so the
 * digest never enters application memory on a management path and cannot be
 * leaked by an over-eager `res.json(row)`.
 */
const SUMMARY_COLUMNS = {
  id: apiCredentials.id,
  name: apiCredentials.name,
  keyPrefix: apiCredentials.keyPrefix,
  createdAt: apiCredentials.createdAt,
  lastUsedAt: apiCredentials.lastUsedAt,
  revokedAt: apiCredentials.revokedAt,
} as const;

export function apiCredentialScopePredicate(scope: WorkspaceScope): SQL {
  return eq(apiCredentials.workspaceId, scope.workspaceId);
}

export interface IssueApiCredentialInput {
  readonly name: string;
  /** Non-secret public half, used for lookup. */
  readonly keyPrefix: string;
  /** SHA-256 of the full plaintext key. The key itself is never passed here. */
  readonly secretHash: string;
}

export interface ApiCredentialRepository {
  /** Newest first. Includes revoked credentials, which are retained for audit. */
  listAll(): Promise<ApiCredentialSummary[]>;
  findById(credentialId: string): Promise<ApiCredentialSummary | null>;
  issue(input: IssueApiCredentialInput): Promise<ApiCredentialSummary>;
  /**
   * Revokes a credential in this workspace.
   *
   * @returns the credential when it exists in scope (whether or not this call
   *   was the one that revoked it), or null when it does not. Idempotent: a
   *   repeated revoke succeeds and leaves the original timestamp intact.
   */
  revoke(credentialId: string, now: Date): Promise<ApiCredentialSummary | null>;
  /** Best-effort telemetry. Never gates authentication. */
  touchLastUsed(credentialId: string, now: Date): Promise<void>;
}

export function createApiCredentialRepository(
  executor: DatabaseExecutor,
  scope: WorkspaceScope,
): ApiCredentialRepository {
  const inScope = (extra?: SQL): SQL =>
    extra === undefined
      ? apiCredentialScopePredicate(scope)
      : (and(apiCredentialScopePredicate(scope), extra) as SQL);

  return {
    async listAll(): Promise<ApiCredentialSummary[]> {
      return executor
        .select(SUMMARY_COLUMNS)
        .from(apiCredentials)
        .where(inScope())
        .orderBy(desc(apiCredentials.createdAt));
    },

    async findById(credentialId: string): Promise<ApiCredentialSummary | null> {
      const rows = await executor
        .select(SUMMARY_COLUMNS)
        .from(apiCredentials)
        .where(inScope(eq(apiCredentials.id, credentialId)))
        .limit(1);

      return rows[0] ?? null;
    },

    async issue(input: IssueApiCredentialInput): Promise<ApiCredentialSummary> {
      const rows = await executor
        .insert(apiCredentials)
        .values({
          // The workspace comes from the SCOPE, never from caller input.
          workspaceId: scope.workspaceId,
          name: input.name,
          keyPrefix: input.keyPrefix,
          secretHash: input.secretHash,
        })
        .returning(SUMMARY_COLUMNS);

      const row = rows[0];
      if (row === undefined) {
        throw new Error('Failed to persist API credential.');
      }
      return row;
    },

    async revoke(credentialId: string, now: Date): Promise<ApiCredentialSummary | null> {
      // Only flips a live credential; an already-revoked row matches nothing
      // here, which is what keeps the original timestamp authoritative.
      const revoked = await executor
        .update(apiCredentials)
        .set({ revokedAt: now })
        .where(inScope(and(eq(apiCredentials.id, credentialId), isNull(apiCredentials.revokedAt))))
        .returning(SUMMARY_COLUMNS);

      const row = revoked[0];
      if (row !== undefined) {
        return row;
      }

      // Either already revoked (return it - idempotent) or not in this
      // workspace (null - indistinguishable from absent).
      return this.findById(credentialId);
    },

    async touchLastUsed(credentialId: string, now: Date): Promise<void> {
      await executor
        .update(apiCredentials)
        .set({ lastUsedAt: now })
        .where(inScope(eq(apiCredentials.id, credentialId)));
    },
  };
}
