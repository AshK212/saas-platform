import {
  AUTH_CALLBACK_PATH,
  AUTH_LOGOUT_PATH,
  AUTH_MAGIC_LINK_PATH,
  AUTH_ME_PATH,
  currentUserResponseSchema,
} from '@hybrid/contracts';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { createFixedClock } from '../src/auth/clock';
import { AUTH_COOKIE_NAME } from '../src/auth/cookie';
import { createCapturingEmailSender, type CapturingEmailSender } from '../src/auth/email';
import { createAuthService, type AuthService } from '../src/auth/service';
import { createMemoryAuthStore, type MemoryAuthStore } from './helpers/memory-auth-store';

const APP_URL = 'https://app.example.test';
const START = new Date('2026-08-12T10:00:00.000Z');

let store: MemoryAuthStore;
let mailer: CapturingEmailSender;
let clock: ReturnType<typeof createFixedClock>;
let service: AuthService;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  store = createMemoryAuthStore();
  mailer = createCapturingEmailSender();
  clock = createFixedClock(START);
  service = createAuthService({
    store,
    mailer,
    clock,
    appUrl: APP_URL,
    callbackPath: AUTH_CALLBACK_PATH,
  });
  app = createApp({
    probeDatabase: () => Promise.resolve('ok'),
    authService: service,
    appUrl: APP_URL,
    secureCookies: true,
  });
});

async function postJson(path: string, body: unknown): Promise<Response> {
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function capturedToken(): string {
  const url = mailer.lastLink()?.url ?? '';
  return new URL(url).searchParams.get('token') ?? '';
}

/** Completes sign-in and returns the raw Set-Cookie header. */
async function signInCookieHeader(): Promise<string> {
  await postJson(AUTH_MAGIC_LINK_PATH, { email: 'user@example.test' });
  const response = await app.request(`${AUTH_CALLBACK_PATH}?token=${capturedToken()}`);
  return response.headers.get('set-cookie') ?? '';
}

function cookieValue(setCookieHeader: string): string {
  return setCookieHeader.split(';')[0]?.split('=')[1] ?? '';
}

describe('POST /v1/auth/magic-link', () => {
  it('accepts a valid address and returns a neutral body', async () => {
    const response = await postJson(AUTH_MAGIC_LINK_PATH, { email: 'user@example.test' });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it('returns the identical body for a known and an unknown address', async () => {
    const unknown = await (await postJson(AUTH_MAGIC_LINK_PATH, { email: 'a@example.test' })).text();
    const known = await (await postJson(AUTH_MAGIC_LINK_PATH, { email: 'a@example.test' })).text();

    expect(known).toBe(unknown);
  });

  it('normalises an uppercase address', async () => {
    await postJson(AUTH_MAGIC_LINK_PATH, { email: 'USER@Example.TEST' });

    expect(mailer.lastLink()?.to).toBe('user@example.test');
  });

  it.each([
    ['missing email', {}],
    ['empty email', { email: '' }],
    ['malformed email', { email: 'not-an-email' }],
    ['wrong type', { email: 42 }],
  ])('rejects %s', async (_label, body) => {
    const response = await postJson(AUTH_MAGIC_LINK_PATH, body);

    expect(response.status).toBe(400);
  });

  it('rejects a malformed JSON body without leaking a parser error', async () => {
    const response = await app.request(AUTH_MAGIC_LINK_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });

    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain('JSON');
  });

  it('never returns a token, hash or user id', async () => {
    const response = await postJson(AUTH_MAGIC_LINK_PATH, { email: 'user@example.test' });
    const raw = await response.text();

    expect(raw).toBe('{"ok":true}');
    expect(raw).not.toContain(capturedToken());
  });

  it('still answers 200 when email delivery fails', async () => {
    const failing = createAuthService({
      store,
      mailer: {
        sendMagicLink: () => Promise.reject(new Error('provider down')),
      },
      clock,
      appUrl: APP_URL,
      callbackPath: AUTH_CALLBACK_PATH,
    });
    const failingApp = createApp({
      probeDatabase: () => Promise.resolve('ok'),
      authService: failing,
      appUrl: APP_URL,
    });

    const response = await failingApp.request(AUTH_MAGIC_LINK_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'user@example.test' }),
    });

    // A 500 here would be an enumeration oracle: it would differ between
    // addresses that do and do not trigger a send.
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });
});

