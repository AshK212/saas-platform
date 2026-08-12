import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Migration artifact tests.
 *
 * These assert properties of the checked-in SQL that structural metadata tests
 * cannot see - notably referential actions and the absence of dangerous type
 * choices in the emitted DDL. They deliberately do NOT compare the whole file
 * byte-for-byte, which would break on any harmless formatting change.
 */

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'migrations',
);

const journal = JSON.parse(
  readFileSync(path.join(MIGRATIONS_DIR, 'meta', '_journal.json'), 'utf8'),
) as { version: string; dialect: string; entries: { idx: number; tag: string }[] };

const sqlFiles = readdirSync(MIGRATIONS_DIR).filter((file) => file.endsWith('.sql'));
const migrationSql = sqlFiles
  .map((file) => readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'))
  .join('\n');

describe('migration journal', () => {
  it('is a postgresql journal', () => {
    expect(journal.dialect).toBe('postgresql');
  });

  it('has one journal entry per checked-in SQL file', () => {
    // Self-consistent rather than a hardcoded count, so adding a migration in a
    // later step does not require editing this assertion.
    expect(journal.entries).toHaveLength(sqlFiles.length);
    expect(journal.entries.length).toBeGreaterThan(0);
  });

  it('records migrations in contiguous order starting at zero', () => {
    // A gap or reordering would make the applied history ambiguous.
    expect(journal.entries.map((entry) => entry.idx)).toEqual(
      journal.entries.map((_entry, index) => index),
    );
  });

  it('references a SQL file that actually exists', () => {
    for (const entry of journal.entries) {
      expect(sqlFiles).toContain(`${entry.tag}.sql`);
    }
  });

  it('ships a snapshot alongside every SQL file', () => {
    const metaFiles = readdirSync(path.join(MIGRATIONS_DIR, 'meta'));

    for (const entry of journal.entries) {
      expect(metaFiles).toContain(`${String(entry.idx).padStart(4, '0')}_snapshot.json`);
    }
  });

  it('keeps the Step 3 core migration untouched by later steps', () => {
    // Auth tables arrived in their own migration; appending them to 0000 would
    // have rewritten history that may already be applied elsewhere.
    const core = readFileSync(path.join(MIGRATIONS_DIR, '0000_dusty_skullbuster.sql'), 'utf8');

    expect(core).not.toContain('auth_magic_links');
    expect(core).not.toContain('auth_sessions');
  });
});

describe('generated DDL - type safety', () => {
  it('creates exactly the expected set of tables', () => {
    // Named rather than counted, so an accidental extra table is identified
    // rather than just changing a number.
    const created = [...migrationSql.matchAll(/CREATE TABLE "(\w+)"/g)].map((match) => match[1]);

    expect(created.sort()).toEqual([
      'agent_policies',
      'agents',
      'api_credentials',
      'auth_magic_links',
      'auth_sessions',
      'blocks',
      'events',
      'ledger_daily',
      'precheck_receipts',
      'runtime_profiles',
      'sessions',
      'share_tokens',
      'tasks',
      'users',
      'workspace_memberships',
      'workspace_policy_state',
      'workspaces',
    ]);
  });

  it('keeps the auth tables free of any workspace column', () => {
    // Authentication is global. A workspace_id here would invite the
    // conflation of identity with tenant authorization.
    const authDdl = migrationSql.slice(migrationSql.indexOf('CREATE TABLE "auth_magic_links"'));
    const authTableBlocks = authDdl.slice(0, authDdl.indexOf('ALTER TABLE'));

    expect(authTableBlocks).not.toContain('workspace_id');
  });

  it('stores only hashes for auth bearer credentials', () => {
    expect(migrationSql).toContain('CONSTRAINT "auth_magic_links_token_hash_key" UNIQUE("token_hash")');
    expect(migrationSql).toContain('CONSTRAINT "auth_sessions_token_hash_key" UNIQUE("token_hash")');
    // No column may hold reusable plaintext credential material.
    expect(migrationSql).not.toMatch(/"(token|secret|magic_link_token|session_token|password)"\s+text/);
  });

  it('uses no floating-point or money types for any column', () => {
    // Authoritative accounting must never touch IEEE-754.
    expect(migrationSql).not.toMatch(/\b(real|double precision|float4|float8|money)\b/i);
  });

  it('uses no serial/sequence public identifiers', () => {
    expect(migrationSql).not.toMatch(/\b(serial|bigserial|smallserial)\b/i);
  });

  it('generates uuid defaults without requiring an extension', () => {
    // gen_random_uuid() is core PostgreSQL from v13, so no CREATE EXTENSION.
    expect(migrationSql).toContain('gen_random_uuid()');
    expect(migrationSql).not.toMatch(/CREATE EXTENSION/i);
    expect(migrationSql).not.toMatch(/uuid_generate_v4/i);
  });

  it('declares every timestamp as timezone-aware', () => {
    const naive = migrationSql.match(/"\w+" timestamp(?! with time zone)/g) ?? [];
    expect(naive).toEqual([]);
  });

  it('stores money as numeric(14, 6)', () => {
    // Match column *declarations* only. A CHECK constraint body also mentions
    // these column names, so scanning the whole file would match that text too.
    const usdDeclarations = migrationSql
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^"\w*usd\w*" /.test(line));

    expect(usdDeclarations.length).toBeGreaterThan(0);
    for (const declaration of usdDeclarations) {
      expect(declaration, declaration).toContain('numeric(14, 6)');
    }
  });
});

