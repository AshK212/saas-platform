import { and, asc, eq, sql, type SQL } from 'drizzle-orm';

import { agents } from '../schema/agents.js';
import { agentPolicies, workspacePolicyState } from '../schema/policy.js';
import type { DatabaseExecutor } from './executor.js';
import type { WorkspaceScope } from './workspace-scope.js';

/**
 * Workspace-scoped policy READS.
 *
 * READ-ONLY BY CONSTRUCTION
 * -------------------------
 * There is no `updatePolicy`, `savePolicy`, `setMode`, `setCap` or `bumpVersion`
 * here, and none may be added in Step 12. Operator policy mutation is Step 13
 * and will live in its own module with its own transaction.
 *
 * This matters beyond tidiness: event ingest, agent registration, API-key
 * authentication, share links and the public demo all reach the data layer, and
 * a policy mutator reachable from any of them would let a runtime edit the
 * governance it is subject to. The absence of a writer is the guarantee, and a
 * guardrail test enforces it.
 *
 * VERSION AS TEXT
 * ---------------
 * `workspace_policy_state.version` is a PostgreSQL `bigint`. It is selected
 * with an explicit `::text` cast so PostgreSQL renders the exact integer and
 * the driver hands back a string. Reading it as a JS number would silently lose
 * precision above 2^53 - unreachable in practice for a counter, but a defect
 * that would be invisible if it ever happened, and free to avoid.
 */

/** The scope predicate every policy-state query is anchored on. */
export function policyStateScopePredicate(scope: WorkspaceScope): SQL {
  return eq(workspacePolicyState.workspaceId, scope.workspaceId);
}

/** The scope predicate every effective-policy query is anchored on. */
export function agentPolicyScopePredicate(scope: WorkspaceScope): SQL {
  return eq(agents.workspaceId, scope.workspaceId);
}

/** One agent's effective policy, as stored or defaulted. */
export interface EffectiveAgentPolicyRow {
  /** Internal UUID. Not exposed on the machine surface. */
  readonly id: string;
  /** External machine-facing id (`agents.external_id`). */
  readonly externalId: string;
  /** Null when no explicit `agent_policies` row exists. */
  readonly mode: 'watch' | 'budgeted' | 'paused' | null;
  /** Decimal string from `numeric(14,6)`, or null. */
  readonly dailySpendCapUsd: string | null;
  readonly dailyPublishCap: number | null;
  /** True when an explicit policy row backs this agent. */
  readonly hasExplicitPolicy: boolean;
}

export const policyQueries = {
  /**
   * The workspace's authoritative policy version, rendered exactly.
   *
   * Returns no row when `workspace_policy_state` is missing, which is an
   * invariant violation rather than an empty policy - see the repository.
   */
  findVersion: (executor: DatabaseExecutor, scope: WorkspaceScope) =>
    executor
      .select({ version: sql<string>`${workspacePolicyState.version}::text` })
      .from(workspacePolicyState)
      .where(policyStateScopePredicate(scope))
      .limit(1),

  /**
   * The version, read under a SHARED lock for decision consistency.
   *
   * WHY `FOR SHARE` AND NOT `FOR UPDATE`
   * ------------------------------------
   * A precheck must evaluate against one internally consistent
   * `(version, policy)` pair: if an operator's mutation landed between reading
   * the version and reading the caps, the receipt would cite a version that
   * never produced the decision it records.
   *
   * `FOR SHARE` blocks the policy MUTATION path - which takes `FOR UPDATE` -
   * for the life of the deciding transaction, while letting concurrent
   * prechecks proceed together. `FOR UPDATE` here would serialize every
   * precheck in a workspace against every other, which for a per-action call
   * would be a severe and unnecessary throughput cost.
   */
  lockVersionForShare: (executor: DatabaseExecutor, scope: WorkspaceScope) =>
    executor
      .select({ version: sql<string>`${workspacePolicyState.version}::text` })
      .from(workspacePolicyState)
      .where(policyStateScopePredicate(scope))
      .for('share')
      .limit(1),

  /**
   * One agent's explicit policy, if any. Used by the decision path, which
   * needs a single agent rather than the whole roster.
   */
  findAgentPolicy: (executor: DatabaseExecutor, scope: WorkspaceScope, agentId: string) =>
    executor
      .select({
        mode: agentPolicies.mode,
        dailySpendCapUsd: agentPolicies.dailySpendCapUsd,
        dailyPublishCap: agentPolicies.dailyPublishCap,
      })
      .from(agentPolicies)
      .where(
        and(
          eq(agentPolicies.workspaceId, scope.workspaceId),
          eq(agentPolicies.agentId, agentId),
        ),
      )
      .limit(1),

  /**
   * Every agent in the workspace with its explicit policy, if any.
   *
   * LEFT JOIN FROM AGENTS, NOT FROM POLICIES. An agent may exist with no policy
   * row - it is created by registration or by event auto-discovery, neither of
   * which writes policy. Joining from policies would silently omit exactly
   * those agents, which is the "empty policy for a known workspace" failure
   * this step exists to prevent.
   *
   * The join condition repeats `workspace_id` in addition to `agent_id`, so a
   * policy row can never be paired with another tenant's agent even if the
   * outer predicate were dropped. Joining on the agent UUID alone would be a
   * global join.
   *
   * Ordered by external id so a 30-second poll returns a stable snapshot and
   * two consecutive polls are diffable.
   */
  listEffectivePolicies: (executor: DatabaseExecutor, scope: WorkspaceScope) =>
    executor
      .select({
        id: agents.id,
        externalId: agents.externalId,
        mode: agentPolicies.mode,
        dailySpendCapUsd: agentPolicies.dailySpendCapUsd,
        dailyPublishCap: agentPolicies.dailyPublishCap,
      })
      .from(agents)
      .leftJoin(
        agentPolicies,
        and(
          eq(agentPolicies.agentId, agents.id),
          eq(agentPolicies.workspaceId, agents.workspaceId),
        ),
      )
      .where(agentPolicyScopePredicate(scope))
      .orderBy(asc(agents.externalId)),
} as const;

