import { beforeEach, describe, expect, it } from 'vitest';

import { createFixedClock } from '../src/auth/clock';
import { createCapturingEmailSender, type CapturingEmailSender } from '../src/auth/email';
import {
  createAuthService,
  MAGIC_LINK_COOLDOWN_MS,
  MAGIC_LINK_TTL_MS,
  type AuthService,
} from '../src/auth/service';
import { hashToken } from '../src/auth/tokens';
import { createMemoryAuthStore, type MemoryAuthStore } from './helpers/memory-auth-store';

const APP_URL = 'https://app.example.test';
const CALLBACK_PATH = '/v1/auth/callback';
const START = new Date('2026-08-12T10:00:00.000Z');

let store: MemoryAuthStore;
let mailer: CapturingEmailSender;
let clock: ReturnType<typeof createFixedClock>;
let service: AuthService;

beforeEach(() => {
  store = createMemoryAuthStore();
  mailer = createCapturingEmailSender();
  clock = createFixedClock(START);
  service = createAuthService({
    store,
    mailer,
    clock,
    appUrl: APP_URL,
    callbackPath: CALLBACK_PATH,
  });
});

/** Extracts the plaintext token from the captured email URL. */
function capturedToken(): string {
  const link = mailer.lastLink();
  if (link === undefined) {
    throw new Error('no magic link was sent');
  }
  const token = new URL(link.url).searchParams.get('token');
  if (token === null) {
    throw new Error('captured link carried no token');
  }
  return token;
}

describe('magic-link request', () => {
  it('sends a link to a new address and creates the identity', async () => {
    await service.requestMagicLink('user@example.test');

    expect(mailer.sent).toHaveLength(1);
    expect(mailer.lastLink()?.to).toBe('user@example.test');
    expect(store.users.size).toBe(1);
  });

  it('normalises an uppercase address', async () => {
    await service.requestMagicLink('User@Example.TEST');

    expect(mailer.lastLink()?.to).toBe('user@example.test');
    expect(store.users.has('user@example.test')).toBe(true);
  });

  it('trims surrounding whitespace', async () => {
    await service.requestMagicLink('  user@example.test  ');

    expect(mailer.lastLink()?.to).toBe('user@example.test');
  });

  it('reuses the existing identity on a second request', async () => {
    await service.requestMagicLink('user@example.test');
    clock.advance(MAGIC_LINK_COOLDOWN_MS + 1);
    await service.requestMagicLink('USER@example.test');

    expect(store.users.size).toBe(1);
  });

  it('builds a link on the configured origin, never localhost', async () => {
    await service.requestMagicLink('user@example.test');

    const url = new URL(mailer.lastLink()?.url ?? '');
    expect(url.origin).toBe(APP_URL);
    expect(url.pathname).toBe(CALLBACK_PATH);
    expect(url.searchParams.get('token')).toBeTruthy();
  });

  it('stores only the hash, never the plaintext token', async () => {
    await service.requestMagicLink('user@example.test');
    const token = capturedToken();

    const stored = store.magicLinks[0];
    expect(stored?.tokenHash).toBe(hashToken(token));
    expect(stored?.tokenHash).not.toBe(token);
    // Nothing anywhere in the persisted record may equal the token.
    expect(JSON.stringify(store.magicLinks)).not.toContain(token);
  });

  it('sets the documented 15-minute expiry', async () => {
    await service.requestMagicLink('user@example.test');

    expect(store.magicLinks[0]?.expiresAt.getTime()).toBe(START.getTime() + MAGIC_LINK_TTL_MS);
  });
});

describe('anti-enumeration', () => {
  it('behaves identically for known and unknown addresses', async () => {
    await service.requestMagicLink('known@example.test');
    clock.advance(MAGIC_LINK_COOLDOWN_MS + 1);

    const knownResult = await service.requestMagicLink('known@example.test');
    const unknownResult = await service.requestMagicLink('unknown@example.test');

    // Both resolve to undefined - there is no value to branch on.
    expect(knownResult).toBeUndefined();
    expect(unknownResult).toBeUndefined();
  });

  it('does not throw for an address that has never been seen', async () => {
    await expect(service.requestMagicLink('nobody@example.test')).resolves.toBeUndefined();
  });
});

describe('issuance cooldown', () => {
  it('suppresses a second email inside the cooldown window', async () => {
    await service.requestMagicLink('user@example.test');
    clock.advance(MAGIC_LINK_COOLDOWN_MS - 1);
    await service.requestMagicLink('user@example.test');

    expect(mailer.sent).toHaveLength(1);
    expect(store.magicLinks).toHaveLength(1);
  });

  it('allows a new email once the cooldown elapses', async () => {
    await service.requestMagicLink('user@example.test');
    clock.advance(MAGIC_LINK_COOLDOWN_MS + 1);
    await service.requestMagicLink('user@example.test');

    expect(mailer.sent).toHaveLength(2);
  });

  it('is silent when suppressing, so it cannot be probed', async () => {
    await service.requestMagicLink('user@example.test');
    clock.advance(1_000);

    // Identical resolution to a successful send.
    await expect(service.requestMagicLink('user@example.test')).resolves.toBeUndefined();
  });

  it('applies per address, not globally', async () => {
    await service.requestMagicLink('a@example.test');
    await service.requestMagicLink('b@example.test');

    expect(mailer.sent).toHaveLength(2);
  });
});

