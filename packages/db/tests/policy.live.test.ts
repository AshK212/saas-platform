import { eq, inArray } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { closeDatabasePool, createDatabaseClient, createDatabasePool } from '../src/client';
import { createWorkspaceWithOperator } from '../src/provisioning/workspaces';
import { createPolicyReadRepository } from '../src/repositories/policy';
import { createWorkspaceScope } from '../src/repositories/workspace-scope';
import type { DatabaseExecutor } from '../src/repositories/executor';
import { agents } from '../src/schema/agents';
import { users } from '../src/schema/identity';
import { agentPolicies, workspacePolicyState } from '../src/schema/policy';
import { workspaceMemberships, workspaces } from '../src/schema/workspaces';

/**
 * LIVE policy suite against real PostgreSQL (Step 12).
 *
 * SAFETY - READ BEFORE CHANGING THE GATE
 * --------------------------------------
 * This suite WRITES DATA. It is gated on `TEST_DATABASE_URL` and **never falls
 * back to `DATABASE_URL`**. Every write is rolled back; nothing is dropped or
 * truncated. The connection string is never logged.
 *
 * WHY IT EXISTS SEPARATELY
 * ------------------------
 * The in-memory policy store used by route tests builds its snapshot in
 * JavaScript. It cannot establish the claims this step actually rests on:
 *
 *   - that workspace creation really commits policy state atomically, and
 *     really rolls the whole thing back when one insert fails;
 *   - that the LEFT JOIN returns agents with no policy row at all;
 *   - that a `bigint` version survives the round trip exactly;
 *   - that `numeric(14,6)` returns an exact decimal string, not a float;
 *   - that the workspace predicate isolates tenants at runtime.
 */

const testDatabaseUrl = process.env['TEST_DATABASE_URL']?.trim();
const hasTestDatabase = testDatabaseUrl !== undefined && testDatabaseUrl !== '';

const WORKSPACE_A_NAME = 'live-policy-alpha';
const WORKSPACE_B_NAME = 'live-policy-bravo';
const ALL_NAMES = [WORKSPACE_A_NAME, WORKSPACE_B_NAME];
const USER_EMAIL = 'live-policy-owner@example.test';

class Rollback extends Error {}

let pool: ReturnType<typeof createDatabasePool> | undefined;

afterAll(async () => {
  if (pool !== undefined) {
    await closeDatabasePool(pool);
  }
});

