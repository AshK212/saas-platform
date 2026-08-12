import { eq, inArray } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { closeDatabasePool, createDatabaseClient, createDatabasePool } from '../src/client';
import { createAgentRepository } from '../src/repositories/agents';
import { createWorkspaceScope } from '../src/repositories/workspace-scope';
import { agents } from '../src/schema/agents';
import { runtimeProfiles } from '../src/schema/runtime';
import { workspaces } from '../src/schema/workspaces';

/**
 * LIVE agent registry suite against real PostgreSQL.
 *
 * SAFETY - READ BEFORE CHANGING THE GATE
 * --------------------------------------
 * This suite WRITES DATA. It is gated on `TEST_DATABASE_URL` and **never falls
 * back to `DATABASE_URL`**. Writes are rolled back or explicitly cleaned up;
 * nothing is dropped or truncated. The connection string is never logged.
 *
 * WHY IT EXISTS SEPARATELY
 * ------------------------
 * The in-memory store used by route tests is single-threaded JavaScript. It
 * cannot prove the UNIQUE constraint on `(workspace_id, external_id)`, nor what
 * happens when two registrations race. Only this suite can.
 */

const testDatabaseUrl = process.env['TEST_DATABASE_URL']?.trim();
const hasTestDatabase = testDatabaseUrl !== undefined && testDatabaseUrl !== '';

const WORKSPACE_A_NAME = 'live-agents-alpha';
const WORKSPACE_B_NAME = 'live-agents-bravo';
const ALL_NAMES = [WORKSPACE_A_NAME, WORKSPACE_B_NAME];

class Rollback extends Error {}

let pool: ReturnType<typeof createDatabasePool> | undefined;

afterAll(async () => {
  if (pool !== undefined) {
    await closeDatabasePool(pool);
  }
});

