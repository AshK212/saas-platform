import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * SOURCE GUARDRAILS for read-only sharing (AC-18).
 *
 * A share token is an UNAUTHENTICATED DOOR into a tenant. The behavioural
 * suite proves the routes behave correctly today; these defend the properties
 * that would fail silently - where the page still renders, the request still
 * returns 200, and the damage is a credential that was stored in plaintext, a
 * viewer reading another tenant, or a revoked link that still works.
 *
 * Five things must stay true:
 *
 *   1. The plaintext token is never stored and never serialised.
 *   2. The workspace comes from the share ROW, never from caller input.
 *   3. Share authority cannot reach anything that writes.
 *   4. Management is operator-session-only; the public surface is token-only.
 *   5. No browser persistent storage ever holds share bearer material.
 *
 * Each is mutation-probed in the Step 21 report.
 */

const API_SRC = path.resolve(import.meta.dirname, '..', 'src');
const REPO_ROOT = path.resolve(API_SRC, '..', '..', '..');
const WEB_SRC = path.join(REPO_ROOT, 'apps', 'web', 'src');
const DB_SRC = path.join(REPO_ROOT, 'packages', 'db', 'src');

function read(file: string): string {
  return readFileSync(file, 'utf8');
}

/** Source with comments stripped, so prose about a pattern cannot trip it. */
function code(file: string): string {
  return read(file)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

const PUBLIC_ROUTES = path.join(API_SRC, 'routes', 'share-public.ts');
const MANAGEMENT_ROUTES = path.join(API_SRC, 'routes', 'share-management.ts');
const SHARE_STORE = path.join(API_SRC, 'share', 'store.ts');
const SHARE_TOKENS = path.join(API_SRC, 'share', 'tokens.ts');
const SHARE_COOKIE = path.join(API_SRC, 'share', 'cookie.ts');
const SHARE_REPO = path.join(DB_SRC, 'repositories', 'share-tokens.ts');
const SHARE_RESOLVER = path.join(DB_SRC, 'resolvers', 'share-tokens.ts');
const SHARE_SCHEMA = path.join(DB_SRC, 'schema', 'sharing.ts');

describe('THE PLAINTEXT TOKEN IS NEVER STORED', () => {
  it('the table has no column that could hold one', () => {
    const schema = code(SHARE_SCHEMA);

    // PROBE B. A digest and a non-secret prefix, and nothing else.
    expect(schema).toContain("tokenHash: text('token_hash')");
    expect(schema).toContain("tokenPrefix: text('token_prefix')");
    for (const forbidden of ['token:', 'plaintext', 'secret:', 'tokenValue']) {
      expect(schema, forbidden).not.toContain(forbidden);
    }
  });

  it('the repository row type has no token field', () => {
    const repository = code(SHARE_REPO);

    const rowType = repository.slice(
      repository.indexOf('export interface ShareTokenRow'),
      repository.indexOf('const SHARE_COLUMNS'),
    );
    expect(rowType).toContain('tokenPrefix');
    expect(rowType).not.toContain('tokenHash');
    expect(rowType).not.toMatch(/\btoken\s*:/);
  });

  it('NO PROJECTION SELECTS THE DIGEST', () => {
    const repository = code(SHARE_REPO);

    // The digest is a lookup key for the resolver, never data for a caller.
    const projection = repository.slice(
      repository.indexOf('const SHARE_COLUMNS'),
      repository.indexOf('export const shareTokenQueries'),
    );
    expect(projection).toContain('tokenPrefix');
    expect(projection).not.toContain('tokenHash');
  });

  it('the repository never receives a plaintext token', () => {
    const repository = code(SHARE_REPO);

    // `insert` takes an already-computed prefix and digest. The signature is
    // what makes a leak from this layer impossible, not a convention.
    const input = repository.slice(
      repository.indexOf('export interface InsertShareTokenInput'),
      repository.indexOf('export interface ShareTokenRepository'),
    );
    expect(input).toContain('tokenPrefix');
    expect(input).toContain('tokenHash');
    expect(input).not.toMatch(/readonly token\s*:/);
  });

  it('the digest is a one-way SHA-256 over the FULL token', () => {
    const tokens = code(SHARE_TOKENS);

    expect(tokens).toContain("createHash('sha256')");
    expect(tokens).toContain("randomBytes");
    // Never reversible, and never a weak source.
    for (const forbidden of ['createCipher', 'Math.random', 'Date.now']) {
      expect(tokens, forbidden).not.toContain(forbidden);
    }
  });

  it('the token carries at least 256 bits of secret', () => {
    const tokens = code(SHARE_TOKENS);

    expect(tokens).toContain('const SECRET_BYTES = 32');
    // The public half is INDEPENDENT material, so the stored prefix reveals
    // nothing about the secret.
    expect(tokens).toContain('const SHARE_ID_BYTES = 9');
    expect(tokens).toMatch(/randomBytes\(SHARE_ID_BYTES\)/);
    expect(tokens).toMatch(/randomBytes\(SECRET_BYTES\)/);
  });

  it('the plaintext leaves the store exactly once', () => {
    const store = code(SHARE_STORE);

    // `issue` is the only producer. Word-bounded, because
    // `generated.tokenPrefix` and `generated.tokenHash` are legitimate and
    // must not be counted as the secret.
    expect([...store.matchAll(/generated\.token\b/g)]).toHaveLength(1);
    expect(store).toContain('return { share, token: generated.token }');
  });

  it('only the issuance response carries a token', () => {
    const management = code(MANAGEMENT_ROUTES);

    // The list and revoke handlers use `shareLinkListResponseSchema`, which
    // has no token field. Only the created-response schema does.
    expect(management).toContain('shareLinkCreatedResponseSchema.parse');
    expect([...management.matchAll(/issued\.token/g)]).toHaveLength(1);
    expect(management).not.toContain('hashShareToken');
  });
});

describe('THE WORKSPACE COMES FROM THE SHARE ROW', () => {
  it('the resolver takes no workspace argument', () => {
    const resolver = code(SHARE_RESOLVER);

    // PROBE A. Its purpose is to DISCOVER the workspace, so accepting one
    // would be circular - and would let a caller choose which tenant to read.
    expect(resolver).toContain('createWorkspaceScope(row.workspaceId)');
    expect(resolver).not.toMatch(/workspaceId\s*:\s*string\s*[,)]/);
    expect(resolver).not.toMatch(/scope\s*:\s*WorkspaceScope\s*[,)]/);
  });

  it('the public routes read no workspace from the request', () => {
    const routes = code(PUBLIC_ROUTES);

    // No path segment, no query, no header, no body field.
    expect(routes).not.toMatch(/req\.param\(\s*['"]workspaceId/);
    expect(routes).not.toMatch(/req\.(?:header|query)\(\s*['"](?:x-)?workspace/i);
    expect(routes).not.toContain('workspace_id');
    // Every read is driven by the scope the resolver produced.
    expect(routes).toContain('gate.share.scope');
    expect([...routes.matchAll(/gate\.share\.scope/g)].length).toBeGreaterThanOrEqual(5);
  });

  it('THE TOKEN IS RE-RESOLVED ON EVERY REQUEST', () => {
    const routes = code(PUBLIC_ROUTES);

    // No cache, no memoisation, no decision carried between requests - which
    // is what makes revocation take effect on the very next read.
    expect(routes).toContain('shareResolverStore.resolve(token)');
    for (const cache of ['cache', 'memo', 'Map<', 'lastResolved']) {
      expect(routes, cache).not.toContain(cache);
    }
  });

  it('revocation is checked in the resolving statement itself', () => {
    const resolver = code(SHARE_RESOLVER);

    // PROBE E. In the WHERE clause, so a revoked token stops resolving the
    // moment the revocation commits.
    expect(resolver).toContain('isNull(shareTokens.revokedAt)');
    const where = resolver.slice(resolver.indexOf('.where('), resolver.indexOf('.limit('));
    expect(where).toContain('tokenPrefix');
    expect(where).toContain('tokenHash');
    expect(where).toContain('revokedAt');
  });

  it('revocation is a timestamp, never a delete', () => {
    const repository = code(SHARE_REPO);

    // A deleted row destroys the record that a link existed and was withdrawn.
    expect(repository).toContain('set({ revokedAt: at })');
    expect(repository).not.toContain('.delete(');
  });
});

describe('SHARE AUTHORITY CANNOT REACH ANYTHING THAT WRITES', () => {
  it('the public routes import no mutation store', () => {
    const routes = code(PUBLIC_ROUTES);

    // PROBE D. Each of these is one import away and none belongs here.
    for (const forbidden of [
      'PolicyMutationStore',
      'policy-mutation',
      'ApiKeyStore',
      'api-keys',
      'EventIngestStore',
      'events/store',
      'PrecheckStore',
      'precheck/store',
      'ShareManagementStore',
      'WorkspaceStore',
    ]) {
      expect(routes, forbidden).not.toContain(forbidden);
    }
  });

  it('the read-only context carries no user, role or permission', () => {
    const store = code(SHARE_STORE);

    const context = store.slice(
      store.indexOf('export interface ReadOnlyShareContext'),
      store.indexOf('export interface ShareResolverStore'),
    );
    expect(context).toContain('scope');
    // Nothing a future route could inspect to decide it may write.
    for (const forbidden of ['user', 'role', 'permission', 'canWrite', 'AuthenticatedUser']) {
      expect(context, forbidden).not.toContain(forbidden);
    }
  });

  it('it is NOT an AuthorizedWorkspace', () => {
    const store = code(SHARE_STORE);

    // That type carries a membership role. Manufacturing one would hand a
    // viewer a synthetic identity some later route might trust.
    const context = store.slice(
      store.indexOf('export interface ReadOnlyShareContext'),
      store.indexOf('export interface ShareResolverStore'),
    );
    expect(context).not.toContain('AuthorizedWorkspace');
  });

  it('every public read route is a GET, with one POST for the exchange', () => {
    const routes = code(PUBLIC_ROUTES);

    const posts = [...routes.matchAll(/routes\.post\(/g)];
    const gets = [...routes.matchAll(/routes\.get\(/g)];

    // The single POST carries the credential in its own body.
    expect(posts).toHaveLength(1);
    expect(routes).toContain('routes.post(SHARE_ACCESS_PATH');
    expect(gets.length).toBeGreaterThanOrEqual(5);
    for (const verb of ['put', 'patch', 'delete', 'all']) {
      expect(routes, verb).not.toContain(`routes.${verb}(`);
    }
  });

  it('the public routes never touch the ledger, policy or a receipt writer', () => {
    const routes = code(PUBLIC_ROUTES);

    for (const forbidden of [
      'lockDailyLedger',
      'commitSpend',
      'touchLastSeen',
      'createPolicyMutationRepository',
      'receiptRepo.insert',
      '.transaction(',
    ]) {
      expect(routes, forbidden).not.toContain(forbidden);
    }
  });
});

describe('MANAGEMENT IS SESSION-ONLY; THE PUBLIC SURFACE IS TOKEN-ONLY', () => {
  it('management consults the session and requires operator', () => {
    const management = code(MANAGEMENT_ROUTES);

    // PROBE C.
    expect(management).toContain('requireAuthenticatedUser');
    expect(management).toContain("authorized.workspace.role !== 'operator'");
    // Never a share token, never a bearer key.
    for (const forbidden of ['shareResolverStore', 'readShareCookie', 'Bearer', 'apiKeyStore']) {
      expect(management, forbidden).not.toContain(forbidden);
    }
  });

  it('the public surface never consults a session', () => {
    const routes = code(PUBLIC_ROUTES);

    for (const forbidden of [
      'requireAuthenticatedUser',
      'authService',
      'AUTH_COOKIE_NAME',
      'readAuthCookie',
      'workspaceStore.authorize',
    ]) {
      expect(routes, forbidden).not.toContain(forbidden);
    }
    expect(routes).toContain('readShareCookie');
  });

  it('the share cookie is HttpOnly and path-scoped away from operator routes', () => {
    const cookie = code(SHARE_COOKIE);

    expect(cookie).toContain('httpOnly: true');
    expect(cookie).toContain("SHARE_COOKIE_PATH = '/v1/share'");
    expect(cookie).toContain('path: SHARE_COOKIE_PATH');
    // A distinct name, so it can never be confused with the session cookie.
    expect(cookie).toContain("SHARE_COOKIE_NAME = 'hybrid_share_view'");
    expect(cookie).not.toContain('hybrid_auth_session');
  });

  it('THE COOKIE HOLDS THE TOKEN, NOT A DERIVED SESSION', () => {
    const cookie = code(SHARE_COOKIE);
    const routes = code(PUBLIC_ROUTES);

    // A signed session carrying a share id would be a SECOND credential that
    // could outlive the first - a viewer still reading after revocation.
    for (const forbidden of ['sign(', 'jwt', 'hmac', 'shareTokenId', 'expiresAt']) {
      expect(cookie, forbidden).not.toContain(forbidden);
    }
    // The value written is the token the caller presented, unchanged.
    expect(routes).toContain('writeShareCookie(c, parsed.data.token');
  });

  it('every public failure is the same body and status', () => {
    const routes = code(PUBLIC_ROUTES);

    // Unknown, malformed, revoked and cross-tenant are indistinguishable.
    expect(routes).toContain("INVALID_SHARE_BODY = { error: 'invalid_share' }");
    expect(routes).not.toContain('revoked');
    expect(routes).not.toContain("error: 'not_found'");
    // Never 403: it would confirm something exists.
    expect(routes).not.toContain('403');
  });
});

describe('NO BROWSER PERSISTENT STORAGE HOLDS SHARE MATERIAL', () => {
  const webFiles = ['SharedView.tsx', 'ShareLinks.tsx', 'api.ts', 'App.tsx'];

  it.each(webFiles)('%s uses no localStorage, sessionStorage or IndexedDB', (file) => {
    const source = code(path.join(WEB_SRC, file));

    // All readable by any script on the page, which is precisely why the
    // credential lives in an HttpOnly cookie instead.
    for (const forbidden of ['localStorage', 'sessionStorage', 'indexedDB', 'document.cookie']) {
      expect(source, forbidden).not.toContain(forbidden);
    }
  });

  it('the shared view strips the token from the address bar', () => {
    const view = code(path.join(WEB_SRC, 'SharedView.tsx'));

    // So a screenshot, a shoulder-surfer or a copied URL does not carry it.
    expect(view).toContain("window.history.replaceState({}, '', '/share')");
  });

  it('the shared view sends the token exactly once', () => {
    const view = code(path.join(WEB_SRC, 'SharedView.tsx'));

    // Exactly one call site. The import lists `openShare,` with no paren.
    expect([...view.matchAll(/openShare\(/g)]).toHaveLength(1);
    // And the token is never threaded into a later read.
    expect(view).not.toMatch(/fetchShared\w+\([^)]*token/);
  });

  it('the API client posts the token in a BODY, never a query string', () => {
    const api = code(path.join(WEB_SRC, 'api.ts'));

    const openShare = api.slice(
      api.indexOf('export async function openShare('),
      api.indexOf('export async function fetchSharedAgents('),
    );
    expect(openShare).toContain('body: JSON.stringify({ token })');
    // A query string would land in access logs, history and Referer.
    expect(openShare).not.toContain('?token=');
    expect(openShare).not.toContain('searchParams');
  });
});

describe('the live transcription has not drifted', () => {
  /**
   * `packages/db` cannot import from `apps/`, so its live suite transcribes
   * the token format. That suite is the only place the "no plaintext on disk"
   * and cross-tenant claims are checked against a real database, so a drift
   * would silently remove the strongest evidence for both.
   */
  const liveRaw = read(path.join(DB_SRC, '..', 'tests', 'sharing.live.test.ts'));
  const live = liveRaw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  it('the transcription exists and names its source', () => {
    expect(live).toContain('function hashToken(');
    expect(liveRaw).toContain('apps/api/src/share/tokens.ts');
  });

  it('it hashes the same way production does', () => {
    expect(live).toContain("createHash('sha256').update(token, 'utf8').digest('hex')");
    expect(code(SHARE_TOKENS)).toContain(
      "createHash('sha256').update(token, 'utf8').digest('hex')",
    );
  });

  it('it uses the same namespace and entropy', () => {
    expect(live).toContain("SHARE_NAMESPACE = 'hmp_share'");
    expect(live).toContain('randomBytes(9)');
    expect(live).toContain('randomBytes(32)');
    expect(code(SHARE_TOKENS)).toContain("SHARE_NAMESPACE = 'hmp_share'");
  });

  it('it gates on TEST_DATABASE_URL and never falls back', () => {
    expect(live).toContain("process.env['TEST_DATABASE_URL']");
    expect(live).not.toContain("process.env['DATABASE_URL']");
    expect(live).toContain('describe.skipIf(!hasTestDatabase)');
  });
});

describe('THE SHARED PAGE RENDERS NO EDIT CONTROLS', () => {
  const view = read(path.join(WEB_SRC, 'SharedView.tsx'));

  it.each([
    'Save policy',
    'Create key',
    'Revoke',
    'Create share',
    'API Keys',
    'Sign out',
    'Pause',
    'Unpause',
  ])('does not render %s', (label) => {
    // Read-only means the UI is absent, not merely disabled - and the server
    // refuses these regardless.
    expect(view).not.toContain(label);
  });

  it('imports no management or mutation client function', () => {
    const source = code(path.join(WEB_SRC, 'SharedView.tsx'));

    for (const forbidden of [
      'createShareLink',
      'revokeShareLink',
      'createApiKey',
      'savePolicy',
      'updatePolicy',
      'createWorkspace',
      'logout',
    ]) {
      expect(source, forbidden).not.toContain(forbidden);
    }
  });

  it('renders only share read functions', () => {
    const source = code(path.join(WEB_SRC, 'SharedView.tsx'));

    for (const allowed of [
      'openShare',
      'fetchSharedAgents',
      'fetchSharedEvents',
      'fetchSharedEvent',
      'fetchSharedReceipts',
      'fetchSharedBlocks',
    ]) {
      expect(source, allowed).toContain(allowed);
    }
  });

  it('says plainly that it is read-only', () => {
    expect(view).toContain('Read-only shared view');
  });

  it('NO dangerouslySetInnerHTML', () => {
    for (const file of ['SharedView.tsx', 'ShareLinks.tsx']) {
      expect(code(path.join(WEB_SRC, file))).not.toContain('dangerouslySetInnerHTML');
    }
  });

  it('the operator panel builds the public URL only from the fresh plaintext', () => {
    const panel = code(path.join(WEB_SRC, 'ShareLinks.tsx'));

    // Reconstructing it from the list would imply the secret is recoverable.
    expect(panel).toContain('created.token');
    // `link.tokenPrefix` is public and IS displayed, so this checks that no
    // SECRET is read off a listed row - not that the prefix is hidden.
    expect(panel).not.toMatch(/link\.token\b/);
    expect(panel).not.toContain('link.tokenHash');
    expect(panel).toContain('setIssuedUrl(null)');
  });
});
