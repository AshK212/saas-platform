import { eq, inArray } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { toUtcAccountingDay } from '../src/accounting/utc-day';
import { closeDatabasePool, createDatabaseClient, createDatabasePool } from '../src/client';
import { createAgentRepository } from '../src/repositories/agents';
import { createEventRepository } from '../src/repositories/events';
import { createIngestLockRepository } from '../src/repositories/ingest-locks';
import { createLedgerRepository } from '../src/repositories/ledger';
import { createPrecheckReceiptRepository } from '../src/repositories/receipts';
import { createWorkspaceScope } from '../src/repositories/workspace-scope';
import type { DatabaseExecutor } from '../src/repositories/executor';
import { agents } from '../src/schema/agents';
import { blocks } from '../src/schema/blocks';
import { events } from '../src/schema/events';
import { ledgerDaily } from '../src/schema/ledger';
import { agentPolicies, workspacePolicyState } from '../src/schema/policy';
import { precheckReceipts } from '../src/schema/receipts';
import { workspaces } from '../src/schema/workspaces';

/**
 * LIVE precheck-linked settlement against real PostgreSQL (Step 18).
 *
 * SAFETY - READ BEFORE CHANGING THE GATE
 * --------------------------------------
 * This suite WRITES DATA. It is gated on `TEST_DATABASE_URL` and **never falls
 * back to `DATABASE_URL`**. Writes are rolled back or explicitly cleaned up;
 * nothing is dropped or truncated. The connection string is never logged.
 *
 * WHY IT EXISTS SEPARATELY
 * ------------------------
 * The in-process suite runs two FAKES - the precheck store owns a ledger, the
 * event store owns none - so "the event did not debit" is nearly true by
 * construction there. Only here do both paths touch ONE `ledger_daily` table,
 * which is the only setting in which the headline claim can actually fail:
 *
 *   precheck $4 -> ledger 4.000000
 *   follow-up event -> ledger STILL 4.000000, not 8.000000
 *
 * Also provable only here: that the workspace predicate genuinely hides
 * another tenant's receipt, and that two concurrent replays of one linked
 * event produce exactly one row and zero accounting.
 *
 * `settleEvent` below TRANSCRIBES the ingest path from
 * `apps/api/src/events/store.ts`, because `packages/db` cannot import from
 * `apps/`. Divergence should be visible reading them side by side, and a drift
 * guard in `apps/api` - which depends on both - checks the parts that matter.
 */

const testDatabaseUrl = process.env['TEST_DATABASE_URL']?.trim();
const hasTestDatabase = testDatabaseUrl !== undefined && testDatabaseUrl !== '';

const WORKSPACE_A_NAME = 'live-settlement-alpha';
const WORKSPACE_B_NAME = 'live-settlement-bravo';
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

/** Exact micro-dollar comparison, matching `apps/api/src/events/settlement.ts`. */
function toMicros(value: string): bigint {
  const [whole = '0', fraction = ''] = value.split('.');
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
}

/** A follow-up event, in the shape ingest receives. */
interface LinkedEvent {
  readonly eventId: string;
  readonly agentExternalId: string;
  readonly type: 'spend.recorded' | 'agent.action' | 'action.blocked' | 'heartbeat';
  readonly category?: 'llm_call' | 'tool_call' | 'spend' | 'publish' | 'other';
  readonly amountUsd?: string;
  readonly precheckId?: string;
}

interface SettleOutcome {
  readonly accepted: number;
  readonly duplicates: number;
  readonly rejected: string | null;
}

/**
 * Transcription of the production ingest path for ONE event.
 *
 * Kept deliberately literal and in the same order, so a drift from
 * `apps/api/src/events/store.ts` is visible on inspection. The two properties
 * it must preserve are the two that fail silently: the duplicate decision
 * comes FIRST, and nothing on this path touches the ledger.
 */
