import { and, eq, sql } from 'drizzle-orm';

import type { DatabaseClient } from '../client.js';
import { agents } from '../schema/agents.js';
import { agentPolicies, workspacePolicyState } from '../schema/policy.js';
import type { WorkspaceScope } from './workspace-scope.js';

/**
 * THE ONLY POLICY WRITER IN THE SYSTEM.
 *
 * Deliberately a separate module from `policy.ts`, which stays provably
 * writer-free so a guardrail can assert the read path can never mutate.
 *
 * ─── THE INVARIANT ────────────────────────────────────────────────────────
 *
 *   A POLICY CHANGE AND ITS VERSION INCREMENT ARE ONE TRANSACTION.
 *
 * Neither half can commit alone. A policy changed without a version bump would
 * be invisible to every polling agent - they would keep reporting `since_version
 * = N`, receive 304, and run indefinitely under governance the operator
 * believes they replaced. A version bumped without a policy change would make
 * every agent re-download an unchanged snapshot and, worse, would corrupt the
 * version history that precheck receipts will later cite as evidence.
 *
 * ─── THE TRANSACTION ──────────────────────────────────────────────────────
 *
 *   BEGIN
 *     1. SELECT ... FOR UPDATE on workspace_policy_state
 *        - serializes concurrent mutations in this workspace from the start
 *        - a missing row aborts here, BEFORE anything is written
 *     2. SELECT the agent, workspace-scoped
 *        - not found => no mutation, reported as not-found
 *     3. INSERT ... ON CONFLICT (workspace_id, agent_id) DO UPDATE
 *     4. UPDATE workspace_policy_state SET version = version + 1 RETURNING
 *   COMMIT
 *
 * ─── WHY NOT read-then-write ON THE VERSION ───────────────────────────────
 *
 * `SELECT version` followed by `UPDATE ... SET version = <read + 1>` loses
 * increments: two transactions both read 10 and both write 11. The increment
 * here is a single `version + 1` statement evaluated by PostgreSQL against the
 * row it holds a lock on, so two committed mutations always produce two
 * distinct versions. The `FOR UPDATE` at step 1 makes that serialization begin
 * before any work rather than at the last statement.
 *
 * ─── WHAT THIS DELIBERATELY DOES NOT DO ───────────────────────────────────
 *
 * NO LEDGER EFFECT. Raising a cap from 25 to 100 must NOT reset or adjust
 * today's already-committed spend - that would let an operator erase history by
 * editing configuration. This module imports no ledger table.
 *
 * No receipts, no blocks, no events, no enforcement. Storing `paused` does not
 * pause anything yet.
 */

/** A complete desired policy. Every field is explicit; there is no partial form. */
export interface AgentPolicyValues {
  readonly mode: 'watch' | 'budgeted' | 'paused';
  /** Decimal string for `numeric(14,6)`, or null for UNCAPPED. Never a number. */
  readonly dailySpendCapUsd: string | null;
  /** Non-negative integer, or null for UNCAPPED. */
  readonly dailyPublishCap: number | null;
}

/** What actually committed, and the version it committed at. */
export interface CommittedAgentPolicy {
  /** External machine-facing id, for the response. */
  readonly externalId: string;
  readonly mode: AgentPolicyValues['mode'];
  readonly dailySpendCapUsd: string | null;
  readonly dailyPublishCap: number | null;
  /** Exact decimal string. The `bigint` is never converted through a JS number. */
  readonly version: string;
}

/**
 * The workspace has no `workspace_policy_state` row.
 *
 * A provisioning invariant failed. NOT self-healed here: creating the row
 * during a mutation would hide the defect and silently accept a governance
 * write against a workspace whose version history never existed.
 */
export class MissingPolicyStateError extends Error {
  public constructor() {
    // No workspace id: this may reach a log, and the HTTP layer collapses it
    // to an opaque 500 regardless.
    super('Workspace policy state is missing.');
    this.name = 'MissingPolicyStateError';
  }
}

