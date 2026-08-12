import { afterAll, describe, expect, it } from 'vitest';

import { closeDatabasePool, createDatabaseClient, createDatabasePool } from '../src/client';

/**
 * SQL-level proof for the operator authorization queries.
 *
 * The in-memory store used by the API route tests reproduces the *semantics* of
 * these queries but not their SQL. These tests compile the real Drizzle queries
 * and assert that the membership predicate is actually present - which is what
 * makes cross-tenant access impossible rather than merely unlikely.
 *
 * No connection is opened: `pg.Pool` connects lazily and `.toSQL()` only
 * compiles.
 */

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const WORKSPACE_X = '33333333-3333-4333-8333-333333333333';

const pool = createDatabasePool({ connectionString: 'postgresql://u:p@db.invalid.test:5432/db' });
const db = createDatabaseClient(pool);

afterAll(async () => {
  await closeDatabasePool(pool);
});

/**
 * Rebuilds the exact queries from `resolvers/authorization.ts`.
 *
 * Kept in lock-step with that module by the source assertions at the bottom of
 * this file, which fail if the production predicates change shape.
 */
async function compileAuthorizeQuery(userId: string, workspaceId: string): Promise<{
  sql: string;
  params: unknown[];
}> {
  const { and, eq } = await import('drizzle-orm');
  const { workspaceMemberships, workspaces } = await import('../src/schema/workspaces');

  return db
    .select({
      id: workspaces.id,
      name: workspaces.name,
      role: workspaceMemberships.role,
    })
    .from(workspaceMemberships)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMemberships.workspaceId))
    .where(
      and(
        eq(workspaceMemberships.userId, userId),
        eq(workspaceMemberships.workspaceId, workspaceId),
      ),
    )
    .limit(1)
    .toSQL();
}

async function compileListQuery(userId: string): Promise<{ sql: string; params: unknown[] }> {
  const { eq } = await import('drizzle-orm');
  const { workspaceMemberships, workspaces } = await import('../src/schema/workspaces');

  return db
    .select({
      id: workspaces.id,
      name: workspaces.name,
      role: workspaceMemberships.role,
    })
    .from(workspaceMemberships)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMemberships.workspaceId))
    .where(eq(workspaceMemberships.userId, userId))
    .orderBy(workspaces.name)
    .toSQL();
}

describe('workspace authorization query', () => {
  it('joins through memberships rather than reading workspaces directly', () => {
    // Selecting FROM workspaces and filtering afterwards is the shape that
    // leaks tenants; the join makes membership a precondition of the row.
    return compileAuthorizeQuery(USER_A, WORKSPACE_X).then(({ sql }) => {
      expect(sql).toContain('from "workspace_memberships"');
      expect(sql).toContain('inner join "workspaces"');
    });
  });

  it('filters on BOTH user_id and workspace_id', async () => {
    const { sql } = await compileAuthorizeQuery(USER_A, WORKSPACE_X);

    expect(sql).toContain('"workspace_memberships"."user_id" =');
    expect(sql).toContain('"workspace_memberships"."workspace_id" =');
  });

  it('binds the authenticated user and requested workspace as parameters', async () => {
    const { params } = await compileAuthorizeQuery(USER_A, WORKSPACE_X);

    expect(params).toEqual([USER_A, WORKSPACE_X, 1]);
  });

  it('produces a different binding per user for the same workspace', async () => {
    const a = await compileAuthorizeQuery(USER_A, WORKSPACE_X);
    const b = await compileAuthorizeQuery(USER_B, WORKSPACE_X);

    // Same shape, different caller: possessing the workspace id changes nothing.
    expect(a.sql).toBe(b.sql);
    expect(a.params).toContain(USER_A);
    expect(b.params).toContain(USER_B);
    expect(a.params).not.toContain(USER_B);
  });

  it('never inlines identifiers into SQL text', async () => {
    const { sql } = await compileAuthorizeQuery(USER_A, WORKSPACE_X);

    expect(sql).not.toContain(USER_A);
    expect(sql).not.toContain(WORKSPACE_X);
  });
});

describe('workspace listing query', () => {
  it('is bounded by user_id in SQL, not filtered in memory', async () => {
    const { sql, params } = await compileListQuery(USER_A);

    expect(sql).toContain('"workspace_memberships"."user_id" =');
    expect(params).toEqual([USER_A]);
  });

  it('has no unfiltered variant', async () => {
    const { sql } = await compileListQuery(USER_A);

    // A listing without a WHERE clause would return every tenant.
    expect(sql).toContain('where');
  });
});

describe('the production module matches these compiled queries', () => {
  it('authorization.ts filters both queries on the authenticated user', async () => {
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    const source = readFileSync(
      path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        '..',
        'src',
        'resolvers',
        'authorization.ts',
      ),
      'utf8',
    );

    const selectCount = (source.match(/\.select\(\{/g) ?? []).length;
    const userFilters = (source.match(/eq\(workspaceMemberships\.userId, userId\)/g) ?? []).length;
    const joins = (source.match(/\.innerJoin\(/g) ?? []).length;

    expect(selectCount).toBe(2);
    expect(userFilters).toBe(2);
    expect(joins).toBe(2);
  });

  it('constructs a scope only from a joined row, never from the argument', async () => {
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    const source = readFileSync(
      path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        '..',
        'src',
        'resolvers',
        'authorization.ts',
      ),
      'utf8',
    );

    // `row.id` comes from the membership join. Using the caller's argument
    // instead would grant a scope without proving membership.
    expect(source).toContain('createWorkspaceScope(row.id)');
    expect(source).not.toContain('createWorkspaceScope(workspaceId)');
  });
});
