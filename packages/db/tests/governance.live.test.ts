import { eq, inArray } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { toUtcAccountingDay } from '../src/accounting/utc-day';
import { closeDatabasePool, createDatabaseClient, createDatabasePool } from '../src/client';
import { createAgentRepository } from '../src/repositories/agents';
import { createBlockRepository } from '../src/repositories/blocks';
import { createLedgerRepository } from '../src/repositories/ledger';
import { createPolicyReadRepository } from '../src/repositories/policy';
import { createPrecheckReceiptRepository } from '../src/repositories/receipts';
import { createWorkspaceScope } from '../src/repositories/workspace-scope';
import type { DatabaseExecutor } from '../src/repositories/executor';
import { agents } from '../src/schema/agents';
import { blocks } from '../src/schema/blocks';
import { ledgerDaily } from '../src/schema/ledger';
import { agentPolicies, workspacePolicyState } from '../src/schema/policy';
import { precheckReceipts } from '../src/schema/receipts';
import { workspaces } from '../src/schema/workspaces';

/**
 * LIVE governance read suite against real PostgreSQL (Step 17).
 *
 * SAFETY - READ BEFORE CHANGING THE GATE
 * --------------------------------------
 * This suite WRITES SEED DATA. It is gated on `TEST_DATABASE_URL` and **never
 * falls back to `DATABASE_URL`**. Every write is rolled back or explicitly
 * cleaned up; nothing is dropped or truncated. The connection string is never
 * logged.
 *
 * WHY IT EXISTS SEPARATELY
 * ------------------------
 * The in-memory read store returns whatever it was seeded with, so it can
 * prove the ROUTE behaves but not that the SQL does. Everything Step 17 rests
 * on is a claim about PostgreSQL:
 *
 *   - that `(created_at, id) < ($1, $2)` really pages a burst of decisions
 *     sharing one timestamp without repeating or skipping a row;
 *   - that the workspace predicate really excludes another tenant's receipt,
 *     block and ledger row, including through the joins;
 *   - that `date` comparison for the accounting day really lands on the UTC
 *     boundary rather than the database server's timezone;
 *   - that reading the fleet really creates NO ledger row.
 *
 * The last is the one a mock can never test: an in-memory store cannot fail to
 * write a row it was never asked to write.
 *
 * `readFleet` below TRANSCRIBES the fleet composition from
 * `apps/api/src/governance/read-store.ts`, because `packages/db` cannot import
 * from `apps/` - the same convention `runPrecheck` follows in
 * `precheck.live.test.ts`. A drift guard in `apps/api`, which depends on both,
 * keeps the transcription honest.
 */

const testDatabaseUrl = process.env['TEST_DATABASE_URL']?.trim();
const hasTestDatabase = testDatabaseUrl !== undefined && testDatabaseUrl !== '';

const WORKSPACE_A_NAME = 'live-governance-alpha';
const WORKSPACE_B_NAME = 'live-governance-bravo';
const ALL_NAMES = [WORKSPACE_A_NAME, WORKSPACE_B_NAME];

const NOW = new Date('2026-08-13T09:00:00.000Z');
const DAY = toUtcAccountingDay(NOW);

class Rollback extends Error {}

/** Usage for an agent with no ledger row today. Computed, never written. */
const NO_USAGE = { spendCommittedUsd: '0.000000', publishCountCommitted: 0 } as const;

/** One agent's live governance state, as the fleet view reports it. */
interface FleetGovernance {
  readonly agentId: string;
  readonly mode: 'watch' | 'budgeted' | 'paused';
  readonly dailySpendCapUsd: string | null;
  readonly dailyPublishCap: number | null;
  readonly spendCommittedUsd: string;
  readonly publishCountCommitted: number;
  readonly accountingDay: string;
}

/**
 * Transcription of the production fleet read.
 *
 * Kept deliberately literal, in the same order, so a drift from
 * `apps/api/src/governance/read-store.ts` is visible on inspection - and is
 * caught mechanically by the drift guard in `apps/api`.
 *
 * The two things it must preserve are the two things that fail silently:
 * `findDailyLedger` rather than `lockDailyLedger`, and ONE clock reading for
 * the whole roster.
 */
