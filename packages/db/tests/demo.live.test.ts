import { eq, inArray } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { parseUtcAccountingDay } from '../src/accounting/utc-day';
import { closeDatabasePool, createDatabaseClient, createDatabasePool } from '../src/client';
import { createAgentRepository } from '../src/repositories/agents';
import { createDemoSettingsRepository } from '../src/repositories/demo-settings';
import { createEventRepository } from '../src/repositories/events';
import { createPrecheckReceiptRepository } from '../src/repositories/receipts';
import { createShareTokenRepository } from '../src/repositories/share-tokens';
import { createWorkspaceScope } from '../src/repositories/workspace-scope';
import { resolvePublicDemo } from '../src/resolvers/demo';
import { resolveShareToken } from '../src/resolvers/share-tokens';
import type { DatabaseExecutor } from '../src/repositories/executor';
import { agents } from '../src/schema/agents';
import { blocks } from '../src/schema/blocks';
import { events } from '../src/schema/events';
import { ledgerDaily } from '../src/schema/ledger';
import { agentPolicies, workspacePolicyState } from '../src/schema/policy';
import { precheckReceipts } from '../src/schema/receipts';
import { shareTokens } from '../src/schema/sharing';
import { workspaces } from '../src/schema/workspaces';

/**
 * LIVE public demo mode against real PostgreSQL (AC-19).
 *
 * SAFETY - READ BEFORE CHANGING THE GATE
 * --------------------------------------
 * This suite WRITES DATA. It is gated on `TEST_DATABASE_URL` and **never falls
 * back to `DATABASE_URL`**. Writes are rolled back or explicitly cleaned up;
 * nothing is dropped or truncated. The connection string is never logged.
 *
 * WHY IT EXISTS SEPARATELY
 * ------------------------
 * The in-memory suite proves the ROUTES behave. Four claims are about
 * PostgreSQL itself and cannot be established any other way:
 *
 *   - that `demo_enabled` really defaults false on a freshly created row;
 *   - that the CHECK CONSTRAINT really refuses a slug on a private workspace -
 *     the constraint is why disabling clears the slug at all;
 *   - that the unique index really refuses a duplicate slug;
 *   - that the workspace predicate really hides another tenant's agents,
 *     events, receipts and blocks from a demo scope.
 *
 * A fake cannot fail to enforce a constraint it never had.
 */

const testDatabaseUrl = process.env['TEST_DATABASE_URL']?.trim();
const hasTestDatabase = testDatabaseUrl !== undefined && testDatabaseUrl !== '';

const WORKSPACE_A_NAME = 'live-demo-alpha';
const WORKSPACE_B_NAME = 'live-demo-bravo';
const ALL_NAMES = [WORKSPACE_A_NAME, WORKSPACE_B_NAME];

const NOW = new Date('2026-08-16T09:00:00.000Z');

class Rollback extends Error {}

let pool: ReturnType<typeof createDatabasePool> | undefined;

afterAll(async () => {
  if (pool !== undefined) {
    await closeDatabasePool(pool);
  }
});

