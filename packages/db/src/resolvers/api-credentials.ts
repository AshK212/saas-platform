import { and, eq, isNull } from 'drizzle-orm';

import type { DatabaseExecutor } from '../repositories/executor.js';
import { createWorkspaceScope, type WorkspaceScope } from '../repositories/workspace-scope.js';
import { apiCredentials } from '../schema/credentials.js';

/**
 * API-credential authentication - the agent/machine authorization boundary.
 *
 * WHY THIS IS A RESOLVER AND NOT A REPOSITORY
 * -------------------------------------------
 * Repositories require a `WorkspaceScope`. This lookup cannot have one: its
 * entire purpose is to DISCOVER which workspace a presented credential belongs
 * to. Requiring a scope here would be circular, exactly as it would be for
 * membership resolution in `authorization.ts`.
 *
 * It is still tightly bounded. The only way in is possession of a valid key:
 * the query matches on both the non-secret prefix AND the SHA-256 digest of the
 * full key, and there is deliberately no "list credentials" or "find by
 * workspace" function here. A caller cannot enumerate anything.
 *
 * THE INVARIANT THIS FILE EXISTS TO ENFORCE
 * -----------------------------------------
 * The workspace comes from `api_credentials.workspace_id` on the matched row -
 * never from a header, body field, query parameter or path segment. That is why
 * this function takes only digests and returns the workspace, rather than
 * accepting a workspace id to check against.
 */

/** A successfully authenticated credential. Carries no secret material. */
export interface AuthenticatedApiCredential {
  readonly credentialId: string;
  /** Derived from the credential row. Not caller-supplied. */
  readonly workspaceId: string;
  /** Trusted tenant scope, built from the row's own workspace id. */
  readonly scope: WorkspaceScope;
}

/**
 * Resolves a presented API key to its workspace.
 *
 * Both halves are required: the prefix uses the unique index for an O(1) read,
 * and the digest is what actually authenticates. Matching on the prefix alone
 * would make a public identifier into a credential.
 *
 * `revoked_at IS NULL` is part of the same statement, so a revoked key stops
 * working immediately - there is no cache and no grace window.
 *
 * @param keyPrefix - non-secret public half of the presented key.
 * @param secretHash - SHA-256 of the FULL presented key.
 * @returns null for unknown, mismatched or revoked credentials. The three cases
 *   are deliberately indistinguishable so a caller cannot probe which applies.
 */
export async function authenticateApiCredential(
  executor: DatabaseExecutor,
  keyPrefix: string,
  secretHash: string,
): Promise<AuthenticatedApiCredential | null> {
  const rows = await executor
    .select({
      id: apiCredentials.id,
      workspaceId: apiCredentials.workspaceId,
    })
    .from(apiCredentials)
    .where(
      and(
        eq(apiCredentials.keyPrefix, keyPrefix),
        eq(apiCredentials.secretHash, secretHash),
        isNull(apiCredentials.revokedAt),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (row === undefined) {
    return null;
  }

  return {
    credentialId: row.id,
    workspaceId: row.workspaceId,
    // Built from the ROW's workspace id. This is the only place an API-key
    // request's tenant authority originates.
    scope: createWorkspaceScope(row.workspaceId),
  };
}
