import { afterAll, describe, expect, it } from 'vitest';

import { closeDatabasePool, createDatabaseClient, createDatabasePool } from '../src/client';
import { agentQueries } from '../src/repositories/agents';
import { blockAuditQueries } from '../src/repositories/blocks';
import { demoSettingsQueries } from '../src/repositories/demo-settings';
import { eventQueries } from '../src/repositories/events';
import { ledgerQueries } from '../src/repositories/ledger';
import { planeBlockQueries } from '../src/repositories/plane-blocks';
import { policyQueries } from '../src/repositories/policy';
import { receiptQueries } from '../src/repositories/receipts';
import { runtimeProfileQueries } from '../src/repositories/runtime-profiles';
import { shareTokenQueries } from '../src/repositories/share-tokens';
import { createWorkspaceScope, type WorkspaceScope } from '../src/repositories/workspace-scope';
import type { UtcAccountingDay } from '../src/accounting/utc-day';

/**
 * AC-20 — SQL ISOLATION EVIDENCE.
 *
 * The middle of the three AC-20 layers.
 *
 *   1. `apps/api/tests/ac20-cross-tenant.test.ts`  - scope DERIVATION, over HTTP
 *   2. this file                                   - scope REACHES SQL
 *   3. `ac20-cross-tenant.live.test.ts`            - PostgreSQL ENFORCES it
 *
 * Layer 1 drives in-memory fakes, and a fake cannot forget a WHERE clause it
 * never had. So route tests alone can never establish that a repository query
 * is tenant-scoped. This file closes that gap the only way it can be closed
 * without a database: it COMPILES every tenant-owned query and asserts that
 * `workspace_id` participates in the predicate with the scope's id bound as a
 * parameter.
 *
 * ─── WHY EVERY QUERY AND NOT A SAMPLE ─────────────────────────────────────
 *
 * The predecessor of this file (`tenant-scoping.test.ts`) covered the three
 * tables that existed at Step 4: agents, events and runtime profiles. Eleven
 * steps later the schema also holds policies, policy state, the ledger,
 * receipts, plane blocks, the block audit, share tokens and demo settings -
 * every one of them tenant-owned, and none of them covered.
 *
 * A missing predicate on any single one is a full cross-tenant read. So the
 * list below is derived from the exported query builders rather than chosen,
 * and a guard at the bottom fails if a new builder appears without a case
 * here.
 *
 * ─── WHY A PREDICATE AND NOT A JAVASCRIPT CHECK ───────────────────────────
 *
 * A row belonging to another workspace cannot satisfy `workspace_id = $A`, so
 * it is never in the result set to be leaked, logged, counted or compared. A
 * post-hoc check in TypeScript would still have fetched it.
 *
 * No connection is opened: `pg.Pool` connects lazily and `.toSQL()` only
 * compiles.
 */

const WORKSPACE_A = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_B = '22222222-2222-4222-8222-222222222222';
/** One id, deliberately used for every entity, as a captured UUID would be. */
const SHARED_ENTITY_ID = '33333333-3333-4333-8333-333333333333';
const DAY = '2026-08-16' as UtcAccountingDay;

const scopeA = createWorkspaceScope(WORKSPACE_A);
const scopeB = createWorkspaceScope(WORKSPACE_B);

const pool = createDatabasePool({ connectionString: 'postgresql://u:p@db.invalid.test:5432/db' });
const db = createDatabaseClient(pool);

afterAll(async () => {
  await closeDatabasePool(pool);
});

interface ScopedCase {
  readonly name: string;
  /** The table whose `workspace_id` must appear in the predicate. */
  readonly table: string;
  readonly build: (scope: WorkspaceScope) => { toSQL: () => { sql: string; params: unknown[] } };
}

/**
 * EVERY tenant-owned query in the package, grouped by the Credit surface it
 * serves. A cross-tenant read would have to come through one of these.
 */
