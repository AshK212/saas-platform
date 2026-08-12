import { and, eq, type SQL } from 'drizzle-orm';

import { agents } from '../schema/agents.js';
import type { DatabaseExecutor } from './executor.js';
import type { WorkspaceScope } from './workspace-scope.js';

/**
 * Workspace-scoped agent reads.
 *
 * Every query built here includes `workspace_id = :scope`. There is no
 * tenant-free variant of any method, and no method accepts a workspace id as an
 * argument - the scope is bound once, at construction.
 *
 * STEP 4 SCOPE: READS ONLY. No creation, no discovery, no `last_seen_at`
 * updates. AC-04 behaviour belongs to its own step.
 */

export type AgentRow = typeof agents.$inferSelect;

/**
 * The scope predicate every agent query is anchored on.
 *
 * Exported so architecture tests can render it to SQL and prove the workspace
 * column really participates. It requires a scope, so exporting it creates no
 * unscoped path.
 */
export function agentScopePredicate(scope: WorkspaceScope): SQL {
  return eq(agents.workspaceId, scope.workspaceId);
}

/**
 * Query builders.
 *
 * Separated from execution so tests can call `.toSQL()` and inspect the emitted
 * predicate without a database connection.
 */
export const agentQueries = {
  /**
   * A UUID IS NOT AUTHORIZATION. `id` is globally unique, but the workspace
   * predicate is still required: without it, holding or guessing an id from
   * another tenant would return that tenant's row.
   */
  findById: (executor: DatabaseExecutor, scope: WorkspaceScope, agentId: string) =>
    executor
      .select()
      .from(agents)
      .where(and(agentScopePredicate(scope), eq(agents.id, agentId)))
      .limit(1),

  /**
   * `external_id` is unique only WITHIN a workspace, so two tenants may both
   * have `agent-1`. The workspace predicate is what keeps them apart.
   */
  findByExternalId: (executor: DatabaseExecutor, scope: WorkspaceScope, externalId: string) =>
    executor
      .select()
      .from(agents)
      .where(and(agentScopePredicate(scope), eq(agents.externalId, externalId)))
      .limit(1),

  /** Every agent in the scoped workspace, and only that workspace. */
  listAll: (executor: DatabaseExecutor, scope: WorkspaceScope) =>
    executor.select().from(agents).where(agentScopePredicate(scope)),
} as const;

export interface AgentRepository {
  /** Returns null when the agent does not exist IN THIS WORKSPACE. */
  findById(agentId: string): Promise<AgentRow | null>;
  /** Returns null when no agent with this external id exists in this workspace. */
  findByExternalId(externalId: string): Promise<AgentRow | null>;
  listAll(): Promise<AgentRow[]>;
}

/**
 * Binds agent reads to one workspace and one executor.
 *
 * @param executor - pooled client or an open transaction.
 * @param scope - trusted workspace scope; see workspace-scope.ts.
 */
export function createAgentRepository(
  executor: DatabaseExecutor,
  scope: WorkspaceScope,
): AgentRepository {
  return {
    async findById(agentId: string): Promise<AgentRow | null> {
      const rows = await agentQueries.findById(executor, scope, agentId);
      // A row belonging to another workspace is indistinguishable from a row
      // that does not exist. No "exists elsewhere" signal is ever produced.
      return rows[0] ?? null;
    },

    async findByExternalId(externalId: string): Promise<AgentRow | null> {
      const rows = await agentQueries.findByExternalId(executor, scope, externalId);
      return rows[0] ?? null;
    },

    async listAll(): Promise<AgentRow[]> {
      return agentQueries.listAll(executor, scope);
    },
  };
}
