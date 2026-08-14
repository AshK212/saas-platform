import { afterAll, describe, expect, it } from 'vitest';

import { closeDatabasePool, createDatabaseClient, createDatabasePool } from '../src/client';
import { blockAuditQueries } from '../src/repositories/blocks';
import { parseUtcAccountingDay } from '../src/accounting/utc-day';
import { ledgerQueries } from '../src/repositories/ledger';
import { receiptQueries } from '../src/repositories/receipts';
import { createWorkspaceScope } from '../src/repositories/workspace-scope';

/**
 * COMPILED-SQL EVIDENCE for the Step 17 governance read path.
 *
 * These render the ACTUAL SQL the audit queries emit. A mocked repository can
 * be made to return whatever a test wants; the emitted predicate is what
 * PostgreSQL will really run, which is the thing tenant isolation depends on.
 *
 * Three properties matter here and are each asserted below:
 *
 *   1. EVERY read is workspace-scoped, including the joins - a receipt must not
 *      be pairable with another tenant's agent or block.
 *   2. Pagination is a row-value comparison that cannot disagree with the
 *      ORDER BY, so a page boundary never repeats or skips a row.
 *   3. The read path takes NO LOCK and writes NOTHING - reading the audit must
 *      not create a ledger row or contend with a live decision.
 *
 * No connection is opened: `pg.Pool` connects lazily and `.toSQL()` only
 * compiles.
 */

const WORKSPACE_A = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_B = '22222222-2222-4222-8222-222222222222';
const AGENT_ID = '33333333-3333-4333-8333-333333333333';
const CURSOR_ID = '44444444-4444-4444-8444-444444444444';
const RECEIPT_ID = '55555555-5555-4555-8555-555555555555';
const BLOCK_ID = '66666666-6666-4666-8666-666666666666';
const CURSOR_AT = new Date('2026-08-12T10:00:00.000Z');
const DAY = parseUtcAccountingDay('2026-08-12');

const scopeA = createWorkspaceScope(WORKSPACE_A);
const scopeB = createWorkspaceScope(WORKSPACE_B);

const pool = createDatabasePool({ connectionString: 'postgresql://u:p@db.invalid.test:5432/db' });
const db = createDatabaseClient(pool);

afterAll(async () => {
  await closeDatabasePool(pool);
});

type Scope = ReturnType<typeof createWorkspaceScope>;

const receipts = (
  scope: Scope,
  options: Parameters<typeof receiptQueries.listAudit>[2],
): { sql: string; params: unknown[] } => receiptQueries.listAudit(db, scope, options).toSQL();

const blocks = (
  scope: Scope,
  options: Parameters<typeof blockAuditQueries.list>[2],
): { sql: string; params: unknown[] } => blockAuditQueries.list(db, scope, options).toSQL();

