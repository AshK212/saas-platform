import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { toUtcAccountingDay } from '../src/accounting/utc-day';
import { createPlaneBlockRepository } from '../src/repositories/plane-blocks';
import { blocks } from '../src/schema/blocks';
import { closeDatabasePool, createDatabaseClient, createDatabasePool } from '../src/client';
import { createLedgerRepository } from '../src/repositories/ledger';
import { createPolicyReadRepository } from '../src/repositories/policy';
import { createPrecheckLockRepository } from '../src/repositories/ingest-locks';
import { createPrecheckReceiptRepository } from '../src/repositories/receipts';
import { createWorkspaceScope } from '../src/repositories/workspace-scope';
import type { DatabaseExecutor } from '../src/repositories/executor';
import { agents } from '../src/schema/agents';
import { ledgerDaily } from '../src/schema/ledger';
import { agentPolicies, workspacePolicyState } from '../src/schema/policy';
import { precheckReceipts } from '../src/schema/receipts';
import { workspaces } from '../src/schema/workspaces';

/**
 * LIVE precheck suite against real PostgreSQL (Step 15).
 *
 * SAFETY - READ BEFORE CHANGING THE GATE
 * --------------------------------------
 * This suite WRITES DATA. It is gated on `TEST_DATABASE_URL` and **never falls
 * back to `DATABASE_URL`**. Writes are rolled back or explicitly cleaned up;
 * nothing is dropped or truncated. The connection string is never logged.
 *
 * WHY IT EXISTS SEPARATELY
 * ------------------------
 * The in-memory precheck store is single-threaded JavaScript, so its
 * idempotency check and its "lock" are authoritative for free. Everything
 * Step 15 actually rests on is a claim about PostgreSQL:
 *
 *   - that `SELECT … FOR UPDATE` stops two concurrent decisions from BOTH
 *     allowing past a cap - the commit-on-allow guarantee;
 *   - that `pg_advisory_xact_lock` plus `UNIQUE (workspace_id, action_id)`
 *     stops a retry from debiting twice;
 *   - that the ledger debit and the receipt commit or roll back TOGETHER;
 *   - that `FOR SHARE` on the policy row keeps the decision's version and caps
 *     consistent while an operator mutates concurrently.
 *
 * `runPrecheck` below transcribes the decision transaction from
 * `apps/api/src/precheck/store.ts`, because `packages/db` cannot import from
 * `apps/`. Divergence should be visible reading them side by side.
 */

const testDatabaseUrl = process.env['TEST_DATABASE_URL']?.trim();
const hasTestDatabase = testDatabaseUrl !== undefined && testDatabaseUrl !== '';

const WORKSPACE_A_NAME = 'live-precheck-alpha';
const WORKSPACE_B_NAME = 'live-precheck-bravo';
const ALL_NAMES = [WORKSPACE_A_NAME, WORKSPACE_B_NAME];

const NOW = new Date('2026-08-13T09:00:00.000Z');
const DAY = toUtcAccountingDay(NOW);

class Rollback extends Error {}

let pool: ReturnType<typeof createDatabasePool> | undefined;

afterAll(async () => {
  if (pool !== undefined) {
    await closeDatabasePool(pool);
  }
});

/** A precheck request, mirroring the wire contract. */
interface Request {
  readonly actionId: string;
  readonly agentExternalId: string;
  readonly category: 'llm_call' | 'tool_call' | 'spend' | 'publish' | 'other';
  readonly amountUsd?: string;
}

interface Outcome {
  readonly precheckId: string;
  readonly decision: 'allow' | 'deny';
  readonly reason: string | null;
  readonly replayed: boolean;
}

/**
 * The denial vocabulary, mirrored locally.
 *
 * `packages/db` cannot import `@hybrid/contracts` - the dependency runs the
 * other way - so this transcribes the single shared mapping from
 * `contracts/src/denial.ts`. An agreement test in `apps/api`, which depends on
 * both, proves the two never drift.
 */
const RULE_FOR_REASON: Record<string, string> = {
  daily_spend_cap_exceeded: 'daily_spend_cap',
  daily_publish_cap_exceeded: 'daily_publish_cap',
  paused: 'agent_paused',
};
const EXPLANATION_FOR_REASON: Record<string, string> = {
  daily_spend_cap_exceeded: 'Daily spend cap reached.',
  daily_publish_cap_exceeded: 'Daily publish cap reached.',
  paused: 'Agent is paused.',
};

/** Exact micro-dollar helpers, matching the production arithmetic. */
function toMicros(value: string): bigint {
  const [whole = '0', fraction = ''] = value.split('.');
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
}
function fromMicros(micros: bigint): string {
  return `${(micros / 1_000_000n).toString()}.${(micros % 1_000_000n).toString().padStart(6, '0')}`;
}

/**
 * Transcription of the production decision transaction.
 *
 * Kept deliberately literal, in the same order, so a drift from
 * `apps/api/src/precheck/store.ts` is visible on inspection.
 */
