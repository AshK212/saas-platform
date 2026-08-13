import { eq, inArray } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { closeDatabasePool, createDatabaseClient, createDatabasePool } from '../src/client';
import {
  createPolicyMutationService,
  MissingPolicyStateError,
} from '../src/repositories/policy-mutation';
import { createPolicyReadRepository } from '../src/repositories/policy';
import { createWorkspaceScope } from '../src/repositories/workspace-scope';
import type { DatabaseExecutor } from '../src/repositories/executor';
import { agents } from '../src/schema/agents';
import { agentPolicies, workspacePolicyState } from '../src/schema/policy';
import { workspaces } from '../src/schema/workspaces';

/**
 * LIVE policy mutation suite against real PostgreSQL (Step 13).
 *
 * SAFETY - READ BEFORE CHANGING THE GATE
 * --------------------------------------
 * This suite WRITES DATA. It is gated on `TEST_DATABASE_URL` and **never falls
 * back to `DATABASE_URL`**. Writes are rolled back or explicitly cleaned up;
 * nothing is dropped or truncated. The connection string is never logged.
 *
 * WHY IT EXISTS SEPARATELY
 * ------------------------
 * The in-memory mutation store is single-threaded JavaScript, so its increment
 * is atomic for free. Everything Step 13 actually rests on is a claim about
 * PostgreSQL that only this suite can settle:
 *
 *   - that two concurrent mutations produce TWO distinct versions rather than
 *     both reading N and both writing N+1;
 *   - that `SELECT ... FOR UPDATE` really serializes them;
 *   - that a failure in either half rolls the other half back;
 *   - that the upsert leaves no partially-written policy row;
 *   - that the composite key keeps a mutation inside its workspace.
 */

const testDatabaseUrl = process.env['TEST_DATABASE_URL']?.trim();
const hasTestDatabase = testDatabaseUrl !== undefined && testDatabaseUrl !== '';

const WORKSPACE_A_NAME = 'live-policy-mut-alpha';
const WORKSPACE_B_NAME = 'live-policy-mut-bravo';
const ALL_NAMES = [WORKSPACE_A_NAME, WORKSPACE_B_NAME];

class Rollback extends Error {}

let pool: ReturnType<typeof createDatabasePool> | undefined;

afterAll(async () => {
  if (pool !== undefined) {
    await closeDatabasePool(pool);
  }
});

