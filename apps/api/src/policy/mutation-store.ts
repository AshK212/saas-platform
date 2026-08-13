import type { AgentPolicyMutationRequest, EffectiveAgentPolicy } from '@hybrid/contracts';
import {
  createPolicyMutationService,
  createPolicyReadRepository,
  type AuthorizedWorkspace,
  type DatabaseClient,
} from '@hybrid/db';

/**
 * Operator policy mutation port.
 *
 * SEPARATE FROM THE POLLING STORE
 * -------------------------------
 * `policy/store.ts` is the machine READ path and has no writer at all. This is
 * the operator WRITE path. Keeping them apart means the polling route cannot
 * reach a mutator even by accident, and a guardrail test enforces that the read
 * repository contains no write statement.
 *
 * SCOPE, NOT A WORKSPACE ID
 * -------------------------
 * Every method takes an `AuthorizedWorkspace` - the product of a proven
 * membership whose role the route has already checked. There is no method that
 * accepts a bare workspace id.
 *
 * NO UNVERSIONED WRITER
 * ---------------------
 * The only write exposed here goes through `PolicyMutationService`, which
 * increments the workspace policy version in the same transaction. There is
 * deliberately no "just save the policy" method: one would eventually be
 * called, and a policy change invisible to polling agents is worse than a
 * failed one.
 */

export interface AgentPolicyMutationResult {
  readonly policy: EffectiveAgentPolicy;
  /** Exact decimal string, committed by the same transaction as the policy. */
  readonly version: string;
}

export interface PolicyMutationStore {
  /**
   * Writes one agent's complete policy and bumps the workspace version.
   *
   * @returns null when the agent is not in this workspace - identical to an
   *   agent that does not exist.
   * @throws when the workspace has no policy state (a provisioning invariant).
   */
  setAgentPolicy(
    authorized: AuthorizedWorkspace,
    agentId: string,
    request: AgentPolicyMutationRequest,
  ): Promise<AgentPolicyMutationResult | null>;

  /**
   * One agent's EFFECTIVE policy, for populating the operator editor.
   *
   * Effective, not stored: an agent with no explicit row reports the Step 12
   * default rather than an empty form the operator might mistake for "no
   * policy applies".
   */
  getAgentPolicy(
    authorized: AuthorizedWorkspace,
    agentId: string,
  ): Promise<AgentPolicyMutationResult | null>;
}

export function createDrizzlePolicyMutationStore(db: DatabaseClient): PolicyMutationStore {
  return {
    async setAgentPolicy(
      authorized: AuthorizedWorkspace,
      agentId: string,
      request: AgentPolicyMutationRequest,
    ): Promise<AgentPolicyMutationResult | null> {
      const committed = await createPolicyMutationService(db).setAgentPolicy(
        authorized.scope,
        agentId,
        {
          mode: request.mode,
          // Passed through as the exact decimal string the contract validated.
          // No Number(), no toFixed(), no arithmetic anywhere on this path.
          dailySpendCapUsd: request.daily_spend_cap_usd,
          dailyPublishCap: request.daily_publish_cap,
        },
      );

      if (committed === null) {
        return null;
      }

      return {
        policy: {
          // The EXTERNAL id, matching what `GET /v1/policy` reports.
          agent_id: committed.externalId,
          mode: committed.mode,
          daily_spend_cap_usd: committed.dailySpendCapUsd,
          daily_publish_cap: committed.dailyPublishCap,
        },
        version: committed.version,
      };
    },

    async getAgentPolicy(
      authorized: AuthorizedWorkspace,
      agentId: string,
    ): Promise<AgentPolicyMutationResult | null> {
      const scope = authorized.scope;
      const repository = createPolicyReadRepository(db, scope);

      const version = await repository.findVersion();
      if (version === null) {
        // Same invariant as the polling path: a workspace with no version is
        // broken, not empty. Reported as an opaque 500 by the route.
        throw new Error('Workspace policy state is missing.');
      }

      // Reuses the Step 12 effective-policy read rather than a second query
      // with its own default rules, so the editor and the agent can never be
      // shown different effective values.
      const rows = await repository.listEffectivePolicies();
      const row = rows.find((candidate) => candidate.id === agentId);
      if (row === undefined) {
        return null;
      }

      return {
        policy: {
          agent_id: row.externalId,
          mode: row.mode ?? 'watch',
          daily_spend_cap_usd: row.dailySpendCapUsd,
          daily_publish_cap: row.dailyPublishCap,
        },
        version,
      };
    },
  };
}