async function runPrecheck(
  tx: DatabaseExecutor,
  workspaceId: string,
  request: Request,
  now: Date,
): Promise<Outcome> {
  const scope = createWorkspaceScope(workspaceId);
  const day = toUtcAccountingDay(now);
  const receipts = createPrecheckReceiptRepository(tx, scope);

  // 1. Action identity lock, then the idempotency check.
  await createPrecheckLockRepository(tx, scope).lockAction(request.actionId);

  const existing = await receipts.findByActionId(request.actionId);
  if (existing !== null) {
    return {
      precheckId: existing.id,
      decision: existing.decision,
      reason: existing.denyReason,
      replayed: true,
    };
  }

  // 2. Agent, resolved inside this workspace. Both predicates: a globally
  //    unique UUID is not authorization.
  const found = await tx
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(
        eq(agents.workspaceId, workspaceId),
        eq(agents.externalId, request.agentExternalId),
      ),
    )
    .limit(1);
  const agentId = found[0]?.id;
  if (agentId === undefined) {
    throw new Error('agent not seeded');
  }

  // 3. Consistent policy snapshot under FOR SHARE.
  const policy = await createPolicyReadRepository(tx, scope).lockPolicyForDecision(agentId);
  if (policy === null) {
    throw new Error('missing policy state');
  }

  // 4. Ledger, only when this category could commit.
  const tracked = request.category === 'spend' || request.category === 'publish';
  const needsLedger = policy.mode === 'budgeted' && tracked;
  const locked = needsLedger
    ? await createLedgerRepository(tx, scope).lockDailyLedger(agentId, day)
    : null;
  const usage = locked?.current ?? { spendCommittedUsd: '0.000000', publishCountCommitted: 0 };

  // 5. Decide.
  let decision: 'allow' | 'deny' = 'allow';
  let reason: string | null = null;
  let remainingSpend: string | null = null;
  let remainingPublish: number | null = null;

  if (policy.mode === 'paused') {
    decision = 'deny';
    reason = 'paused';
  } else if (policy.mode === 'budgeted' && request.category === 'spend') {
    const committed = toMicros(usage.spendCommittedUsd);
    const requested = toMicros(request.amountUsd ?? '0.000000');
    if (policy.dailySpendCapUsd !== null) {
      const cap = toMicros(policy.dailySpendCapUsd);
      if (committed + requested > cap) {
        decision = 'deny';
        reason = 'daily_spend_cap_exceeded';
        remainingSpend = fromMicros(cap > committed ? cap - committed : 0n);
      } else {
        remainingSpend = fromMicros(cap - (committed + requested));
      }
    }
  } else if (policy.mode === 'budgeted' && request.category === 'publish') {
    if (policy.dailyPublishCap !== null) {
      if (usage.publishCountCommitted + 1 > policy.dailyPublishCap) {
        decision = 'deny';
        reason = 'daily_publish_cap_exceeded';
        remainingPublish = Math.max(policy.dailyPublishCap - usage.publishCountCommitted, 0);
      } else {
        remainingPublish = Math.max(
          policy.dailyPublishCap - (usage.publishCountCommitted + 1),
          0,
        );
      }
    }
  }

  // 6. Commit on allow, only through the locked capability.
  if (decision === 'allow' && locked !== null) {
    if (request.category === 'spend') {
      await locked.commitSpend(request.amountUsd ?? '0.000000');
    } else {
      await locked.commitPublish();
    }
  }

  // 7. Durable receipt, same transaction.
  const receipt = await receipts.insert({
    actionId: request.actionId,
    agentId,
    category: request.category,
    requestedAmountUsd: request.category === 'spend' ? (request.amountUsd ?? null) : null,
    requestedPublishCount: request.category === 'publish' ? 1 : null,
    decision,
    policyVersion: policy.version,
    appliedMode: policy.mode,
    appliedSpendCapUsd: policy.dailySpendCapUsd,
    appliedPublishCap: policy.dailyPublishCap,
    accountingDay: day,
    ledgerSpendBeforeUsd: locked === null ? null : usage.spendCommittedUsd,
    ledgerPublishBefore: locked === null ? null : usage.publishCountCommitted,
    remainingSpendUsd: remainingSpend,
    remainingPublishCount: remainingPublish,
    denyReason: reason,
  });

  // 8. WHOEVER DENIES, RECORDS. The plane block, in the SAME transaction,
  //    linked to the receipt just inserted. An allow writes none.
  if (decision === 'deny' && reason !== null) {
    await createPlaneBlockRepository(tx, scope).createForDeniedPrecheck({
      agentId,
      precheckReceiptId: receipt.id,
      category: request.category,
      rule: RULE_FOR_REASON[reason] ?? reason,
      reason: EXPLANATION_FOR_REASON[reason] ?? reason,
      amountUsd: request.category === 'spend' ? request.amountUsd : undefined,
      count: request.category === 'publish' ? 1 : undefined,
      createdAt: now,
    });
  }

  return { precheckId: receipt.id, decision, reason, replayed: false };
}

