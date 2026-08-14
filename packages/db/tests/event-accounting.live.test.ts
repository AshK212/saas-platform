import { eq, inArray } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { toUtcAccountingDay, type UtcAccountingDay } from '../src/accounting/utc-day';
import { closeDatabasePool, createDatabaseClient, createDatabasePool } from '../src/client';
import { createAgentRepository } from '../src/repositories/agents';
import { createEventRepository } from '../src/repositories/events';
import { createIngestLockRepository } from '../src/repositories/ingest-locks';
import { createLedgerRepository, type LockedDailyLedger } from '../src/repositories/ledger';
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
 * LIVE authoritative event accounting against real PostgreSQL (Step 19).
 *
 * SAFETY - READ BEFORE CHANGING THE GATE
 * --------------------------------------
 * This suite WRITES DATA. It is gated on `TEST_DATABASE_URL` and **never falls
 * back to `DATABASE_URL`**. Writes are rolled back or explicitly cleaned up;
 * nothing is dropped or truncated. The connection string is never logged.
 *
 * WHY IT EXISTS SEPARATELY
 * ------------------------
 * The in-process suite now shares one `MemoryLedger` between both fakes, so it
 * can finally observe a double debit. What it still cannot observe is anything
 * that requires two things to happen AT ONCE:
 *
 *   - that `SELECT … FOR UPDATE` makes a second debit WAIT rather than read a
 *     stale total - the lost-update case Step 14 corrected;
 *   - that `pg_advisory_xact_lock` makes exactly one of two racing replays the
 *     accepted one, so a retry storm debits once;
 *   - that two batches naming the same agents in OPPOSITE order do not
 *     deadlock on ledger rows.
 *
 * Single-threaded JavaScript makes all three true for free. PostgreSQL does
 * not, and every one of them is a money defect if wrong.
 *
 * `ingestBatch` below TRANSCRIBES the staged transaction from
 * `apps/api/src/events/store.ts`, because `packages/db` cannot import from
 * `apps/`. A drift guard in `apps/api` - which depends on both - checks the
 * parts that matter.
 */

const testDatabaseUrl = process.env['TEST_DATABASE_URL']?.trim();
const hasTestDatabase = testDatabaseUrl !== undefined && testDatabaseUrl !== '';

const WORKSPACE_A_NAME = 'live-accounting-alpha';
const WORKSPACE_B_NAME = 'live-accounting-bravo';
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

/** An event in the shape ingest receives it. */
interface WireEvent {
  readonly eventId: string;
  readonly agentExternalId: string;
  readonly type: 'spend.recorded' | 'agent.action' | 'heartbeat';
  readonly amountUsd?: string;
  readonly precheckId?: string;
  /** Client-reported. Untrusted, and never selects the accounting day. */
  readonly occurredAt?: Date;
}

interface IngestOutcome {
  readonly accepted: number;
  readonly duplicates: number;
}

/**
 * Transcription of the production staged ingest transaction.
 *
 * Kept deliberately literal and in the same phase order, so a drift from
 * `apps/api/src/events/store.ts` is visible on inspection. The properties it
 * must preserve are the ones that fail silently:
 *
 *   - the duplicate decision precedes EVERY other phase;
 *   - all event advisory locks precede all ledger locks;
 *   - ledger locks are acquired in a deterministic total order;
 *   - the debit is gated on the ABSENCE of a precheck id;
 *   - the accounting day comes from the injected server instant.
 */