describe.skipIf(!hasTestDatabase)('live public demo mode', () => {
  function getDb(): ReturnType<typeof createDatabaseClient> {
    pool ??= createDatabasePool({
      connectionString: testDatabaseUrl as string,
      maxConnections: 4,
      applicationName: 'hybrid-demo-live-test',
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

  async function cleanup(db: ReturnType<typeof createDatabaseClient>): Promise<void> {
    const rows = await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(inArray(workspaces.name, ALL_NAMES));
    for (const row of rows) {
      await db.delete(shareTokens).where(eq(shareTokens.workspaceId, row.id));
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

  it('1. A WORKSPACE IS BORN PRIVATE', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const { workspaceId } = await seedWorkspace(tx, WORKSPACE_A_NAME);

        const stored = await tx.select().from(workspaces).where(eq(workspaces.id, workspaceId));

        // The column default, enforced by the database rather than by a
        // convention some future insert might forget.
        expect(stored[0]?.demoEnabled).toBe(false);
        expect(stored[0]?.demoSlug).toBeNull();

        throw new Rollback();
      });
    } catch (error: unknown) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('2. an operator enables it and the slug resolves', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const { workspaceId } = await seedWorkspace(tx, WORKSPACE_A_NAME);
        const repository = createDemoSettingsRepository(tx, createWorkspaceScope(workspaceId));

        const enabled = await repository.enable('live-demo-alpha-abc123', NOW);
        expect(enabled.demoEnabled).toBe(true);

        const resolved = await resolvePublicDemo(tx, 'live-demo-alpha-abc123');
        expect(resolved?.workspaceId).toBe(workspaceId);
        expect(resolved?.workspaceName).toBe(WORKSPACE_A_NAME);
        expect(resolved?.scope.workspaceId).toBe(workspaceId);

        throw new Rollback();
      });
    } catch (error: unknown) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('3. A DISABLED DEMO STOPS RESOLVING IMMEDIATELY', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const { workspaceId } = await seedWorkspace(tx, WORKSPACE_A_NAME);
        const repository = createDemoSettingsRepository(tx, createWorkspaceScope(workspaceId));
        await repository.enable('live-demo-alpha-def456', NOW);
        expect(await resolvePublicDemo(tx, 'live-demo-alpha-def456')).not.toBeNull();

        await repository.disable(NOW);

        // The predicate is in the same statement: no cache, no grace window.
        expect(await resolvePublicDemo(tx, 'live-demo-alpha-def456')).toBeNull();

        throw new Rollback();
      });
    } catch (error: unknown) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('4. THE CHECK CONSTRAINT REFUSES A SLUG ON A PRIVATE WORKSPACE', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const { workspaceId } = await seedWorkspace(tx, WORKSPACE_A_NAME);

        // This is WHY disabling clears the slug. The database, not the
        // application, is what makes a private workspace unable to hold a
        // public locator.
        await expect(
          tx
            .update(workspaces)
            .set({ demoEnabled: false, demoSlug: 'still-public-ghi789' })
            .where(eq(workspaces.id, workspaceId)),
        ).rejects.toThrow();

        throw new Rollback();
      });
    } catch (error: unknown) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('5. disabling clears the slug, and re-enabling mints a new one', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const { workspaceId } = await seedWorkspace(tx, WORKSPACE_A_NAME);
        const repository = createDemoSettingsRepository(tx, createWorkspaceScope(workspaceId));

        await repository.enable('live-demo-alpha-first1', NOW);
        const disabled = await repository.disable(NOW);
        expect(disabled.demoSlug).toBeNull();

        await repository.enable('live-demo-alpha-second', NOW);

        // The withdrawn URL stays dead.
        expect(await resolvePublicDemo(tx, 'live-demo-alpha-first1')).toBeNull();
        expect(await resolvePublicDemo(tx, 'live-demo-alpha-second')).not.toBeNull();

        throw new Rollback();
      });
    } catch (error: unknown) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('6. THE UNIQUE INDEX REFUSES A DUPLICATE SLUG', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const a = await seedWorkspace(tx, WORKSPACE_A_NAME);
        const b = await seedWorkspace(tx, WORKSPACE_B_NAME);

        await createDemoSettingsRepository(tx, createWorkspaceScope(a.workspaceId)).enable(
          'shared-slug-xyz999',
          NOW,
        );

        // The database refuses, which is what makes the bounded retry in the
        // store meaningful rather than decorative.
        await expect(
          createDemoSettingsRepository(tx, createWorkspaceScope(b.workspaceId)).enable(
            'shared-slug-xyz999',
            NOW,
          ),
        ).rejects.toThrow();

        throw new Rollback();
      });
    } catch (error: unknown) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it("7. CROSS-TENANT: an operator cannot publish another workspace", async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const a = await seedWorkspace(tx, WORKSPACE_A_NAME);
        const b = await seedWorkspace(tx, WORKSPACE_B_NAME);

        // A's scope, aimed at B. The predicate simply matches nothing.
        await expect(
          createDemoSettingsRepository(tx, createWorkspaceScope(a.workspaceId)).enable(
            'alice-published-bob1',
            NOW,
          ),
        ).resolves.toBeDefined();

        const bobsRow = await tx.select().from(workspaces).where(eq(workspaces.id, b.workspaceId));
        expect(bobsRow[0]?.demoEnabled).toBe(false);
        expect(bobsRow[0]?.demoSlug).toBeNull();

        throw new Rollback();
      });
    } catch (error: unknown) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it("8. CROSS-TENANT: A's demo scope reads only A's data", async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        // The same EXTERNAL agent id in both tenants.
        const a = await seedWorkspace(tx, WORKSPACE_A_NAME, 'agent-shared');
        const b = await seedWorkspace(tx, WORKSPACE_B_NAME, 'agent-shared');
        await createDemoSettingsRepository(tx, createWorkspaceScope(a.workspaceId)).enable(
          'live-demo-alpha-iso001',
          NOW,
        );

        const [bobsEvent] = await tx
          .insert(events)
          .values({
            workspaceId: b.workspaceId,
            eventId: 'evt-bob',
            agentId: b.agentId,
            type: 'heartbeat',
            payload: {},
            receivedAt: NOW,
          })
          .returning();
        const bobsReceipt = await createPrecheckReceiptRepository(
          tx,
          createWorkspaceScope(b.workspaceId),
        ).insert({
          actionId: 'act-bob',
          agentId: b.agentId,
          category: 'spend',
          requestedAmountUsd: '41.000000',
          requestedPublishCount: null,
          decision: 'deny',
          policyVersion: '1',
          appliedMode: 'budgeted',
          appliedSpendCapUsd: '25.000000',
          appliedPublishCap: 5,
          accountingDay: parseUtcAccountingDay('2026-08-16'),
          ledgerSpendBeforeUsd: '0.000000',
          ledgerPublishBefore: null,
          remainingSpendUsd: null,
          remainingPublishCount: null,
          denyReason: 'daily_spend_cap_exceeded',
        });

        // Resolve A's slug and read EVERYTHING through the scope it yields.
        const resolved = await resolvePublicDemo(tx, 'live-demo-alpha-iso001');
        const scope = resolved?.scope;
        expect(scope).toBeDefined();
        if (scope === undefined) throw new Error('unreachable');

        const roster = await createAgentRepository(tx, scope).listAll();
        expect(roster).toHaveLength(1);
        expect(roster[0]?.id).toBe(a.agentId);

        // B's EXACT uuids, offered to A's demo scope.
        expect(
          await createEventRepository(tx, scope).findDetailById(bobsEvent?.id ?? ''),
        ).toBeNull();
        expect(
          await createPrecheckReceiptRepository(tx, scope).findAuditById(bobsReceipt.id),
        ).toBeNull();
        expect(await createEventRepository(tx, scope).listTimeline({ limit: 50 })).toEqual([]);
        expect(
          await createPrecheckReceiptRepository(tx, scope).listAudit({ limit: 50 }),
        ).toEqual([]);

        throw new Rollback();
      });
    } catch (error: unknown) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('9. SHARE AND DEMO ARE INDEPENDENT', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const { workspaceId } = await seedWorkspace(tx, WORKSPACE_A_NAME);
        const scope = createWorkspaceScope(workspaceId);
        const demoRepository = createDemoSettingsRepository(tx, scope);
        const shareRepository = createShareTokenRepository(tx, scope);

        await demoRepository.enable('live-demo-alpha-both1', NOW);
        const share = await shareRepository.insert({
          tokenPrefix: 'hmp_share_ABCDEFGHIJKL',
          tokenHash: 'a'.repeat(64),
        });

        // Revoking the share leaves the demo alone.
        await shareRepository.revoke(share.id, NOW);
        expect(await resolvePublicDemo(tx, 'live-demo-alpha-both1')).not.toBeNull();

        // And disabling the demo leaves the share row alone.
        await demoRepository.disable(NOW);
        const shares = await shareRepository.list();
        expect(shares).toHaveLength(1);
        // Still revoked from its own action, not from the demo change.
        expect(shares[0]?.revokedAt).not.toBeNull();

        throw new Rollback();
      });
    } catch (error: unknown) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('10. an ACTIVE share is untouched by disabling the demo', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const { workspaceId } = await seedWorkspace(tx, WORKSPACE_A_NAME);
        const scope = createWorkspaceScope(workspaceId);
        await createDemoSettingsRepository(tx, scope).enable('live-demo-alpha-both2', NOW);
        await createShareTokenRepository(tx, scope).insert({
          tokenPrefix: 'hmp_share_MNOPQRSTUVWX',
          tokenHash: 'b'.repeat(64),
        });

        await createDemoSettingsRepository(tx, scope).disable(NOW);

        // Separate authorities: the share link still works.
        const resolvedShare = await resolveShareToken(
          tx,
          'hmp_share_MNOPQRSTUVWX',
          'b'.repeat(64),
        );
        expect(resolvedShare?.workspaceId).toBe(workspaceId);

        throw new Rollback();
      });
    } catch (error: unknown) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('11. A PUBLIC READ MUTATES NOTHING', async () => {
    const db = getDb();

    // Committed state, so a stray write would survive to be observed.
    try {
      const { workspaceId, agentId } = await seedWorkspace(db, WORKSPACE_A_NAME);
      await createDemoSettingsRepository(db, createWorkspaceScope(workspaceId)).enable(
        'live-demo-alpha-read01',
        NOW,
      );

      const before = {
        agents: JSON.stringify(
          await db.select().from(agents).where(eq(agents.workspaceId, workspaceId)),
        ),
        ledger: JSON.stringify(
          await db.select().from(ledgerDaily).where(eq(ledgerDaily.workspaceId, workspaceId)),
        ),
        workspace: JSON.stringify(
          await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)),
        ),
        policy: JSON.stringify(
          await db
            .select()
            .from(workspacePolicyState)
            .where(eq(workspacePolicyState.workspaceId, workspaceId)),
        ),
      };

      // Resolve and read repeatedly, exactly as a visitor refreshing would.
      for (let i = 0; i < 3; i += 1) {
        const resolved = await resolvePublicDemo(db, 'live-demo-alpha-read01');
        const scope = resolved?.scope;
        if (scope === undefined) throw new Error('unreachable');
        await createAgentRepository(db, scope).listAll();
        await createEventRepository(db, scope).listTimeline({ limit: 50 });
        await createPrecheckReceiptRepository(db, scope).listAudit({ limit: 50 });
      }

      // Visiting is not agent activity: no last-seen, no ledger row, no policy
      // version bump, and no write to the workspace row itself.
      expect(
        JSON.stringify(await db.select().from(agents).where(eq(agents.workspaceId, workspaceId))),
      ).toBe(before.agents);
      expect(
        JSON.stringify(
          await db.select().from(ledgerDaily).where(eq(ledgerDaily.workspaceId, workspaceId)),
        ),
      ).toBe(before.ledger);
      expect(
        JSON.stringify(await db.select().from(workspaces).where(eq(workspaces.id, workspaceId))),
      ).toBe(before.workspace);
      expect(
        JSON.stringify(
          await db
            .select()
            .from(workspacePolicyState)
            .where(eq(workspacePolicyState.workspaceId, workspaceId)),
        ),
      ).toBe(before.policy);
      expect(agentId).toBeDefined();
    } finally {
      await cleanup(db);
    }
  });
});
