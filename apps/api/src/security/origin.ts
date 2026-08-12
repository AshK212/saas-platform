import type { Context, MiddlewareHandler, Next } from 'hono';

import { AUTH_COOKIE_NAME } from '../auth/cookie.js';

/**
 * CSRF protection via origin checking.
 *
 * WHY THIS EXISTS NOW
 * -------------------
 * Step 5 deferred CSRF work with an explicit trigger: revisit when authenticated
 * operator mutations arrive. `POST /v1/workspaces` is the first one, so this is
 * that revisit.
 *
 * THE THREAT
 * ----------
 * The session cookie is ambient authority: the browser attaches it to requests
 * the user did not intend. Without a check, a page on `attacker.example` could
 * submit a form to `POST /v1/workspaces` and act as the victim.
 *
 * DEFENCE IN DEPTH - TWO INDEPENDENT LAYERS
 * -----------------------------------------
 *   1. `SameSite=Lax` on the session cookie. Browsers withhold it from
 *      cross-site POST entirely, so the forged request arrives unauthenticated.
 *   2. This origin check. It does not rely on the browser honouring SameSite,
 *      and it also covers same-site-but-different-origin cases that Lax permits
 *      (for example another subdomain, since Lax is site-scoped, not
 *      origin-scoped).
 *
 * Either layer alone would stop the classic attack. Both are cheap.
 *
 * THE RULE
 * --------
 * For state-changing methods:
 *
 *   1. `Origin` present  -> must be in the allowlist, else 403.
 *   2. `Origin` absent   -> rejected ONLY IF the request carries the auth
 *                           cookie. No cookie means no ambient authority to
 *                           abuse, so there is nothing to forge.
 *   3. Otherwise         -> allowed.
 *
 * Rule 2 is what keeps non-browser clients usable. `curl` and the simulator
 * send no `Origin`; they also present no cookie, and from Step 7 they will
 * authenticate with an API key in an explicit header - a credential the browser
 * never attaches automatically, so it is not forgeable this way.
 *
 * Safe methods (GET/HEAD/OPTIONS) are not checked. They must not change state,
 * and blocking them would break following an emailed link.
 */

/** Methods that may change state and therefore require an origin check. */
const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export interface OriginGuardOptions {
  /**
   * Origins permitted to make state-changing requests. Normally just the app's
   * own origin; a second entry appears only in a split-origin deployment.
   *
   * An EMPTY allowlist rejects every cookie-authenticated mutation. That is the
   * safe direction: a misconfigured deployment refuses writes rather than
   * accepting them from anywhere.
   */
  readonly allowedOrigins: readonly string[];
}

/** Normalises to scheme://host[:port], so path or trailing slash cannot differ. */
function toOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export function buildAllowedOrigins(
  appUrl: string | undefined,
  webOrigin: string | undefined,
): string[] {
  const origins = new Set<string>();
  for (const candidate of [appUrl, webOrigin]) {
    if (candidate === undefined) {
      continue;
    }
    const origin = toOrigin(candidate);
    if (origin !== null) {
      origins.add(origin);
    }
  }
  return [...origins];
}

function hasAuthCookie(c: Context): boolean {
  // Read the raw header rather than a cookie helper: the question is only
  // whether the browser attached ambient authority, not whether it is valid.
  const cookieHeader = c.req.header('cookie');
  return cookieHeader !== undefined && cookieHeader.includes(`${AUTH_COOKIE_NAME}=`);
}

/**
 * Rejects cross-origin state-changing requests.
 *
 * The 403 body is a fixed code. It never echoes the offending origin or the
 * allowlist - that would tell an attacker exactly what to spoof.
 */
export function originGuard(options: OriginGuardOptions): MiddlewareHandler {
  const allowed = new Set(options.allowedOrigins);

  return async (c: Context, next: Next) => {
    if (!STATE_CHANGING_METHODS.has(c.req.method)) {
      return next();
    }

    const origin = c.req.header('origin');

    if (origin !== undefined) {
      const normalised = toOrigin(origin);
      if (normalised === null || !allowed.has(normalised)) {
        return c.json({ error: 'forbidden_origin' }, 403);
      }
      return next();
    }

    // No Origin header. Only a problem when ambient cookie authority is present.
    if (hasAuthCookie(c)) {
      return c.json({ error: 'forbidden_origin' }, 403);
    }

    return next();
  };
}