/** One agent's effective policy, resolved for a decision. */
export interface EffectivePolicyForDecision {
  /** The exact workspace policy version this snapshot belongs to. */
  readonly version: string;
  readonly mode: 'watch' | 'budgeted' | 'paused';
  readonly dailySpendCapUsd: string | null;
  readonly dailyPublishCap: number | null;
  /** False when the defaults were applied because no explicit row exists. */
  readonly hasExplicitPolicy: boolean;
}

export interface PolicyReadRepository {
  /**
   * The workspace policy version as an exact decimal string.
   *
   * @returns null when no `workspace_policy_state` row exists. The caller must
   *   treat that as an invariant violation, NOT as version 0 or an empty
   *   policy - see `createWorkspaceWithOperator`, which creates the row in the
   *   same transaction as the workspace.
   */
  findVersion(): Promise<string | null>;

  /** Every agent with its effective policy. Empty only if the workspace has no agents. */
  listEffectivePolicies(): Promise<EffectiveAgentPolicyRow[]>;

  /**
   * One CONSISTENT policy snapshot for a decision, under a shared lock.
   *
   * The version and the caps are read in the same transaction with the version
   * row locked `FOR SHARE`, so an operator mutation cannot land between them.
   * The receipt can therefore cite a version that genuinely produced the
   * decision.
   *
   * Applies the Step 12 defaults when no explicit row exists, and creates
   * nothing - governance state is operator-owned, and a precheck that wrote a
   * policy row would be an agent configuring itself.
   *
   * @returns null when the workspace has no policy state, which is a
   *   provisioning invariant violation rather than an empty policy.
   */
  lockPolicyForDecision(agentId: string): Promise<EffectivePolicyForDecision | null>;
}

export function createPolicyReadRepository(
  executor: DatabaseExecutor,
  scope: WorkspaceScope,
): PolicyReadRepository {
  return {
    async findVersion(): Promise<string | null> {
      const rows = await policyQueries.findVersion(executor, scope);
      return rows[0]?.version ?? null;
    },

    async lockPolicyForDecision(agentId: string): Promise<EffectivePolicyForDecision | null> {
      // 1. Lock the version row FOR SHARE. This is the FIRST lock a decision
      //    takes - see the documented global lock order in docs/precheck.md.
      const versions = await policyQueries.lockVersionForShare(executor, scope);
      const version = versions[0]?.version;
      if (version === undefined) {
        return null;
      }

      // 2. Read the agent's policy inside the same lock, so the version above
      //    is guaranteed to be the one these values belong to.
      const rows = await policyQueries.findAgentPolicy(executor, scope, agentId);
      const explicit = rows[0];

      if (explicit === undefined) {
        // Step 12 defaults: observe and record, enforce nothing. Computed,
        // never persisted.
        return {
          version,
          mode: 'watch',
          dailySpendCapUsd: null,
          dailyPublishCap: null,
          hasExplicitPolicy: false,
        };
      }

      return {
        version,
        mode: explicit.mode,
        dailySpendCapUsd: explicit.dailySpendCapUsd,
        dailyPublishCap: explicit.dailyPublishCap,
        hasExplicitPolicy: true,
      };
    },

    async listEffectivePolicies(): Promise<EffectiveAgentPolicyRow[]> {
      const rows = await policyQueries.listEffectivePolicies(executor, scope);

      return rows.map((row) => ({
        id: row.id,
        externalId: row.externalId,
        mode: row.mode,
        dailySpendCapUsd: row.dailySpendCapUsd,
        dailyPublishCap: row.dailyPublishCap,
        // The left join produced no policy row for this agent.
        hasExplicitPolicy: row.mode !== null,
      }));
    },
  };
}
