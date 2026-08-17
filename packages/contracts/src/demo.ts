import { z } from 'zod';

import { shareAgentSchema } from './share.js';
import { blockSummarySchema, receiptSummarySchema } from './governance.js';
import { eventDetailSchema, eventSummarySchema } from './timeline.js';

/**
 * Public demo mode (AC-19).
 *
 * ─── DEMO IS NOT SHARING ──────────────────────────────────────────────────
 *
 * They are separate authorities and must not be confused.
 *
 *   SHARE (AC-18)   a 256-bit SECRET bearer token, issued per link, revoked
 *                   per link. Secrecy is the security model.
 *   DEMO  (AC-19)   a PUBLIC slug plus a workspace-level `demo_enabled` flag.
 *                   The slug is meant to be published, so it protects nothing;
 *                   the FLAG is the security model.
 *
 * Revoking a share link does not disable the demo, and disabling the demo does
 * not revoke share links. Neither reads the other's table.
 *
 * Both are read-only, workspace-scoped, and authorize no mutation of any kind.
 *
 * ─── DISABLING CLEARS THE SLUG ────────────────────────────────────────────
 *
 * The Step 3 check constraint is `demo_slug IS NULL OR demo_enabled`, so a
 * private workspace cannot hold a public locator. Re-enabling therefore mints
 * a NEW slug and every previously-published URL stays dead - which is the
 * right direction for a switch whose whole purpose is withdrawing access.
 */

// ─── Paths ──────────────────────────────────────────────────────────────────

/** `/v1/workspaces/:workspaceId/demo` - operator only. */
export function workspaceDemoPath(workspaceId: string): string {
  return `/v1/workspaces/${encodeURIComponent(workspaceId)}/demo`;
}

/** The public browser route. No login, no token. */
export function demoViewPath(slug: string): string {
  return `/demo/${encodeURIComponent(slug)}`;
}

/**
 * Public read surfaces.
 *
 * The slug is IN THE PATH, unlike the AC-18 share token which is exchanged for
 * a cookie. That difference is deliberate: a share token is a secret whose
 * exposure in logs matters, and a demo slug is published on purpose. Hiding a
 * public identifier would be ceremony, and it would cost the demo its most
 * useful property - a bookmarkable, copy-pasteable URL.
 */
export const DEMO_PUBLIC_PREFIX = '/v1/demo' as const;

export function demoWorkspacePath(slug: string): string {
  return `${DEMO_PUBLIC_PREFIX}/${encodeURIComponent(slug)}`;
}
export function demoAgentsPath(slug: string): string {
  return `${demoWorkspacePath(slug)}/agents`;
}
export function demoEventsPath(slug: string): string {
  return `${demoWorkspacePath(slug)}/events`;
}
export function demoEventPath(slug: string, eventId: string): string {
  return `${demoEventsPath(slug)}/${encodeURIComponent(eventId)}`;
}
export function demoReceiptsPath(slug: string): string {
  return `${demoWorkspacePath(slug)}/receipts`;
}
export function demoBlocksPath(slug: string): string {
  return `${demoWorkspacePath(slug)}/blocks`;
}

// ─── Slug ───────────────────────────────────────────────────────────────────

/**
 * Slug shape: lowercase alphanumerics and single hyphens.
 *
 * Bounded and conservative so a slug is safe in a URL path without escaping,
 * readable aloud, and impossible to confuse with a uuid or an API key.
 */
export const DEMO_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MAX_DEMO_SLUG_LENGTH = 64;

export const demoSlugSchema = z
  .string()
  .min(3)
  .max(MAX_DEMO_SLUG_LENGTH)
  .regex(DEMO_SLUG_PATTERN, 'A demo slug is lowercase letters, digits and hyphens.');

// ─── Operator management ────────────────────────────────────────────────────

/**
 * The demo setting request.
 *
 * Strict, and carrying ONLY `enabled`. Notably it does NOT accept a slug: the
 * server mints one. Letting a caller choose would invite squatting on
 * recognisable names across tenants, and would make the slug feel like an
 * identity the operator owns rather than a locator the plane assigns.
 */
export const setDemoRequestSchema = z.strictObject({
  enabled: z.boolean(),
});

export type SetDemoRequest = z.infer<typeof setDemoRequestSchema>;

/** Demo state, as the operator sees it. */
export const demoSettingsSchema = z.object({
  enabled: z.boolean(),
  /** Null while disabled - the schema forbids a slug without the flag. */
  slug: demoSlugSchema.nullable(),
  /** The full public URL, built only when enabled. Convenience, not secret. */
  publicPath: z.string().nullable(),
});

export type DemoSettings = z.infer<typeof demoSettingsSchema>;

export const demoSettingsResponseSchema = z.object({ demo: demoSettingsSchema });
export type DemoSettingsResponse = z.infer<typeof demoSettingsResponseSchema>;

// ─── Public read surface ────────────────────────────────────────────────────

/**
 * What a visitor learns about the workspace.
 *
 * The NAME and the slug they already used. No id: a visitor has no use for an
 * internal identifier, and publishing one invites someone to try it elsewhere.
 */
export const demoWorkspaceSchema = z.object({
  name: z.string(),
  slug: demoSlugSchema,
});

export type DemoWorkspace = z.infer<typeof demoWorkspaceSchema>;

export const demoWorkspaceResponseSchema = z.object({ workspace: demoWorkspaceSchema });
export type DemoWorkspaceResponse = z.infer<typeof demoWorkspaceResponseSchema>;

/**
 * The read responses REUSE the AC-18 share schemas exactly.
 *
 * Not similar shapes - the same ones, which are themselves the operator
 * shapes. Three surfaces describing one system, so none can drift into
 * describing a different one.
 */
export const demoAgentListResponseSchema = z.object({
  agents: z.array(shareAgentSchema),
});
export type DemoAgentListResponse = z.infer<typeof demoAgentListResponseSchema>;

export const demoEventListResponseSchema = z.object({
  events: z.array(eventSummarySchema),
  nextCursor: z.string().nullable(),
});
export type DemoEventListResponse = z.infer<typeof demoEventListResponseSchema>;

export const demoEventDetailResponseSchema = z.object({ event: eventDetailSchema });
export type DemoEventDetailResponse = z.infer<typeof demoEventDetailResponseSchema>;

export const demoReceiptListResponseSchema = z.object({
  receipts: z.array(receiptSummarySchema),
  nextCursor: z.string().nullable(),
});
export type DemoReceiptListResponse = z.infer<typeof demoReceiptListResponseSchema>;

export const demoBlockListResponseSchema = z.object({
  blocks: z.array(blockSummarySchema),
  nextCursor: z.string().nullable(),
});
export type DemoBlockListResponse = z.infer<typeof demoBlockListResponseSchema>;

/**
 * The single public failure.
 *
 * Unknown slug, malformed slug, DISABLED demo and another tenant's record all
 * produce this. A visitor does not need to learn that a workspace exists but
 * is private.
 */
export const demoErrorSchema = z.strictObject({
  error: z.literal('demo_not_found'),
});

export type DemoError = z.infer<typeof demoErrorSchema>;
