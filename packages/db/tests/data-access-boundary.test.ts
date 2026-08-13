import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import * as dbPackage from '../src/index';
import * as provisioning from '../src/provisioning/index';
import * as repositories from '../src/repositories/index';
import * as resolvers from '../src/resolvers/index';

/**
 * Architecture guardrails for the data-access boundary.
 *
 * These enforce the conventions that keep tenant isolation from eroding as the
 * codebase grows: no escape hatches, no raw table re-exports, and every
 * repository factory demanding a scope.
 */

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('no tenant-bypass escape hatches', () => {
  const FORBIDDEN_EXPORTS = [
    'unsafeDb',
    'withoutWorkspace',
    'allTenants',
    'adminQuery',
    'rawQuery',
    'bypassScope',
    'crossWorkspaceQuery',
    'findAllAgents',
    'findAllEvents',
    'listAllWorkspaces',
    'listAllMemberships',
  ];

  it.each([
    ['@hybrid/db root', dbPackage],
    ['repositories', repositories],
    ['resolvers', resolvers],
    ['provisioning', provisioning],
  ])('%s exposes no bypass helper', (_label, moduleExports) => {
    for (const name of FORBIDDEN_EXPORTS) {
      expect(Object.keys(moduleExports)).not.toContain(name);
    }
  });

  it('exposes no export whose name advertises unsafety', () => {
    const suspicious = /^(unsafe|raw|admin|bypass|god|internal)/i;
    for (const name of Object.keys(dbPackage)) {
      expect(name, `${name} looks like a bypass export`).not.toMatch(suspicious);
    }
  });
});

describe('trusted scope construction cannot be bypassed', () => {
  it('does not export the raw scope constructor from @hybrid/db', () => {
    // `createWorkspaceScope` performs NO authorization. If application code
    // could import it, one line - createWorkspaceScope(req.params.id) - would
    // mint tenant access straight from request input.
    expect(Object.keys(dbPackage)).not.toContain('createWorkspaceScope');
  });

  it('exports the trusted authorization resolver instead', () => {
    expect(Object.keys(dbPackage)).toContain('authorizeWorkspaceForUser');
    expect(typeof dbPackage.authorizeWorkspaceForUser).toBe('function');
  });

  it('still exports the WorkspaceScope type without a way to fabricate one', () => {
    // A type-only export lets callers name the value they receive from the
    // authorization resolver, while leaving the constructor unreachable.
    const packageSource = readFileSync(path.join(PACKAGE_ROOT, 'src', 'index.ts'), 'utf8');

    expect(packageSource).toMatch(/export type \{[^}]*WorkspaceScope/s);
    expect(packageSource).not.toMatch(/^\s*createWorkspaceScope,$/m);
  });

  it('no application CODE calls the raw constructor', () => {
    // Source-level guard: catches even an unexported deep import. Comments are
    // stripped first, so documentation that names the forbidden function -
    // explaining why handlers must not call it - is not a false positive.
    const appsDir = path.resolve(PACKAGE_ROOT, '..', '..', 'apps');
    const offenders: string[] = [];

    const stripComments = (source: string): string =>
      source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === 'dist') continue;
          walk(full);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(entry.name)) continue;
        if (stripComments(readFileSync(full, 'utf8')).includes('createWorkspaceScope')) {
          offenders.push(path.relative(appsDir, full));
        }
      }
    };
    walk(appsDir);

    expect(offenders, 'apps/ must not call createWorkspaceScope').toEqual([]);
  });

  it('only the authorization resolver constructs a scope inside the package', () => {
    const authorization = readFileSync(
      path.join(PACKAGE_ROOT, 'src', 'resolvers', 'authorization.ts'),
      'utf8',
    );

    // And it does so only after the membership join has returned a row.
    expect(authorization).toContain('createWorkspaceScope(row.id)');
    expect(authorization).toContain('eq(workspaceMemberships.userId, userId)');
  });
});