const SCOPED: ScopedCase[] = [
  // ── Agents (AC-04) ──────────────────────────────────────────────────────
  { name: 'agents.findById', table: 'agents', build: (s) => agentQueries.findById(db, s, SHARED_ENTITY_ID) },
  { name: 'agents.findByExternalId', table: 'agents', build: (s) => agentQueries.findByExternalId(db, s, 'agent-1') },
  { name: 'agents.listAll', table: 'agents', build: (s) => agentQueries.listAll(db, s) },

  // ── Events: ingest idempotency and the operator timeline (AC-05, AC-06, AC-13) ──
  { name: 'events.findByEventId', table: 'events', build: (s) => eventQueries.findByEventId(db, s, 'evt-shared-001') },
  { name: 'events.findById', table: 'events', build: (s) => eventQueries.findById(db, s, SHARED_ENTITY_ID) },
  {
    name: 'events.listTimeline',
    table: 'events',
    build: (s) => eventQueries.listTimeline(db, s, { limit: 50 }),
  },
  {
    name: 'events.listTimeline (agent filter + cursor)',
    table: 'events',
    build: (s) =>
      eventQueries.listTimeline(db, s, {
        limit: 50,
        agentId: SHARED_ENTITY_ID,
        cursor: { receivedAt: new Date('2026-08-16T10:00:00.000Z'), id: SHARED_ENTITY_ID },
      }),
  },
  { name: 'events.findDetailById', table: 'events', build: (s) => eventQueries.findDetailById(db, s, SHARED_ENTITY_ID) },

  // ── Policy (AC-07, AC-10, AC-12) ────────────────────────────────────────
  { name: 'policy.findVersion', table: 'workspace_policy_state', build: (s) => policyQueries.findVersion(db, s) },
  { name: 'policy.lockVersionForShare', table: 'workspace_policy_state', build: (s) => policyQueries.lockVersionForShare(db, s) },
  { name: 'policy.findAgentPolicy', table: 'agent_policies', build: (s) => policyQueries.findAgentPolicy(db, s, SHARED_ENTITY_ID) },
  { name: 'policy.listEffectivePolicies', table: 'agents', build: (s) => policyQueries.listEffectivePolicies(db, s) },

  // ── Ledger: the authoritative accounting rows (AC-07, AC-08, AC-11) ─────
  { name: 'ledger.find', table: 'ledger_daily', build: (s) => ledgerQueries.find(db, s, SHARED_ENTITY_ID, DAY) },
  { name: 'ledger.lockForUpdate', table: 'ledger_daily', build: (s) => ledgerQueries.lockForUpdate(db, s, SHARED_ENTITY_ID, DAY) },
  { name: 'ledger.findScopedAgent', table: 'agents', build: (s) => ledgerQueries.findScopedAgent(db, s, SHARED_ENTITY_ID) },

  // ── Receipts: precheck idempotency and the operator audit (AC-08, AC-11, AC-12) ──
  { name: 'receipts.exists', table: 'precheck_receipts', build: (s) => receiptQueries.exists(db, s, SHARED_ENTITY_ID) },
  { name: 'receipts.findByActionId', table: 'precheck_receipts', build: (s) => receiptQueries.findByActionId(db, s, 'act-shared-001') },
  { name: 'receipts.findById', table: 'precheck_receipts', build: (s) => receiptQueries.findById(db, s, SHARED_ENTITY_ID) },
  { name: 'receipts.findAuditById', table: 'precheck_receipts', build: (s) => receiptQueries.findAuditById(db, s, SHARED_ENTITY_ID) },
  { name: 'receipts.listAudit', table: 'precheck_receipts', build: (s) => receiptQueries.listAudit(db, s, { limit: 50 }) },
  {
    name: 'receipts.listAudit (agent + decision filter)',
    table: 'precheck_receipts',
    build: (s) => receiptQueries.listAudit(db, s, { limit: 50, agentId: SHARED_ENTITY_ID, decision: 'deny' }),
  },

  // ── Blocks: plane linkage and the operator audit (AC-08, AC-11, AC-12) ──
  { name: 'planeBlocks.findByReceiptId', table: 'blocks', build: (s) => planeBlockQueries.findByReceiptId(db, s, SHARED_ENTITY_ID) },
  { name: 'planeBlocks.countForWorkspace', table: 'blocks', build: (s) => planeBlockQueries.countForWorkspace(db, s) },
  { name: 'blockAudit.findById', table: 'blocks', build: (s) => blockAuditQueries.findById(db, s, SHARED_ENTITY_ID) },
  { name: 'blockAudit.list', table: 'blocks', build: (s) => blockAuditQueries.list(db, s, { limit: 50 }) },
  {
    name: 'blockAudit.list (agent + source filter)',
    table: 'blocks',
    build: (s) => blockAuditQueries.list(db, s, { limit: 50, agentId: SHARED_ENTITY_ID, source: 'plane' }),
  },

  // ── Sharing (AC-18) ─────────────────────────────────────────────────────
  { name: 'shareTokens.list', table: 'share_tokens', build: (s) => shareTokenQueries.list(db, s) },
  { name: 'shareTokens.findById', table: 'share_tokens', build: (s) => shareTokenQueries.findById(db, s, SHARED_ENTITY_ID) },

  // ── Public demo (AC-19) ─────────────────────────────────────────────────
  { name: 'demoSettings.find', table: 'workspaces', build: (s) => demoSettingsQueries.find(db, s) },

  // ── Runtime profiles (foundation) ───────────────────────────────────────
  { name: 'runtimeProfiles.findById', table: 'runtime_profiles', build: (s) => runtimeProfileQueries.findById(db, s, SHARED_ENTITY_ID) },
  { name: 'runtimeProfiles.findByName', table: 'runtime_profiles', build: (s) => runtimeProfileQueries.findByName(db, s, 'default') },
  { name: 'runtimeProfiles.listAll', table: 'runtime_profiles', build: (s) => runtimeProfileQueries.listAll(db, s) },
];

