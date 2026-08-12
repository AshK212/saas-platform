import { z } from 'zod';

/**
 * Step 5 authentication contracts.
 *
 * Shared by the API and the web app so request and response shapes are
 * validated from one definition rather than drifting apart.
 *
 * ANTI-ENUMERATION IS PART OF THE CONTRACT
 * ----------------------------------------
 * The magic-link response is a fixed `{ ok: true }` with no field that could
 * vary by whether the address is known. That is a deliberate contract-level
 * decision, not merely an implementation detail: adding a `created` or
 * `emailSent` field later would reintroduce an account-existence oracle.
 */

/** Canonical auth paths, shared so client and server cannot drift. */
export const AUTH_MAGIC_LINK_PATH = '/v1/auth/magic-link' as const;
export const AUTH_CALLBACK_PATH = '/v1/auth/callback' as const;
export const AUTH_ME_PATH = '/v1/auth/me' as const;
export const AUTH_LOGOUT_PATH = '/v1/auth/logout' as const;

/** Query parameter carrying the plaintext magic-link token to the callback. */
export const AUTH_CALLBACK_TOKEN_PARAM = 'token' as const;

/**
 * Request body for `POST /v1/auth/magic-link`.
 *
 * Trimmed and lowercased here so the client, the API and the database's
 * `email = lower(email)` constraint all agree on identity.
 */
export const magicLinkRequestSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .pipe(z.email({ message: 'A valid email address is required.' }))
    // Generous but bounded: RFC 5321 caps a path at 254 characters.
    .pipe(z.string().max(254)),
});

export type MagicLinkRequest = z.infer<typeof magicLinkRequestSchema>;

/**
 * Response for `POST /v1/auth/magic-link`.
 *
 * Identical for a known address, an unknown address, and an address currently
 * inside its issuance cooldown.
 */
export const magicLinkResponseSchema = z.object({
  ok: z.literal(true),
});

export type MagicLinkResponse = z.infer<typeof magicLinkResponseSchema>;

/**
 * Response for `GET /v1/auth/me`.
 *
 * Carries identity ONLY. There is deliberately no workspace, membership, role
 * or permission field: being authenticated authorises no workspace. Workspace
 * selection is Step 6.
 */
export const currentUserResponseSchema = z.object({
  user: z.object({
    id: z.uuid(),
    email: z.email(),
  }),
});

export type CurrentUserResponse = z.infer<typeof currentUserResponseSchema>;

/** Response for `POST /v1/auth/logout`. */
export const logoutResponseSchema = z.object({
  ok: z.literal(true),
});

export type LogoutResponse = z.infer<typeof logoutResponseSchema>;

/**
 * Outcome codes appended to the post-callback redirect.
 *
 * Deliberately coarse: a single generic failure code covers unknown, expired,
 * already-used and malformed tokens, so the redirect cannot be used to probe
 * which applies.
 */
export const AUTH_CALLBACK_RESULT_PARAM = 'auth' as const;
export const authCallbackResultSchema = z.enum(['success', 'invalid_link']);
export type AuthCallbackResult = z.infer<typeof authCallbackResultSchema>;