describe('GET /v1/auth/callback', () => {
  it('redirects to the app and sets a session cookie on success', async () => {
    await postJson(AUTH_MAGIC_LINK_PATH, { email: 'user@example.test' });

    const response = await app.request(`${AUTH_CALLBACK_PATH}?token=${capturedToken()}`);

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(`${APP_URL}/?auth=success`);
    expect(response.headers.get('set-cookie')).toContain(AUTH_COOKIE_NAME);
  });

  it('removes the token from the redirect destination', async () => {
    await postJson(AUTH_MAGIC_LINK_PATH, { email: 'user@example.test' });
    const token = capturedToken();

    const response = await app.request(`${AUTH_CALLBACK_PATH}?token=${token}`);

    // The browser's address bar, history and any onward Referer must not carry
    // the bearer credential.
    expect(response.headers.get('location')).not.toContain(token);
  });

  it('sets HttpOnly, Secure, SameSite=Lax, Path and Max-Age', async () => {
    const header = await signInCookieHeader();

    expect(header).toContain('HttpOnly');
    expect(header).toContain('Secure');
    expect(header).toContain('SameSite=Lax');
    expect(header).toContain('Path=/');
    expect(header).toMatch(/Max-Age=\d+/);
  });

  it('omits Secure when not in production, so localhost works', async () => {
    const devApp = createApp({
      probeDatabase: () => Promise.resolve('ok'),
      authService: service,
      appUrl: APP_URL,
      secureCookies: false,
    });

    await devApp.request(AUTH_MAGIC_LINK_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'user@example.test' }),
    });
    const response = await devApp.request(`${AUTH_CALLBACK_PATH}?token=${capturedToken()}`);

    expect(response.headers.get('set-cookie')).not.toContain('Secure');
  });

  it.each([
    ['missing token', ''],
    ['malformed token', '?token=garbage'],
    ['unknown token', `?token=${'z'.repeat(43)}`],
  ])('redirects with a generic failure for %s', async (_label, query) => {
    const response = await app.request(`${AUTH_CALLBACK_PATH}${query}`);

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(`${APP_URL}/?auth=invalid_link`);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('gives the same failure for a replayed token as for an unknown one', async () => {
    await postJson(AUTH_MAGIC_LINK_PATH, { email: 'user@example.test' });
    const token = capturedToken();
    await app.request(`${AUTH_CALLBACK_PATH}?token=${token}`);

    const replay = await app.request(`${AUTH_CALLBACK_PATH}?token=${token}`);
    const unknown = await app.request(`${AUTH_CALLBACK_PATH}?token=${'z'.repeat(43)}`);

    expect(replay.headers.get('location')).toBe(unknown.headers.get('location'));
  });

  it('ignores a caller-supplied redirect target', async () => {
    await postJson(AUTH_MAGIC_LINK_PATH, { email: 'user@example.test' });

    const response = await app.request(
      `${AUTH_CALLBACK_PATH}?token=${capturedToken()}&returnTo=https://evil.example`,
    );

    // Open-redirect guard: the destination comes only from configured APP_URL.
    expect(response.headers.get('location')).toBe(`${APP_URL}/?auth=success`);
    expect(response.headers.get('location')).not.toContain('evil.example');
  });
});

describe('GET /v1/auth/me', () => {
  it('returns the identity for an authenticated session', async () => {
    const cookie = cookieValue(await signInCookieHeader());

    const response = await app.request(AUTH_ME_PATH, {
      headers: { cookie: `${AUTH_COOKIE_NAME}=${cookie}` },
    });

    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(currentUserResponseSchema.safeParse(body).success).toBe(true);
    expect((body as { user: { email: string } }).user.email).toBe('user@example.test');
  });

  it('exposes only id and email - no workspace, role or session hash', async () => {
    const cookie = cookieValue(await signInCookieHeader());

    const response = await app.request(AUTH_ME_PATH, {
      headers: { cookie: `${AUTH_COOKIE_NAME}=${cookie}` },
    });
    const body = (await response.json()) as { user: Record<string, unknown> };

    expect(Object.keys(body.user).sort()).toEqual(['email', 'id']);
    expect(Object.keys(body)).toEqual(['user']);
  });

  it('returns 401 without a cookie', async () => {
    const response = await app.request(AUTH_ME_PATH);

    expect(response.status).toBe(401);
  });

  it.each([
    ['garbage cookie', 'garbage'],
    ['empty cookie', ''],
    ['unknown token', 'z'.repeat(43)],
  ])('returns 401 for %s', async (_label, value) => {
    const response = await app.request(AUTH_ME_PATH, {
      headers: { cookie: `${AUTH_COOKIE_NAME}=${value}` },
    });

    expect(response.status).toBe(401);
  });

  it('returns 401 after the session expires', async () => {
    const cookie = cookieValue(await signInCookieHeader());
    clock.advance(service.sessionTtlMs + 1);

    const response = await app.request(AUTH_ME_PATH, {
      headers: { cookie: `${AUTH_COOKIE_NAME}=${cookie}` },
    });

    expect(response.status).toBe(401);
  });
});

