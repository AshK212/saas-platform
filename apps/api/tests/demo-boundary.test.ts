import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * SOURCE GUARDRAILS for public demo mode (AC-19).
 *
 * The demo makes a private tenant readable by anyone on the internet. The
 * behavioural suite proves it behaves today; these defend the properties that
 * would fail SILENTLY - where the page still renders, requests still return
 * 200, and the damage is a workspace that was never meant to be public, or a
 * demo whose "live" numbers were invented.
 *
 * Five things must stay true:
 *
 *   1. `demo_enabled` defaults false and is checked in SQL on every read.
 *   2. Enabling is operator-only, through one narrow writer.
 *   3. The public surface is GET-only and can reach nothing that writes.
 *   4. The page shows REAL data - no fixture, and no event-summing for totals.
 *   5. The generator has no database access and no policy authority.
 *
 * Each is mutation-probed in the Step 22 report.
 */

const API_SRC = path.resolve(import.meta.dirname, '..', 'src');
const REPO_ROOT = path.resolve(API_SRC, '..', '..', '..');
const WEB_SRC = path.join(REPO_ROOT, 'apps', 'web', 'src');
const DB_SRC = path.join(REPO_ROOT, 'packages', 'db', 'src');
const SIM_SRC = path.join(REPO_ROOT, 'apps', 'simulator', 'src');

function read(file: string): string {
  return readFileSync(file, 'utf8');
}

/** Source with comments stripped, so prose about a pattern cannot trip it. */
function code(file: string): string {
  return read(file)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

const PUBLIC_ROUTES = path.join(API_SRC, 'routes', 'demo-public.ts');
const MANAGEMENT_ROUTES = path.join(API_SRC, 'routes', 'demo-management.ts');
const DEMO_STORE = path.join(API_SRC, 'demo', 'store.ts');
const DEMO_SLUG = path.join(API_SRC, 'demo', 'slug.ts');
const DEMO_REPO = path.join(DB_SRC, 'repositories', 'demo-settings.ts');
const DEMO_RESOLVER = path.join(DB_SRC, 'resolvers', 'demo.ts');
const WORKSPACE_SCHEMA = path.join(DB_SRC, 'schema', 'workspaces.ts');
const GENERATOR = path.join(SIM_SRC, 'demo-generator.ts');

describe('A WORKSPACE IS NEVER BORN PUBLIC', () => {
  it('demo_enabled defaults false in the schema', () => {
    const schema = code(WORKSPACE_SCHEMA);

    expect(schema).toContain("demoEnabled: boolean('demo_enabled').notNull().default(false)");
  });

  it('the schema forbids a slug on a private workspace', () => {
    const schema = code(WORKSPACE_SCHEMA);

    // `demo_slug IS NULL OR demo_enabled`. A public locator only exists while
    // the thing it locates is public - which is why disabling clears it.
    expect(schema).toContain('workspaces_demo_slug_requires_demo_check');
    expect(schema).toContain('is null or');
  });

  it('provisioning cannot create a public workspace', () => {
    const provisioning = code(path.join(DB_SRC, 'provisioning', 'workspaces.ts'));

    expect(provisioning).not.toContain('demoEnabled');
    expect(provisioning).not.toContain('demoSlug');
  });
});

describe('PUBLIC RESOLUTION REQUIRES THE FLAG', () => {
  it('demo_enabled is a SQL predicate, not a later check', () => {
    const resolver = code(DEMO_RESOLVER);

    // PROBE A. Fetching by slug and testing the flag in JavaScript afterwards
    // would make a forgotten branch a full tenant disclosure.
    const where = resolver.slice(resolver.indexOf('.where('), resolver.indexOf('.limit('));
    expect(where).toContain('eq(workspaces.demoSlug, slug)');
    expect(where).toContain('eq(workspaces.demoEnabled, true)');
  });

  it('the resolver takes no workspace argument', () => {
    const resolver = code(DEMO_RESOLVER);

    // Its purpose is to DISCOVER the workspace. Accepting one would let a
    // caller choose which tenant to read.
    expect(resolver).toContain('createWorkspaceScope(row.id)');
    expect(resolver).not.toMatch(/workspaceId\s*:\s*string\s*[,)]/);
    expect(resolver).not.toMatch(/scope\s*:\s*WorkspaceScope\s*[,)]/);
  });

  it('THE FLAG IS RE-CHECKED ON EVERY REQUEST', () => {
    const routes = code(PUBLIC_ROUTES);

    // No cache, no memoisation - which is what makes a withdrawal take effect
    // on the visitor's very next request.
    expect(routes).toContain('demoResolverStore.resolve(');
    for (const cache of ['cache', 'memo', 'lastResolved', 'ttl']) {
      expect(routes, cache).not.toContain(cache);
    }
  });

  it('the resolver exposes no enumeration', () => {
    const resolver = code(DEMO_RESOLVER);

    // One query, by slug. No "list demo workspaces", no "find by id".
    expect([...resolver.matchAll(/\.select\(/g)]).toHaveLength(1);
    expect(resolver).not.toContain('listDemo');
  });

  it('every public failure is the same body and status', () => {
    const routes = code(PUBLIC_ROUTES);

    // Unknown, malformed, disabled and cross-tenant are indistinguishable.
    expect(routes).toContain("NOT_FOUND_BODY = { error: 'demo_not_found' }");
    expect(routes).not.toContain('disabled');
    expect(routes).not.toContain('403');
  });
});

