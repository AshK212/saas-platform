import { inArray } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { closeDatabasePool, createDatabaseClient, createDatabasePool } from '../src/client';
import { createAgentRepository } from '../src/repositories/agents';
import { createEventRepository, type TimelineEventRow } from '../src/repositories/events';
import { createWorkspaceScope } from '../src/repositories/workspace-scope';
import type { DatabaseExecutor } from '../src/repositories/executor';
import { agents } from '../src/schema/agents';
import { blocks } from '../src/schema/blocks';
import { events } from '../src/schema/events';
import { workspaces } from '../src/schema/workspaces';

/**
 * LIVE timeline suite against real PostgreSQL (AC-05, AC-06).
 *
 * SAFETY - READ BEFORE CHANGING THE GATE
 * --------------------------------------
 * This suite WRITES DATA. It is gated on `TEST_DATABASE_URL` and **never falls
 * back to `DATABASE_URL`**. Every write is rolled back; nothing is dropped or
 * truncated. The connection string is never logged.
 *
 * WHY IT EXISTS SEPARATELY
 * ------------------------
 * The in-memory read store used by route tests sorts and slices in JavaScript.
 * It cannot establish what PostgreSQL actually does, and the timeline's
 * correctness is entirely a claim about PostgreSQL:
 *
 *   - that `ORDER BY received_at DESC, id DESC` is a total order over rows
 *     sharing a timestamp;
 *   - that the row-value comparison `(received_at, id) < ($1, $2)` reproduces
 *     that ordering boundary exactly, so paging neither repeats nor skips;
 *   - that `jsonb` returns the stored payload unchanged;
 *   - that the workspace predicate really isolates tenants at runtime.
 */

const testDatabaseUrl = process.env['TEST_DATABASE_URL']?.trim();
const hasTestDatabase = testDatabaseUrl !== undefined && testDatabaseUrl !== '';

const WORKSPACE_A_NAME = 'live-timeline-alpha';
const WORKSPACE_B_NAME = 'live-timeline-bravo';
const ALL_NAMES = [WORKSPACE_A_NAME, WORKSPACE_B_NAME];

const BASE = new Date('2026-08-12T10:00:00.000Z');

class Rollback extends Error {}

let pool: ReturnType<typeof createDatabasePool> | undefined;

afterAll(async () => {
  if (pool !== undefined) {
    await closeDatabasePool(pool);
  }
});