describe('magic-link consumption', () => {
  it('establishes a session for a valid token', async () => {
    await service.requestMagicLink('user@example.test');

    const session = await service.completeMagicLink(capturedToken());

    expect(session).not.toBeNull();
    expect(session?.token).toBeTruthy();
    expect(store.sessions).toHaveLength(1);
  });

  it('stores only the session hash, never the session token', async () => {
    await service.requestMagicLink('user@example.test');
    const session = await service.completeMagicLink(capturedToken());

    expect(store.sessions[0]?.tokenHash).toBe(hashToken(session?.token ?? ''));
    expect(JSON.stringify(store.sessions)).not.toContain(session?.token);
  });

  it('REPLAY: rejects the same token a second time', async () => {
    await service.requestMagicLink('user@example.test');
    const token = capturedToken();

    const first = await service.completeMagicLink(token);
    const second = await service.completeMagicLink(token);

    expect(first).not.toBeNull();
    expect(second).toBeNull();
    // Exactly one session, not two.
    expect(store.sessions).toHaveLength(1);
  });

  it('REPLAY: a third attempt also fails', async () => {
    await service.requestMagicLink('user@example.test');
    const token = capturedToken();

    await service.completeMagicLink(token);
    await service.completeMagicLink(token);

    expect(await service.completeMagicLink(token)).toBeNull();
    expect(store.sessions).toHaveLength(1);
  });

  it('EXPIRY: rejects a token past its lifetime and creates no session', async () => {
    await service.requestMagicLink('user@example.test');
    const token = capturedToken();

    clock.advance(MAGIC_LINK_TTL_MS + 1);

    expect(await service.completeMagicLink(token)).toBeNull();
    expect(store.sessions).toHaveLength(0);
  });

  it('EXPIRY: accepts a token one millisecond before expiry', async () => {
    await service.requestMagicLink('user@example.test');
    const token = capturedToken();

    clock.advance(MAGIC_LINK_TTL_MS - 1);

    expect(await service.completeMagicLink(token)).not.toBeNull();
  });

  it('rejects an unknown but well-formed token', async () => {
    await service.requestMagicLink('user@example.test');

    expect(await service.completeMagicLink('a'.repeat(43))).toBeNull();
  });

  it.each([
    ['empty', ''],
    ['malformed', 'not-a-token'],
    ['sql fragment', "' OR 1=1 --"],
  ])('rejects %s input without querying', async (_label, value) => {
    expect(await service.completeMagicLink(value)).toBeNull();
  });

  it('leaves the consumed link marked, not deleted', async () => {
    await service.requestMagicLink('user@example.test');
    await service.completeMagicLink(capturedToken());

    expect(store.magicLinks[0]?.consumedAt).not.toBeNull();
  });
});

describe('session authentication', () => {
  async function signIn(): Promise<string> {
    await service.requestMagicLink('user@example.test');
    const session = await service.completeMagicLink(capturedToken());
    return session?.token ?? '';
  }

  it('authenticates a valid session token', async () => {
    const token = await signIn();

    const user = await service.authenticate(token);

    expect(user?.email).toBe('user@example.test');
    expect(user?.userId).toBeTruthy();
    expect(user?.authSessionId).toBeTruthy();
  });

  it('carries no workspace authorization', async () => {
    const user = await service.authenticate(await signIn());

    // Authentication proves identity only. Any workspace-shaped field here
    // would let a caller construct a WorkspaceScope from a login.
    expect(Object.keys(user ?? {}).sort()).toEqual(['authSessionId', 'email', 'userId']);
  });

  it('rejects an expired session', async () => {
    const token = await signIn();

    clock.advance(service.sessionTtlMs + 1);

    expect(await service.authenticate(token)).toBeNull();
  });

  it('rejects a revoked session', async () => {
    const token = await signIn();
    await service.logout(token);

    expect(await service.authenticate(token)).toBeNull();
  });

  it('rejects an unknown token', async () => {
    await signIn();

    expect(await service.authenticate('b'.repeat(43))).toBeNull();
  });

  it.each([
    ['empty', ''],
    ['malformed', 'garbage'],
  ])('rejects %s cookie value safely', async (_label, value) => {
    expect(await service.authenticate(value)).toBeNull();
  });

  it('does not authenticate using the magic-link token', async () => {
    await service.requestMagicLink('user@example.test');
    const magicToken = capturedToken();
    await service.completeMagicLink(magicToken);

    // The two token namespaces must not be interchangeable.
    expect(await service.authenticate(magicToken)).toBeNull();
  });
});

describe('logout', () => {
  it('revokes server-side so a retained cookie stops working', async () => {
    await service.requestMagicLink('user@example.test');
    const session = await service.completeMagicLink(capturedToken());
    const token = session?.token ?? '';

    // Simulates an attacker holding a copy of the cookie.
    expect(await service.authenticate(token)).not.toBeNull();

    await service.logout(token);

    expect(await service.authenticate(token)).toBeNull();
    expect(store.sessions[0]?.revokedAt).not.toBeNull();
  });

  it('is idempotent', async () => {
    await service.requestMagicLink('user@example.test');
    const session = await service.completeMagicLink(capturedToken());

    await service.logout(session?.token ?? '');
    await expect(service.logout(session?.token ?? '')).resolves.toBeUndefined();
  });

  it('is silent for an unknown token', async () => {
    await expect(service.logout('c'.repeat(43))).resolves.toBeUndefined();
  });

  it('does not affect other sessions', async () => {
    await service.requestMagicLink('a@example.test');
    const first = await service.completeMagicLink(capturedToken());

    await service.requestMagicLink('b@example.test');
    const second = await service.completeMagicLink(capturedToken());

    await service.logout(first?.token ?? '');

    expect(await service.authenticate(first?.token ?? '')).toBeNull();
    expect(await service.authenticate(second?.token ?? '')).not.toBeNull();
  });
});
