import { randomUUID } from 'node:crypto';

import type {
  ApiCredentialSummary,
  AuthenticatedApiCredential,
  AuthorizedWorkspace,
  WorkspaceScope,
} from '@hybrid/db';

import type { ApiKeyStore, IssueApiKeyCommand } from '../../src/api-keys/store';

/**
 * In-memory `ApiKeyStore` for route and resolver tests.
 *
 * Faithfully reproduces the semantics the production store depends on:
 * workspace-scoped management, prefix+hash authentication, and immediate
 * rejection of revoked credentials.
 *
 * WHAT IT DOES NOT PROVE
 * ----------------------
 * It is not PostgreSQL. It cannot prove the UNIQUE constraints on `key_prefix`
 * and `secret_hash`, nor real persistence. Those live in
 * `packages/db/tests/api-credentials.live.test.ts`, skipped without
 * `TEST_DATABASE_URL`.
 */

interface StoredCredential {
  id: string;
  workspaceId: string;
  name: string;
  keyPrefix: string;
  /** Present ONLY so tests can assert plaintext is never among these fields. */
  secretHash: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

export interface MemoryApiKeyStore extends ApiKeyStore {
  readonly credentials: StoredCredential[];
  /** Every value ever written to persistence, for leak assertions. */
  persistedBlob(): string;
}

function toSummary(credential: StoredCredential): ApiCredentialSummary {
  return {
    id: credential.id,
    name: credential.name,
    keyPrefix: credential.keyPrefix,
    createdAt: credential.createdAt,
    lastUsedAt: credential.lastUsedAt,
    revokedAt: credential.revokedAt,
  };
}

export function createMemoryApiKeyStore(): MemoryApiKeyStore {
  const credentials: StoredCredential[] = [];

  return {
    credentials,

    persistedBlob(): string {
      return JSON.stringify(credentials);
    },

    list(authorized: AuthorizedWorkspace): Promise<ApiCredentialSummary[]> {
      // Scope-bound, exactly as the production repository is.
      return Promise.resolve(
        credentials
          .filter((c) => c.workspaceId === authorized.scope.workspaceId)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .map(toSummary),
      );
    },

    issue(
      authorized: AuthorizedWorkspace,
      command: IssueApiKeyCommand,
    ): Promise<ApiCredentialSummary> {
      // Mirrors the UNIQUE constraints so the retry path can be exercised.
      if (credentials.some((c) => c.keyPrefix === command.keyPrefix)) {
        return Promise.reject(new Error('duplicate key_prefix'));
      }
      if (credentials.some((c) => c.secretHash === command.secretHash)) {
        return Promise.reject(new Error('duplicate secret_hash'));
      }

      const stored: StoredCredential = {
        id: randomUUID(),
        // Workspace comes from the SCOPE, never from the command.
        workspaceId: authorized.scope.workspaceId,
        name: command.name,
        keyPrefix: command.keyPrefix,
        secretHash: command.secretHash,
        createdAt: new Date(),
        lastUsedAt: null,
        revokedAt: null,
      };
      credentials.push(stored);
      return Promise.resolve(toSummary(stored));
    },

    revoke(
      authorized: AuthorizedWorkspace,
      credentialId: string,
      now: Date,
    ): Promise<ApiCredentialSummary | null> {
      const found = credentials.find(
        (c) => c.id === credentialId && c.workspaceId === authorized.scope.workspaceId,
      );
      if (found === undefined) {
        return Promise.resolve(null);
      }
      // Idempotent: an existing timestamp is preserved.
      found.revokedAt ??= now;
      return Promise.resolve(toSummary(found));
    },

    authenticate(
      keyPrefix: string,
      secretHash: string,
    ): Promise<AuthenticatedApiCredential | null> {
      const found = credentials.find(
        (c) => c.keyPrefix === keyPrefix && c.secretHash === secretHash && c.revokedAt === null,
      );
      if (found === undefined) {
        return Promise.resolve(null);
      }

      return Promise.resolve({
        credentialId: found.id,
        // Derived from the stored row - never from caller input.
        workspaceId: found.workspaceId,
        scope: { workspaceId: found.workspaceId } as unknown as WorkspaceScope,
      });
    },

    touchLastUsed(credential: AuthenticatedApiCredential, now: Date): Promise<void> {
      const found = credentials.find((c) => c.id === credential.credentialId);
      if (found !== undefined) {
        found.lastUsedAt = now;
      }
      return Promise.resolve();
    },
  };
}
