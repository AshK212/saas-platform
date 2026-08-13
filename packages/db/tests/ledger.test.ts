import { afterAll, describe, expect, it } from 'vitest';

import { toUtcAccountingDay } from '../src/accounting/utc-day';
import { closeDatabasePool, createDatabaseClient, createDatabasePool } from '../src/client';
import { ledgerQueries } from '../src/repositories/ledger';
import { createWorkspaceScope } from '../src/repositories/workspace-scope';

/**
 * COMPILED-SQL EVIDENCE for the ledger primitives.
 *
 * These render the ACTUAL SQL each query emits. That matters more than a mocked
 * return value: a fake returns whatever a test wants, whereas the emitted
 * predicate and the `FOR UPDATE` clause are what PostgreSQL will really run -
 * and the lock is the entire basis of later cap enforcement.
 *
 * No connection is opened: `pg.Pool` connects lazily and `.toSQL()` only
 * compiles.
 */

const WORKSPACE_A = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_B = '22222222-2222-4222-8222-222222222222';
const AGENT = '33333333-3333-4333-8333-333333333333';
const DAY = toUtcAccountingDay(new Date('2026-08-13T09:00:00.000Z'));

const scopeA = createWorkspaceScope(WORKSPACE_A);
const scopeB = createWorkspaceScope(WORKSPACE_B);

const pool = createDatabasePool({ connectionString: 'postgresql://u:p@db.invalid.test:5432/db' });
const db = createDatabaseClient(pool);

afterAll(async () => {
  await closeDatabasePool(pool);
});

