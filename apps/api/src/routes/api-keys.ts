import {
  API_KEY_IDENTITY_PATH,
  apiKeyIdentityResponseSchema,
  apiKeyListResponseSchema,
  createApiKeyRequestSchema,
  createApiKeyResponseSchema,
  revokeApiKeyResponseSchema,
  WORKSPACE_API_KEYS_SEGMENT,
  type ApiKeySummary,
} from '@hybrid/contracts';
import type { ApiCredentialSummary, AuthorizedWorkspace } from '@hybrid/db';
import { Hono, type Context } from 'hono';

import { apiKeyUnauthorizedBody, authenticateApiKeyRequest } from '../api-keys/authenticate.js';
import type { ApiKeyStore } from '../api-keys/store.js';
import { generateApiKey } from '../api-keys/tokens.js';
import type { Clock } from '../auth/clock.js';
import { requireAuthenticatedUser } from '../auth/middleware.js';
import type { AuthService } from '../auth/service.js';
import type { WorkspaceStore } from '../workspaces/store.js';

/**
 * API-credential routes.
 *
 * TWO AUTHENTICATION DOMAINS, DELIBERATELY NOT INTERCHANGEABLE
 * ------------------------------------------------------------
 *   Management (issue / list / revoke)
 *     session cookie -> AuthenticatedUser -> membership -> operator role
 *     -> AuthorizedWorkspace. Also passes the Step 6 origin guard, since these
 *     are cookie-authenticated browser mutations.
 *
 *   Agent probe
 *     Authorization: Bearer <key> -> credential row -> workspace.
 *
 * A bearer key cannot manage credentials: the management handlers only ever
 * consult the session cookie. A session cookie cannot authenticate the probe:
 * it only ever reads the Authorization header. Tests assert both directions.
 *
 * POLICY MUTATION IS OUT OF REACH FOR API KEYS - permanently. Policy changes
 * happen only through authenticated operator flows. No route here, and none
 * added later, may give a bearer-authenticated caller policy-write authority.
 */

const WORKSPACE_KEYS_PATH = `/v1/workspaces/:workspaceId/${WORKSPACE_API_KEYS_SEGMENT}`;
const REVOKE_PATH = `${WORKSPACE_KEYS_PATH}/:credentialId/revoke`;

const SERVICE_UNAVAILABLE = 503;
const UNAUTHORIZED = 401;
const FORBIDDEN = 403;
const NOT_FOUND = 404;
const BAD_REQUEST = 400;
const CREATED = 201;

const UNAVAILABLE_BODY = { error: 'api_keys_unavailable' } as const;

/**
 * A workspace the caller cannot reach is `not_found`, matching Step 6.
 *
 * 403 would confirm the workspace exists and let a non-member enumerate tenant
 * ids. Insufficient ROLE is different: the caller is already a proven member,
 * so they know the workspace exists and 403 reveals nothing new.
 */
const NOT_FOUND_BODY = { error: 'not_found' } as const;
const FORBIDDEN_ROLE_BODY = { error: 'insufficient_role' } as const;

/** Maps a stored credential to its safe client shape. Never includes a hash. */
function toSummary(credential: ApiCredentialSummary): ApiKeySummary {
  return {
    id: credential.id,
    name: credential.name,
    keyPrefix: credential.keyPrefix,
    status: credential.revokedAt === null ? 'active' : 'revoked',
    createdAt: credential.createdAt.toISOString(),
    lastUsedAt: credential.lastUsedAt?.toISOString() ?? null,
    revokedAt: credential.revokedAt?.toISOString() ?? null,
  };
}

export interface ApiKeyRouteOptions {
  readonly apiKeyStore: ApiKeyStore | undefined;
  readonly workspaceStore: WorkspaceStore | undefined;
  readonly authService: AuthService | undefined;
  readonly clock: Clock;
}

/** Bounded retry for the negligible case of a unique-constraint collision. */
const MAX_ISSUE_ATTEMPTS = 3;

