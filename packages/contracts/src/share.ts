import { z } from 'zod';

import { agentGovernanceSchema, blockSummarySchema, receiptSummarySchema } from './governance.js';
import { agentSummarySchema } from './agents.js';
import { eventDetailSchema, eventSummarySchema } from './timeline.js';

/**
 * Revocable read-only workspace sharing (AC-18).
 *
 * ─── TWO SURFACES, DELIBERATELY SEPARATE ──────────────────────────────────
 *
 * MANAGEMENT is operator-only and lives under the workspace path, alongside
 * API keys. PUBLIC is unauthenticated-by-session and lives under `/v1/share`,
 * reachable with nothing but the token.
 *
 * They never overlap. The management surface can never return a usable token,
 * and the public surface can never reach a management route.
 *
 * ─── WHAT A SHARE TOKEN IS ────────────────────────────────────────────────
 *
 * A bearer credential granting READ-ONLY access to exactly ONE workspace. It
 * is not a user, not a membership, and not an API key. It carries no role and
 * authorizes no mutation of any kind.
 *
 * ─── SHOW ONCE ────────────────────────────────────────────────────────────
 *
 * Issuance returns the plaintext exactly once. Only a SHA-256 digest and a
 * non-secret prefix are stored, so there is no recovery endpoint and none can
 * be added later: the server cannot reproduce a token it never kept. A lost
 * link is revoked and reissued.
 */

// ─── Paths ──────────────────────────────────────────────────────────────────

/** `/v1/workspaces/:workspaceId/share-links` - operator only. */
export function workspaceShareLinksPath(workspaceId: string): string {
  return `/v1/workspaces/${encodeURIComponent(workspaceId)}/share-links`;
}

/** `/v1/workspaces/:workspaceId/share-links/:shareId/revoke` - operator only. */
export function revokeShareLinkPath(workspaceId: string, shareId: string): string {
  return `${workspaceShareLinksPath(workspaceId)}/${encodeURIComponent(shareId)}/revoke`;
}

/**
 * The public browser route.
 *
 * The token is in the URL because the recipient must arrive carrying it and
 * has nowhere else to put it. Everything after this is deliberate about not
 * repeating that exposure - see `SHARE_ACCESS_PATH`.
 */
export function shareViewPath(token: string): string {
  return `/share/${encodeURIComponent(token)}`;
}

/**
 * THE ONE-TIME EXCHANGE.
 *
 * The token is POSTed in a BODY, never a query string, and traded for a
 * short-lived HttpOnly cookie. Every subsequent read is cookie-authenticated,
 * so the token appears in exactly one request rather than in every access log
 * line, proxy log and `Referer` header for the life of the session.
 */
export const SHARE_ACCESS_PATH = '/v1/share/access' as const;

/** Read surfaces. Cookie-authenticated; no token in any path. */
export const SHARE_WORKSPACE_PATH = '/v1/share/workspace' as const;
export const SHARE_AGENTS_PATH = '/v1/share/agents' as const;
export const SHARE_EVENTS_PATH = '/v1/share/events' as const;
export const SHARE_RECEIPTS_PATH = '/v1/share/receipts' as const;
export const SHARE_BLOCKS_PATH = '/v1/share/blocks' as const;

export function shareEventPath(eventId: string): string {
  return `${SHARE_EVENTS_PATH}/${encodeURIComponent(eventId)}`;
}

// ─── Operator management ────────────────────────────────────────────────────

/**
 * Share metadata. SAFE TO LIST.
 *
 * Carries no token, no digest, and no reconstructable URL. `tokenPrefix` is
 * independent random material that reveals nothing about the secret - it
 * exists so an operator can tell two links apart when revoking one.
 */
export const shareLinkSummarySchema = z.object({
  id: z.uuid(),
  /** Non-secret. Never enough to access anything. */
  tokenPrefix: z.string(),
  createdAt: z.string(),
  /** Null while active. A revoked row is retained for the audit. */
  revokedAt: z.string().nullable(),
});

export type ShareLinkSummary = z.infer<typeof shareLinkSummarySchema>;

export const shareLinkListResponseSchema = z.object({
  shareLinks: z.array(shareLinkSummarySchema),
});