describe('every ledger read is keyed on workspace, agent AND day', () => {
  it.each([
    ['find', () => ledgerQueries.find(db, scopeA, AGENT, DAY).toSQL()],
    ['lockForUpdate', () => ledgerQueries.lockForUpdate(db, scopeA, AGENT, DAY).toSQL()],
  ])('%s carries all three predicates', (_label, build) => {
    const { sql, params } = build();

    expect(sql).toContain('"ledger_daily"."workspace_id" =');
    expect(sql).toContain('"ledger_daily"."agent_id" =');
    expect(sql).toContain('"ledger_daily"."day" =');
    expect(params).toEqual([WORKSPACE_A, AGENT, DAY, 1]);
    // Parameterised, never interpolated.
    expect(sql).not.toContain(WORKSPACE_A);
    expect(sql).not.toContain(DAY);
  });

  it('composes predicates with AND, never OR', () => {
    const { sql } = ledgerQueries.find(db, scopeA, AGENT, DAY).toSQL();

    // An OR anywhere here could let a row escape the tenant predicate.
    expect(sql.toLowerCase()).not.toContain(' or ');
    expect(sql).toMatch(/where \("ledger_daily"\."workspace_id" = \$1 and /);
  });

  it('emits identical SQL with a different binding per tenant', () => {
    const a = ledgerQueries.find(db, scopeA, AGENT, DAY).toSQL();
    const b = ledgerQueries.find(db, scopeB, AGENT, DAY).toSQL();

    expect(a.sql).toBe(b.sql);
    expect(a.params).toContain(WORKSPACE_A);
    expect(b.params).toContain(WORKSPACE_B);
    expect(a.params).not.toContain(WORKSPACE_B);
  });
});

describe('the row lock is real', () => {
  it('lockForUpdate emits FOR UPDATE', () => {
    // THE core concurrency primitive. Without this clause two concurrent
    // decisions both read the same committed usage and both believe they fit.
    const { sql } = ledgerQueries.lockForUpdate(db, scopeA, AGENT, DAY).toSQL();

    expect(sql.toLowerCase()).toContain('for update');
  });

  it('find does NOT lock', () => {
    // A plain read is for reporting only; using it for a decision would
    // reintroduce the exact race the lock closes.
    const { sql } = ledgerQueries.find(db, scopeA, AGENT, DAY).toSQL();

    expect(sql.toLowerCase()).not.toContain('for update');
  });

  it('locks one row, not a range', () => {
    const { sql } = ledgerQueries.lockForUpdate(db, scopeA, AGENT, DAY).toSQL();

    // Two different agents, or two different days, must not block each other.
    expect(sql).toMatch(/limit \$\d+/);
    expect(sql).toContain('"ledger_daily"."agent_id" =');
    expect(sql).toContain('"ledger_daily"."day" =');
  });
});

describe('row creation is conflict-safe', () => {
  it('targets the composite primary key', () => {
    const { sql } = ledgerQueries.insertIfAbsent(db, scopeA, AGENT, DAY).toSQL();

    // The first action of a UTC day can arrive concurrently; a bare
    // SELECT-absent-then-INSERT would let both requests insert.
    expect(sql.toLowerCase()).toContain('on conflict');
    expect(sql).toContain('"workspace_id"');
    expect(sql).toContain('"agent_id"');
    expect(sql).toContain('"day"');
    expect(sql.toLowerCase()).toContain('do nothing');
  });

  it('never overwrites committed usage on conflict', () => {
    const { sql } = ledgerQueries.insertIfAbsent(db, scopeA, AGENT, DAY).toSQL();

    // DO UPDATE here would reset a day's spend to zero whenever two requests
    // raced on the first action - silently erasing committed accounting.
    expect(sql.toLowerCase()).not.toContain('do update');
  });

  it('initialises usage to zero, not null', () => {
    const { params } = ledgerQueries.insertIfAbsent(db, scopeA, AGENT, DAY).toSQL();

    // Null would make "no spend yet" indistinguishable from "unknown".
    expect(params).toContain('0.000000');
    expect(params).toContain(0);
    expect(params).not.toContain(null);
  });

  it('takes the workspace from the scope', () => {
    const { params } = ledgerQueries.insertIfAbsent(db, scopeA, AGENT, DAY).toSQL();

    expect(params[0]).toBe(WORKSPACE_A);
  });
});

describe('agent verification is workspace-scoped', () => {
  it('filters on both workspace and agent id', () => {
    const { sql, params } = ledgerQueries.findScopedAgent(db, scopeA, AGENT).toSQL();

    // A globally unique UUID is not authorization: without the workspace
    // predicate, holding another tenant's agent id would create a ledger row
    // for them.
    expect(sql).toContain('"agents"."workspace_id" =');
    expect(sql).toContain('"agents"."id" =');
    expect(params).toEqual([WORKSPACE_A, AGENT, 1]);
  });
});

describe('the ledger surface stays narrow', () => {
  it('exposes exactly four query builders', () => {
    // Enumerated so a reset, a delete or a generic criteria query must be a
    // deliberate reviewed addition rather than something that slips in.
    expect(Object.keys(ledgerQueries).sort()).toEqual([
      'find',
      'findScopedAgent',
      'insertIfAbsent',
      'lockForUpdate',
    ]);
  });

  it('every builder requires a scope argument', () => {
    // Arity is the mechanical guarantee that no tenant-free variant exists.
    expect(ledgerQueries.find.length).toBe(4);
    expect(ledgerQueries.lockForUpdate.length).toBe(4);
    expect(ledgerQueries.insertIfAbsent.length).toBe(4);
    expect(ledgerQueries.findScopedAgent.length).toBe(3);
  });

  it('emits no DELETE anywhere', () => {
    for (const build of [
      () => ledgerQueries.find(db, scopeA, AGENT, DAY).toSQL(),
      () => ledgerQueries.lockForUpdate(db, scopeA, AGENT, DAY).toSQL(),
      () => ledgerQueries.insertIfAbsent(db, scopeA, AGENT, DAY).toSQL(),
      () => ledgerQueries.findScopedAgent(db, scopeA, AGENT).toSQL(),
    ]) {
      // Accounting history must not be casually erasable.
      expect(build().sql.toLowerCase()).not.toContain('delete');
    }
  });
});