async function ingestBatch(
  tx: DatabaseExecutor,
  workspaceId: string,
  batch: readonly WireEvent[],
  now: Date,
): Promise<IngestOutcome> {
  const scope = createWorkspaceScope(workspaceId);
  const accountingDay = toUtcAccountingDay(now);

  const agentRepo = createAgentRepository(tx, scope);
  const eventRepo = createEventRepository(tx, scope);
  const receiptRepo = createPrecheckReceiptRepository(tx, scope);
  const ledgerRepo = createLedgerRepository(tx, scope);

  // PHASE 1: event identity locks, deterministic order.
  await createIngestLockRepository(tx, scope).lockEvents(batch.map((e) => e.eventId));

  let accepted = 0;
  let duplicates = 0;

  // PHASE 2: the duplicate decision, before any side effect.
  const fresh: WireEvent[] = [];
  for (const event of batch) {
    if ((await eventRepo.findByEventId(event.eventId)) !== null) {
      duplicates += 1;
      continue;
    }
    fresh.push(event);
  }

  // PHASE 3: agent resolution for survivors, sorted by external id.
  const agentByExternalId = new Map<string, string>();
  for (const externalId of [...new Set(fresh.map((e) => e.agentExternalId))].sort()) {
    const agent = await agentRepo.discover(externalId, now);
    agentByExternalId.set(externalId, agent.id);
  }
  const agentIdFor = (event: WireEvent): string => {
    const id = agentByExternalId.get(event.agentExternalId);
    if (id === undefined) throw new Error('agent not resolved');
    return id;
  };

  // PHASE 4: settlement validation (Step 18). Read-only, can reject.
  const linked = new Set<string>();
  for (const event of fresh) {
    if (event.precheckId === undefined) continue;
    const receipt = await receiptRepo.findById(event.precheckId);
    if (receipt === null) throw new Error('Unknown precheck_id for this workspace.');
    if (receipt.agentId !== agentIdFor(event)) {
      throw new Error('precheck_id belongs to a different agent.');
    }
    linked.add(event.eventId);
  }

  // PHASE 5: ledger locks for unprechecked spend, deterministic (agent, day).
  const debits = fresh.filter(
    (e) => e.type === 'spend.recorded' && !linked.has(e.eventId),
  );
  const ledgerKeys = [
    ...new Map(
      debits.map((e) => {
        const agentId = agentIdFor(e);
        return [`${agentId} ${accountingDay}`, agentId] as const;
      }),
    ),
  ].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));

  const ledgerByAgent = new Map<string, LockedDailyLedger>();
  for (const [, agentId] of ledgerKeys) {
    const locked = await ledgerRepo.lockDailyLedger(agentId, accountingDay as UtcAccountingDay);
    if (locked === null) throw new Error('ledger unavailable');
    ledgerByAgent.set(agentId, locked);
  }

  // PHASE 6: effects, in submission order.
  for (const event of fresh) {
    const agentId = agentIdFor(event);

    const inserted = await eventRepo.insertIfNew({
      eventId: event.eventId,
      agentId,
      type: event.type,
      category: event.type === 'agent.action' ? 'spend' : null,
      payload: { ...event, occurredAt: event.occurredAt?.toISOString() },
      precheckReceiptId: linked.has(event.eventId) ? event.precheckId : undefined,
      occurredAt: event.occurredAt,
      receivedAt: now,
    });

    if (inserted === null) {
      duplicates += 1;
      continue;
    }

    if (event.type === 'spend.recorded' && !linked.has(event.eventId)) {
      const ledger = ledgerByAgent.get(agentId);
      if (ledger === undefined) throw new Error('ledger capability missing');
      await ledger.commitSpend(event.amountUsd ?? '0.000000');
    }

    accepted += 1;
    await agentRepo.touchLastSeen(agentId, now);
  }

  return { accepted, duplicates };
}

