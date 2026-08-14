import {
  createShareTokenRepository,
  resolveShareToken,
  type AuthorizedWorkspace,
  type DatabaseClient,
  type ShareTokenRow,
  type WorkspaceScope,
} from '@hybrid/db';

import { generateShareToken, hashShareToken, parseShareToken } from './tokens.js';

/**
 * Share-token persistence: one management port, one resolution port.
 *
 * ─── THE THIRD AUTHORITY ──────────────────────────────────────────────────
 *
 * The plane now has three ways to prove a right to read one workspace:
 *
 *   operator   session -> user -> membership -> scope
 *   machine    bearer API key -> credential row -> scope
 *   share      share token -> share row -> scope        (this file)
 *
 * All three end in a `WorkspaceScope` and diverge in nothing else, which is
 * what lets the read stores be reused untouched. The DIFFERENCE is what each
 * one additionally carries: an operator carries a user and a role, a machine
 * carries a credential id, and a share carries neither.
 *
 * ─── READ-ONLY IS STRUCTURAL ──────────────────────────────────────────────
 *
 * `ReadOnlyShareContext` has no user, no role and no permission set. There is
 * no field a future route could inspect to decide it may write, and no flag to
 * flip. A share cannot become writable without changing this type, which is
 * the point: the restriction is in the shape, not in a check someone might
 * forget to perform.
 */

/**
 * Proof that a caller may READ one workspace, and nothing more.
 *
 * Deliberately NOT an `AuthorizedWorkspace`: that type carries a membership
 * role, and manufacturing one here would hand a share viewer a synthetic
 * identity that operator routes might later trust.
 */
export interface ReadOnlyShareContext {
  /** Which share link this is, for the audit. Never sent to the browser. */
  readonly shareTokenId: string;
  readonly workspaceId: string;
  readonly workspaceName: string;
  /** Trusted tenant scope, built from the share row's own workspace id. */
  readonly scope: WorkspaceScope;
}

/** Resolution: plaintext token in, read-only authority out. */
export interface ShareResolverStore {
  /**
   * @param token - the plaintext presented by the viewer.
   * @returns null for unknown, malformed and revoked alike. The caller must
   *   report all three identically.
   */
  resolve(token: string): Promise<ReadOnlyShareContext | null>;
}

/** A newly issued link. The only object that ever carries a plaintext token. */
export interface IssuedShareLink {
  readonly share: ShareTokenRow;
  /** PLAINTEXT. Returned once, up the stack, and never persisted. */
  readonly token: string;
}

/** Management: operator-only, and already inside a proven workspace. */
export interface ShareManagementStore {
  issue(authorized: AuthorizedWorkspace): Promise<IssuedShareLink>;
  list(authorized: AuthorizedWorkspace): Promise<ShareTokenRow[]>;
  /** @returns null when the share is not in this workspace. */
  revoke(authorized: AuthorizedWorkspace, shareId: string, at: Date): Promise<ShareTokenRow | null>;
}

/**
 * Bounded retry for the astronomically unlikely unique-index collision.
 *
 * Two independent 72-bit and 256-bit draws colliding is not a real event, but
 * the columns are UNIQUE and an unhandled constraint violation would surface
 * as an opaque 500. Retrying twice costs nothing and keeps the failure honest;
 * relaxing the constraint to avoid it would be the wrong trade entirely.
 */
const MAX_ISSUE_ATTEMPTS = 3;

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '23505'
  );
}

export function createDrizzleShareManagementStore(db: DatabaseClient): ShareManagementStore {
  return {
    async issue(authorized: AuthorizedWorkspace): Promise<IssuedShareLink> {
      const repository = createShareTokenRepository(db, authorized.scope);

      let lastError: unknown;
      for (let attempt = 0; attempt < MAX_ISSUE_ATTEMPTS; attempt += 1) {
        // Fresh material per attempt: a collision means these exact bytes are
        // taken, so retrying with the same ones would fail identically.
        const generated = generateShareToken();
        try {
          const share = await repository.insert({
            tokenPrefix: generated.tokenPrefix,
            tokenHash: generated.tokenHash,
          });
          // The ONLY point at which a plaintext token leaves this module.
          return { share, token: generated.token };
        } catch (error: unknown) {
          if (!isUniqueViolation(error)) {
            throw error;
          }
          lastError = error;
        }
      }
      throw lastError instanceof Error
        ? lastError
        : new Error('Failed to issue a unique share link.');
    },

    async list(authorized: AuthorizedWorkspace): Promise<ShareTokenRow[]> {
      return createShareTokenRepository(db, authorized.scope).list();
    },

    async revoke(
      authorized: AuthorizedWorkspace,
      shareId: string,
      at: Date,
    ): Promise<ShareTokenRow | null> {
      return createShareTokenRepository(db, authorized.scope).revoke(shareId, at);
    },
  };
}

export function createDrizzleShareResolverStore(db: DatabaseClient): ShareResolverStore {
  return {
    async resolve(token: string): Promise<ReadOnlyShareContext | null> {
      // Structural screen first: a malformed value never reaches the database,
      // and never becomes a digest lookup that could be timed.
      const parsed = parseShareToken(token);
      if (parsed === null) {
        return null;
      }

      const resolved = await resolveShareToken(db, parsed.tokenPrefix, parsed.tokenHash);
      if (resolved === null) {
        return null;
      }

      return {
        shareTokenId: resolved.shareTokenId,
        workspaceId: resolved.workspaceId,
        workspaceName: resolved.workspaceName,
        scope: resolved.scope,
      };
    },
  };
}

/** Re-exported so route code never reaches into the token module directly. */
export { hashShareToken };