describe('ENABLING IS OPERATOR-ONLY, THROUGH ONE NARROW WRITER', () => {
  it('management requires a session and the operator role', () => {
    const management = code(MANAGEMENT_ROUTES);

    // PROBE F.
    expect(management).toContain('requireAuthenticatedUser');
    expect(management).toContain("authorized.workspace.role !== 'operator'");
    // Never a demo slug, a share token or a bearer key.
    for (const forbidden of ['demoResolverStore', 'Bearer', 'apiKeyStore', 'shareResolverStore']) {
      expect(management, forbidden).not.toContain(forbidden);
    }
  });

  it('the request carries only `enabled` - never a caller-chosen slug', () => {
    const contracts = code(path.join(REPO_ROOT, 'packages', 'contracts', 'src', 'demo.ts'));

    // Letting a caller pick would invite squatting on recognisable names
    // across tenants.
    expect(contracts).toContain('setDemoRequestSchema = z.strictObject({\n  enabled: z.boolean(),\n})');
  });

  it('there is no generic workspace update', () => {
    const management = code(MANAGEMENT_ROUTES);

    // A switch this consequential must not sit in a bag of fields where a
    // future caller flips it while renaming something.
    expect(management).not.toContain('patch');
    expect(management).toContain('routes.put(WORKSPACE_DEMO_PATH');
    expect([...management.matchAll(/routes\.(put|post|patch|delete)\(/g)]).toHaveLength(1);
  });

  it('the repository writes the flag through two explicit verbs', () => {
    const repository = code(DEMO_REPO);

    expect(repository).toContain('async enable(');
    expect(repository).toContain('async disable(');

    // Every write sets the flag to a LITERAL. A `.set({ demoEnabled: x })`
    // taking a boolean from a caller-shaped object is what would let a generic
    // update flip it. Scoped to `.set(` because the SELECT projection
    // legitimately reads `demoEnabled: workspaces.demoEnabled`.
    const writes = [...repository.matchAll(/\.set\(\{[^}]*demoEnabled:\s*([^,]+),/g)].map((m) =>
      m[1]?.trim(),
    );
    expect(writes).toEqual(['true', 'false']);
  });

  it('DISABLING CLEARS THE SLUG', () => {
    const repository = code(DEMO_REPO);

    // The schema requires it, and it means a withdrawn URL stays dead.
    expect(repository).toContain('demoEnabled: false, demoSlug: null');
  });

  it('every write is workspace-scoped', () => {
    const repository = code(DEMO_REPO);

    const updates = [...repository.matchAll(/\.update\(workspaces\)/g)];
    const scoped = [...repository.matchAll(/workspaceScopePredicate\(scope\)/g)];
    expect(updates.length).toBeGreaterThan(0);
    expect(scoped.length).toBeGreaterThanOrEqual(updates.length);
  });
});

describe('THE PUBLIC SURFACE CANNOT WRITE', () => {
  it('is GET-only', () => {
    const routes = code(PUBLIC_ROUTES);

    const gets = [...routes.matchAll(/routes\.get\(/g)];
    expect(gets.length).toBeGreaterThanOrEqual(6);
    for (const verb of ['post', 'put', 'patch', 'delete', 'all']) {
      expect(routes, verb).not.toContain(`routes.${verb}(`);
    }
  });

  it('imports no mutation store', () => {
    const routes = code(PUBLIC_ROUTES);

    // PROBE B. Each of these is one import away and none belongs here.
    for (const forbidden of [
      'PolicyMutationStore',
      'policy-mutation',
      'ApiKeyStore',
      'api-keys',
      'EventIngestStore',
      'events/store',
      'PrecheckStore',
      'precheck/store',
      'DemoManagementStore',
      'ShareManagementStore',
      'WorkspaceStore',
    ]) {
      expect(routes, forbidden).not.toContain(forbidden);
    }
  });

  it('the read-only context carries no user, role or permission', () => {
    const store = code(DEMO_STORE);

    const context = store.slice(
      store.indexOf('export interface ReadOnlyDemoContext'),
      store.indexOf('export interface DemoResolverStore'),
    );
    expect(context).toContain('scope');
    for (const forbidden of ['user', 'role', 'permission', 'canWrite', 'AuthenticatedUser']) {
      expect(context, forbidden).not.toContain(forbidden);
    }
    // Not an AuthorizedWorkspace: that carries a membership role.
    expect(context).not.toContain('AuthorizedWorkspace');
  });

  it('never touches the ledger, policy or a receipt writer', () => {
    const routes = code(PUBLIC_ROUTES);

    for (const forbidden of [
      'lockDailyLedger',
      'commitSpend',
      'touchLastSeen',
      'createPolicyMutationRepository',
      '.transaction(',
    ]) {
      expect(routes, forbidden).not.toContain(forbidden);
    }
  });

  it('consults no session and no credential', () => {
    const routes = code(PUBLIC_ROUTES);

    // A visitor arrives with a slug and nothing else.
    for (const forbidden of [
      'requireAuthenticatedUser',
      'authService',
      'readAuthCookie',
      'readShareCookie',
      'setCookie',
    ]) {
      expect(routes, forbidden).not.toContain(forbidden);
    }
  });
});

describe('THE SLUG IS A LOCATOR, NOT A SECRET - AND LEAKS NOTHING', () => {
  it('is generated with a CSPRNG', () => {
    const slug = code(DEMO_SLUG);

    expect(slug).toContain('randomBytes');
    expect(slug).not.toContain('Math.random');
    expect(slug).not.toContain('Date.now');
  });

  it('is derived only from the workspace NAME and randomness', () => {
    const slug = code(DEMO_SLUG);

    // The name is the operator's own public label and appears on the page
    // anyway. A uuid, an email or a key prefix must never appear.
    expect(slug).toContain('workspaceName');
    for (const forbidden of ['workspaceId', 'email', 'keyPrefix', 'tokenHash', 'uuid']) {
      expect(slug, forbidden).not.toContain(forbidden);
    }
  });
});

describe('THE PAGE SHOWS REAL DATA', () => {
  const view = code(path.join(WEB_SRC, 'DemoView.tsx'));

  it('EMBEDS NO FIXTURE DATASET', () => {
    // The criterion is explicit: a real read path, not a fake dashboard.
    for (const fixture of [
      'demoAgents =',
      'demoEvents =',
      'fakeBlocks',
      'sampleAgents',
      'mockData',
      'SAMPLE_',
      'FIXTURE',
      'placeholderAgents',
    ]) {
      expect(view, fixture).not.toContain(fixture);
    }

    // No array literal of objects standing in for records.
    expect(view).not.toMatch(/const \w*(?:agents|events|blocks|receipts)\w*\s*[:=]\s*\[\s*\{/i);
  });

  it('reads every section from the public demo API', () => {
    for (const call of [
      'fetchDemoWorkspace',
      'fetchDemoAgents',
      'fetchDemoEvents',
      'fetchDemoReceipts',
      'fetchDemoBlocks',
    ]) {
      expect(view, call).toContain(call);
    }
  });

  it('DOES NOT SUM EVENTS TO DERIVE TOTALS', () => {
    // PROBE E. Today's spend comes from `ledger_daily`, already computed on
    // `governance`. Summing here would show a number the plane does not
    // enforce against - the Step 17 invariant.
    expect(view).toContain('describeSpend(agent.governance)');
    for (const float of ['parseFloat', 'toFixed', '.reduce(', 'Number(']) {
      expect(view, float).not.toContain(float);
    }
  });

  it('renders no edit control', () => {
    const raw = read(path.join(WEB_SRC, 'DemoView.tsx'));

    for (const label of [
      'Save policy',
      'Create key',
      'API Keys',
      'Revoke',
      'Create share',
      'Sign out',
      'Pause',
      'Turn on public demo',
    ]) {
      expect(raw, label).not.toContain(label);
    }
  });

  it('imports no management or mutation client function', () => {
    for (const forbidden of [
      'setDemoEnabled',
      'createShareLink',
      'revokeShareLink',
      'createApiKey',
      'savePolicy',
      'createWorkspace',
      'logout',
    ]) {
      expect(view, forbidden).not.toContain(forbidden);
    }
  });

  it('says plainly that it is a read-only public demo', () => {
    const raw = read(path.join(WEB_SRC, 'DemoView.tsx'));

    expect(raw).toContain('Public demo');
    expect(raw).toContain('read-only');
  });

  it('NO dangerouslySetInnerHTML', () => {
    for (const file of ['DemoView.tsx', 'DemoSettings.tsx']) {
      expect(code(path.join(WEB_SRC, file))).not.toContain('dangerouslySetInnerHTML');
    }
  });

  it('cleans up its refresh timer', () => {
    // A closed page must leave no timer behind, and no runaway requests.
    expect(view).toContain('clearInterval(timer)');
    expect(view).toContain('REFRESH_INTERVAL_MS');
  });
});

describe('THE GENERATOR GOES THROUGH THE REAL API', () => {
  it('has no database access of any kind', () => {
    const generator = code(GENERATOR);

    // PROBE C. It must not write a block, a receipt, a ledger row or an event
    // directly - the whole point is that the plane produces them.
    //
    // Checked as IMPORTS and TABLE identifiers rather than as raw substrings:
    // the module legitimately says "blocks" in operator-facing output, and a
    // guard that flagged prose would be noise rather than protection.
    const specifiers = [...generator.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1] ?? '');
    for (const specifier of specifiers) {
      expect(specifier).not.toMatch(/@hybrid\/db|drizzle|^pg$/);
    }
    for (const table of ['precheckReceipts', 'ledgerDaily', 'agentPolicies', 'shareTokens']) {
      expect(generator, table).not.toContain(table);
    }
  });

  it('imports only reference-client pieces', () => {
    const generator = code(GENERATOR);
    const specifiers = [...generator.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1] ?? '');

    // Relative, in-package imports only. The generator is a MODE of the
    // reference client, reusing its transport rather than duplicating it.
    for (const specifier of specifiers) {
      expect(specifier.startsWith('./')).toBe(true);
    }
  });

  it('HAS NO POLICY AUTHORITY', () => {
    const generator = code(GENERATOR);

    // It holds machine authority only. If an operator raises the cap, it obeys
    // rather than lowering it again to keep producing blocks.
    //
    // Checked as CALLS and route helpers. The word "policy" appears in the
    // message shown when an attempt is allowed - explaining that current
    // policy permitted it - and that sentence is worth keeping.
    for (const forbidden of [
      'agentPolicyPath',
      'setPolicy',
      'updatePolicy',
      'dailySpendCap',
      "method: 'PUT'",
    ]) {
      expect(generator, forbidden).not.toContain(forbidden);
    }
  });

  it('creates no block and reports no spend after a denial', () => {
    const generator = code(GENERATOR);

    // The plane owns the receipt and the block.
    expect(generator).not.toContain('action.blocked');
    expect(generator).not.toContain('reportRuntimeBlock');
    expect(generator).not.toContain('recordUnprecheckedSpend');
    // The denial branch logs and moves on.
    expect(generator).toContain("outcome.status === 'denied'");
  });

  it('EVERY BLOCK CYCLE USES A NEW ORDINAL', () => {
    const generator = code(GENERATOR);

    // PROBE D. A constant here would replay the first decision forever: the
    // plane would return the original receipt and write NO NEW BLOCK, and the
    // page would show one stale block while looking healthy.
    expect(generator).toContain('blockAttempts += 1');
    expect(generator).toMatch(/runtime\.spend\([\s\S]{0,120}blockAttempts,/);
  });

  it('bounds its cadence', () => {
    const generator = code(GENERATOR);

    // A typo must not turn the generator into a load test against the plane.
    expect(generator).toContain('MIN_BLOCK_INTERVAL_MS');
    expect(generator).not.toContain('while (true)');
  });

  it('DOES NOT UNREF THE WAIT THAT KEEPS IT ALIVE', () => {
    const generator = code(GENERATOR);

    // This guard used to assert the OPPOSITE, and was wrong.
    //
    // The generator's between-cycle wait was `unref`'d, on the reasoning that a
    // pending timer should not keep the process alive after a shutdown signal.
    // But `unref` means "do not count toward keeping Node running AT ALL", and
    // a waiting generator holds no other referenced handle - the HTTP requests
    // have completed and the policy poller is deliberately unref'd. So the
    // compiled binary exited 0 after ONE cycle, silently, looking like a clean
    // finish. A demo that stops producing blocks after twenty seconds is the
    // whole criterion failing quietly.
    //
    // Nothing in-process could see it: these tests inject an instant `sleep`
    // and a `maxCycles` bound. It took running the built artifact unbounded.
    expect(generator).not.toContain('unref');

    // The wait is the shared one, which resolves the instant the signal aborts
    // and removes its listener. Behaviour is pinned in simulator/tests/sleep.
    expect(generator).toContain("from './sleep.js'");
  });

  it('survives a transient failure and honours abort', () => {
    const generator = code(GENERATOR);

    expect(generator).toContain('catch (caught: unknown)');
    expect(generator).toContain('signal.aborted');
  });
});

describe('DEMO AND SHARE ARE SEPARATE AUTHORITIES', () => {
  it('the demo store never touches share state', () => {
    const store = code(DEMO_STORE);

    // Revoking a share must not disable the demo, and disabling the demo must
    // not revoke shares. Neither reads the other's table.
    for (const forbidden of ['shareTokens', 'ShareToken', 'tokenHash', 'hashShareToken']) {
      expect(store, forbidden).not.toContain(forbidden);
    }
  });

  it('the share store never touches demo state', () => {
    const shareStore = code(path.join(API_SRC, 'share', 'store.ts'));

    for (const forbidden of ['demoEnabled', 'demoSlug', 'DemoSettings']) {
      expect(shareStore, forbidden).not.toContain(forbidden);
    }
  });

  it('the demo flag is not stored as a share token', () => {
    const repository = code(DEMO_REPO);

    // The flag lives on `workspaces`, where it belongs.
    expect(repository).toContain('.update(workspaces)');
    expect(repository).not.toContain('shareTokens');
  });
});
