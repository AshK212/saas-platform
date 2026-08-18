import { inArray } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { PG, expectRefused } from './helpers/pg-errors';

import { closeDatabasePool, createDatabaseClient, createDatabasePool } from '../src/client';
import { createAgentRepository } from '../src/repositories/agents';
import { createEventRepository } from '../src/repositories/events';
import { createWorkspaceScope } from '../src/repositories/workspace-scope';
import { agents } from '../src/schema/agents';
import { events } from '../src/schema/events';
import { workspaces } from '../src/schema/workspaces';

/**
 * LIVE cross-tenant isolation suite (AC-20 foundation).
 *
 * SAFETY - READ THIS BEFORE CHANGING THE GATE
 * -------------------------------------------
 * This suite WRITES DATA. It is therefore gated on `TEST_DATABASE_URL` and
 * **never falls back to `DATABASE_URL`**. That fallback is exactly how a
 * destructive test suite ends up pointed at production, so the omission is
 * deliberate and must not be "fixed".
 *
 * Every write happens inside a transaction that is always rolled back, so the
 * suite leaves no residue even on failure. Nothing is dropped, truncated or
 * deleted, so a stray run against a populated database still cannot destroy
 * existing data.
 *
 * The connection string is never logged.
 *
 * Runs only via `pnpm test:db`; skips itself when the variable is absent,
 * reporting SKIPPED rather than a false PASS.
 */

const testDatabaseUrl = process.env['TEST_DATABASE_URL']?.trim();
const hasTestDatabase = testDatabaseUrl !== undefined && testDatabaseUrl !== '';

const WORKSPACE_A = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_B = '22222222-2222-4222-8222-222222222222';
const AGENT_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const AGENT_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

/** Both tenants deliberately reuse these identifiers. That is the point. */
const SHARED_EXTERNAL_ID = 'agent-1';
const SHARED_EVENT_ID = 'evt-shared-123';

/** Sentinel used to force a rollback without failing the test. */
class Rollback extends Error {}

let pool: ReturnType<typeof createDatabasePool> | undefined;

afterAll(async () => {
  if (pool !== undefined) {
    await closeDatabasePool(pool);
  }
});

