import { and, desc, eq, isNull, type SQL } from 'drizzle-orm';

import type { DatabaseExecutor } from './executor.js';
import type { WorkspaceScope } from './workspace-scope.js';
import { shareTokens } from '../schema/sharing.js';

/**
 * Workspace-scoped share-token management.
 *
 * ─── SECRET HANDLING ──────────────────────────────────────────────────────
 *
 * There is NO method that returns a token, and no column capable of holding
 * one. `insert` accepts an already-computed prefix and digest; the plaintext
 * never reaches this module. That is not a convention to remember - the
 * function signature makes a plaintext leak from here impossible.
 *
 * A guardrail test asserts `tokenHash` never appears in any projection.
 *
 * ─── REVOCATION IS A TIMESTAMP, NOT A DELETE ──────────────────────────────
 *
 * A revoked share stays in the table. Deleting it would destroy the record
 * that a link once existed and was withdrawn, which is exactly the thing an
 * operator investigating an exposure needs to see.
 */

/** The tenant predicate every query in this file must carry. */
function shareScopePredicate(scope: WorkspaceScope): SQL {
  return eq(shareTokens.workspaceId, scope.workspaceId);
}

/** Safe metadata. Deliberately has no field for a token or a digest. */
export interface ShareTokenRow {
  readonly id: string;
  readonly tokenPrefix: string;
  readonly createdAt: Date;
  readonly revokedAt: Date | null;
}

/** The projection every read shares. NOTE the absence of `tokenHash`. */
const SHARE_COLUMNS = {
  id: shareTokens.id,
  tokenPrefix: shareTokens.tokenPrefix,
  createdAt: shareTokens.createdAt,
  revokedAt: shareTokens.revokedAt,
} as const;

export const shareTokenQueries = {
  /** Every share for this workspace, newest first. Revoked ones included. */
  list: (executor: DatabaseExecutor, scope: WorkspaceScope) =>
    executor
      .select(SHARE_COLUMNS)
      .from(shareTokens)
      .where(shareScopePredicate(scope))
      .orderBy(desc(shareTokens.createdAt), desc(shareTokens.id)),

  /** One share, by id, inside this workspace. */
  findById: (executor: DatabaseExecutor, scope: WorkspaceScope, shareId: string) =>
    executor
      .select(SHARE_COLUMNS)
      .from(shareTokens)
      .where(and(shareScopePredicate(scope), eq(shareTokens.id, shareId)))
      .limit(1),
} as const;

/** What issuance persists. The caller has already hashed the plaintext. */
export interface InsertShareTokenInput {
  /** Non-secret public half. */
  readonly tokenPrefix: string;
  /** SHA-256 of the FULL token. The plaintext is never passed in. */
  readonly tokenHash: string;
}

export interface ShareTokenRepository {
  list(): Promise<ShareTokenRow[]>;
  findById(shareId: string): Promise<ShareTokenRow | null>;
  insert(input: InsertShareTokenInput): Promise<ShareTokenRow>;
  /**
   * Marks a share revoked.
   *
   * IDEMPOTENT: the predicate includes `revoked_at IS NULL`, so revoking twice
   * is a no-op rather than a second timestamp overwriting the first. The
   * ORIGINAL revocation instant is the one that matters for an audit.
   *
   * @returns the row when it exists in this workspace, whatever its state.
   *   Null means "no such share here", which the route reports as 404.
   */
  revoke(shareId: string, at: Date): Promise<ShareTokenRow | null>;
}

function toRow(row: {
  id: string;
  tokenPrefix: string;
  createdAt: Date;
  revokedAt: Date | null;
}): ShareTokenRow {
  return row;
}

export function createShareTokenRepository(
  executor: DatabaseExecutor,
  scope: WorkspaceScope,
): ShareTokenRepository {
  return {
    async list(): Promise<ShareTokenRow[]> {
      return (await shareTokenQueries.list(executor, scope)).map(toRow);
    },

    async findById(shareId: string): Promise<ShareTokenRow | null> {
      const rows = await shareTokenQueries.findById(executor, scope, shareId);
      const row = rows[0];
      return row === undefined ? null : toRow(row);
    },

    async insert(input: InsertShareTokenInput): Promise<ShareTokenRow> {
      const inserted = await executor
        .insert(shareTokens)
        .values({
          // Workspace from the SCOPE, never from caller input.
          workspaceId: scope.workspaceId,
          tokenPrefix: input.tokenPrefix,
          tokenHash: input.tokenHash,
        })
        .returning(SHARE_COLUMNS);

      const row = inserted[0];
      if (row === undefined) {
        throw new Error('Failed to issue the share link.');
      }
      return toRow(row);
    },

    async revoke(shareId: string, at: Date): Promise<ShareTokenRow | null> {
      const updated = await executor
        .update(shareTokens)
        .set({ revokedAt: at })
        .where(
          and(
            shareScopePredicate(scope),
            eq(shareTokens.id, shareId),
            // Already revoked -> no rows updated, first timestamp preserved.
            isNull(shareTokens.revokedAt),
          ),
        )
        .returning(SHARE_COLUMNS);

      const row = updated[0];
      if (row !== undefined) {
        return toRow(row);
      }
      // Either already revoked, or not in this workspace. Reading it back
      // distinguishes the two for the CALLER, who has already proven operator
      // membership - the public surface never learns either.
      return this.findById(shareId);
    },
  };
}
