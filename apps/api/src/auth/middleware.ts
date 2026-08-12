import type { Context } from 'hono';

import { readAuthCookie } from './cookie.js';
import type { AuthenticatedUser, AuthService } from './service.js';

/**
 * Authentication resolution for protected routes.
 *
 * Returns an `AuthenticatedUser`, which proves IDENTITY ONLY. It carries no
 * workspace, membership or role, so a route holding one still cannot touch
 * tenant data - it must go through `authorizeWorkspaceForUser` first.
 */

export type AuthOutcome =
  | { readonly ok: true; readonly user: AuthenticatedUser }
  | { readonly ok: false; readonly response: Response };

const UNAUTHORIZED = 401;
const SERVICE_UNAVAILABLE = 503;

/**
 * Resolves the caller, or produces the error response to return.
 *
 * Unauthenticated, expired, revoked and malformed cookies all yield the same
 * generic 401, so none of them can be distinguished by a caller.
 */
export async function requireAuthenticatedUser(
  c: Context,
  service: AuthService | undefined,
): Promise<AuthOutcome> {
  if (service === undefined) {
    return { ok: false, response: c.json({ error: 'auth_unavailable' }, SERVICE_UNAVAILABLE) };
  }

  const cookie = readAuthCookie(c);
  if (cookie === undefined) {
    return { ok: false, response: c.json({ error: 'unauthenticated' }, UNAUTHORIZED) };
  }

  const user = await service.authenticate(cookie);
  if (user === null) {
    return { ok: false, response: c.json({ error: 'unauthenticated' }, UNAUTHORIZED) };
  }

  return { ok: true, user };
}
