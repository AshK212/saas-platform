import { randomUUID } from 'node:crypto';

import type { AgentRow, AuthenticatedApiCredential, AuthorizedWorkspace } from '@hybrid/db';

import type { AgentStore, RegisterAgentCommand } from '../../src/agents/store';

/**
 * In-memory `AgentStore` for route tests.
 *
 * Reproduces the semantics the production repository relies on: workspace-bound
 * reads, and an upsert keyed on `(workspace_id, external_id)` that preserves an
 * existing name when none is supplied.
 *
 * WHAT IT DOES NOT PROVE
 * ----------------------
 * It is single-threaded JavaScript. It cannot prove the UNIQUE constraint or
 * PostgreSQL's behaviour when two registrations race. That is what
 * `packages/db/tests/agents.live.test.ts` is for, and it is skipped without
 * `TEST_DATABASE_URL`.
 */

export interface MemoryAgentStore extends AgentStore {
  readonly agents: AgentRow[];
  /** Seeds an agent directly, bypassing registration. */
  seed(workspaceId: string, externalId: string, lastSeenAt?: Date | null): AgentRow;
}

export function createMemoryAgentStore(): MemoryAgentStore {
  const agents: AgentRow[] = [];

  function find(workspaceId: string, externalId: string): AgentRow | undefined {
    return agents.find((a) => a.workspaceId === workspaceId && a.externalId === externalId);
  }

  function makeRow(workspaceId: string, externalId: string, now: Date): AgentRow {
    return {
      id: randomUUID(),
      workspaceId,
      externalId,
      displayName: null,
      runtimeProfileId: null,
      lastSeenAt: now,
      createdAt: now,
      updatedAt: now,
    };
  }

  return {
    agents,

    seed(workspaceId: string, externalId: string, lastSeenAt: Date | null = null): AgentRow {
      const row = makeRow(workspaceId, externalId, new Date());
      row.lastSeenAt = lastSeenAt;
      agents.push(row);
      return row;
    },

    register(
      credential: AuthenticatedApiCredential,
      command: RegisterAgentCommand,
      now: Date,
    ): Promise<AgentRow> {
      // Workspace comes from the credential's scope, never from the command.
      const workspaceId = credential.scope.workspaceId;
      const existing = find(workspaceId, command.externalId);

      if (existing !== undefined) {
        // Mirrors ON CONFLICT DO UPDATE: last-seen always advances; the name is
        // only overwritten when one is supplied (COALESCE semantics).
        existing.lastSeenAt = now;
        existing.updatedAt = now;
        if (command.displayName !== undefined) {
          existing.displayName = command.displayName;
        }
        return Promise.resolve(existing);
      }

      const created = makeRow(workspaceId, command.externalId, now);
      created.displayName = command.displayName ?? null;
      agents.push(created);
      return Promise.resolve(created);
    },

    list(authorized: AuthorizedWorkspace): Promise<AgentRow[]> {
      // Scope-bound, ordered by last contact with never-seen agents last.
      return Promise.resolve(
        agents
          .filter((a) => a.workspaceId === authorized.scope.workspaceId)
          .sort((a, b) => (b.lastSeenAt?.getTime() ?? -1) - (a.lastSeenAt?.getTime() ?? -1)),
      );
    },

    findById(authorized: AuthorizedWorkspace, agentId: string): Promise<AgentRow | null> {
      return Promise.resolve(
        agents.find((a) => a.id === agentId && a.workspaceId === authorized.scope.workspaceId) ??
          null,
      );
    },
  };
}