describe.skipIf(!hasTestDatabase)('live precheck decisions', () => {
  function getDb(): ReturnType<typeof createDatabaseClient> {
    pool ??= createDatabasePool({
      connectionString: testDatabaseUrl as string,
      maxConnections: 8,
      applicationName: 'hybrid-precheck-live-test',
    });
    return createDatabaseClient(pool);
  }

  async function seedWorkspace(
    executor: DatabaseExecutor,
    name: string,
    policy: { mode: 'watch' | 'budgeted' | 'paused'; spend: string | null; publish: number | null },
    externalId = 'agent-a',
  ): Promise<{ workspaceId: string; agentId: string }> {
    const [ws] = await executor.insert(workspaces).values({ name }).returning();
    const workspaceId = ws?.id ?? '';
    await executor.insert(workspacePolicyState).values({ workspaceId, version: 1 });
    const [agent] = await executor
      .insert(agents)
      .values({ workspaceId, externalId })
      .returning();
    await executor.insert(agentPolicies).values({
      workspaceId,
      agentId: agent?.id ?? '',
      mode: policy.mode,
      dailySpendCapUsd: policy.spend,
      dailyPublishCap: policy.publish,
    });
    return { workspaceId, agentId: agent?.id ?? '' };
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

  it('AC-07 shape: 20, then 5 to the cap, then a denial', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const { workspaceId } = await seedWorkspace(tx, WORKSPACE_A_NAME, {
          mode: 'budgeted',
          spend: '25.000000',
          publish: null,
        });
        const req = (actionId: string, amount: string): Request => ({
          actionId,
          agentExternalId: 'agent-a',
          category: 'spend',
          amountUsd: amount,
        });

        expect((await runPrecheck(tx, workspaceId, req('a1', '20.000000'), NOW)).decision).toBe(
          'allow',
        );
        expect((await runPrecheck(tx, workspaceId, req('a2', '5.000000'), NOW)).decision).toBe(
          'allow',
        );
        const third = await runPrecheck(tx, workspaceId, req('a3', '0.000001'), NOW);
        expect(third.decision).toBe('deny');
        expect(third.reason).toBe('daily_spend_cap_exceeded');

        const ledger = await tx
          .select()
          .from(ledgerDaily)
          .where(eq(ledgerDaily.workspaceId, workspaceId));
        // The denial committed nothing.
        expect(ledger[0]?.spendCommittedUsd).toBe('25.000000');

        const receipts = await tx
          .select()
          .from(precheckReceipts)
          .where(eq(precheckReceipts.workspaceId, workspaceId));
        // EVERY decision produced a receipt.
        expect(receipts).toHaveLength(3);

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('AC-08 shape: $41 against $25 denies and commits nothing', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const { workspaceId } = await seedWorkspace(tx, WORKSPACE_A_NAME, {
          mode: 'budgeted',
          spend: '25.000000',
          publish: null,
        });

        const outcome = await runPrecheck(
          tx,
          workspaceId,
          { actionId: 'a1', agentExternalId: 'agent-a', category: 'spend', amountUsd: '41.000000' },
          NOW,
        );

        expect(outcome.decision).toBe('deny');
        const receipts = await tx
          .select()
          .from(precheckReceipts)
          .where(eq(precheckReceipts.workspaceId, workspaceId));
        expect(receipts[0]?.requestedAmountUsd).toBe('41.000000');
        expect(receipts[0]?.appliedSpendCapUsd).toBe('25.000000');
        expect(receipts[0]?.ledgerSpendBeforeUsd).toBe('0.000000');
        expect(receipts[0]?.remainingSpendUsd).toBe('25.000000');

        const ledger = await tx
          .select()
          .from(ledgerDaily)
          .where(eq(ledgerDaily.workspaceId, workspaceId));
        expect(ledger[0]?.spendCommittedUsd).toBe('0.000000');

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('AC-11 shape: five publishes allowed, the sixth denied', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const { workspaceId } = await seedWorkspace(tx, WORKSPACE_A_NAME, {
          mode: 'budgeted',
          spend: null,
          publish: 5,
        });

        const decisions: string[] = [];
        for (let i = 1; i <= 6; i += 1) {
          decisions.push(
            (
              await runPrecheck(
                tx,
                workspaceId,
                { actionId: `p${String(i)}`, agentExternalId: 'agent-a', category: 'publish' },
                NOW,
              )
            ).decision,
          );
        }

        expect(decisions).toEqual(['allow', 'allow', 'allow', 'allow', 'allow', 'deny']);

        const ledger = await tx
          .select()
          .from(ledgerDaily)
          .where(eq(ledgerDaily.workspaceId, workspaceId));
        expect(ledger[0]?.publishCountCommitted).toBe(5);

        const receipts = await tx
          .select()
          .from(precheckReceipts)
          .where(eq(precheckReceipts.workspaceId, workspaceId));
        expect(receipts).toHaveLength(6);

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('WATCH allows a $41 spend and commits NOTHING', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const { workspaceId } = await seedWorkspace(tx, WORKSPACE_A_NAME, {
          mode: 'watch',
          spend: '25.000000',
          publish: 5,
        });

        const outcome = await runPrecheck(
          tx,
          workspaceId,
          { actionId: 'a1', agentExternalId: 'agent-a', category: 'spend', amountUsd: '41.000000' },
          NOW,
        );

        expect(outcome.decision).toBe('allow');
        // No ledger row at all: watch must not behave as budgeted accounting.
        const ledger = await tx
          .select()
          .from(ledgerDaily)
          .where(eq(ledgerDaily.workspaceId, workspaceId));
        expect(ledger).toEqual([]);
        // The receipt still exists.
        const receipts = await tx
          .select()
          .from(precheckReceipts)
          .where(eq(precheckReceipts.workspaceId, workspaceId));
        expect(receipts).toHaveLength(1);
        expect(receipts[0]?.appliedMode).toBe('watch');

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('UNCAPPED budgeted still records committed usage', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const { workspaceId } = await seedWorkspace(tx, WORKSPACE_A_NAME, {
          mode: 'budgeted',
          spend: null,
          publish: null,
        });

        await runPrecheck(
          tx,
          workspaceId,
          { actionId: 'a1', agentExternalId: 'agent-a', category: 'spend', amountUsd: '41.000000' },
          NOW,
        );

        // If an operator adds a cap later today, the morning's spend is
        // already counted rather than silently forgiven.
        const ledger = await tx
          .select()
          .from(ledgerDaily)
          .where(eq(ledgerDaily.workspaceId, workspaceId));
        expect(ledger[0]?.spendCommittedUsd).toBe('41.000000');

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('PAUSED denies every category and commits nothing', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const { workspaceId } = await seedWorkspace(tx, WORKSPACE_A_NAME, {
          mode: 'paused',
          spend: '100.000000',
          publish: 10,
        });

        for (const category of ['llm_call', 'tool_call', 'spend', 'publish', 'other'] as const) {
          const outcome = await runPrecheck(
            tx,
            workspaceId,
            {
              actionId: `a-${category}`,
              agentExternalId: 'agent-a',
              category,
              ...(category === 'spend' ? { amountUsd: '0.000001' } : {}),
            },
            NOW,
          );
          expect(outcome.decision, category).toBe('deny');
          expect(outcome.reason, category).toBe('paused');
        }

        const ledger = await tx
          .select()
          .from(ledgerDaily)
          .where(eq(ledgerDaily.workspaceId, workspaceId));
        expect(ledger).toEqual([]);

        const receipts = await tx
          .select()
          .from(precheckReceipts)
          .where(eq(precheckReceipts.workspaceId, workspaceId));
        expect(receipts).toHaveLength(5);

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('CONCURRENCY: two spends of $4 against $25 with $20 committed - exactly one allows', async () => {
    // THE commit-on-allow proof. Without row-lock serialization both read $20,
    // both believe $4 fits, and $28 commits past a $25 cap.
    const db = getDb();

    try {
      const { workspaceId } = await seedWorkspace(db, WORKSPACE_A_NAME, {
        mode: 'budgeted',
        spend: '25.000000',
        publish: null,
      });

      await db.transaction(async (tx) =>
        runPrecheck(
          tx,
          workspaceId,
          { actionId: 'seed', agentExternalId: 'agent-a', category: 'spend', amountUsd: '20.000000' },
          NOW,
        ),
      );

      const attempt = (actionId: string): Promise<Outcome> =>
        db.transaction(async (tx) =>
          runPrecheck(
            tx,
            workspaceId,
            { actionId, agentExternalId: 'agent-a', category: 'spend', amountUsd: '4.000000' },
            NOW,
          ),
        );

      const [a, b] = await Promise.all([attempt('c1'), attempt('c2')]);

      // Exactly one allow and one deny - NEVER both allow.
      expect([a.decision, b.decision].sort()).toEqual(['allow', 'deny']);

      const ledger = await db
        .select()
        .from(ledgerDaily)
        .where(eq(ledgerDaily.workspaceId, workspaceId));
      expect(ledger[0]?.spendCommittedUsd).toBe('24.000000');

      const receipts = await db
        .select()
        .from(precheckReceipts)
        .where(eq(precheckReceipts.workspaceId, workspaceId));
      // Both decisions are recorded, including the denial.
      expect(receipts).toHaveLength(3);
    } finally {
      await cleanup(db);
    }
  });

  it('CONCURRENCY: two $2 spends with $21 committed against $25 both allow', async () => {
    // The boundary case: serialization must not deny an action that genuinely
    // fits. 21 + 2 + 2 = 25, exactly at the cap.
    const db = getDb();

    try {
      const { workspaceId } = await seedWorkspace(db, WORKSPACE_A_NAME, {
        mode: 'budgeted',
        spend: '25.000000',
        publish: null,
      });

      await db.transaction(async (tx) =>
        runPrecheck(
          tx,
          workspaceId,
          { actionId: 'seed', agentExternalId: 'agent-a', category: 'spend', amountUsd: '21.000000' },
          NOW,
        ),
      );

      const attempt = (actionId: string): Promise<Outcome> =>
        db.transaction(async (tx) =>
          runPrecheck(
            tx,
            workspaceId,
            { actionId, agentExternalId: 'agent-a', category: 'spend', amountUsd: '2.000000' },
            NOW,
          ),
        );

      const [a, b] = await Promise.all([attempt('c1'), attempt('c2')]);

      expect([a.decision, b.decision]).toEqual(['allow', 'allow']);
      const ledger = await db
        .select()
        .from(ledgerDaily)
        .where(eq(ledgerDaily.workspaceId, workspaceId));
      expect(ledger[0]?.spendCommittedUsd).toBe('25.000000');

      // And the next positive spend is denied.
      const next = await db.transaction(async (tx) =>
        runPrecheck(
          tx,
          workspaceId,
          { actionId: 'c3', agentExternalId: 'agent-a', category: 'spend', amountUsd: '0.000001' },
          NOW,
        ),
      );
      expect(next.decision).toBe('deny');
    } finally {
      await cleanup(db);
    }
  });

  it('CONCURRENCY: six concurrent publishes against a cap of 5 allow exactly five', async () => {
    const db = getDb();

    try {
      const { workspaceId } = await seedWorkspace(db, WORKSPACE_A_NAME, {
        mode: 'budgeted',
        spend: null,
        publish: 5,
      });

      const outcomes = await Promise.all(
        Array.from({ length: 6 }, (_v, i) =>
          db.transaction(async (tx) =>
            runPrecheck(
              tx,
              workspaceId,
              { actionId: `p${String(i)}`, agentExternalId: 'agent-a', category: 'publish' },
              NOW,
            ),
          ),
        ),
      );

      expect(outcomes.filter((o) => o.decision === 'allow')).toHaveLength(5);
      expect(outcomes.filter((o) => o.decision === 'deny')).toHaveLength(1);

      const ledger = await db
        .select()
        .from(ledgerDaily)
        .where(eq(ledgerDaily.workspaceId, workspaceId));
      expect(ledger[0]?.publishCountCommitted).toBe(5);
    } finally {
      await cleanup(db);
    }
  });

  it('IDEMPOTENCY: a replay returns the original receipt and debits nothing more', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const { workspaceId } = await seedWorkspace(tx, WORKSPACE_A_NAME, {
          mode: 'budgeted',
          spend: '25.000000',
          publish: null,
        });
        const req: Request = {
          actionId: 'a1',
          agentExternalId: 'agent-a',
          category: 'spend',
          amountUsd: '5.000000',
        };

        const first = await runPrecheck(tx, workspaceId, req, NOW);
        const replay = await runPrecheck(tx, workspaceId, req, NOW);

        expect(replay.precheckId).toBe(first.precheckId);
        expect(replay.replayed).toBe(true);

        const ledger = await tx
          .select()
          .from(ledgerDaily)
          .where(eq(ledgerDaily.workspaceId, workspaceId));
        // The retry that would otherwise double-charge.
        expect(ledger[0]?.spendCommittedUsd).toBe('5.000000');

        const receipts = await tx
          .select()
          .from(precheckReceipts)
          .where(eq(precheckReceipts.workspaceId, workspaceId));
        expect(receipts).toHaveLength(1);

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('IDEMPOTENCY: a CHANGED replay does not reinterpret history', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const { workspaceId } = await seedWorkspace(tx, WORKSPACE_A_NAME, {
          mode: 'budgeted',
          spend: '25.000000',
          publish: null,
        });

        const first = await runPrecheck(
          tx,
          workspaceId,
          { actionId: 'a1', agentExternalId: 'agent-a', category: 'spend', amountUsd: '5.000000' },
          NOW,
        );
        const changed = await runPrecheck(
          tx,
          workspaceId,
          { actionId: 'a1', agentExternalId: 'agent-a', category: 'spend', amountUsd: '10.000000' },
          NOW,
        );

        expect(changed.precheckId).toBe(first.precheckId);
        const ledger = await tx
          .select()
          .from(ledgerDaily)
          .where(eq(ledgerDaily.workspaceId, workspaceId));
        expect(ledger[0]?.spendCommittedUsd).toBe('5.000000');

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('CONCURRENCY: two simultaneous retries of ONE action debit once', async () => {
    const db = getDb();

    try {
      const { workspaceId } = await seedWorkspace(db, WORKSPACE_A_NAME, {
        mode: 'budgeted',
        spend: '25.000000',
        publish: null,
      });

      const attempt = (): Promise<Outcome> =>
        db.transaction(async (tx) =>
          runPrecheck(
            tx,
            workspaceId,
            { actionId: 'retry-1', agentExternalId: 'agent-a', category: 'spend', amountUsd: '5.000000' },
            NOW,
          ),
        );

      const [a, b] = await Promise.all([attempt(), attempt()]);

      // Both callers receive the same logical decision.
      expect(a.precheckId).toBe(b.precheckId);
      // Exactly one debit and one receipt.
      const ledger = await db
        .select()
        .from(ledgerDaily)
        .where(eq(ledgerDaily.workspaceId, workspaceId));
      expect(ledger[0]?.spendCommittedUsd).toBe('5.000000');
      const receipts = await db
        .select()
        .from(precheckReceipts)
        .where(eq(precheckReceipts.workspaceId, workspaceId));
      expect(receipts).toHaveLength(1);
    } finally {
      await cleanup(db);
    }
  });

  it('the unique constraint refuses a duplicate action id', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const { workspaceId, agentId } = await seedWorkspace(tx, WORKSPACE_A_NAME, {
          mode: 'watch',
          spend: null,
          publish: null,
        });
        const row = {
          workspaceId,
          actionId: 'dupe',
          agentId,
          category: 'other' as const,
          decision: 'allow' as const,
          policyVersion: 1,
          appliedMode: 'watch' as const,
        };

        await tx.insert(precheckReceipts).values(row);
        // The database, not application discipline, is the idempotency
        // boundary of last resort.
        await expect(tx.insert(precheckReceipts).values(row)).rejects.toThrow();

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('ATOMICITY: a failed receipt insert rolls the debit back', async () => {
    const db = getDb();

    try {
      const { workspaceId } = await seedWorkspace(db, WORKSPACE_A_NAME, {
        mode: 'budgeted',
        spend: '25.000000',
        publish: null,
      });

      // An allow-deny check constraint violation: a denial with no reason.
      // Forces the receipt insert to fail AFTER the debit has been applied.
      await expect(
        db.transaction(async (tx) => {
          const scope = createWorkspaceScope(workspaceId);
          const agentRows = await tx
            .select({ id: agents.id })
            .from(agents)
            .where(eq(agents.workspaceId, workspaceId));
          const agentId = agentRows[0]?.id ?? '';

          const locked = await createLedgerRepository(tx, scope).lockDailyLedger(agentId, DAY);
          await locked?.commitSpend('5.000000');

          await createPrecheckReceiptRepository(tx, scope).insert({
            actionId: 'a1',
            agentId,
            category: 'spend',
            requestedAmountUsd: '5.000000',
            requestedPublishCount: null,
            decision: 'deny',
            policyVersion: '1',
            appliedMode: 'budgeted',
            appliedSpendCapUsd: '25.000000',
            appliedPublishCap: null,
            accountingDay: DAY,
            ledgerSpendBeforeUsd: '0.000000',
            ledgerPublishBefore: 0,
            remainingSpendUsd: '20.000000',
            remainingPublishCount: null,
            // A denial with no reason violates the check constraint.
            denyReason: null,
          });
        }),
      ).rejects.toThrow();

      // NEITHER HALF SURVIVED. Money spent but unexplainable is worse than a
      // failed request.
      const ledger = await db
        .select()
        .from(ledgerDaily)
        .where(eq(ledgerDaily.workspaceId, workspaceId));
      expect(ledger).toEqual([]);
      const receipts = await db
        .select()
        .from(precheckReceipts)
        .where(eq(precheckReceipts.workspaceId, workspaceId));
      expect(receipts).toEqual([]);
    } finally {
      await cleanup(db);
    }
  });

  it('the receipt records the EXACT policy version, unchanged by later mutation', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const { workspaceId } = await seedWorkspace(tx, WORKSPACE_A_NAME, {
          mode: 'budgeted',
          spend: '25.000000',
          publish: null,
        });

        await runPrecheck(
          tx,
          workspaceId,
          { actionId: 'a1', agentExternalId: 'agent-a', category: 'spend', amountUsd: '1.000000' },
          NOW,
        );

        // The operator changes policy afterwards.
        await tx
          .update(workspacePolicyState)
          .set({ version: 9 })
          .where(eq(workspacePolicyState.workspaceId, workspaceId));

        const receipts = await tx
          .select()
          .from(precheckReceipts)
          .where(eq(precheckReceipts.workspaceId, workspaceId));
        // The receipt still cites the version that decided it.
        expect(receipts[0]?.policyVersion).toBe(1);

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('CROSS-TENANT: two workspaces decide independently on a shared agent name', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const a = await seedWorkspace(
          tx,
          WORKSPACE_A_NAME,
          { mode: 'paused', spend: null, publish: null },
          'agent-1',
        );
        const b = await seedWorkspace(
          tx,
          WORKSPACE_B_NAME,
          { mode: 'budgeted', spend: '100.000000', publish: null },
          'agent-1',
        );

        const fromA = await runPrecheck(
          tx,
          a.workspaceId,
          { actionId: 'shared', agentExternalId: 'agent-1', category: 'spend', amountUsd: '1.000000' },
          NOW,
        );
        // The SAME action id in the other workspace is a separate action.
        const fromB = await runPrecheck(
          tx,
          b.workspaceId,
          { actionId: 'shared', agentExternalId: 'agent-1', category: 'spend', amountUsd: '1.000000' },
          NOW,
        );

        expect(fromA.decision).toBe('deny');
        expect(fromB.decision).toBe('allow');
        expect(fromA.precheckId).not.toBe(fromB.precheckId);

        // A's ledger is untouched; B's has the spend.
        const aLedger = await tx
          .select()
          .from(ledgerDaily)
          .where(eq(ledgerDaily.workspaceId, a.workspaceId));
        expect(aLedger).toEqual([]);
        const bLedger = await tx
          .select()
          .from(ledgerDaily)
          .where(eq(ledgerDaily.workspaceId, b.workspaceId));
        expect(bLedger[0]?.spendCommittedUsd).toBe('1.000000');

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it("CROSS-TENANT: a receipt is invisible to the other workspace", async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const a = await seedWorkspace(tx, WORKSPACE_A_NAME, {
          mode: 'watch',
          spend: null,
          publish: null,
        });
        const b = await seedWorkspace(
          tx,
          WORKSPACE_B_NAME,
          { mode: 'watch', spend: null, publish: null },
          'bobs-agent',
        );

        const outcome = await runPrecheck(
          tx,
          b.workspaceId,
          { actionId: 'bobs-action', agentExternalId: 'bobs-agent', category: 'other' },
          NOW,
        );

        const fromA = createPrecheckReceiptRepository(tx, createWorkspaceScope(a.workspaceId));
        expect(await fromA.findByActionId('bobs-action')).toBeNull();
        expect(await fromA.exists(outcome.precheckId)).toBe(false);

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('DIFFERENT AGENTS do not serialize on each other', async () => {
    const db = getDb();

    try {
      const { workspaceId } = await seedWorkspace(db, WORKSPACE_A_NAME, {
        mode: 'budgeted',
        spend: '25.000000',
        publish: null,
      });
      const [second] = await db
        .insert(agents)
        .values({ workspaceId, externalId: 'agent-b' })
        .returning();
      await db.insert(agentPolicies).values({
        workspaceId,
        agentId: second?.id ?? '',
        mode: 'budgeted',
        dailySpendCapUsd: '25.000000',
      });

      const [a, b] = await Promise.all([
        db.transaction(async (tx) =>
          runPrecheck(
            tx,
            workspaceId,
            { actionId: 'x1', agentExternalId: 'agent-a', category: 'spend', amountUsd: '25.000000' },
            NOW,
          ),
        ),
        db.transaction(async (tx) =>
          runPrecheck(
            tx,
            workspaceId,
            { actionId: 'x2', agentExternalId: 'agent-b', category: 'spend', amountUsd: '25.000000' },
            NOW,
          ),
        ),
      ]);

      // Separate ledger rows, separate budgets: both allow.
      expect([a.decision, b.decision]).toEqual(['allow', 'allow']);
      const ledger = await db
        .select()
        .from(ledgerDaily)
        .where(eq(ledgerDaily.workspaceId, workspaceId));
      expect(ledger).toHaveLength(2);
    } finally {
      await cleanup(db);
    }
  });

  it('AC-08: the denial commits a receipt AND a plane block together', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const { workspaceId } = await seedWorkspace(tx, WORKSPACE_A_NAME, {
          mode: 'budgeted',
          spend: '25.000000',
          publish: null,
        });

        const outcome = await runPrecheck(
          tx,
          workspaceId,
          { actionId: 'a1', agentExternalId: 'agent-a', category: 'spend', amountUsd: '41.000000' },
          NOW,
        );
        expect(outcome.decision).toBe('deny');

        const blockRows = await tx.select().from(blocks).where(eq(blocks.workspaceId, workspaceId));
        expect(blockRows).toHaveLength(1);
        const block = blockRows[0];

        // Plane-owned, with no external identity.
        expect(block?.source).toBe('plane');
        expect(block?.externalBlockId).toBeNull();
        // Linked to the receipt that explains it - the FK direction the Step 3
        // schema chose, so the receipt itself never needed updating.
        expect(block?.precheckReceiptId).toBe(outcome.precheckId);
        expect(block?.category).toBe('spend');
        expect(block?.rule).toBe('daily_spend_cap');
        expect(block?.amountUsd).toBe('41.000000');
        expect(block?.count).toBeNull();

        // And the ledger is untouched.
        const ledger = await tx
          .select()
          .from(ledgerDaily)
          .where(eq(ledgerDaily.workspaceId, workspaceId));
        expect(ledger[0]?.spendCommittedUsd).toBe('0.000000');

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('the reverse lookup finds a receipt block', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const { workspaceId } = await seedWorkspace(tx, WORKSPACE_A_NAME, {
          mode: 'paused',
          spend: null,
          publish: null,
        });

        const outcome = await runPrecheck(
          tx,
          workspaceId,
          { actionId: 'a1', agentExternalId: 'agent-a', category: 'other' },
          NOW,
        );

        // Both directions remain queryable even though the FK is modelled once.
        const found = await createPlaneBlockRepository(
          tx,
          createWorkspaceScope(workspaceId),
        ).findByReceiptId(outcome.precheckId);
        expect(found?.rule).toBe('agent_paused');
        expect(found?.reason).toBe('Agent is paused.');

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('NO BLOCK on any allowed decision', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const { workspaceId } = await seedWorkspace(tx, WORKSPACE_A_NAME, {
          mode: 'budgeted',
          spend: '25.000000',
          publish: 5,
        });

        for (const [i, category] of (['spend', 'publish', 'llm_call', 'other'] as const).entries()) {
          const outcome = await runPrecheck(
            tx,
            workspaceId,
            {
              actionId: `a${String(i)}`,
              agentExternalId: 'agent-a',
              category,
              ...(category === 'spend' ? { amountUsd: '1.000000' } : {}),
            },
            NOW,
          );
          expect(outcome.decision, category).toBe('allow');
        }

        const blockRows = await tx.select().from(blocks).where(eq(blocks.workspaceId, workspaceId));
        expect(blockRows).toEqual([]);

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('AC-11: exactly one block for the sixth publish', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const { workspaceId } = await seedWorkspace(tx, WORKSPACE_A_NAME, {
          mode: 'budgeted',
          spend: null,
          publish: 5,
        });

        for (let i = 1; i <= 6; i += 1) {
          await runPrecheck(
            tx,
            workspaceId,
            { actionId: `p${String(i)}`, agentExternalId: 'agent-a', category: 'publish' },
            NOW,
          );
        }

        const blockRows = await tx.select().from(blocks).where(eq(blocks.workspaceId, workspaceId));
        expect(blockRows).toHaveLength(1);
        expect(blockRows[0]?.rule).toBe('daily_publish_cap');
        // Publish metadata in the count column, never the spend column.
        expect(blockRows[0]?.count).toBe(1);
        expect(blockRows[0]?.amountUsd).toBeNull();

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('ATOMICITY: a failed receipt leaves no block', async () => {
    const db = getDb();

    try {
      const { workspaceId } = await seedWorkspace(db, WORKSPACE_A_NAME, {
        mode: 'budgeted',
        spend: '25.000000',
        publish: null,
      });

      // A denial with no reason violates the receipt check constraint, so the
      // receipt insert fails inside a transaction that would have written a
      // block.
      await expect(
        db.transaction(async (tx) => {
          const scope = createWorkspaceScope(workspaceId);
          const agentRows = await tx
            .select({ id: agents.id })
            .from(agents)
            .where(eq(agents.workspaceId, workspaceId));
          const agentId = agentRows[0]?.id ?? '';

          const receipt = await createPrecheckReceiptRepository(tx, scope).insert({
            actionId: 'a1',
            agentId,
            category: 'spend',
            requestedAmountUsd: '41.000000',
            requestedPublishCount: null,
            decision: 'deny',
            policyVersion: '1',
            appliedMode: 'budgeted',
            appliedSpendCapUsd: '25.000000',
            appliedPublishCap: null,
            accountingDay: DAY,
            ledgerSpendBeforeUsd: '0.000000',
            ledgerPublishBefore: 0,
            remainingSpendUsd: '25.000000',
            remainingPublishCount: null,
            denyReason: null,
          });
          await createPlaneBlockRepository(tx, scope).createForDeniedPrecheck({
            agentId,
            precheckReceiptId: receipt.id,
            category: 'spend',
            rule: 'daily_spend_cap',
            reason: 'Daily spend cap reached.',
            amountUsd: '41.000000',
            createdAt: NOW,
          });
        }),
      ).rejects.toThrow();

      const blockRows = await db.select().from(blocks).where(eq(blocks.workspaceId, workspaceId));
      const receiptRows = await db
        .select()
        .from(precheckReceipts)
        .where(eq(precheckReceipts.workspaceId, workspaceId));
      // NEITHER artifact survived.
      expect(blockRows).toEqual([]);
      expect(receiptRows).toEqual([]);
    } finally {
      await cleanup(db);
    }
  });

  it('ATOMICITY: a failed BLOCK leaves no receipt and no ledger effect', async () => {
    const db = getDb();

    try {
      const { workspaceId } = await seedWorkspace(db, WORKSPACE_A_NAME, {
        mode: 'budgeted',
        spend: '25.000000',
        publish: null,
      });

      // An empty rule violates the block check constraint, failing the insert
      // after the receipt has been written.
      await expect(
        db.transaction(async (tx) => {
          const scope = createWorkspaceScope(workspaceId);
          const agentRows = await tx
            .select({ id: agents.id })
            .from(agents)
            .where(eq(agents.workspaceId, workspaceId));
          const agentId = agentRows[0]?.id ?? '';

          const locked = await createLedgerRepository(tx, scope).lockDailyLedger(agentId, DAY);
          await locked?.commitSpend('5.000000');

          const receipt = await createPrecheckReceiptRepository(tx, scope).insert({
            actionId: 'a1',
            agentId,
            category: 'spend',
            requestedAmountUsd: '41.000000',
            requestedPublishCount: null,
            decision: 'deny',
            policyVersion: '1',
            appliedMode: 'budgeted',
            appliedSpendCapUsd: '25.000000',
            appliedPublishCap: null,
            accountingDay: DAY,
            ledgerSpendBeforeUsd: '0.000000',
            ledgerPublishBefore: 0,
            remainingSpendUsd: '25.000000',
            remainingPublishCount: null,
            denyReason: 'daily_spend_cap_exceeded',
          });
          await createPlaneBlockRepository(tx, scope).createForDeniedPrecheck({
            agentId,
            precheckReceiptId: receipt.id,
            category: 'spend',
            rule: '',
            reason: 'Daily spend cap reached.',
            createdAt: NOW,
          });
        }),
      ).rejects.toThrow();

      const blockRows = await db.select().from(blocks).where(eq(blocks.workspaceId, workspaceId));
      const receiptRows = await db
        .select()
        .from(precheckReceipts)
        .where(eq(precheckReceipts.workspaceId, workspaceId));
      const ledger = await db
        .select()
        .from(ledgerDaily)
        .where(eq(ledgerDaily.workspaceId, workspaceId));
      // Every governance artifact succeeded together or not at all.
      expect(blockRows).toEqual([]);
      expect(receiptRows).toEqual([]);
      expect(ledger).toEqual([]);
    } finally {
      await cleanup(db);
    }
  });

  it('CONCURRENCY: two simultaneous denials of one action create ONE block', async () => {
    const db = getDb();

    try {
      const { workspaceId } = await seedWorkspace(db, WORKSPACE_A_NAME, {
        mode: 'paused',
        spend: null,
        publish: null,
      });

      const attempt = (): Promise<Outcome> =>
        db.transaction(async (tx) =>
          runPrecheck(
            tx,
            workspaceId,
            { actionId: 'retry-1', agentExternalId: 'agent-a', category: 'other' },
            NOW,
          ),
        );

      const [a, b] = await Promise.all([attempt(), attempt()]);

      // Both callers observe the same logical decision.
      expect(a.precheckId).toBe(b.precheckId);
      const receiptRows = await db
        .select()
        .from(precheckReceipts)
        .where(eq(precheckReceipts.workspaceId, workspaceId));
      const blockRows = await db.select().from(blocks).where(eq(blocks.workspaceId, workspaceId));
      expect(receiptRows).toHaveLength(1);
      // Exactly one block - a retry must not double-record a refusal.
      expect(blockRows).toHaveLength(1);
    } finally {
      await cleanup(db);
    }
  });

  it('a CHANGED replay of a denial creates no alternate block', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const { workspaceId } = await seedWorkspace(tx, WORKSPACE_A_NAME, {
          mode: 'budgeted',
          spend: '25.000000',
          publish: 5,
        });

        await runPrecheck(
          tx,
          workspaceId,
          { actionId: 'a1', agentExternalId: 'agent-a', category: 'spend', amountUsd: '41.000000' },
          NOW,
        );
        await runPrecheck(
          tx,
          workspaceId,
          { actionId: 'a1', agentExternalId: 'agent-a', category: 'publish' },
          NOW,
        );

        const blockRows = await tx.select().from(blocks).where(eq(blocks.workspaceId, workspaceId));
        expect(blockRows).toHaveLength(1);
        // The original block still describes the original refusal.
        expect(blockRows[0]?.category).toBe('spend');
        expect(blockRows[0]?.amountUsd).toBe('41.000000');

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('a runtime block and a plane block coexist without colliding', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const { workspaceId } = await seedWorkspace(tx, WORKSPACE_A_NAME, {
          mode: 'paused',
          spend: null,
          publish: null,
        });
        const agentRows = await tx
          .select({ id: agents.id })
          .from(agents)
          .where(eq(agents.workspaceId, workspaceId));
        const agentId = agentRows[0]?.id ?? '';

        // A runtime-reported denial, as event ingest would write it.
        await tx.insert(blocks).values({
          workspaceId,
          agentId,
          source: 'runtime',
          externalBlockId: 'client-block-1',
          category: 'publish',
          rule: 'client_rule',
          reason: 'Runtime refused.',
        });
        // Two plane denials, both with NULL external ids.
        for (const actionId of ['a1', 'a2']) {
          await runPrecheck(
            tx,
            workspaceId,
            { actionId, agentExternalId: 'agent-a', category: 'other' },
            NOW,
          );
        }

        const all = await tx.select().from(blocks).where(eq(blocks.workspaceId, workspaceId));
        expect(all).toHaveLength(3);
        // Multiple NULL external ids coexist under the unique constraint,
        // because PostgreSQL treats NULLs as distinct.
        expect(all.filter((b) => b.source === 'plane')).toHaveLength(2);
        expect(all.filter((b) => b.source === 'runtime')).toHaveLength(1);
        // Ownership stays unambiguous, and the runtime block is untouched.
        expect(all.find((b) => b.source === 'runtime')?.externalBlockId).toBe('client-block-1');
        expect(all.filter((b) => b.source === 'plane').every((b) => b.externalBlockId === null)).toBe(
          true,
        );

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it("CROSS-TENANT: a block cannot reference another workspace's receipt", async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const a = await seedWorkspace(tx, WORKSPACE_A_NAME, {
          mode: 'paused',
          spend: null,
          publish: null,
        });
        const b = await seedWorkspace(
          tx,
          WORKSPACE_B_NAME,
          { mode: 'paused', spend: null, publish: null },
          'bobs-agent',
        );

        const bobs = await runPrecheck(
          tx,
          b.workspaceId,
          { actionId: 'bobs', agentExternalId: 'bobs-agent', category: 'other' },
          NOW,
        );

        const aAgents = await tx
          .select({ id: agents.id })
          .from(agents)
          .where(eq(agents.workspaceId, a.workspaceId));

        // The composite FK to (workspace_id, id) makes this impossible at the
        // database level, not merely in application code.
        await expect(
          createPlaneBlockRepository(tx, createWorkspaceScope(a.workspaceId)).createForDeniedPrecheck(
            {
              agentId: aAgents[0]?.id ?? '',
              precheckReceiptId: bobs.precheckId,
              category: 'other',
              rule: 'agent_paused',
              reason: 'Agent is paused.',
              createdAt: NOW,
            },
          ),
        ).rejects.toThrow();

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it("CROSS-TENANT: the reverse lookup cannot see another workspace's block", async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const a = await seedWorkspace(tx, WORKSPACE_A_NAME, {
          mode: 'paused',
          spend: null,
          publish: null,
        });
        const b = await seedWorkspace(
          tx,
          WORKSPACE_B_NAME,
          { mode: 'paused', spend: null, publish: null },
          'bobs-agent',
        );

        const bobs = await runPrecheck(
          tx,
          b.workspaceId,
          { actionId: 'bobs', agentExternalId: 'bobs-agent', category: 'other' },
          NOW,
        );

        // Holding Bob's exact receipt id, A's scope finds nothing.
        const found = await createPlaneBlockRepository(
          tx,
          createWorkspaceScope(a.workspaceId),
        ).findByReceiptId(bobs.precheckId);
        expect(found).toBeNull();

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
