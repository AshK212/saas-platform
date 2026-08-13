import type { AgentPolicyMutationRequest } from '@hybrid/contracts';
import type { AuthorizedWorkspace } from '@hybrid/db';

import type {
  AgentPolicyMutationResult,
  PolicyMutationStore,
} from '../../src/policy/mutation-store';

/**
 * In-memory `PolicyMutationStore` mirroring the production write algorithm.
 *
 * Reproduces the semantics that matter: workspace-scoped agent resolution, a
 * full upsert (no partial fields), ALWAYS incrementing the version, and a
 * missing policy state aborting before anything is written.
 *
 * WHAT IT CANNOT PROVE
 * --------------------
 * The thing this step actually rests on. It is single-threaded JavaScript, so
 * its increment is atomic for free. Whether PostgreSQL loses an increment
 * between two concurrent transactions, whether `SELECT ... FOR UPDATE` really
 * serializes them, and whether a failed version bump rolls the policy write
 * back can only be established by `packages/db/tests/policy-mutation.live.test.ts`,
 * skipped without `TEST_DATABASE_URL`.
 */

interface StoredAgent {
  readonly workspaceId: string;
  readonly id: string;
  readonly externalId: string;
}

interface StoredPolicy {
  workspaceId: string;
  agentId: string;
  mode: AgentPolicyMutationRequest['mode'];
  dailySpendCapUsd: string | null;
  dailyPublishCap: number | null;
}

export interface MemoryPolicyMutationStore extends PolicyMutationStore {
  /** Stands in for provisioning. */
  seedPolicyState(workspaceId: string, version?: string): void;
  /** Stands in for agent registration / event discovery. No policy row. */
  seedAgent(workspaceId: string, id: string, externalId: string): void;
  /** The committed version, for asserting non-increment on rejected attempts. */
  versionOf(workspaceId: string): string | undefined;
  /** The committed policy row, or undefined when the agent has no explicit one. */
  policyOf(workspaceId: string, agentId: string): StoredPolicy | undefined;
  /** Forces the version bump to fail, to exercise rollback. */
  failVersionBump: boolean;
}

export function createMemoryPolicyMutationStore(): MemoryPolicyMutationStore {
  const versions = new Map<string, string>();
  const agents: StoredAgent[] = [];
  const policies: StoredPolicy[] = [];
  const state = { failVersionBump: false };

  function findAgent(workspaceId: string, agentId: string): StoredAgent | undefined {
    // Workspace-scoped: another tenant's exact UUID resolves to nothing.
    return agents.find((a) => a.workspaceId === workspaceId && a.id === agentId);
  }

  return {
    seedPolicyState(workspaceId: string, version = '1'): void {
      versions.set(workspaceId, version);
    },

    seedAgent(workspaceId: string, id: string, externalId: string): void {
      agents.push({ workspaceId, id, externalId });
    },

    versionOf(workspaceId: string): string | undefined {
      return versions.get(workspaceId);
    },

    policyOf(workspaceId: string, agentId: string): StoredPolicy | undefined {
      return policies.find((p) => p.workspaceId === workspaceId && p.agentId === agentId);
    },

    get failVersionBump(): boolean {
      return state.failVersionBump;
    },
    set failVersionBump(value: boolean) {
      state.failVersionBump = value;
    },

    setAgentPolicy(
      authorized: AuthorizedWorkspace,
      agentId: string,
      request: AgentPolicyMutationRequest,
    ): Promise<AgentPolicyMutationResult | null> {
      const workspaceId = authorized.scope.workspaceId;

      // 1. Missing policy state aborts BEFORE any write.
      const current = versions.get(workspaceId);
      if (current === undefined) {
        return Promise.reject(new Error('Workspace policy state is missing.'));
      }

      // 2. Agent must be in THIS workspace.
      const agent = findAgent(workspaceId, agentId);
      if (agent === undefined) {
        return Promise.resolve(null);
      }

      // Snapshot for rollback - production is one transaction.
      const policySnapshot = policies.map((p) => ({ ...p }));

      // 3. Full upsert. Every field written, including nulls.
      const existing = policies.find(
        (p) => p.workspaceId === workspaceId && p.agentId === agentId,
      );
      const next: StoredPolicy = {
        workspaceId,
        agentId,
        mode: request.mode,
        dailySpendCapUsd: request.daily_spend_cap_usd,
        dailyPublishCap: request.daily_publish_cap,
      };
      if (existing === undefined) {
        policies.push(next);
      } else {
        Object.assign(existing, next);
      }

      // 4. Always increment, even when the values are unchanged.
      if (state.failVersionBump) {
        // Roll the policy write back with it: neither half may survive alone.
        policies.length = 0;
        policies.push(...policySnapshot);
        return Promise.reject(new Error('Version bump failed.'));
      }
      const bumped = (BigInt(current) + 1n).toString();
      versions.set(workspaceId, bumped);

      return Promise.resolve({
        policy: {
          agent_id: agent.externalId,
          mode: request.mode,
          daily_spend_cap_usd: request.daily_spend_cap_usd,
          daily_publish_cap: request.daily_publish_cap,
        },
        version: bumped,
      });
    },

    getAgentPolicy(
      authorized: AuthorizedWorkspace,
      agentId: string,
    ): Promise<AgentPolicyMutationResult | null> {
      const workspaceId = authorized.scope.workspaceId;

      const version = versions.get(workspaceId);
      if (version === undefined) {
        return Promise.reject(new Error('Workspace policy state is missing.'));
      }

      const agent = findAgent(workspaceId, agentId);
      if (agent === undefined) {
        return Promise.resolve(null);
      }

      const stored = policies.find(
        (p) => p.workspaceId === workspaceId && p.agentId === agentId,
      );

      return Promise.resolve({
        policy: {
          agent_id: agent.externalId,
          // EFFECTIVE: no explicit row reports the default, not an empty form.
          mode: stored?.mode ?? 'watch',
          daily_spend_cap_usd: stored?.dailySpendCapUsd ?? null,
          daily_publish_cap: stored?.dailyPublishCap ?? null,
        },
        version,
      });
    },
  };
}
