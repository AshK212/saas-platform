import {
  consumeMagicLink,
  findActiveAuthSession,
  findLatestMagicLinkIssuedAt,
  findOrCreateUserByEmail,
  insertAuthSession,
  insertMagicLink,
  revokeAuthSession,
  type DatabaseClient,
} from '@hybrid/db';

/**
 * The persistence port the auth service depends on.
 *
 * WHY A PORT RATHER THAN DIRECT DATA-LAYER CALLS
 * ----------------------------------------------
 * Two reasons, both structural:
 *
 *  1. The service's security behaviour - replay rejection, expiry, cooldown,
 *     revocation - becomes testable without a live PostgreSQL, so the default
 *     suite runs anywhere while still exercising the real logic.
 *
 *  2. It forces the transaction boundary to be a single named operation
 *     (`consumeMagicLinkAndCreateSession`) rather than something the service
 *     assembles. Redeem-and-create cannot accidentally be split into two calls
 *     by a later edit, because there is no API for doing so.
 *
 * Only hashes cross this port. Plaintext tokens never leave the service.
 */

export interface AuthStoreUser {
  readonly id: string;
  readonly email: string;
}

export interface CreatedSession {
  readonly userId: string;
}

export interface ActiveSession {
  readonly sessionId: string;
  readonly userId: string;
  readonly email: string;
}

export interface AuthStore {
  /** Most recent issuance for an address, for the abuse cooldown. */
  findLatestMagicLinkIssuedAt(email: string): Promise<Date | null>;

  /** Passwordless onboarding: resolve or create the identity. */
  findOrCreateUser(email: string): Promise<AuthStoreUser>;

  insertMagicLink(input: {
    userId: string;
    email: string;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<void>;

  /**
   * Atomically redeem a magic link AND create the resulting session.
   *
   * Both happen in one transaction so a failure between them cannot burn a
   * token without issuing a session. Returns null when the token is unknown,
   * expired or already consumed - the three cases are indistinguishable.
   */
  consumeMagicLinkAndCreateSession(input: {
    magicLinkTokenHash: string;
    sessionTokenHash: string;
    now: Date;
    sessionExpiresAt: Date;
  }): Promise<CreatedSession | null>;

  findActiveSession(tokenHash: string, now: Date): Promise<ActiveSession | null>;

  revokeSession(tokenHash: string, now: Date): Promise<void>;
}

/** Production store backed by Drizzle/PostgreSQL. */
export function createDrizzleAuthStore(db: DatabaseClient): AuthStore {
  return {
    async findLatestMagicLinkIssuedAt(email: string): Promise<Date | null> {
      return findLatestMagicLinkIssuedAt(db, email);
    },

    async findOrCreateUser(email: string): Promise<AuthStoreUser> {
      const user = await findOrCreateUserByEmail(db, email);
      return { id: user.id, email: user.email };
    },

    async insertMagicLink(input): Promise<void> {
      await insertMagicLink(db, input);
    },

    async consumeMagicLinkAndCreateSession(input): Promise<CreatedSession | null> {
      return db.transaction(async (tx) => {
        // Single atomic conditional UPDATE; see @hybrid/db consumeMagicLink for
        // why two concurrent callbacks cannot both match.
        const consumed = await consumeMagicLink(tx, input.magicLinkTokenHash, input.now);
        if (consumed === null) {
          return null;
        }

        await insertAuthSession(tx, {
          userId: consumed.userId,
          tokenHash: input.sessionTokenHash,
          expiresAt: input.sessionExpiresAt,
        });

        return { userId: consumed.userId };
      });
    },

    async findActiveSession(tokenHash: string, now: Date): Promise<ActiveSession | null> {
      const session = await findActiveAuthSession(db, tokenHash, now);
      if (session === null) {
        return null;
      }
      return {
        sessionId: session.sessionId,
        userId: session.userId,
        email: session.email,
      };
    },

    async revokeSession(tokenHash: string, now: Date): Promise<void> {
      await revokeAuthSession(db, tokenHash, now);
    },
  };
}
