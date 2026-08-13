import { eq, inArray } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { closeDatabasePool, createDatabaseClient, createDatabasePool } from '../src/client';
import { createAgentRepository } from '../src/repositories/agents';
import { createBlockRepository } from '../src/repositories/blocks';
import { createEventRepository } from '../src/repositories/events';
import { createIngestLockRepository } from '../src/repositories/ingest-locks';
import { createPrecheckReceiptRepository } from '../src/repositories/receipts';
import { createWorkspaceScope, type WorkspaceScope } from '../src/repositories/workspace-scope';
import type { DatabaseExecutor } from '../src/repositories/executor';
import { agents } from '../src/schema/agents';
import { blocks } from '../src/schema/blocks';
import { events } from '../src/schema/events';
import { ledgerDaily } from '../src/schema/ledger';
import { precheckReceipts } from '../src/schema/receipts';
import { workspaces } from '../src/schema/workspaces';

/**
 * LIVE event-ingest suite against real PostgreSQL. AC-13.
 *
 * SAFETY - READ BEFORE CHANGING THE GATE
 * --------------------------------------
 * This suite WRITES DATA. It is gated on `TEST_DATABASE_URL` and **never falls
 * back to `DATABASE_URL`**. Writes are rolled back or explicitly cleaned up;
 * nothing is dropped or truncated. The connection string is never logged.
 *
 * WHY IT EXISTS SEPARATELY
 * ------------------------
 * The in-memory store behind the route tests is single-threaded JavaScript. It
 * can demonstrate the ingest ALGORITHM but it cannot prove the thing AC-13
 * actually depends on: that PostgreSQL's UNIQUE index on
 * `(workspace_id, event_id)` arbitrates two SIMULTANEOUS submissions of the
 * same event, and that `ON CONFLICT DO NOTHING` turns the loser into a
 * duplicate rather than an error or an overwrite.
 *
 * It is also the ONLY place that can prove the correction made after
 * architecture review: that the duplicate decision now happens BEFORE any
 * one-time side effect, and that it stays correct when two requests race. In
 * single-threaded JavaScript a read-then-act sequence is authoritative for
 * free; in PostgreSQL it is authoritative only because of the advisory lock.
 *
 * WHAT IS BEING TESTED
 * --------------------
 * The repository layer, driven by a local transcription of the ingest loop from
 * `apps/api/src/events/store.ts`. `packages/db` cannot import from `apps/`, so
 * `runIngest` below mirrors that algorithm; the source-level guardrails in
 * `data-access-boundary.test.ts` pin the repository behaviour it relies on.
 */

const testDatabaseUrl = process.env['TEST_DATABASE_URL']?.trim();
const hasTestDatabase = testDatabaseUrl !== undefined && testDatabaseUrl !== '';

const WORKSPACE_A_NAME = 'live-ingest-alpha';
const WORKSPACE_B_NAME = 'live-ingest-bravo';
const ALL_NAMES = [WORKSPACE_A_NAME, WORKSPACE_B_NAME];

class Rollback extends Error {}

let pool: ReturnType<typeof createDatabasePool> | undefined;

afterAll(async () => {
  if (pool !== undefined) {
    await closeDatabasePool(pool);
  }
});

/** Minimal stand-in for a validated wire event. */
interface TestEvent {
  readonly event_id: string;
  readonly agent_id: string;
  readonly type: 'heartbeat' | 'agent.action' | 'action.blocked' | 'spend.recorded';
  readonly category?: 'llm_call' | 'tool_call' | 'publish' | 'other';
  readonly block_id?: string;
  readonly precheck_id?: string;
  readonly rule?: string;
  readonly reason?: string;
}

interface Outcome {
  accepted: number;
  duplicates: number;
}

class UnresolvedReference extends Error {}

/**
 * Transcription of the production ingest loop, repository-for-repository.
 *
 * Kept deliberately literal rather than factored - divergence from
 * `apps/api/src/events/store.ts` should be visible when read side by side.
 */
