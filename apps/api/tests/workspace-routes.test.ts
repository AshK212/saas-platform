import {
  AUTH_CALLBACK_PATH,
  AUTH_MAGIC_LINK_PATH,
  workspaceListResponseSchema,
  workspacePath,
  workspaceResponseSchema,
  WORKSPACES_PATH,
} from '@hybrid/contracts';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { createFixedClock } from '../src/auth/clock';
import { AUTH_COOKIE_NAME } from '../src/auth/cookie';
import { createCapturingEmailSender, type CapturingEmailSender } from '../src/auth/email';
import { createAuthService, type AuthService } from '../src/auth/service';
import { createMemoryAuthStore, type MemoryAuthStore } from './helpers/memory-auth-store';
import {
  createMemoryWorkspaceStore,
  type MemoryWorkspaceStore,
} from './helpers/memory-workspace-store';

const APP_URL = 'https://app.example.test';
const EVIL_ORIGIN = 'https://attacker.example';
const START = new Date('2026-08-12T10:00:00.000Z');

let authStore: MemoryAuthStore;
let mailer: CapturingEmailSender;
let clock: ReturnType<typeof createFixedClock>;
let service: AuthService;
let db: MemoryWorkspaceStore;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  authStore = createMemoryAuthStore();
  mailer = createCapturingEmailSender();
  clock = createFixedClock(START);
  service = createAuthService({
    store: authStore,
    mailer,
    clock,
    appUrl: APP_URL,
    callbackPath: AUTH_CALLBACK_PATH,
  });
  db = createMemoryWorkspaceStore();
  app = createApp({
    probeDatabase: () => Promise.resolve('ok'),
    authService: service,
    appUrl: APP_URL,
    secureCookies: true,
    workspaceStore: db,
  });
});

