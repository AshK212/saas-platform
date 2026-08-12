import {
  authenticateApiCredential,
  createApiCredentialRepository,
  type ApiCredentialSummary,
  type AuthenticatedApiCredential,
  type AuthorizedWorkspace,
  type DatabaseClient,
} from '@hybrid/db';

/**
 * Persistence port for API credentials.
 *
 * Two clearly separated concerns, mirroring the two authentication domains:
 *
 *   MANAGEMENT   requires an `AuthorizedWorkspace` - the operator has already
 *                proven membership, so every query runs through the scoped
 *                repository.
 *
 *   AUTHENTICATE takes only digests and DISCOVERS the workspace. It cannot
 *                accept a scope, because producing one is its purpose.
 *
 * Keeping them on one port with different signatures makes the asymmetry
 * explicit: management is scope-in, authentication is scope-out.
 */

export interface IssueApiKeyCommand {
  readonly name: string;
  readonly keyPrefix: string;
  readonly secretHash: string;
}

export interface ApiKeyStore {
  /** Lists a workspace's credentials. Scope-bound; never returns a hash. */
  list(authorized: AuthorizedWorkspace): Promise<ApiCredentialSummary[]>;

  /** Persists a new credential. The plaintext key is never passed here. */
  issue(authorized: AuthorizedWorkspace, command: IssueApiKeyCommand): Promise<ApiCredentialSummary>;

  /**
   * Revokes a credential in the authorized workspace.
   *
   * @returns null when the credential is not in this workspace - so a
   *   cross-tenant revoke is indistinguishable from a missing credential.
   */
  revoke(
    authorized: AuthorizedWorkspace,
    credentialId: string,
    now: Date,
  ): Promise<ApiCredentialSummary | null>;

  /**
   * Resolves a presented key to its workspace.
   *
   * Returns the credential with a trusted scope derived from the credential
   * ROW, or null for unknown/mismatched/revoked keys.
   */
  authenticate(keyPrefix: string, secretHash: string): Promise<AuthenticatedApiCredential | null>;

  /** Best-effort telemetry. Failure must never fail authentication. */
  touchLastUsed(credential: AuthenticatedApiCredential, now: Date): Promise<void>;
}

export function createDrizzleApiKeyStore(db: DatabaseClient): ApiKeyStore {
  return {
    async list(authorized: AuthorizedWorkspace): Promise<ApiCredentialSummary[]> {
      return createApiCredentialRepository(db, authorized.scope).listAll();
    },

    async issue(
      authorized: AuthorizedWorkspace,
      command: IssueApiKeyCommand,
    ): Promise<ApiCredentialSummary> {
      return createApiCredentialRepository(db, authorized.scope).issue(command);
    },

    async revoke(
      authorized: AuthorizedWorkspace,
      credentialId: string,
      now: Date,
    ): Promise<ApiCredentialSummary | null> {
      return createApiCredentialRepository(db, authorized.scope).revoke(credentialId, now);
    },

    async authenticate(
      keyPrefix: string,
      secretHash: string,
    ): Promise<AuthenticatedApiCredential | null> {
      return authenticateApiCredential(db, keyPrefix, secretHash);
    },

    async touchLastUsed(credential: AuthenticatedApiCredential, now: Date): Promise<void> {
      // Uses the scope the credential itself produced, so this write stays
      // inside the same tenant boundary as the authentication that allowed it.
      await createApiCredentialRepository(db, credential.scope).touchLastUsed(
        credential.credentialId,
        now,
      );
    },
  };
}
