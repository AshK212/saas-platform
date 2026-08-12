import {
  createAgentRepository,
  type AgentRow,
  type AuthenticatedApiCredential,
  type AuthorizedWorkspace,
  type DatabaseClient,
} from '@hybrid/db';

/**
 * Persistence port for the agent registry.
 *
 * TWO ENTRY POINTS, ONE SCOPED REPOSITORY
 * ---------------------------------------
 *   register()   takes an `AuthenticatedApiCredential` - the machine path. The
 *                scope comes from the credential row.
 *   list()/get() take an `AuthorizedWorkspace` - the operator path. The scope
 *                comes from a proven membership.
 *
 * Neither accepts a workspace id. Both funnel into the same workspace-scoped
 * repository, so the tenant predicate is identical regardless of which
 * authentication domain the caller arrived through.
 */

export interface RegisterAgentCommand {
  /** Stable client-supplied identifier (`external_id`). */
  readonly externalId: string;
  readonly displayName?: string | undefined;
}

export interface AgentStore {
  /**
   * Registers or re-resolves an agent inside the credential's workspace.
   *
   * @param now - SERVER time; the caller's clock is never consulted.
   */
  register(
    credential: AuthenticatedApiCredential,
    command: RegisterAgentCommand,
    now: Date,
  ): Promise<AgentRow>;

  /** Lists the authorized workspace's agents, newest contact first. */
  list(authorized: AuthorizedWorkspace): Promise<AgentRow[]>;

  /**
   * Fetches one agent by internal id.
   *
   * @returns null when the agent is not in this workspace - indistinguishable
   *   from an agent that does not exist.
   */
  findById(authorized: AuthorizedWorkspace, agentId: string): Promise<AgentRow | null>;
}

export function createDrizzleAgentStore(db: DatabaseClient): AgentStore {
  return {
    async register(
      credential: AuthenticatedApiCredential,
      command: RegisterAgentCommand,
      now: Date,
    ): Promise<AgentRow> {
      // Scope from the credential row - the only tenant source for a machine.
      return createAgentRepository(db, credential.scope).register(
        { externalId: command.externalId, displayName: command.displayName },
        now,
      );
    },

    async list(authorized: AuthorizedWorkspace): Promise<AgentRow[]> {
      return createAgentRepository(db, authorized.scope).listAll();
    },

    async findById(authorized: AuthorizedWorkspace, agentId: string): Promise<AgentRow | null> {
      return createAgentRepository(db, authorized.scope).findById(agentId);
    },
  };
}
