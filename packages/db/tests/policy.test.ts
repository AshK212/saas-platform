import { afterAll, describe, expect, it } from 'vitest';

import { closeDatabasePool, createDatabaseClient, createDatabasePool } from '../src/client';
import { policyQueries } from '../src/repositories/policy';
import { createWorkspaceScope } from '../src/repositories/workspace-scope';

/**
 * COMPILED-SQL EVIDENCE for the Step 12 policy read path.
 *
 * These render the ACTUAL SQL the policy queries emit, which is stronger than
 * a mocked return value: a fake returns whatever a test wants, whereas the
 * emitted predicate is what PostgreSQL will really run.
 *
 * No connection is opened - `pg.Pool` connects lazily and `.toSQL()` only
 * compiles the query.
 */

const WORKSPACE_A = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_B = '22222222-2222-4222-8222-222222222222';

const scopeA = createWorkspaceScope(WORKSPACE_A);
const scopeB = createWorkspaceScope(WORKSPACE_B);

const pool = createDatabasePool({ connectionString: 'postgresql://u:p@db.invalid.test:5432/db' });
const db = createDatabaseClient(pool);

afterAll(async () => {
  await closeDatabasePool(pool);
});

describe('the version query is workspace-scoped', () => {
  it('filters on workspace_policy_state.workspace_id', () => {
    const { sql, params } = policyQueries.findVersion(db, scopeA).toSQL();

    expect(sql).toContain('"workspace_policy_state"."workspace_id" =');
    expect(params).toContain(WORKSPACE_A);
    // Parameterised, never interpolated.
    expect(sql).not.toContain(WORKSPACE_A);
  });

  it('casts the bigint version to text', () => {
    const { sql } = policyQueries.findVersion(db, scopeA).toSQL();

    // Reading it as a JS number would silently lose precision above 2^53.
    expect(sql).toContain('::text');
    expect(sql).toContain('"version"');
  });

  it('reads one row and nothing else', () => {
    const { sql } = policyQueries.findVersion(db, scopeA).toSQL();

    // A 30-second poll's common answer is "unchanged", so this must stay a
    // single primary-key lookup rather than joining anything.
    expect(sql).toMatch(/limit \$\d+$/);
    expect(sql.toLowerCase()).not.toContain('join');
    expect(sql).not.toContain('"agents"');
  });

  it('emits a different binding for a different tenant', () => {
    const a = policyQueries.findVersion(db, scopeA).toSQL();
    const b = policyQueries.findVersion(db, scopeB).toSQL();

    expect(a.sql).toBe(b.sql);
    expect(a.params).toContain(WORKSPACE_A);
    expect(b.params).toContain(WORKSPACE_B);
    expect(a.params).not.toContain(WORKSPACE_B);
  });
});

describe('the effective-policy query cannot cross tenants', () => {
  it('filters on agents.workspace_id', () => {
    const { sql, params } = policyQueries.listEffectivePolicies(db, scopeA).toSQL();

    expect(sql).toContain('"agents"."workspace_id" =');
    expect(params).toEqual([WORKSPACE_A]);
    expect(sql).not.toContain(WORKSPACE_A);
  });

  it('JOINS ON WORKSPACE AS WELL AS AGENT ID', () => {
    const { sql } = policyQueries.listEffectivePolicies(db, scopeA).toSQL();

    // Joining on the agent UUID alone would be a global join: another tenant's
    // policy row could pair with this tenant's agent. The workspace column in
    // the join condition makes that impossible even if the outer predicate
    // were dropped.
    expect(sql).toContain('"agent_policies"."agent_id" = "agents"."id"');
    expect(sql).toContain('"agent_policies"."workspace_id" = "agents"."workspace_id"');
  });

  it('joins FROM agents with a LEFT join', () => {
    const { sql } = policyQueries.listEffectivePolicies(db, scopeA).toSQL();

    // An agent may exist with no policy row - registration and event discovery
    // both create agents without one. An inner join, or joining from policies,
    // would silently omit exactly those agents.
    expect(sql).toMatch(/from "agents"/);
    expect(sql).toContain('left join "agent_policies"');
    expect(sql.toLowerCase()).not.toContain('inner join');
  });

  it('composes predicates with AND, never OR', () => {
    const { sql } = policyQueries.listEffectivePolicies(db, scopeA).toSQL();

    expect(sql.toLowerCase()).not.toContain(' or ');
  });

  it('orders deterministically by external id', () => {
    const { sql } = policyQueries.listEffectivePolicies(db, scopeA).toSQL();

    // Two consecutive 30-second polls must be diffable.
    expect(sql).toContain('order by "agents"."external_id"');
  });

  it('selects the external id, not only the internal uuid', () => {
    const { sql } = policyQueries.listEffectivePolicies(db, scopeA).toSQL();

    // The machine surface speaks external ids.
    expect(sql).toContain('"agents"."external_id"');
  });

  it('selects the cap columns needed for an effective policy', () => {
    const { sql } = policyQueries.listEffectivePolicies(db, scopeA).toSQL();

    expect(sql).toContain('"agent_policies"."mode"');
    expect(sql).toContain('"agent_policies"."daily_spend_cap_usd"');
    expect(sql).toContain('"agent_policies"."daily_publish_cap"');
  });

  it('emits identical SQL with a different binding per tenant', () => {
    const a = policyQueries.listEffectivePolicies(db, scopeA).toSQL();
    const b = policyQueries.listEffectivePolicies(db, scopeB).toSQL();

    expect(a.sql).toBe(b.sql);
    expect(a.params).toEqual([WORKSPACE_A]);
    expect(b.params).toEqual([WORKSPACE_B]);
  });
});

describe('there is no policy writer and no unscoped read', () => {
  it('every query builder requires a scope argument', () => {
    // Arity is the mechanical guarantee: a one-argument builder would mean a
    // tenant-free variant exists.
    expect(policyQueries.findVersion.length).toBe(2);
    expect(policyQueries.listEffectivePolicies.length).toBe(2);
  });

  it('exposes exactly two read builders and nothing else', () => {
    // Enumerated, so a writer or a generic criteria query must be a deliberate
    // reviewed addition rather than something that slips in.
    expect(Object.keys(policyQueries).sort()).toEqual(['findVersion', 'listEffectivePolicies']);
  });

  it('neither query emits a write statement', () => {
    for (const build of [
      () => policyQueries.findVersion(db, scopeA).toSQL(),
      () => policyQueries.listEffectivePolicies(db, scopeA).toSQL(),
    ]) {
      const { sql } = build();
      expect(sql.toLowerCase()).toMatch(/^select /);
      expect(sql.toLowerCase()).not.toMatch(/\b(insert|update|delete)\b/);
    }
  });
});