/** Signs a user in and returns their cookie header value plus user id. */
async function signIn(email: string): Promise<{ cookie: string; userId: string }> {
  await app.request(AUTH_MAGIC_LINK_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  const token = new URL(mailer.lastLink()?.url ?? '').searchParams.get('token') ?? '';
  const callback = await app.request(`${AUTH_CALLBACK_PATH}?token=${token}`);
  const raw = callback.headers.get('set-cookie') ?? '';
  const value = raw.split(';')[0]?.split('=')[1] ?? '';
  const userId = authStore.users.get(email)?.id ?? '';
  return { cookie: `${AUTH_COOKIE_NAME}=${value}`, userId };
}

async function createWorkspace(cookie: string, name: string, origin = APP_URL): Promise<Response> {
  return app.request(WORKSPACES_PATH, {
    method: 'POST',
    headers: { cookie, origin, 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}

describe('POST /v1/workspaces', () => {
  it('rejects an unauthenticated request', async () => {
    const response = await app.request(WORKSPACES_PATH, {
      method: 'POST',
      headers: { origin: APP_URL, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Acme' }),
    });

    expect(response.status).toBe(401);
    expect(db.workspaces).toHaveLength(0);
  });

  it('creates a workspace for an authenticated user', async () => {
    const { cookie } = await signIn('owner@example.test');

    const response = await createWorkspace(cookie, 'Ashir AI Lab');

    expect(response.status).toBe(201);
    const body: unknown = await response.json();
    expect(workspaceResponseSchema.safeParse(body).success).toBe(true);
    expect((body as { workspace: { name: string } }).workspace.name).toBe('Ashir AI Lab');
  });

  it('makes the creator an operator member atomically', async () => {
    const { cookie, userId } = await signIn('owner@example.test');

    const response = await createWorkspace(cookie, 'Acme');
    const body = (await response.json()) as { workspace: { id: string; role: string } };

    expect(body.workspace.role).toBe('operator');
    expect(db.memberships).toEqual([
      { workspaceId: body.workspace.id, userId, role: 'operator' },
    ]);
  });

  it('leaves no orphaned workspace when the membership insert fails', async () => {
    const { cookie } = await signIn('owner@example.test');
    db.failMembershipInsert = true;

    const response = await createWorkspace(cookie, 'Doomed');

    expect(response.status).toBe(500);
    // The failure must be opaque - no SQL, no table names, no driver text.
    expect(await response.json()).toEqual({ error: 'internal_error' });

    // A workspace without its creator membership would be permanently
    // unreachable - nobody could authorize into it.
    expect(db.workspaces).toHaveLength(0);
    expect(db.memberships).toHaveLength(0);
  });

  it('does not leak internal detail when the data layer fails', async () => {
    const { cookie } = await signIn('owner@example.test');
    db.failMembershipInsert = true;

    const raw = await (await createWorkspace(cookie, 'Doomed')).text();

    expect(raw).not.toContain('membership insert failed');
    expect(raw).not.toContain('insert');
    expect(raw).not.toMatch(/workspace_memberships|drizzle|postgres/i);
  });

  it('never creates a publicly visible workspace', async () => {
    const { cookie } = await signIn('owner@example.test');

    await createWorkspace(cookie, 'Acme');

    expect(db.workspaces[0]?.demoEnabled).toBe(false);
    expect(db.workspaces[0]?.demoSlug).toBeNull();
  });

  it('does not return demo or internal fields', async () => {
    const { cookie } = await signIn('owner@example.test');

    const body = (await (await createWorkspace(cookie, 'Acme')).json()) as {
      workspace: Record<string, unknown>;
    };

    expect(Object.keys(body.workspace).sort()).toEqual(['id', 'name', 'role']);
  });

  it.each([
    ['missing name', {}],
    ['empty name', { name: '' }],
    ['whitespace-only name', { name: '   ' }],
    ['over-long name', { name: 'x'.repeat(121) }],
    ['wrong type', { name: 42 }],
  ])('rejects %s', async (_label, body) => {
    const { cookie } = await signIn('owner@example.test');

    const response = await app.request(WORKSPACES_PATH, {
      method: 'POST',
      headers: { cookie, origin: APP_URL, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(400);
    expect(db.workspaces).toHaveLength(0);
  });

  it('accepts international and punctuated names', async () => {
    const { cookie } = await signIn('owner@example.test');

    // Real customer names carry punctuation, accents and non-Latin scripts; a
    // restrictive character allowlist would reject legitimate workspaces.
    const response = await createWorkspace(cookie, "Ashir's Lab — 東京 (R&D) Café");

    expect(response.status).toBe(201);
  });

  it('trims surrounding whitespace from the name', async () => {
    const { cookie } = await signIn('owner@example.test');

    const body = (await (await createWorkspace(cookie, '  Acme  ')).json()) as {
      workspace: { name: string };
    };

    expect(body.workspace.name).toBe('Acme');
  });
});

describe('GET /v1/workspaces', () => {
  it('rejects an unauthenticated request', async () => {
    expect((await app.request(WORKSPACES_PATH)).status).toBe(401);
  });

  it('returns an empty list for a user with no memberships', async () => {
    const { cookie } = await signIn('newcomer@example.test');

    const response = await app.request(WORKSPACES_PATH, { headers: { cookie } });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ workspaces: [] });
  });

  it('returns only the caller memberships, never another tenant', async () => {
    const alice = await signIn('alice@example.test');
    const bob = await signIn('bob@example.test');

    db.seedWorkspace('Workspace A', [{ userId: alice.userId }]);
    db.seedWorkspace('Workspace B', [{ userId: bob.userId }]);
    db.seedWorkspace('Workspace C', [{ userId: alice.userId }]);

    const response = await app.request(WORKSPACES_PATH, { headers: { cookie: alice.cookie } });
    const body = (await response.json()) as { workspaces: { name: string }[] };

    expect(body.workspaces.map((w) => w.name)).toEqual(['Workspace A', 'Workspace C']);
    expect(workspaceListResponseSchema.safeParse(body).success).toBe(true);
  });

  it('MULTI-WORKSPACE: one user sees both of their workspaces', async () => {
    const user = await signIn('multi@example.test');
    db.seedWorkspace('Alpha', [{ userId: user.userId }]);
    db.seedWorkspace('Beta', [{ userId: user.userId, role: 'member' }]);

    const body = (await (
      await app.request(WORKSPACES_PATH, { headers: { cookie: user.cookie } })
    ).json()) as { workspaces: { name: string; role: string }[] };

    expect(body.workspaces).toHaveLength(2);
    expect(body.workspaces.map((w) => w.role).sort()).toEqual(['member', 'operator']);
  });
});

describe('GET /v1/workspaces/:workspaceId', () => {
  it('rejects an unauthenticated request', async () => {
    const id = db.seedWorkspace('Acme', [{ userId: 'someone' }]);

    expect((await app.request(workspacePath(id))).status).toBe(401);
  });

  it('returns the workspace to a member', async () => {
    const user = await signIn('member@example.test');
    const id = db.seedWorkspace('Acme', [{ userId: user.userId }]);

    const response = await app.request(workspacePath(id), { headers: { cookie: user.cookie } });

    expect(response.status).toBe(200);
    expect((await response.json()) as unknown).toEqual({
      workspace: { id, name: 'Acme', role: 'operator' },
    });
  });

  it('CROSS-TENANT: returns 404 for a workspace the caller does not belong to', async () => {
    const alice = await signIn('alice@example.test');
    const bob = await signIn('bob@example.test');
    const bobsWorkspace = db.seedWorkspace('Bob Workspace', [{ userId: bob.userId }]);

    const response = await app.request(workspacePath(bobsWorkspace), {
      headers: { cookie: alice.cookie },
    });

    // 404, not 403: a 403 would confirm the workspace exists, turning this into
    // an oracle for enumerating other tenants' ids.
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'not_found' });
  });

  it('gives an identical answer for a foreign workspace and a nonexistent one', async () => {
    const alice = await signIn('alice@example.test');
    const bob = await signIn('bob@example.test');
    const bobsWorkspace = db.seedWorkspace('Bob Workspace', [{ userId: bob.userId }]);

    const foreign = await app.request(workspacePath(bobsWorkspace), {
      headers: { cookie: alice.cookie },
    });
    const missing = await app.request(workspacePath('11111111-1111-4111-8111-111111111111'), {
      headers: { cookie: alice.cookie },
    });

    expect(foreign.status).toBe(missing.status);
    expect(await foreign.text()).toBe(await missing.text());
  });

  it('possessing the UUID is not authorization', async () => {
    const alice = await signIn('alice@example.test');
    const bob = await signIn('bob@example.test');
    const bobsWorkspace = db.seedWorkspace('Bob Workspace', [{ userId: bob.userId }]);

    // Alice knows the exact id and still cannot reach it.
    const response = await app.request(workspacePath(bobsWorkspace), {
      headers: { cookie: alice.cookie },
    });

    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('Bob Workspace');
  });

  it.each([
    ['a malformed id', 'not-a-uuid'],
    ['a sql fragment', "' OR 1=1 --"],
    ['an empty segment', '%20'],
  ])('returns 404 for %s rather than an error', async (_label, id) => {
    const user = await signIn('user@example.test');

    const response = await app.request(`${WORKSPACES_PATH}/${id}`, {
      headers: { cookie: user.cookie },
    });

    expect(response.status).toBe(404);
  });

  it('MULTI-WORKSPACE: authorizes each membership independently', async () => {
    const user = await signIn('multi@example.test');
    const alpha = db.seedWorkspace('Alpha', [{ userId: user.userId }]);
    const beta = db.seedWorkspace('Beta', [{ userId: user.userId, role: 'member' }]);

    const a = await app.request(workspacePath(alpha), { headers: { cookie: user.cookie } });
    const b = await app.request(workspacePath(beta), { headers: { cookie: user.cookie } });

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(((await a.json()) as { workspace: { role: string } }).workspace.role).toBe('operator');
    expect(((await b.json()) as { workspace: { role: string } }).workspace.role).toBe('member');
  });
});

describe('CSRF origin protection', () => {
  it('rejects a workspace creation from a foreign origin', async () => {
    const { cookie } = await signIn('victim@example.test');

    const response = await createWorkspace(cookie, 'Attacker Workspace', EVIL_ORIGIN);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'forbidden_origin' });
    // The victim's cookie must not have created anything.
    expect(db.workspaces).toHaveLength(0);
  });

  it('accepts the configured application origin', async () => {
    const { cookie } = await signIn('owner@example.test');

    expect((await createWorkspace(cookie, 'Acme', APP_URL)).status).toBe(201);
  });

  it('rejects a cookie-authenticated mutation with no Origin header', async () => {
    const { cookie } = await signIn('owner@example.test');

    const response = await app.request(WORKSPACES_PATH, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Acme' }),
    });

    expect(response.status).toBe(403);
    expect(db.workspaces).toHaveLength(0);
  });

  it('does not leak the allowlist in the rejection', async () => {
    const { cookie } = await signIn('owner@example.test');

    const raw = await (await createWorkspace(cookie, 'X', EVIL_ORIGIN)).text();

    expect(raw).not.toContain(APP_URL);
    expect(raw).not.toContain(EVIL_ORIGIN);
  });

  it('does not block safe GET requests', async () => {
    const { cookie } = await signIn('owner@example.test');

    // No Origin on a read is normal and must not be rejected.
    expect((await app.request(WORKSPACES_PATH, { headers: { cookie } })).status).toBe(200);
  });

  it('leaves /healthz reachable without an Origin', async () => {
    expect((await app.request('/healthz')).status).toBe(200);
  });

  it('rejects a scheme downgrade of the allowed origin', async () => {
    const { cookie } = await signIn('owner@example.test');

    const response = await createWorkspace(cookie, 'X', 'http://app.example.test');

    expect(response.status).toBe(403);
  });

  it('rejects a subdomain of the allowed origin', async () => {
    const { cookie } = await signIn('owner@example.test');

    // SameSite=Lax is site-scoped and would permit this; the origin check is
    // origin-scoped and does not.
    const response = await createWorkspace(cookie, 'X', 'https://evil.app.example.test');

    expect(response.status).toBe(403);
  });
});

describe('workspaces unavailable without a database', () => {
  it('reports 503 rather than crashing', async () => {
    const noDb = createApp({
      probeDatabase: () => Promise.resolve('unconfigured'),
      authService: service,
      appUrl: APP_URL,
    });

    expect((await noDb.request(WORKSPACES_PATH)).status).toBe(503);
  });

  it('keeps /healthz at 200', async () => {
    const noDb = createApp({ probeDatabase: () => Promise.resolve('unconfigured') });

    expect((await noDb.request('/healthz')).status).toBe(200);
  });
});

describe('identity and tenancy stay separate', () => {
  it('/v1/auth/me still returns identity only, with no workspace', async () => {
    const user = await signIn('user@example.test');
    db.seedWorkspace('Acme', [{ userId: user.userId }]);

    const response = await app.request('/v1/auth/me', { headers: { cookie: user.cookie } });
    const body = (await response.json()) as { user: Record<string, unknown> };

    expect(Object.keys(body)).toEqual(['user']);
    expect(Object.keys(body.user).sort()).toEqual(['email', 'id']);
  });
});
