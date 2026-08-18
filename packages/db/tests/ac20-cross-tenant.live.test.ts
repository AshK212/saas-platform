import { inArray } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { closeDatabasePool, createDatabaseClient, createDatabasePool } from '../src/client';
import { createLedgerRepository } from '../src/repositories/ledger';
import { blockAuditQueries } from '../src/repositories/blocks';
import { demoSettingsQueries } from '../src/repositories/demo-settings';
import { policyQueries } from '../src/repositories/policy';
import { receiptQueries } from '../src/repositories/receipts';
import { shareTokenQueries } from '../src/repositories/share-tokens';
import { createWorkspaceScope } from '../src/repositories/workspace-scope';
import { resolvePublicDemo } from '../src/resolvers/demo';
import { agents } from '../src/schema/agents';
import { blocks } from '../src/schema/blocks';
import { events } from '../src/schema/events';
import { ledgerDaily } from '../src/schema/ledger';
import { agentPolicies, workspacePolicyState } from '../src/schema/policy';
import { precheckReceipts } from '../src/schema/receipts';
import { shareTokens } from '../src/schema/sharing';
import { workspaces } from '../src/schema/workspaces';
import type { UtcAccountingDay } from '../src/accounting/utc-day';
import { PG, expectRefused } from './helpers/pg-errors';

/**
 * AC-20 — LIVE CROSS-TENANT ACCEPTANCE.
 *
 * The third and only conclusive isolation layer.
 *
 *   1. `apps/api/tests/ac20-cross-tenant.test.ts`  - scope DERIVATION, over HTTP
 *   2. `packages/db/tests/ac20-sql-isolation.test.ts` - scope REACHES SQL
 *   3. this file                                   - PostgreSQL ENFORCES it
 *
 * Layers 1 and 2 are arguments about code. This is the only layer that can
 * observe the database actually refusing something, and it covers the claims
 * the other two structurally cannot reach:
 *
 *   - a UNIQUE constraint that is scoped by workspace, so the SAME action_id,
 *     event_id, external agent id and external block id can exist in two
 *     tenants at once - and a second row in ONE tenant still collides;
 *   - a COMPOSITE FOREIGN KEY refusing a row in A that points at an agent in
 *     B, which is the defence that survives a missing WHERE clause;
 *   - the ledger primary key `(workspace_id, agent_id, day)` genuinely keeping
 *     two rows apart for one external agent id;
 *   - `SELECT … FOR UPDATE` locking one tenant's ledger row without touching
 *     the other's;
 *   - policy versions incrementing per workspace;
 *   - the demo resolver's `demo_enabled` predicate, and the CHECK constraint
 *     that forbids a slug on a private workspace.
 *
 * ─── SAFETY: READ BEFORE CHANGING THE GATE ────────────────────────────────
 *
 * This suite WRITES DATA. It is gated on `TEST_DATABASE_URL` and **never falls
 * back to `DATABASE_URL`**. That fallback is exactly how a destructive suite
 * ends up pointed at production, so the omission is deliberate and must not be
 * "fixed". Every write happens inside a transaction that is always rolled
 * back; nothing is dropped, truncated or deleted. The connection string is
 * never logged.
 *
 * Runs only via `pnpm test:db`, and SKIPS when the variable is absent.
 *
 * ─── SKIPPED IS NOT PASSED ────────────────────────────────────────────────
 *
 * No `TEST_DATABASE_URL` exists for this project, so every test below is
 * currently skipped. AC-20 therefore cannot be reported as PASS: the layer
 * that would prove PostgreSQL enforces tenant isolation has never run.
 */

const testDatabaseUrl = process.env['TEST_DATABASE_URL']?.trim();
const hasTestDatabase = testDatabaseUrl !== undefined && testDatabaseUrl !== '';

const WS_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const WS_B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const AGENT_A = 'aaaaaaaa-1111-4111-8111-00000000000a';
const AGENT_B = 'bbbbbbbb-1111-4111-8111-00000000000b';
const RECEIPT_A = 'aaaaaaaa-2222-4222-8222-00000000000a';
const RECEIPT_B = 'bbbbbbbb-2222-4222-8222-00000000000b';
const BLOCK_A = 'aaaaaaaa-3333-4333-8333-00000000000a';
const BLOCK_B = 'bbbbbbbb-3333-4333-8333-00000000000b';
const SHARE_A = 'aaaaaaaa-4444-4444-8444-00000000000a';
const SHARE_B = 'bbbbbbbb-4444-4444-8444-00000000000b';