describe('generated DDL - referential actions', () => {
  const fkLines = migrationSql
    .split('\n')
    .filter((line) => line.includes('ADD CONSTRAINT') && line.includes('FOREIGN KEY'));

  it('emits a foreign key for every declared relationship', () => {
    expect(fkLines.length).toBeGreaterThanOrEqual(25);
  });

  it('never cascades deletes from audit or accounting tables', () => {
    // Losing an event, receipt, block or ledger row because a parent changed
    // would destroy the audit trail the control plane exists to keep.
    const auditTables = ['"events"', '"precheck_receipts"', '"blocks"', '"ledger_daily"'];
    for (const line of fkLines) {
      const isAuditChild = auditTables.some((table) =>
        line.startsWith(`ALTER TABLE ${table} `),
      );
      if (isAuditChild) {
        expect(line, `audit table FK must not cascade: ${line}`).toContain('ON DELETE restrict');
      }
    }
  });

  it('limits cascade deletes to link and per-agent config tables only', () => {
    const cascading = fkLines.filter((line) => line.includes('ON DELETE cascade'));
    const allowedChildren = [
      '"workspace_memberships"',
      '"workspace_policy_state"',
      '"agent_policies"',
      // Auth rows are ephemeral credentials belonging to one identity, not
      // tenant audit history. Removing an identity should remove its pending
      // challenges and live sessions rather than leave them orphaned.
      '"auth_magic_links"',
      '"auth_sessions"',
    ];
    for (const line of cascading) {
      const permitted = allowedChildren.some((table) => line.startsWith(`ALTER TABLE ${table} `));
      expect(permitted, `unexpected cascade: ${line}`).toBe(true);
    }
  });

  it('anchors every agent reference on workspace_id', () => {
    const agentRefs = fkLines.filter((line) => line.includes('REFERENCES "public"."agents"'));
    expect(agentRefs.length).toBeGreaterThan(0);
    for (const line of agentRefs) {
      expect(line).toContain('("workspace_id","id")');
      expect(line).toContain('FOREIGN KEY ("workspace_id","agent_id")');
    }
  });
});

describe('generated DDL - critical constraints', () => {
  it('creates the event idempotency constraint', () => {
    expect(migrationSql).toContain(
      'CONSTRAINT "events_workspace_event_id_key" UNIQUE("workspace_id","event_id")',
    );
  });

  it('creates the one-row-per-agent-per-UTC-day ledger key', () => {
    expect(migrationSql).toContain(
      'CONSTRAINT "ledger_daily_pkey" PRIMARY KEY("workspace_id","agent_id","day")',
    );
    expect(migrationSql).toContain('"day" date NOT NULL');
  });

  it('creates all eight enum types', () => {
    const enums = migrationSql.match(/CREATE TYPE "public"\."\w+" AS ENUM/g) ?? [];
    expect(enums).toHaveLength(8);
  });

  it('creates the baseline event vocabulary', () => {
    expect(migrationSql).toContain(
      `CREATE TYPE "public"."event_type" AS ENUM('agent.action', 'spend.recorded', 'action.blocked', 'heartbeat')`,
    );
  });

  it('creates the agent mode vocabulary', () => {
    expect(migrationSql).toContain(
      `CREATE TYPE "public"."agent_mode" AS ENUM('watch', 'budgeted', 'paused')`,
    );
  });

  it('creates non-negative checks on all committed accounting values', () => {
    expect(migrationSql).toContain('"ledger_daily_spend_nonnegative_check"');
    expect(migrationSql).toContain('"ledger_daily_publish_nonnegative_check"');
  });

  it('writes partial index predicates unqualified for portability', () => {
    const partialIndexes = migrationSql.match(/CREATE INDEX .* WHERE .*/g) ?? [];
    expect(partialIndexes.length).toBeGreaterThan(0);
    for (const index of partialIndexes) {
      const predicate = index.slice(index.indexOf(' WHERE '));
      expect(predicate).not.toMatch(/"\w+"\."\w+"/);
    }
  });
});