async function settleEvent(
  tx: DatabaseExecutor,
  workspaceId: string,
  event: LinkedEvent,
  now: Date,
): Promise<SettleOutcome> {
  const scope = createWorkspaceScope(workspaceId);
  const agentRepo = createAgentRepository(tx, scope);
  const eventRepo = createEventRepository(tx, scope);
  const receiptRepo = createPrecheckReceiptRepository(tx, scope);

  await createIngestLockRepository(tx, scope).lockEvents([event.eventId]);

  // 1. THE DUPLICATE DECISION, BEFORE ANY SIDE EFFECT.
  if ((await eventRepo.findByEventId(event.eventId)) !== null) {
    return { accepted: 0, duplicates: 1, rejected: null };
  }

  // 2. Agent discovery.
  const agent = await agentRepo.discover(event.agentExternalId, now);

  // 3. Precheck linkage - resolve scoped, then validate the claim.
  let precheckReceiptId: string | undefined;
  if (event.precheckId !== undefined) {
    const receipt = await receiptRepo.findById(event.precheckId);
    if (receipt === null) {
      return { accepted: 0, duplicates: 0, rejected: 'Unknown precheck_id for this workspace.' };
    }

    const category = event.type === 'spend.recorded' ? 'spend' : (event.category ?? null);
    const assertsSuccess = event.type === 'spend.recorded' || event.type === 'agent.action';

    if (receipt.agentId !== agent.id) {
      return { accepted: 0, duplicates: 0, rejected: 'precheck_id belongs to a different agent.' };
    }
    if (category === null) {
      return { accepted: 0, duplicates: 0, rejected: 'A heartbeat cannot reference a precheck.' };
    }
    if (assertsSuccess && receipt.decision === 'deny') {
      return { accepted: 0, duplicates: 0, rejected: 'precheck_id references a denied decision.' };
    }
    if (receipt.category !== category) {
      return { accepted: 0, duplicates: 0, rejected: 'wrong category' };
    }
    if (event.amountUsd !== undefined) {
      if (
        receipt.requestedAmountUsd === null ||
        toMicros(event.amountUsd) !== toMicros(receipt.requestedAmountUsd)
      ) {
        return { accepted: 0, duplicates: 0, rejected: 'wrong amount' };
      }
    }
    precheckReceiptId = receipt.id;
  }

  // 4. The insert. NO LEDGER ACCESS ANYWHERE ON THIS PATH.
  const inserted = await eventRepo.insertIfNew({
    eventId: event.eventId,
    agentId: agent.id,
    type: event.type,
    category: event.category ?? null,
    payload: event,
    precheckReceiptId,
    receivedAt: now,
  });

  if (inserted === null) {
    return { accepted: 0, duplicates: 1, rejected: null };
  }

  await agentRepo.touchLastSeen(agent.id, now);
  return { accepted: 1, duplicates: 0, rejected: null };
}