describe('AC-20: every tenant-owned query carries a workspace predicate', () => {
  it.each(SCOPED)('$name filters on workspace_id', ({ table, build }) => {
    const { sql } = build(scopeA).toSQL();

    // `workspaces` is addressed by its own primary key, which IS the tenant.
    const column = table === 'workspaces' ? '"workspaces"."id" =' : `"${table}"."workspace_id" =`;
    expect(sql).toContain(column);
  });

  it.each(SCOPED)('$name binds the scope workspace id as a parameter', ({ build }) => {
    const { params } = build(scopeA).toSQL();

    expect(params).toContain(WORKSPACE_A);
  });

  it.each(SCOPED)('$name never inlines a workspace id into SQL text', ({ build }) => {
    // Parameterised, not interpolated: a scope can never alter query STRUCTURE.
    const { sql } = build(scopeA).toSQL();

    expect(sql).not.toContain(WORKSPACE_A);
  });

  it.each(SCOPED)('$name emits the same shape with a different binding per scope', ({ build }) => {
    const a = build(scopeA).toSQL();
    const b = build(scopeB).toSQL();

    // Identical SQL, different parameter. That is the proof that the scope
    // genuinely reaches the statement rather than being decoration.
    expect(a.sql).toBe(b.sql);
    expect(a.params).toContain(WORKSPACE_A);
    expect(b.params).toContain(WORKSPACE_B);
    expect(a.params).not.toContain(WORKSPACE_B);
    expect(b.params).not.toContain(WORKSPACE_A);
  });

  it.each(SCOPED)('$name composes its predicates with AND, never OR', ({ build }) => {
    // `workspace_id = $1 OR id = $2` would satisfy a naive "contains
    // workspace_id" assertion while leaking every row in the table.
    const { sql } = build(scopeA).toSQL();
    const where = sql.slice(sql.indexOf('where'));

    expect(where).not.toContain(' or ');
  });
});

describe('AC-20: a shared identifier cannot collide across tenants', () => {
  it('the same event_id in two workspaces compiles to two different statements', () => {
    const a = eventQueries.findByEventId(db, scopeA, 'evt-shared-001').toSQL();
    const b = eventQueries.findByEventId(db, scopeB, 'evt-shared-001').toSQL();

    expect(a.params).not.toEqual(b.params);
  });

  it('the same action_id in two workspaces compiles to two different statements', () => {
    const a = receiptQueries.findByActionId(db, scopeA, 'act-shared-001').toSQL();
    const b = receiptQueries.findByActionId(db, scopeB, 'act-shared-001').toSQL();

    expect(a.params).not.toEqual(b.params);
  });

  it('the same agent external_id in two workspaces compiles to two different statements', () => {
    const a = agentQueries.findByExternalId(db, scopeA, 'agent-1').toSQL();
    const b = agentQueries.findByExternalId(db, scopeB, 'agent-1').toSQL();

    expect(a.params).not.toEqual(b.params);
  });

  it('a globally unique UUID is STILL workspace-qualified everywhere', () => {
    // The important case: an id an attacker actually holds. Uniqueness is not
    // authorization, so every by-uuid lookup must still name its tenant.
    const byUuid = [
      agentQueries.findById(db, scopeA, SHARED_ENTITY_ID),
      eventQueries.findById(db, scopeA, SHARED_ENTITY_ID),
      eventQueries.findDetailById(db, scopeA, SHARED_ENTITY_ID),
      receiptQueries.findById(db, scopeA, SHARED_ENTITY_ID),
      receiptQueries.findAuditById(db, scopeA, SHARED_ENTITY_ID),
      blockAuditQueries.findById(db, scopeA, SHARED_ENTITY_ID),
      shareTokenQueries.findById(db, scopeA, SHARED_ENTITY_ID),
      policyQueries.findAgentPolicy(db, scopeA, SHARED_ENTITY_ID),
      ledgerQueries.findScopedAgent(db, scopeA, SHARED_ENTITY_ID),
      planeBlockQueries.findByReceiptId(db, scopeA, SHARED_ENTITY_ID),
    ];

    for (const query of byUuid) {
      const { params } = query.toSQL();

      expect(params).toContain(WORKSPACE_A);
      expect(params).toContain(SHARED_ENTITY_ID);
    }
  });
});