describe('every receipt read is workspace-scoped', () => {
  it.each([
    ['unfiltered', { limit: 51 }],
    ['agent-filtered', { limit: 51, agentId: AGENT_ID }],
    ['decision-filtered', { limit: 51, decision: 'deny' as const }],
    ['cursor-paged', { limit: 51, cursor: { createdAt: CURSOR_AT, id: CURSOR_ID } }],
    [
      'fully filtered and paged',
      {
        limit: 51,
        agentId: AGENT_ID,
        decision: 'deny' as const,
        cursor: { createdAt: CURSOR_AT, id: CURSOR_ID },
      },
    ],
  ])('%s listAudit filters on precheck_receipts.workspace_id', (_label, options) => {
    const { sql, params } = receipts(scopeA, options);

    expect(sql).toContain('"precheck_receipts"."workspace_id" = $1');
    expect(params[0]).toBe(WORKSPACE_A);
    // Parameterised, never interpolated: the scope cannot alter query shape.
    expect(sql).not.toContain(WORKSPACE_A);
  });

  it('findAuditById filters on precheck_receipts.workspace_id', () => {
    const { sql, params } = receiptQueries.findAuditById(db, scopeA, RECEIPT_ID).toSQL();

    expect(sql).toContain('"precheck_receipts"."workspace_id" = $1');
    expect(params).toEqual([WORKSPACE_A, RECEIPT_ID, 1]);
    expect(sql).not.toContain(WORKSPACE_A);
  });

  it('a receipt id alone is not enough to read a receipt', () => {
    // PROBE A in query form. An id guessed or leaked from another tenant must
    // fail the workspace predicate, so the route can answer a uniform 404.
    const { params } = receiptQueries.findAuditById(db, scopeB, RECEIPT_ID).toSQL();

    expect(params[0]).toBe(WORKSPACE_B);
    expect(params).not.toContain(WORKSPACE_A);
  });

  it('emits identical SQL with a different binding for a different tenant', () => {
    const a = receipts(scopeA, { limit: 51 });
    const b = receipts(scopeB, { limit: 51 });

    expect(a.sql).toBe(b.sql);
    expect(a.params).toContain(WORKSPACE_A);
    expect(b.params).toContain(WORKSPACE_B);
    expect(a.params).not.toContain(WORKSPACE_B);
  });

  it('composes predicates with AND, never OR', () => {
    const { sql } = receipts(scopeA, {
      limit: 51,
      agentId: AGENT_ID,
      decision: 'deny',
      cursor: { createdAt: CURSOR_AT, id: CURSOR_ID },
    });

    // An OR anywhere in the WHERE could let a row escape the tenant predicate.
    expect(sql.toLowerCase()).not.toContain(' or ');
    expect(sql).toMatch(/where \("precheck_receipts"\."workspace_id" = \$1 and /);
  });
});

describe('the receipt joins cannot reach across tenants', () => {
  it.each([
    ['list', () => receipts(scopeA, { limit: 51 }).sql],
    ['detail', () => receiptQueries.findAuditById(db, scopeA, RECEIPT_ID).toSQL().sql],
  ])('%s repeats workspace_id in the agent join', (_label, render) => {
    const sql = render();

    // Belt and braces: even if the outer predicate were dropped, the join
    // itself cannot pair a receipt with another tenant's agent.
    expect(sql).toContain(
      '"agents"."workspace_id" = "precheck_receipts"."workspace_id"',
    );
  });

  it.each([
    ['list', () => receipts(scopeA, { limit: 51 }).sql],
    ['detail', () => receiptQueries.findAuditById(db, scopeA, RECEIPT_ID).toSQL().sql],
  ])('%s repeats workspace_id in the block join', (_label, render) => {
    const sql = render();

    expect(sql).toContain('"blocks"."workspace_id" = "precheck_receipts"."workspace_id"');
  });

  it('left joins the block so an allowed decision still returns a row', () => {
    // An inner join would silently hide every allow, and every denial that
    // predates plane-owned blocks, from the audit list.
    const { sql } = receipts(scopeA, { limit: 51 });

    expect(sql.toLowerCase()).toContain('left join "blocks"');
    expect(sql.toLowerCase()).toContain('inner join "agents"');
  });
});

describe('receipt pagination is stable', () => {
  it('orders newest first with an id tiebreaker', () => {
    const { sql } = receipts(scopeA, { limit: 51 });

    expect(sql).toContain(
      'order by "precheck_receipts"."created_at" desc, "precheck_receipts"."id" desc',
    );
  });

  it('the cursor predicate is a row-value comparison matching the ORDER BY', () => {
    // Two decisions can share a `created_at`. A plain `created_at <` would
    // skip the rest of that instant; a row-value comparison is exactly the
    // ordering boundary and cannot disagree with the sort.
    const { sql, params } = receipts(scopeA, {
      limit: 51,
      cursor: { createdAt: CURSOR_AT, id: CURSOR_ID },
    });

    expect(sql).toContain(
      '("precheck_receipts"."created_at", "precheck_receipts"."id") < ($2::timestamptz, $3::uuid)',
    );
    expect(params[1]).toBe(CURSOR_AT);
    expect(params[2]).toBe(CURSOR_ID);
  });

  it('binds the cursor rather than concatenating it', () => {
    // The cursor is client-supplied. It reaches SQL only as a bound parameter
    // with an explicit cast, so a malformed one is a type error, never syntax.
    const { sql } = receipts(scopeA, { limit: 51, cursor: { createdAt: CURSOR_AT, id: CURSOR_ID } });

    expect(sql).not.toContain(CURSOR_ID);
    expect(sql).not.toContain('2026-08-12');
  });

  it('binds the limit', () => {
    const { params } = receipts(scopeA, { limit: 51 });

    // limit+1: the extra row is the "is there another page" probe and is
    // dropped before the response is built.
    expect(params.at(-1)).toBe(51);
  });
});

describe('every block read is workspace-scoped', () => {
  it.each([
    ['unfiltered', { limit: 51 }],
    ['agent-filtered', { limit: 51, agentId: AGENT_ID }],
    ['plane-only', { limit: 51, source: 'plane' as const }],
    ['runtime-only', { limit: 51, source: 'runtime' as const }],
    ['cursor-paged', { limit: 51, cursor: { createdAt: CURSOR_AT, id: CURSOR_ID } }],
  ])('%s list filters on blocks.workspace_id', (_label, options) => {
    const { sql, params } = blocks(scopeA, options);

    expect(sql).toContain('"blocks"."workspace_id" = $1');
    expect(params[0]).toBe(WORKSPACE_A);
    expect(sql).not.toContain(WORKSPACE_A);
  });

  it('findById filters on blocks.workspace_id', () => {
    const { sql, params } = blockAuditQueries.findById(db, scopeA, BLOCK_ID).toSQL();

    expect(sql).toContain('"blocks"."workspace_id" = $1');
    expect(params).toEqual([WORKSPACE_A, BLOCK_ID, 1]);
  });

  it('repeats workspace_id in the agent join', () => {
    const { sql } = blocks(scopeA, { limit: 51 });

    expect(sql).toContain('"agents"."workspace_id" = "blocks"."workspace_id"');
  });

  it('orders newest first with an id tiebreaker', () => {
    const { sql } = blocks(scopeA, { limit: 51 });

    expect(sql).toContain('order by "blocks"."created_at" desc, "blocks"."id" desc');
  });

  it('filters ownership rather than excluding it', () => {
    // Runtime blocks are part of the record. `source` narrows the view on
    // request; it is never a hidden default that would make the plane look
    // like the only thing refusing work.
    // Scoped to the WHERE clause: `source` is always in the PROJECTION,
    // because ownership is something every row reports.
    const whereOf = (sql: string): string => sql.slice(sql.indexOf(' where '));

    const unfiltered = blocks(scopeA, { limit: 51 });
    expect(whereOf(unfiltered.sql)).not.toContain('"blocks"."source"');
    expect(unfiltered.params).toEqual([WORKSPACE_A, 51]);

    const planeOnly = blocks(scopeA, { limit: 51, source: 'plane' });
    expect(whereOf(planeOnly.sql)).toContain('"blocks"."source" = $2');
    expect(planeOnly.params[1]).toBe('plane');

    const runtimeOnly = blocks(scopeA, { limit: 51, source: 'runtime' });
    expect(runtimeOnly.params[1]).toBe('runtime');
  });

  it('composes predicates with AND, never OR', () => {
    const { sql } = blocks(scopeA, {
      limit: 51,
      agentId: AGENT_ID,
      source: 'plane',
      cursor: { createdAt: CURSOR_AT, id: CURSOR_ID },
    });

    expect(sql.toLowerCase()).not.toContain(' or ');
  });
});

describe('THE GOVERNANCE READ PATH TAKES NO LOCK AND WRITES NOTHING', () => {
  /** Every SQL statement the governance read path can emit. */
  const readPath: [string, () => string][] = [
    ['receipt list', () => receipts(scopeA, { limit: 51 }).sql],
    [
      'receipt list, filtered',
      () =>
        receipts(scopeA, {
          limit: 51,
          agentId: AGENT_ID,
          decision: 'deny',
          cursor: { createdAt: CURSOR_AT, id: CURSOR_ID },
        }).sql,
    ],
    ['receipt detail', () => receiptQueries.findAuditById(db, scopeA, RECEIPT_ID).toSQL().sql],
    ['block list', () => blocks(scopeA, { limit: 51 }).sql],
    ['block detail', () => blockAuditQueries.findById(db, scopeA, BLOCK_ID).toSQL().sql],
    [
      'fleet ledger read',
      () => ledgerQueries.find(db, scopeA, AGENT_ID, DAY).toSQL().sql,
    ],
  ];

  it.each(readPath)('%s issues a plain SELECT', (_label, render) => {
    const sql = render().toLowerCase();

    expect(sql.startsWith('select ')).toBe(true);
    for (const write of ['insert ', 'update ', 'delete ', 'upsert', 'on conflict', 'returning']) {
      expect(sql, write).not.toContain(write);
    }
  });

  it.each(readPath)('%s takes NO ROW LOCK', (_label, render) => {
    // PROBE D in query form. An operator refreshing a dashboard must never
    // contend with a live precheck, and must never create today's ledger row
    // as a side effect of looking at it.
    const sql = render().toLowerCase();

    for (const lock of ['for update', 'for share', 'for no key update', 'advisory']) {
      expect(sql, lock).not.toContain(lock);
    }
  });

  it('the fleet usage read is the non-locking ledger query', () => {
    // `findDaily` observes; `lockDailyLedger` creates and locks. The read store
    // must use the former - the source guard in the API package asserts it does
    // not import the latter, and this asserts what the former actually emits.
    const { sql, params } = ledgerQueries.find(db, scopeA, AGENT_ID, DAY).toSQL();

    expect(sql).toContain('"ledger_daily"."workspace_id" = $1');
    expect(params).toEqual([WORKSPACE_A, AGENT_ID, '2026-08-12', 1]);
    expect(sql.toLowerCase()).not.toContain('for update');
  });

  it('the ledger read is bound to a day the server chose', () => {
    // The day is a bound parameter in `YYYY-MM-DD` form, derived server-side
    // from the injected clock. Nothing in the query computes "today", so the
    // database server's timezone cannot shift the accounting boundary either.
    const { sql } = ledgerQueries.find(db, scopeA, AGENT_ID, DAY).toSQL();

    expect(sql).not.toContain('2026-08-12');
    expect(sql.toLowerCase()).not.toContain('current_date');
    expect(sql.toLowerCase()).not.toContain('now()');
  });
});
