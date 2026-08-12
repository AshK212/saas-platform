import { z } from 'zod';

/**
 * Step 6 workspace contracts.
 *
 * WHAT IS DELIBERATELY ABSENT
 * ---------------------------
 * No `demo_enabled`, no `demo_slug`, no policy, no caps, no API keys. Those
 * belong to later steps, and a workspace response is not the place to grow a
 * grab-bag of tenant state.
 *
 * `role` is included because the operator UI needs to know what the signed-in
 * user is, but it carries no permission semantics yet - the Credit phase has a
 * deliberately minimal two-value role vocabulary, not an RBAC system.
 */

export const WORKSPACES_PATH = '/v1/workspaces' as const;

/** Concrete path for one workspace. `:workspaceId` is a lookup argument only. */
export function workspacePath(workspaceId: string): string {
  return `${WORKSPACES_PATH}/${encodeURIComponent(workspaceId)}`;
}

/** Mirrors the locked `membership_role` enum. */
export const membershipRoleSchema = z.enum(['operator', 'member']);
export type MembershipRoleValue = z.infer<typeof membershipRoleSchema>;

/**
 * Request body for `POST /v1/workspaces`.
 *
 * Trimmed, non-empty and length-bounded, but otherwise permissive: real company
 * and project names contain punctuation, accents and non-Latin scripts, and a
 * restrictive character allowlist would reject legitimate customers. The name
 * is display metadata - it is never an authorization identifier, so it needs no
 * uniqueness or format guarantee.
 */
export const createWorkspaceRequestSchema = z.object({
  name: z.string().trim().min(1, 'A workspace name is required.').max(120),
});

export type CreateWorkspaceRequest = z.infer<typeof createWorkspaceRequestSchema>;

/** Non-secret workspace metadata, as seen by an authorized member. */
export const workspaceSummarySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  role: membershipRoleSchema,
});

export type WorkspaceSummary = z.infer<typeof workspaceSummarySchema>;

/** Response for `POST /v1/workspaces` and `GET /v1/workspaces/:workspaceId`. */
export const workspaceResponseSchema = z.object({
  workspace: workspaceSummarySchema,
});

export type WorkspaceResponse = z.infer<typeof workspaceResponseSchema>;

/**
 * Response for `GET /v1/workspaces`.
 *
 * Contains only workspaces the authenticated user is a member of. An empty
 * array is the normal state for a newly signed-in user.
 */
export const workspaceListResponseSchema = z.object({
  workspaces: z.array(workspaceSummarySchema),
});

export type WorkspaceListResponse = z.infer<typeof workspaceListResponseSchema>;
