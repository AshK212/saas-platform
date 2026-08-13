import { afterAll, describe, expect, it } from 'vitest';

import { closeDatabasePool, createDatabaseClient, createDatabasePool } from '../src/client';
import { eventQueries } from '../src/repositories/events';
import { createWorkspaceScope } from '../src/repositories/workspace-scope';

/**
 * COMPILED-SQL EVIDENCE for the Step 11 read path.
 *
 * These render the ACTUAL SQL the timeline queries emit. That matters more than
 * a mocked return value: a fake can be made to return whatever a test wants,
 * whereas the emitted predicate is what PostgreSQL will really run.
 *
 * No connection is opened - `pg.Pool` connects lazily and `.toSQL()` only
 * compiles.
 */

const WORKSPACE_A = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_B = '22222222-2222-4222-8222-222222222222';
const AGENT_ID = '33333333-3333-4333-8333-333333333333';
const CURSOR_ID = '44444444-4444-4444-8444-444444444444';
const EVENT_ID = '55555555-5555-4555-8555-555555555555';
const CURSOR_AT = new Date('2026-08-12T10:00:00.000Z');

const scopeA = createWorkspaceScope(WORKSPACE_A);
const scopeB = createWorkspaceScope(WORKSPACE_B);

const pool = createDatabasePool({ connectionString: 'postgresql://u:p@db.invalid.test:5432/db' });
const db = createDatabaseClient(pool);

afterAll(async () => {
  await closeDatabasePool(pool);
});

const timeline = (
  scope: ReturnType<typeof createWorkspaceScope>,
  options: Parameters<typeof eventQueries.listTimeline>[2],
): { sql: string; params: unknown[] } => eventQueries.listTimeline(db, scope, options).toSQL();

