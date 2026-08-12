import { and, eq } from 'drizzle-orm';

import type { DatabaseExecutor } from '../repositories/executor.js';
import { createWorkspaceScope, type WorkspaceScope } from '../repositories/workspace-scope.js';
import { workspaceMemberships, workspaces } from '../schema/workspaces.js';

/**
 * The trusted operator authorization boundary.
 *
 * THIS IS THE ONLY SANCTIONED PATH FROM A BROWSER IDENTITY TO TENANT SCOPE.
 *
 *   Authenticated user + requested workspace id
 *        -> membership proven in SQL
 *        -> AuthorizedWorkspace (carrying a trusted WorkspaceScope)
 *
 * A workspace id arriving in a URL, body or query is a LOOKUP ARGUMENT. It is
 * never authorization. The membership row is the authorization, and it is
 * re-proven on every call - there is no cached grant and no "current
 * workspace" server state.
 *
 * `createWorkspaceScope` is no longer exported from the package root precisely
 * so that an HTTP handler cannot bypass this function and mint a scope straight
 * from request input.
 */

/** Membership roles, mirroring the locked `membership_role` enum. */
export type MembershipRole = (typeof workspaceMemberships.$inferSelect)['role'];

/** Non-secret workspace metadata safe to return to an authorized member. */
export interface AuthorizedWorkspaceSummary {
  readonly id: string;
  readonly name: string;
  readonly role: MembershipRole;
}

/**
 * Proof that a specific user may act inside a specific workspace.
 *
 * Obtainable only from `authorizeWorkspaceForUser`, which requires a membership
 * row to exist. Holding one of these means the check has already happened.
 */
export interface AuthorizedWorkspace {
  readonly workspace: AuthorizedWorkspaceSummary;
  /** Trusted tenant scope for the workspace-bound repositories. */
  readonly scope: WorkspaceScope;
}

/**
 * Authorizes an authenticated user for one workspace.
 *
 * The join is the authorization: a workspace row is returned only when a
 * membership row links it to THIS user. There is no post-filtering in
 * application memory, so a missing `WHERE` cannot leak another tenant.
 *
 * @param userId - id of the ALREADY-AUTHENTICATED user. Never request input.
 * @param workspaceId - requested workspace. Untrusted lookup argument.
 * @returns null when the workspace does not exist OR the user is not a member.
 *   The two cases are deliberately indistinguishable, so a non-member cannot
 *   probe which workspace ids exist.
 */
export async function authorizeWorkspaceForUser(
  executor: DatabaseExecutor,
  userId: string,
  workspaceId: string,
): Promise<AuthorizedWorkspace | null> {
  // A malformed id must fail as "inaccessible", not as a thrown error, so it
  // is indistinguishable from a valid id the user cannot reach.
  if (!isUuid(workspaceId)) {
    return null;
  }

  const rows = await executor
    .select({
      id: workspaces.id,
      name: workspaces.name,
      role: workspaceMemberships.role,
    })
    .from(workspaceMemberships)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMemberships.workspaceId))
    .where(
      and(
        eq(workspaceMemberships.userId, userId),
        eq(workspaceMemberships.workspaceId, workspaceId),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (row === undefined) {
    return null;
  }

  return {
    workspace: { id: row.id, name: row.name, role: row.role },
    // Reached only after the membership join returned a row.
    scope: createWorkspaceScope(row.id),
  };
}

/**
 * Lists every workspace the authenticated user belongs to.
 *
 * Bounded by `user_id` in SQL through the membership join. It does NOT read all
 * workspaces and filter afterwards - that pattern turns one forgotten line into
 * a full cross-tenant disclosure.
 */
export async function listWorkspacesForUser(
  executor: DatabaseExecutor,
  userId: string,
): Promise<AuthorizedWorkspaceSummary[]> {
  return executor
    .select({
      id: workspaces.id,
      name: workspaces.name,
      role: workspaceMemberships.role,
    })
    .from(workspaceMemberships)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMemberships.workspaceId))
    .where(eq(workspaceMemberships.userId, userId))
    .orderBy(workspaces.name);
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}
