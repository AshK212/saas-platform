import { and, eq, type SQL } from 'drizzle-orm';

import { runtimeProfiles } from '../schema/runtime.js';
import type { DatabaseExecutor } from './executor.js';
import type { WorkspaceScope } from './workspace-scope.js';

/**
 * Workspace-scoped runtime profile reads.
 *
 * Included in Step 4 because runtime profiles are the other side of the
 * composite `(workspace_id, runtime_profile_id)` foreign key on `agents`. They
 * prove the scoping pattern holds for a workspace-owned entity that is itself a
 * composite-FK target, not just for leaf tables.
 *
 * STEP 4 SCOPE: READS ONLY. No adapter, no runtime behaviour, no Hermes or
 * OpenClaw anything.
 */

export type RuntimeProfileRow = typeof runtimeProfiles.$inferSelect;

export function runtimeProfileScopePredicate(scope: WorkspaceScope): SQL {
  return eq(runtimeProfiles.workspaceId, scope.workspaceId);
}

export const runtimeProfileQueries = {
  findById: (executor: DatabaseExecutor, scope: WorkspaceScope, profileId: string) =>
    executor
      .select()
      .from(runtimeProfiles)
      .where(and(runtimeProfileScopePredicate(scope), eq(runtimeProfiles.id, profileId)))
      .limit(1),

  /** `name` is unique per workspace, so this too must be scoped. */
  findByName: (executor: DatabaseExecutor, scope: WorkspaceScope, name: string) =>
    executor
      .select()
      .from(runtimeProfiles)
      .where(and(runtimeProfileScopePredicate(scope), eq(runtimeProfiles.name, name)))
      .limit(1),

  listAll: (executor: DatabaseExecutor, scope: WorkspaceScope) =>
    executor.select().from(runtimeProfiles).where(runtimeProfileScopePredicate(scope)),
} as const;

export interface RuntimeProfileRepository {
  findById(profileId: string): Promise<RuntimeProfileRow | null>;
  findByName(name: string): Promise<RuntimeProfileRow | null>;
  listAll(): Promise<RuntimeProfileRow[]>;
}

export function createRuntimeProfileRepository(
  executor: DatabaseExecutor,
  scope: WorkspaceScope,
): RuntimeProfileRepository {
  return {
    async findById(profileId: string): Promise<RuntimeProfileRow | null> {
      const rows = await runtimeProfileQueries.findById(executor, scope, profileId);
      return rows[0] ?? null;
    },

    async findByName(name: string): Promise<RuntimeProfileRow | null> {
      const rows = await runtimeProfileQueries.findByName(executor, scope, name);
      return rows[0] ?? null;
    },

    async listAll(): Promise<RuntimeProfileRow[]> {
      return runtimeProfileQueries.listAll(executor, scope);
    },
  };
}
