import { randomUUID } from 'node:crypto';

import type { AuthorizedWorkspace, AuthorizedWorkspaceSummary, WorkspaceScope } from '@hybrid/db';

import type { CreateWorkspaceCommand, WorkspaceStore } from '../../src/workspaces/store';

/**
 * In-memory `WorkspaceStore` for route tests.
 *
 * Reproduces the SEMANTICS the production store relies on - membership-bounded
 * listing, membership-gated authorization, and atomic create - so the routes'
 * authorization behaviour is genuinely exercised without a database.
 *
 * WHAT IT DOES NOT PROVE
 * ----------------------
 * It is not PostgreSQL. It cannot prove real transaction rollback, the
 * membership uniqueness constraint, or that the production SQL actually filters
 * by `user_id`. Those are covered elsewhere:
 *
 *   - SQL-level proof: `packages/db/tests/workspace-authorization.test.ts`
 *     renders the real queries and asserts the membership predicate.
 *   - Real rollback/uniqueness: the live suite, skipped without a database.
 */

export interface MemoryWorkspaceRecord {
  id: string;
  name: string;
  demoEnabled: boolean;
  demoSlug: string | null;
}

export interface MemoryMembershipRecord {
  workspaceId: string;
  userId: string;
  role: 'operator' | 'member';
}

export interface MemoryWorkspaceStore extends WorkspaceStore {
  readonly workspaces: MemoryWorkspaceRecord[];
  readonly memberships: MemoryMembershipRecord[];
  seedWorkspace(
    name: string,
    members: { userId: string; role?: 'operator' | 'member' }[],
  ): string;
  /** Forces the membership insert to fail, to exercise atomicity. */
  failMembershipInsert: boolean;
}

export function createMemoryWorkspaceStore(): MemoryWorkspaceStore {
  const workspaces: MemoryWorkspaceRecord[] = [];
  const memberships: MemoryMembershipRecord[] = [];
  const state = { failMembershipInsert: false };

  function summarise(membership: MemoryMembershipRecord): AuthorizedWorkspaceSummary | null {
    const workspace = workspaces.find((candidate) => candidate.id === membership.workspaceId);
    if (workspace === undefined) {
      return null;
    }
    return { id: workspace.id, name: workspace.name, role: membership.role };
  }

  return {
    workspaces,
    memberships,

    seedWorkspace(name, members) {
      const id = randomUUID();
      workspaces.push({ id, name, demoEnabled: false, demoSlug: null });
      for (const member of members) {
        memberships.push({
          workspaceId: id,
          userId: member.userId,
          role: member.role ?? 'operator',
        });
      }
      return id;
    },

    get failMembershipInsert(): boolean {
      return state.failMembershipInsert;
    },
    set failMembershipInsert(value: boolean) {
      state.failMembershipInsert = value;
    },

    create(command: CreateWorkspaceCommand): Promise<AuthorizedWorkspaceSummary> {
      // Mirrors the production transaction: if the membership fails, the
      // workspace must not survive.
      const workspace: MemoryWorkspaceRecord = {
        id: randomUUID(),
        name: command.name,
        demoEnabled: false,
        demoSlug: null,
      };
      workspaces.push(workspace);

      if (state.failMembershipInsert) {
        workspaces.pop();
        return Promise.reject(new Error('membership insert failed'));
      }

      memberships.push({
        workspaceId: workspace.id,
        userId: command.creatorUserId,
        role: 'operator',
      });

      return Promise.resolve({ id: workspace.id, name: workspace.name, role: 'operator' });
    },

    listForUser(userId: string): Promise<AuthorizedWorkspaceSummary[]> {
      // Bounded by userId, exactly as the production membership join is.
      const summaries = memberships
        .filter((membership) => membership.userId === userId)
        .map(summarise)
        .filter((summary): summary is AuthorizedWorkspaceSummary => summary !== null)
        .sort((a, b) => a.name.localeCompare(b.name));

      return Promise.resolve(summaries);
    },

    authorize(userId: string, workspaceId: string): Promise<AuthorizedWorkspace | null> {
      const membership = memberships.find(
        (candidate) => candidate.userId === userId && candidate.workspaceId === workspaceId,
      );
      if (membership === undefined) {
        return Promise.resolve(null);
      }

      const summary = summarise(membership);
      if (summary === null) {
        return Promise.resolve(null);
      }

      // The route only reads `.workspace`; the scope is opaque to it. A cast is
      // used because the real constructor is intentionally unexported.
      return Promise.resolve({
        workspace: summary,
        scope: { workspaceId } as unknown as WorkspaceScope,
      });
    },
  };
}