describe('every timeline read is workspace-scoped', () => {
  it.each([
    ['unfiltered', { limit: 51 }],
    ['agent-filtered', { limit: 51, agentId: AGENT_ID }],
    ['cursor-paged', { limit: 51, cursor: { receivedAt: CURSOR_AT, id: CURSOR_ID } }],
    [
      'agent-filtered and cursor-paged',
      { limit: 51, agentId: AGENT_ID, cursor: { receivedAt: CURSOR_AT, id: CURSOR_ID } },
    ],
  ])('%s listTimeline filters on events.workspace_id', (_label, options) => {
    const { sql, params } = timeline(scopeA, options);

    expect(sql).toContain('"events"."workspace_id" = $1');
    expect(params[0]).toBe(WORKSPACE_A);
    // Parameterised, never interpolated: the scope cannot alter query shape.
    expect(sql).not.toContain(WORKSPACE_A);
  });

  it('findDetailById filters on events.workspace_id', () => {
    const { sql, params } = eventQueries.findDetailById(db, scopeA, EVENT_ID).toSQL();

    expect(sql).toContain('"events"."workspace_id" = $1');
    expect(params).toEqual([WORKSPACE_A, EVENT_ID, 1]);
    expect(sql).not.toContain(WORKSPACE_A);
  });

  it('emits identical SQL with a different binding for a different tenant', () => {
    const a = timeline(scopeA, { limit: 51 });
    const b = timeline(scopeB, { limit: 51 });

    expect(a.sql).toBe(b.sql);
    expect(a.params).toContain(WORKSPACE_A);
    expect(b.params).toContain(WORKSPACE_B);
    expect(a.params).not.toContain(WORKSPACE_B);
  });

  it('composes predicates with AND, never OR', () => {
    const { sql } = timeline(scopeA, {
      limit: 51,
      agentId: AGENT_ID,
      cursor: { receivedAt: CURSOR_AT, id: CURSOR_ID },
    });

    // An OR anywhere in the WHERE could let a row escape the tenant predicate.
    expect(sql.toLowerCase()).not.toContain(' or ');
    expect(sql).toMatch(/where \("events"\."workspace_id" = \$1 and /);
  });
});

describe('the joins cannot reach across tenants', () => {
  it.each([
    ['agents', '"agents"."workspace_id" = "events"."workspace_id"'],
    ['blocks', '"blocks"."workspace_id" = "events"."workspace_id"'],
  ])('the %s join repeats the workspace column', (_label, condition) => {
    // Defence in depth: even if the outer predicate were dropped, the join
    // itself cannot pair an event with another tenant's agent or block.
    const { sql } = timeline(scopeA, { limit: 51 });

    expect(sql).toContain(condition);
  });

  it('joins agents INNER and blocks LEFT', () => {
    const { sql } = timeline(scopeA, { limit: 51 });

    // Every event has an agent (NOT NULL + composite FK); most have no block.
    expect(sql).toContain('inner join "agents"');
    expect(sql).toContain('left join "blocks"');
  });

  it('selects no payload in the timeline projection', () => {
    // Raw payloads belong to detail only - see the page-size reasoning.
    expect(timeline(scopeA, { limit: 51 }).sql).not.toContain('"events"."payload"');
  });

  it('selects the payload in the detail projection', () => {
    expect(eventQueries.findDetailById(db, scopeA, EVENT_ID).toSQL().sql).toContain(
      '"events"."payload"',
    );
  });
});

describe('deterministic ordering', () => {
  it('orders by received_at then id, both descending', () => {
    const { sql } = timeline(scopeA, { limit: 51 });

    expect(sql).toContain(
      'order by "events"."received_at" desc, "events"."id" desc',
    );
  });

  it('never orders by the client-controlled occurred_at', () => {
    // A client clock must not determine its own position in the history.
    const { sql } = timeline(scopeA, { limit: 51 });

    expect(sql).not.toMatch(/order by[^;]*occurred_at/);
  });

  it('keeps the same ordering under a filter and a cursor', () => {
    // If ordering differed between pages, pagination would repeat or skip rows.
    for (const options of [
      { limit: 51 },
      { limit: 51, agentId: AGENT_ID },
      { limit: 51, cursor: { receivedAt: CURSOR_AT, id: CURSOR_ID } },
    ]) {
      expect(timeline(scopeA, options).sql).toContain(
        'order by "events"."received_at" desc, "events"."id" desc',
      );
    }
  });
});

describe('cursor parameters are bound, never interpolated', () => {
  it('emits a row-value comparison matching the ORDER BY', () => {
    const { sql } = timeline(scopeA, {
      limit: 51,
      cursor: { receivedAt: CURSOR_AT, id: CURSOR_ID },
    });

    // One expression that cannot disagree with the sort key.
    expect(sql).toContain('("events"."received_at", "events"."id") <');
  });

  it('binds and casts both cursor components', () => {
    const { sql, params } = timeline(scopeA, {
      limit: 51,
      cursor: { receivedAt: CURSOR_AT, id: CURSOR_ID },
    });

    expect(sql).toContain('($2::timestamptz, $3::uuid)');
    expect(params).toEqual([WORKSPACE_A, CURSOR_AT, CURSOR_ID, 51]);
    // The cursor's own values never appear as SQL text.
    expect(sql).not.toContain(CURSOR_ID);
    expect(sql).not.toContain('2026-08-12');
  });

  it('binds a hostile cursor id as data', () => {
    // The route rejects a non-UUID before this point; this proves that even if
    // one arrived, it would be a parameter and not executable SQL.
    const injection = "' OR 1=1--";
    const { sql, params } = timeline(scopeA, {
      limit: 51,
      cursor: { receivedAt: CURSOR_AT, id: injection },
    });

    expect(sql).not.toContain(injection);
    expect(sql.toLowerCase()).not.toContain('1=1');
    expect(params).toContain(injection);
  });

  it('binds the agent filter as a parameter', () => {
    const { sql, params } = timeline(scopeA, { limit: 51, agentId: AGENT_ID });

    // The INTERNAL uuid, already resolved inside the scope. An external id is
    // never compared here, so a shared `agent-1` cannot cross tenants.
    expect(sql).toContain('"events"."agent_id" = $2');
    expect(params).toEqual([WORKSPACE_A, AGENT_ID, 51]);
    expect(sql).not.toContain(AGENT_ID);
  });

  it('omits the filter and cursor predicates when absent', () => {
    const { sql, params } = timeline(scopeA, { limit: 51 });

    expect(sql).not.toContain('"events"."agent_id" =');
    expect(sql).not.toContain('("events"."received_at", "events"."id")');
    expect(params).toEqual([WORKSPACE_A, 51]);
  });

  it('binds the limit rather than inlining it', () => {
    const { sql, params } = timeline(scopeA, { limit: 7 });

    expect(sql).toMatch(/limit \$\d+$/);
    expect(params).toContain(7);
  });
});

describe('index compatibility', () => {
  it('leads with workspace_id and orders by received_at', () => {
    // Matches events_workspace_received_idx (workspace_id, received_at) from
    // Step 3 - no new index was needed.
    const { sql } = timeline(scopeA, { limit: 51 });

    expect(sql).toMatch(
      /where "events"\."workspace_id" = \$1 order by "events"\."received_at" desc/,
    );
  });

  it('leads with workspace_id and agent_id when filtered', () => {
    // Matches events_workspace_agent_received_idx
    // (workspace_id, agent_id, received_at), also from Step 3.
    const { sql } = timeline(scopeA, { limit: 51, agentId: AGENT_ID });

    expect(sql).toMatch(
      /"events"\."workspace_id" = \$1 and "events"\."agent_id" = \$2/,
    );
  });
});

describe('there is no unscoped read', () => {
  it('every query builder requires a scope argument', () => {
    // Arity is the mechanical guarantee: a two-argument builder would mean a
    // tenant-free variant exists.
    expect(eventQueries.listTimeline.length).toBe(3);
    expect(eventQueries.findDetailById.length).toBe(3);
  });

  it('exposes no generic criteria query', () => {
    const names = Object.keys(eventQueries).sort();

    // Concrete, named reads only. A `queryEvents(criteria)` would eventually be
    // called with a criteria object that forgot the workspace.
    expect(names).toEqual(['findByEventId', 'findById', 'findDetailById', 'listTimeline']);
  });
});