describe.skipIf(!hasTestDatabase)('live authoritative event accounting', () => {
  function getDb(): ReturnType<typeof createDatabaseClient> {
    pool ??= createDatabasePool({
      connectionString: testDatabaseUrl as string,
      maxConnections: 12,
      applicationName: 'hybrid-event-accounting-live-test',
    });
    return createDatabaseClient(pool);
  }

  async function seedWorkspace(
    executor: DatabaseExecutor,
    name: string,
    externalIds: readonly string[] = ['agent-a'],
  ): Promise<{ workspaceId: string; agentIds: Record<string, string> }> {
    const [ws] = await executor.insert(workspaces).values({ name }).returning();
    const workspaceId = ws?.id ?? '';
    await executor.insert(workspacePolicyState).values({ workspaceId, version: 1 });

    const agentIds: Record<string, string> = {};
    for (const externalId of externalIds) {
      const [agent] = await executor.insert(agents).values({ workspaceId, externalId }).returning();
      agentIds[externalId] = agent?.id ?? '';
    }
    return { workspaceId, agentIds };
  }

  /** Sets a policy, so "policy does not affect recording" is a real test. */
  async function setPolicy(
    executor: DatabaseExecutor,
    workspaceId: string,
    agentId: string,
    mode: 'watch' | 'budgeted' | 'paused',
    spend: string | null,
  ): Promise<void> {
    await executor.insert(agentPolicies).values({
      workspaceId,
      agentId,
      mode,
      dailySpendCapUsd: spend,
      dailyPublishCap: null,
    });
  }

  /**
   * Committed spend, read through `findDailyLedger`.
   *
   * Deliberately the SAME call the Step 17 governance read store makes, so
   * every assertion below doubles as proof that the fleet view sees
   * event-side accounting without any change to it - and without ever summing
   * event history.
   */
  async function committed(
    executor: DatabaseExecutor,
    workspaceId: string,
    agentId: string,
    day: string = DAY,
  ): Promise<string> {
    const row = await createLedgerRepository(
      executor,
      createWorkspaceScope(workspaceId),
    ).findDailyLedger(agentId, day as UtcAccountingDay);
    return row?.spendCommittedUsd ?? '0.000000';
  }

  async function cleanup(db: ReturnType<typeof createDatabaseClient>): Promise<void> {
    const rows = await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(inArray(workspaces.name, ALL_NAMES));
    for (const row of rows) {
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

  const spend = (eventId: string, amountUsd: string, agentExternalId = 'agent-a'): WireEvent => ({
    eventId,
    agentExternalId,
    type: 'spend.recorded',
    amountUsd,
  });

  it('1. an unprechecked spend debits the ledger exactly once', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const { workspaceId, agentIds } = await seedWorkspace(tx, WORKSPACE_A_NAME);
        const agentId = agentIds['agent-a'] ?? '';
        expect(await committed(tx, workspaceId, agentId)).toBe('0.000000');

        const outcome = await ingestBatch(tx, workspaceId, [spend('evt-1', '4.000000')], NOW);

        expect(outcome).toEqual({ accepted: 1, duplicates: 0 });
        expect(await committed(tx, workspaceId, agentId)).toBe('4.000000');
        // One event, no receipt, no block.
        expect(
          await tx.select().from(events).where(eq(events.workspaceId, workspaceId)),
        ).toHaveLength(1);
        expect(
          await tx
            .select()
            .from(precheckReceipts)
            .where(eq(precheckReceipts.workspaceId, workspaceId)),
        ).toEqual([]);
        expect(
          await tx.select().from(blocks).where(eq(blocks.workspaceId, workspaceId)),
        ).toEqual([]);

        throw new Rollback();
      });
    } catch (error: unknown) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('2. a duplicate does not debit twice', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const { workspaceId, agentIds } = await seedWorkspace(tx, WORKSPACE_A_NAME);
        const agentId = agentIds['agent-a'] ?? '';

        await ingestBatch(tx, workspaceId, [spend('evt-1', '4.000000')], NOW);
        const again = await ingestBatch(tx, workspaceId, [spend('evt-1', '4.000000')], NOW);

        expect(again).toEqual({ accepted: 0, duplicates: 1 });
        expect(await committed(tx, workspaceId, agentId)).toBe('4.000000');

        throw new Rollback();
      });
    } catch (error: unknown) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('3. a CHANGED duplicate does not re-account', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const { workspaceId, agentIds } = await seedWorkspace(tx, WORKSPACE_A_NAME);
        const agentId = agentIds['agent-a'] ?? '';

        await ingestBatch(tx, workspaceId, [spend('evt-1', '4.000000')], NOW);
        // Same identity, wildly different amount. Replacement content is not
        // historical truth.
        const replay = await ingestBatch(tx, workspaceId, [spend('evt-1', '400.000000')], NOW);

        expect(replay).toEqual({ accepted: 0, duplicates: 1 });
        expect(await committed(tx, workspaceId, agentId)).toBe('4.000000');

        const stored = await tx.select().from(events).where(eq(events.workspaceId, workspaceId));
        expect(stored).toHaveLength(1);

        throw new Rollback();
      });
    } catch (error: unknown) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('4. CONCURRENT replay of one event debits ONCE', async () => {
    const db = getDb();

    // Committed state: concurrency is invisible inside one transaction.
    try {
      const { workspaceId, agentIds } = await seedWorkspace(db, WORKSPACE_A_NAME);
      const agentId = agentIds['agent-a'] ?? '';
      const event = spend('evt-race', '4.000000');

      const [first, second] = await Promise.all([
        db.transaction(async (tx) => ingestBatch(tx, workspaceId, [event], NOW)),
        db.transaction(async (tx) => ingestBatch(tx, workspaceId, [event], NOW)),
      ]);

      // The advisory lock makes exactly one of them the winner.
      expect(first.accepted + second.accepted).toBe(1);
      expect(first.duplicates + second.duplicates).toBe(1);
      expect(
        await db.select().from(events).where(eq(events.workspaceId, workspaceId)),
      ).toHaveLength(1);
      // A retry storm debits once.
      expect(await committed(db, workspaceId, agentId)).toBe('4.000000');
    } finally {
      await cleanup(db);
    }
  });

  it('5. CONCURRENT DISTINCT events for one agent/day sum exactly', async () => {
    const db = getDb();

    // THE LOST-UPDATE CASE. Without `FOR UPDATE` both transactions read the
    // same total and the second overwrites the first.
    try {
      const { workspaceId, agentIds } = await seedWorkspace(db, WORKSPACE_A_NAME);
      const agentId = agentIds['agent-a'] ?? '';

      await Promise.all([
        db.transaction(async (tx) => ingestBatch(tx, workspaceId, [spend('evt-1', '4.000000')], NOW)),
        db.transaction(async (tx) => ingestBatch(tx, workspaceId, [spend('evt-2', '6.000000')], NOW)),
      ]);

      expect(await committed(db, workspaceId, agentId)).toBe('10.000000');
      expect(
        await db.select().from(events).where(eq(events.workspaceId, workspaceId)),
      ).toHaveLength(2);
    } finally {
      await cleanup(db);
    }
  });

  it('6. eight concurrent $1.25 spends sum to exactly 10.000000', async () => {
    const db = getDb();

    try {
      const { workspaceId, agentIds } = await seedWorkspace(db, WORKSPACE_A_NAME);
      const agentId = agentIds['agent-a'] ?? '';

      await Promise.all(
        Array.from({ length: 8 }, (_unused, index) =>
          db.transaction(async (tx) =>
            ingestBatch(tx, workspaceId, [spend(`evt-${String(index)}`, '1.250000')], NOW),
          ),
        ),
      );

      // Exact. Not 9.999999, not 10.000001.
      expect(await committed(db, workspaceId, agentId)).toBe('10.000000');
      expect(
        await db.select().from(events).where(eq(events.workspaceId, workspaceId)),
      ).toHaveLength(8);
    } finally {
      await cleanup(db);
    }
  });

  it('7. different agents use independent rows and do not serialize', async () => {
    const db = getDb();

    try {
      const { workspaceId, agentIds } = await seedWorkspace(db, WORKSPACE_A_NAME, [
        'agent-a',
        'agent-b',
      ]);

      await Promise.all([
        db.transaction(async (tx) =>
          ingestBatch(tx, workspaceId, [spend('evt-1', '4.000000', 'agent-a')], NOW),
        ),
        db.transaction(async (tx) =>
          ingestBatch(tx, workspaceId, [spend('evt-2', '6.000000', 'agent-b')], NOW),
        ),
      ]);

      // No workspace-wide accounting lock: two agents, two rows.
      expect(await committed(db, workspaceId, agentIds['agent-a'] ?? '')).toBe('4.000000');
      expect(await committed(db, workspaceId, agentIds['agent-b'] ?? '')).toBe('6.000000');
    } finally {
      await cleanup(db);
    }
  });

  it('8. MULTI-AGENT REVERSE-ORDER BATCHES DO NOT DEADLOCK', async () => {
    const db = getDb();

    // THE STEP 19 DEADLOCK HAZARD. Batch one names [A, B]; batch two names
    // [B, A]. Locking ledger rows in event order would let each hold what the
    // other wants. Sorting by (agentId, day) removes the cycle.
    try {
      const { workspaceId, agentIds } = await seedWorkspace(db, WORKSPACE_A_NAME, [
        'agent-a',
        'agent-b',
      ]);

      const [first, second] = await Promise.all([
        db.transaction(async (tx) =>
          ingestBatch(
            tx,
            workspaceId,
            [spend('evt-1', '1.000000', 'agent-a'), spend('evt-2', '2.000000', 'agent-b')],
            NOW,
          ),
        ),
        db.transaction(async (tx) =>
          ingestBatch(
            tx,
            workspaceId,
            [spend('evt-3', '3.000000', 'agent-b'), spend('evt-4', '4.000000', 'agent-a')],
            NOW,
          ),
        ),
      ]);

      // Both completed - no deadlock, no retry, no aborted transaction.
      expect(first).toEqual({ accepted: 2, duplicates: 0 });
      expect(second).toEqual({ accepted: 2, duplicates: 0 });
      expect(await committed(db, workspaceId, agentIds['agent-a'] ?? '')).toBe('5.000000');
      expect(await committed(db, workspaceId, agentIds['agent-b'] ?? '')).toBe('5.000000');
    } finally {
      await cleanup(db);
    }
  });

  it('9. a batch that fails after a debit leaves NO partial ledger', async () => {
    const db = getDb();

    try {
      const { workspaceId, agentIds } = await seedWorkspace(db, WORKSPACE_A_NAME);
      const agentId = agentIds['agent-a'] ?? '';
      await db.transaction(async (tx) =>
        ingestBatch(tx, workspaceId, [spend('evt-0', '1.000000')], NOW),
      );
      expect(await committed(db, workspaceId, agentId)).toBe('1.000000');

      // evt-2 references a receipt that does not exist, after evt-1 debited.
      await expect(
        db.transaction(async (tx) =>
          ingestBatch(
            tx,
            workspaceId,
            [
              spend('evt-1', '4.000000'),
              {
                eventId: 'evt-2',
                agentExternalId: 'agent-a',
                type: 'spend.recorded',
                amountUsd: '6.000000',
                precheckId: '11111111-1111-4111-8111-111111111111',
              },
            ],
            NOW,
          ),
        ),
      ).rejects.toThrow();

      // Back to the pre-batch value, and no partial event rows.
      expect(await committed(db, workspaceId, agentId)).toBe('1.000000');
      expect(
        await db.select().from(events).where(eq(events.workspaceId, workspaceId)),
      ).toHaveLength(1);
    } finally {
      await cleanup(db);
    }
  });

  it('10. a mixed duplicate/new batch debits only the new event', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const { workspaceId, agentIds } = await seedWorkspace(tx, WORKSPACE_A_NAME);
        const agentId = agentIds['agent-a'] ?? '';

        await ingestBatch(tx, workspaceId, [spend('evt-1', '4.000000')], NOW);
        const mixed = await ingestBatch(
          tx,
          workspaceId,
          [spend('evt-1', '4.000000'), spend('evt-2', '6.000000')],
          NOW,
        );

        expect(mixed).toEqual({ accepted: 1, duplicates: 1 });
        expect(await committed(tx, workspaceId, agentId)).toBe('10.000000');

        throw new Rollback();
      });
    } catch (error: unknown) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('11. a PRECHECKED spend gets no event-side second debit', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const { workspaceId, agentIds } = await seedWorkspace(tx, WORKSPACE_A_NAME);
        const agentId = agentIds['agent-a'] ?? '';
        const scope = createWorkspaceScope(workspaceId);

        // The precheck half: lock, commit, receipt - one transaction.
        const locked = await createLedgerRepository(tx, scope).lockDailyLedger(agentId, DAY);
        await locked?.commitSpend('4.000000');
        const receipt = await createPrecheckReceiptRepository(tx, scope).insert({
          actionId: 'act-1',
          agentId,
          category: 'spend',
          requestedAmountUsd: '4.000000',
          requestedPublishCount: null,
          decision: 'allow',
          policyVersion: '1',
          appliedMode: 'budgeted',
          appliedSpendCapUsd: '25.000000',
          appliedPublishCap: null,
          accountingDay: DAY,
          ledgerSpendBeforeUsd: '0.000000',
          ledgerPublishBefore: null,
          remainingSpendUsd: '21.000000',
          remainingPublishCount: null,
          denyReason: null,
        });
        expect(await committed(tx, workspaceId, agentId)).toBe('4.000000');

        await ingestBatch(
          tx,
          workspaceId,
          [
            {
              eventId: 'evt-1',
              agentExternalId: 'agent-a',
              type: 'spend.recorded',
              amountUsd: '4.000000',
              precheckId: receipt.id,
            },
          ],
          NOW,
        );

        // $4, NOT $8 - one real ledger table, both paths.
        expect(await committed(tx, workspaceId, agentId)).toBe('4.000000');

        throw new Rollback();
      });
    } catch (error: unknown) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('12. a WATCH-linked spend gets no event-side debit either', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const { workspaceId, agentIds } = await seedWorkspace(tx, WORKSPACE_A_NAME);
        const agentId = agentIds['agent-a'] ?? '';

        // A watch precheck allows and commits NOTHING, but still records.
        const receipt = await createPrecheckReceiptRepository(
          tx,
          createWorkspaceScope(workspaceId),
        ).insert({
          actionId: 'act-1',
          agentId,
          category: 'spend',
          requestedAmountUsd: '4.000000',
          requestedPublishCount: null,
          decision: 'allow',
          policyVersion: '1',
          appliedMode: 'watch',
          appliedSpendCapUsd: null,
          appliedPublishCap: null,
          accountingDay: DAY,
          ledgerSpendBeforeUsd: null,
          ledgerPublishBefore: null,
          remainingSpendUsd: null,
          remainingPublishCount: null,
          denyReason: null,
        });
        expect(await committed(tx, workspaceId, agentId)).toBe('0.000000');

        await ingestBatch(
          tx,
          workspaceId,
          [
            {
              eventId: 'evt-1',
              agentExternalId: 'agent-a',
              type: 'spend.recorded',
              amountUsd: '4.000000',
              precheckId: receipt.id,
            },
          ],
          NOW,
        );

        // The classification is receipt PRESENCE, not what it recorded. A
        // watch follow-up must not commit on the precheck's behalf.
        expect(await committed(tx, workspaceId, agentId)).toBe('0.000000');
        expect(
          await tx.select().from(ledgerDaily).where(eq(ledgerDaily.workspaceId, workspaceId)),
        ).toEqual([]);

        throw new Rollback();
      });
    } catch (error: unknown) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('13. CROSS-TENANT: the same external agent id keeps separate ledgers', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const a = await seedWorkspace(tx, WORKSPACE_A_NAME);
        const b = await seedWorkspace(tx, WORKSPACE_B_NAME);

        // Same event id, same agent id, different tenants.
        await ingestBatch(tx, a.workspaceId, [spend('evt-1', '4.000000')], NOW);
        await ingestBatch(tx, b.workspaceId, [spend('evt-1', '6.000000')], NOW);

        expect(await committed(tx, a.workspaceId, a.agentIds['agent-a'] ?? '')).toBe('4.000000');
        expect(await committed(tx, b.workspaceId, b.agentIds['agent-a'] ?? '')).toBe('6.000000');
        // A's scope cannot see B's row even holding B's agent uuid.
        expect(await committed(tx, a.workspaceId, b.agentIds['agent-a'] ?? '')).toBe('0.000000');

        throw new Rollback();
      });
    } catch (error: unknown) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('14. the SERVER instant selects the day, never occurred_at', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const { workspaceId, agentIds } = await seedWorkspace(tx, WORKSPACE_A_NAME);
        const agentId = agentIds['agent-a'] ?? '';

        await ingestBatch(
          tx,
          workspaceId,
          [
            {
              eventId: 'evt-1',
              agentExternalId: 'agent-a',
              type: 'spend.recorded',
              amountUsd: '4.000000',
              // Reported as a month ago. Untrusted.
              occurredAt: new Date('2026-07-13T09:00:00.000Z'),
            },
          ],
          NOW,
        );

        expect(await committed(tx, workspaceId, agentId, '2026-08-13')).toBe('4.000000');
        expect(await committed(tx, workspaceId, agentId, '2026-07-13')).toBe('0.000000');

        // And a batch accepted after midnight lands on the next day.
        await ingestBatch(
          tx,
          workspaceId,
          [spend('evt-2', '6.000000')],
          new Date('2026-08-14T00:00:00.000Z'),
        );
        expect(await committed(tx, workspaceId, agentId, '2026-08-14')).toBe('6.000000');
        expect(await committed(tx, workspaceId, agentId, '2026-08-13')).toBe('4.000000');

        throw new Rollback();
      });
    } catch (error: unknown) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('15. spend OVER the configured cap is still recorded', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const { workspaceId, agentIds } = await seedWorkspace(tx, WORKSPACE_A_NAME);
        const agentId = agentIds['agent-a'] ?? '';
        await setPolicy(tx, workspaceId, agentId, 'budgeted', '25.000000');

        await ingestBatch(tx, workspaceId, [spend('evt-1', '24.000000')], NOW);
        const over = await ingestBatch(tx, workspaceId, [spend('evt-2', '17.000000')], NOW);

        expect(over).toEqual({ accepted: 1, duplicates: 0 });
        // $41 against a $25 cap: the truth, not the cap. Recording is not
        // deciding, and clamping would hide the overspend.
        expect(await committed(tx, workspaceId, agentId)).toBe('41.000000');
        expect(
          await tx.select().from(blocks).where(eq(blocks.workspaceId, workspaceId)),
        ).toEqual([]);
        expect(
          await tx
            .select()
            .from(precheckReceipts)
            .where(eq(precheckReceipts.workspaceId, workspaceId)),
        ).toEqual([]);

        throw new Rollback();
      });
    } catch (error: unknown) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('16. a PAUSED agent’s reported spend is still recorded', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const { workspaceId, agentIds } = await seedWorkspace(tx, WORKSPACE_A_NAME);
        const agentId = agentIds['agent-a'] ?? '';
        await setPolicy(tx, workspaceId, agentId, 'paused', null);

        const outcome = await ingestBatch(tx, workspaceId, [spend('evt-1', '4.000000')], NOW);

        // Paused stops future actions; it does not erase past ones.
        expect(outcome).toEqual({ accepted: 1, duplicates: 0 });
        expect(await committed(tx, workspaceId, agentId)).toBe('4.000000');
        expect(
          await tx.select().from(blocks).where(eq(blocks.workspaceId, workspaceId)),
        ).toEqual([]);

        throw new Rollback();
      });
    } catch (error: unknown) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('sums an exact decimal sequence with no float drift', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const { workspaceId, agentIds } = await seedWorkspace(tx, WORKSPACE_A_NAME);
        const agentId = agentIds['agent-a'] ?? '';

        // 24.999999999999996 in IEEE-754. `numeric(14,6)` must yield 25.
        await ingestBatch(
          tx,
          workspaceId,
          [
            spend('evt-1', '10.100000'),
            spend('evt-2', '10.200000'),
            spend('evt-3', '4.700000'),
          ],
          NOW,
        );

        expect(await committed(tx, workspaceId, agentId)).toBe('25.000000');

        throw new Rollback();
      });
    } catch (error: unknown) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('several spends for one agent in one batch reuse the locked row', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const { workspaceId, agentIds } = await seedWorkspace(tx, WORKSPACE_A_NAME);
        const agentId = agentIds['agent-a'] ?? '';

        await ingestBatch(
          tx,
          workspaceId,
          Array.from({ length: 4 }, (_unused, index) =>
            spend(`evt-${String(index)}`, '1.250000'),
          ),
          NOW,
        );

        // The capability's tracked state advances after each commit, so a
        // stale read would lose all but the last.
        expect(await committed(tx, workspaceId, agentId)).toBe('5.000000');

        throw new Rollback();
      });
    } catch (error: unknown) {
      if (!(error instanceof Rollback)) throw error;
    }
  });
});