export function createApiKeyRoutes(options: ApiKeyRouteOptions): Hono {
  const routes = new Hono();
  const { apiKeyStore, workspaceStore, authService, clock } = options;

  /**
   * Resolves the caller to an operator-authorized workspace.
   *
   * Returns the error response rather than throwing, so each handler decides
   * nothing about status codes.
   */
  async function requireOperatorWorkspace(
    c: Context,
  ): Promise<{ ok: true; authorized: AuthorizedWorkspace } | { ok: false; response: Response }> {
    const auth = await requireAuthenticatedUser(c, authService);
    if (!auth.ok) {
      return { ok: false, response: auth.response };
    }

    if (workspaceStore === undefined) {
      return { ok: false, response: c.json(UNAVAILABLE_BODY, SERVICE_UNAVAILABLE) };
    }

    // Membership is the authorization; the path parameter is only a lookup.
    const authorized = await workspaceStore.authorize(
      auth.user.userId,
      c.req.param('workspaceId') ?? '',
    );
    if (authorized === null) {
      return { ok: false, response: c.json(NOT_FOUND_BODY, NOT_FOUND) };
    }

    // Credential management is operator-only. A `member` may act inside the
    // workspace but must not mint or destroy its machine credentials.
    if (authorized.workspace.role !== 'operator') {
      return { ok: false, response: c.json(FORBIDDEN_ROLE_BODY, FORBIDDEN) };
    }

    return { ok: true, authorized };
  }

  /**
   * POST /v1/workspaces/:workspaceId/api-keys
   *
   * SHOW-ONCE: the plaintext key is generated here, returned in this response,
   * and never persisted or returned again.
   */
  routes.post(WORKSPACE_KEYS_PATH, async (c) => {
    if (apiKeyStore === undefined) {
      return c.json(UNAVAILABLE_BODY, SERVICE_UNAVAILABLE);
    }

    const gate = await requireOperatorWorkspace(c);
    if (!gate.ok) {
      return gate.response;
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_request' }, BAD_REQUEST);
    }

    const parsed = createApiKeyRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid_key_name' }, BAD_REQUEST);
    }

    // A 256-bit collision is effectively impossible, but `key_prefix` and
    // `secret_hash` are both UNIQUE, so a constraint violation is retried a
    // bounded number of times rather than surfacing as a 500.
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_ISSUE_ATTEMPTS; attempt += 1) {
      const generated = generateApiKey();
      try {
        const stored = await apiKeyStore.issue(gate.authorized, {
          name: parsed.data.name,
          keyPrefix: generated.keyPrefix,
          // Only the digest reaches persistence.
          secretHash: generated.secretHash,
        });

        return c.json(
          createApiKeyResponseSchema.parse({
            apiKey: { ...toSummary(stored), key: generated.key },
          }),
          CREATED,
        );
      } catch (error: unknown) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error('Failed to issue API key.');
  });

  /** GET /v1/workspaces/:workspaceId/api-keys - safe metadata only. */
  routes.get(WORKSPACE_KEYS_PATH, async (c) => {
    if (apiKeyStore === undefined) {
      return c.json(UNAVAILABLE_BODY, SERVICE_UNAVAILABLE);
    }

    const gate = await requireOperatorWorkspace(c);
    if (!gate.ok) {
      return gate.response;
    }

    const credentials = await apiKeyStore.list(gate.authorized);

    // No plaintext exists to return, and the hash is never selected.
    return c.json(apiKeyListResponseSchema.parse({ apiKeys: credentials.map(toSummary) }));
  });

  /**
   * POST /v1/workspaces/:workspaceId/api-keys/:credentialId/revoke
   *
   * Idempotent: revoking an already-revoked credential succeeds and leaves the
   * original timestamp intact. The row is never deleted - it is audit history.
   */
  routes.post(REVOKE_PATH, async (c) => {
    if (apiKeyStore === undefined) {
      return c.json(UNAVAILABLE_BODY, SERVICE_UNAVAILABLE);
    }

    const gate = await requireOperatorWorkspace(c);
    if (!gate.ok) {
      return gate.response;
    }

    const revoked = await apiKeyStore.revoke(
      gate.authorized,
      c.req.param('credentialId') ?? '',
      clock.now(),
    );

    // A credential in another workspace is reported exactly like a missing one.
    if (revoked === null) {
      return c.json(NOT_FOUND_BODY, NOT_FOUND);
    }

    return c.json(revokeApiKeyResponseSchema.parse({ apiKey: toSummary(revoked) }));
  });

  /**
   * GET /v1/api-key/me - bearer-authentication probe.
   *
   * FOUNDATIONAL, NOT A PRODUCT SURFACE. It exists so the API-key boundary can
   * be demonstrated end to end over real HTTP before any agent or event route
   * exists. It returns no secret and no tenant data - only confirmation, plus
   * the workspace the credential itself resolved to.
   *
   * Requires NO session cookie, and deliberately ignores one if present.
   */
  routes.get(API_KEY_IDENTITY_PATH, async (c) => {
    if (apiKeyStore === undefined) {
      return c.json(UNAVAILABLE_BODY, SERVICE_UNAVAILABLE);
    }

    const result = await authenticateApiKeyRequest(c, { store: apiKeyStore, clock });
    if (!result.ok) {
      // Every failure category collapses to one identical 401.
      return c.json(apiKeyUnauthorizedBody(), UNAUTHORIZED);
    }

    return c.json(
      apiKeyIdentityResponseSchema.parse({
        authenticated: true,
        // Straight from the credential row. No request input contributed.
        workspaceId: result.credential.workspaceId,
      }),
    );
  });

  return routes;
}