async function readFleet(
  executor: DatabaseExecutor,
  workspaceId: string,
  now: Date,
): Promise<FleetGovernance[]> {
  const scope = createWorkspaceScope(workspaceId);
  const day = toUtcAccountingDay(now);

  const ledgerRepository = createLedgerRepository(executor, scope);

  const [roster, policies] = await Promise.all([
    createAgentRepository(executor, scope).listAll(),
    createPolicyReadRepository(executor, scope).listEffectivePolicies(),
  ]);

  const policyByAgent = new Map(policies.map((row) => [row.id, row]));

  return Promise.all(
    roster.map(async (agent) => {
      const policy = policyByAgent.get(agent.id);
      // READ, never lock, never create.
      const usage = (await ledgerRepository.findDailyLedger(agent.id, day)) ?? NO_USAGE;

      return {
        agentId: agent.id,
        mode: policy?.mode ?? 'watch',
        dailySpendCapUsd: policy?.dailySpendCapUsd ?? null,
        dailyPublishCap: policy?.dailyPublishCap ?? null,
        spendCommittedUsd: usage.spendCommittedUsd,
        publishCountCommitted: usage.publishCountCommitted,
        accountingDay: day,
      };
    }),
  );
}

let pool: ReturnType<typeof createDatabasePool> | undefined;

afterAll(async () => {
  if (pool !== undefined) {
    await closeDatabasePool(pool);
  }
});

