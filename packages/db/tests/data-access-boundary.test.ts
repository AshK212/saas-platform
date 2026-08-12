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

  it('creates the workspace and its membership in one transaction', () => {
    const source = readFileSync(
      path.join(PACKAGE_ROOT, 'src', 'provisioning', 'workspaces.ts'),
      'utf8',
    );

    // A workspace whose creator membership failed would be unreachable forever.
    expect(source).toContain('db.transaction(');
    expect((source.match(/\.insert\(/g) ?? []).length).toBe(2);
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
    ['createEventRepository', repositories.createEventRepository],
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
  const REPOSITORY_FILES = ['agents.ts', 'events.ts', 'runtime-profiles.ts'];

  it.each(REPOSITORY_FILES)('%s references workspaceId in every query builder', (fileName) => {
    const source = readFileSync(
      path.join(PACKAGE_ROOT, 'src', 'repositories', fileName),
      'utf8',
    );

    // Each query builder must run through the file's scope predicate helper.
    const selectCount = (source.match(/\.select\(\)/g) ?? []).length;
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
      'authorizeWorkspaceForUser',
      'findDemoWorkspaceBySlug',
      'findMembership',
      'findWorkspaceById',
      'listMembershipsForUser',
      'listWorkspacesForUser',
    ]);
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
  const liveSource = readFileSync(
    path.join(PACKAGE_ROOT, 'tests', 'tenant-isolation.live.test.ts'),
    'utf8',
  );

  it('gates on TEST_DATABASE_URL', () => {
    expect(liveSource).toContain("process.env['TEST_DATABASE_URL']");
  });

  it('never falls back to DATABASE_URL', () => {
    // A fallback is how a data-writing suite ends up pointed at production.
    const readsProductionUrl = /process\.env\[['"]DATABASE_URL['"]\]/.test(liveSource);

    expect(readsProductionUrl, 'live isolation suite must not read DATABASE_URL').toBe(false);
  });

  it('rolls back every write instead of deleting rows', () => {
    // Rollback leaves no residue even on failure, and a stray run against a
    // populated database still cannot destroy existing data.
    expect(liveSource).toContain('Rollback');
    expect(liveSource).not.toMatch(/\bdrop\s+table\b|\btruncate\b/i);
  });

  it('never logs the connection string', () => {
    expect(liveSource).not.toMatch(/console\.(log|info|warn|error)/);
  });
});

describe('no mutation surface exists yet', () => {
  it('repositories perform no writes', () => {
    for (const fileName of ['agents.ts', 'events.ts', 'runtime-profiles.ts']) {
      const source = readFileSync(
        path.join(PACKAGE_ROOT, 'src', 'repositories', fileName),
        'utf8',
      );

      // A generic write surface is how a read-only share or the public demo
      // would eventually be able to mutate policy. Step 4 adds none.
      expect(source, fileName).not.toMatch(/\.insert\(|\.update\(|\.delete\(/);
    }
  });

  it('resolvers perform no writes', () => {
    for (const fileName of ['memberships.ts', 'workspaces.ts']) {
      const source = readFileSync(path.join(PACKAGE_ROOT, 'src', 'resolvers', fileName), 'utf8');

      expect(source, fileName).not.toMatch(/\.insert\(|\.update\(|\.delete\(/);
    }
  });
});