export interface PolicyMutationService {
  /**
   * Writes one agent's complete policy and increments the workspace version.
   *
   * ALWAYS INCREMENTS, even when the submitted values equal the stored ones.
   * An operator who pressed save performed a governance write, and suppressing
   * the bump would make the version history depend on a value comparison -
   * meaning two operators saving the same values would see different histories
   * depending on who went first. Deterministic beats clever.
   *
   * @returns the committed policy, or null when the agent is not in this
   *   workspace - indistinguishable from an agent that does not exist.
   * @throws {MissingPolicyStateError} when the workspace has no version row.
   */
  setAgentPolicy(
    scope: WorkspaceScope,
    agentId: string,
    values: AgentPolicyValues,
  ): Promise<CommittedAgentPolicy | null>;
}

export function createPolicyMutationService(db: DatabaseClient): PolicyMutationService {
  return {
    async setAgentPolicy(
      scope: WorkspaceScope,
      agentId: string,
      values: AgentPolicyValues,
    ): Promise<CommittedAgentPolicy | null> {
      return db.transaction(async (tx) => {
        // 1. Serialize on the workspace's version row before doing anything.
        //    A concurrent mutation in the same workspace blocks here and
        //    resumes only after this transaction commits or rolls back.
        const locked = await tx
          .select({ version: sql<string>`${workspacePolicyState.version}::text` })
          .from(workspacePolicyState)
          .where(eq(workspacePolicyState.workspaceId, scope.workspaceId))
          .for('update')
          .limit(1);

        if (locked[0] === undefined) {
          // Nothing has been written yet, so the rollback leaves no agent
          // policy row behind.
          throw new MissingPolicyStateError();
        }

        // 2. The agent must belong to THIS workspace. A globally unique UUID
        //    is not authorization: without the workspace predicate, holding
        //    another tenant's agent id would let an operator rewrite their
        //    policy. The composite FK below is defense in depth, not the
        //    primary check.
        const found = await tx
          .select({ id: agents.id, externalId: agents.externalId })
          .from(agents)
          .where(and(eq(agents.workspaceId, scope.workspaceId), eq(agents.id, agentId)))
          .limit(1);

        const agent = found[0];
        if (agent === undefined) {
          // No write happened; the transaction commits having only read.
          return null;
        }

        // 3. Upsert on the workspace-scoped identity. `(workspace_id, agent_id)`
        //    is the primary key, so an agent with no policy row gets one and an
        //    existing row is replaced wholesale - there is no partial state.
        //
        //    Every field is written explicitly, including nulls: this is a PUT,
        //    so "no spend cap" must actually clear a previously set cap rather
        //    than leaving it in place.
        await tx
          .insert(agentPolicies)
          .values({
            // Workspace from the SCOPE, never from caller input.
            workspaceId: scope.workspaceId,
            agentId: agent.id,
            mode: values.mode,
            dailySpendCapUsd: values.dailySpendCapUsd,
            dailyPublishCap: values.dailyPublishCap,
          })
          .onConflictDoUpdate({
            target: [agentPolicies.workspaceId, agentPolicies.agentId],
            set: {
              mode: values.mode,
              dailySpendCapUsd: values.dailySpendCapUsd,
              dailyPublishCap: values.dailyPublishCap,
              updatedAt: sql`now()`,
            },
          });

        // 4. Atomic increment, evaluated by PostgreSQL against the locked row.
        //    Returned as text so the bigint never passes through a JS number.
        const bumped = await tx
          .update(workspacePolicyState)
          .set({ version: sql`${workspacePolicyState.version} + 1`, updatedAt: sql`now()` })
          .where(eq(workspacePolicyState.workspaceId, scope.workspaceId))
          .returning({ version: sql<string>`${workspacePolicyState.version}::text` });

        const version = bumped[0]?.version;
        if (version === undefined) {
          // Unreachable while the lock is held, since step 1 proved the row
          // exists. Throwing rather than returning a policy at an unknown
          // version rolls the upsert back too.
          throw new MissingPolicyStateError();
        }

        return {
          externalId: agent.externalId,
          mode: values.mode,
          dailySpendCapUsd: values.dailySpendCapUsd,
          dailyPublishCap: values.dailyPublishCap,
          version,
        };
      });
    },
  };
}
