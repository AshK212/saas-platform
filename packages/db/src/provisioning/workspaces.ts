import type { DatabaseClient } from '../client.js';
import type { AuthorizedWorkspaceSummary } from '../resolvers/authorization.js';
import { workspacePolicyState } from '../schema/policy.js';
import { workspaceMemberships, workspaces } from '../schema/workspaces.js';

/**
 * Tenant provisioning.
 *
 * WHY A SEPARATE DIRECTORY
 * ------------------------
 * The package now has four data-access categories, each with one rule:
 *
 *   identity/      global, user-owned records (users, auth). No workspace.
 *   resolvers/     READ-ONLY. Establish which workspace a caller may enter.
 *   repositories/  Operate inside one workspace. Always scoped.
 *   provisioning/  Creates tenants. The only writes outside identity/.  <- here
 *
 * Creating a workspace fits none of the other three: there is no scope yet (the
 * tenant does not exist), it is not identity, and it is a write - so putting it
 * in `resolvers/` would break the "resolvers never write" guarantee that a
 * Step 4 test enforces. Keeping it here preserves that guarantee and leaves
 * tenant creation as a single, narrowly named, auditable function.
 */

export interface CreateWorkspaceInput {
  readonly name: string;
  /** The authenticated creator. Becomes the first member. */
  readonly creatorUserId: string;
}

/**
 * Creates a workspace, its creator's membership and its policy state ATOMICALLY.
 *
 * All three rows commit together or none does:
 *
 *   BEGIN
 *     INSERT workspace
 *     INSERT workspace_membership   (creator, operator)
 *     INSERT workspace_policy_state (version = 1)
 *   COMMIT
 *
 * A workspace whose creator membership failed would be permanently unreachable
 * - nobody could authorize into it, and no route exists to repair it. A
 * workspace whose POLICY STATE failed would be equally broken in a different
 * way: `GET /v1/policy` treats a missing version as an invariant violation and
 * returns a controlled error rather than inventing version 0 or an empty
 * policy. There is deliberately no lazy "create it on first read" path, because
 * a GET that repairs state is a GET that hides provisioning defects - and this
 * is the only supported way a workspace comes into existence.
 *
 * Version starts at 1, matching the `version >= 1` check constraint. Only the
 * Step 13 mutation service may increment it, and it will do so inside the same
 * transaction as the policy change itself.
 *
 * SECURE DEFAULTS
 * ---------------
 * `demo_enabled` and `demo_slug` are deliberately NOT settable through this
 * function. New workspaces take the schema defaults (`demo_enabled = false`,
 * no slug), so a caller cannot create a publicly visible workspace. Enabling
 * demo mode belongs to AC-19 and has no route yet.
 *
 * The creator is assigned `operator`, the higher of the two roles in the locked
 * `membership_role` vocabulary, rather than the column default of `member` -
 * otherwise a workspace's own creator would hold the lesser role.
 *
 * Takes the top-level client rather than a `DatabaseExecutor` because it opens
 * its own transaction; it is a unit of work, not a step inside someone else's.
 */
export async function createWorkspaceWithOperator(
  db: DatabaseClient,
  input: CreateWorkspaceInput,
): Promise<AuthorizedWorkspaceSummary> {
  return db.transaction(async (tx) => {
    const insertedWorkspaces = await tx
      .insert(workspaces)
      .values({ name: input.name })
      .returning({ id: workspaces.id, name: workspaces.name });

    const workspace = insertedWorkspaces[0];
    if (workspace === undefined) {
      // Rolls the transaction back; no orphaned workspace can survive.
      throw new Error('Failed to create workspace.');
    }

    const insertedMemberships = await tx
      .insert(workspaceMemberships)
      .values({
        workspaceId: workspace.id,
        userId: input.creatorUserId,
        role: 'operator',
      })
      .returning({ role: workspaceMemberships.role });

    const membership = insertedMemberships[0];
    if (membership === undefined) {
      throw new Error('Failed to create workspace membership.');
    }

    // Policy INITIALIZATION, not policy mutation: this establishes the
    // authoritative version a workspace is born with. The value is stated
    // explicitly rather than relying on the column default, so the starting
    // version is visible at the point it is decided.
    const insertedPolicyState = await tx
      .insert(workspacePolicyState)
      .values({ workspaceId: workspace.id, version: 1 })
      .returning({ version: workspacePolicyState.version });

    if (insertedPolicyState[0] === undefined) {
      // Rolls back the workspace and the membership too. A workspace that
      // cannot report a policy version is not a usable workspace.
      throw new Error('Failed to create workspace policy state.');
    }

    return { id: workspace.id, name: workspace.name, role: membership.role };
  });
}
