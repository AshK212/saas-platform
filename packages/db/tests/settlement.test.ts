import { afterAll, describe, expect, it } from 'vitest';

import { closeDatabasePool, createDatabaseClient, createDatabasePool } from '../src/client';
import { eventQueries } from '../src/repositories/events';
import { receiptQueries } from '../src/repositories/receipts';
import { createWorkspaceScope } from '../src/repositories/workspace-scope';

/**
 * COMPILED-SQL EVIDENCE for the Step 18 settlement lookup.
 *
 * `receiptQueries.findById` is the query that decides whether a caller's
 * `precheck_id` is real. Everything Step 18 rests on assumes it cannot return
 * another tenant's row - so this renders the ACTUAL statement rather than
 * trusting a repository fake, which would return whatever it was seeded with.
 *
 * No connection is opened: `pg.Pool` connects lazily and `.toSQL()` only
 * compiles.
 */

const WORKSPACE_A = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_B = '22222222-2222-4222-8222-222222222222';
const RECEIPT_ID = '55555555-5555-4555-8555-555555555555';

const scopeA = createWorkspaceScope(WORKSPACE_A);
const scopeB = createWorkspaceScope(WORKSPACE_B);

const pool = createDatabasePool({ connectionString: 'postgresql://u:p@db.invalid.test:5432/db' });
const db = createDatabaseClient(pool);

afterAll(async () => {
  await closeDatabasePool(pool);
});

describe('the settlement lookup is workspace-scoped IN SQL', () => {
  it('findById filters on precheck_receipts.workspace_id', () => {
    const { sql, params } = receiptQueries.findById(db, scopeA, RECEIPT_ID).toSQL();

    expect(sql).toContain('"precheck_receipts"."workspace_id" = $1');
    expect(sql).toContain('"precheck_receipts"."id" = $2');
    expect(params).toEqual([WORKSPACE_A, RECEIPT_ID, 1]);
    // Parameterised, never interpolated.
    expect(sql).not.toContain(WORKSPACE_A);
    expect(sql).not.toContain(RECEIPT_ID);
  });

  it('a receipt uuid alone cannot reach a row', () => {
    // PROBE C in query form. Another tenant submitting the exact uuid gets no
    // row at all, so ingest reports it identically to one that never existed -
    // the row is never available to compare in JavaScript.
    const { params } = receiptQueries.findById(db, scopeB, RECEIPT_ID).toSQL();

    expect(params[0]).toBe(WORKSPACE_B);
    expect(params).not.toContain(WORKSPACE_A);
  });

  it('emits identical SQL with a different binding per tenant', () => {
    const a = receiptQueries.findById(db, scopeA, RECEIPT_ID).toSQL();
    const b = receiptQueries.findById(db, scopeB, RECEIPT_ID).toSQL();

    expect(a.sql).toBe(b.sql);
    expect(a.params).not.toContain(WORKSPACE_B);
  });

  it('composes with AND, never OR', () => {
    const { sql } = receiptQueries.findById(db, scopeA, RECEIPT_ID).toSQL();

    // An OR would let the id predicate satisfy the WHERE on its own.
    expect(sql.toLowerCase()).not.toContain(' or ');
    expect(sql).toMatch(/where \("precheck_receipts"\."workspace_id" = \$1 and /);
  });

  it('SELECTS the facts settlement compares, and takes no lock', () => {
    const { sql } = receiptQueries.findById(db, scopeA, RECEIPT_ID).toSQL();

    // Unqualified in the projection - there is only one table in this query.
    for (const column of ['agent_id', 'category', 'decision', 'requested_amount_usd']) {
      expect(sql, column).toContain(`"${column}"`);
    }

    const lowered = sql.toLowerCase();
    expect(lowered.startsWith('select ')).toBe(true);
    // Reading a receipt to validate a claim must not serialize against a live
    // decision, and must not be able to write.
    for (const forbidden of ['for update', 'for share', 'insert ', 'update ', 'delete ']) {
      expect(lowered, forbidden).not.toContain(forbidden);
    }
  });

  it('is leaner than the operator audit read', () => {
    // Settlement needs decision facts, not the agent and block joins the
    // Step 17 audit renders per row.
    const settlement = receiptQueries.findById(db, scopeA, RECEIPT_ID).toSQL().sql.toLowerCase();
    const audit = receiptQueries.findAuditById(db, scopeA, RECEIPT_ID).toSQL().sql.toLowerCase();

    expect(settlement).not.toContain('join');
    expect(audit).toContain('join');
  });
});

describe('the event row carries the linkage', () => {
  it('the duplicate lookup is workspace-scoped and by event id', () => {
    // The idempotency identity is `(workspace_id, event_id)` and nothing else -
    // never the precheck id, which is not event identity.
    const { sql, params } = eventQueries.findByEventId(db, scopeA, 'evt-1').toSQL();

    expect(sql).toContain('"events"."workspace_id" = $1');
    expect(sql).toContain('"events"."event_id" = $2');
    expect(params).toEqual([WORKSPACE_A, 'evt-1', 1]);

    // Scoped to the WHERE clause: `precheck_receipt_id` is legitimately in the
    // PROJECTION, because the stored linkage is what a replay must preserve.
    // It must never be part of the identity that decides duplicate-or-not.
    const where = sql.slice(sql.indexOf(' where '));
    expect(where).not.toContain('precheck');
  });
});
