import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';

/**
 * Authentication cookie handling.
 *
 * ATTRIBUTES AND WHY
 * ------------------
 *   HttpOnly           JavaScript cannot read the session token, so an XSS bug
 *                      cannot exfiltrate the credential. This is why the token
 *                      is never placed in localStorage or sessionStorage - both
 *                      are readable by any script on the page.
 *   Secure             Set in production so the cookie is never sent over
 *                      plaintext HTTP. Omitted on localhost, where there is no
 *                      HTTPS and setting it would silently break development.
 *   SameSite=Lax       The browser withholds this cookie from cross-site POST,
 *                      PUT and DELETE, which is the CSRF defence for every
 *                      mutating route. Lax still sends it on top-level GET
 *                      navigation, so following the emailed link works.
 *   Path=/             One session for the whole application.
 *   Max-Age            Matches the server-side session expiry, so the browser
 *                      stops presenting a credential the server would reject.
 *
 * The cookie is the ONLY place the plaintext session token lives client-side.
 */

/** Namespaced so it cannot collide with another app on a shared host. */
export const AUTH_COOKIE_NAME = 'hybrid_auth_session';

export interface AuthCookieOptions {
  /** True in production; drives the Secure attribute. */
  readonly secure: boolean;
}

export function readAuthCookie(c: Context): string | undefined {
  return getCookie(c, AUTH_COOKIE_NAME);
}

export function writeAuthCookie(
  c: Context,
  token: string,
  expiresAt: Date,
  options: AuthCookieOptions,
): void {
  const maxAgeSeconds = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1_000));

  setCookie(c, AUTH_COOKIE_NAME, token, {
    httpOnly: true,
    secure: options.secure,
    sameSite: 'Lax',
    path: '/',
    maxAge: maxAgeSeconds,
  });
}

/**
 * Clears the cookie.
 *
 * Cosmetic on its own - the server-side session must also be revoked, or a
 * copied cookie would keep working. See `AuthService.logout`.
 */
export function clearAuthCookie(c: Context, options: AuthCookieOptions): void {
  deleteCookie(c, AUTH_COOKIE_NAME, {
    httpOnly: true,
    secure: options.secure,
    sameSite: 'Lax',
    path: '/',
  });
}
