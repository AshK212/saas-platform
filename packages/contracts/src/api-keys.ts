import { z } from 'zod';

/**
 * Step 7 workspace API-credential contracts.
 *
 * WHAT IS DELIBERATELY ABSENT
 * ---------------------------
 * No `secret_hash`, ever. The hash is an internal authentication artifact; it
 * must never appear in a client contract, because a contract field is the one
 * thing a future handler is most likely to populate without thinking.
 * A guardrail test asserts no schema here mentions a hash.
 *
 * There are also no scopes, permissions or expiry fields. Every key is simply
 * workspace-bound. Per-key capability matrices are not a Credit requirement,
 * and adding the field now would invite partial enforcement later.
 */

export const WORKSPACE_API_KEYS_SEGMENT = 'api-keys' as const;

/** `/v1/workspaces/:workspaceId/api-keys` */
export function workspaceApiKeysPath(workspaceId: string): string {
  return `/v1/workspaces/${encodeURIComponent(workspaceId)}/${WORKSPACE_API_KEYS_SEGMENT}`;
}

/** `/v1/workspaces/:workspaceId/api-keys/:credentialId/revoke` */
export function revokeApiKeyPath(workspaceId: string, credentialId: string): string {
  return `${workspaceApiKeysPath(workspaceId)}/${encodeURIComponent(credentialId)}/revoke`;
}

/** Probe route proving the bearer-auth boundary. Returns no secret. */
export const API_KEY_IDENTITY_PATH = '/v1/api-key/me' as const;

/**
 * Request body for issuing a key.
 *
 * The name is a display label only. It is never part of authentication, so it
 * needs no uniqueness or format guarantee - just sane bounds.
 */
export const createApiKeyRequestSchema = z.object({
  name: z.string().trim().min(1, 'A key name is required.').max(120),
});

export type CreateApiKeyRequest = z.infer<typeof createApiKeyRequestSchema>;

/** Lifecycle state derived from `revoked_at`; not a stored column. */
export const apiKeyStatusSchema = z.enum(['active', 'revoked']);
export type ApiKeyStatus = z.infer<typeof apiKeyStatusSchema>;

/**
 * Safe credential metadata.
 *
 * `keyPrefix` is the NON-SECRET public half, shown so an operator can tell two
 * keys apart in a list. It carries no authentication power on its own.
 */
export const apiKeySummarySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  keyPrefix: z.string(),
  status: apiKeyStatusSchema,
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
});

export type ApiKeySummary = z.infer<typeof apiKeySummarySchema>;

/**
 * Issuance response - THE ONLY CONTRACT CARRYING PLAINTEXT.
 *
 * `key` exists here and nowhere else in the API surface. There is no retrieval
 * endpoint and no recovery path: a lost key is revoked and replaced. Keeping
 * plaintext in exactly one response type makes that auditable.
 */
export const issuedApiKeySchema = apiKeySummarySchema.extend({
  /** Full plaintext key. Shown once, never stored, never returned again. */
  key: z.string(),
});

export type IssuedApiKey = z.infer<typeof issuedApiKeySchema>;

export const createApiKeyResponseSchema = z.object({
  apiKey: issuedApiKeySchema,
});

export type CreateApiKeyResponse = z.infer<typeof createApiKeyResponseSchema>;

export const apiKeyListResponseSchema = z.object({
  apiKeys: z.array(apiKeySummarySchema),
});

export type ApiKeyListResponse = z.infer<typeof apiKeyListResponseSchema>;

export const revokeApiKeyResponseSchema = z.object({
  apiKey: apiKeySummarySchema,
});

export type RevokeApiKeyResponse = z.infer<typeof revokeApiKeyResponseSchema>;

/**
 * Response for the bearer-auth probe.
 *
 * `workspaceId` is reported so a caller can confirm which tenant its key maps
 * to. It is derived from the credential record - the caller cannot influence
 * it, which is precisely what this endpoint demonstrates.
 */
export const apiKeyIdentityResponseSchema = z.object({
  authenticated: z.literal(true),
  workspaceId: z.uuid(),
});

export type ApiKeyIdentityResponse = z.infer<typeof apiKeyIdentityResponseSchema>;