describe('AC-20: the ledger write path is scoped, not only the read path', () => {
  it('the row lock names the workspace, the agent AND the day', () => {
    const { sql, params } = ledgerQueries.lockForUpdate(db, scopeA, SHARED_ENTITY_ID, DAY).toSQL();

    expect(sql).toContain('"ledger_daily"."workspace_id" =');
    expect(sql).toContain('for update');
    expect(params).toContain(WORKSPACE_A);
    expect(params).toContain(SHARED_ENTITY_ID);
    expect(params).toContain(DAY);
  });

  it('the create-if-absent insert names the workspace', () => {
    // A conflict-safe insert that omitted the workspace would create the row
    // under a null or default tenant.
    const { params } = ledgerQueries.insertIfAbsent(db, scopeA, SHARED_ENTITY_ID, DAY).toSQL();

    expect(params).toContain(WORKSPACE_A);
  });
});

describe('AC-20: joins repeat the workspace predicate rather than trusting the parent row', () => {
  // Defence in depth. The event already belongs to the scope, so joining its
  // agent on id alone would be "safe" - until a data defect or a future query
  // change makes it not. The join condition carries the tenant too.
  const JOINING = [
    { name: 'events.findDetailById', build: () => eventQueries.findDetailById(db, scopeA, SHARED_ENTITY_ID) },
    { name: 'events.listTimeline', build: () => eventQueries.listTimeline(db, scopeA, { limit: 50 }) },
    { name: 'receipts.listAudit', build: () => receiptQueries.listAudit(db, scopeA, { limit: 50 }) },
    { name: 'blockAudit.list', build: () => blockAuditQueries.list(db, scopeA, { limit: 50 }) },
    { name: 'policy.listEffectivePolicies', build: () => policyQueries.listEffectivePolicies(db, scopeA) },
  ];

  it.each(JOINING)('$name repeats workspace_id inside the join', ({ build }) => {
    const { sql } = build().toSQL();

    const joinClause = sql.slice(sql.indexOf('join'), sql.indexOf('where'));
    expect(joinClause).toContain('workspace_id');
  });
});

describe('AC-20: the inventory cannot silently fall behind the code', () => {
  it('covers every exported query builder member', async () => {
    // A new tenant-owned query added without a case above is a coverage hole
    // that would otherwise be invisible. This fails the moment one appears.
    const modules = {
      agents: (await import('../src/repositories/agents')).agentQueries,
      blocks: (await import('../src/repositories/blocks')).blockAuditQueries,
      'demo-settings': (await import('../src/repositories/demo-settings')).demoSettingsQueries,
      events: (await import('../src/repositories/events')).eventQueries,
      ledger: (await import('../src/repositories/ledger')).ledgerQueries,
      'plane-blocks': (await import('../src/repositories/plane-blocks')).planeBlockQueries,
      policy: (await import('../src/repositories/policy')).policyQueries,
      receipts: (await import('../src/repositories/receipts')).receiptQueries,
      'runtime-profiles': (await import('../src/repositories/runtime-profiles')).runtimeProfileQueries,
      'share-tokens': (await import('../src/repositories/share-tokens')).shareTokenQueries,
    } as const;

    const PREFIX: Record<string, string> = {
      agents: 'agents',
      blocks: 'blockAudit',
      'demo-settings': 'demoSettings',
      events: 'events',
      ledger: 'ledger',
      'plane-blocks': 'planeBlocks',
      policy: 'policy',
      receipts: 'receipts',
      'runtime-profiles': 'runtimeProfiles',
      'share-tokens': 'shareTokens',
    };

    // Writes carry the workspace in their VALUES rather than a WHERE, so
    // they are asserted in the ledger write-path block instead of the
    // predicate matrix. Listed here so the guard still accounts for them.
    const COVERED_ELSEWHERE = ['ledger.insertIfAbsent'];

    const covered = new Set([
      ...SCOPED.map((c) => c.name.split(' ')[0]),
      ...COVERED_ELSEWHERE,
    ]);
    const missing: string[] = [];

    for (const [module, queries] of Object.entries(modules)) {
      for (const member of Object.keys(queries)) {
        const qualified = `${PREFIX[module] ?? module}.${member}`;
        if (!covered.has(qualified)) {
          missing.push(qualified);
        }
      }
    }

    expect(missing).toEqual([]);
  });
});
