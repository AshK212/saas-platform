import { eq, inArray } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { LedgerCapacityError } from '../src/accounting/money';
import { toUtcAccountingDay } from '../src/accounting/utc-day';
import { closeDatabasePool, createDatabaseClient, createDatabasePool } from '../src/client';
import { createLedgerRepository, type LockedDailyLedger } from '../src/repositories/ledger';
import { createWorkspaceScope } from '../src/repositories/workspace-scope';
import type { DatabaseExecutor } from '../src/repositories/executor';
import { agents } from '../src/schema/agents';
import { ledgerDaily } from '../src/schema/ledger';
import { workspaces } from '../src/schema/workspaces';

/**
 * LIVE ledger suite against real PostgreSQL (Step 14).
 *
 * SAFETY - READ BEFORE CHANGING THE GATE
 * --------------------------------------
 * This suite WRITES DATA. It is gated on `TEST_DATABASE_URL` and **never falls
 * back to `DATABASE_URL`**. Writes are rolled back or explicitly cleaned up;
 * nothing is dropped or truncated. The connection string is never logged.
 *
 * WHY IT EXISTS SEPARATELY
 * ------------------------
 * Everything Step 14 exists to guarantee is a claim about PostgreSQL that
 * JavaScript cannot establish:
 *
 *   - that `SELECT ... FOR UPDATE` actually makes a second transaction WAIT,
 *     which is the entire basis of later cap enforcement;
 *   - that two serialized callers cannot both act from the same stale state;
 *   - that two concurrent first-actions of a day produce exactly one row;
 *   - that locks on different agents or different days do not block each other,
 *     so one busy agent cannot stall the fleet;
 *   - that `numeric(14,6)` round-trips an exact decimal;
 *   - that the composite FK refuses a cross-tenant agent.
 */

const testDatabaseUrl = process.env['TEST_DATABASE_URL']?.trim();
const hasTestDatabase = testDatabaseUrl !== undefined && testDatabaseUrl !== '';

const WORKSPACE_A_NAME = 'live-ledger-alpha';
const WORKSPACE_B_NAME = 'live-ledger-bravo';
const ALL_NAMES = [WORKSPACE_A_NAME, WORKSPACE_B_NAME];

const DAY = toUtcAccountingDay(new Date('2026-08-13T09:00:00.000Z'));
const NEXT_DAY = toUtcAccountingDay(new Date('2026-08-14T09:00:00.000Z'));

class Rollback extends Error {}

let pool: ReturnType<typeof createDatabasePool> | undefined;

afterAll(async () => {
  if (pool !== undefined) {
    await closeDatabasePool(pool);
  }
});