describe('POST /v1/auth/logout', () => {
  it('revokes the session and clears the cookie', async () => {
    const cookie = cookieValue(await signInCookieHeader());
    const header = { cookie: `${AUTH_COOKIE_NAME}=${cookie}` };

    const logout = await app.request(AUTH_LOGOUT_PATH, {
      method: 'POST',
      // A real browser always sends Origin on POST; the CSRF origin guard
      // requires it whenever the request carries the session cookie.
      headers: { ...header, origin: APP_URL },
    });

    expect(logout.status).toBe(200);
    expect(await logout.json()).toEqual({ ok: true });
    expect(logout.headers.get('set-cookie')).toContain(`${AUTH_COOKIE_NAME}=;`);

    // The retained cookie value must no longer authenticate - clearing the
    // browser cookie is not the security boundary.
    const after = await app.request(AUTH_ME_PATH, { headers: header });
    expect(after.status).toBe(401);
  });

  it('succeeds without a cookie and reveals nothing', async () => {
    const response = await app.request(AUTH_LOGOUT_PATH, { method: 'POST' });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it('is not exposed over GET', async () => {
    // GET would be reachable cross-site by navigation or a prefetcher.
    const response = await app.request(AUTH_LOGOUT_PATH);

    expect(response.status).toBe(404);
  });
});

describe('auth unavailable without configuration', () => {
  const unconfigured = (): ReturnType<typeof createApp> =>
    createApp({ probeDatabase: () => Promise.resolve('unconfigured') });

  it('magic-link reports 503 rather than crashing', async () => {
    const response = await unconfigured().request(AUTH_MAGIC_LINK_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'a@example.test' }),
    });

    expect(response.status).toBe(503);
  });

  it.each([
    ['me', AUTH_ME_PATH],
    ['callback', AUTH_CALLBACK_PATH],
  ])('%s reports 503 rather than crashing', async (_label, path) => {
    const response = await unconfigured().request(path);

    expect(response.status).toBe(503);
  });

  it('logout reports 503 rather than crashing', async () => {
    const response = await unconfigured().request(AUTH_LOGOUT_PATH, { method: 'POST' });

    expect(response.status).toBe(503);
  });

  it('keeps /healthz at 200 with no auth configured', async () => {
    const response = await unconfigured().request('/healthz');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });
});

describe('liveness and readiness remain unaffected by auth', () => {
  it('/healthz stays 200 with auth configured', async () => {
    const response = await app.request('/healthz');

    expect(response.status).toBe(200);
  });

  it('/readyz still reflects only database state', async () => {
    const notReady = createApp({
      probeDatabase: () => Promise.resolve('unreachable'),
      authService: service,
      appUrl: APP_URL,
    });

    const response = await notReady.request('/readyz');

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      status: 'not_ready',
      checks: { database: 'unreachable' },
    });
  });
});

describe('no secret material in any auth response', () => {
  it('no response body contains a token or hash', async () => {
    await postJson(AUTH_MAGIC_LINK_PATH, { email: 'user@example.test' });
    const token = capturedToken();

    const callback = await app.request(`${AUTH_CALLBACK_PATH}?token=${token}`);
    const cookie = cookieValue(callback.headers.get('set-cookie') ?? '');
    const header = { cookie: `${AUTH_COOKIE_NAME}=${cookie}` };

    const bodies = await Promise.all([
      (await postJson(AUTH_MAGIC_LINK_PATH, { email: 'user@example.test' })).text(),
      callback.text(),
      (await app.request(AUTH_ME_PATH, { headers: header })).text(),
      (await app.request(AUTH_LOGOUT_PATH, { method: 'POST', headers: header })).text(),
    ]);

    for (const body of bodies) {
      expect(body).not.toContain(token);
      expect(body).not.toContain(cookie);
      // A 64-char hex digest would be a leaked SHA-256 hash.
      expect(body).not.toMatch(/[0-9a-f]{64}/);
    }
  });
});