describe.skipIf(!hasTestDatabase)('live precheck-linked settlement', () => {
  function getDb(): ReturnType<typeof createDatabaseClient> {
    pool ??= createDatabasePool({
      connectionString: testDatabaseUrl as string,
      maxConnections: 8,
      applicationName: 'hybrid-settlement-live-test',
    });
    return createDatabaseClient(pool);
  }

  async function seedWorkspace(
    executor: DatabaseExecutor,
    name: string,
    externalId = 'agent-a',
  ): Promise<{ workspaceId: string; agentId: string }> {
    const [ws] = await executor.insert(workspaces).values({ name }).returning();
    const workspaceId = ws?.id ?? '';
    await executor.insert(workspacePolicyState).values({ workspaceId, version: 1 });
    const [agent] = await executor.insert(agents).values({ workspaceId, externalId }).returning();
    const agentId = agent?.id ?? '';
    await executor.insert(agentPolicies).values({
      workspaceId,
      agentId,
      mode: 'budgeted',
      dailySpendCapUsd: '25.000000',
      dailyPublishCap: 5,
    });
    return { workspaceId, agentId };
  }

  /**
   * A precheck ALLOW that debits the ledger and records its receipt.
   *
   * The Step 15 shape, compressed: lock today's row, commit, then insert the
   * receipt in the same transaction.
   */
  async function allowedPrecheck(
    tx: DatabaseExecutor,
    workspaceId: string,
    agentId: string,
    options: {
      actionId?: string;
      category?: 'llm_call' | 'tool_call' | 'spend' | 'publish' | 'other';
      amountUsd?: string | null;
      decision?: 'allow' | 'deny';
      commit?: boolean;
    } = {},
  ): Promise<string> {
    const scope = createWorkspaceScope(workspaceId);
    const category = options.category ?? 'spend';
    const amountUsd = options.amountUsd === undefined ? '4.000000' : options.amountUsd;
    const decision = options.decision ?? 'allow';
    const commit = options.commit ?? decision === 'allow';

    let spendBefore: string | null = null;
    if (commit) {
      const locked = await createLedgerRepository(tx, scope).lockDailyLedger(agentId, DAY);
      spendBefore = locked?.current.spendCommittedUsd ?? '0.000000';
      if (locked !== null) {
        if (category === 'spend' && amountUsd !== null) {
          await locked.commitSpend(amountUsd);
        } else if (category === 'publish') {
          await locked.commitPublish();
        }
      }
    }

    const receipt = await createPrecheckReceiptRepository(tx, scope).insert({
      actionId: options.actionId ?? `act-${category}-${String(amountUsd)}`,
      agentId,
      category,
      requestedAmountUsd: category === 'spend' ? amountUsd : null,
      requestedPublishCount: category === 'publish' ? 1 : null,
      decision,
      policyVersion: '1',
      appliedMode: 'budgeted',
      appliedSpendCapUsd: '25.000000',
      appliedPublishCap: 5,
      accountingDay: DAY,
      ledgerSpendBeforeUsd: spendBefore,
      ledgerPublishBefore: null,
      remainingSpendUsd: null,
      remainingPublishCount: null,
      denyReason: decision === 'deny' ? 'daily_spend_cap_exceeded' : null,
    });
    return receipt.id;
  }

  /** Today's committed spend. Absent row reads as zero, per Step 17 semantics. */
  async function committedSpend(
    executor: DatabaseExecutor,
    workspaceId: string,
    agentId: string,
  ): Promise<string> {
    const row = await createLedgerRepository(
      executor,
      createWorkspaceScope(workspaceId),
    ).findDailyLedger(agentId, DAY);
    return row?.spendCommittedUsd ?? '0.000000';
  }

  async function cleanup(db: ReturnType<typeof createDatabaseClient>): Promise<void> {
    const rows = await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(inArray(workspaces.name, ALL_NAMES));
    for (const row of rows) {
      // Events reference receipts and blocks; both go after it.
      await db.delete(events).where(eq(events.workspaceId, row.id));
      await db.delete(blocks).where(eq(blocks.workspaceId, row.id));
      await db.delete(precheckReceipts).where(eq(precheckReceipts.workspaceId, row.id));
      await db.delete(ledgerDaily).where(eq(ledgerDaily.workspaceId, row.id));
      await db.delete(agentPolicies).where(eq(agentPolicies.workspaceId, row.id));
      await db.delete(agents).where(eq(agents.workspaceId, row.id));
      await db.delete(workspacePolicyState).where(eq(workspacePolicyState.workspaceId, row.id));
    }
    await db.delete(workspaces).where(inArray(workspaces.name, ALL_NAMES));
  }

  it('1. THE HEADLINE: precheck commits $4, the follow-up event commits nothing', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const { workspaceId, agentId } = await seedWorkspace(tx, WORKSPACE_A_NAME);
        expect(await committedSpend(tx, workspaceId, agentId)).toBe('0.000000');

        const receiptId = await allowedPrecheck(tx, workspaceId, agentId);
        expect(await committedSpend(tx, workspaceId, agentId)).toBe('4.000000');

        const outcome = await settleEvent(
          tx,
          workspaceId,
          {
            eventId: 'evt-1',
            agentExternalId: 'agent-a',
            type: 'spend.recorded',
            amountUsd: '4.000000',
            precheckId: receiptId,
          },
          NOW,
        );

        expect(outcome).toEqual({ accepted: 1, duplicates: 0, rejected: null });
        // $4, NOT $8. One real ledger table, both paths.
        expect(await committedSpend(tx, workspaceId, agentId)).toBe('4.000000');

        const stored = await tx.select().from(events).where(eq(events.workspaceId, workspaceId));
        expect(stored).toHaveLength(1);
        expect(stored[0]?.precheckReceiptId).toBe(receiptId);
        // Receipt count unchanged, receipt itself unchanged.
        const receipts = await tx
          .select()
          .from(precheckReceipts)
          .where(eq(precheckReceipts.workspaceId, workspaceId));
        expect(receipts).toHaveLength(1);
        expect(receipts[0]?.decision).toBe('allow');

        throw new Rollback();
      });
    } catch (error: unknown) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('2. a duplicate linked event adds no event and no accounting', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const { workspaceId, agentId } = await seedWorkspace(tx, WORKSPACE_A_NAME);
        const receiptId = await allowedPrecheck(tx, workspaceId, agentId);
        const event: LinkedEvent = {
          eventId: 'evt-1',
          agentExternalId: 'agent-a',
          type: 'spend.recorded',
          amountUsd: '4.000000',
          precheckId: receiptId,
        };

        expect(await settleEvent(tx, workspaceId, event, NOW)).toEqual({
          accepted: 1,
          duplicates: 0,
          rejected: null,
        });
        expect(await settleEvent(tx, workspaceId, event, NOW)).toEqual({
          accepted: 0,
          duplicates: 1,
          rejected: null,
        });

        expect(
          await tx.select().from(events).where(eq(events.workspaceId, workspaceId)),
        ).toHaveLength(1);
        expect(await committedSpend(tx, workspaceId, agentId)).toBe('4.000000');

        throw new Rollback();
      });
    } catch (error: unknown) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('3. a changed replay creates no alternate linkage and no accounting', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const { workspaceId, agentId } = await seedWorkspace(tx, WORKSPACE_A_NAME);
        const real = await allowedPrecheck(tx, workspaceId, agentId, { actionId: 'act-1' });
        const other = await allowedPrecheck(tx, workspaceId, agentId, {
          actionId: 'act-2',
          amountUsd: '9.000000',
        });

        await settleEvent(
          tx,
          workspaceId,
          {
            eventId: 'evt-1',
            agentExternalId: 'agent-a',
            type: 'spend.recorded',
            amountUsd: '4.000000',
            precheckId: real,
          },
          NOW,
        );
        const spendAfterFirst = await committedSpend(tx, workspaceId, agentId);

        // Same event id, different receipt AND a different amount. The
        // duplicate decision precedes validation, so this is a plain replay -
        // not a 400, and not a rewrite.
        const replay = await settleEvent(
          tx,
          workspaceId,
          {
            eventId: 'evt-1',
            agentExternalId: 'agent-a',
            type: 'spend.recorded',
            amountUsd: '9.000000',
            precheckId: other,
          },
          NOW,
        );

        expect(replay).toEqual({ accepted: 0, duplicates: 1, rejected: null });
        const stored = await tx.select().from(events).where(eq(events.workspaceId, workspaceId));
        expect(stored).toHaveLength(1);
        // The ORIGINAL linkage, unrewritten.
        expect(stored[0]?.precheckReceiptId).toBe(real);
        expect(await committedSpend(tx, workspaceId, agentId)).toBe(spendAfterFirst);

        throw new Rollback();
      });
    } catch (error: unknown) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('4. CROSS-TENANT: a foreign receipt uuid is rejected and stores nothing', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const a = await seedWorkspace(tx, WORKSPACE_A_NAME);
        const b = await seedWorkspace(tx, WORKSPACE_B_NAME);
        const bobsReceipt = await allowedPrecheck(tx, b.workspaceId, b.agentId);

        const outcome = await settleEvent(
          tx,
          a.workspaceId,
          {
            eventId: 'evt-1',
            agentExternalId: 'agent-a',
            type: 'spend.recorded',
            amountUsd: '4.000000',
            precheckId: bobsReceipt,
          },
          NOW,
        );

        // Indistinguishable from a receipt that does not exist - the row is
        // never returned, so nothing in JavaScript had to remember to compare.
        expect(outcome.rejected).toBe('Unknown precheck_id for this workspace.');
        expect(
          await tx.select().from(events).where(eq(events.workspaceId, a.workspaceId)),
        ).toHaveLength(0);
        // Bob's accounting is untouched.
        expect(await committedSpend(tx, b.workspaceId, b.agentId)).toBe('4.000000');

        throw new Rollback();
      });
    } catch (error: unknown) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('5. WRONG AGENT: a receipt for agent-a cannot settle agent-b', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const { workspaceId, agentId } = await seedWorkspace(tx, WORKSPACE_A_NAME);
        await tx.insert(agents).values({ workspaceId, externalId: 'agent-b' });
        const receiptId = await allowedPrecheck(tx, workspaceId, agentId);

        const outcome = await settleEvent(
          tx,
          workspaceId,
          {
            eventId: 'evt-1',
            agentExternalId: 'agent-b',
            type: 'spend.recorded',
            amountUsd: '4.000000',
            precheckId: receiptId,
          },
          NOW,
        );

        expect(outcome.rejected).toBe('precheck_id belongs to a different agent.');
        expect(
          await tx.select().from(events).where(eq(events.workspaceId, workspaceId)),
        ).toHaveLength(0);
        expect(await committedSpend(tx, workspaceId, agentId)).toBe('4.000000');

        throw new Rollback();
      });
    } catch (error: unknown) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('6. WRONG CATEGORY: a publish receipt cannot settle a spend', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const { workspaceId, agentId } = await seedWorkspace(tx, WORKSPACE_A_NAME);
        const receiptId = await allowedPrecheck(tx, workspaceId, agentId, {
          category: 'publish',
          amountUsd: null,
        });

        const outcome = await settleEvent(
          tx,
          workspaceId,
          {
            eventId: 'evt-1',
            agentExternalId: 'agent-a',
            type: 'spend.recorded',
            amountUsd: '4.000000',
            precheckId: receiptId,
          },
          NOW,
        );

        expect(outcome.rejected).toBe('wrong category');
        expect(
          await tx.select().from(events).where(eq(events.workspaceId, workspaceId)),
        ).toHaveLength(0);

        throw new Rollback();
      });
    } catch (error: unknown) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('7. WRONG AMOUNT: $41 cannot settle a $4 authorization', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const { workspaceId, agentId } = await seedWorkspace(tx, WORKSPACE_A_NAME);
        const receiptId = await allowedPrecheck(tx, workspaceId, agentId, {
          amountUsd: '4.000000',
        });

        const inflated = await settleEvent(
          tx,
          workspaceId,
          {
            eventId: 'evt-1',
            agentExternalId: 'agent-a',
            type: 'spend.recorded',
            amountUsd: '41.000000',
            precheckId: receiptId,
          },
          NOW,
        );
        expect(inflated.rejected).toBe('wrong amount');

        // One micro-dollar over is also a mismatch.
        const nudged = await settleEvent(
          tx,
          workspaceId,
          {
            eventId: 'evt-2',
            agentExternalId: 'agent-a',
            type: 'spend.recorded',
            amountUsd: '4.000001',
            precheckId: receiptId,
          },
          NOW,
        );
        expect(nudged.rejected).toBe('wrong amount');

        // The equal amount, written differently, IS accepted. `numeric(14,6)`
        // returns `4.000000`, and `"4"` must compare equal to it.
        const equivalent = await settleEvent(
          tx,
          workspaceId,
          {
            eventId: 'evt-3',
            agentExternalId: 'agent-a',
            type: 'spend.recorded',
            amountUsd: '4',
            precheckId: receiptId,
          },
          NOW,
        );
        expect(equivalent).toEqual({ accepted: 1, duplicates: 0, rejected: null });

        expect(
          await tx.select().from(events).where(eq(events.workspaceId, workspaceId)),
        ).toHaveLength(1);
        expect(await committedSpend(tx, workspaceId, agentId)).toBe('4.000000');

        throw new Rollback();
      });
    } catch (error: unknown) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('8. DENIED RECEIPT: cannot evidence a completed spend', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const { workspaceId, agentId } = await seedWorkspace(tx, WORKSPACE_A_NAME);
        const receiptId = await allowedPrecheck(tx, workspaceId, agentId, {
          amountUsd: '41.000000',
          decision: 'deny',
          commit: false,
        });

        const outcome = await settleEvent(
          tx,
          workspaceId,
          {
            eventId: 'evt-1',
            agentExternalId: 'agent-a',
            type: 'spend.recorded',
            amountUsd: '41.000000',
            precheckId: receiptId,
          },
          NOW,
        );

        expect(outcome.rejected).toBe('precheck_id references a denied decision.');
        expect(
          await tx.select().from(events).where(eq(events.workspaceId, workspaceId)),
        ).toHaveLength(0);
        // The denial is untouched and nothing was committed.
        const receipts = await tx
          .select()
          .from(precheckReceipts)
          .where(eq(precheckReceipts.workspaceId, workspaceId));
        expect(receipts[0]?.decision).toBe('deny');
        expect(receipts[0]?.denyReason).toBe('daily_spend_cap_exceeded');
        expect(await committedSpend(tx, workspaceId, agentId)).toBe('0.000000');

        throw new Rollback();
      });
    } catch (error: unknown) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('9. WATCH RECEIPT: accepted follow-up, ledger still zero', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const { workspaceId, agentId } = await seedWorkspace(tx, WORKSPACE_A_NAME);
        // Watch allows and commits NOTHING - `commit: false` reproduces that.
        const receiptId = await allowedPrecheck(tx, workspaceId, agentId, { commit: false });
        expect(await committedSpend(tx, workspaceId, agentId)).toBe('0.000000');

        const outcome = await settleEvent(
          tx,
          workspaceId,
          {
            eventId: 'evt-1',
            agentExternalId: 'agent-a',
            type: 'spend.recorded',
            amountUsd: '4.000000',
            precheckId: receiptId,
          },
          NOW,
        );

        expect(outcome).toEqual({ accepted: 1, duplicates: 0, rejected: null });
        // A follow-up event is not a second chance to make an accounting
        // decision. The receipt captured the semantics; watch records nothing.
        expect(await committedSpend(tx, workspaceId, agentId)).toBe('0.000000');
        // And no ledger row was conjured by the event path either.
        expect(
          await tx.select().from(ledgerDaily).where(eq(ledgerDaily.workspaceId, workspaceId)),
        ).toEqual([]);

        throw new Rollback();
      });
    } catch (error: unknown) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('10. CONCURRENT replay: exactly one event, zero event-side accounting', async () => {
    const db = getDb();

    // Committed state: concurrency cannot be observed inside one transaction.
    try {
      const { workspaceId, agentId } = await seedWorkspace(db, WORKSPACE_A_NAME);
      const receiptId = await db.transaction(async (tx) =>
        allowedPrecheck(tx, workspaceId, agentId),
      );
      expect(await committedSpend(db, workspaceId, agentId)).toBe('4.000000');

      const event: LinkedEvent = {
        eventId: 'evt-concurrent',
        agentExternalId: 'agent-a',
        type: 'spend.recorded',
        amountUsd: '4.000000',
        precheckId: receiptId,
      };

      // Two racing submissions of the SAME linked event. The advisory lock
      // must make one of them the duplicate.
      const [first, second] = await Promise.all([
        db.transaction(async (tx) => settleEvent(tx, workspaceId, event, NOW)),
        db.transaction(async (tx) => settleEvent(tx, workspaceId, event, NOW)),
      ]);

      expect(first.accepted + second.accepted).toBe(1);
      expect(first.duplicates + second.duplicates).toBe(1);
      expect(first.rejected).toBeNull();
      expect(second.rejected).toBeNull();

      const stored = await db.select().from(events).where(eq(events.workspaceId, workspaceId));
      expect(stored).toHaveLength(1);
      expect(stored[0]?.precheckReceiptId).toBe(receiptId);

      // Still $4. Neither branch debited, so a race cannot double-count.
      expect(await committedSpend(db, workspaceId, agentId)).toBe('4.000000');
    } finally {
      await cleanup(db);
    }
  });

  it('a linked event leaves the receipt byte-for-byte unchanged', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const { workspaceId, agentId } = await seedWorkspace(tx, WORKSPACE_A_NAME);
        const receiptId = await allowedPrecheck(tx, workspaceId, agentId);

        const before = await tx
          .select()
          .from(precheckReceipts)
          .where(eq(precheckReceipts.id, receiptId));

        await settleEvent(
          tx,
          workspaceId,
          {
            eventId: 'evt-1',
            agentExternalId: 'agent-a',
            type: 'spend.recorded',
            amountUsd: '4.000000',
            precheckId: receiptId,
          },
          NOW,
        );

        const after = await tx
          .select()
          .from(precheckReceipts)
          .where(eq(precheckReceipts.id, receiptId));

        // No consumption flag, no settled-at column, nothing.
        expect(after).toEqual(before);

        throw new Rollback();
      });
    } catch (error: unknown) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('MANY linked events settle one precheck, still one debit', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const { workspaceId, agentId } = await seedWorkspace(tx, WORKSPACE_A_NAME);
        const receiptId = await allowedPrecheck(tx, workspaceId, agentId);

        // `precheck_id` is NOT event identity - `event_id` is. Several
        // legitimate audit events may reference one authorized action.
        for (const eventId of ['evt-1', 'evt-2', 'evt-3']) {
          const outcome = await settleEvent(
            tx,
            workspaceId,
            {
              eventId,
              agentExternalId: 'agent-a',
              type: 'spend.recorded',
              amountUsd: '4.000000',
              precheckId: receiptId,
            },
            NOW,
          );
          expect(outcome.accepted).toBe(1);
        }

        expect(
          await tx.select().from(events).where(eq(events.workspaceId, workspaceId)),
        ).toHaveLength(3);
        expect(await committedSpend(tx, workspaceId, agentId)).toBe('4.000000');

        throw new Rollback();
      });
    } catch (error: unknown) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('an UNPRECHECKED spend event is stored and still does not debit', async () => {
    const db = getDb();

    // CARRIED DEFICIENCY, asserted so it cannot change silently. Event-side
    // accounting for unprechecked spend is the NEXT Credit step.
    try {
      await db.transaction(async (tx) => {
        const { workspaceId, agentId } = await seedWorkspace(tx, WORKSPACE_A_NAME);

        const outcome = await settleEvent(
          tx,
          workspaceId,
          {
            eventId: 'evt-1',
            agentExternalId: 'agent-a',
            type: 'spend.recorded',
            amountUsd: '4.000000',
          },
          NOW,
        );

        expect(outcome).toEqual({ accepted: 1, duplicates: 0, rejected: null });
        expect(await committedSpend(tx, workspaceId, agentId)).toBe('0.000000');

        throw new Rollback();
      });
    } catch (error: unknown) {
      if (!(error instanceof Rollback)) throw error;
    }
  });
});
