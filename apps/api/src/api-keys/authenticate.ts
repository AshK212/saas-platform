import type { AuthenticatedApiCredential } from '@hybrid/db';
import type { Context } from 'hono';

import type { Clock } from '../auth/clock.js';
import type { ApiKeyStore } from './store.js';
import { parseApiKey } from './tokens.js';

/**
 * API-key (agent/machine) authentication.
 *
 * THE CENTRAL INVARIANT OF STEP 7
 * -------------------------------
 * The workspace is derived from `api_credentials.workspace_id` on the matched
 * row. It is NEVER read from a header, body field, query parameter or path
 * segment. This resolver takes no workspace argument at all, so a caller has
 * nothing to influence - the invariant is enforced by the function signature,
 * not by discipline.
 *
 * NOT A HUMAN IDENTITY
 * --------------------
 * The result carries no user, no membership and no role. An API key is not a
 * person, and no synthetic membership is fabricated for it. Operator
 * credential-management routes require a session cookie and will not accept a
 * bearer key.
 *
 * BEARER HEADER ONLY
 * ------------------
 * Keys are accepted exclusively from `Authorization: Bearer <key>`. Never from
 * a query string or URL path - those land in access logs, browser history,
 * proxy logs and `Referer` headers - and never from a body, which would make
 * the credential position depend on content type.
 */

export type ApiKeyAuthFailure =
  | 'missing_header'
  | 'unsupported_scheme'
  | 'malformed_key'
  | 'unknown_or_revoked';

export type ApiKeyAuthResult =
  | { readonly ok: true; readonly credential: AuthenticatedApiCredential }
  | { readonly ok: false; readonly reason: ApiKeyAuthFailure };

/**
 * Extracts the bearer token.
 *
 * The scheme is compared case-insensitively because RFC 7235 defines it as
 * case-insensitive; the token itself is compared exactly.
 */
function readBearerToken(header: string | undefined): ApiKeyAuthResult | string {
  if (header === undefined || header.trim() === '') {
    return { ok: false, reason: 'missing_header' };
  }

  const separator = header.indexOf(' ');
  if (separator === -1) {
    return { ok: false, reason: 'unsupported_scheme' };
  }

  const scheme = header.slice(0, separator);
  const token = header.slice(separator + 1).trim();

  if (scheme.toLowerCase() !== 'bearer') {
    return { ok: false, reason: 'unsupported_scheme' };
  }
  if (token === '') {
    return { ok: false, reason: 'malformed_key' };
  }

  return token;
}

export interface ApiKeyAuthenticatorOptions {
  readonly store: ApiKeyStore;
  readonly clock: Clock;
}

/**
 * Authenticates a request carrying an API key.
 *
 * The failure `reason` is for server-side diagnostics only. Callers must map
 * every variant to one identical 401 - distinguishing "unknown" from "revoked"
 * would confirm a key once existed, and distinguishing "malformed" from
 * "unknown" would let an attacker probe the key format.
 */
export async function authenticateApiKeyRequest(
  c: Context,
  options: ApiKeyAuthenticatorOptions,
): Promise<ApiKeyAuthResult> {
  const tokenOrFailure = readBearerToken(c.req.header('authorization'));
  if (typeof tokenOrFailure !== 'string') {
    return tokenOrFailure;
  }

  // Structural check first: rejects garbage without a database round trip.
  const parsed = parseApiKey(tokenOrFailure);
  if (parsed === null) {
    return { ok: false, reason: 'malformed_key' };
  }

  const credential = await options.store.authenticate(parsed.keyPrefix, parsed.secretHash);
  if (credential === null) {
    return { ok: false, reason: 'unknown_or_revoked' };
  }

  // Telemetry, deliberately not awaited into the failure path: a write problem
  // here must not deny a caller whose credential is valid.
  try {
    await options.store.touchLastUsed(credential, options.clock.now());
  } catch {
    // Intentionally swallowed. `last_used_at` is operational nicety, not auth.
  }

  return { ok: true, credential };
}

/** The single response every authentication failure maps to. */
export function apiKeyUnauthorizedBody(): { error: string } {
  return { error: 'unauthorized' };
}