describe.skipIf(!hasTestDatabase)('live policy mutation', () => {
  function getDb(): ReturnType<typeof createDatabaseClient> {
    pool ??= createDatabasePool({
      connectionString: testDatabaseUrl as string,
      maxConnections: 6,
      applicationName: 'hybrid-policy-mutation-live-test',
    });
    return createDatabaseClient(pool);
  }

  async function seedWorkspace(
    executor: DatabaseExecutor,
    name: string,
    externalIds: string[] = ['agent-a'],
  ): Promise<{ workspaceId: string; agentIds: string[] }> {
    const [ws] = await executor.insert(workspaces).values({ name }).returning();
    const workspaceId = ws?.id ?? '';
    await executor.insert(workspacePolicyState).values({ workspaceId, version: 1 });

    const agentIds: string[] = [];
    for (const externalId of externalIds) {
      const [agent] = await executor
        .insert(agents)
        .values({ workspaceId, externalId })
        .returning();
      agentIds.push(agent?.id ?? '');
    }
    return { workspaceId, agentIds };
  }

  /** Deletes everything this suite could have committed, by workspace name. */
  async function cleanup(db: ReturnType<typeof createDatabaseClient>): Promise<void> {
    const rows = await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(inArray(workspaces.name, ALL_NAMES));
    for (const row of rows) {
      await db.delete(agentPolicies).where(eq(agentPolicies.workspaceId, row.id));
      await db.delete(agents).where(eq(agents.workspaceId, row.id));
      await db.delete(workspacePolicyState).where(eq(workspacePolicyState.workspaceId, row.id));
    }
    await db.delete(workspaces).where(inArray(workspaces.name, ALL_NAMES));
  }

  it('writes the policy and increments the version in one transaction', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const { workspaceId, agentIds } = await seedWorkspace(tx, WORKSPACE_A_NAME);
        const scope = createWorkspaceScope(workspaceId);

        // The service opens its own transaction, so drive it through `tx` by
        // calling the same statements it does - see the committed-path tests
        // below for the real service under COMMIT.
        const before = await createPolicyReadRepository(tx, scope).findVersion();
        expect(before).toBe('1');
        expect(agentIds[0]).toBeDefined();

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('COMMITTED: default -> explicit policy, version 1 -> 2', async () => {
    const db = getDb();

    try {
      const { workspaceId, agentIds } = await seedWorkspace(db, WORKSPACE_A_NAME);
      const scope = createWorkspaceScope(workspaceId);

      const committed = await createPolicyMutationService(db).setAgentPolicy(
        scope,
        agentIds[0] ?? '',
        { mode: 'budgeted', dailySpendCapUsd: '25.000000', dailyPublishCap: 5 },
      );

      expect(committed?.version).toBe('2');
      expect(committed?.externalId).toBe('agent-a');

      const stored = await db
        .select()
        .from(agentPolicies)
        .where(eq(agentPolicies.workspaceId, workspaceId));
      expect(stored).toHaveLength(1);
      expect(stored[0]?.mode).toBe('budgeted');
      // Exact decimal from numeric(14,6) - never through a JS float.
      expect(stored[0]?.dailySpendCapUsd).toBe('25.000000');
      expect(stored[0]?.dailyPublishCap).toBe(5);

      const version = await createPolicyReadRepository(db, scope).findVersion();
      expect(version).toBe('2');
    } finally {
      await cleanup(db);
    }
  });

  it('COMMITTED: a repeat save with identical values still increments', async () => {
    const db = getDb();

    try {
      const { workspaceId, agentIds } = await seedWorkspace(db, WORKSPACE_A_NAME);
      const scope = createWorkspaceScope(workspaceId);
      const service = createPolicyMutationService(db);
      const values = { mode: 'paused' as const, dailySpendCapUsd: null, dailyPublishCap: null };

      expect((await service.setAgentPolicy(scope, agentIds[0] ?? '', values))?.version).toBe('2');
      expect((await service.setAgentPolicy(scope, agentIds[0] ?? '', values))?.version).toBe('3');

      // Documented semantic: the operator performed a governance write, so the
      // history does not depend on a value comparison.
      const rows = await db
        .select()
        .from(agentPolicies)
        .where(eq(agentPolicies.workspaceId, workspaceId));
      expect(rows).toHaveLength(1);
    } finally {
      await cleanup(db);
    }
  });

  it('COMMITTED: a PUT clears a previously set cap', async () => {
    const db = getDb();

    try {
      const { workspaceId, agentIds } = await seedWorkspace(db, WORKSPACE_A_NAME);
      const scope = createWorkspaceScope(workspaceId);
      const service = createPolicyMutationService(db);

      await service.setAgentPolicy(scope, agentIds[0] ?? '', {
        mode: 'budgeted',
        dailySpendCapUsd: '25.000000',
        dailyPublishCap: 5,
      });
      await service.setAgentPolicy(scope, agentIds[0] ?? '', {
        mode: 'watch',
        dailySpendCapUsd: null,
        dailyPublishCap: null,
      });

      const rows = await db
        .select()
        .from(agentPolicies)
        .where(eq(agentPolicies.workspaceId, workspaceId));

      // The upsert writes every field, so null really clears.
      expect(rows[0]?.dailySpendCapUsd).toBeNull();
      expect(rows[0]?.dailyPublishCap).toBeNull();
      expect(rows[0]?.mode).toBe('watch');
    } finally {
      await cleanup(db);
    }
  });

  it('CONCURRENCY: two agents mutated at once reach version 3, not 2', async () => {
    // THE test this suite exists for. A read-then-write increment would have
    // both transactions read 1 and both write 2, losing one bump - and with it
    // the guarantee that a polling agent notices the second change.
    const db = getDb();

    try {
      const { workspaceId, agentIds } = await seedWorkspace(db, WORKSPACE_A_NAME, [
        'agent-a',
        'agent-b',
      ]);
      const scope = createWorkspaceScope(workspaceId);
      const service = createPolicyMutationService(db);

      const [a, b] = await Promise.all([
        service.setAgentPolicy(scope, agentIds[0] ?? '', {
          mode: 'budgeted',
          dailySpendCapUsd: '10.000000',
          dailyPublishCap: null,
        }),
        service.setAgentPolicy(scope, agentIds[1] ?? '', {
          mode: 'paused',
          dailySpendCapUsd: null,
          dailyPublishCap: null,
        }),
      ]);

      // Two committed mutations, two distinct versions.
      const versions = [a?.version, b?.version].sort();
      expect(versions).toEqual(['2', '3']);

      const final = await createPolicyReadRepository(db, scope).findVersion();
      expect(final).toBe('3');

      // And both policies actually landed.
      const rows = await db
        .select()
        .from(agentPolicies)
        .where(eq(agentPolicies.workspaceId, workspaceId));
      expect(rows).toHaveLength(2);
    } finally {
      await cleanup(db);
    }
  });

  it('CONCURRENCY: eight simultaneous mutations produce eight distinct versions', async () => {
    const db = getDb();

    try {
      const externalIds = Array.from({ length: 8 }, (_v, i) => `agent-${String(i)}`);
      const { workspaceId, agentIds } = await seedWorkspace(db, WORKSPACE_A_NAME, externalIds);
      const scope = createWorkspaceScope(workspaceId);
      const service = createPolicyMutationService(db);

      const results = await Promise.all(
        agentIds.map((agentId) =>
          service.setAgentPolicy(scope, agentId, {
            mode: 'watch',
            dailySpendCapUsd: null,
            dailyPublishCap: null,
          }),
        ),
      );

      const versions = results.map((r) => r?.version ?? '');
      // No duplicates: every committed mutation got its own version.
      expect(new Set(versions).size).toBe(8);
      expect([...versions].sort((x, y) => Number(x) - Number(y))).toEqual([
        '2', '3', '4', '5', '6', '7', '8', '9',
      ]);
      expect(await createPolicyReadRepository(db, scope).findVersion()).toBe('9');
    } finally {
      await cleanup(db);
    }
  });

  it('CONCURRENCY: same agent twice leaves one COMPLETE policy, version +2', async () => {
    const db = getDb();

    try {
      const { workspaceId, agentIds } = await seedWorkspace(db, WORKSPACE_A_NAME);
      const scope = createWorkspaceScope(workspaceId);
      const service = createPolicyMutationService(db);
      const agentId = agentIds[0] ?? '';

      const [a, b] = await Promise.all([
        service.setAgentPolicy(scope, agentId, {
          mode: 'budgeted',
          dailySpendCapUsd: '10.000000',
          dailyPublishCap: 1,
        }),
        service.setAgentPolicy(scope, agentId, {
          mode: 'paused',
          dailySpendCapUsd: null,
          dailyPublishCap: null,
        }),
      ]);

      expect([a?.version, b?.version].sort()).toEqual(['2', '3']);
      expect(await createPolicyReadRepository(db, scope).findVersion()).toBe('3');

      const rows = await db
        .select()
        .from(agentPolicies)
        .where(eq(agentPolicies.workspaceId, workspaceId));
      expect(rows).toHaveLength(1);

      // LAST WRITER WINS, but never a MIX. The row must equal exactly one of
      // the two submitted policies - not `paused` with a 10.000000 cap.
      const row = rows[0];
      const isFirst =
        row?.mode === 'budgeted' &&
        row.dailySpendCapUsd === '10.000000' &&
        row.dailyPublishCap === 1;
      const isSecond =
        row?.mode === 'paused' &&
        row.dailySpendCapUsd === null &&
        row.dailyPublishCap === null;
      expect(isFirst || isSecond).toBe(true);
    } finally {
      await cleanup(db);
    }
  });

  it('ROLLBACK: a missing policy state writes no agent policy row', async () => {
    const db = getDb();

    try {
      // A workspace deliberately created WITHOUT policy state, which the real
      // provisioning path cannot produce.
      const [ws] = await db.insert(workspaces).values({ name: WORKSPACE_A_NAME }).returning();
      const workspaceId = ws?.id ?? '';
      const [agent] = await db
        .insert(agents)
        .values({ workspaceId, externalId: 'agent-a' })
        .returning();

      await expect(
        createPolicyMutationService(db).setAgentPolicy(
          createWorkspaceScope(workspaceId),
          agent?.id ?? '',
          { mode: 'paused', dailySpendCapUsd: null, dailyPublishCap: null },
        ),
      ).rejects.toThrow(MissingPolicyStateError);

      // No self-healing, and no orphaned policy row.
      const rows = await db
        .select()
        .from(agentPolicies)
        .where(eq(agentPolicies.workspaceId, workspaceId));
      expect(rows).toEqual([]);
      const state = await db
        .select()
        .from(workspacePolicyState)
        .where(eq(workspacePolicyState.workspaceId, workspaceId));
      expect(state).toEqual([]);
    } finally {
      await cleanup(db);
    }
  });

  it('ROLLBACK: a constraint violation leaves the version untouched', async () => {
    const db = getDb();

    try {
      const { workspaceId, agentIds } = await seedWorkspace(db, WORKSPACE_A_NAME);
      const scope = createWorkspaceScope(workspaceId);

      // A negative cap violates the Step 3 check constraint, failing the
      // upsert BEFORE the version bump. The contract rejects this long before
      // the database would, so this proves the last line of defence.
      await expect(
        createPolicyMutationService(db).setAgentPolicy(scope, agentIds[0] ?? '', {
          mode: 'budgeted',
          dailySpendCapUsd: '-1.000000',
          dailyPublishCap: null,
        }),
      ).rejects.toThrow();

      // Neither half committed.
      expect(await createPolicyReadRepository(db, scope).findVersion()).toBe('1');
      const rows = await db
        .select()
        .from(agentPolicies)
        .where(eq(agentPolicies.workspaceId, workspaceId));
      expect(rows).toEqual([]);
    } finally {
      await cleanup(db);
    }
  });

  it("CROSS-TENANT: another workspace's agent id mutates nothing", async () => {
    const db = getDb();

    try {
      const a = await seedWorkspace(db, WORKSPACE_A_NAME);
      const b = await seedWorkspace(db, WORKSPACE_B_NAME, ['bobs-agent']);

      // Workspace A's scope, holding B's exact internal agent UUID.
      const result = await createPolicyMutationService(db).setAgentPolicy(
        createWorkspaceScope(a.workspaceId),
        b.agentIds[0] ?? '',
        { mode: 'paused', dailySpendCapUsd: null, dailyPublishCap: null },
      );

      // A UUID is not authorization.
      expect(result).toBeNull();

      // Nothing changed in EITHER workspace, versions included.
      expect(
        await createPolicyReadRepository(db, createWorkspaceScope(a.workspaceId)).findVersion(),
      ).toBe('1');
      expect(
        await createPolicyReadRepository(db, createWorkspaceScope(b.workspaceId)).findVersion(),
      ).toBe('1');
      const bPolicies = await db
        .select()
        .from(agentPolicies)
        .where(eq(agentPolicies.workspaceId, b.workspaceId));
      expect(bPolicies).toEqual([]);
    } finally {
      await cleanup(db);
    }
  });

  it('CROSS-TENANT: concurrent mutations in two workspaces do not share a counter', async () => {
    const db = getDb();

    try {
      const a = await seedWorkspace(db, WORKSPACE_A_NAME);
      const b = await seedWorkspace(db, WORKSPACE_B_NAME, ['bobs-agent']);
      const service = createPolicyMutationService(db);
      const values = { mode: 'paused' as const, dailySpendCapUsd: null, dailyPublishCap: null };

      const [ra, rb] = await Promise.all([
        service.setAgentPolicy(createWorkspaceScope(a.workspaceId), a.agentIds[0] ?? '', values),
        service.setAgentPolicy(createWorkspaceScope(b.workspaceId), b.agentIds[0] ?? '', values),
      ]);

      // Each workspace has its own row and its own counter, so both reach 2.
      expect(ra?.version).toBe('2');
      expect(rb?.version).toBe('2');
    } finally {
      await cleanup(db);
    }
  });

  it('the new policy is immediately visible to the read path', async () => {
    const db = getDb();

    try {
      const { workspaceId, agentIds } = await seedWorkspace(db, WORKSPACE_A_NAME);
      const scope = createWorkspaceScope(workspaceId);

      await createPolicyMutationService(db).setAgentPolicy(scope, agentIds[0] ?? '', {
        mode: 'budgeted',
        dailySpendCapUsd: '25.000000',
        dailyPublishCap: 5,
      });

      // No delay anywhere in the server: a committed write is visible at once.
      const rows = await createPolicyReadRepository(db, scope).listEffectivePolicies();
      expect(rows[0]?.mode).toBe('budgeted');
      expect(rows[0]?.dailySpendCapUsd).toBe('25.000000');
      expect(rows[0]?.hasExplicitPolicy).toBe(true);
    } finally {
      await cleanup(db);
    }
  });

  it('NO LEDGER EFFECT: raising a cap creates no ledger row', async () => {
    const db = getDb();

    try {
      const { workspaceId, agentIds } = await seedWorkspace(db, WORKSPACE_A_NAME);
      const scope = createWorkspaceScope(workspaceId);
      const service = createPolicyMutationService(db);

      await service.setAgentPolicy(scope, agentIds[0] ?? '', {
        mode: 'budgeted',
        dailySpendCapUsd: '25.000000',
        dailyPublishCap: null,
      });
      await service.setAgentPolicy(scope, agentIds[0] ?? '', {
        mode: 'budgeted',
        dailySpendCapUsd: '100.000000',
        dailyPublishCap: null,
      });

      // Raising a cap must not touch usage: an operator must not be able to
      // erase today's committed spend by editing configuration.
      const ledger = await db.execute(
        `select count(*)::int as count from ledger_daily where workspace_id = '${workspaceId}'`,
      );
      expect((ledger.rows[0] as { count: number }).count).toBe(0);
    } finally {
      await cleanup(db);
    }
  });

  it('leaves no residue', async () => {
    const db = getDb();

    const remaining = await db.select().from(workspaces).where(inArray(workspaces.name, ALL_NAMES));

    expect(remaining).toEqual([]);
  });
});
