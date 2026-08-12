import {
  API_KEY_IDENTITY_PATH,
  AUTH_CALLBACK_PATH,
  AUTH_MAGIC_LINK_PATH,
  apiKeyListResponseSchema,
  createApiKeyResponseSchema,
  revokeApiKeyPath,
  workspaceApiKeysPath,
} from '@hybrid/contracts';
import { beforeEach, describe, expect, it } from 'vitest';

import { API_KEY_PREFIX_LENGTH } from '../src/api-keys/tokens';
import { createApp } from '../src/app';
import { createFixedClock } from '../src/auth/clock';
import { AUTH_COOKIE_NAME } from '../src/auth/cookie';
import { createCapturingEmailSender, type CapturingEmailSender } from '../src/auth/email';
import { createAuthService, type AuthService } from '../src/auth/service';
import { createMemoryApiKeyStore, type MemoryApiKeyStore } from './helpers/memory-api-key-store';
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
let workspaces: MemoryWorkspaceStore;
let apiKeys: MemoryApiKeyStore;
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
  workspaces = createMemoryWorkspaceStore();
  apiKeys = createMemoryApiKeyStore();
  app = createApp({
    probeDatabase: () => Promise.resolve('ok'),
    authService: service,
    appUrl: APP_URL,
    secureCookies: true,
    workspaceStore: workspaces,
    apiKeyStore: apiKeys,
    clock,
  });
});

