import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import * as schema from '../src/schema/index';

/**
 * Structural schema tests.
 *
 * These read Drizzle's table metadata rather than matching generated SQL text,
 * so they assert the *design invariants* and do not break when Drizzle changes
 * its formatting. They verify the guarantees the platform depends on:
 * tenant isolation, money precision, audit uniqueness and secret hygiene.
 */

const {
  agentPolicies,
  agents,
  apiCredentials,
  blocks,
  events,
  ledgerDaily,
  precheckReceipts,
  runtimeProfiles,
  sessions,
  shareTokens,
  tasks,
  users,
  workspaceMemberships,
  workspacePolicyState,
  workspaces,
} = schema;

/** Every table in the schema, by SQL name. */
const ALL_TABLES: Record<string, PgTable> = {
  agent_policies: agentPolicies,
  agents,
  api_credentials: apiCredentials,
  blocks,
  events,
  ledger_daily: ledgerDaily,
  precheck_receipts: precheckReceipts,
  runtime_profiles: runtimeProfiles,
  sessions,
  share_tokens: shareTokens,
  tasks,
  users,
  workspace_memberships: workspaceMemberships,
  workspace_policy_state: workspacePolicyState,
  workspaces,
};

/**
 * Tables that hold tenant-owned rows. `users` is excluded because identity is
 * global; `workspaces` is the boundary itself.
 */
const TENANT_OWNED = [
  'agent_policies',
  'agents',
  'api_credentials',
  'blocks',
  'events',
  'ledger_daily',
  'precheck_receipts',
  'runtime_profiles',
  'sessions',
  'share_tokens',
  'tasks',
  'workspace_memberships',
  'workspace_policy_state',
] as const;

function columnNames(table: PgTable): string[] {
  return getTableConfig(table).columns.map((column) => column.name);
}

function checkNames(table: PgTable): string[] {
  return getTableConfig(table).checks.map((check) => check.name);
}

function uniqueColumnSets(table: PgTable): string[][] {
  const config = getTableConfig(table);
  const uniques = config.uniqueConstraints.map((constraint) =>
    constraint.columns.map((column) => column.name),
  );
  const primaries = config.primaryKeys.map((pk) => pk.columns.map((column) => column.name));
  return [...uniques, ...primaries];
}

function hasUniqueOn(table: PgTable, expected: string[]): boolean {
  return uniqueColumnSets(table).some(
    (set) => set.length === expected.length && expected.every((name) => set.includes(name)),
  );
}

