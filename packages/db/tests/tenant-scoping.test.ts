import { afterAll, describe, expect, it } from 'vitest';

import { closeDatabasePool, createDatabaseClient, createDatabasePool } from '../src/client';
import { agentQueries } from '../src/repositories/agents';
import { eventQueries } from '../src/repositories/events';
import { runtimeProfileQueries } from '../src/repositories/runtime-profiles';
import { createWorkspaceScope } from '../src/repositories/workspace-scope';

/**
 * SQL SCOPING EVIDENCE.
 *
 * These are the strongest isolation assertions possible without a live
 * database: they render the ACTUAL SQL each repository query emits and prove
 * that `workspace_id` participates in the predicate with the scope's id bound
 * as a parameter.
 *
 * That is what makes a cross-tenant read impossible - a row belonging to
 * another workspace cannot satisfy `workspace_id = $A`.
 *
 * No connection is opened: `pg.Pool` connects lazily and `.toSQL()` only
 * compiles the query.
 */

const WORKSPACE_A = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_B = '22222222-2222-4222-8222-222222222222';
const SHARED_ENTITY_ID = '33333333-3333-4333-8333-333333333333';

const scopeA = createWorkspaceScope(WORKSPACE_A);
const scopeB = createWorkspaceScope(WORKSPACE_B);

const pool = createDatabasePool({ connectionString: 'postgresql://u:p@db.invalid.test:5432/db' });
const db = createDatabaseClient(pool);

afterAll(async () => {
  await closeDatabasePool(pool);
});

/** Every tenant-owned query introduced in Step 4. */
const SCOPED_QUERIES = [
  {
    name: 'agents.findById',
    table: 'agents',
    build: (scope: ReturnType<typeof createWorkspaceScope>) =>
      agentQueries.findById(db, scope, SHARED_ENTITY_ID),
  },
  {
    name: 'agents.findByExternalId',
    table: 'agents',
    build: (scope: ReturnType<typeof createWorkspaceScope>) =>
      agentQueries.findByExternalId(db, scope, 'agent-1'),
  },
  {
    name: 'agents.listAll',
    table: 'agents',
    build: (scope: ReturnType<typeof createWorkspaceScope>) => agentQueries.listAll(db, scope),
  },
  {
    name: 'events.findByEventId',
    table: 'events',
    build: (scope: ReturnType<typeof createWorkspaceScope>) =>
      eventQueries.findByEventId(db, scope, 'evt-123'),
  },
  {
    name: 'events.findById',
    table: 'events',
    build: (scope: ReturnType<typeof createWorkspaceScope>) =>
      eventQueries.findById(db, scope, SHARED_ENTITY_ID),
  },
  {
    name: 'runtimeProfiles.findById',
    table: 'runtime_profiles',
    build: (scope: ReturnType<typeof createWorkspaceScope>) =>
      runtimeProfileQueries.findById(db, scope, SHARED_ENTITY_ID),
  },
  {
    name: 'runtimeProfiles.findByName',
    table: 'runtime_profiles',
    build: (scope: ReturnType<typeof createWorkspaceScope>) =>
      runtimeProfileQueries.findByName(db, scope, 'default'),
  },
  {
    name: 'runtimeProfiles.listAll',
    table: 'runtime_profiles',
    build: (scope: ReturnType<typeof createWorkspaceScope>) =>
      runtimeProfileQueries.listAll(db, scope),
  },
] as const;

describe('every tenant-owned query is workspace-scoped', () => {
  it.each(SCOPED_QUERIES)('$name filters on workspace_id', ({ table, build }) => {
    const { sql } = build(scopeA).toSQL();

    expect(sql).toContain(`"${table}"."workspace_id" =`);
  });

  it.each(SCOPED_QUERIES)('$name binds the scope workspace id as a parameter', ({ build }) => {
    const { params } = build(scopeA).toSQL();

    expect(params).toContain(WORKSPACE_A);
  });

  it.each(SCOPED_QUERIES)('$name never inlines the workspace id into SQL text', ({ build }) => {
    // Parameterised, not interpolated - the scope cannot alter query structure.
    const { sql } = build(scopeA).toSQL();

    expect(sql).not.toContain(WORKSPACE_A);
  });

  it.each(SCOPED_QUERIES)('$name emits a different binding for a different scope', ({ build }) => {
    const a = build(scopeA).toSQL();
    const b = build(scopeB).toSQL();

    // Identical shape, different tenant - proving scope actually reaches SQL.
    expect(a.sql).toBe(b.sql);
    expect(a.params).toContain(WORKSPACE_A);
    expect(b.params).toContain(WORKSPACE_B);
    expect(a.params).not.toContain(WORKSPACE_B);
  });
});

describe('same identifier in two workspaces cannot collide', () => {
  it('an event_id shared by two tenants resolves to different queries', () => {
    // The schema permits (A, 'evt-123') and (B, 'evt-123') to both exist.
    const a = eventQueries.findByEventId(db, scopeA, 'evt-123').toSQL();
    const b = eventQueries.findByEventId(db, scopeB, 'evt-123').toSQL();

    expect(a.params).toEqual([WORKSPACE_A, 'evt-123', 1]);
    expect(b.params).toEqual([WORKSPACE_B, 'evt-123', 1]);
  });

  it('an agent external_id shared by two tenants resolves to different queries', () => {
    const a = agentQueries.findByExternalId(db, scopeA, 'agent-1').toSQL();
    const b = agentQueries.findByExternalId(db, scopeB, 'agent-1').toSQL();

    expect(a.params).toEqual([WORKSPACE_A, 'agent-1', 1]);
    expect(b.params).toEqual([WORKSPACE_B, 'agent-1', 1]);
  });

  it('a globally unique UUID is still workspace-qualified', () => {
    // UUID unguessability is NOT authorization. Presenting workspace B's agent
    // id under scope A must still produce a workspace-A-filtered query.
    const { sql, params } = agentQueries.findById(db, scopeA, SHARED_ENTITY_ID).toSQL();

    expect(sql).toContain('"agents"."workspace_id" =');
    expect(sql).toContain('"agents"."id" =');
    expect(params).toEqual([WORKSPACE_A, SHARED_ENTITY_ID, 1]);
  });
});

describe('predicate composition', () => {
  it('combines workspace and entity predicates with AND, never OR', () => {
    const { sql } = agentQueries.findById(db, scopeA, SHARED_ENTITY_ID).toSQL();

    expect(sql).toMatch(/where .*"workspace_id" = \$1 and .*"id" = \$2/i);
    expect(sql.toLowerCase()).not.toContain(' or ');
  });

  it('scopes unfiltered list queries too', () => {
    // A "list everything" method is the easiest place to forget scoping.
    const { sql, params } = agentQueries.listAll(db, scopeA).toSQL();

    expect(sql).toContain('where');
    expect(sql).toContain('"agents"."workspace_id" =');
    expect(params).toEqual([WORKSPACE_A]);
  });
});