describe.skipIf(!hasTestDatabase)('live governance reads', () => {
  function getDb(): ReturnType<typeof createDatabaseClient> {
    pool ??= createDatabasePool({
      connectionString: testDatabaseUrl as string,
      maxConnections: 4,
      applicationName: 'hybrid-governance-live-test',
    });
    return createDatabaseClient(pool);
  }

  async function seedWorkspace(
    executor: DatabaseExecutor,
    name: string,
    policy: {
      mode: 'watch' | 'budgeted' | 'paused';
      spend: string | null;
      publish: number | null;
    } | null = { mode: 'budgeted', spend: '25.000000', publish: 5 },
    externalId = 'agent-a',
  ): Promise<{ workspaceId: string; agentId: string }> {
    const [ws] = await executor.insert(workspaces).values({ name }).returning();
    const workspaceId = ws?.id ?? '';
    await executor.insert(workspacePolicyState).values({ workspaceId, version: 1 });
    const [agent] = await executor.insert(agents).values({ workspaceId, externalId }).returning();
    const agentId = agent?.id ?? '';

    // `policy === null` seeds an agent with NO explicit row, exercising the
    // Step 12 effective default rather than a persisted watch row.
    if (policy !== null) {
      await executor.insert(agentPolicies).values({
        workspaceId,
        agentId,
        mode: policy.mode,
        dailySpendCapUsd: policy.spend,
        dailyPublishCap: policy.publish,
      });
    }
    return { workspaceId, agentId };
  }

  /** Inserts one receipt directly, so the read path is tested in isolation. */
  async function seedReceipt(
    executor: DatabaseExecutor,
    workspaceId: string,
    agentId: string,
    overrides: {
      actionId: string;
      decision: 'allow' | 'deny';
      denyReason?: string | null;
      createdAt?: Date;
      category?: 'llm_call' | 'tool_call' | 'spend' | 'publish' | 'other';
      appliedMode?: 'watch' | 'budgeted' | 'paused';
      appliedSpendCapUsd?: string | null;
      requestedAmountUsd?: string | null;
      ledgerSpendBeforeUsd?: string | null;
    },
  ): Promise<string> {
    const [row] = await executor
      .insert(precheckReceipts)
      .values({
        workspaceId,
        agentId,
        actionId: overrides.actionId,
        category: overrides.category ?? 'spend',
        decision: overrides.decision,
        denyReason: overrides.denyReason ?? null,
        policyVersion: 1,
        appliedMode: overrides.appliedMode ?? 'budgeted',
        appliedSpendCapUsd: overrides.appliedSpendCapUsd ?? '25.000000',
        appliedPublishCap: 5,
        requestedAmountUsd: overrides.requestedAmountUsd ?? '4.000000',
        requestedPublishCount: null,
        ledgerSpendBeforeUsd: overrides.ledgerSpendBeforeUsd ?? '20.000000',
        ledgerPublishBefore: 0,
        remainingSpendUsd: '1.000000',
        remainingPublishCount: 5,
        accountingDay: DAY,
        ...(overrides.createdAt === undefined ? {} : { createdAt: overrides.createdAt }),
      })
      .returning();
    return row?.id ?? '';
  }

  async function cleanup(db: ReturnType<typeof createDatabaseClient>): Promise<void> {
    const rows = await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(inArray(workspaces.name, ALL_NAMES));
    for (const row of rows) {
      // Blocks first: they reference receipts.
      await db.delete(blocks).where(eq(blocks.workspaceId, row.id));
      await db.delete(precheckReceipts).where(eq(precheckReceipts.workspaceId, row.id));
      await db.delete(ledgerDaily).where(eq(ledgerDaily.workspaceId, row.id));
      await db.delete(agentPolicies).where(eq(agentPolicies.workspaceId, row.id));
      await db.delete(agents).where(eq(agents.workspaceId, row.id));
      await db.delete(workspacePolicyState).where(eq(workspacePolicyState.workspaceId, row.id));
    }
    await db.delete(workspaces).where(inArray(workspaces.name, ALL_NAMES));
  }

  it('pages a burst of decisions sharing ONE timestamp without repeat or gap', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const { workspaceId, agentId } = await seedWorkspace(tx, WORKSPACE_A_NAME);
        const scope = createWorkspaceScope(workspaceId);
        const receipts = createPrecheckReceiptRepository(tx, scope);

        // Ten decisions, identical `created_at`. This is the case a plain
        // `created_at <` cursor gets wrong: it would skip the remainder of the
        // instant, silently losing rows from the audit.
        const instant = new Date('2026-08-13T09:00:00.000Z');
        for (let i = 0; i < 10; i += 1) {
          await seedReceipt(tx, workspaceId, agentId, {
            actionId: `act-${String(i)}`,
            decision: 'allow',
            createdAt: instant,
          });
        }

        const seen: string[] = [];
        let cursor: { createdAt: Date; id: string } | undefined;
        for (let page = 0; page < 5; page += 1) {
          const rows = await receipts.listAudit({ limit: 4, cursor });
          if (rows.length === 0) break;
          seen.push(...rows.map((r) => r.id));
          const last = rows.at(-1);
          if (last === undefined || rows.length < 4) break;
          cursor = { createdAt: last.createdAt, id: last.id };
        }

        expect(seen).toHaveLength(10);
        expect(new Set(seen).size).toBe(10);

        throw new Rollback();
      });
    } catch (error: unknown) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('pages across distinct timestamps newest first', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const { workspaceId, agentId } = await seedWorkspace(tx, WORKSPACE_A_NAME);
        const scope = createWorkspaceScope(workspaceId);
        const receipts = createPrecheckReceiptRepository(tx, scope);

        const ids: string[] = [];
        for (let i = 0; i < 6; i += 1) {
          ids.push(
            await seedReceipt(tx, workspaceId, agentId, {
              actionId: `act-${String(i)}`,
              decision: 'allow',
              createdAt: new Date(Date.UTC(2026, 7, 13, 9, i)),
            }),
          );
        }

        const first = await receipts.listAudit({ limit: 3 });
        const last = first.at(-1);
        const second = await receipts.listAudit({
          limit: 3,
          cursor: { createdAt: last?.createdAt ?? NOW, id: last?.id ?? '' },
        });

        // Newest first, so the pages walk the seed order backwards.
        expect(first.map((r) => r.id)).toEqual([...ids].reverse().slice(0, 3));
        expect(second.map((r) => r.id)).toEqual([...ids].reverse().slice(3, 6));

        throw new Rollback();
      });
    } catch (error: unknown) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it("CROSS-TENANT: another workspace's receipt is invisible by exact id", async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const a = await seedWorkspace(tx, WORKSPACE_A_NAME);
        const b = await seedWorkspace(tx, WORKSPACE_B_NAME);

        const foreignId = await seedReceipt(tx, b.workspaceId, b.agentId, {
          actionId: 'act-b',
          decision: 'deny',
          denyReason: 'daily_spend_cap_exceeded',
        });

        const asA = createPrecheckReceiptRepository(tx, createWorkspaceScope(a.workspaceId));

        // PROBE A against real SQL: the exact uuid, and it still is not there.
        expect(await asA.findAuditById(foreignId)).toBeNull();
        expect(await asA.listAudit({ limit: 50 })).toEqual([]);

        // And it does exist - the read above failed on the predicate, not
        // because the row was missing.
        const asB = createPrecheckReceiptRepository(tx, createWorkspaceScope(b.workspaceId));
        expect((await asB.findAuditById(foreignId))?.id).toBe(foreignId);

        throw new Rollback();
      });
    } catch (error: unknown) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('CROSS-TENANT: the agent join cannot pair a receipt with a foreign agent', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const a = await seedWorkspace(tx, WORKSPACE_A_NAME, undefined, 'shared-name');
        const b = await seedWorkspace(tx, WORKSPACE_B_NAME, undefined, 'shared-name');

        // Both workspaces use the SAME external agent id. Only the composite
        // join keeps them apart.
        await seedReceipt(tx, a.workspaceId, a.agentId, { actionId: 'act-a', decision: 'allow' });

        const rows = await createPrecheckReceiptRepository(
          tx,
          createWorkspaceScope(a.workspaceId),
        ).listAudit({ limit: 50 });

        expect(rows).toHaveLength(1);
        expect(rows[0]?.agent.id).toBe(a.agentId);
        expect(rows[0]?.agent.id).not.toBe(b.agentId);

        throw new Rollback();
      });
    } catch (error: unknown) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('shows an allowed decision even though it has no block', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const { workspaceId, agentId } = await seedWorkspace(tx, WORKSPACE_A_NAME);
        await seedReceipt(tx, workspaceId, agentId, { actionId: 'act-1', decision: 'allow' });

        // An inner join to `blocks` would hide every allow from the audit.
        const rows = await createPrecheckReceiptRepository(
          tx,
          createWorkspaceScope(workspaceId),
        ).listAudit({ limit: 50 });

        expect(rows).toHaveLength(1);
        expect(rows[0]?.block).toBeNull();
        expect(rows[0]?.decision).toBe('allow');

        throw new Rollback();
      });
    } catch (error: unknown) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('links a denial to its plane block, and leaves a runtime block unlinked', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const { workspaceId, agentId } = await seedWorkspace(tx, WORKSPACE_A_NAME);
        const scope = createWorkspaceScope(workspaceId);

        const receiptId = await seedReceipt(tx, workspaceId, agentId, {
          actionId: 'act-deny',
          decision: 'deny',
          denyReason: 'daily_spend_cap_exceeded',
        });

        await tx.insert(blocks).values({
          workspaceId,
          agentId,
          source: 'plane',
          category: 'spend',
          rule: 'daily_spend_cap',
          reason: 'Daily spend cap reached.',
          externalBlockId: null,
          precheckReceiptId: receiptId,
          amountUsd: '4.000000',
        });
        await tx.insert(blocks).values({
          workspaceId,
          agentId,
          source: 'runtime',
          category: 'publish',
          rule: 'vendor_custom_guard',
          reason: 'Plugin refused locally.',
          externalBlockId: 'client-block-1',
          precheckReceiptId: null,
        });

        const receipt = await createPrecheckReceiptRepository(tx, scope).findAuditById(receiptId);
        expect(receipt?.block?.rule).toBe('daily_spend_cap');

        const all = await createBlockRepository(tx, scope).listAudit({ limit: 50 });
        expect(all).toHaveLength(2);

        const runtime = all.find((b) => b.source === 'runtime');
        const plane = all.find((b) => b.source === 'plane');

        // Ownership is PERSISTED, and a runtime block has no plane decision.
        expect(runtime?.precheckReceiptId).toBeNull();
        expect(runtime?.externalBlockId).toBe('client-block-1');
        expect(plane?.precheckReceiptId).toBe(receiptId);
        expect(plane?.externalBlockId).toBeNull();

        // The source filter narrows; it never hides.
        expect(await createBlockRepository(tx, scope).listAudit({ limit: 50, source: 'plane' })).toHaveLength(1);
        expect(
          await createBlockRepository(tx, scope).listAudit({ limit: 50, source: 'runtime' }),
        ).toHaveLength(1);

        throw new Rollback();
      });
    } catch (error: unknown) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('returns exact decimal money, unrounded, straight from numeric(14,6)', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const { workspaceId, agentId } = await seedWorkspace(tx, WORKSPACE_A_NAME);

        const receiptId = await seedReceipt(tx, workspaceId, agentId, {
          actionId: 'act-exact',
          decision: 'deny',
          denyReason: 'daily_spend_cap_exceeded',
          appliedSpendCapUsd: '25.000000',
          requestedAmountUsd: '0.000001',
          ledgerSpendBeforeUsd: '24.999999',
        });

        const row = await createPrecheckReceiptRepository(
          tx,
          createWorkspaceScope(workspaceId),
        ).findAuditById(receiptId);

        // Strings, not numbers. A JS float cannot hold 24.999999 and 0.000001
        // and still decide this correctly, which is exactly why the driver
        // must hand back text.
        expect(row?.ledgerSpendBeforeUsd).toBe('24.999999');
        expect(row?.requestedAmountUsd).toBe('0.000001');
        expect(row?.appliedSpendCapUsd).toBe('25.000000');
        expect(typeof row?.ledgerSpendBeforeUsd).toBe('string');

        throw new Rollback();
      });
    } catch (error: unknown) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('a receipt keeps its recorded policy after the policy CHANGES', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const { workspaceId, agentId } = await seedWorkspace(tx, WORKSPACE_A_NAME);
        const scope = createWorkspaceScope(workspaceId);

        const receiptId = await seedReceipt(tx, workspaceId, agentId, {
          actionId: 'act-1',
          decision: 'deny',
          denyReason: 'daily_spend_cap_exceeded',
          appliedMode: 'budgeted',
          appliedSpendCapUsd: '25.000000',
        });

        // The operator raises the cap and unpauses, as they would after
        // reviewing the denial.
        await tx
          .update(agentPolicies)
          .set({ dailySpendCapUsd: '500.000000', mode: 'watch' })
          .where(eq(agentPolicies.agentId, agentId));

        const row = await createPrecheckReceiptRepository(tx, scope).findAuditById(receiptId);

        // NO HISTORICAL RECOMPUTATION. The evidence is what it was.
        expect(row?.appliedSpendCapUsd).toBe('25.000000');
        expect(row?.appliedMode).toBe('budgeted');
        expect(row?.denyReason).toBe('daily_spend_cap_exceeded');

        // Meanwhile the LIVE policy read reports the new value, so the two
        // surfaces are genuinely reading different things.
        const effective = await createPolicyReadRepository(tx, scope).listEffectivePolicies();
        expect(effective[0]?.dailySpendCapUsd).toBe('500.000000');
        expect(effective[0]?.mode).toBe('watch');

        throw new Rollback();
      });
    } catch (error: unknown) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('an agent with no policy row reads as the WATCH default', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const { workspaceId } = await seedWorkspace(tx, WORKSPACE_A_NAME, null);

        const effective = await createPolicyReadRepository(
          tx,
          createWorkspaceScope(workspaceId),
        ).listEffectivePolicies();

        // Watch with NULL caps - never a persisted zero, which would read as
        // "spend nothing" rather than "no cap".
        expect(effective).toHaveLength(1);
        expect(effective[0]?.mode).toBe('watch');
        expect(effective[0]?.dailySpendCapUsd).toBeNull();
        expect(effective[0]?.dailyPublishCap).toBeNull();

        // And no row was created by reading.
        const stored = await tx
          .select()
          .from(agentPolicies)
          .where(eq(agentPolicies.workspaceId, workspaceId));
        expect(stored).toEqual([]);

        throw new Rollback();
      });
    } catch (error: unknown) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('READING THE FLEET CREATES NO LEDGER ROW', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const { workspaceId, agentId } = await seedWorkspace(tx, WORKSPACE_A_NAME);
        const scope = createWorkspaceScope(workspaceId);

        // PROBE D against real SQL. This is the assertion a mock cannot make:
        // an in-memory store cannot fail to write a row it was never asked to
        // write, but a real `SELECT` that had been changed to an upsert would
        // leave one behind here.
        const usage = await createLedgerRepository(tx, scope).findDailyLedger(agentId, DAY);
        expect(usage).toBeNull();

        const rows = await tx
          .select()
          .from(ledgerDaily)
          .where(eq(ledgerDaily.workspaceId, workspaceId));
        expect(rows).toEqual([]);

        throw new Rollback();
      });
    } catch (error: unknown) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('THE FLEET READ CREATES NO LEDGER ROW', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const { workspaceId, agentId } = await seedWorkspace(tx, WORKSPACE_A_NAME);

        // PROBE D against the composed read, not just the query. Swapping in
        // `lockDailyLedger` would satisfy every assertion above this line and
        // then leave a row behind.
        const fleet = await readFleet(tx, workspaceId, NOW);

        expect(fleet).toEqual([
          {
            agentId,
            mode: 'budgeted',
            dailySpendCapUsd: '25.000000',
            dailyPublishCap: 5,
            spendCommittedUsd: '0.000000',
            publishCountCommitted: 0,
            accountingDay: DAY,
          },
        ]);

        const rows = await tx
          .select()
          .from(ledgerDaily)
          .where(eq(ledgerDaily.workspaceId, workspaceId));

        // Zero is a READ SEMANTIC, not a persisted row.
        expect(rows).toEqual([]);

        // Reading twice is still no rows, and still the same answer.
        await readFleet(tx, workspaceId, NOW);
        expect(
          await tx.select().from(ledgerDaily).where(eq(ledgerDaily.workspaceId, workspaceId)),
        ).toEqual([]);

        throw new Rollback();
      });
    } catch (error: unknown) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('the fleet read reports committed usage exactly', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const { workspaceId, agentId } = await seedWorkspace(tx, WORKSPACE_A_NAME);
        await tx.insert(ledgerDaily).values({
          workspaceId,
          agentId,
          day: DAY,
          spendCommittedUsd: '24.999999',
          publishCountCommitted: 4,
        });

        const fleet = await readFleet(tx, workspaceId, NOW);

        // Exact decimal strings the whole way. No float touches this path -
        // 24.999999 against a 25.000000 cap is precisely the comparison a
        // double would get wrong.
        expect(fleet[0]?.spendCommittedUsd).toBe('24.999999');
        expect(fleet[0]?.dailySpendCapUsd).toBe('25.000000');
        expect(fleet[0]?.publishCountCommitted).toBe(4);

        throw new Rollback();
      });
    } catch (error: unknown) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('THE WHOLE ROSTER REPORTS ONE ACCOUNTING DAY', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const { workspaceId } = await seedWorkspace(tx, WORKSPACE_A_NAME);
        for (const externalId of ['agent-b', 'agent-c', 'agent-d']) {
          await tx.insert(agents).values({ workspaceId, externalId });
        }

        // A request that straddles UTC midnight must not report two different
        // days across its rows, which is why the clock is read once.
        const fleet = await readFleet(tx, workspaceId, new Date('2026-08-13T23:59:59.999Z'));

        expect(fleet).toHaveLength(4);
        expect(new Set(fleet.map((f) => f.accountingDay))).toEqual(new Set(['2026-08-13']));

        throw new Rollback();
      });
    } catch (error: unknown) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('the fleet read shows an agent with no policy row as the WATCH default', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const { workspaceId } = await seedWorkspace(tx, WORKSPACE_A_NAME, null);

        const fleet = await readFleet(tx, workspaceId, NOW);

        expect(fleet[0]?.mode).toBe('watch');
        expect(fleet[0]?.dailySpendCapUsd).toBeNull();
        expect(fleet[0]?.dailyPublishCap).toBeNull();
        expect(fleet[0]?.spendCommittedUsd).toBe('0.000000');

        // And reading created neither a policy row nor a ledger row.
        expect(
          await tx.select().from(agentPolicies).where(eq(agentPolicies.workspaceId, workspaceId)),
        ).toEqual([]);
        expect(
          await tx.select().from(ledgerDaily).where(eq(ledgerDaily.workspaceId, workspaceId)),
        ).toEqual([]);

        throw new Rollback();
      });
    } catch (error: unknown) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('reads usage for the SERVER UTC day, not the database timezone', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const { workspaceId, agentId } = await seedWorkspace(tx, WORKSPACE_A_NAME);
        const scope = createWorkspaceScope(workspaceId);
        const ledger = createLedgerRepository(tx, scope);

        // Two adjacent UTC days, each with committed spend.
        await tx.insert(ledgerDaily).values([
          { workspaceId, agentId, day: '2026-08-13', spendCommittedUsd: '24.000000', publishCountCommitted: 4 },
          { workspaceId, agentId, day: '2026-08-14', spendCommittedUsd: '1.000000', publishCountCommitted: 1 },
        ]);

        // An instant just before UTC midnight belongs to the 13th, and just
        // after to the 14th - regardless of where the server sits. A local-time
        // boundary would put 23:30 UTC on the 14th anywhere east of Greenwich.
        const before = await ledger.findDailyLedger(
          agentId,
          toUtcAccountingDay(new Date('2026-08-13T23:59:59.999Z')),
        );
        const after = await ledger.findDailyLedger(
          agentId,
          toUtcAccountingDay(new Date('2026-08-14T00:00:00.000Z')),
        );

        expect(before?.spendCommittedUsd).toBe('24.000000');
        expect(before?.publishCountCommitted).toBe(4);
        expect(after?.spendCommittedUsd).toBe('1.000000');

        throw new Rollback();
      });
    } catch (error: unknown) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it("CROSS-TENANT: one workspace's ledger is invisible to another", async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const a = await seedWorkspace(tx, WORKSPACE_A_NAME);
        const b = await seedWorkspace(tx, WORKSPACE_B_NAME);

        await tx.insert(ledgerDaily).values({
          workspaceId: b.workspaceId,
          agentId: b.agentId,
          day: DAY,
          spendCommittedUsd: '99.000000',
          publishCountCommitted: 9,
        });

        // Even with B's own agent uuid in hand, A's scope reads nothing.
        const asA = createLedgerRepository(tx, createWorkspaceScope(a.workspaceId));
        expect(await asA.findDailyLedger(b.agentId, DAY)).toBeNull();
        expect(await asA.findDailyLedger(a.agentId, DAY)).toBeNull();

        throw new Rollback();
      });
    } catch (error: unknown) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('filters receipts by decision and by agent, composably', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const { workspaceId, agentId } = await seedWorkspace(tx, WORKSPACE_A_NAME);
        const [second] = await tx
          .insert(agents)
          .values({ workspaceId, externalId: 'agent-b' })
          .returning();
        const secondId = second?.id ?? '';
        const scope = createWorkspaceScope(workspaceId);
        const receipts = createPrecheckReceiptRepository(tx, scope);

        await seedReceipt(tx, workspaceId, agentId, { actionId: 'a-allow', decision: 'allow' });
        await seedReceipt(tx, workspaceId, agentId, {
          actionId: 'a-deny',
          decision: 'deny',
          denyReason: 'paused',
        });
        await seedReceipt(tx, workspaceId, secondId, { actionId: 'b-allow', decision: 'allow' });

        expect(await receipts.listAudit({ limit: 50 })).toHaveLength(3);
        expect(await receipts.listAudit({ limit: 50, decision: 'deny' })).toHaveLength(1);
        expect(await receipts.listAudit({ limit: 50, agentId })).toHaveLength(2);
        expect(
          await receipts.listAudit({ limit: 50, agentId, decision: 'allow' }),
        ).toHaveLength(1);

        throw new Rollback();
      });
    } catch (error: unknown) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('leaves no rows behind after an explicit non-transactional run', async () => {
    const db = getDb();

    // Everything above rolls back. This one commits, reads through a real
    // committed state, and then cleans up - proving the cleanup path works and
    // that the reads behave identically outside a transaction.
    try {
      const { workspaceId, agentId } = await seedWorkspace(db, WORKSPACE_A_NAME);
      const scope = createWorkspaceScope(workspaceId);

      const receiptId = await seedReceipt(db, workspaceId, agentId, {
        actionId: 'act-committed',
        decision: 'deny',
        denyReason: 'paused',
      });

      const row = await createPrecheckReceiptRepository(db, scope).findAuditById(receiptId);
      expect(row?.denyReason).toBe('paused');
      expect(row?.agent.externalId).toBe('agent-a');

      // The fleet read still creates nothing, committed state or not.
      expect(await createLedgerRepository(db, scope).findDailyLedger(agentId, DAY)).toBeNull();
      const ledgerRows = await db
        .select()
        .from(ledgerDaily)
        .where(eq(ledgerDaily.workspaceId, workspaceId));
      expect(ledgerRows).toEqual([]);
    } finally {
      await cleanup(db);
    }
  });
});