describe.skipIf(!hasTestDatabase)('live authoritative ledger', () => {
  function getDb(): ReturnType<typeof createDatabaseClient> {
    pool ??= createDatabasePool({
      connectionString: testDatabaseUrl as string,
      maxConnections: 6,
      applicationName: 'hybrid-ledger-live-test',
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

  /** Acquires the lock and fails loudly rather than silently skipping work. */
  async function lockOrFail(
    executor: DatabaseExecutor,
    workspaceId: string,
    agentId: string,
    day: typeof DAY,
  ): Promise<LockedDailyLedger> {
    const locked = await createLedgerRepository(
      executor,
      createWorkspaceScope(workspaceId),
    ).lockDailyLedger(agentId, day);
    if (locked === null) {
      throw new Error('expected the lock to be granted');
    }
    return locked;
  }

  /** Deletes everything this suite could have committed, by workspace name. */
  async function cleanup(db: ReturnType<typeof createDatabaseClient>): Promise<void> {
    const rows = await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(inArray(workspaces.name, ALL_NAMES));
    for (const row of rows) {
      await db.delete(ledgerDaily).where(eq(ledgerDaily.workspaceId, row.id));
      await db.delete(agents).where(eq(agents.workspaceId, row.id));
    }
    await db.delete(workspaces).where(inArray(workspaces.name, ALL_NAMES));
  }

  it('creates a day row initialised to zero', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const { workspaceId, agentIds } = await seedWorkspace(tx, WORKSPACE_A_NAME);
        const repo = createLedgerRepository(tx, createWorkspaceScope(workspaceId));

        // No activity yet: a read reports absence, not zero-by-invention.
        expect(await repo.findDailyLedger(agentIds[0] ?? '', DAY)).toBeNull();

        const locked = await lockOrFail(tx, workspaceId, agentIds[0] ?? '', DAY);

        expect(locked.current.spendCommittedUsd).toBe('0.000000');
        expect(locked.current.publishCountCommitted).toBe(0);
        expect(locked.current.day).toBe(DAY);

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('normalises the stored decimal to six fractional digits', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const { workspaceId, agentIds } = await seedWorkspace(tx, WORKSPACE_A_NAME);
        await lockOrFail(tx, workspaceId, agentIds[0] ?? '', DAY);

        // The column default is '0'; PostgreSQL may render it several ways.
        // Everything crossing the repository boundary is canonical.
        const row = await createLedgerRepository(
          tx,
          createWorkspaceScope(workspaceId),
        ).findDailyLedger(agentIds[0] ?? '', DAY);
        expect(row?.spendCommittedUsd).toBe('0.000000');
        expect(typeof row?.spendCommittedUsd).toBe('string');

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('commits spend with EXACT decimal arithmetic', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const { workspaceId, agentIds } = await seedWorkspace(tx, WORKSPACE_A_NAME);
        const locked = await lockOrFail(tx, workspaceId, agentIds[0] ?? '', DAY);

        // The float-drift case, through real numeric(14,6).
        for (const amount of ['10.100000', '10.200000', '4.700000']) {
          await locked.commitSpend(amount);
        }
        expect(locked.current.spendCommittedUsd).toBe('25.000000');

        // And a single micro-dollar on top.
        const after = await locked.commitSpend('0.000001');
        expect(after.spendCommittedUsd).toBe('25.000001');

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('CURRENT reflects each mutation without an unlocked re-read', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const { workspaceId, agentIds } = await seedWorkspace(tx, WORKSPACE_A_NAME);
        const locked = await lockOrFail(tx, workspaceId, agentIds[0] ?? '', DAY);

        // The shape Step 15 needs: decide against `current`, commit, then
        // record the new `current` as receipt evidence.
        expect(locked.current.spendCommittedUsd).toBe('0.000000');
        await locked.commitSpend('20.000000');
        expect(locked.current.spendCommittedUsd).toBe('20.000000');
        const returned = await locked.commitSpend('4.000000');
        expect(returned.spendCommittedUsd).toBe('24.000000');
        expect(locked.current.spendCommittedUsd).toBe('24.000000');

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('commits publishes by exactly one', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const { workspaceId, agentIds } = await seedWorkspace(tx, WORKSPACE_A_NAME);
        const locked = await lockOrFail(tx, workspaceId, agentIds[0] ?? '', DAY);

        for (let i = 0; i < 6; i += 1) {
          await locked.commitPublish();
        }

        expect(locked.current.publishCountCommitted).toBe(6);

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('SPEND AND PUBLISH ARE INDEPENDENT', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const { workspaceId, agentIds } = await seedWorkspace(tx, WORKSPACE_A_NAME);
        const locked = await lockOrFail(tx, workspaceId, agentIds[0] ?? '', DAY);

        await locked.commitSpend('25.000000');
        // A spend must not touch the publish counter.
        expect(locked.current.publishCountCommitted).toBe(0);

        await locked.commitPublish();
        // And a publish must not touch committed spend.
        expect(locked.current.spendCommittedUsd).toBe('25.000000');
        expect(locked.current.publishCountCommitted).toBe(1);

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('refuses to exceed numeric(14,6) capacity', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const { workspaceId, agentIds } = await seedWorkspace(tx, WORKSPACE_A_NAME);
        const locked = await lockOrFail(tx, workspaceId, agentIds[0] ?? '', DAY);

        await locked.commitSpend('99999999.999999');
        expect(locked.current.spendCommittedUsd).toBe('99999999.999999');

        // Neither wrapped nor silently truncated - a typed error before the
        // write, with the column precision as defense in depth.
        await expect(locked.commitSpend('0.000001')).rejects.toThrow(LedgerCapacityError);
        expect(locked.current.spendCommittedUsd).toBe('99999999.999999');

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('CONCURRENCY: two first-actions of a day create exactly one row', async () => {
    const db = getDb();

    try {
      const { workspaceId, agentIds } = await seedWorkspace(db, WORKSPACE_A_NAME);
      const agentId = agentIds[0] ?? '';

      // Both transactions find no row and both try to create it. ON CONFLICT
      // DO NOTHING means the loser inserts nothing and reads the winner's row.
      const [a, b] = await Promise.all([
        db.transaction(async (tx) => (await lockOrFail(tx, workspaceId, agentId, DAY)).current),
        db.transaction(async (tx) => (await lockOrFail(tx, workspaceId, agentId, DAY)).current),
      ]);

      expect(a.spendCommittedUsd).toBe('0.000000');
      expect(b.spendCommittedUsd).toBe('0.000000');

      const rows = await db
        .select()
        .from(ledgerDaily)
        .where(eq(ledgerDaily.workspaceId, workspaceId));
      expect(rows).toHaveLength(1);
    } finally {
      await cleanup(db);
    }
  });

  it('CONCURRENCY: two serialized callers cannot act from the same stale state', async () => {
    // THE test this suite exists for. Without serialization both transactions
    // read $20 committed, both believe $4 fits under a $25 cap, and $28
    // commits. The lock must make the second WAIT and observe $24.
    const db = getDb();

    try {
      const { workspaceId, agentIds } = await seedWorkspace(db, WORKSPACE_A_NAME);
      const agentId = agentIds[0] ?? '';

      await db.transaction(async (tx) => {
        await (await lockOrFail(tx, workspaceId, agentId, DAY)).commitSpend('20.000000');
      });

      /** What each transaction SAW under its own lock. */
      const observed: string[] = [];
      const attempt = async (amount: string): Promise<void> =>
        db.transaction(async (tx) => {
          const locked = await lockOrFail(tx, workspaceId, agentId, DAY);
          observed.push(locked.current.spendCommittedUsd);
          await locked.commitSpend(amount);
        });

      await Promise.all([attempt('4.000000'), attempt('4.000000')]);

      // One saw $20; the other WAITED and saw $24. Neither read a stale $20,
      // which is exactly what lets Step 15 deny the second correctly.
      expect(observed.sort()).toEqual(['20.000000', '24.000000']);

      const rows = await db
        .select()
        .from(ledgerDaily)
        .where(eq(ledgerDaily.workspaceId, workspaceId));
      // No lost update: exactly $28 committed, not $24.
      expect(rows[0]?.spendCommittedUsd).toBe('28.000000');
    } finally {
      await cleanup(db);
    }
  });

  it('CONCURRENCY: a second transaction observes the first committed value', async () => {
    const db = getDb();

    try {
      const { workspaceId, agentIds } = await seedWorkspace(db, WORKSPACE_A_NAME);
      const agentId = agentIds[0] ?? '';

      await db.transaction(async (tx) => {
        await (await lockOrFail(tx, workspaceId, agentId, DAY)).commitSpend('7.500000');
      });

      const second = await db.transaction(async (tx) =>
        (await lockOrFail(tx, workspaceId, agentId, DAY)).current.spendCommittedUsd,
      );

      expect(second).toBe('7.500000');
    } finally {
      await cleanup(db);
    }
  });

  it('CONCURRENCY: eight concurrent spends all land', async () => {
    const db = getDb();

    try {
      const { workspaceId, agentIds } = await seedWorkspace(db, WORKSPACE_A_NAME);
      const agentId = agentIds[0] ?? '';

      await Promise.all(
        Array.from({ length: 8 }, () =>
          db.transaction(async (tx) => {
            await (await lockOrFail(tx, workspaceId, agentId, DAY)).commitSpend('1.250000');
          }),
        ),
      );

      const rows = await db
        .select()
        .from(ledgerDaily)
        .where(eq(ledgerDaily.workspaceId, workspaceId));
      expect(rows).toHaveLength(1);
      // 8 x 1.25 exactly, with no lost update and no float drift.
      expect(rows[0]?.spendCommittedUsd).toBe('10.000000');
    } finally {
      await cleanup(db);
    }
  });

  it('CONCURRENCY: concurrent publishes all count', async () => {
    const db = getDb();

    try {
      const { workspaceId, agentIds } = await seedWorkspace(db, WORKSPACE_A_NAME);
      const agentId = agentIds[0] ?? '';

      await Promise.all(
        Array.from({ length: 6 }, () =>
          db.transaction(async (tx) => {
            await (await lockOrFail(tx, workspaceId, agentId, DAY)).commitPublish();
          }),
        ),
      );

      const rows = await db
        .select()
        .from(ledgerDaily)
        .where(eq(ledgerDaily.workspaceId, workspaceId));
      // The AC-11 shape: six publishes are six, never five.
      expect(rows[0]?.publishCountCommitted).toBe(6);
    } finally {
      await cleanup(db);
    }
  });

  it('DIFFERENT AGENTS do not block one another', async () => {
    // One busy agent must not stall the fleet: the lock is per row, and the
    // rows differ by agent.
    const db = getDb();

    try {
      const { workspaceId, agentIds } = await seedWorkspace(db, WORKSPACE_A_NAME, [
        'agent-a',
        'agent-b',
      ]);

      let bothLocked = false;
      const release: { resolve: () => void } = { resolve: () => undefined };
      const gate = new Promise<void>((resolve) => {
        release.resolve = resolve;
      });

      const holdA = db.transaction(async (tx) => {
        await lockOrFail(tx, workspaceId, agentIds[0] ?? '', DAY);
        // Hold A's lock until B has proven it can proceed.
        await gate;
      });

      const lockB = db.transaction(async (tx) => {
        await lockOrFail(tx, workspaceId, agentIds[1] ?? '', DAY);
        bothLocked = true;
        release.resolve();
      });

      await Promise.all([holdA, lockB]);

      // B acquired its lock while A still held its own.
      expect(bothLocked).toBe(true);
    } finally {
      await cleanup(db);
    }
  });

  it('DIFFERENT DAYS are independent rows', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const { workspaceId, agentIds } = await seedWorkspace(tx, WORKSPACE_A_NAME);
        const agentId = agentIds[0] ?? '';
        const repo = createLedgerRepository(tx, createWorkspaceScope(workspaceId));

        await (await lockOrFail(tx, workspaceId, agentId, DAY)).commitSpend('25.000000');
        await (await lockOrFail(tx, workspaceId, agentId, NEXT_DAY)).commitSpend('3.000000');

        // Crossing midnight UTC starts a fresh daily budget; yesterday's spend
        // is untouched and still on yesterday's row.
        expect((await repo.findDailyLedger(agentId, DAY))?.spendCommittedUsd).toBe('25.000000');
        expect((await repo.findDailyLedger(agentId, NEXT_DAY))?.spendCommittedUsd).toBe(
          '3.000000',
        );

        const rows = await tx
          .select()
          .from(ledgerDaily)
          .where(eq(ledgerDaily.workspaceId, workspaceId));
        expect(rows).toHaveLength(2);

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('a capability mutates ONLY the row it locked', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const { workspaceId, agentIds } = await seedWorkspace(tx, WORKSPACE_A_NAME, [
          'agent-a',
          'agent-b',
        ]);
        const repo = createLedgerRepository(tx, createWorkspaceScope(workspaceId));

        // Create neighbouring rows the capability must not touch.
        await lockOrFail(tx, workspaceId, agentIds[1] ?? '', DAY);
        await lockOrFail(tx, workspaceId, agentIds[0] ?? '', NEXT_DAY);

        const locked = await lockOrFail(tx, workspaceId, agentIds[0] ?? '', DAY);
        await locked.commitSpend('9.000000');
        await locked.commitPublish();

        // Only agent-a / DAY moved. The key is bound to the capability, so
        // there is no argument through which another row could be addressed.
        expect((await repo.findDailyLedger(agentIds[0] ?? '', DAY))?.spendCommittedUsd).toBe(
          '9.000000',
        );
        expect((await repo.findDailyLedger(agentIds[1] ?? '', DAY))?.spendCommittedUsd).toBe(
          '0.000000',
        );
        expect(
          (await repo.findDailyLedger(agentIds[0] ?? '', NEXT_DAY))?.spendCommittedUsd,
        ).toBe('0.000000');
        expect(
          (await repo.findDailyLedger(agentIds[1] ?? '', DAY))?.publishCountCommitted,
        ).toBe(0);

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('the composite primary key refuses a duplicate row', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const { workspaceId, agentIds } = await seedWorkspace(tx, WORKSPACE_A_NAME);
        const row = { workspaceId, agentId: agentIds[0] ?? '', day: DAY };

        await tx.insert(ledgerDaily).values(row);
        // Exactly one authoritative row per workspace/agent/day, enforced by
        // the database rather than by application discipline.
        await expect(tx.insert(ledgerDaily).values(row)).rejects.toThrow();

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('CROSS-TENANT: another workspace agent grants no capability', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const a = await seedWorkspace(tx, WORKSPACE_A_NAME);
        const b = await seedWorkspace(tx, WORKSPACE_B_NAME, ['bobs-agent']);

        // Workspace A's scope, holding B's exact internal agent UUID.
        const locked = await createLedgerRepository(
          tx,
          createWorkspaceScope(a.workspaceId),
        ).lockDailyLedger(b.agentIds[0] ?? '', DAY);

        // A UUID is not authorization. No capability is granted at all, so
        // there is nothing to call commitSpend on.
        expect(locked).toBeNull();
        const rows = await tx.select().from(ledgerDaily);
        expect(
          rows.filter((r) => r.workspaceId === a.workspaceId || r.workspaceId === b.workspaceId),
        ).toEqual([]);

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('CROSS-TENANT: the composite FK also refuses it at the database level', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const a = await seedWorkspace(tx, WORKSPACE_A_NAME);
        const b = await seedWorkspace(tx, WORKSPACE_B_NAME, ['bobs-agent']);

        // Defense in depth behind the scoped agent check.
        await expect(
          tx
            .insert(ledgerDaily)
            .values({ workspaceId: a.workspaceId, agentId: b.agentIds[0] ?? '', day: DAY }),
        ).rejects.toThrow();

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('CROSS-TENANT: two workspaces keep independent ledgers', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        // The same external agent name in both tenants - a realistic collision.
        const a = await seedWorkspace(tx, WORKSPACE_A_NAME, ['agent-1']);
        const b = await seedWorkspace(tx, WORKSPACE_B_NAME, ['agent-1']);

        await (await lockOrFail(tx, a.workspaceId, a.agentIds[0] ?? '', DAY)).commitSpend(
          '25.000000',
        );
        await (await lockOrFail(tx, b.workspaceId, b.agentIds[0] ?? '', DAY)).commitSpend(
          '3.000000',
        );

        const repoA = createLedgerRepository(tx, createWorkspaceScope(a.workspaceId));
        const repoB = createLedgerRepository(tx, createWorkspaceScope(b.workspaceId));

        expect((await repoA.findDailyLedger(a.agentIds[0] ?? '', DAY))?.spendCommittedUsd).toBe(
          '25.000000',
        );
        expect((await repoB.findDailyLedger(b.agentIds[0] ?? '', DAY))?.spendCommittedUsd).toBe(
          '3.000000',
        );
        // A's scope cannot see B's row even holding B's agent id.
        expect(await repoA.findDailyLedger(b.agentIds[0] ?? '', DAY)).toBeNull();

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('the non-negative check constraint holds', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const { workspaceId, agentIds } = await seedWorkspace(tx, WORKSPACE_A_NAME);

        // The application never produces a negative, but the column refuses
        // one regardless.
        await expect(
          tx.insert(ledgerDaily).values({
            workspaceId,
            agentId: agentIds[0] ?? '',
            day: DAY,
            spendCommittedUsd: '-1.000000',
          }),
        ).rejects.toThrow();

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('leaves no residue', async () => {
    const db = getDb();

    const remaining = await db.select().from(workspaces).where(inArray(workspaces.name, ALL_NAMES));

    expect(remaining).toEqual([]);
  });
});
