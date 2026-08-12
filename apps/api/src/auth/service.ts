import { normaliseEmail } from '@hybrid/db';

import type { Clock } from './clock.js';
import type { AuthEmailSender } from './email.js';
import type { AuthStore } from './store.js';
import { generateToken, hashToken, isWellFormedToken } from './tokens.js';

/**
 * Authentication service.
 *
 * Owns identity only. Nothing here grants access to a workspace, and the
 * authenticated identity it returns carries no workspace, membership or role -
 * see `docs/adr/0002-authentication.md`.
 *
 * The plaintext magic-link and session tokens exist only inside this module and
 * in transit (email URL, cookie). Everything persisted is a SHA-256 digest.
 */

/** Magic links are short-lived: an emailed bearer credential should not linger. */
export const MAGIC_LINK_TTL_MS = 15 * 60 * 1_000; // 15 minutes

/** Browser sessions last two weeks; re-authenticating issues a fresh one. */
export const AUTH_SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1_000; // 14 days

/** Minimum gap between magic-link emails for one address. */
export const MAGIC_LINK_COOLDOWN_MS = 60 * 1_000; // 60 seconds

/**
 * An authenticated identity.
 *
 * NOTE WHAT IS ABSENT: no workspace id, no membership, no role, no permission.
 * That absence is the architecture. A caller holding this cannot construct a
 * `WorkspaceScope` from it.
 */
export interface AuthenticatedUser {
  readonly userId: string;
  readonly email: string;
  readonly authSessionId: string;
}

/** Result of establishing a session from a magic link. */
export interface EstablishedSession {
  /** Plaintext session token for the cookie. SENSITIVE - never log or persist. */
  readonly token: string;
  readonly expiresAt: Date;
  readonly userId: string;
}

export interface AuthServiceOptions {
  readonly store: AuthStore;
  readonly mailer: AuthEmailSender;
  readonly clock: Clock;
  /** Absolute origin used to build the sign-in URL. */
  readonly appUrl: string;
  /** Path of the API callback route the emailed link points at. */
  readonly callbackPath: string;
  readonly magicLinkTtlMs?: number;
  readonly sessionTtlMs?: number;
  readonly cooldownMs?: number;
}

export interface AuthService {
  requestMagicLink(email: string): Promise<void>;
  completeMagicLink(token: string): Promise<EstablishedSession | null>;
  authenticate(sessionToken: string): Promise<AuthenticatedUser | null>;
  logout(sessionToken: string): Promise<void>;
  readonly sessionTtlMs: number;
}

/** Builds the callback URL the recipient clicks. */
function buildMagicLinkUrl(appUrl: string, callbackPath: string, token: string): string {
  const url = new URL(callbackPath, appUrl);
  url.searchParams.set('token', token);
  return url.toString();
}

export function createAuthService(options: AuthServiceOptions): AuthService {
  const {
    store,
    mailer,
    clock,
    appUrl,
    callbackPath,
    magicLinkTtlMs = MAGIC_LINK_TTL_MS,
    sessionTtlMs = AUTH_SESSION_TTL_MS,
    cooldownMs = MAGIC_LINK_COOLDOWN_MS,
  } = options;

  return {
    sessionTtlMs,

    /**
     * Issues a magic link.
     *
     * ANTI-ENUMERATION: resolves identically whether the address is known,
     * unknown, or inside its cooldown. It returns nothing, so there is no value
     * for a caller to branch on.
     *
     * ABUSE CONTROL: a per-address cooldown enforced by a database query rather
     * than process memory, so it holds across multiple API instances. Exceeding
     * it silently skips sending - indistinguishable from a successful send, so
     * the endpoint cannot be probed to find active addresses, and cannot be
     * driven as an unrestricted email relay.
     */
    async requestMagicLink(rawEmail: string): Promise<void> {
      const email = normaliseEmail(rawEmail);
      const now = clock.now();

      const lastIssuedAt = await store.findLatestMagicLinkIssuedAt(email);
      if (lastIssuedAt !== null && now.getTime() - lastIssuedAt.getTime() < cooldownMs) {
        return;
      }

      // Passwordless onboarding: an unknown address becomes an identity here.
      // This grants no access - a user with no membership reaches no workspace.
      const user = await store.findOrCreateUser(email);

      const token = generateToken();
      await store.insertMagicLink({
        userId: user.id,
        email,
        tokenHash: hashToken(token),
        expiresAt: new Date(now.getTime() + magicLinkTtlMs),
      });

      await mailer.sendMagicLink({
        to: email,
        url: buildMagicLinkUrl(appUrl, callbackPath, token),
      });
    },

    /**
     * Redeems a magic link and establishes a session.
     *
     * Redemption and session creation are one transactional store operation, so
     * they cannot be split. Malformed tokens are rejected before any query.
     *
     * @returns null for malformed, unknown, expired or already-used tokens.
     *   The four cases are deliberately indistinguishable.
     */
    async completeMagicLink(token: string): Promise<EstablishedSession | null> {
      if (!isWellFormedToken(token)) {
        return null;
      }

      const now = clock.now();
      const sessionToken = generateToken();
      const expiresAt = new Date(now.getTime() + sessionTtlMs);

      const created = await store.consumeMagicLinkAndCreateSession({
        magicLinkTokenHash: hashToken(token),
        sessionTokenHash: hashToken(sessionToken),
        now,
        sessionExpiresAt: expiresAt,
      });

      if (created === null) {
        return null;
      }

      return { token: sessionToken, expiresAt, userId: created.userId };
    },

    /**
     * Resolves a session cookie to an identity.
     *
     * Presence, expiry and revocation are evaluated together in SQL against the
     * server clock, so there is no window between reading a session and judging
     * it valid.
     */
    async authenticate(sessionToken: string): Promise<AuthenticatedUser | null> {
      if (!isWellFormedToken(sessionToken)) {
        return null;
      }

      const session = await store.findActiveSession(hashToken(sessionToken), clock.now());
      if (session === null) {
        return null;
      }

      return {
        userId: session.userId,
        email: session.email,
        authSessionId: session.sessionId,
      };
    },

    /**
     * Revokes the session server-side.
     *
     * The caller also clears the cookie, but revocation is the actual security
     * boundary: a copy of the cookie taken before logout must stop working.
     *
     * Silent for unknown or malformed tokens - logout must never report whether
     * a session existed.
     */
    async logout(sessionToken: string): Promise<void> {
      if (!isWellFormedToken(sessionToken)) {
        return;
      }
      await store.revokeSession(hashToken(sessionToken), clock.now());
    },
  };
}
