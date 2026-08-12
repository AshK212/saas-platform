import type { DatabaseClient } from '../client.js';
import type { AuthorizedWorkspaceSummary } from '../resolvers/authorization.js';
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
 * Creates a workspace and its creator's membership ATOMICALLY.
 *
 * Both rows commit together or neither does. A workspace whose creator
 * membership failed would be permanently unreachable - nobody could authorize
 * into it, and no route exists to repair it - so a partial success here is a
 * worse outcome than an outright failure.
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

    return { id: workspace.id, name: workspace.name, role: membership.role };
  });
}
