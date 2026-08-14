import { and, eq, isNull } from 'drizzle-orm';

import type { DatabaseExecutor } from '../repositories/executor.js';
import { createWorkspaceScope, type WorkspaceScope } from '../repositories/workspace-scope.js';
import { shareTokens } from '../schema/sharing.js';
import { workspaces } from '../schema/workspaces.js';

/**
 * Share-token resolution - the READ-ONLY PUBLIC authorization boundary.
 *
 * ─── WHY A RESOLVER AND NOT A REPOSITORY ──────────────────────────────────
 *
 * Repositories require a `WorkspaceScope`. This lookup cannot have one: its
 * entire purpose is to DISCOVER which workspace a presented token belongs to.
 * Requiring a scope would be circular - exactly as it is for membership in
 * `authorization.ts` and for API keys in `api-credentials.ts`.
 *
 * It is still tightly bounded. The only way in is possession of a valid token:
 * the query matches on both the non-secret prefix AND the SHA-256 digest of
 * the full token, and there is deliberately NO "list share tokens", NO "find
 * by workspace", and NO way to enumerate anything from here. Workspace-scoped
 * management lives in the repository, where a scope is already proven.
 *
 * ─── THE INVARIANT THIS FILE EXISTS TO ENFORCE ────────────────────────────
 *
 * The workspace comes from `share_tokens.workspace_id` on the matched row -
 * never from a header, body field, query parameter or path segment. This
 * function takes no workspace argument at all, so a caller has nothing to
 * influence. A token is bound to exactly one workspace, permanently.
 *
 * ─── REVOCATION IS PART OF THE SAME STATEMENT ─────────────────────────────
 *
 * `revoked_at IS NULL` sits in the WHERE clause, so a revoked token stops
 * resolving the instant the revocation commits. There is no cache, no grace
 * window and no session that could outlive it - every read re-runs this.
 */

/** A successfully resolved share token. Carries no secret and no user. */
export interface ResolvedShareToken {
  readonly shareTokenId: string;
  /** Derived from the token row. Not caller-supplied. */
  readonly workspaceId: string;
  /** Display name, so a viewer knows whose data they are looking at. */
  readonly workspaceName: string;
  /** Trusted tenant scope, built from the row's own workspace id. */
  readonly scope: WorkspaceScope;
}

/**
 * Resolves a presented share token to its workspace.
 *
 * Both halves are required: the prefix uses the unique index for an O(1) read,
 * and the digest is what actually authenticates. Matching on the prefix alone
 * would turn a public identifier into a credential.
 *
 * @param tokenPrefix - non-secret public half of the presented token.
 * @param tokenHash - SHA-256 of the FULL presented token.
 * @returns null for unknown, mismatched or revoked tokens. The three cases are
 *   deliberately indistinguishable so a caller cannot probe which applies.
 */
export async function resolveShareToken(
  executor: DatabaseExecutor,
  tokenPrefix: string,
  tokenHash: string,
): Promise<ResolvedShareToken | null> {
  const rows = await executor
    .select({
      id: shareTokens.id,
      workspaceId: shareTokens.workspaceId,
      workspaceName: workspaces.name,
    })
    .from(shareTokens)
    // Joined for the display name only. The join cannot widen authority: the
    // workspace is still whichever one the token row points at.
    .innerJoin(workspaces, eq(workspaces.id, shareTokens.workspaceId))
    .where(
      and(
        eq(shareTokens.tokenPrefix, tokenPrefix),
        eq(shareTokens.tokenHash, tokenHash),
        isNull(shareTokens.revokedAt),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (row === undefined) {
    return null;
  }

  return {
    shareTokenId: row.id,
    workspaceId: row.workspaceId,
    workspaceName: row.workspaceName,
    // Built from the ROW's workspace id, never from anything a caller sent.
    scope: createWorkspaceScope(row.workspaceId),
  };
}
