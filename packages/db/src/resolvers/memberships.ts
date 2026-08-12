import { and, eq } from 'drizzle-orm';

import { workspaceMemberships } from '../schema/workspaces.js';
import type { DatabaseExecutor } from '../repositories/executor.js';

/**
 * Membership resolution - IDENTITY, NOT TENANT BUSINESS.
 *
 * WHY THESE FUNCTIONS ARE NOT WORKSPACE-SCOPED
 * --------------------------------------------
 * `listMembershipsForUser` exists precisely to answer "which workspaces may
 * this user enter?". Requiring a `WorkspaceScope` to answer that would be
 * circular: the scope is the output of this question, not an input to it.
 *
 * That is the whole distinction this directory encodes:
 *
 *   resolvers/     establish which workspace a caller may act in.
 *                  Bounded by USER identity, and by nothing else.
 *   repositories/  operate inside one workspace. Always scoped.
 *
 * `users` is a GLOBAL table - one human, one identity, many workspaces. It is
 * not tenant-owned and must never be treated as such.
 *
 * THE BOUND THAT STILL APPLIES
 * ----------------------------
 * These functions are not unscoped in the dangerous sense. Each is anchored on
 * a `user_id`, so a caller can only ever discover the memberships of the user
 * they have already authenticated as. There is no "list all memberships"
 * function, and none may be added.
 *
 * STEP 4 SCOPE: reads only. No membership creation, no invitations, no roles
 * management, no authentication - Step 5 owns sign-in.
 */

export type MembershipRow = typeof workspaceMemberships.$inferSelect;

/**
 * Lists every workspace membership held by one user.
 *
 * This is the operator sign-in path: authenticate the user, call this, then
 * build a `WorkspaceScope` from a workspace the user actually belongs to.
 */
export async function listMembershipsForUser(
  executor: DatabaseExecutor,
  userId: string,
): Promise<MembershipRow[]> {
  return executor
    .select()
    .from(workspaceMemberships)
    .where(eq(workspaceMemberships.userId, userId));
}

/**
 * Confirms one specific membership.
 *
 * This is the authorization check that must precede `createWorkspaceScope` in
 * the operator flow: a caller-supplied workspace id is only ever acceptable
 * once it has been proven to be one of *this user's* workspaces. Returns null
 * when the user is not a member - never a reason, so a non-member cannot
 * distinguish "no such workspace" from "not yours".
 */
export async function findMembership(
  executor: DatabaseExecutor,
  userId: string,
  workspaceId: string,
): Promise<MembershipRow | null> {
  const rows = await executor
    .select()
    .from(workspaceMemberships)
    .where(
      and(
        eq(workspaceMemberships.userId, userId),
        eq(workspaceMemberships.workspaceId, workspaceId),
      ),
    )
    .limit(1);

  return rows[0] ?? null;
}