async function signIn(email: string): Promise<{ cookie: string; userId: string }> {
  await app.request(AUTH_MAGIC_LINK_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  const token = new URL(mailer.lastLink()?.url ?? '').searchParams.get('token') ?? '';
  const callback = await app.request(`${AUTH_CALLBACK_PATH}?token=${token}`);
  const value = (callback.headers.get('set-cookie') ?? '').split(';')[0]?.split('=')[1] ?? '';
  return { cookie: `${AUTH_COOKIE_NAME}=${value}`, userId: authStore.users.get(email)?.id ?? '' };
}

async function issue(
  cookie: string,
  workspaceId: string,
  name = 'Simulator',
  origin = APP_URL,
): Promise<Response> {
  return app.request(workspaceApiKeysPath(workspaceId), {
    method: 'POST',
    headers: { cookie, origin, 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}

describe('POST issue API key', () => {
  it('rejects an unauthenticated caller', async () => {
    const ws = workspaces.seedWorkspace('Acme', [{ userId: 'someone' }]);

    const response = await app.request(workspaceApiKeysPath(ws), {
      method: 'POST',
      headers: { origin: APP_URL, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'X' }),
    });

    expect(response.status).toBe(401);
    expect(apiKeys.credentials).toHaveLength(0);
  });

  it('issues a key for an operator and returns plaintext exactly once', async () => {
    const user = await signIn('op@example.test');
    const ws = workspaces.seedWorkspace('Acme', [{ userId: user.userId, role: 'operator' }]);

    const response = await issue(user.cookie, ws, 'Production Agent');

    expect(response.status).toBe(201);
    const body: unknown = await response.json();
    expect(createApiKeyResponseSchema.safeParse(body).success).toBe(true);

    const { apiKey } = body as { apiKey: { key: string; keyPrefix: string; status: string } };
    expect(apiKey.key.startsWith('hmp_live_')).toBe(true);
    expect(apiKey.status).toBe('active');
    expect(apiKey.key.startsWith(`${apiKey.keyPrefix}_`)).toBe(true);
  });

  it('SHOW-ONCE: persistence holds the hash, never the plaintext', async () => {
    const user = await signIn('op@example.test');
    const ws = workspaces.seedWorkspace('Acme', [{ userId: user.userId }]);

    const { apiKey } = (await (await issue(user.cookie, ws)).json()) as {
      apiKey: { key: string };
    };

    // Scan everything ever written to the store.
    const secret = apiKey.key.slice(API_KEY_PREFIX_LENGTH + 1);
    expect(secret).not.toBe('');
    expect(apiKeys.persistedBlob()).not.toContain(apiKey.key);
    expect(apiKeys.persistedBlob()).not.toContain(secret);
    expect(apiKeys.credentials[0]?.secretHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('SHOW-ONCE: the key is unrecoverable from the list afterwards', async () => {
    const user = await signIn('op@example.test');
    const ws = workspaces.seedWorkspace('Acme', [{ userId: user.userId }]);
    const { apiKey } = (await (await issue(user.cookie, ws)).json()) as { apiKey: { key: string } };

    const listRaw = await (
      await app.request(workspaceApiKeysPath(ws), { headers: { cookie: user.cookie } })
    ).text();

    expect(listRaw).not.toContain(apiKey.key);
    expect(listRaw).not.toContain('key"');
    expect(listRaw).not.toContain('secretHash');
    expect(listRaw).not.toMatch(/[0-9a-f]{64}/);
  });

  it('has no retrieval endpoint that could return the key', async () => {
    const user = await signIn('op@example.test');
    const ws = workspaces.seedWorkspace('Acme', [{ userId: user.userId }]);
    const { apiKey } = (await (await issue(user.cookie, ws)).json()) as {
      apiKey: { id: string; key: string };
    };

    // The obvious guess for a detail route must not exist.
    const detail = await app.request(`${workspaceApiKeysPath(ws)}/${apiKey.id}`, {
      headers: { cookie: user.cookie },
    });

    expect(detail.status).toBe(404);
  });

  it('rejects a member without the operator role', async () => {
    const user = await signIn('member@example.test');
    const ws = workspaces.seedWorkspace('Acme', [{ userId: user.userId, role: 'member' }]);

    const response = await issue(user.cookie, ws);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'insufficient_role' });
    expect(apiKeys.credentials).toHaveLength(0);
  });

  it('rejects a foreign workspace with 404, not 403', async () => {
    const alice = await signIn('alice@example.test');
    const bob = await signIn('bob@example.test');
    const bobsWs = workspaces.seedWorkspace('Bob Corp', [{ userId: bob.userId }]);

    const response = await issue(alice.cookie, bobsWs);

    // 403 would confirm the workspace exists.
    expect(response.status).toBe(404);
    expect(apiKeys.credentials).toHaveLength(0);
  });

  it.each([
    ['missing name', {}],
    ['empty name', { name: '' }],
    ['whitespace name', { name: '   ' }],
    ['over-long name', { name: 'x'.repeat(121) }],
    ['wrong type', { name: 7 }],
  ])('rejects %s', async (_label, body) => {
    const user = await signIn('op@example.test');
    const ws = workspaces.seedWorkspace('Acme', [{ userId: user.userId }]);

    const response = await app.request(workspaceApiKeysPath(ws), {
      method: 'POST',
      headers: { cookie: user.cookie, origin: APP_URL, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(400);
    expect(apiKeys.credentials).toHaveLength(0);
  });

  it('CSRF: rejects issuance from a foreign origin', async () => {
    const user = await signIn('victim@example.test');
    const ws = workspaces.seedWorkspace('Acme', [{ userId: user.userId }]);

    const response = await issue(user.cookie, ws, 'Attacker Key', EVIL_ORIGIN);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'forbidden_origin' });
    expect(apiKeys.credentials).toHaveLength(0);
  });

  it('CSRF: rejects issuance with a cookie and no Origin', async () => {
    const user = await signIn('victim@example.test');
    const ws = workspaces.seedWorkspace('Acme', [{ userId: user.userId }]);

    const response = await app.request(workspaceApiKeysPath(ws), {
      method: 'POST',
      headers: { cookie: user.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'X' }),
    });

    expect(response.status).toBe(403);
    expect(apiKeys.credentials).toHaveLength(0);
  });

  it('binds the key to the authorized workspace, not to anything in the body', async () => {
    const alice = await signIn('alice@example.test');
    const bob = await signIn('bob@example.test');
    const aliceWs = workspaces.seedWorkspace('Alice Co', [{ userId: alice.userId }]);
    const bobWs = workspaces.seedWorkspace('Bob Co', [{ userId: bob.userId }]);

    await app.request(workspaceApiKeysPath(aliceWs), {
      method: 'POST',
      headers: { cookie: alice.cookie, origin: APP_URL, 'content-type': 'application/json' },
      // A hostile extra field must be ignored entirely.
      body: JSON.stringify({ name: 'Sneaky', workspace_id: bobWs, workspaceId: bobWs }),
    });

    expect(apiKeys.credentials[0]?.workspaceId).toBe(aliceWs);
  });
});

describe('GET list API keys', () => {
  it('rejects an unauthenticated caller', async () => {
    const ws = workspaces.seedWorkspace('Acme', [{ userId: 'x' }]);

    expect((await app.request(workspaceApiKeysPath(ws))).status).toBe(401);
  });

  it('returns safe metadata only', async () => {
    const user = await signIn('op@example.test');
    const ws = workspaces.seedWorkspace('Acme', [{ userId: user.userId }]);
    await issue(user.cookie, ws, 'Simulator');

    const response = await app.request(workspaceApiKeysPath(ws), {
      headers: { cookie: user.cookie },
    });
    const body = (await response.json()) as { apiKeys: Record<string, unknown>[] };

    expect(apiKeyListResponseSchema.safeParse(body).success).toBe(true);
    expect(Object.keys(body.apiKeys[0] ?? {}).sort()).toEqual([
      'createdAt',
      'id',
      'keyPrefix',
      'lastUsedAt',
      'name',
      'revokedAt',
      'status',
    ]);
  });

  it('rejects a member', async () => {
    const user = await signIn('member@example.test');
    const ws = workspaces.seedWorkspace('Acme', [{ userId: user.userId, role: 'member' }]);

    expect((await app.request(workspaceApiKeysPath(ws), { headers: { cookie: user.cookie } })).status).toBe(403);
  });

  it('CROSS-TENANT: cannot list another workspace keys', async () => {
    const alice = await signIn('alice@example.test');
    const bob = await signIn('bob@example.test');
    const bobWs = workspaces.seedWorkspace('Bob Co', [{ userId: bob.userId }]);
    await issue(bob.cookie, bobWs, 'Bob Key');

    const response = await app.request(workspaceApiKeysPath(bobWs), {
      headers: { cookie: alice.cookie },
    });

    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('Bob Key');
  });
});

describe('POST revoke API key', () => {
  async function setup(): Promise<{ cookie: string; ws: string; id: string; key: string }> {
    const user = await signIn('op@example.test');
    const ws = workspaces.seedWorkspace('Acme', [{ userId: user.userId }]);
    const { apiKey } = (await (await issue(user.cookie, ws)).json()) as {
      apiKey: { id: string; key: string };
    };
    return { cookie: user.cookie, ws, id: apiKey.id, key: apiKey.key };
  }

  it('revokes an operator own workspace credential', async () => {
    const { cookie, ws, id } = await setup();

    const response = await app.request(revokeApiKeyPath(ws, id), {
      method: 'POST',
      headers: { cookie, origin: APP_URL },
    });

    expect(response.status).toBe(200);
    expect(((await response.json()) as { apiKey: { status: string } }).apiKey.status).toBe('revoked');
  });

  it('makes the key fail API authentication immediately', async () => {
    const { cookie, ws, id, key } = await setup();

    const before = await app.request(API_KEY_IDENTITY_PATH, {
      headers: { authorization: `Bearer ${key}` },
    });
    expect(before.status).toBe(200);

    await app.request(revokeApiKeyPath(ws, id), {
      method: 'POST',
      headers: { cookie, origin: APP_URL },
    });

    const after = await app.request(API_KEY_IDENTITY_PATH, {
      headers: { authorization: `Bearer ${key}` },
    });
    expect(after.status).toBe(401);
  });

  it('is idempotent and preserves the original timestamp', async () => {
    const { cookie, ws, id } = await setup();
    const headers = { cookie, origin: APP_URL };

    const first = await app.request(revokeApiKeyPath(ws, id), { method: 'POST', headers });
    clock.advance(60_000);
    const second = await app.request(revokeApiKeyPath(ws, id), { method: 'POST', headers });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const a = (await first.json()) as { apiKey: { revokedAt: string } };
    const b = (await second.json()) as { apiKey: { revokedAt: string } };
    expect(b.apiKey.revokedAt).toBe(a.apiKey.revokedAt);
  });

  it('retains the credential row for audit', async () => {
    const { cookie, ws, id } = await setup();

    await app.request(revokeApiKeyPath(ws, id), { method: 'POST', headers: { cookie, origin: APP_URL } });

    expect(apiKeys.credentials).toHaveLength(1);
    expect(apiKeys.credentials[0]?.revokedAt).not.toBeNull();
  });

  it('rejects a member', async () => {
    const { ws, id } = await setup();
    const member = await signIn('member@example.test');
    workspaces.memberships.push({ workspaceId: ws, userId: member.userId, role: 'member' });

    const response = await app.request(revokeApiKeyPath(ws, id), {
      method: 'POST',
      headers: { cookie: member.cookie, origin: APP_URL },
    });

    expect(response.status).toBe(403);
    expect(apiKeys.credentials[0]?.revokedAt).toBeNull();
  });

  it('CROSS-TENANT: cannot revoke another workspace credential', async () => {
    const { ws, id } = await setup();
    const mallory = await signIn('mallory@example.test');
    workspaces.seedWorkspace('Mallory Co', [{ userId: mallory.userId }]);

    const response = await app.request(revokeApiKeyPath(ws, id), {
      method: 'POST',
      headers: { cookie: mallory.cookie, origin: APP_URL },
    });

    expect(response.status).toBe(404);
    expect(apiKeys.credentials[0]?.revokedAt).toBeNull();
  });

  it('CSRF: rejects revocation from a foreign origin', async () => {
    const { cookie, ws, id } = await setup();

    const response = await app.request(revokeApiKeyPath(ws, id), {
      method: 'POST',
      headers: { cookie, origin: EVIL_ORIGIN },
    });

    expect(response.status).toBe(403);
    expect(apiKeys.credentials[0]?.revokedAt).toBeNull();
  });

  it('returns 404 for an unknown credential id', async () => {
    const { cookie, ws } = await setup();

    const response = await app.request(
      revokeApiKeyPath(ws, '11111111-1111-4111-8111-111111111111'),
      { method: 'POST', headers: { cookie, origin: APP_URL } },
    );

    expect(response.status).toBe(404);
  });
});