describe('tenant provisioning is narrow', () => {
  it('exposes only workspace creation', () => {
    const functions = Object.entries(provisioning)
      .filter(([, value]) => typeof value === 'function')
      .map(([name]) => name);

    expect(functions).toEqual(['createWorkspaceWithOperator']);
  });

  it('creates the workspace, its membership AND its policy state in one transaction', () => {
    const source = readFileSync(
      path.join(PACKAGE_ROOT, 'src', 'provisioning', 'workspaces.ts'),
      'utf8',
    );

    // A workspace whose creator membership failed would be unreachable
    // forever. A workspace whose POLICY STATE failed would report no version,
    // which `GET /v1/policy` treats as an invariant violation - so all three
    // must commit together or none may.
    expect(source).toContain('db.transaction(');
    expect((source.match(/\.insert\(/g) ?? []).length).toBe(3);
    expect(source).toContain('.insert(workspaces)');
    expect(source).toContain('.insert(workspaceMemberships)');
    expect(source).toContain('.insert(workspacePolicyState)');
  });

  it('initializes the policy version to 1 explicitly', () => {
    const source = readFileSync(
      path.join(PACKAGE_ROOT, 'src', 'provisioning', 'workspaces.ts'),
      'utf8',
    );

    // Stated at the point it is decided rather than inherited from the column
    // default, and matching the `version >= 1` check constraint. Version 0
    // would be indistinguishable from "no state" to a polling client.
    expect(source).toMatch(/workspaceId: workspace\.id,\s*version: 1/);
  });

  it('provisioning sets no policy VALUES, only the version', () => {
    const source = readFileSync(
      path.join(PACKAGE_ROOT, 'src', 'provisioning', 'workspaces.ts'),
      'utf8',
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    // This is policy INITIALIZATION, not policy mutation. Creating agent
    // policy rows or caps here would mean a workspace is born with governance
    // nobody configured.
    expect(code).not.toContain('agentPolicies');
    expect(code).not.toMatch(/\bmode\b|dailySpendCap|dailyPublishCap/);
  });

  it('cannot create a publicly visible workspace', () => {
    const source = readFileSync(
      path.join(PACKAGE_ROOT, 'src', 'provisioning', 'workspaces.ts'),
      'utf8',
    );

    // demo_enabled / demo_slug must not be settable; AC-19 owns those.
    expect(source).not.toContain('demoEnabled');
    expect(source).not.toContain('demoSlug');
  });

  it('assigns the creator the operator role, not the column default', () => {
    const source = readFileSync(
      path.join(PACKAGE_ROOT, 'src', 'provisioning', 'workspaces.ts'),
      'utf8',
    );

    expect(source).toContain("role: 'operator'");
  });
});

describe('raw schema is not reachable from the package root', () => {
  it('does not re-export schema tables from @hybrid/db', () => {
    // `db.select().from(events)` with no workspace predicate is a one-line
    // cross-tenant leak. Raw tables live behind @hybrid/db/schema, which ESLint
    // forbids application code from importing.
    expect(Object.keys(dbPackage)).not.toContain('schema');
    expect(Object.keys(dbPackage)).not.toContain('agents');
    expect(Object.keys(dbPackage)).not.toContain('events');
    expect(Object.keys(dbPackage)).not.toContain('workspaces');
  });

  it('still publishes schema on a dedicated subpath for migrations and tooling', () => {
    const manifest = JSON.parse(
      readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'),
    ) as { exports: Record<string, unknown> };

    expect(Object.keys(manifest.exports)).toContain('./schema');
  });
});

describe('repository factories require a workspace scope', () => {
  const FACTORIES = [
    ['createAgentRepository', repositories.createAgentRepository],
    ['createBlockRepository', repositories.createBlockRepository],
    ['createEventRepository', repositories.createEventRepository],
    ['createIngestLockRepository', repositories.createIngestLockRepository],
    ['createPrecheckReceiptRepository', repositories.createPrecheckReceiptRepository],
    ['createRuntimeProfileRepository', repositories.createRuntimeProfileRepository],
  ] as const;

  it.each(FACTORIES)('%s takes (executor, scope)', (_name, factory) => {
    // Arity is the mechanical guarantee that scope cannot be omitted: a
    // one-argument factory would mean a tenant-free repository exists.
    expect(factory.length).toBe(2);
  });

  it.each(FACTORIES)('%s produces only bound methods, none taking a workspace id', (
    _name,
    factory,
  ) => {
    const repo = factory({} as never, { workspaceId: 'x' } as never) as unknown as Record<
      string,
      unknown
    >;

    for (const [methodName, method] of Object.entries(repo)) {
      expect(typeof method).toBe('function');
      // Methods are bound to the construction-time scope. None may accept a
      // workspace id, which would let a caller re-target another tenant.
      expect(methodName.toLowerCase()).not.toContain('workspace');
    }
  });
});

describe('every repository source file scopes its queries', () => {
  /** Files whose every statement is a read. */
  const READ_ONLY_FILES = ['policy.ts', 'receipts.ts', 'runtime-profiles.ts'];

  /**
   * Files that also perform SCOPED writes.
   *
   * Tenant-scoped mutation belongs in a repository - that is what keeps it
   * inside the tenant boundary. These are enumerated so a new writing
   * repository is a deliberate, reviewed addition rather than something that
   * slips past a blanket "no writes" rule.
   */
  const WRITING_FILES = [
    'agents.ts',
    'api-credentials.ts',
    'blocks.ts',
    'events.ts',
    'policy-mutation.ts',
  ];

  /**
   * Files in `repositories/` that hold no query at all, and why.
   *
   * Enumerated so the classification above stays exhaustive: a new file that is
   * neither read-only nor writing nor listed here fails the census below,
   * rather than quietly escaping every rule in this block.
   *
   * `lock-keys.ts` takes a bare `workspaceId: string`, which the raw-argument
   * rule would otherwise flag. That is correct here and only here: it is a pure
   * hash function, not a query, so there is no row for a wrong workspace id to
   * expose. Its caller derives the value from a `WorkspaceScope`.
   */
  const NON_QUERY_FILES = ['executor.ts', 'index.ts', 'ingest-locks.ts', 'lock-keys.ts', 'workspace-scope.ts'];

  const REPOSITORY_FILES = [...READ_ONLY_FILES, ...WRITING_FILES];

  it('every file in repositories/ is classified', () => {
    const onDisk = readdirSync(path.join(PACKAGE_ROOT, 'src', 'repositories'))
      .filter((name) => name.endsWith('.ts'))
      .sort();

    expect(onDisk).toEqual([...REPOSITORY_FILES, ...NON_QUERY_FILES].sort());
  });

  it.each(READ_ONLY_FILES)('%s references workspaceId in every query builder', (fileName) => {
    const source = readFileSync(
      path.join(PACKAGE_ROOT, 'src', 'repositories', fileName),
      'utf8',
    );

    // Each query builder must run through the file's scope predicate helper.
    // Both `.select()` and a projected `.select({...})` count - a projection
    // is still a read of tenant rows.
    const selectCount = (source.match(/\.select\(/g) ?? []).length;
    const scopePredicateCount = (source.match(/ScopePredicate\(scope\)/g) ?? []).length;

    expect(selectCount).toBeGreaterThan(0);
    expect(
      scopePredicateCount,
      `${fileName}: ${String(selectCount)} selects but ${String(scopePredicateCount)} scope predicates`,
    ).toBe(selectCount);
  });

  it.each(REPOSITORY_FILES)('%s exposes no query taking a raw workspaceId argument', (fileName) => {
    const source = readFileSync(
      path.join(PACKAGE_ROOT, 'src', 'repositories', fileName),
      'utf8',
    );

    // Scope must arrive as a WorkspaceScope, never as a bare string a caller
    // could set to any tenant.
    expect(source).not.toMatch(/workspaceId\s*:\s*string/);
  });
});

describe('resolvers are the only unscoped reads, and stay bounded', () => {
  it('exposes exactly the expected resolver functions', () => {
    // Enumerated rather than counted: a new unscoped read must be a deliberate,
    // reviewed addition to this list, not something that slips in unnoticed.
    const functions = Object.entries(resolvers)
      .filter(([, value]) => typeof value === 'function')
      .map(([name]) => name)
      .sort();

    expect(functions).toEqual([
      // Discovers a workspace from a presented API credential. Cannot take a
      // scope, because producing one is its purpose.
      'authenticateApiCredential',
      'authorizeWorkspaceForUser',
      'findDemoWorkspaceBySlug',
      'findMembership',
      'findWorkspaceById',
      'listMembershipsForUser',
      'listWorkspacesForUser',
    ]);
  });

  it('the credential resolver exposes no cross-tenant search', () => {
    const source = readFileSync(
      path.join(PACKAGE_ROOT, 'src', 'resolvers', 'api-credentials.ts'),
      'utf8',
    );

    // Possession of a valid key is the only way in: the single query matches
    // on prefix AND hash. There is no "list credentials" or "find by
    // workspace" function here to enumerate with.
    expect((source.match(/\.select\(/g) ?? []).length).toBe(1);
    expect(source).toContain('eq(apiCredentials.keyPrefix, keyPrefix)');
    expect(source).toContain('eq(apiCredentials.secretHash, secretHash)');
    expect(source).toContain('isNull(apiCredentials.revokedAt)');
  });

  it('builds the credential scope from the row, never from an argument', () => {
    const source = readFileSync(
      path.join(PACKAGE_ROOT, 'src', 'resolvers', 'api-credentials.ts'),
      'utf8',
    );

    expect(source).toContain('createWorkspaceScope(row.workspaceId)');
    // There is no workspace parameter to misuse.
    expect(source).not.toMatch(/workspaceId:\s*string\s*[,)]/);
  });

  it('bounds every workspace-listing resolver on the authenticated user', () => {
    const source = readFileSync(
      path.join(PACKAGE_ROOT, 'src', 'resolvers', 'authorization.ts'),
      'utf8',
    );

    // Both queries must filter by userId. An unbounded workspace read here
    // would list every tenant on the platform.
    const selectCount = (source.match(/\.select\(\{/g) ?? []).length;
    const userFilterCount = (source.match(/eq\(workspaceMemberships\.userId, userId\)/g) ?? [])
      .length;

    expect(selectCount).toBeGreaterThan(0);
    expect(userFilterCount).toBe(selectCount);
  });

  it('anchors membership resolution on a user id', () => {
    const source = readFileSync(
      path.join(PACKAGE_ROOT, 'src', 'resolvers', 'memberships.ts'),
      'utf8',
    );

    // Both membership queries must filter by userId; an unfiltered membership
    // read would enumerate the whole platform.
    const selectCount = (source.match(/\.select\(\)/g) ?? []).length;
    const userFilterCount = (source.match(/eq\(workspaceMemberships\.userId, userId\)/g) ?? [])
      .length;

    expect(selectCount).toBeGreaterThan(0);
    expect(userFilterCount).toBe(selectCount);
  });

  it('constrains the public demo resolver to demo-enabled workspaces', () => {
    const source = readFileSync(
      path.join(PACKAGE_ROOT, 'src', 'resolvers', 'workspaces.ts'),
      'utf8',
    );

    expect(source).toContain('eq(workspaces.demoEnabled, true)');
  });
});

describe('destructive live tests cannot target production', () => {
  /**
   * EVERY data-writing live suite, discovered from disk rather than listed.
   *
   * A hand-maintained list would silently stop covering a suite added later -
   * which is exactly the suite most likely to get its gate wrong.
   */
  const LIVE_SUITES = readdirSync(path.join(PACKAGE_ROOT, 'tests'))
    .filter((name) => name.endsWith('.live.test.ts'))
    .sort();

  const read = (fileName: string): string =>
    readFileSync(path.join(PACKAGE_ROOT, 'tests', fileName), 'utf8');

  /**
   * Whether a suite mutates data, DERIVED FROM ITS SOURCE.
   *
   * Deliberately not a hand-maintained allowlist. The gate a suite must satisfy
   * follows from what it actually does, so a suite cannot be reclassified as
   * harmless while quietly containing an INSERT.
   */
  const writesData = (source: string): boolean =>
    /\.insert\(|\.update\(|\.delete\(/.test(source) ||
    /\b(insert\s+into|update\s+\w+\s+set|delete\s+from)\b/i.test(source);

  const WRITING_SUITES = LIVE_SUITES.filter((name) => writesData(read(name)));
  const READING_SUITES = LIVE_SUITES.filter((name) => !writesData(read(name)));

  it('classifies the live suites', () => {
    // Guards the guard: a glob that matched nothing, or a classifier that put
    // every suite in the unchecked bucket, would make the rest vacuous.
    expect(LIVE_SUITES.length).toBeGreaterThan(0);
    expect(WRITING_SUITES).toContain('event-ingest.live.test.ts');
    expect(WRITING_SUITES).toContain('tenant-isolation.live.test.ts');
    // The connectivity probe only SELECTs, so it may use DATABASE_URL.
    expect(READING_SUITES).toEqual(['neon-connectivity.live.test.ts']);
  });

  it.each(WRITING_SUITES)('%s gates on TEST_DATABASE_URL', (fileName) => {
    expect(read(fileName)).toContain("process.env['TEST_DATABASE_URL']");
  });

  it.each(WRITING_SUITES)('%s skips itself when the gate is unset', (fileName) => {
    // Without skipIf the suite would not skip - it would FAIL on a developer
    // machine, and the pressure would be to point it at whatever database
    // happens to be configured.
    expect(read(fileName)).toMatch(/describe\.skipIf\(!hasTestDatabase\)/);
  });

  it.each(WRITING_SUITES)('%s never falls back to DATABASE_URL', (fileName) => {
    // A fallback is how a data-writing suite ends up pointed at production.
    const readsProductionUrl = /process\.env\[['"]DATABASE_URL['"]\]/.test(read(fileName));

    expect(readsProductionUrl, `${fileName} must not read DATABASE_URL`).toBe(false);
  });

  it.each(WRITING_SUITES)('%s rolls its writes back', (fileName) => {
    // Rollback leaves no residue even on failure. The few tests that must
    // COMMIT (to observe a real race) delete their own rows in a finally.
    expect(read(fileName)).toContain('Rollback');
  });

  it.each(LIVE_SUITES)('%s never drops or truncates', (fileName) => {
    // A stray run against a populated database still cannot destroy data.
    expect(read(fileName)).not.toMatch(/\bdrop\s+table\b|\btruncate\b/i);
  });

  it.each(LIVE_SUITES)('%s never logs the connection string', (fileName) => {
    expect(read(fileName)).not.toMatch(/console\.(log|info|warn|error)/);
  });
});

describe('mutation surface stays narrow and scoped', () => {
  it.each(['receipts.ts', 'runtime-profiles.ts'])('%s performs no writes', (fileName) => {
    const source = readFileSync(path.join(PACKAGE_ROOT, 'src', 'repositories', fileName), 'utf8');

    expect(source, fileName).not.toMatch(/\.insert\(|\.update\(|\.delete\(/);
  });

  it.each(['agents.ts', 'api-credentials.ts', 'blocks.ts', 'events.ts'])(
    '%s never deletes tenant rows',
    (fileName) => {
      const source = readFileSync(path.join(PACKAGE_ROOT, 'src', 'repositories', fileName), 'utf8');

      // Revocation and de-registration must be state changes, not deletions -
      // the rows are audit history.
      expect(source, fileName).not.toMatch(/\.delete\(/);
    },
  );

  it.each(['blocks.ts', 'events.ts'])('%s is append-only: no update either', (fileName) => {
    const source = readFileSync(path.join(PACKAGE_ROOT, 'src', 'repositories', fileName), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    // The audit stream is the evidence AC-06 and AC-13 rest on. An UPDATE path
    // here would let a replayed event rewrite recorded history, and
    // `onConflictDoUpdate` is an UPDATE by another name.
    expect(code, fileName).not.toMatch(/\.update\(/);
    expect(code, fileName).not.toContain('onConflictDoUpdate');
  });

  it('event insert is workspace-anchored and idempotent', () => {
    const source = readFileSync(path.join(PACKAGE_ROOT, 'src', 'repositories', 'events.ts'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    // Workspace comes from the scope, never from the caller's input object.
    expect(code).toContain('workspaceId: scope.workspaceId');
    expect(code).not.toMatch(/workspaceId:\s*input\./);
    // The unique index on (workspace_id, event_id) is the race arbiter for
    // AC-13; DO NOTHING is what makes a concurrent duplicate a no-op rather
    // than a constraint violation or an overwrite.
    expect(code).toContain('onConflictDoNothing');
    expect(code).toContain('target: [events.workspaceId, events.eventId]');
  });

  it('block resolution conflicts on the workspace-scoped external id', () => {
    const source = readFileSync(path.join(PACKAGE_ROOT, 'src', 'repositories', 'blocks.ts'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    expect(code).toContain('workspaceId: scope.workspaceId');
    expect(code).toContain('onConflictDoNothing');
    expect(code).toContain('target: [blocks.workspaceId, blocks.externalBlockId]');
    // Runtime-reported blocks are self-declared. Only the plane may mint a
    // block it claims to have enforced, so `source` is not a parameter.
    expect(code).toContain("source: 'runtime'");
    expect(code).not.toMatch(/source:\s*input\.|source:\s*\w+Source/);
  });

  it('ingest serialization is transaction-scoped, never session-scoped', () => {
    const source = readFileSync(
      path.join(PACKAGE_ROOT, 'src', 'repositories', 'ingest-locks.ts'),
      'utf8',
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    // Neon and PgBouncer pool per TRANSACTION. A session-scoped
    // `pg_advisory_lock` would outlive the request, attach to whichever request
    // next borrowed the connection, and eventually wedge the pool.
    expect(code).toContain('pg_advisory_xact_lock');
    expect(code).not.toMatch(/pg_advisory_lock\s*\(/);
    expect(code).not.toContain('pg_advisory_unlock');
    // The workspace comes from the scope, so a caller cannot aim a lock at
    // another tenant's key space.
    expect(code).toContain('scope.workspaceId');
  });

  it('locks are acquired in deterministic order', () => {
    const source = readFileSync(
      path.join(PACKAGE_ROOT, 'src', 'repositories', 'ingest-locks.ts'),
      'utf8',
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    // Without a sort, two batches carrying the same ids in opposite order can
    // deadlock, because xact locks are held until COMMIT.
    expect(code).toContain('.sort(compareLockKeys)');
    // And sequentially - Promise.all would forfeit the ordering entirely.
    expect(code).not.toMatch(/Promise\.all/);
  });

  it('the lock key derivation is pure and reproducible across instances', () => {
    const source = readFileSync(
      path.join(PACKAGE_ROOT, 'src', 'repositories', 'lock-keys.ts'),
      'utf8',
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    // A key that varied by process would mean two Render instances failing to
    // exclude each other on the same event.
    expect(code).not.toMatch(/Math\.random|Date\.now|process\.(pid|env)|randomUUID/);
    expect(code).toContain("createHash('sha256')");
  });

  it('THE POLICY REPOSITORY HAS NO WRITER', () => {
    const source = readFileSync(path.join(PACKAGE_ROOT, 'src', 'repositories', 'policy.ts'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    // The single most important guarantee in Step 12. Event ingest, agent
    // registration, API-key auth, share links and the demo all reach the data
    // layer; a policy mutator reachable from any of them would let a runtime
    // edit the governance it is subject to.
    expect(code).not.toMatch(/\.insert\(|\.update\(|\.delete\(/);
    expect(code).not.toMatch(/\b(updatePolicy|savePolicy|setMode|setCap|bumpVersion|incrementVersion)\b/i);
  });

  it('EXACTLY TWO files may write policy tables', () => {
    // Source-level sweep across BOTH packages, catching a deep import too.
    //
    //   provisioning/workspaces.ts  - inserts the INITIAL version row only
    //   repositories/policy-mutation.ts - the versioned mutation service
    //
    // Anything else writing `agent_policies` or `workspace_policy_state` would
    // be an UNVERSIONED policy write: a governance change invisible to every
    // polling agent, which would keep receiving 304 and running under the old
    // policy indefinitely.
    const roots = [
      path.join(PACKAGE_ROOT, 'src'),
      path.resolve(PACKAGE_ROOT, '..', '..', 'apps'),
    ];
    const PERMITTED = [
      path.join('provisioning', 'workspaces.ts'),
      path.join('repositories', 'policy-mutation.ts'),
    ];
    const offenders: string[] = [];

    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === 'dist') continue;
          walk(full);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(entry.name)) continue;
        if (PERMITTED.some((permitted) => full.endsWith(permitted))) continue;
        if (full.includes(`${path.sep}tests${path.sep}`)) continue;

        const code = readFileSync(full, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/\/\/.*$/gm, '');

        if (/\.(insert|update|delete)\([\s]*(agentPolicies|workspacePolicyState)/.test(code)) {
          offenders.push(full);
        }
      }
    };
    for (const root of roots) walk(root);

    expect(offenders, 'only provisioning and the mutation service may write policy').toEqual([]);
  });

  it('THE POLICY WRITER ALWAYS INCREMENTS THE VERSION', () => {
    const source = readFileSync(
      path.join(PACKAGE_ROOT, 'src', 'repositories', 'policy-mutation.ts'),
      'utf8',
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    // The central Step 13 invariant. Both halves in ONE transaction.
    expect(code).toContain('db.transaction(');
    expect(code).toContain('.insert(agentPolicies)');
    expect(code).toContain('.update(workspacePolicyState)');
    // A single `version + 1` statement evaluated by PostgreSQL, NOT a
    // read-then-write: two transactions that both read 10 would both write 11.
    expect(code).toMatch(/version:\s*sql`\$\{workspacePolicyState\.version\} \+ 1`/);
    // And serialized from the start, so concurrent mutations queue rather than
    // interleave.
    expect(code).toContain(".for('update')");
  });

  it('the policy writer is workspace-anchored and takes no workspace argument', () => {
    const source = readFileSync(
      path.join(PACKAGE_ROOT, 'src', 'repositories', 'policy-mutation.ts'),
      'utf8',
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    // Workspace from the SCOPE on every statement - the agent lookup, the
    // upsert and the version bump alike. A globally unique agent UUID is not
    // authorization.
    expect(code).toContain('workspaceId: scope.workspaceId');
    expect(code).toContain('eq(agents.workspaceId, scope.workspaceId)');
    expect(code).toContain('eq(workspacePolicyState.workspaceId, scope.workspaceId)');
    expect(code).not.toMatch(/workspaceId:\s*string\s*[,)]/);
    // Conflict target is the composite identity, never the agent id alone.
    expect(code).toContain('target: [agentPolicies.workspaceId, agentPolicies.agentId]');
  });

  it('the policy writer touches no ledger, receipt, block or event table', () => {
    const source = readFileSync(
      path.join(PACKAGE_ROOT, 'src', 'repositories', 'policy-mutation.ts'),
      'utf8',
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    // Raising a cap from 25 to 100 must NOT reset today's committed spend -
    // that would let an operator erase history by editing configuration.
    for (const forbidden of ['ledgerDaily', 'precheckReceipts', 'blocks', 'events']) {
      expect(code, forbidden).not.toContain(forbidden);
    }
  });

  it('policy reads are workspace-anchored on both sides of the join', () => {
    const source = readFileSync(path.join(PACKAGE_ROOT, 'src', 'repositories', 'policy.ts'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    // Joining on the agent UUID alone would be a global join: a policy row
    // from another tenant could pair with this tenant's agent.
    expect(code).toContain('eq(agentPolicies.agentId, agents.id)');
    expect(code).toContain('eq(agentPolicies.workspaceId, agents.workspaceId)');
    // And the join starts FROM agents, so an agent with no policy row is still
    // returned - the "empty policy for a known workspace" failure mode.
    expect(code).toMatch(/\.from\(agents\)[\s\S]{0,200}\.leftJoin\(/);
  });

  it('the policy version is read as text, never as a JS number', () => {
    const source = readFileSync(path.join(PACKAGE_ROOT, 'src', 'repositories', 'policy.ts'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    // The column is a bigint. Converting through Number would silently lose
    // precision above 2^53 - invisible if it ever happened, free to avoid.
    expect(code).toContain('::text');
    expect(code).not.toMatch(/Number\(|parseInt\(/);
  });

  it('the receipt repository can only test existence', () => {
    const source = readFileSync(
      path.join(PACKAGE_ROOT, 'src', 'repositories', 'receipts.ts'),
      'utf8',
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    // Ingest must be able to VERIFY a precheck receipt, never to create one -
    // a self-issued receipt would be an approval an agent granted itself.
    expect(code).not.toMatch(/\.insert\(|\.update\(|\.delete\(/);
    expect(code).toContain('receiptScopePredicate(scope)');
  });

  it('agent writes are workspace-anchored', () => {
    const source = readFileSync(path.join(PACKAGE_ROOT, 'src', 'repositories', 'agents.ts'), 'utf8');

    // The inserted workspace comes from the scope, and the update carries the
    // scope predicate. Neither takes a workspace argument.
    expect(source).toContain('workspaceId: scope.workspaceId');
    expect(source).toMatch(/\.update\(agents\)[\s\S]{0,200}agentScopePredicate\(scope\)/);
    expect(source).not.toMatch(/workspaceId:\s*string\s*[,)]/);
  });

  it('agent registration conflicts on the workspace-scoped identity', () => {
    const source = readFileSync(path.join(PACKAGE_ROOT, 'src', 'repositories', 'agents.ts'), 'utf8');

    // The unique index on (workspace_id, external_id) is the race arbiter.
    expect(source).toContain('onConflictDoUpdate');
    expect(source).toContain('target: [agents.workspaceId, agents.externalId]');
  });

  it('no repository exposes a generic patch/update-anything method', () => {
    for (const fileName of ['agents.ts', 'api-credentials.ts', 'events.ts', 'runtime-profiles.ts']) {
      const source = readFileSync(
        path.join(PACKAGE_ROOT, 'src', 'repositories', fileName),
        'utf8',
      );
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

      // A generic mutator is how event ingest, a share link or the demo would
      // eventually acquire authority over policy fields.
      expect(code, fileName).not.toMatch(/\b(patch|updateAny|updateFields|setFields)\s*\(/i);
    }
  });

  it('agent registration cannot touch policy or runtime profile', () => {
    const source = readFileSync(path.join(PACKAGE_ROOT, 'src', 'repositories', 'agents.ts'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    expect(code).not.toContain('runtimeProfileId:');
    expect(code).not.toMatch(/\bmode\b|agentPolicies|dailySpendCap|dailyPublishCap/);
  });

  it('resolvers perform no writes', () => {
    for (const fileName of ['memberships.ts', 'workspaces.ts']) {
      const source = readFileSync(path.join(PACKAGE_ROOT, 'src', 'resolvers', fileName), 'utf8');

      expect(source, fileName).not.toMatch(/\.insert\(|\.update\(|\.delete\(/);
    }
  });
});