export type ShareLinkListResponse = z.infer<typeof shareLinkListResponseSchema>;

/**
 * The ONLY response that ever carries a usable token.
 *
 * Returned once, at issuance. The operator copies it or loses it.
 */
export const shareLinkCreatedResponseSchema = z.object({
  shareLink: shareLinkSummarySchema,
  /** PLAINTEXT. Shown once and never retrievable again. */
  token: z.string(),
});

export type ShareLinkCreatedResponse = z.infer<typeof shareLinkCreatedResponseSchema>;

/**
 * Issuance takes no body fields.
 *
 * A strict empty object rather than no schema at all: a caller sending
 * `{"workspace_id": "..."}` or `{"scope": "write"}` gets a loud 400 instead of
 * a silently ignored field they might believe took effect.
 */
export const createShareLinkRequestSchema = z.strictObject({});

export type CreateShareLinkRequest = z.infer<typeof createShareLinkRequestSchema>;

// ─── Public read surface ────────────────────────────────────────────────────

/** Bounds the token before it reaches a hash or a database. */
export const MAX_SHARE_TOKEN_LENGTH = 200;

/** The exchange request. Token in the body, never the query string. */
export const shareAccessRequestSchema = z.strictObject({
  token: z.string().min(1).max(MAX_SHARE_TOKEN_LENGTH),
});

export type ShareAccessRequest = z.infer<typeof shareAccessRequestSchema>;

/**
 * What a viewer learns about the workspace.
 *
 * The NAME and nothing else. No id, because a viewer has no use for one and
 * publishing an internal identifier invites someone to try it somewhere else.
 * No member list, no plan, no counts of anything not otherwise visible.
 */
export const shareWorkspaceSchema = z.object({
  name: z.string(),
});

export type ShareWorkspace = z.infer<typeof shareWorkspaceSchema>;

export const shareAccessResponseSchema = z.object({
  workspace: shareWorkspaceSchema,
});

export type ShareAccessResponse = z.infer<typeof shareAccessResponseSchema>;

/**
 * The shared fleet view.
 *
 * `governance` is REQUIRED here, unlike on the operator roster where it is
 * optional. A shared view exists to show governance state; one without it
 * would be an agent list, which is not what the criterion asks for.
 */
export const shareAgentSchema = agentSummarySchema.extend({
  governance: agentGovernanceSchema,
});

export type ShareAgent = z.infer<typeof shareAgentSchema>;

export const shareAgentListResponseSchema = z.object({
  agents: z.array(shareAgentSchema),
});

export type ShareAgentListResponse = z.infer<typeof shareAgentListResponseSchema>;

/**
 * The remaining read responses REUSE the operator schemas exactly.
 *
 * Not similar shapes - the same ones. A parallel set would drift, and the
 * shared view would slowly start describing a different system than the
 * operator sees. The authority differs; the data does not.
 */
export const shareEventListResponseSchema = z.object({
  events: z.array(eventSummarySchema),
  nextCursor: z.string().nullable(),
});

export type ShareEventListResponse = z.infer<typeof shareEventListResponseSchema>;

export const shareEventDetailResponseSchema = z.object({ event: eventDetailSchema });
export type ShareEventDetailResponse = z.infer<typeof shareEventDetailResponseSchema>;

export const shareReceiptListResponseSchema = z.object({
  receipts: z.array(receiptSummarySchema),
  nextCursor: z.string().nullable(),
});

export type ShareReceiptListResponse = z.infer<typeof shareReceiptListResponseSchema>;

export const shareBlockListResponseSchema = z.object({
  blocks: z.array(blockSummarySchema),
  nextCursor: z.string().nullable(),
});

export type ShareBlockListResponse = z.infer<typeof shareBlockListResponseSchema>;

/**
 * The single public failure.
 *
 * Unknown, malformed, revoked and belonging-to-another-workspace all produce
 * THIS and nothing else. Distinguishing them would let a holder of an expired
 * link learn whether it once existed, and would let anyone probe for valid
 * prefixes.
 */
export const shareErrorSchema = z.strictObject({
  error: z.literal('invalid_share'),
});

export type ShareError = z.infer<typeof shareErrorSchema>;