async function runIngest(
  executor: DatabaseExecutor,
  scope: WorkspaceScope,
  batch: readonly TestEvent[],
  now: Date,
): Promise<Outcome> {
  const agentRepo = createAgentRepository(executor, scope);
  const eventRepo = createEventRepository(executor, scope);
  const blockRepo = createBlockRepository(executor, scope);
  const receiptRepo = createPrecheckReceiptRepository(executor, scope);
  const lockRepo = createIngestLockRepository(executor, scope);

  let accepted = 0;
  let duplicates = 0;

  await lockRepo.lockEvents(batch.map((event) => event.event_id));

  for (const event of batch) {
    // THE DUPLICATE DECISION, BEFORE ANY SIDE EFFECT.
    if ((await eventRepo.findByEventId(event.event_id)) !== null) {
      duplicates += 1;
      continue;
    }

    const agent = await agentRepo.discover(event.agent_id, now);

    let precheckReceiptId: string | undefined;
    if (event.precheck_id !== undefined) {
      if (!(await receiptRepo.exists(event.precheck_id))) {
        throw new UnresolvedReference('Unknown precheck_id for this workspace.');
      }
      precheckReceiptId = event.precheck_id;
    }

    let blockId: string | undefined;
    if (event.type === 'action.blocked' && event.block_id !== undefined) {
      const block = await blockRepo.resolveOrCreateRuntimeBlock({
        externalBlockId: event.block_id,
        agentId: agent.id,
        category: event.category ?? 'other',
        rule: event.rule ?? 'daily_publish_cap',
        reason: event.reason ?? 'Daily publish cap reached',
      });
      blockId = block.id;
    }

    const inserted = await eventRepo.insertIfNew({
      eventId: event.event_id,
      agentId: agent.id,
      type: event.type,
      category:
        event.type === 'agent.action' || event.type === 'action.blocked'
          ? (event.category ?? 'other')
          : null,
      payload: event,
      precheckReceiptId,
      blockId,
      receivedAt: now,
    });

    if (inserted === null) {
      duplicates += 1;
      continue;
    }
    accepted += 1;
    await agentRepo.touchLastSeen(agent.id, now);
  }

  return { accepted, duplicates };
}

const heartbeat = (eventId: string, agentId = 'agent-a'): TestEvent => ({
  event_id: eventId,
  agent_id: agentId,
  type: 'heartbeat',
});

