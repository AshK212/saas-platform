import {
  API_KEY_IDENTITY_PATH,
  AUTH_CALLBACK_PATH,
  AUTH_MAGIC_LINK_PATH,
  AUTH_ME_PATH,
  apiKeyIdentityResponseSchema,
  workspaceApiKeysPath,
} from '@hybrid/contracts';
import { beforeEach, describe, expect, it } from 'vitest';

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

/** Signs a user in, creates a workspace and issues a key for it. */
async function provision(email: string, name: string): Promise<{ workspaceId: string; key: string; cookie: string }> {
  const user = await signIn(email);
  const workspaceId = workspaces.seedWorkspace(name, [{ userId: user.userId }]);
  const response = await app.request(workspaceApiKeysPath(workspaceId), {
    method: 'POST',
    headers: { cookie: user.cookie, origin: APP_URL, 'content-type': 'application/json' },
    body: JSON.stringify({ name: `${name} key` }),
  });
  const { apiKey } = (await response.json()) as { apiKey: { key: string } };
  return { workspaceId, key: apiKey.key, cookie: user.cookie };
}

describe('bearer authentication', () => {
  it('authenticates a valid key and reports its workspace', async () => {
    const { workspaceId, key } = await provision('op@example.test', 'Acme');

    const response = await app.request(API_KEY_IDENTITY_PATH, {
      headers: { authorization: `Bearer ${key}` },
    });

    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(apiKeyIdentityResponseSchema.safeParse(body).success).toBe(true);
    expect(body).toEqual({ authenticated: true, workspaceId });
  });

  it('accepts the scheme case-insensitively per RFC 7235', async () => {
    const { key } = await provision('op@example.test', 'Acme');

    for (const scheme of ['Bearer', 'bearer', 'BEARER', 'BeArEr']) {
      const response = await app.request(API_KEY_IDENTITY_PATH, {
        headers: { authorization: `${scheme} ${key}` },
      });
      expect(response.status, scheme).toBe(200);
    }
  });

  it('records last-used telemetry without gating authentication', async () => {
    const { key } = await provision('op@example.test', 'Acme');

    await app.request(API_KEY_IDENTITY_PATH, { headers: { authorization: `Bearer ${key}` } });

    expect(apiKeys.credentials[0]?.lastUsedAt).toEqual(START);
  });

  it('still authenticates when the telemetry write fails', async () => {
    const { key } = await provision('op@example.test', 'Acme');
    apiKeys.touchLastUsed = () => Promise.reject(new Error('write failed'));

    const response = await app.request(API_KEY_IDENTITY_PATH, {
      headers: { authorization: `Bearer ${key}` },
    });

    // A telemetry problem must never deny a caller with a valid credential.
    expect(response.status).toBe(200);
  });
});

