import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';

/**
 * The share-viewer cookie.
 *
 * ─── WHY A COOKIE AT ALL ──────────────────────────────────────────────────
 *
 * The alternative is a token in every request path - `/v1/share/:token/events`
 * and so on. That works and is stateless, but it writes a live bearer
 * credential into every access log line, every proxy log, every browser
 * history entry and every outbound `Referer` header, for the whole life of the
 * session. A share link is meant to be pasted into a chat or an email; it will
 * end up somewhere it was not meant to be, and multiplying its exposure by the
 * number of requests is the wrong default.
 *
 * With this exchange, the token appears in exactly ONE request body. Every
 * subsequent read carries the cookie instead, and cookies are not written to
 * access logs and are not sent as `Referer`.
 *
 * ─── WHAT IS IN IT ────────────────────────────────────────────────────────
 *
 * THE SAME SHARE TOKEN, and deliberately nothing else.
 *
 * The tempting design is to mint a signed session carrying the share id. That
 * would be a SECOND, INDEPENDENT credential - and a second credential can
 * outlive the first. A viewer holding a signed session after the operator
 * revoked the link would still be reading the workspace, which is precisely
 * the failure AC-18 exists to prevent.
 *
 * Because the cookie holds the original token, every read re-resolves it:
 * hash, look up, check `revoked_at IS NULL`. There is no cached decision, no
 * grace window and nothing to invalidate separately. Revocation is
 * authoritative by construction rather than by remembering to propagate it.
 *
 * ─── ATTRIBUTES AND WHY ───────────────────────────────────────────────────
 *
 *   HttpOnly       Script cannot read it, so an XSS bug cannot exfiltrate the
 *                  link. This is also why the token is never put in
 *                  localStorage, sessionStorage or IndexedDB - all readable by
 *                  any script on the page.
 *   Secure         Production only; omitted on localhost where there is no
 *                  HTTPS and setting it would silently break development.
 *   SameSite=Lax   The share surface is GET-only, so there is no state-changing
 *                  request to protect. Lax keeps a pasted link working when
 *                  followed from another site, which is the entire point of a
 *                  share link.
 *   Path=/v1/share SCOPED. The browser never sends this cookie to
 *                  `/v1/workspaces/*`, `/v1/events` or anything else, so a
 *                  share viewer's credential cannot even reach an operator or
 *                  machine route to be rejected by it.
 *   Max-Age        A short session. Expiry is a convenience, NOT the security
 *                  control - revocation is, and it does not wait for this.
 */

/** Namespaced, and distinct from the operator session cookie. */
export const SHARE_COOKIE_NAME = 'hybrid_share_view';

/** The only path the browser will attach this cookie to. */
export const SHARE_COOKIE_PATH = '/v1/share';

/**
 * Eight hours - long enough to read a dashboard without re-pasting the link,
 * short enough that a forgotten open tab does not hold a credential for weeks.
 */
export const SHARE_COOKIE_MAX_AGE_SECONDS = 8 * 60 * 60;

export interface ShareCookieOptions {
  /** True in production; drives the Secure attribute. */
  readonly secure: boolean;
}

export function readShareCookie(c: Context): string | undefined {
  return getCookie(c, SHARE_COOKIE_NAME);
}

export function writeShareCookie(c: Context, token: string, options: ShareCookieOptions): void {
  setCookie(c, SHARE_COOKIE_NAME, token, {
    httpOnly: true,
    secure: options.secure,
    sameSite: 'Lax',
    path: SHARE_COOKIE_PATH,
    maxAge: SHARE_COOKIE_MAX_AGE_SECONDS,
  });
}

/**
 * Clears the cookie.
 *
 * Cosmetic on its own, and that is fine here: the cookie holds the share token
 * itself, so its authority ends when the operator revokes the link, whether or
 * not any browser cooperated.
 */
export function clearShareCookie(c: Context, options: ShareCookieOptions): void {
  deleteCookie(c, SHARE_COOKIE_NAME, {
    httpOnly: true,
    secure: options.secure,
    sameSite: 'Lax',
    path: SHARE_COOKIE_PATH,
  });
}