/** Deliberately reused by BOTH tenants. That collision is the whole test. */
const SHARED_AGENT_EXTERNAL_ID = 'agent-1';
const SHARED_EVENT_ID = 'evt-shared-001';
const SHARED_ACTION_ID = 'act-shared-001';
const SHARED_BLOCK_EXTERNAL_ID = 'blk-shared-001';
const DAY = '2026-08-16' as UtcAccountingDay;

const scopeA = createWorkspaceScope(WS_A);
const scopeB = createWorkspaceScope(WS_B);

/** Forces a rollback without failing the test. */
class Rollback extends Error {}

let pool: ReturnType<typeof createDatabasePool> | undefined;

afterAll(async () => {
  if (pool !== undefined) {
    await closeDatabasePool(pool);
  }
});

describe.skipIf(!hasTestDatabase)('AC-20 live cross-tenant acceptance', () => {
  function getDb(): ReturnType<typeof createDatabaseClient> {
    pool ??= createDatabasePool({
      connectionString: testDatabaseUrl as string,
      maxConnections: 3,
      applicationName: 'hybrid-ac20-cross-tenant-test',
    });
    return createDatabaseClient(pool);
  }

  type Tx = Parameters<Parameters<ReturnType<typeof createDatabaseClient>['transaction']>[0]>[0];

  /** Two fully-populated tenants that collide on every external identifier. */
  async function seedBothTenants(tx: Tx): Promise<void> {
    await tx.insert(workspaces).values([
      { id: WS_A, name: 'Tenant A' },
      { id: WS_B, name: 'Tenant B' },
    ]);

    await tx.insert(workspacePolicyState).values([
      { workspaceId: WS_A, version: 1 },
      { workspaceId: WS_B, version: 7 },
    ]);

    await tx.insert(agents).values([
      { id: AGENT_A, workspaceId: WS_A, externalId: SHARED_AGENT_EXTERNAL_ID },
      { id: AGENT_B, workspaceId: WS_B, externalId: SHARED_AGENT_EXTERNAL_ID },
    ]);

    await tx.insert(agentPolicies).values([
      {
        workspaceId: WS_A,
        agentId: AGENT_A,
        mode: 'budgeted',
        dailySpendCapUsd: '25.000000',
        dailyPublishCap: 5,
      },
      {
        workspaceId: WS_B,
        agentId: AGENT_B,
        mode: 'budgeted',
        dailySpendCapUsd: '99.000000',
        dailyPublishCap: 50,
      },
    ]);

    await tx.insert(events).values([
      {
        workspaceId: WS_A,
        eventId: SHARED_EVENT_ID,
        agentId: AGENT_A,
        type: 'heartbeat',
        payload: { tenant: 'A' },
      },
      {
        workspaceId: WS_B,
        eventId: SHARED_EVENT_ID,
        agentId: AGENT_B,
        type: 'heartbeat',
        payload: { tenant: 'B' },
      },
    ]);

    await tx.insert(ledgerDaily).values([
      {
        workspaceId: WS_A,
        agentId: AGENT_A,
        day: DAY,
        spendCommittedUsd: '4.000000',
        publishCountCommitted: 1,
      },
      {
        workspaceId: WS_B,
        agentId: AGENT_B,
        day: DAY,
        spendCommittedUsd: '19.000000',
        publishCountCommitted: 3,
      },
    ]);

    await tx.insert(precheckReceipts).values([
      {
        id: RECEIPT_A,
        workspaceId: WS_A,
        agentId: AGENT_A,
        actionId: SHARED_ACTION_ID,
        category: 'spend',
        decision: 'deny',
        policyVersion: 1,
        appliedMode: 'budgeted',
        denyReason: 'daily_spend_cap_exceeded',
      },
      {
        id: RECEIPT_B,
        workspaceId: WS_B,
        agentId: AGENT_B,
        actionId: SHARED_ACTION_ID,
        category: 'spend',
        decision: 'allow',
        policyVersion: 7,
        appliedMode: 'budgeted',
      },
    ]);

    await tx.insert(blocks).values([
      {
        id: BLOCK_A,
        workspaceId: WS_A,
        agentId: AGENT_A,
        externalBlockId: SHARED_BLOCK_EXTERNAL_ID,
        source: 'plane',
        category: 'spend',
        rule: 'daily_spend_cap',
        reason: 'Tenant A cap reached.',
        precheckReceiptId: RECEIPT_A,
      },
      {
        id: BLOCK_B,
        workspaceId: WS_B,
        agentId: AGENT_B,
        externalBlockId: SHARED_BLOCK_EXTERNAL_ID,
        source: 'plane',
        category: 'spend',
        rule: 'daily_spend_cap',
        reason: 'Tenant B cap reached.',
        precheckReceiptId: RECEIPT_B,
      },
    ]);

    await tx.insert(shareTokens).values([
      { id: SHARE_A, workspaceId: WS_A, tokenPrefix: 'prefix-a', tokenHash: 'hash-a' },
      { id: SHARE_B, workspaceId: WS_B, tokenPrefix: 'prefix-b', tokenHash: 'hash-b' },
    ]);
  }

  /** Runs `work` inside a transaction that is always rolled back. */
  async function inRolledBackTransaction(work: (tx: Tx) => Promise<void>): Promise<void> {
    try {
      await getDb().transaction(async (tx) => {
        await work(tx);
        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) {
        throw error;
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Colliding identifiers coexist, and every read stays on its own side
  // ─────────────────────────────────────────────────────────────────────────

  it('every colliding external identifier coexists in both tenants', async () => {
    await inRolledBackTransaction(async (tx) => {
      // The insert itself is the assertion: a globally-unique constraint on
      // any of these would have thrown during seeding.
      await seedBothTenants(tx);

      const allAgents = await tx
        .select()
        .from(agents)
        .where(inArray(agents.workspaceId, [WS_A, WS_B]));
      expect(allAgents).toHaveLength(2);

      const allReceipts = await tx
        .select()
        .from(precheckReceipts)
        .where(inArray(precheckReceipts.workspaceId, [WS_A, WS_B]));
      expect(allReceipts).toHaveLength(2);

      const allBlocks = await tx
        .select()
        .from(blocks)
        .where(inArray(blocks.workspaceId, [WS_A, WS_B]));
      expect(allBlocks).toHaveLength(2);
    });
  });

  it('a DUPLICATE inside ONE tenant is still refused', async () => {
    // The other half of a workspace-scoped unique constraint. Without this,
    // "both tenants can hold act-shared-001" might simply mean the constraint
    // is gone, and idempotency would be broken rather than scoped.
    await expectRefused(
      () =>
        getDb().transaction(async (tx) => {
        await seedBothTenants(tx);
        await tx.insert(precheckReceipts).values({
          workspaceId: WS_A,
          agentId: AGENT_A,
          actionId: SHARED_ACTION_ID,
          category: 'spend',
          decision: 'allow',
          policyVersion: 1,
          appliedMode: 'budgeted',
        });
        }),
      { code: PG.uniqueViolation, constraint: 'precheck_receipts_workspace_action_id_key' },
    );
  });

  it('a duplicate event_id inside one tenant is refused', async () => {
    await expectRefused(
      () =>
        getDb().transaction(async (tx) => {
        await seedBothTenants(tx);
        await tx.insert(events).values({
          workspaceId: WS_A,
          eventId: SHARED_EVENT_ID,
          agentId: AGENT_A,
          type: 'heartbeat',
          payload: {},
        });
        }),
      { code: PG.uniqueViolation, constraint: 'events_workspace_event_id_key' },
    );
  });

  it('a duplicate external block id inside one tenant is refused', async () => {
    await expectRefused(
      () =>
        getDb().transaction(async (tx) => {
        await seedBothTenants(tx);
        await tx.insert(blocks).values({
          workspaceId: WS_A,
          agentId: AGENT_A,
          externalBlockId: SHARED_BLOCK_EXTERNAL_ID,
          source: 'runtime',
          category: 'spend',
          rule: 'daily_spend_cap',
          reason: 'again',
        });
        }),
      { code: PG.uniqueViolation, constraint: 'blocks_workspace_external_block_id_key' },
    );
  });

  it('a duplicate agent external id inside one tenant is refused', async () => {
    await expectRefused(
      () =>
        getDb().transaction(async (tx) => {
        await seedBothTenants(tx);
        await tx
          .insert(agents)
          .values({ workspaceId: WS_A, externalId: SHARED_AGENT_EXTERNAL_ID });
        }),
      { code: PG.uniqueViolation, constraint: 'agents_workspace_external_id_key' },
    );
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Reads: a captured UUID is not authorization
  // ─────────────────────────────────────────────────────────────────────────

  it("every scoped read refuses the other tenant's exact UUID", async () => {
    await inRolledBackTransaction(async (tx) => {
      await seedBothTenants(tx);

      // Receipts.
      expect(await receiptQueries.findById(tx, scopeA, RECEIPT_B)).toEqual([]);
      expect(await receiptQueries.findAuditById(tx, scopeA, RECEIPT_B)).toEqual([]);
      expect(await receiptQueries.exists(tx, scopeA, RECEIPT_B)).toEqual([]);
      // ... and accepts its own, so the emptiness above is scoping.
      expect(await receiptQueries.findById(tx, scopeA, RECEIPT_A)).toHaveLength(1);

      // Blocks.
      expect(await blockAuditQueries.findById(tx, scopeA, BLOCK_B)).toEqual([]);
      expect(await blockAuditQueries.findById(tx, scopeA, BLOCK_A)).toHaveLength(1);

      // Policy.
      expect(await policyQueries.findAgentPolicy(tx, scopeA, AGENT_B)).toEqual([]);
      expect(await policyQueries.findAgentPolicy(tx, scopeA, AGENT_A)).toHaveLength(1);

      // Share tokens.
      expect(await shareTokenQueries.findById(tx, scopeA, SHARE_B)).toEqual([]);
      expect(await shareTokenQueries.findById(tx, scopeA, SHARE_A)).toHaveLength(1);
    });
  });

  it('a shared action_id resolves to a DIFFERENT receipt in each tenant', async () => {
    await inRolledBackTransaction(async (tx) => {
      await seedBothTenants(tx);

      const fromA = await receiptQueries.findByActionId(tx, scopeA, SHARED_ACTION_ID);
      const fromB = await receiptQueries.findByActionId(tx, scopeB, SHARED_ACTION_ID);

      expect(fromA[0]?.id).toBe(RECEIPT_A);
      expect(fromB[0]?.id).toBe(RECEIPT_B);
      // Not merely different rows - different DECISIONS, so a leak would be
      // an enforcement failure and not only a privacy one.
      expect(fromA[0]?.decision).toBe('deny');
      expect(fromB[0]?.decision).toBe('allow');
    });
  });

  it('listing never crosses the boundary on any audit surface', async () => {
    await inRolledBackTransaction(async (tx) => {
      await seedBothTenants(tx);

      const receiptsA = await receiptQueries.listAudit(tx, scopeA, { limit: 50 });
      const blocksA = await blockAuditQueries.list(tx, scopeA, { limit: 50 });
      const sharesA = await shareTokenQueries.list(tx, scopeA);
      const policiesA = await policyQueries.listEffectivePolicies(tx, scopeA);

      expect(receiptsA.map((r) => r.id)).toEqual([RECEIPT_A]);
      expect(blocksA.map((r) => r.id)).toEqual([BLOCK_A]);
      expect(sharesA.map((r) => r.id)).toEqual([SHARE_A]);
      expect(policiesA).toHaveLength(1);
      expect(policiesA[0]?.dailySpendCapUsd).toBe('25.000000');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Composite foreign keys: the defence that survives a missing WHERE clause
  // ─────────────────────────────────────────────────────────────────────────

  const CROSS_TENANT_INSERTS: {
    name: string;
    /** The exact composite FK that must refuse the row. */
    constraint: string;
    insert: (tx: Tx) => Promise<unknown>;
  }[] = [
    {
      name: 'an event in A referencing B agent',
      constraint: 'events_workspace_agent_fkey',
      insert: (tx) =>
        tx.insert(events).values({
          workspaceId: WS_A,
          eventId: 'evt-cross',
          agentId: AGENT_B,
          type: 'heartbeat',
          payload: {},
        }),
    },
    {
      name: 'a ledger row in A for B agent',
      constraint: 'ledger_daily_workspace_agent_fkey',
      insert: (tx) =>
        tx.insert(ledgerDaily).values({ workspaceId: WS_A, agentId: AGENT_B, day: DAY }),
    },
    {
      name: 'a receipt in A for B agent',
      constraint: 'precheck_receipts_workspace_agent_fkey',
      insert: (tx) =>
        tx.insert(precheckReceipts).values({
          workspaceId: WS_A,
          agentId: AGENT_B,
          actionId: 'act-cross',
          category: 'spend',
          decision: 'allow',
          policyVersion: 1,
          appliedMode: 'budgeted',
        }),
    },
    {
      name: 'a block in A for B agent',
      constraint: 'blocks_workspace_agent_fkey',
      insert: (tx) =>
        tx.insert(blocks).values({
          workspaceId: WS_A,
          agentId: AGENT_B,
          source: 'plane',
          category: 'spend',
          rule: 'daily_spend_cap',
          reason: 'cross',
        }),
    },
    {
      name: "a block in A linked to B's receipt",
      constraint: 'blocks_workspace_precheck_receipt_fkey',
      insert: (tx) =>
        tx.insert(blocks).values({
          workspaceId: WS_A,
          agentId: AGENT_A,
          source: 'plane',
          category: 'spend',
          rule: 'daily_spend_cap',
          reason: 'cross-receipt',
          precheckReceiptId: RECEIPT_B,
        }),
    },
    {
      name: 'an agent policy in A for B agent',
      constraint: 'agent_policies_workspace_agent_fkey',
      insert: (tx) =>
        tx.insert(agentPolicies).values({
          workspaceId: WS_A,
          agentId: AGENT_B,
          mode: 'paused',
        }),
    },
  ];

  it.each(CROSS_TENANT_INSERTS)('PostgreSQL refuses $name', async ({ insert, constraint }) => {
    // The last line of defence. Even with every WHERE clause removed, these
    // rows cannot exist, because the composite key names the workspace.
    await expectRefused(
      () =>
        getDb().transaction(async (tx) => {
        await seedBothTenants(tx);
        await insert(tx);
        }),
      // A composite FK refusing the row - not a unique clash, not any other
      // error, and specifically the FK named by this case.
      { code: PG.foreignKeyViolation, constraint },
    );
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Ledger: the authoritative accounting boundary
  // ─────────────────────────────────────────────────────────────────────────

  it('one external agent id keeps two independent ledger rows', async () => {
    await inRolledBackTransaction(async (tx) => {
      await seedBothTenants(tx);

      const ledgerA = createLedgerRepository(tx, scopeA);
      const ledgerB = createLedgerRepository(tx, scopeB);

      expect((await ledgerA.findDailyLedger(AGENT_A, DAY))?.spendCommittedUsd).toBe('4.000000');
      expect((await ledgerB.findDailyLedger(AGENT_B, DAY))?.spendCommittedUsd).toBe('19.000000');
    });
  });

  it("a foreign agent UUID yields NO locked ledger capability and creates no row", async () => {
    // The strongest ledger claim: holding B's internal agent id must not let A
    // open a mutation capability, and must not leave a row behind in the
    // attempt. `lockDailyLedger` screens the agent BEFORE its insert.
    await inRolledBackTransaction(async (tx) => {
      await seedBothTenants(tx);

      const ledgerA = createLedgerRepository(tx, scopeA);
      expect(await ledgerA.lockDailyLedger(AGENT_B, DAY)).toBeNull();

      const rows = await tx
        .select()
        .from(ledgerDaily)
        .where(inArray(ledgerDaily.workspaceId, [WS_A, WS_B]));
      // Still exactly the two seeded rows: no phantom (A, AGENT_B) row.
      expect(rows).toHaveLength(2);
    });
  });

  it("committing spend in A leaves B's ledger row untouched", async () => {
    await inRolledBackTransaction(async (tx) => {
      await seedBothTenants(tx);

      const locked = await createLedgerRepository(tx, scopeA).lockDailyLedger(AGENT_A, DAY);
      expect(locked).not.toBeNull();
      await locked?.commitSpend('6.000000');

      const after = await createLedgerRepository(tx, scopeB).findDailyLedger(AGENT_B, DAY);
      expect(after?.spendCommittedUsd).toBe('19.000000');
      expect(
        (await createLedgerRepository(tx, scopeA).findDailyLedger(AGENT_A, DAY))
          ?.spendCommittedUsd,
      ).toBe('10.000000');
    });
  });

  it('the ledger primary key refuses a second row for the same workspace, agent and day', async () => {
    await expectRefused(
      () =>
        getDb().transaction(async (tx) => {
        await seedBothTenants(tx);
        await tx.insert(ledgerDaily).values({ workspaceId: WS_A, agentId: AGENT_A, day: DAY });
        }),
      // The composite PRIMARY KEY (workspace_id, agent_id, day).
      { code: PG.uniqueViolation, constraint: 'ledger_daily_pkey' },
    );
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Policy versions
  // ─────────────────────────────────────────────────────────────────────────

  it('policy versions are per workspace and move independently', async () => {
    await inRolledBackTransaction(async (tx) => {
      await seedBothTenants(tx);

      // STRINGS, not numbers. `version` is a bigint, and `findVersion`
      // deliberately selects it as `::text` with `sql<string>`: a version can
      // exceed Number.MAX_SAFE_INTEGER, and the contract
      // (`policyVersionSchema`) is a decimal string for exactly that reason.
      // It is only ever compared for equality and ordering, never arithmetic.
      //
      // This assertion said `1` until the first real PostgreSQL run corrected
      // it. The production representation was right; the test was wrong.
      expect((await policyQueries.findVersion(tx, scopeA))[0]?.version).toBe('1');
      expect((await policyQueries.findVersion(tx, scopeB))[0]?.version).toBe('7');

      // A locking read in A must not block or alter B's row.
      await policyQueries.lockVersionForShare(tx, scopeA);

      expect((await policyQueries.findVersion(tx, scopeB))[0]?.version).toBe('7');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Public demo resolution (AC-19) against real SQL
  // ─────────────────────────────────────────────────────────────────────────

  it('a demo slug resolves only its own workspace, and only while enabled', async () => {
    await inRolledBackTransaction(async (tx) => {
      await seedBothTenants(tx);
      await tx.insert(workspaces).values({
        id: 'cccccccc-0000-4000-8000-00000000000c',
        name: 'Tenant C',
      });

      // Enable A only.
      await demoSettingsQueries.find(tx, scopeA);
      await tx
        .update(workspaces)
        .set({ demoEnabled: true, demoSlug: 'tenant-a-abcd1234' })
        .where(inArray(workspaces.id, [WS_A]));

      const resolved = await resolvePublicDemo(tx, 'tenant-a-abcd1234');
      expect(resolved?.workspaceId).toBe(WS_A);
      expect(resolved?.scope.workspaceId).toBe(WS_A);

      // B is private and unreachable by any slug.
      expect(await resolvePublicDemo(tx, 'tenant-b-abcd1234')).toBeNull();
    });
  });

  it('the CHECK constraint forbids a slug on a private workspace', async () => {
    // This is what makes "disable" total: the slug cannot survive the flag, so
    // a former demo URL cannot be left addressable in the table.
    await expectRefused(
      () =>
        getDb().transaction(async (tx) => {
        await seedBothTenants(tx);
        await tx
          .update(workspaces)
          .set({ demoEnabled: false, demoSlug: 'orphaned-abcd1234' })
          .where(inArray(workspaces.id, [WS_A]));
        }),
      { code: PG.checkViolation, constraint: 'workspaces_demo_slug_requires_demo_check' },
    );
  });

  it('a demo slug is globally unique, so two tenants cannot claim one address', async () => {
    await expectRefused(
      () =>
        getDb().transaction(async (tx) => {
        await seedBothTenants(tx);
        await tx
          .update(workspaces)
          .set({ demoEnabled: true, demoSlug: 'contested-abcd1234' })
          .where(inArray(workspaces.id, [WS_A]));
        await tx
          .update(workspaces)
          .set({ demoEnabled: true, demoSlug: 'contested-abcd1234' })
          .where(inArray(workspaces.id, [WS_B]));
        }),
      { code: PG.uniqueViolation, constraint: 'workspaces_demo_slug_key' },
    );
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Residue
  // ─────────────────────────────────────────────────────────────────────────

  it('leaves no residue behind', async () => {
    const remaining = await getDb()
      .select()
      .from(workspaces)
      .where(inArray(workspaces.id, [WS_A, WS_B, 'cccccccc-0000-4000-8000-00000000000c']));

    expect(remaining).toEqual([]);
  });
});