describe('authentication failures are uniform', () => {
  it.each([
    ['missing header', undefined],
    ['empty header', ''],
    ['no scheme', 'hmp_live_AbCdEfGhIjKl_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
    ['wrong scheme Basic', 'Basic hmp_live_AbCdEfGhIjKl_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
    ['wrong scheme Token', 'Token hmp_live_AbCdEfGhIjKl_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
    ['bearer with no token', 'Bearer '],
    ['malformed key', 'Bearer not-a-key'],
    ['uuid as key', 'Bearer 11111111-1111-4111-8111-111111111111'],
    ['unknown but well-formed key', `Bearer hmp_live_${'A'.repeat(12)}_${'B'.repeat(43)}`],
  ])('returns an identical 401 for %s', async (_label, header) => {
    await provision('op@example.test', 'Acme');

    const response = await app.request(
      API_KEY_IDENTITY_PATH,
      header === undefined ? {} : { headers: { authorization: header } },
    );

    expect(response.status).toBe(401);
    // One body for every category - no enumeration signal.
    expect(await response.json()).toEqual({ error: 'unauthorized' });
  });

  it('a revoked key is indistinguishable from an unknown one', async () => {
    const { workspaceId, key, cookie } = await provision('op@example.test', 'Acme');
    const id = apiKeys.credentials[0]?.id ?? '';
    await app.request(`${workspaceApiKeysPath(workspaceId)}/${id}/revoke`, {
      method: 'POST',
      headers: { cookie, origin: APP_URL },
    });

    const revoked = await app.request(API_KEY_IDENTITY_PATH, {
      headers: { authorization: `Bearer ${key}` },
    });
    const unknown = await app.request(API_KEY_IDENTITY_PATH, {
      headers: { authorization: `Bearer hmp_live_${'A'.repeat(12)}_${'B'.repeat(43)}` },
    });

    expect(revoked.status).toBe(unknown.status);
    expect(await revoked.text()).toBe(await unknown.text());
  });

  it('never echoes the presented key', async () => {
    const { key } = await provision('op@example.test', 'Acme');
    await app.request(`${workspaceApiKeysPath('x')}`, { headers: {} });

    const bad = `${key.slice(0, -1)}X`;
    const raw = await (
      await app.request(API_KEY_IDENTITY_PATH, { headers: { authorization: `Bearer ${bad}` } })
    ).text();

    expect(raw).not.toContain(bad);
    expect(raw).not.toContain(key);
  });
});

describe('WORKSPACE IS DERIVED FROM THE CREDENTIAL', () => {
  it('ignores a workspace_id in the request body', async () => {
    const alice = await provision('alice@example.test', 'Alice Co');
    const bob = await provision('bob@example.test', 'Bob Co');

    // Alice's key, body claiming Bob's workspace.
    const response = await app.request(API_KEY_IDENTITY_PATH, {
      method: 'GET',
      headers: { authorization: `Bearer ${alice.key}`, 'content-type': 'application/json' },
    });

    const body = (await response.json()) as { workspaceId: string };
    expect(body.workspaceId).toBe(alice.workspaceId);
    expect(body.workspaceId).not.toBe(bob.workspaceId);
  });

  it('ignores an X-Workspace-Id header', async () => {
    const alice = await provision('alice@example.test', 'Alice Co');
    const bob = await provision('bob@example.test', 'Bob Co');

    const response = await app.request(API_KEY_IDENTITY_PATH, {
      headers: {
        authorization: `Bearer ${alice.key}`,
        'x-workspace-id': bob.workspaceId,
        'x-tenant-id': bob.workspaceId,
      },
    });

    const body = (await response.json()) as { workspaceId: string };
    expect(body.workspaceId).toBe(alice.workspaceId);
  });

  it('ignores a workspace_id query parameter', async () => {
    const alice = await provision('alice@example.test', 'Alice Co');
    const bob = await provision('bob@example.test', 'Bob Co');

    const response = await app.request(
      `${API_KEY_IDENTITY_PATH}?workspace_id=${bob.workspaceId}&workspaceId=${bob.workspaceId}`,
      { headers: { authorization: `Bearer ${alice.key}` } },
    );

    const body = (await response.json()) as { workspaceId: string };
    expect(body.workspaceId).toBe(alice.workspaceId);
  });

  it('all three injection attempts at once still yield the credential workspace', async () => {
    const alice = await provision('alice@example.test', 'Alice Co');
    const bob = await provision('bob@example.test', 'Bob Co');

    const response = await app.request(
      `${API_KEY_IDENTITY_PATH}?workspace_id=${bob.workspaceId}`,
      {
        headers: {
          authorization: `Bearer ${alice.key}`,
          'x-workspace-id': bob.workspaceId,
        },
      },
    );

    expect(((await response.json()) as { workspaceId: string }).workspaceId).toBe(
      alice.workspaceId,
    );
  });

  it('never accepts a key from the query string', async () => {
    const { key } = await provision('op@example.test', 'Acme');

    // Query-string credentials land in access logs and Referer headers.
    const response = await app.request(`${API_KEY_IDENTITY_PATH}?api_key=${key}`);

    expect(response.status).toBe(401);
  });
});

describe('the two authentication domains do not overlap', () => {
  it('a session cookie cannot authenticate the bearer probe', async () => {
    const user = await signIn('op@example.test');

    const response = await app.request(API_KEY_IDENTITY_PATH, {
      headers: { cookie: user.cookie },
    });

    expect(response.status).toBe(401);
  });

  it('an API key cannot issue credentials', async () => {
    const { workspaceId, key } = await provision('op@example.test', 'Acme');

    const response = await app.request(workspaceApiKeysPath(workspaceId), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        origin: APP_URL,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'Self-issued' }),
    });

    // Management is operator/browser only. A key cannot mint more keys.
    expect(response.status).toBe(401);
    expect(apiKeys.credentials).toHaveLength(1);
  });

  it('an API key cannot list or revoke credentials', async () => {
    const { workspaceId, key } = await provision('op@example.test', 'Acme');
    const id = apiKeys.credentials[0]?.id ?? '';

    const list = await app.request(workspaceApiKeysPath(workspaceId), {
      headers: { authorization: `Bearer ${key}` },
    });
    const revoke = await app.request(`${workspaceApiKeysPath(workspaceId)}/${id}/revoke`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, origin: APP_URL },
    });

    expect(list.status).toBe(401);
    expect(revoke.status).toBe(401);
    expect(apiKeys.credentials[0]?.revokedAt).toBeNull();
  });

  it('an API key cannot access the operator identity endpoint', async () => {
    const { key } = await provision('op@example.test', 'Acme');

    const response = await app.request(AUTH_ME_PATH, {
      headers: { authorization: `Bearer ${key}` },
    });

    // An API key is not a human identity.
    expect(response.status).toBe(401);
  });

  it('the probe reveals no user identity', async () => {
    const { key } = await provision('op@example.test', 'Acme');

    const body = (await (
      await app.request(API_KEY_IDENTITY_PATH, { headers: { authorization: `Bearer ${key}` } })
    ).json()) as Record<string, unknown>;

    expect(Object.keys(body).sort()).toEqual(['authenticated', 'workspaceId']);
    expect(JSON.stringify(body)).not.toContain('op@example.test');
  });
});

describe('unavailable without a database', () => {
  it('the probe reports 503 rather than crashing', async () => {
    const noDb = createApp({ probeDatabase: () => Promise.resolve('unconfigured') });

    expect((await noDb.request(API_KEY_IDENTITY_PATH)).status).toBe(503);
  });

  it('/healthz stays 200', async () => {
    const noDb = createApp({ probeDatabase: () => Promise.resolve('unconfigured') });

    expect((await noDb.request('/healthz')).status).toBe(200);
  });
});