describe.skipIf(!hasTestDatabase)('live agent registry', () => {
  function getDb(): ReturnType<typeof createDatabaseClient> {
    pool ??= createDatabasePool({
      connectionString: testDatabaseUrl as string,
      maxConnections: 4,
      applicationName: 'hybrid-agents-live-test',
    });
    return createDatabaseClient(pool);
  }

  it('persists a registration and advances last-seen on re-registration', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const [ws] = await tx.insert(workspaces).values({ name: WORKSPACE_A_NAME }).returning();
        const repo = createAgentRepository(tx, createWorkspaceScope(ws?.id ?? ''));

        const first = new Date('2026-08-12T10:00:00.000Z');
        const created = await repo.register({ externalId: 'agent-a', displayName: 'Agent A' }, first);
        expect(created.lastSeenAt).toEqual(first);
        expect(created.displayName).toBe('Agent A');

        const later = new Date('2026-08-12T10:00:45.000Z');
        const again = await repo.register({ externalId: 'agent-a' }, later);

        // Same row, advanced clock, name preserved.
        expect(again.id).toBe(created.id);
        expect(again.lastSeenAt).toEqual(later);
        expect(again.displayName).toBe('Agent A');

        const rows = await tx.select().from(agents).where(eq(agents.workspaceId, ws?.id ?? ''));
        expect(rows).toHaveLength(1);

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('enforces UNIQUE (workspace_id, external_id)', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const [ws] = await tx.insert(workspaces).values({ name: WORKSPACE_A_NAME }).returning();

        await tx.insert(agents).values({ workspaceId: ws?.id ?? '', externalId: 'agent-a' });

        // A raw duplicate insert must be rejected by the database.
        await expect(
          tx.insert(agents).values({ workspaceId: ws?.id ?? '', externalId: 'agent-a' }),
        ).rejects.toThrow();

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('CONCURRENCY: simultaneous registrations create exactly one agent', async () => {
    // THE test this suite exists for. Requires real PostgreSQL; single-threaded
    // JavaScript cannot establish it.
    const db = getDb();
    let workspaceId = '';

    // Committed setup so both racing transactions see the same workspace.
    try {
      const [ws] = await db.insert(workspaces).values({ name: WORKSPACE_A_NAME }).returning();
      workspaceId = ws?.id ?? '';
      const scope = createWorkspaceScope(workspaceId);

      const attempt = async (at: Date): Promise<string> =>
        db.transaction(async (tx) =>
          (await createAgentRepository(tx, scope).register({ externalId: 'agent-race' }, at)).id,
        );

      const [first, second] = await Promise.all([
        attempt(new Date('2026-08-12T10:00:00.000Z')),
        attempt(new Date('2026-08-12T10:00:01.000Z')),
      ]);

      // Both callers succeed, and both resolve to the SAME logical agent.
      expect(first).toBe(second);

      const rows = await db.select().from(agents).where(eq(agents.workspaceId, workspaceId));
      expect(rows).toHaveLength(1);
    } finally {
      await db.delete(agents).where(eq(agents.workspaceId, workspaceId));
      await db.delete(workspaces).where(inArray(workspaces.name, ALL_NAMES));
    }
  });

  it('CROSS-TENANT: the same external id in two workspaces is two agents', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const [wsA] = await tx.insert(workspaces).values({ name: WORKSPACE_A_NAME }).returning();
        const [wsB] = await tx.insert(workspaces).values({ name: WORKSPACE_B_NAME }).returning();
        const scopeA = createWorkspaceScope(wsA?.id ?? '');
        const scopeB = createWorkspaceScope(wsB?.id ?? '');

        const now = new Date();
        const a = await createAgentRepository(tx, scopeA).register(
          { externalId: 'agent-1', displayName: 'Alpha Agent' },
          now,
        );
        const b = await createAgentRepository(tx, scopeB).register(
          { externalId: 'agent-1', displayName: 'Bravo Agent' },
          now,
        );

        // Same client-supplied id, two independent rows.
        expect(a.id).not.toBe(b.id);

        const repoA = createAgentRepository(tx, scopeA);
        expect((await repoA.listAll()).map((x) => x.displayName)).toEqual(['Alpha Agent']);

        // A's scope cannot reach B's agent, even holding its exact UUID.
        expect(await repoA.findById(b.id)).toBeNull();

        // Nor can a scoped touch reach across.
        await repoA.touchLastSeen(b.id, new Date('2099-01-01T00:00:00.000Z'));
        const bAfter = await tx.select().from(agents).where(eq(agents.id, b.id));
        expect(bAfter[0]?.lastSeenAt).toEqual(now);

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('rejects a runtime profile from another workspace at the database level', async () => {
    // Step 8 does not link runtime profiles, but the composite FK from Step 3
    // must still refuse a cross-workspace attachment if one is ever attempted.
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const [wsA] = await tx.insert(workspaces).values({ name: WORKSPACE_A_NAME }).returning();
        const [wsB] = await tx.insert(workspaces).values({ name: WORKSPACE_B_NAME }).returning();

        const [profileB] = await tx
          .insert(runtimeProfiles)
          .values({ workspaceId: wsB?.id ?? '', name: 'bravo-runtime', adapterKey: 'local-dev' })
          .returning();

        await expect(
          tx.insert(agents).values({
            workspaceId: wsA?.id ?? '',
            externalId: 'agent-a',
            runtimeProfileId: profileB?.id ?? '',
          }),
        ).rejects.toThrow();

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('AC-04: three agents all report last-seen within 60 seconds', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const [ws] = await tx.insert(workspaces).values({ name: WORKSPACE_A_NAME }).returning();
        const repo = createAgentRepository(tx, createWorkspaceScope(ws?.id ?? ''));

        const base = new Date('2026-08-12T10:00:00.000Z');
        await repo.register({ externalId: 'agent-a', displayName: 'A' }, base);
        await repo.register({ externalId: 'agent-b', displayName: 'B' }, new Date(base.getTime() + 10_000));
        await repo.register({ externalId: 'agent-c', displayName: 'C' }, new Date(base.getTime() + 20_000));

        const roster = await repo.listAll();
        expect(roster).toHaveLength(3);

        const referenceNow = base.getTime() + 30_000;
        for (const agent of roster) {
          expect(referenceNow - (agent.lastSeenAt?.getTime() ?? 0)).toBeLessThanOrEqual(60_000);
        }

        // Ordered by most recent contact.
        expect(roster.map((a) => a.externalId)).toEqual(['agent-c', 'agent-b', 'agent-a']);

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('leaves no residue', async () => {
    const db = getDb();

    const remaining = await db
      .select()
      .from(workspaces)
      .where(inArray(workspaces.name, ALL_NAMES));

    expect(remaining).toEqual([]);
  });
});
