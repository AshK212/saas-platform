import { DEFAULT_AGENT_MODE, type AgentMode, type EffectiveAgentPolicy } from '@hybrid/contracts';
import type { AuthenticatedApiCredential } from '@hybrid/db';

import {
  MissingPolicyStateError,
  type PolicySnapshotResult,
  type PolicyStore,
} from '../../src/policy/store';

/**
 * In-memory `PolicyStore` mirroring the production read algorithm.
 *
 * Reproduces the semantics that matter: workspace scoping, version-first
 * reading, effective defaults for agents with no explicit policy row, exact
 * decimal cap strings, and a missing policy state raising an invariant error
 * rather than yielding version 0 or an empty policy.
 *
 * It is also DELIBERATELY WRITE-FREE. There is no method to set a mode, a cap
 * or a version, so a test cannot accidentally demonstrate a mutation path that
 * production does not have. Seeding happens through explicit `seed*` helpers
 * that stand in for provisioning and for the Step 13 mutation service.
 *
 * WHAT IT CANNOT PROVE
 * --------------------
 * That the emitted SQL carries the workspace predicate, that the LEFT JOIN
 * really returns agents with no policy row, or that a PostgreSQL `bigint`
 * survives the round trip. Those are `packages/db/tests/policy.test.ts`
 * (compiled SQL) and `packages/db/tests/policy.live.test.ts` (real
 * PostgreSQL, skipped without `TEST_DATABASE_URL`).
 */

interface StoredPolicy {
  readonly workspaceId: string;
  readonly externalId: string;
  readonly mode: AgentMode;
  readonly dailySpendCapUsd: string | null;
  readonly dailyPublishCap: number | null;
}

export interface MemoryPolicyStore extends PolicyStore {
  /** Stands in for provisioning: creates the workspace policy state row. */
  seedPolicyState(workspaceId: string, version?: string): void;
  /** Stands in for agent registration / event discovery. No policy row. */
  seedAgent(workspaceId: string, externalId: string): void;
  /** Stands in for the Step 13 mutation service. */
  seedExplicitPolicy(policy: StoredPolicy): void;
  /** Stands in for the Step 13 mutation service incrementing the version. */
  seedVersion(workspaceId: string, version: string): void;
  /** Counts reads, so version-first polling can be asserted. */
  readonly calls: { versionReads: number; snapshotReads: number };
}

export function createMemoryPolicyStore(): MemoryPolicyStore {
  const versions = new Map<string, string>();
  const agentsByWorkspace = new Map<string, string[]>();
  const policies: StoredPolicy[] = [];
  const calls = { versionReads: 0, snapshotReads: 0 };

  function requireVersion(workspaceId: string): string {
    const version = versions.get(workspaceId);
    if (version === undefined) {
      throw new MissingPolicyStateError();
    }
    return version;
  }

  return {
    calls,

    seedPolicyState(workspaceId: string, version = '1'): void {
      versions.set(workspaceId, version);
      if (!agentsByWorkspace.has(workspaceId)) {
        agentsByWorkspace.set(workspaceId, []);
      }
    },

    seedAgent(workspaceId: string, externalId: string): void {
      const roster = agentsByWorkspace.get(workspaceId) ?? [];
      if (!roster.includes(externalId)) {
        roster.push(externalId);
      }
      agentsByWorkspace.set(workspaceId, roster);
    },

    seedExplicitPolicy(policy: StoredPolicy): void {
      const roster = agentsByWorkspace.get(policy.workspaceId) ?? [];
      if (!roster.includes(policy.externalId)) {
        roster.push(policy.externalId);
      }
      agentsByWorkspace.set(policy.workspaceId, roster);
      policies.push(policy);
    },

    seedVersion(workspaceId: string, version: string): void {
      versions.set(workspaceId, version);
    },

    getVersion(credential: AuthenticatedApiCredential): Promise<string> {
      calls.versionReads += 1;
      try {
        return Promise.resolve(requireVersion(credential.scope.workspaceId));
      } catch (error: unknown) {
        return Promise.reject(error instanceof Error ? error : new Error('policy read failed'));
      }
    },

    getSnapshot(credential: AuthenticatedApiCredential): Promise<PolicySnapshotResult> {
      calls.snapshotReads += 1;
      const workspaceId = credential.scope.workspaceId;

      let version: string;
      try {
        version = requireVersion(workspaceId);
      } catch (error: unknown) {
        return Promise.reject(error instanceof Error ? error : new Error('policy read failed'));
      }

      const roster = [...(agentsByWorkspace.get(workspaceId) ?? [])].sort();

      const agents: EffectiveAgentPolicy[] = roster.map((externalId) => {
        // Scoped: a policy row from another workspace can never match.
        const explicit = policies.find(
          (p) => p.workspaceId === workspaceId && p.externalId === externalId,
        );

        return {
          agent_id: externalId,
          // Effective policy: the explicit row, else the deterministic default.
          mode: explicit?.mode ?? DEFAULT_AGENT_MODE,
          daily_spend_cap_usd: explicit?.dailySpendCapUsd ?? null,
          daily_publish_cap: explicit?.dailyPublishCap ?? null,
        };
      });

      return Promise.resolve({ version, agents });
    },
  };
}
