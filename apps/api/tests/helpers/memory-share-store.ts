import { randomUUID } from 'node:crypto';

import type { AuthorizedWorkspace, ShareTokenRow, WorkspaceScope } from '@hybrid/db';

import { generateShareToken, hashShareToken, parseShareToken } from '../../src/share/tokens';
import type {
  IssuedShareLink,
  ReadOnlyShareContext,
  ShareManagementStore,
  ShareResolverStore,
} from '../../src/share/store';

/**
 * In-memory share stores, mirroring the production algorithm.
 *
 * ─── IT STORES A DIGEST, NOT A TOKEN ──────────────────────────────────────
 *
 * Deliberately faithful on the one point that matters most: the stored row has
 * NO field for a plaintext token, exactly as the table has no column for one.
 * A fake that kept the plaintext for convenience would let the hash-at-rest
 * tests pass while proving nothing.
 *
 * ─── RESOLUTION RE-CHECKS REVOCATION EVERY TIME ───────────────────────────
 *
 * `resolve` looks up by digest AND requires `revokedAt === null`, matching the
 * single SQL statement in production. There is no cached decision, so a
 * revoked link dies on the viewer's next read - which is what the acceptance
 * flow refreshes to observe.
 */

/** A stored share. Mirrors `share_tokens`: prefix and digest only. */
interface StoredShare {
  id: string;
  workspaceId: string;
  workspaceName: string;
  tokenPrefix: string;
  /** SHA-256. The plaintext is NEVER kept, here or in the table. */
  tokenHash: string;
  createdAt: Date;
  revokedAt: Date | null;
}

export interface MemoryShareStore extends ShareManagementStore, ShareResolverStore {
  /** Every stored row, for assertions. Contains no plaintext by construction. */
  readonly shares: StoredShare[];
  /** Serialised state, to prove a read changed nothing. */
  snapshot(): string;
}

export function createMemoryShareStore(): MemoryShareStore {
  const shares: StoredShare[] = [];

  return {
    shares,

    snapshot(): string {
      return JSON.stringify(shares);
    },

    issue(authorized: AuthorizedWorkspace): Promise<IssuedShareLink> {
      const generated = generateShareToken();
      const row: StoredShare = {
        id: randomUUID(),
        // Workspace from the proven authorization, never from input.
        workspaceId: authorized.workspace.id,
        workspaceName: authorized.workspace.name,
        tokenPrefix: generated.tokenPrefix,
        tokenHash: generated.tokenHash,
        createdAt: new Date('2026-08-14T10:00:00.000Z'),
        revokedAt: null,
      };
      shares.push(row);

      return Promise.resolve({
        share: toRow(row),
        // The one and only time the plaintext is handed out.
        token: generated.token,
      });
    },

    list(authorized: AuthorizedWorkspace): Promise<ShareTokenRow[]> {
      return Promise.resolve(
        shares
          .filter((s) => s.workspaceId === authorized.workspace.id)
          .map(toRow),
      );
    },

    revoke(
      authorized: AuthorizedWorkspace,
      shareId: string,
      at: Date,
    ): Promise<ShareTokenRow | null> {
      // Scoped: another workspace's share is simply not found.
      const found = shares.find(
        (s) => s.id === shareId && s.workspaceId === authorized.workspace.id,
      );
      if (found === undefined) {
        return Promise.resolve(null);
      }
      // Idempotent: the FIRST revocation instant is the one that matters.
      found.revokedAt ??= at;
      return Promise.resolve(toRow(found));
    },

    resolve(token: string): Promise<ReadOnlyShareContext | null> {
      const parsed = parseShareToken(token);
      if (parsed === null) {
        return Promise.resolve(null);
      }

      // Digest match AND not revoked, in one step - as the SQL does.
      const found = shares.find(
        (s) =>
          s.tokenPrefix === parsed.tokenPrefix &&
          s.tokenHash === hashShareToken(token) &&
          s.revokedAt === null,
      );
      if (found === undefined) {
        return Promise.resolve(null);
      }

      return Promise.resolve({
        shareTokenId: found.id,
        workspaceId: found.workspaceId,
        workspaceName: found.workspaceName,
        // Built from the ROW's workspace, never from anything a caller sent.
        // `createWorkspaceScope` is deliberately not exported from the package
        // root - a scope must come from a resolver - so the fake brands one
        // the same way the other memory stores do.
        scope: { workspaceId: found.workspaceId } as unknown as WorkspaceScope,
      });
    },
  };
}

/** Safe metadata. There is no branch that could include a digest. */
function toRow(share: StoredShare): ShareTokenRow {
  return {
    id: share.id,
    tokenPrefix: share.tokenPrefix,
    createdAt: share.createdAt,
    revokedAt: share.revokedAt,
  };
}