describe.skipIf(!hasTestDatabase)('live policy reads', () => {
  function getDb(): ReturnType<typeof createDatabaseClient> {
    pool ??= createDatabasePool({
      connectionString: testDatabaseUrl as string,
      maxConnections: 4,
      applicationName: 'hybrid-policy-live-test',
    });
    return createDatabaseClient(pool);
  }

  async function seedWorkspace(
    tx: DatabaseExecutor,
    name: string,
  ): Promise<{ workspaceId: string }> {
    const [ws] = await tx.insert(workspaces).values({ name }).returning();
    const workspaceId = ws?.id ?? '';
    await tx.insert(workspacePolicyState).values({ workspaceId, version: 1 });
    return { workspaceId };
  }

  async function seedAgent(
    tx: DatabaseExecutor,
    workspaceId: string,
    externalId: string,
  ): Promise<string> {
    const [agent] = await tx.insert(agents).values({ workspaceId, externalId }).returning();
    return agent?.id ?? '';
  }

  it('PROVISIONING creates workspace, membership and policy state atomically', async () => {
    const db = getDb();
    // Only the workspace id is needed in `finally`; cleanup is by email.
    let workspaceId = '';

    try {
      const [user] = await db.insert(users).values({ email: USER_EMAIL }).returning();

      // The real provisioning function, committed - so the atomicity is
      // observed after COMMIT rather than inside a rolled-back transaction.
      const created = await createWorkspaceWithOperator(db, {
        name: WORKSPACE_A_NAME,
        creatorUserId: user?.id ?? '',
      });
      workspaceId = created.id;

      expect(created.role).toBe('operator');

      const state = await db
        .select()
        .from(workspacePolicyState)
        .where(eq(workspacePolicyState.workspaceId, workspaceId));

      expect(state).toHaveLength(1);
      // The floor the check constraint enforces, and the value a fresh
      // workspace must report to a polling agent.
      expect(state[0]?.version).toBe(1);

      const membership = await db
        .select()
        .from(workspaceMemberships)
        .where(eq(workspaceMemberships.workspaceId, workspaceId));
      expect(membership).toHaveLength(1);
    } finally {
      await db
        .delete(workspacePolicyState)
        .where(eq(workspacePolicyState.workspaceId, workspaceId));
      await db
        .delete(workspaceMemberships)
        .where(eq(workspaceMemberships.workspaceId, workspaceId));
      await db.delete(workspaces).where(inArray(workspaces.name, ALL_NAMES));
      await db.delete(users).where(eq(users.email, USER_EMAIL));
    }
  });

  it('ROLLBACK: a failed membership leaves no workspace and no policy state', async () => {
    const db = getDb();

    try {
      // A creator user id that does not exist violates the membership foreign
      // key, failing the second insert of three.
      await expect(
        createWorkspaceWithOperator(db, {
          name: WORKSPACE_A_NAME,
          creatorUserId: '11111111-1111-4111-8111-111111111111',
        }),
      ).rejects.toThrow();

      const remaining = await db
        .select()
        .from(workspaces)
        .where(inArray(workspaces.name, ALL_NAMES));

      // No orphaned workspace, and therefore no orphaned policy state.
      expect(remaining).toEqual([]);
    } finally {
      await db.delete(workspaces).where(inArray(workspaces.name, ALL_NAMES));
    }
  });

  it('the version check constraint refuses 0', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const [ws] = await tx.insert(workspaces).values({ name: WORKSPACE_A_NAME }).returning();

        // Version 0 would be indistinguishable from "no state" to a client.
        await expect(
          tx
            .insert(workspacePolicyState)
            .values({ workspaceId: ws?.id ?? '', version: 0 }),
        ).rejects.toThrow();

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('one policy state row per workspace is enforced', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const { workspaceId } = await seedWorkspace(tx, WORKSPACE_A_NAME);

        // workspace_id is the primary key: a second row is impossible, so a
        // workspace can never have two competing versions.
        await expect(
          tx.insert(workspacePolicyState).values({ workspaceId, version: 2 }),
        ).rejects.toThrow();

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('reads the version as an exact string', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const { workspaceId } = await seedWorkspace(tx, WORKSPACE_A_NAME);

        const version = await createPolicyReadRepository(
          tx,
          createWorkspaceScope(workspaceId),
        ).findVersion();

        expect(version).toBe('1');
        expect(typeof version).toBe('string');

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('BIGINT: a version beyond Number.MAX_SAFE_INTEGER round-trips exactly', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const [ws] = await tx.insert(workspaces).values({ name: WORKSPACE_A_NAME }).returning();
        const workspaceId = ws?.id ?? '';
        // 2^53 + 1. As a JS number this is indistinguishable from 2^53.
        await tx.execute(
          `insert into workspace_policy_state (workspace_id, version) values ('${workspaceId}', 9007199254740993)`,
        );

        const version = await createPolicyReadRepository(
          tx,
          createWorkspaceScope(workspaceId),
        ).findVersion();

        // The whole reason the column is cast to text before it reaches JS.
        expect(version).toBe('9007199254740993');

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('a missing policy state reads as null, never as 0', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        // A workspace deliberately created WITHOUT policy state, which the
        // real provisioning path cannot produce.
        const [ws] = await tx.insert(workspaces).values({ name: WORKSPACE_A_NAME }).returning();

        const version = await createPolicyReadRepository(
          tx,
          createWorkspaceScope(ws?.id ?? ''),
        ).findVersion();

        // null is the signal for an invariant violation. Returning 0 would let
        // the API report a fake policy version to a polling agent.
        expect(version).toBeNull();

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('LEFT JOIN: an agent with no policy row is still returned', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const { workspaceId } = await seedWorkspace(tx, WORKSPACE_A_NAME);
        await seedAgent(tx, workspaceId, 'agent-a');

        const rows = await createPolicyReadRepository(
          tx,
          createWorkspaceScope(workspaceId),
        ).listEffectivePolicies();

        // The failure mode this step exists to prevent: an agent created by
        // registration or event discovery must not vanish from the snapshot.
        expect(rows).toHaveLength(1);
        expect(rows[0]?.externalId).toBe('agent-a');
        expect(rows[0]?.mode).toBeNull();
        expect(rows[0]?.hasExplicitPolicy).toBe(false);
        expect(rows[0]?.dailySpendCapUsd).toBeNull();
        expect(rows[0]?.dailyPublishCap).toBeNull();

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('reads an explicit policy with an EXACT decimal cap', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const { workspaceId } = await seedWorkspace(tx, WORKSPACE_A_NAME);
        const agentId = await seedAgent(tx, workspaceId, 'agent-a');
        await tx.insert(agentPolicies).values({
          workspaceId,
          agentId,
          mode: 'budgeted',
          dailySpendCapUsd: '25.000000',
          dailyPublishCap: 5,
        });

        const rows = await createPolicyReadRepository(
          tx,
          createWorkspaceScope(workspaceId),
        ).listEffectivePolicies();

        expect(rows[0]?.mode).toBe('budgeted');
        // A STRING straight from numeric(14,6) - never through a JS float.
        expect(rows[0]?.dailySpendCapUsd).toBe('25.000000');
        expect(typeof rows[0]?.dailySpendCapUsd).toBe('string');
        expect(rows[0]?.dailyPublishCap).toBe(5);
        expect(rows[0]?.hasExplicitPolicy).toBe(true);

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('distinguishes a ZERO cap from an absent one', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const { workspaceId } = await seedWorkspace(tx, WORKSPACE_A_NAME);
        const capped = await seedAgent(tx, workspaceId, 'agent-zero');
        const uncapped = await seedAgent(tx, workspaceId, 'agent-null');
        await tx.insert(agentPolicies).values({
          workspaceId,
          agentId: capped,
          mode: 'budgeted',
          dailySpendCapUsd: '0.000000',
          dailyPublishCap: 0,
        });
        await tx.insert(agentPolicies).values({
          workspaceId,
          agentId: uncapped,
          mode: 'budgeted',
        });

        const rows = await createPolicyReadRepository(
          tx,
          createWorkspaceScope(workspaceId),
        ).listEffectivePolicies();
        const byId = new Map(rows.map((r) => [r.externalId, r]));

        // 0 = nothing permitted. null = no limit. Collapsing them would either
        // silently pause an agent or silently uncap one.
        expect(byId.get('agent-zero')?.dailySpendCapUsd).toBe('0.000000');
        expect(byId.get('agent-zero')?.dailyPublishCap).toBe(0);
        expect(byId.get('agent-null')?.dailySpendCapUsd).toBeNull();
        expect(byId.get('agent-null')?.dailyPublishCap).toBeNull();

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('returns a mix of explicit and defaulted agents, ordered stably', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const { workspaceId } = await seedWorkspace(tx, WORKSPACE_A_NAME);
        await seedAgent(tx, workspaceId, 'zeta');
        const alpha = await seedAgent(tx, workspaceId, 'alpha');
        await seedAgent(tx, workspaceId, 'mike');
        await tx
          .insert(agentPolicies)
          .values({ workspaceId, agentId: alpha, mode: 'paused' });

        const repo = createPolicyReadRepository(tx, createWorkspaceScope(workspaceId));
        const first = await repo.listEffectivePolicies();
        const second = await repo.listEffectivePolicies();

        expect(first.map((r) => r.externalId)).toEqual(['alpha', 'mike', 'zeta']);
        expect(second.map((r) => r.externalId)).toEqual(first.map((r) => r.externalId));
        // paused is reported truthfully; nothing enforces it here.
        expect(first[0]?.mode).toBe('paused');
        expect(first[1]?.mode).toBeNull();

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('CROSS-TENANT: a shared external agent id carries independent policy', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const a = await seedWorkspace(tx, WORKSPACE_A_NAME);
        const b = await seedWorkspace(tx, WORKSPACE_B_NAME);
        const aAgent = await seedAgent(tx, a.workspaceId, 'agent-1');
        const bAgent = await seedAgent(tx, b.workspaceId, 'agent-1');

        await tx
          .insert(agentPolicies)
          .values({ workspaceId: a.workspaceId, agentId: aAgent, mode: 'paused' });
        await tx.insert(agentPolicies).values({
          workspaceId: b.workspaceId,
          agentId: bAgent,
          mode: 'budgeted',
          dailySpendCapUsd: '99.000000',
        });

        const aRows = await createPolicyReadRepository(
          tx,
          createWorkspaceScope(a.workspaceId),
        ).listEffectivePolicies();
        const bRows = await createPolicyReadRepository(
          tx,
          createWorkspaceScope(b.workspaceId),
        ).listEffectivePolicies();

        // Same client-supplied name, entirely separate governance.
        expect(aRows).toHaveLength(1);
        expect(bRows).toHaveLength(1);
        expect(aRows[0]?.mode).toBe('paused');
        expect(aRows[0]?.dailySpendCapUsd).toBeNull();
        expect(bRows[0]?.mode).toBe('budgeted');
        expect(bRows[0]?.dailySpendCapUsd).toBe('99.000000');

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('CROSS-TENANT: versions are independent', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const a = await seedWorkspace(tx, WORKSPACE_A_NAME);
        const [wsB] = await tx.insert(workspaces).values({ name: WORKSPACE_B_NAME }).returning();
        await tx
          .insert(workspacePolicyState)
          .values({ workspaceId: wsB?.id ?? '', version: 42 });

        const aVersion = await createPolicyReadRepository(
          tx,
          createWorkspaceScope(a.workspaceId),
        ).findVersion();
        const bVersion = await createPolicyReadRepository(
          tx,
          createWorkspaceScope(wsB?.id ?? ''),
        ).findVersion();

        expect(aVersion).toBe('1');
        expect(bVersion).toBe('42');

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('CROSS-TENANT: a policy row cannot attach to another workspace agent', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const a = await seedWorkspace(tx, WORKSPACE_A_NAME);
        const b = await seedWorkspace(tx, WORKSPACE_B_NAME);
        const bAgent = await seedAgent(tx, b.workspaceId, 'agent-b');

        // The composite FK to (workspace_id, id) makes this impossible at the
        // database level, not merely in application code.
        await expect(
          tx
            .insert(agentPolicies)
            .values({ workspaceId: a.workspaceId, agentId: bAgent, mode: 'paused' }),
        ).rejects.toThrow();

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('a workspace with zero agents yields a version and an empty list', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const { workspaceId } = await seedWorkspace(tx, WORKSPACE_A_NAME);
        const repo = createPolicyReadRepository(tx, createWorkspaceScope(workspaceId));

        // Valid, not empty: version present, no agent fabricated.
        expect(await repo.findVersion()).toBe('1');
        expect(await repo.listEffectivePolicies()).toEqual([]);

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('leaves no residue', async () => {
    const db = getDb();

    const remainingWorkspaces = await db
      .select()
      .from(workspaces)
      .where(inArray(workspaces.name, ALL_NAMES));
    const remainingUsers = await db.select().from(users).where(eq(users.email, USER_EMAIL));

    expect(remainingWorkspaces).toEqual([]);
    expect(remainingUsers).toEqual([]);
  });
});
