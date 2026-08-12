import {
  AUTH_CALLBACK_PATH,
  AUTH_CALLBACK_RESULT_PARAM,
  AUTH_CALLBACK_TOKEN_PARAM,
  AUTH_LOGOUT_PATH,
  AUTH_MAGIC_LINK_PATH,
  AUTH_ME_PATH,
  currentUserResponseSchema,
  logoutResponseSchema,
  magicLinkRequestSchema,
  magicLinkResponseSchema,
} from '@hybrid/contracts';
import { Hono } from 'hono';

import { clearAuthCookie, readAuthCookie, writeAuthCookie } from '../auth/cookie.js';
import type { AuthService } from '../auth/service.js';

/**
 * Authentication routes.
 *
 * ERROR DISCIPLINE
 * ----------------
 * No response body ever carries a SQL error, a provider error body, a token, a
 * hash, a stack trace, or any signal of whether an account exists. Failures
 * collapse to a small set of generic outcomes.
 *
 * TOKEN HYGIENE
 * -------------
 * Nothing here logs a token or a full magic-link URL. The callback consumes the
 * token server-side and then redirects to a CLEAN application URL, so the
 * bearer credential is removed from the address bar, browser history and any
 * onward `Referer`.
 */

export interface AuthRouteOptions {
  /** Absent when the database is not configured; routes then report 503. */
  readonly service: AuthService | undefined;
  /** Absolute origin the callback redirects back to. */
  readonly appUrl: string | undefined;
  /** True in production; drives the cookie Secure attribute. */
  readonly secureCookies: boolean;
}

const SERVICE_UNAVAILABLE = 503;
const UNAUTHORIZED = 401;
const BAD_REQUEST = 400;
const FOUND = 302;

/** Uniform "auth is not configured here" body. Reveals no configuration detail. */
const UNAVAILABLE_BODY = { error: 'auth_unavailable' } as const;

export function createAuthRoutes(options: AuthRouteOptions): Hono {
  const routes = new Hono();
  const { service, appUrl, secureCookies } = options;

  /**
   * POST /v1/auth/magic-link
   *
   * Always answers `{ ok: true }` for a well-formed address - known, unknown or
   * rate-limited alike. Only a malformed address is rejected, which is a
   * validation fact about the input rather than a fact about the account.
   */
  routes.post(AUTH_MAGIC_LINK_PATH, async (c) => {
    if (service === undefined) {
      return c.json(UNAVAILABLE_BODY, SERVICE_UNAVAILABLE);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_request' }, BAD_REQUEST);
    }

    const parsed = magicLinkRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid_email' }, BAD_REQUEST);
    }

    try {
      await service.requestMagicLink(parsed.data.email);
    } catch {
      // A delivery or database failure must not become an existence oracle:
      // an attacker could otherwise compare a 500 for known addresses against
      // a 200 for unknown ones. The operational detail stays server-side.
      return c.json(magicLinkResponseSchema.parse({ ok: true }));
    }

    return c.json(magicLinkResponseSchema.parse({ ok: true }));
  });

  /**
   * GET /v1/auth/callback?token=...
   *
   * Consumes the token, sets the session cookie, and redirects to a clean URL.
   * Every failure - malformed, unknown, expired, already used - produces the
   * same `auth=invalid_link` outcome.
   *
   * OPEN REDIRECT: the destination is built from the configured APP_URL only.
   * There is deliberately no `returnTo` parameter, so there is nothing for a
   * caller to point elsewhere.
   */
  routes.get(AUTH_CALLBACK_PATH, async (c) => {
    if (service === undefined || appUrl === undefined) {
      return c.json(UNAVAILABLE_BODY, SERVICE_UNAVAILABLE);
    }

    const token = c.req.query(AUTH_CALLBACK_TOKEN_PARAM);

    let established = null;
    if (token !== undefined) {
      try {
        established = await service.completeMagicLink(token);
      } catch {
        established = null;
      }
    }

    if (established === null) {
      return c.redirect(buildResultUrl(appUrl, 'invalid_link'), FOUND);
    }

    writeAuthCookie(c, established.token, established.expiresAt, { secure: secureCookies });

    return c.redirect(buildResultUrl(appUrl, 'success'), FOUND);
  });

  /**
   * GET /v1/auth/me
   *
   * Identity only. Grants and reports no workspace access.
   */
  routes.get(AUTH_ME_PATH, async (c) => {
    if (service === undefined) {
      return c.json(UNAVAILABLE_BODY, SERVICE_UNAVAILABLE);
    }

    const cookie = readAuthCookie(c);
    if (cookie === undefined) {
      return c.json({ error: 'unauthenticated' }, UNAUTHORIZED);
    }

    const user = await service.authenticate(cookie);
    if (user === null) {
      return c.json({ error: 'unauthenticated' }, UNAUTHORIZED);
    }

    // Built through the shared contract, so no internal field can leak by
    // accidentally returning the whole session row.
    return c.json(
      currentUserResponseSchema.parse({ user: { id: user.userId, email: user.email } }),
    );
  });

  /**
   * POST /v1/auth/logout
   *
   * POST rather than GET on purpose: SameSite=Lax withholds the cookie from
   * cross-site POST, so a third-party page cannot force a logout, and no
   * prefetcher or link-scanner can sign the user out by following a URL.
   *
   * Always succeeds. Reporting whether a session existed would leak state.
   */
  routes.post(AUTH_LOGOUT_PATH, async (c) => {
    if (service === undefined) {
      return c.json(UNAVAILABLE_BODY, SERVICE_UNAVAILABLE);
    }

    const cookie = readAuthCookie(c);
    if (cookie !== undefined) {
      // Server-side revocation first: this is the real boundary.
      await service.logout(cookie);
    }
    clearAuthCookie(c, { secure: secureCookies });

    return c.json(logoutResponseSchema.parse({ ok: true }));
  });

  return routes;
}

function buildResultUrl(appUrl: string, result: 'success' | 'invalid_link'): string {
  const url = new URL('/', appUrl);
  url.searchParams.set(AUTH_CALLBACK_RESULT_PARAM, result);
  return url.toString();
}