describe.skipIf(!hasTestDatabase)('live event ingest', () => {
  function getDb(): ReturnType<typeof createDatabaseClient> {
    pool ??= createDatabasePool({
      connectionString: testDatabaseUrl as string,
      maxConnections: 6,
      applicationName: 'hybrid-ingest-live-test',
    });
    return createDatabaseClient(pool);
  }

  it('enforces UNIQUE (workspace_id, event_id) at the database level', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const [ws] = await tx.insert(workspaces).values({ name: WORKSPACE_A_NAME }).returning();
        const workspaceId = ws?.id ?? '';
        const [agent] = await tx
          .insert(agents)
          .values({ workspaceId, externalId: 'agent-a' })
          .returning();

        const row = {
          workspaceId,
          eventId: 'evt-1',
          agentId: agent?.id ?? '',
          type: 'heartbeat' as const,
          payload: {},
          receivedAt: new Date(),
        };
        await tx.insert(events).values(row);

        // The constraint - not application code - is what makes replay safe.
        await expect(tx.insert(events).values(row)).rejects.toThrow();

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('AC-13: replaying an identical batch stores nothing new', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const [ws] = await tx.insert(workspaces).values({ name: WORKSPACE_A_NAME }).returning();
        const workspaceId = ws?.id ?? '';
        const scope = createWorkspaceScope(workspaceId);
        const batch = [heartbeat('evt-1'), heartbeat('evt-2'), heartbeat('evt-3')];

        const first = await runIngest(tx, scope, batch, new Date('2026-08-12T10:00:00.000Z'));
        expect(first).toEqual({ accepted: 3, duplicates: 0 });

        const stored = await tx.select().from(events).where(eq(events.workspaceId, workspaceId));
        expect(stored).toHaveLength(3);

        const replay = await runIngest(tx, scope, batch, new Date('2026-08-12T10:10:00.000Z'));
        expect(replay).toEqual({ accepted: 0, duplicates: 3 });

        const after = await tx.select().from(events).where(eq(events.workspaceId, workspaceId));
        expect(after).toHaveLength(3);
        // Every stored row is byte-identical, received_at included.
        expect(after.map((r) => r.receivedAt)).toEqual(stored.map((r) => r.receivedAt));
        expect(after.map((r) => r.id).sort()).toEqual(stored.map((r) => r.id).sort());

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('a duplicate replay does not refresh last_seen_at', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const [ws] = await tx.insert(workspaces).values({ name: WORKSPACE_A_NAME }).returning();
        const workspaceId = ws?.id ?? '';
        const scope = createWorkspaceScope(workspaceId);
        const first = new Date('2026-08-12T10:00:00.000Z');

        await runIngest(tx, scope, [heartbeat('evt-1')], first);
        await runIngest(tx, scope, [heartbeat('evt-1')], new Date('2026-08-12T10:30:00.000Z'));

        const [agent] = await tx.select().from(agents).where(eq(agents.workspaceId, workspaceId));
        expect(agent?.lastSeenAt).toEqual(first);

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('CONCURRENCY: two simultaneous submissions of one event store one row', async () => {
    // THE test this suite exists for. Two committed transactions race on the
    // same (workspace_id, event_id). Requires real PostgreSQL.
    const db = getDb();
    let workspaceId = '';

    try {
      const [ws] = await db.insert(workspaces).values({ name: WORKSPACE_A_NAME }).returning();
      workspaceId = ws?.id ?? '';
      const scope = createWorkspaceScope(workspaceId);

      const submit = (at: Date): Promise<Outcome> =>
        db.transaction(async (tx) => runIngest(tx, scope, [heartbeat('evt-race')], at));

      const [a, b] = await Promise.all([
        submit(new Date('2026-08-12T10:00:00.000Z')),
        submit(new Date('2026-08-12T10:00:00.500Z')),
      ]);

      // Neither caller errors, and between them exactly one insert happened.
      const totalAccepted = (a?.accepted ?? 0) + (b?.accepted ?? 0);
      const totalDuplicates = (a?.duplicates ?? 0) + (b?.duplicates ?? 0);
      expect(totalAccepted).toBe(1);
      expect(totalDuplicates).toBe(1);

      const stored = await db.select().from(events).where(eq(events.workspaceId, workspaceId));
      expect(stored).toHaveLength(1);
    } finally {
      await db.delete(events).where(eq(events.workspaceId, workspaceId));
      await db.delete(agents).where(eq(agents.workspaceId, workspaceId));
      await db.delete(workspaces).where(inArray(workspaces.name, ALL_NAMES));
    }
  });

  it('CONCURRENCY: a 10-way replay storm still stores one row', async () => {
    const db = getDb();
    let workspaceId = '';

    try {
      const [ws] = await db.insert(workspaces).values({ name: WORKSPACE_A_NAME }).returning();
      workspaceId = ws?.id ?? '';
      const scope = createWorkspaceScope(workspaceId);
      const at = new Date('2026-08-12T10:00:00.000Z');

      const outcomes = await Promise.all(
        Array.from({ length: 10 }, () =>
          db.transaction(async (tx) => runIngest(tx, scope, [heartbeat('evt-storm')], at)),
        ),
      );

      // A retry storm is the realistic failure mode: nine of ten must be
      // reported as duplicates, and none may fail.
      expect(outcomes.reduce((sum, o) => sum + o.accepted, 0)).toBe(1);
      expect(outcomes.reduce((sum, o) => sum + o.duplicates, 0)).toBe(9);

      const stored = await db.select().from(events).where(eq(events.workspaceId, workspaceId));
      expect(stored).toHaveLength(1);
    } finally {
      await db.delete(events).where(eq(events.workspaceId, workspaceId));
      await db.delete(agents).where(eq(agents.workspaceId, workspaceId));
      await db.delete(workspaces).where(inArray(workspaces.name, ALL_NAMES));
    }
  });

  it('CONCURRENCY: a racing duplicate creates no alternate BLOCK', async () => {
    // The correction, under concurrency. Two simultaneous submissions share an
    // event id but name DIFFERENT external blocks. Whoever loses the race is a
    // duplicate and must not create its block - which is only true because the
    // duplicate check sits behind the advisory lock, ahead of block creation.
    const db = getDb();
    let workspaceId = '';

    try {
      const [ws] = await db.insert(workspaces).values({ name: WORKSPACE_A_NAME }).returning();
      workspaceId = ws?.id ?? '';
      const scope = createWorkspaceScope(workspaceId);
      const at = new Date('2026-08-12T10:00:00.000Z');

      const submit = (externalBlockId: string): Promise<Outcome> =>
        db.transaction(async (tx) =>
          runIngest(
            tx,
            scope,
            [
              {
                event_id: 'evt-race-block',
                agent_id: 'agent-a',
                type: 'action.blocked',
                category: 'publish',
                block_id: externalBlockId,
                rule: 'daily_publish_cap',
                reason: 'Daily publish cap reached',
              },
            ],
            at,
          ),
        );

      const [a, b] = await Promise.all([submit('block-alpha'), submit('block-bravo')]);

      expect((a?.accepted ?? 0) + (b?.accepted ?? 0)).toBe(1);
      expect((a?.duplicates ?? 0) + (b?.duplicates ?? 0)).toBe(1);

      // EXACTLY ONE block exists, and it belongs to the winner.
      const blockRows = await db.select().from(blocks).where(eq(blocks.workspaceId, workspaceId));
      expect(blockRows).toHaveLength(1);
      expect(['block-alpha', 'block-bravo']).toContain(blockRows[0]?.externalBlockId);

      const stored = await db.select().from(events).where(eq(events.workspaceId, workspaceId));
      expect(stored).toHaveLength(1);
      expect(stored[0]?.blockId).toBe(blockRows[0]?.id);
    } finally {
      await db.delete(events).where(eq(events.workspaceId, workspaceId));
      await db.delete(blocks).where(eq(blocks.workspaceId, workspaceId));
      await db.delete(agents).where(eq(agents.workspaceId, workspaceId));
      await db.delete(workspaces).where(inArray(workspaces.name, ALL_NAMES));
    }
  });

  it('CONCURRENCY: a racing duplicate discovers no alternate AGENT', async () => {
    const db = getDb();
    let workspaceId = '';

    try {
      const [ws] = await db.insert(workspaces).values({ name: WORKSPACE_A_NAME }).returning();
      workspaceId = ws?.id ?? '';
      const scope = createWorkspaceScope(workspaceId);
      const at = new Date('2026-08-12T10:00:00.000Z');

      const submit = (agentId: string): Promise<Outcome> =>
        db.transaction(async (tx) =>
          runIngest(tx, scope, [heartbeat('evt-race-agent', agentId)], at),
        );

      const [a, b] = await Promise.all([submit('agent-alpha'), submit('agent-bravo')]);

      expect((a?.accepted ?? 0) + (b?.accepted ?? 0)).toBe(1);
      expect((a?.duplicates ?? 0) + (b?.duplicates ?? 0)).toBe(1);

      // A reused event id is not a way to enrol an agent, even under a race.
      const agentRows = await db.select().from(agents).where(eq(agents.workspaceId, workspaceId));
      expect(agentRows).toHaveLength(1);
      expect(['agent-alpha', 'agent-bravo']).toContain(agentRows[0]?.externalId);
      // And that single agent is the one the stored event points at.
      const stored = await db.select().from(events).where(eq(events.workspaceId, workspaceId));
      expect(stored).toHaveLength(1);
      expect(stored[0]?.agentId).toBe(agentRows[0]?.id);
      // Last-seen moved exactly once, for the accepted event.
      expect(agentRows[0]?.lastSeenAt).toEqual(at);
    } finally {
      await db.delete(events).where(eq(events.workspaceId, workspaceId));
      await db.delete(agents).where(eq(agents.workspaceId, workspaceId));
      await db.delete(workspaces).where(inArray(workspaces.name, ALL_NAMES));
    }
  });

  it('DEADLOCK: overlapping batches [E1,E2] and [E2,E1] both complete', async () => {
    // Advisory locks are held to COMMIT, so acquiring them in request order
    // would let these two transactions hold one lock each and wait forever.
    // Deterministic key ordering is what makes this finish.
    const db = getDb();
    let workspaceId = '';

    try {
      const [ws] = await db.insert(workspaces).values({ name: WORKSPACE_A_NAME }).returning();
      workspaceId = ws?.id ?? '';
      const scope = createWorkspaceScope(workspaceId);
      const at = new Date('2026-08-12T10:00:00.000Z');

      const submit = (ids: string[]): Promise<Outcome> =>
        db.transaction(async (tx) =>
          runIngest(
            tx,
            scope,
            ids.map((id) => heartbeat(id)),
            at,
          ),
        );

      const [a, b] = await Promise.all([submit(['E1', 'E2']), submit(['E2', 'E1'])]);

      // No deadlock (a deadlock surfaces as a rejected transaction, so simply
      // arriving here is most of the assertion), and the counts still balance.
      expect((a?.accepted ?? 0) + (b?.accepted ?? 0)).toBe(2);
      expect((a?.duplicates ?? 0) + (b?.duplicates ?? 0)).toBe(2);

      const stored = await db.select().from(events).where(eq(events.workspaceId, workspaceId));
      expect(stored.map((e) => e.eventId).sort()).toEqual(['E1', 'E2']);
    } finally {
      await db.delete(events).where(eq(events.workspaceId, workspaceId));
      await db.delete(agents).where(eq(agents.workspaceId, workspaceId));
      await db.delete(workspaces).where(inArray(workspaces.name, ALL_NAMES));
    }
  });

  it('DEADLOCK: eight batches with shuffled overlapping ids all complete', async () => {
    const db = getDb();
    let workspaceId = '';

    try {
      const [ws] = await db.insert(workspaces).values({ name: WORKSPACE_A_NAME }).returning();
      workspaceId = ws?.id ?? '';
      const scope = createWorkspaceScope(workspaceId);
      const at = new Date('2026-08-12T10:00:00.000Z');
      const ids = ['E1', 'E2', 'E3', 'E4', 'E5'];

      // Fixed rotations rather than random shuffles - a deadlock test must be
      // reproducible, and this file may not use Math.random anyway.
      const batches = Array.from({ length: 8 }, (_v, i) => [
        ...ids.slice(i % ids.length),
        ...ids.slice(0, i % ids.length),
      ]);

      const outcomes = await Promise.all(
        batches.map((batch) =>
          db.transaction(async (tx) =>
            runIngest(
              tx,
              scope,
              batch.map((id) => heartbeat(id)),
              at,
            ),
          ),
        ),
      );

      expect(outcomes.reduce((sum, o) => sum + o.accepted, 0)).toBe(5);
      expect(outcomes.reduce((sum, o) => sum + o.duplicates, 0)).toBe(35);

      const stored = await db.select().from(events).where(eq(events.workspaceId, workspaceId));
      expect(stored).toHaveLength(5);
    } finally {
      await db.delete(events).where(eq(events.workspaceId, workspaceId));
      await db.delete(agents).where(eq(agents.workspaceId, workspaceId));
      await db.delete(workspaces).where(inArray(workspaces.name, ALL_NAMES));
    }
  });

  it('a sequential replay with changed content creates no alternate rows', async () => {
    // The non-concurrent form of the reported defect, against real PostgreSQL.
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const [ws] = await tx.insert(workspaces).values({ name: WORKSPACE_A_NAME }).returning();
        const workspaceId = ws?.id ?? '';
        const scope = createWorkspaceScope(workspaceId);
        const at = new Date('2026-08-12T10:00:00.000Z');

        await runIngest(
          tx,
          scope,
          [
            {
              event_id: 'evt-duplicate',
              agent_id: 'agent-original',
              type: 'action.blocked',
              category: 'publish',
              block_id: 'block-original',
              rule: 'rule-original',
              reason: 'reason-original',
            },
          ],
          at,
        );

        const replay = await runIngest(
          tx,
          scope,
          [
            {
              event_id: 'evt-duplicate',
              agent_id: 'agent-fake-new',
              type: 'action.blocked',
              category: 'publish',
              block_id: 'block-should-never-exist',
              rule: 'different-rule',
              reason: 'different-reason',
              precheck_id: '11111111-1111-4111-8111-111111111111',
            },
          ],
          new Date('2026-08-12T10:30:00.000Z'),
        );

        // Not a 400 despite the bogus precheck_id: the identity settled first.
        expect(replay).toEqual({ accepted: 0, duplicates: 1 });

        const blockRows = await tx
          .select()
          .from(blocks)
          .where(eq(blocks.workspaceId, workspaceId));
        expect(blockRows.map((b) => b.externalBlockId)).toEqual(['block-original']);
        expect(blockRows[0]?.rule).toBe('rule-original');

        const agentRows = await tx
          .select()
          .from(agents)
          .where(eq(agents.workspaceId, workspaceId));
        expect(agentRows.map((a) => a.externalId)).toEqual(['agent-original']);
        expect(agentRows[0]?.lastSeenAt).toEqual(at);

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('an unresolved precheck_id rolls back the ENTIRE batch', async () => {
    const db = getDb();
    let workspaceId = '';

    try {
      const [ws] = await db.insert(workspaces).values({ name: WORKSPACE_A_NAME }).returning();
      workspaceId = ws?.id ?? '';
      const scope = createWorkspaceScope(workspaceId);

      await expect(
        db.transaction(async (tx) =>
          runIngest(
            tx,
            scope,
            [
              heartbeat('evt-1'),
              {
                ...heartbeat('evt-2'),
                precheck_id: '11111111-1111-4111-8111-111111111111',
              },
            ],
            new Date('2026-08-12T10:00:00.000Z'),
          ),
        ),
      ).rejects.toThrow(UnresolvedReference);

      // evt-1 was inserted before the failure. It must not have committed.
      const stored = await db.select().from(events).where(eq(events.workspaceId, workspaceId));
      expect(stored).toEqual([]);
    } finally {
      await db.delete(events).where(eq(events.workspaceId, workspaceId));
      await db.delete(agents).where(eq(agents.workspaceId, workspaceId));
      await db.delete(workspaces).where(inArray(workspaces.name, ALL_NAMES));
    }
  });

  it('links a precheck receipt in the same workspace and refuses one from another', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const [wsA] = await tx.insert(workspaces).values({ name: WORKSPACE_A_NAME }).returning();
        const [wsB] = await tx.insert(workspaces).values({ name: WORKSPACE_B_NAME }).returning();
        const scopeA = createWorkspaceScope(wsA?.id ?? '');

        const makeReceipt = async (workspaceId: string): Promise<string> => {
          const [agent] = await tx
            .insert(agents)
            .values({ workspaceId, externalId: 'agent-a' })
            .returning();
          const [receipt] = await tx
            .insert(precheckReceipts)
            .values({
              workspaceId,
              agentId: agent?.id ?? '',
              category: 'publish',
              decision: 'allow',
              policyVersion: 1,
              appliedMode: 'budgeted',
            })
            .returning();
          return receipt?.id ?? '';
        };

        const receiptA = await makeReceipt(wsA?.id ?? '');
        const receiptB = await makeReceipt(wsB?.id ?? '');

        const linked = await runIngest(
          tx,
          scopeA,
          [{ ...heartbeat('evt-1'), precheck_id: receiptA }],
          new Date('2026-08-12T10:00:00.000Z'),
        );
        expect(linked).toEqual({ accepted: 1, duplicates: 0 });

        // Workspace B's receipt is invisible to A, exactly like a nonexistent
        // one - a UUID is not authorization.
        await expect(
          runIngest(
            tx,
            scopeA,
            [{ ...heartbeat('evt-2'), precheck_id: receiptB }],
            new Date('2026-08-12T10:00:00.000Z'),
          ),
        ).rejects.toThrow(UnresolvedReference);

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('deduplicates runtime blocks on (workspace_id, external_block_id)', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const [wsA] = await tx.insert(workspaces).values({ name: WORKSPACE_A_NAME }).returning();
        const [wsB] = await tx.insert(workspaces).values({ name: WORKSPACE_B_NAME }).returning();
        const scopeA = createWorkspaceScope(wsA?.id ?? '');
        const scopeB = createWorkspaceScope(wsB?.id ?? '');
        const at = new Date('2026-08-12T10:00:00.000Z');

        const blocked = (eventId: string): TestEvent => ({
          event_id: eventId,
          agent_id: 'agent-a',
          type: 'action.blocked',
          category: 'publish',
          block_id: 'client-block-123',
          rule: 'daily_publish_cap',
          reason: 'Daily publish cap reached',
        });

        await runIngest(tx, scopeA, [blocked('evt-1'), blocked('evt-2')], at);
        // Replay of evt-1 as well.
        await runIngest(tx, scopeA, [blocked('evt-1')], at);

        const aBlocks = await tx
          .select()
          .from(blocks)
          .where(eq(blocks.workspaceId, wsA?.id ?? ''));
        expect(aBlocks).toHaveLength(1);
        expect(aBlocks[0]?.source).toBe('runtime');

        const aEvents = await tx
          .select()
          .from(events)
          .where(eq(events.workspaceId, wsA?.id ?? ''));
        expect(aEvents).toHaveLength(2);
        // events.block_id holds the INTERNAL uuid, not the client string.
        expect(new Set(aEvents.map((e) => e.blockId))).toEqual(new Set([aBlocks[0]?.id]));
        expect(aEvents[0]?.blockId).not.toBe('client-block-123');

        // The same external id in another workspace is a different block.
        await runIngest(tx, scopeB, [blocked('evt-1')], at);
        const bBlocks = await tx
          .select()
          .from(blocks)
          .where(eq(blocks.workspaceId, wsB?.id ?? ''));
        expect(bBlocks).toHaveLength(1);
        expect(bBlocks[0]?.id).not.toBe(aBlocks[0]?.id);

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('CROSS-TENANT: the same event_id in two workspaces is two events', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const [wsA] = await tx.insert(workspaces).values({ name: WORKSPACE_A_NAME }).returning();
        const [wsB] = await tx.insert(workspaces).values({ name: WORKSPACE_B_NAME }).returning();
        const scopeA = createWorkspaceScope(wsA?.id ?? '');
        const scopeB = createWorkspaceScope(wsB?.id ?? '');
        const at = new Date('2026-08-12T10:00:00.000Z');

        expect(await runIngest(tx, scopeA, [heartbeat('shared')], at)).toEqual({
          accepted: 1,
          duplicates: 0,
        });
        // Workspace B is NOT a duplicate - the uniqueness key is composite.
        expect(await runIngest(tx, scopeB, [heartbeat('shared')], at)).toEqual({
          accepted: 1,
          duplicates: 0,
        });

        const repoA = createEventRepository(tx, scopeA);
        const aRow = await repoA.findByEventId('shared');
        expect(aRow?.workspaceId).toBe(wsA?.id);

        // Holding B's row id, scope A still cannot read it.
        const bRows = await tx.select().from(events).where(eq(events.workspaceId, wsB?.id ?? ''));
        expect(await repoA.findById(bRows[0]?.id ?? '')).toBeNull();

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('ingest writes no ledger, policy or receipt rows', async () => {
    // Step 10 records; Step 19 debits. Proving the absence of a debit here is
    // what stops "events were persisted" being mistaken for "spend was counted".
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const [ws] = await tx.insert(workspaces).values({ name: WORKSPACE_A_NAME }).returning();
        const workspaceId = ws?.id ?? '';
        const scope = createWorkspaceScope(workspaceId);

        await runIngest(
          tx,
          scope,
          [
            {
              event_id: 'evt-spend',
              agent_id: 'agent-a',
              type: 'spend.recorded',
            },
          ],
          new Date('2026-08-12T10:00:00.000Z'),
        );

        // The headline absence: a spend.recorded event debited nothing.
        const ledger = await tx
          .select()
          .from(ledgerDaily)
          .where(eq(ledgerDaily.workspaceId, workspaceId));
        expect(ledger).toEqual([]);

        const receipts = await tx
          .select()
          .from(precheckReceipts)
          .where(eq(precheckReceipts.workspaceId, workspaceId));
        expect(receipts).toEqual([]);

        const blockRows = await tx.select().from(blocks).where(eq(blocks.workspaceId, workspaceId));
        expect(blockRows).toEqual([]);

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