describe('schema inventory', () => {
  it('defines exactly the 15 Step 3 tables', () => {
    expect(Object.keys(ALL_TABLES).sort()).toHaveLength(15);
  });

  it.each(Object.entries(ALL_TABLES))('%s has a resolvable table config', (_name, table) => {
    expect(getTableConfig(table).columns.length).toBeGreaterThan(0);
  });

  it('names every table in snake_case', () => {
    for (const name of Object.keys(ALL_TABLES)) {
      expect(name).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });
});

describe('multi-tenancy', () => {
  it.each(TENANT_OWNED)('%s carries a workspace_id column', (name) => {
    const table = ALL_TABLES[name];
    expect(table).toBeDefined();
    expect(columnNames(table as PgTable)).toContain('workspace_id');
  });

  it('users is global and carries no workspace_id', () => {
    // Identity is shared across workspaces; scoping lives on membership.
    expect(columnNames(users)).not.toContain('workspace_id');
  });

  it.each(TENANT_OWNED)('%s has workspace_id as NOT NULL', (name) => {
    const table = ALL_TABLES[name] as PgTable;
    const workspaceColumn = getTableConfig(table).columns.find((c) => c.name === 'workspace_id');
    expect(workspaceColumn?.notNull).toBe(true);
  });
});

describe('tenant-safe composite foreign keys', () => {
  /**
   * Every reference from one tenant-owned row to another must be composite and
   * anchored on workspace_id, so PostgreSQL rejects a cross-workspace link.
   * A bare single-column reference to a tenant-owned parent would leave that
   * link structurally possible, which is exactly what this guards against.
   */
  const EXPECTED_COMPOSITE_FKS: ReadonlyArray<{
    child: string;
    localColumn: string;
    parentTable: string;
  }> = [
    { child: 'agents', localColumn: 'runtime_profile_id', parentTable: 'runtime_profiles' },
    { child: 'sessions', localColumn: 'agent_id', parentTable: 'agents' },
    { child: 'sessions', localColumn: 'runtime_profile_id', parentTable: 'runtime_profiles' },
    { child: 'tasks', localColumn: 'session_id', parentTable: 'sessions' },
    { child: 'tasks', localColumn: 'agent_id', parentTable: 'agents' },
    { child: 'agent_policies', localColumn: 'agent_id', parentTable: 'agents' },
    { child: 'ledger_daily', localColumn: 'agent_id', parentTable: 'agents' },
    { child: 'precheck_receipts', localColumn: 'agent_id', parentTable: 'agents' },
    { child: 'blocks', localColumn: 'agent_id', parentTable: 'agents' },
    { child: 'blocks', localColumn: 'precheck_receipt_id', parentTable: 'precheck_receipts' },
    { child: 'events', localColumn: 'agent_id', parentTable: 'agents' },
    { child: 'events', localColumn: 'precheck_receipt_id', parentTable: 'precheck_receipts' },
    { child: 'events', localColumn: 'block_id', parentTable: 'blocks' },
  ];

  it.each(EXPECTED_COMPOSITE_FKS)(
    '$child.$localColumn -> $parentTable is workspace-anchored',
    ({ child, localColumn, parentTable }) => {
      const table = ALL_TABLES[child] as PgTable;
      const foreignKeys = getTableConfig(table).foreignKeys;

      const match = foreignKeys.find((fk) => {
        const reference = fk.reference();
        const local = reference.columns.map((c) => c.name);
        return local.includes(localColumn) && local.includes('workspace_id');
      });

      expect(
        match,
        `${child}.${localColumn} must be part of a composite FK including workspace_id`,
      ).toBeDefined();

      const reference = match?.reference();
      const foreignColumns = reference?.foreignColumns.map((c) => c.name) ?? [];
      const foreignTable = getTableConfig(reference?.foreignTable as PgTable);

      // It must point at the parent's (workspace_id, id) pair.
      expect(foreignTable.name).toBe(parentTable);
      expect(foreignColumns).toContain('workspace_id');
      expect(foreignColumns).toContain('id');
    },
  );

  it.each([
    ['runtime_profiles', runtimeProfiles],
    ['agents', agents],
    ['sessions', sessions],
    ['precheck_receipts', precheckReceipts],
    ['blocks', blocks],
  ] as const)('%s exposes UNIQUE(workspace_id, id) as a composite FK target', (_name, table) => {
    // Without this, PostgreSQL cannot accept the composite reference at all.
    expect(hasUniqueOn(table, ['workspace_id', 'id'])).toBe(true);
  });
});

describe('audit and accounting invariants', () => {
  it('events enforce idempotency with UNIQUE(workspace_id, event_id)', () => {
    // AC-13 rests on this constraint.
    expect(hasUniqueOn(events, ['workspace_id', 'event_id'])).toBe(true);
  });

  it('events do not make the client event_id globally unique', () => {
    // A global unique would let one tenant's ids collide with another's.
    expect(hasUniqueOn(events, ['event_id'])).toBe(false);
  });

  it('ledger has exactly one authoritative row per workspace/agent/UTC day', () => {
    expect(hasUniqueOn(ledgerDaily, ['workspace_id', 'agent_id', 'day'])).toBe(true);
  });

  it('agents are unique per workspace by external id, not globally', () => {
    expect(hasUniqueOn(agents, ['workspace_id', 'external_id'])).toBe(true);
    expect(hasUniqueOn(agents, ['external_id'])).toBe(false);
  });

  it('blocks deduplicate external ids within a workspace', () => {
    expect(hasUniqueOn(blocks, ['workspace_id', 'external_block_id'])).toBe(true);
  });

  it('memberships cannot be duplicated for a user in a workspace', () => {
    expect(hasUniqueOn(workspaceMemberships, ['workspace_id', 'user_id'])).toBe(true);
  });

  it('ledger enforces non-negative committed values', () => {
    const names = checkNames(ledgerDaily);
    expect(names).toContain('ledger_daily_spend_nonnegative_check');
    expect(names).toContain('ledger_daily_publish_nonnegative_check');
  });

  it('policy caps cannot be negative', () => {
    const names = checkNames(agentPolicies);
    expect(names).toContain('agent_policies_daily_spend_cap_nonnegative_check');
    expect(names).toContain('agent_policies_daily_publish_cap_nonnegative_check');
  });

  it('a denial receipt must carry a reason', () => {
    expect(checkNames(precheckReceipts)).toContain(
      'precheck_receipts_deny_requires_reason_check',
    );
  });

  it('policy versions start at 1 and cannot go below it', () => {
    expect(checkNames(workspacePolicyState)).toContain('workspace_policy_state_version_check');
    expect(checkNames(precheckReceipts)).toContain('precheck_receipts_policy_version_check');
  });
});

describe('money representation', () => {
  const MONEY_COLUMNS: ReadonlyArray<[string, string]> = [
    ['agent_policies', 'daily_spend_cap_usd'],
    ['ledger_daily', 'spend_committed_usd'],
    ['precheck_receipts', 'requested_amount_usd'],
    ['precheck_receipts', 'applied_spend_cap_usd'],
    ['precheck_receipts', 'ledger_spend_before_usd'],
    ['precheck_receipts', 'remaining_spend_usd'],
    ['blocks', 'amount_usd'],
  ];

  it.each(MONEY_COLUMNS)('%s.%s is fixed-precision numeric, never floating point', (
    tableName,
    columnName,
  ) => {
    const table = ALL_TABLES[tableName] as PgTable;
    const column = getTableConfig(table).columns.find((c) => c.name === columnName);

    expect(column, `${tableName}.${columnName} must exist`).toBeDefined();
    expect(column?.columnType).toBe('PgNumeric');
    // Drizzle surfaces numeric as a JS string; converting to number would
    // reintroduce IEEE-754 error into authoritative accounting.
    expect(column?.dataType).toBe('string');
  });

  it('no column anywhere uses a floating-point type', () => {
    const floatingTypes = ['PgReal', 'PgDoublePrecision'];
    for (const [name, table] of Object.entries(ALL_TABLES)) {
      for (const column of getTableConfig(table).columns) {
        expect(
          floatingTypes,
          `${name}.${column.name} uses a floating-point type`,
        ).not.toContain(column.columnType);
      }
    }
  });
});

describe('time representation', () => {
  it('every timestamp column is timezone-aware', () => {
    for (const [tableName, table] of Object.entries(ALL_TABLES)) {
      for (const column of getTableConfig(table).columns) {
        if (column.columnType === 'PgTimestamp' || column.columnType === 'PgTimestampString') {
          const withTimezone = (column as unknown as { withTimezone?: boolean }).withTimezone;
          expect(withTimezone, `${tableName}.${column.name} must be timestamptz`).toBe(true);
        }
      }
    }
  });

  it('accounting days are PostgreSQL dates in string mode, not timestamps', () => {
    // A JS Date would let the server's local zone shift a UTC accounting day.
    for (const [tableName, columnName] of [
      ['ledger_daily', 'day'],
      ['precheck_receipts', 'accounting_day'],
    ] as const) {
      const table = ALL_TABLES[tableName] as PgTable;
      const column = getTableConfig(table).columns.find((c) => c.name === columnName);
      expect(column?.columnType).toBe('PgDateString');
      expect(column?.dataType).toBe('string');
    }
  });
});

describe('identifier strategy', () => {
  it('uses uuid primary keys with a database-side default', () => {
    for (const [name, table] of Object.entries(ALL_TABLES)) {
      const idColumn = getTableConfig(table).columns.find((c) => c.name === 'id');
      if (idColumn === undefined) {
        continue; // composite-key tables have no surrogate id
      }
      expect(idColumn.columnType, `${name}.id`).toBe('PgUUID');
      expect(idColumn.hasDefault, `${name}.id must default server-side`).toBe(true);
    }
  });

  it('uses no sequential/serial public identifiers', () => {
    for (const [name, table] of Object.entries(ALL_TABLES)) {
      for (const column of getTableConfig(table).columns) {
        expect(
          (column as unknown as { isUnique?: boolean; columnType: string }).columnType,
          `${name}.${column.name}`,
        ).not.toBe('PgSerial');
      }
    }
  });
});

describe('secret hygiene', () => {
  /**
   * No column may be capable of holding reusable secret material. Credential
   * tables store a hash and a non-secret prefix only.
   */
  const FORBIDDEN_COLUMN_NAMES = [
    'plaintext_api_key',
    'api_key',
    'share_token',
    'raw_token',
    'token',
    'secret',
    'password',
    'password_hash',
    'database_url',
    'private_key',
  ];

  it('defines no plaintext secret column on any table', () => {
    for (const [tableName, table] of Object.entries(ALL_TABLES)) {
      for (const column of getTableConfig(table).columns) {
        expect(
          FORBIDDEN_COLUMN_NAMES,
          `${tableName}.${column.name} looks like reusable secret material`,
        ).not.toContain(column.name);
      }
    }
  });

  it('api credentials store only a hash and a non-secret prefix', () => {
    const names = columnNames(apiCredentials);
    expect(names).toContain('secret_hash');
    expect(names).toContain('key_prefix');
    expect(names).not.toContain('secret');
    expect(names).not.toContain('api_key');
  });

  it('share tokens store only a hash and a non-secret prefix', () => {
    const names = columnNames(shareTokens);
    expect(names).toContain('token_hash');
    expect(names).toContain('token_prefix');
    expect(names).not.toContain('token');
    expect(names).not.toContain('share_token');
  });

  it('credential hashes are unique so lookup cannot be ambiguous', () => {
    expect(hasUniqueOn(apiCredentials, ['secret_hash'])).toBe(true);
    expect(hasUniqueOn(shareTokens, ['token_hash'])).toBe(true);
  });

  it('users carry no password column', () => {
    const names = columnNames(users);
    expect(names).not.toContain('password');
    expect(names).not.toContain('password_hash');
  });

  it('runtime profiles expose no secret column', () => {
    const names = columnNames(runtimeProfiles);
    expect(names).not.toContain('api_key');
    expect(names).not.toContain('secret');
    expect(names).not.toContain('credentials');
  });
});

describe('revocation is non-destructive', () => {
  it.each([
    ['api_credentials', apiCredentials],
    ['share_tokens', shareTokens],
  ] as const)('%s revokes via timestamp rather than deletion', (_name, table) => {
    expect(columnNames(table)).toContain('revoked_at');
  });
});
