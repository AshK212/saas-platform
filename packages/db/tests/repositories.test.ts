import { describe, expect, it } from 'vitest';

import { createAgentRepository, type AgentRow } from '../src/repositories/agents';
import { createEventRepository } from '../src/repositories/events';
import type { DatabaseExecutor } from '../src/repositories/executor';
import { createRuntimeProfileRepository } from '../src/repositories/runtime-profiles';
import { createWorkspaceScope } from '../src/repositories/workspace-scope';

const WORKSPACE_A = '11111111-1111-4111-8111-111111111111';
const scopeA = createWorkspaceScope(WORKSPACE_A);

/**
 * A minimal executor stand-in that returns a fixed result set.
 *
 * It does NOT evaluate SQL, so it cannot prove isolation on its own - that is
 * what tenant-scoping.test.ts (real emitted SQL) and the live suite are for.
 * What it does prove is the repository's result mapping: specifically that an
 * empty result becomes `null` rather than `undefined` or a thrown error, which
 * is how "belongs to another workspace" is made indistinguishable from
 * "does not exist".
 */
function executorReturning(rows: unknown[]): DatabaseExecutor {
  const builder = {
    from: () => builder,
    where: () => builder,
    // `listAll` now orders by last-seen, so the fake must accept the call.
    orderBy: () => builder,
    limit: () => Promise.resolve(rows),
    then: (resolve: (value: unknown) => unknown) => Promise.resolve(rows).then(resolve),
  };
  return { select: () => builder } as unknown as DatabaseExecutor;
}

const AGENT_ROW = {
  id: '33333333-3333-4333-8333-333333333333',
  workspaceId: WORKSPACE_A,
  externalId: 'agent-1',
  displayName: null,
  runtimeProfileId: null,
  lastSeenAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
} as unknown as AgentRow;

describe('agent repository', () => {
  it('returns the row when it exists in scope', async () => {
    const repo = createAgentRepository(executorReturning([AGENT_ROW]), scopeA);

    await expect(repo.findById(AGENT_ROW.id)).resolves.toEqual(AGENT_ROW);
  });

  it('returns null - not undefined - when nothing matches', async () => {
    const repo = createAgentRepository(executorReturning([]), scopeA);

    await expect(repo.findById(AGENT_ROW.id)).resolves.toBeNull();
    await expect(repo.findByExternalId('agent-1')).resolves.toBeNull();
  });

  it('returns an empty list rather than throwing for an empty workspace', async () => {
    const repo = createAgentRepository(executorReturning([]), scopeA);

    await expect(repo.listAll()).resolves.toEqual([]);
  });
});

describe('event repository', () => {
  it('returns null when the client event id is absent from this workspace', async () => {
    const repo = createEventRepository(executorReturning([]), scopeA);

    await expect(repo.findByEventId('evt-123')).resolves.toBeNull();
  });
});

describe('runtime profile repository', () => {
  it('returns null when the profile is absent from this workspace', async () => {
    const repo = createRuntimeProfileRepository(executorReturning([]), scopeA);

    await expect(repo.findById(AGENT_ROW.id)).resolves.toBeNull();
    await expect(repo.findByName('default')).resolves.toBeNull();
  });
});

describe('cross-tenant error semantics', () => {
  it('reveals nothing about existence in another workspace', async () => {
    // A row that exists in workspace B produces an empty result under scope A.
    // The repository must render that identically to "no such row" - no
    // distinct error, no code, no message hinting the entity exists elsewhere.
    const repo = createAgentRepository(executorReturning([]), scopeA);

    const result = await repo.findById(AGENT_ROW.id);

    expect(result).toBeNull();
  });

  it('does not throw a distinguishable error for a wrong-workspace lookup', async () => {
    const repo = createEventRepository(executorReturning([]), scopeA);

    // Resolving to null (rather than rejecting) is what keeps the two cases
    // indistinguishable to any caller, including a future HTTP layer.
    await expect(repo.findByEventId('evt-belonging-to-b')).resolves.toBeNull();
  });
});
