import {
  authorizeWorkspaceForUser,
  createWorkspaceWithOperator,
  listWorkspacesForUser,
  type AuthorizedWorkspace,
  type AuthorizedWorkspaceSummary,
  type DatabaseClient,
} from '@hybrid/db';

/**
 * The persistence port for workspace routes.
 *
 * WHY A PORT
 * ----------
 * Same reasoning as Step 5's `AuthStore`, plus one more: application code must
 * not import `drizzle-orm`, and ESLint enforces that. Depending on a port keeps
 * query construction inside `@hybrid/db`, where the workspace-scoping rules
 * live and where SQL-level tests can prove the membership join is bounded by
 * `user_id`.
 *
 * AUTHORIZATION IS NOT DELEGATED TO THE ROUTE
 * -------------------------------------------
 * `authorize` returns an `AuthorizedWorkspace` - already carrying a trusted
 * `WorkspaceScope` - or null. The route cannot construct a scope itself, so it
 * cannot accidentally skip the membership check.
 */

export interface CreateWorkspaceCommand {
  readonly name: string;
  /** The authenticated creator. Never request input. */
  readonly creatorUserId: string;
}

export interface WorkspaceStore {
  /** Creates a workspace and its creator membership atomically. */
  create(command: CreateWorkspaceCommand): Promise<AuthorizedWorkspaceSummary>;

  /** Lists only the workspaces this user belongs to. Bounded in SQL. */
  listForUser(userId: string): Promise<AuthorizedWorkspaceSummary[]>;

  /**
   * Proves membership and returns a trusted scope, or null.
   *
   * Null covers "no such workspace" and "not yours" alike - the caller must not
   * be able to tell them apart.
   */
  authorize(userId: string, workspaceId: string): Promise<AuthorizedWorkspace | null>;
}

/** Production store backed by Drizzle/PostgreSQL. */
export function createDrizzleWorkspaceStore(db: DatabaseClient): WorkspaceStore {
  return {
    async create(command: CreateWorkspaceCommand): Promise<AuthorizedWorkspaceSummary> {
      return createWorkspaceWithOperator(db, {
        name: command.name,
        creatorUserId: command.creatorUserId,
      });
    },

    async listForUser(userId: string): Promise<AuthorizedWorkspaceSummary[]> {
      return listWorkspacesForUser(db, userId);
    },

    async authorize(userId: string, workspaceId: string): Promise<AuthorizedWorkspace | null> {
      return authorizeWorkspaceForUser(db, userId, workspaceId);
    },
  };
}