describe.skipIf(!hasTestDatabase)('live cross-tenant isolation', () => {
  function getDb(): ReturnType<typeof createDatabaseClient> {
    pool ??= createDatabasePool({
      connectionString: testDatabaseUrl as string,
      maxConnections: 2,
      applicationName: 'hybrid-tenant-isolation-test',
    });
    return createDatabaseClient(pool);
  }

  it('isolates two workspaces sharing identical external identifiers', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        // ---- Arrange: two tenants, deliberately colliding identifiers -----
        await tx.insert(workspaces).values([
          { id: WORKSPACE_A, name: 'Tenant A' },
          { id: WORKSPACE_B, name: 'Tenant B' },
        ]);

        await tx.insert(agents).values([
          { id: AGENT_A, workspaceId: WORKSPACE_A, externalId: SHARED_EXTERNAL_ID },
          { id: AGENT_B, workspaceId: WORKSPACE_B, externalId: SHARED_EXTERNAL_ID },
        ]);

        await tx.insert(events).values([
          {
            workspaceId: WORKSPACE_A,
            eventId: SHARED_EVENT_ID,
            agentId: AGENT_A,
            type: 'heartbeat',
            payload: { tenant: 'A' },
          },
          {
            workspaceId: WORKSPACE_B,
            eventId: SHARED_EVENT_ID,
            agentId: AGENT_B,
            type: 'heartbeat',
            payload: { tenant: 'B' },
          },
        ]);

        // Repositories are constructed on `tx`, which also proves transaction
        // compatibility against a real PostgreSQL transaction.
        const scopeA = createWorkspaceScope(WORKSPACE_A);
        const scopeB = createWorkspaceScope(WORKSPACE_B);
        const agentsA = createAgentRepository(tx, scopeA);
        const agentsB = createAgentRepository(tx, scopeB);
        const eventsA = createEventRepository(tx, scopeA);
        const eventsB = createEventRepository(tx, scopeB);

        // ---- Assert: shared external id resolves per tenant ---------------
        expect((await agentsA.findByExternalId(SHARED_EXTERNAL_ID))?.id).toBe(AGENT_A);
        expect((await agentsB.findByExternalId(SHARED_EXTERNAL_ID))?.id).toBe(AGENT_B);

        // ---- Assert: shared event id resolves per tenant ------------------
        const eventA = await eventsA.findByEventId(SHARED_EVENT_ID);
        const eventB = await eventsB.findByEventId(SHARED_EVENT_ID);
        expect(eventA?.workspaceId).toBe(WORKSPACE_A);
        expect(eventB?.workspaceId).toBe(WORKSPACE_B);
        expect(eventA?.payload).toEqual({ tenant: 'A' });
        expect(eventB?.payload).toEqual({ tenant: 'B' });

        // ---- Assert: a UUID from the other tenant is NOT authorization ----
        expect(await agentsA.findById(AGENT_B)).toBeNull();
        expect(await agentsB.findById(AGENT_A)).toBeNull();

        // ---- Assert: listing never crosses the boundary -------------------
        const listA = await agentsA.listAll();
        const listB = await agentsB.listAll();
        expect(listA.map((a) => a.id)).toEqual([AGENT_A]);
        expect(listB.map((a) => a.id)).toEqual([AGENT_B]);
        expect(listA.every((a) => a.workspaceId === WORKSPACE_A)).toBe(true);

        throw new Rollback();
      });
    } catch (error) {
      // Only the rollback sentinel is swallowed; a failed assertion propagates
      // and fails the test (after PostgreSQL has rolled the transaction back).
      if (!(error instanceof Rollback)) {
        throw error;
      }
    }
  });

  it('leaves no residue after the rolled-back scenario', async () => {
    const db = getDb();

    const remaining = await db
      .select()
      .from(workspaces)
      .where(inArray(workspaces.id, [WORKSPACE_A, WORKSPACE_B]));

    expect(remaining).toEqual([]);
  });

  it('rejects a cross-workspace foreign key at the database level', async () => {
    // Defence in depth: even if query scoping were bypassed, the composite FK
    // from Step 3 must refuse an event in A referencing an agent in B.
    //
    // ─── WHY THE SQLSTATE IS ASSERTED, NOT JUST "IT THREW" ────────────────
    //
    // This test used to end in a bare `.rejects.toThrow()`, and that is not
    // the same claim. Pointing the suite at a closed port during Step 24 made
    // it PASS: `ECONNREFUSED` is a throw too, so a test about a foreign key
    // was satisfied by there being no database at all. The same assertion
    // would also have passed on a typo in the INSERT or a NOT NULL violation
    // on an unrelated column - while the foreign key was gone.
    //
    // 23503 is `foreign_key_violation` and nothing else produces it.
    //
    // ─── AND WHY THE ERROR MUST BE UNWRAPPED ──────────────────────────────
    //
    // The first CI run against real PostgreSQL failed HERE, and the database
    // was not at fault: it refused the insert correctly, with 23503 and
    // `events_workspace_agent_fkey`. Drizzle wraps driver errors, so the pg
    // error is on `.cause` and a direct `toMatchObject({ code })` on the
    // wrapper never sees it. An assertion-layer defect, not an isolation one.
    //
    // The constraint NAME is now asserted too, so this cannot start passing
    // because some other foreign key happened to fire.
    const db = getDb();

    await expectRefused(
      () =>
        db.transaction(async (tx) => {
          await tx.insert(workspaces).values([
            { id: WORKSPACE_A, name: 'Tenant A' },
            { id: WORKSPACE_B, name: 'Tenant B' },
          ]);
          await tx
            .insert(agents)
            .values([{ id: AGENT_B, workspaceId: WORKSPACE_B, externalId: SHARED_EXTERNAL_ID }]);

          // Workspace A event pointing at workspace B's agent - must fail.
          await tx.insert(events).values({
            workspaceId: WORKSPACE_A,
            eventId: 'evt-cross-tenant',
            agentId: AGENT_B,
            type: 'heartbeat',
            payload: {},
          });
        }),
      { code: PG.foreignKeyViolation, constraint: 'events_workspace_agent_fkey' },
    );
  });
});
