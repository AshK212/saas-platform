import { DEFAULT_AGENT_MODE, type EffectiveAgentPolicy } from '@hybrid/contracts';
import {
  createPolicyReadRepository,
  type AuthenticatedApiCredential,
  type DatabaseClient,
} from '@hybrid/db';

/**
 * Read-only persistence port for policy polling.
 *
 * TWO-PHASE, VERSION FIRST
 * ------------------------
 * Agents poll roughly every 30 seconds, and the overwhelmingly common answer is
 * "nothing changed". So the version is read on its own first - a single-row
 * primary-key lookup - and the agent snapshot is loaded only when the caller is
 * actually behind. A 304 therefore costs one tiny query instead of a join
 * across every agent in the workspace.
 *
 * No cache is introduced. A per-poll primary-key read is already cheap, and
 * cache invalidation would be a new correctness problem to own before there is
 * any evidence it is needed.
 *
 * NOTHING HERE WRITES
 * -------------------
 * A poll does not create policy rows, does not increment the version, and does
 * not advance `last_seen_at`. Polling is configuration retrieval, not agent
 * activity: treating it as liveness would make a crashed-but-still-polling
 * supervisor look like a healthy agent, and last-seen is the substance of
 * AC-04.
 */

/** The workspace policy version is missing - a provisioning invariant failed. */
export class MissingPolicyStateError extends Error {
  public constructor() {
    // Deliberately carries no workspace id: this message may reach a log, and
    // the HTTP layer collapses it to an opaque 500 regardless.
    super('Workspace policy state is missing.');
    this.name = 'MissingPolicyStateError';
  }
}

export interface PolicySnapshotResult {
  /** Exact decimal string. Never a JS number - see the contract. */
  readonly version: string;
  readonly agents: readonly EffectiveAgentPolicy[];
}

export interface PolicyStore {
  /**
   * The workspace's current policy version.
   *
   * @throws {MissingPolicyStateError} when the workspace has no policy state.
   *   Every supported provisioning path creates it atomically with the
   *   workspace, so this means the invariant broke - not that the policy is
   *   empty and not that the version is 0.
   */
  getVersion(credential: AuthenticatedApiCredential): Promise<string>;

  /** The full authoritative snapshot. Loaded only when the caller is behind. */
  getSnapshot(credential: AuthenticatedApiCredential): Promise<PolicySnapshotResult>;
}

export function createDrizzlePolicyStore(db: DatabaseClient): PolicyStore {
  async function readVersion(credential: AuthenticatedApiCredential): Promise<string> {
    // Scope from the credential row - the only tenant source for a machine.
    const version = await createPolicyReadRepository(db, credential.scope).findVersion();
    if (version === null) {
      throw new MissingPolicyStateError();
    }
    return version;
  }

  return {
    getVersion: readVersion,

    async getSnapshot(credential: AuthenticatedApiCredential): Promise<PolicySnapshotResult> {
      const scope = credential.scope;
      const version = await readVersion(credential);

      const rows = await createPolicyReadRepository(db, scope).listEffectivePolicies();

      return {
        version,
        agents: rows.map((row) => ({
          // The EXTERNAL id: what the runtime calls this agent. The internal
          // UUID is never exposed on the machine surface.
          agent_id: row.externalId,
          // EFFECTIVE POLICY. No explicit row means observe-and-record with no
          // caps - not an error, and not a fabricated row written to the
          // database. Persisting a default here would make agent discovery
          // mutate governance, which is exactly the separation Step 10 kept.
          mode: row.mode ?? DEFAULT_AGENT_MODE,
          // NULL means UNCAPPED and is passed through untouched. Substituting 0
          // would silently turn "no limit" into "nothing permitted".
          //
          // The value arrives from `numeric(14,6)` as a string and is never
          // converted through a JS float.
          daily_spend_cap_usd: row.dailySpendCapUsd,
          daily_publish_cap: row.dailyPublishCap,
        })),
      };
    },
  };
}
