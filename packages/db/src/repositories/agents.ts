import { and, desc, eq, sql, type SQL } from 'drizzle-orm';

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
 * STEP 8 adds workspace-scoped WRITES: registration/discovery and last-seen.
 * Every mutation carries the same scope predicate as the reads, so a machine
 * caller can only ever touch its own tenant's agents.
 *
 * FIELD OWNERSHIP - what a machine caller may change
 * --------------------------------------------------
 *   last_seen_at    machine-owned. Set from SERVER time on every registration.
 *   display_name    self-reported, and only when supplied. See `register`.
 *   updated_at      bookkeeping.
 *
 * Everything else is off limits to machine callers, and there is no method here
 * that could change it:
 *   workspace_id        fixed at creation, taken from the scope
 *   runtime_profile_id  deliberately NOT settable - see `register`
 *   policy / caps / pause / mode   live in `agent_policies`, untouched here
 *
 * There is deliberately NO generic `update(id, patch)`. A generic mutator is
 * how a future caller acquires authority over fields it should never own.
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

  /**
   * Every agent in the scoped workspace, and only that workspace.
   *
   * Ordered by last contact, newest first, so the AC-04 roster shows live
   * agents at the top. `NULLS LAST` keeps never-seen agents below active ones.
   */
  listAll: (executor: DatabaseExecutor, scope: WorkspaceScope) =>
    executor
      .select()
      .from(agents)
      .where(agentScopePredicate(scope))
      .orderBy(sql`${agents.lastSeenAt} desc nulls last`, desc(agents.createdAt)),
} as const;

export interface RegisterAgentInput {
  /** Client-supplied stable identifier, unique within the workspace. */
  readonly externalId: string;
  /** Self-reported label. Omitted leaves any existing name untouched. */
  readonly displayName?: string | undefined;
}

export interface AgentRepository {
  /** Returns null when the agent does not exist IN THIS WORKSPACE. */
  findById(agentId: string): Promise<AgentRow | null>;
  /** Returns null when no agent with this external id exists in this workspace. */
  findByExternalId(externalId: string): Promise<AgentRow | null>;
  /** Newest contact first, so an operator sees live agents at the top. */
  listAll(): Promise<AgentRow[]>;
  /**
   * Registers or re-resolves an agent, atomically.
   *
   * @param now - SERVER time. Never a caller-supplied timestamp.
   */
  register(input: RegisterAgentInput, now: Date): Promise<AgentRow>;
  /** Advances last-seen for an existing agent. Used by later event ingest. */
  touchLastSeen(agentId: string, now: Date): Promise<void>;
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

    /**
     * Atomic registration / discovery.
     *
     * ONE statement, relying on the database's own uniqueness guarantee:
     *
     *   INSERT INTO agents (...) VALUES (...)
     *   ON CONFLICT (workspace_id, external_id) DO UPDATE
     *      SET last_seen_at = $now,
     *          updated_at   = $now,
     *          display_name = COALESCE(EXCLUDED.display_name, agents.display_name)
     *   RETURNING *
     *
     * There is deliberately no `SELECT` followed by an `INSERT`: that pattern
     * has a read-modify-write window in which two concurrent registrations both
     * observe "not present" and both insert. Here the unique index on
     * `(workspace_id, external_id)` is the arbiter - PostgreSQL serialises the
     * conflicting inserts and the loser is converted into an update, so exactly
     * one row can ever exist for a given workspace + agent id.
     *
     * WHY `COALESCE` ON THE NAME
     * --------------------------
     * A registration that omits a name must not blank an existing one. The name
     * is self-reported and there is currently no operator rename route, so
     * nothing operator-owned can be clobbered. **If a rename route is added
     * later, this line must be revisited** - at that point the machine should
     * stop overwriting the name at all.
     *
     * `workspace_id` comes from the SCOPE. It is not an argument, so a caller
     * has nothing to influence.
     *
     * `runtime_profile_id` is intentionally absent. Accepting one would require
     * validating that the profile belongs to this workspace, and Step 8 needs no
     * such linking - omitting it removes the cross-workspace attachment risk
     * entirely rather than defending against it.
     */
    async register(input: RegisterAgentInput, now: Date): Promise<AgentRow> {
      const rows = await executor
        .insert(agents)
        .values({
          workspaceId: scope.workspaceId,
          externalId: input.externalId,
          displayName: input.displayName ?? null,
          lastSeenAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [agents.workspaceId, agents.externalId],
          set: {
            lastSeenAt: now,
            updatedAt: now,
            displayName: sql`coalesce(excluded.display_name, ${agents.displayName})`,
          },
        })
        .returning();

      const row = rows[0];
      if (row === undefined) {
        throw new Error('Failed to register agent.');
      }
      return row;
    },

    async touchLastSeen(agentId: string, now: Date): Promise<void> {
      await executor
        .update(agents)
        .set({ lastSeenAt: now, updatedAt: now })
        .where(and(agentScopePredicate(scope), eq(agents.id, agentId)));
    },
  };
}