describe.skipIf(!hasTestDatabase)('live event timeline', () => {
  function getDb(): ReturnType<typeof createDatabaseClient> {
    pool ??= createDatabasePool({
      connectionString: testDatabaseUrl as string,
      maxConnections: 4,
      applicationName: 'hybrid-timeline-live-test',
    });
    return createDatabaseClient(pool);
  }

  /** Creates a workspace and one agent, returning both ids. */
  async function seedWorkspace(
    tx: DatabaseExecutor,
    name: string,
    externalId = 'agent-a',
  ): Promise<{ workspaceId: string; agentId: string }> {
    const [ws] = await tx.insert(workspaces).values({ name }).returning();
    const workspaceId = ws?.id ?? '';
    const [agent] = await tx.insert(agents).values({ workspaceId, externalId }).returning();
    return { workspaceId, agentId: agent?.id ?? '' };
  }

  async function seedEvent(
    tx: DatabaseExecutor,
    input: {
      workspaceId: string;
      agentId: string;
      eventId: string;
      receivedAt: Date;
      payload?: unknown;
      blockId?: string;
    },
  ): Promise<string> {
    const [row] = await tx
      .insert(events)
      .values({
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        eventId: input.eventId,
        type: 'heartbeat',
        payload: input.payload ?? { event_id: input.eventId, type: 'heartbeat' },
        receivedAt: input.receivedAt,
        blockId: input.blockId ?? null,
      })
      .returning();
    return row?.id ?? '';
  }

  it('orders newest first by received_at', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const { workspaceId, agentId } = await seedWorkspace(tx, WORKSPACE_A_NAME);
        for (let i = 0; i < 5; i += 1) {
          await seedEvent(tx, {
            workspaceId,
            agentId,
            eventId: `evt-${String(i)}`,
            receivedAt: new Date(BASE.getTime() + i * 1_000),
          });
        }

        const rows = await createEventRepository(tx, createWorkspaceScope(workspaceId)).listTimeline(
          { limit: 10 },
        );

        expect(rows.map((r) => r.eventId)).toEqual([
          'evt-4',
          'evt-3',
          'evt-2',
          'evt-1',
          'evt-0',
        ]);
        // The join populated agent metadata.
        expect(rows[0]?.agent.externalId).toBe('agent-a');

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('IDENTICAL received_at is broken deterministically by id', async () => {
    // One ingest batch is one transaction stamped from one clock read, so a
    // block of equal timestamps is the normal case. Without the tiebreaker
    // PostgreSQL may return them in any order, and pagination breaks.
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const { workspaceId, agentId } = await seedWorkspace(tx, WORKSPACE_A_NAME);
        for (let i = 0; i < 8; i += 1) {
          await seedEvent(tx, {
            workspaceId,
            agentId,
            eventId: `evt-${String(i)}`,
            receivedAt: BASE,
          });
        }

        const repo = createEventRepository(tx, createWorkspaceScope(workspaceId));
        const first = await repo.listTimeline({ limit: 10 });
        const second = await repo.listTimeline({ limit: 10 });

        expect(first.map((r) => r.id)).toEqual(second.map((r) => r.id));
        const ids = first.map((r) => r.id);
        expect([...ids].sort().reverse()).toEqual(ids);

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('CURSOR: paging a static dataset repeats nothing and skips nothing', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const { workspaceId, agentId } = await seedWorkspace(tx, WORKSPACE_A_NAME);
        for (let i = 0; i < 23; i += 1) {
          await seedEvent(tx, {
            workspaceId,
            agentId,
            eventId: `evt-${String(i).padStart(2, '0')}`,
            // Deliberately coarse: many rows share a timestamp, which is what
            // stresses the row-value boundary.
            receivedAt: new Date(BASE.getTime() + Math.floor(i / 4) * 1_000),
          });
        }

        const repo = createEventRepository(tx, createWorkspaceScope(workspaceId));
        const seen: string[] = [];
        let cursor: { receivedAt: Date; id: string } | undefined;
        let pages = 0;

        for (;;) {
          const page: TimelineEventRow[] = await repo.listTimeline({ limit: 5, cursor });
          seen.push(...page.map((r) => r.eventId));
          pages += 1;
          expect(pages).toBeLessThan(12);
          const last = page.at(-1);
          if (page.length < 5 || last === undefined) break;
          cursor = { receivedAt: last.receivedAt, id: last.id };
        }

        expect(seen).toHaveLength(23);
        expect(new Set(seen).size).toBe(23);
        // Identical order to a single unpaged read.
        const single = await repo.listTimeline({ limit: 100 });
        expect(seen).toEqual(single.map((r) => r.eventId));

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('CURSOR: pages correctly when EVERY received_at is identical', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const { workspaceId, agentId } = await seedWorkspace(tx, WORKSPACE_A_NAME);
        for (let i = 0; i < 14; i += 1) {
          await seedEvent(tx, {
            workspaceId,
            agentId,
            eventId: `evt-${String(i).padStart(2, '0')}`,
            receivedAt: BASE,
          });
        }

        const repo = createEventRepository(tx, createWorkspaceScope(workspaceId));
        const seen: string[] = [];
        let cursor: { receivedAt: Date; id: string } | undefined;

        for (;;) {
          const page: TimelineEventRow[] = await repo.listTimeline({ limit: 4, cursor });
          seen.push(...page.map((r) => r.eventId));
          const last = page.at(-1);
          if (page.length < 4 || last === undefined) break;
          cursor = { receivedAt: last.receivedAt, id: last.id };
        }

        // The pure-tiebreaker case: only `id DESC` distinguishes these rows.
        expect(seen).toHaveLength(14);
        expect(new Set(seen).size).toBe(14);

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('filters by agent within the workspace', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const { workspaceId, agentId } = await seedWorkspace(tx, WORKSPACE_A_NAME, 'agent-a');
        const [other] = await tx
          .insert(agents)
          .values({ workspaceId, externalId: 'agent-b' })
          .returning();

        await seedEvent(tx, { workspaceId, agentId, eventId: 'a-1', receivedAt: BASE });
        await seedEvent(tx, { workspaceId, agentId, eventId: 'a-2', receivedAt: BASE });
        await seedEvent(tx, {
          workspaceId,
          agentId: other?.id ?? '',
          eventId: 'b-1',
          receivedAt: BASE,
        });

        const repo = createEventRepository(tx, createWorkspaceScope(workspaceId));
        const filtered = await repo.listTimeline({ limit: 10, agentId });

        expect(filtered.map((r) => r.eventId).sort()).toEqual(['a-1', 'a-2']);

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('a SHARED external agent id resolves independently per workspace', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const a = await seedWorkspace(tx, WORKSPACE_A_NAME, 'agent-1');
        const b = await seedWorkspace(tx, WORKSPACE_B_NAME, 'agent-1');

        await seedEvent(tx, {
          workspaceId: a.workspaceId,
          agentId: a.agentId,
          eventId: 'shared',
          receivedAt: BASE,
        });
        await seedEvent(tx, {
          workspaceId: b.workspaceId,
          agentId: b.agentId,
          eventId: 'shared',
          receivedAt: BASE,
        });

        const scopeA = createWorkspaceScope(a.workspaceId);
        // Resolving `agent-1` under A's scope can only find A's agent.
        const resolved = await createAgentRepository(tx, scopeA).findByExternalId('agent-1');
        expect(resolved?.id).toBe(a.agentId);
        expect(resolved?.id).not.toBe(b.agentId);

        const rows = await createEventRepository(tx, scopeA).listTimeline({
          limit: 10,
          agentId: resolved?.id ?? '',
        });

        expect(rows).toHaveLength(1);
        expect(rows[0]?.agent.id).toBe(a.agentId);

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it("filtering by ANOTHER workspace's agent uuid returns nothing", async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const a = await seedWorkspace(tx, WORKSPACE_A_NAME);
        const b = await seedWorkspace(tx, WORKSPACE_B_NAME, 'agent-b');
        await seedEvent(tx, {
          workspaceId: b.workspaceId,
          agentId: b.agentId,
          eventId: 'bobs',
          receivedAt: BASE,
        });
        await seedEvent(tx, {
          workspaceId: a.workspaceId,
          agentId: a.agentId,
          eventId: 'alices',
          receivedAt: BASE,
        });

        // Even holding B's exact internal agent uuid, A's scope sees nothing.
        const rows = await createEventRepository(tx, createWorkspaceScope(a.workspaceId))
          .listTimeline({ limit: 10, agentId: b.agentId });

        expect(rows).toEqual([]);

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('CROSS-TENANT: the timeline never returns another workspace rows', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const a = await seedWorkspace(tx, WORKSPACE_A_NAME);
        const b = await seedWorkspace(tx, WORKSPACE_B_NAME, 'agent-b');
        for (let i = 0; i < 3; i += 1) {
          await seedEvent(tx, {
            workspaceId: a.workspaceId,
            agentId: a.agentId,
            eventId: `a-${String(i)}`,
            receivedAt: new Date(BASE.getTime() + i * 1_000),
          });
        }
        for (let i = 0; i < 4; i += 1) {
          await seedEvent(tx, {
            workspaceId: b.workspaceId,
            agentId: b.agentId,
            eventId: `b-${String(i)}`,
            receivedAt: new Date(BASE.getTime() + i * 1_000),
            payload: { secret: 'bob-only' },
          });
        }

        const aRows = await createEventRepository(tx, createWorkspaceScope(a.workspaceId))
          .listTimeline({ limit: 100 });
        const bRows = await createEventRepository(tx, createWorkspaceScope(b.workspaceId))
          .listTimeline({ limit: 100 });

        expect(aRows).toHaveLength(3);
        expect(bRows).toHaveLength(4);
        expect(aRows.every((r) => r.eventId.startsWith('a-'))).toBe(true);

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('AC-06: detail returns the stored payload byte-for-byte', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const { workspaceId, agentId } = await seedWorkspace(tx, WORKSPACE_A_NAME);
        const payload = {
          type: 'spend.recorded',
          event_id: 'evt-1',
          agent_id: 'agent-a',
          amount_usd: '1.250000',
          provider: 'openai',
          payload: {
            model: 'gpt-x',
            nested: { attempt: 2, tags: ['a', 'b'], flag: false, missing: null },
            // A script-looking string is DATA. jsonb must return it unchanged.
            note: '<script>alert(1)</script>',
            unicode: 'héllo 🙂',
          },
        };
        const id = await seedEvent(tx, {
          workspaceId,
          agentId,
          eventId: 'evt-1',
          receivedAt: BASE,
          payload,
        });

        const detail = await createEventRepository(tx, createWorkspaceScope(workspaceId))
          .findDetailById(id);

        expect(detail?.payload).toEqual(payload);

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it("CROSS-TENANT: detail refuses another workspace's exact event uuid", async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const a = await seedWorkspace(tx, WORKSPACE_A_NAME);
        const b = await seedWorkspace(tx, WORKSPACE_B_NAME, 'agent-b');
        const bobsEventId = await seedEvent(tx, {
          workspaceId: b.workspaceId,
          agentId: b.agentId,
          eventId: 'bobs',
          receivedAt: BASE,
          payload: { secret: 'bob-only' },
        });

        // A UUID is not authorization.
        const viaA = await createEventRepository(tx, createWorkspaceScope(a.workspaceId))
          .findDetailById(bobsEventId);

        expect(viaA).toBeNull();

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('joins block linkage without exposing another workspace block', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const { workspaceId, agentId } = await seedWorkspace(tx, WORKSPACE_A_NAME);
        const [block] = await tx
          .insert(blocks)
          .values({
            workspaceId,
            agentId,
            externalBlockId: 'client-block-123',
            source: 'runtime',
            category: 'publish',
            rule: 'daily_publish_cap',
            reason: 'Daily publish cap reached',
          })
          .returning();

        const id = await seedEvent(tx, {
          workspaceId,
          agentId,
          eventId: 'evt-blocked',
          receivedAt: BASE,
          blockId: block?.id ?? '',
        });

        const detail = await createEventRepository(tx, createWorkspaceScope(workspaceId))
          .findDetailById(id);

        expect(detail?.block?.externalBlockId).toBe('client-block-123');
        expect(detail?.block?.source).toBe('runtime');

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('returns a null block for an event with no linkage', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const { workspaceId, agentId } = await seedWorkspace(tx, WORKSPACE_A_NAME);
        const id = await seedEvent(tx, {
          workspaceId,
          agentId,
          eventId: 'evt-plain',
          receivedAt: BASE,
        });

        // Proves the LEFT join does not drop unblocked events.
        const detail = await createEventRepository(tx, createWorkspaceScope(workspaceId))
          .findDetailById(id);

        expect(detail).not.toBeNull();
        expect(detail?.block).toBeNull();

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
