import {
  agentPolicyPath,
  agentPolicyResponseSchema,
  AUTH_CALLBACK_PATH,
  AUTH_MAGIC_LINK_PATH,
  workspaceApiKeysPath,
  type AgentPolicyResponse,
} from '@hybrid/contracts';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { createFixedClock } from '../src/auth/clock';
import { AUTH_COOKIE_NAME } from '../src/auth/cookie';
import { createCapturingEmailSender, type CapturingEmailSender } from '../src/auth/email';
import { createAuthService } from '../src/auth/service';
import { createMemoryApiKeyStore, type MemoryApiKeyStore } from './helpers/memory-api-key-store';
import { createMemoryAuthStore, type MemoryAuthStore } from './helpers/memory-auth-store';
import {
  createMemoryPolicyMutationStore,
  type MemoryPolicyMutationStore,
} from './helpers/memory-policy-mutation-store';
import {
  createMemoryWorkspaceStore,
  type MemoryWorkspaceStore,
} from './helpers/memory-workspace-store';

/**
 * Operator agent-policy routes (Step 13).
 *
 * The properties under test: only an operator browser session can write, every
 * accepted write increments the version exactly once, every REJECTED attempt
 * increments nothing, and nothing crosses a tenant boundary.
 */

const APP_URL = 'https://app.example.test';
const START = new Date('2026-08-12T10:00:00.000Z');
const AGENT_A = '33333333-3333-4333-8333-333333333333';
const AGENT_B = '44444444-4444-4444-8444-444444444444';
const UNKNOWN_UUID = '55555555-5555-4555-8555-555555555555';

let authStore: MemoryAuthStore;
let mailer: CapturingEmailSender;
let clock: ReturnType<typeof createFixedClock>;
let workspaces: MemoryWorkspaceStore;
let apiKeys: MemoryApiKeyStore;
let mutations: MemoryPolicyMutationStore;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  authStore = createMemoryAuthStore();
  mailer = createCapturingEmailSender();
  clock = createFixedClock(START);
  workspaces = createMemoryWorkspaceStore();
  apiKeys = createMemoryApiKeyStore();
  mutations = createMemoryPolicyMutationStore();
  app = createApp({
    probeDatabase: () => Promise.resolve('ok'),
    authService: createAuthService({
      store: authStore,
      mailer,
      clock,
      appUrl: APP_URL,
      callbackPath: AUTH_CALLBACK_PATH,
    }),
    appUrl: APP_URL,
    secureCookies: true,
    workspaceStore: workspaces,
    apiKeyStore: apiKeys,
    policyMutationStore: mutations,
    clock,
  });
});

interface Tenant {
  readonly workspaceId: string;
  readonly cookie: string;
}

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

async function tenant(
  email: string,
  name: string,
  role: 'operator' | 'member' = 'operator',
  agentId = AGENT_A,
  externalId = 'agent-a',
): Promise<Tenant> {
  const { cookie, userId } = await signIn(email);
  const workspaceId = workspaces.seedWorkspace(name, [{ userId, role }]);
  mutations.seedPolicyState(workspaceId);
  mutations.seedAgent(workspaceId, agentId, externalId);
  return { workspaceId, cookie };
}

const VALID_POLICY = {
  mode: 'budgeted',
  daily_spend_cap_usd: '25.000000',
  daily_publish_cap: 5,
} as const;

async function put(t: Tenant, body: unknown, agentId = AGENT_A): Promise<Response> {
  return app.request(agentPolicyPath(t.workspaceId, agentId), {
    method: 'PUT',
    headers: { cookie: t.cookie, origin: APP_URL, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function saved(t: Tenant, body: unknown, agentId = AGENT_A): Promise<AgentPolicyResponse> {
  const response = await put(t, body, agentId);
  expect(response.status).toBe(200);
  return agentPolicyResponseSchema.parse(await response.json());
}

describe('mutation basics', () => {
  it('an operator sets policy on an agent that has none', async () => {
    const t = await tenant('op@example.test', 'Acme');

    const body = await saved(t, VALID_POLICY);

    // Default -> explicit, with no pre-existing policy row required.
    expect(body.policy).toEqual({
      agent_id: 'agent-a',
      mode: 'budgeted',
      daily_spend_cap_usd: '25.000000',
      daily_publish_cap: 5,
    });
    expect(body.version).toBe('2');
  });

  it('increments the version once per mutation', async () => {
    const t = await tenant('op@example.test', 'Acme');

    expect((await saved(t, VALID_POLICY)).version).toBe('2');
    expect((await saved(t, { ...VALID_POLICY, mode: 'watch' })).version).toBe('3');
    expect((await saved(t, { ...VALID_POLICY, mode: 'paused' })).version).toBe('4');
  });

  it('INCREMENTS even when the submitted values are identical', async () => {
    const t = await tenant('op@example.test', 'Acme');
    await saved(t, VALID_POLICY);

    const again = await saved(t, VALID_POLICY);

    // Documented semantic: the operator performed a governance write, so the
    // history is deterministic rather than dependent on a value comparison.
    expect(again.version).toBe('3');
  });

  it('replaces every field, clearing a previously set cap', async () => {
    const t = await tenant('op@example.test', 'Acme');
    await saved(t, VALID_POLICY);

    const cleared = await saved(t, {
      mode: 'watch',
      daily_spend_cap_usd: null,
      daily_publish_cap: null,
    });

    // PUT semantics: null actually clears, rather than meaning "unchanged".
    expect(cleared.policy.daily_spend_cap_usd).toBeNull();
    expect(cleared.policy.daily_publish_cap).toBeNull();
    expect(mutations.policyOf(t.workspaceId, AGENT_A)?.dailySpendCapUsd).toBeNull();
  });

  it('stores paused without enforcing anything', async () => {
    const t = await tenant('op@example.test', 'Acme');

    const body = await saved(t, {
      mode: 'paused',
      daily_spend_cap_usd: null,
      daily_publish_cap: null,
    });

    expect(body.policy.mode).toBe('paused');
  });

  it('unpauses back to budgeted', async () => {
    const t = await tenant('op@example.test', 'Acme');
    await saved(t, { mode: 'paused', daily_spend_cap_usd: null, daily_publish_cap: null });

    const resumed = await saved(t, VALID_POLICY);

    expect(resumed.policy.mode).toBe('budgeted');
    expect(resumed.version).toBe('3');
  });

  it('reads the effective policy of an unconfigured agent', async () => {
    const t = await tenant('op@example.test', 'Acme');

    const response = await app.request(agentPolicyPath(t.workspaceId, AGENT_A), {
      headers: { cookie: t.cookie },
    });
    const body = agentPolicyResponseSchema.parse(await response.json());

    // The Step 12 default, not an empty form.
    expect(body.policy).toEqual({
      agent_id: 'agent-a',
      mode: 'watch',
      daily_spend_cap_usd: null,
      daily_publish_cap: null,
    });
    expect(body.version).toBe('1');
  });

  it('a read does NOT increment the version', async () => {
    const t = await tenant('op@example.test', 'Acme');

    await app.request(agentPolicyPath(t.workspaceId, AGENT_A), { headers: { cookie: t.cookie } });

    expect(mutations.versionOf(t.workspaceId)).toBe('1');
  });

  it('exposes no internal ids in the response', async () => {
    const t = await tenant('op@example.test', 'Acme');

    const raw = await (await put(t, VALID_POLICY)).text();

    // External agent id only; no internal UUID, no workspace, no row id.
    expect(raw).toContain('"agent_id":"agent-a"');
    expect(raw).not.toContain(AGENT_A);
    expect(raw).not.toContain(t.workspaceId);
    expect(Object.keys(JSON.parse(raw) as object).sort()).toEqual(['policy', 'version']);
  });
});

describe('authentication and role', () => {
  it('rejects an unauthenticated write', async () => {
    const t = await tenant('op@example.test', 'Acme');

    const response = await app.request(agentPolicyPath(t.workspaceId, AGENT_A), {
      method: 'PUT',
      headers: { origin: APP_URL, 'content-type': 'application/json' },
      body: JSON.stringify(VALID_POLICY),
    });

    expect(response.status).toBe(401);
    expect(mutations.versionOf(t.workspaceId)).toBe('1');
  });

  it('REJECTS a machine API key', async () => {
    const t = await tenant('op@example.test', 'Acme');
    const issued = await app.request(workspaceApiKeysPath(t.workspaceId), {
      method: 'POST',
      headers: { cookie: t.cookie, origin: APP_URL, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'runtime' }),
    });
    const { apiKey } = (await issued.json()) as { apiKey: { key: string } };

    const response = await app.request(agentPolicyPath(t.workspaceId, AGENT_A), {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${apiKey.key}`,
        origin: APP_URL,
        'content-type': 'application/json',
      },
      body: JSON.stringify(VALID_POLICY),
    });

    // A runtime must never edit the governance it is subject to. It may READ
    // policy through /v1/policy; it may not write it anywhere.
    expect(response.status).toBe(401);
    expect(mutations.versionOf(t.workspaceId)).toBe('1');
    expect(mutations.policyOf(t.workspaceId, AGENT_A)).toBeUndefined();
  });

  it('a MEMBER gets 403 insufficient_role, not 404', async () => {
    const t = await tenant('member@example.test', 'Acme', 'member');

    const response = await put(t, VALID_POLICY);

    // 403 because a member legitimately knows the workspace exists - hiding it
    // would be theatre. Same rule as API-key management.
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: string }).error).toBe('insufficient_role');
    expect(mutations.versionOf(t.workspaceId)).toBe('1');
    expect(mutations.policyOf(t.workspaceId, AGENT_A)).toBeUndefined();
  });

  it('a member MAY read policy', async () => {
    const t = await tenant('member@example.test', 'Acme', 'member');

    const response = await app.request(agentPolicyPath(t.workspaceId, AGENT_A), {
      headers: { cookie: t.cookie },
    });

    // Reading is ordinary tenant data, like the agent roster.
    expect(response.status).toBe(200);
  });

  it('rejects a foreign ORIGIN carrying a valid session', async () => {
    const t = await tenant('op@example.test', 'Acme');

    const response = await app.request(agentPolicyPath(t.workspaceId, AGENT_A), {
      method: 'PUT',
      headers: {
        cookie: t.cookie,
        origin: 'https://attacker.example',
        'content-type': 'application/json',
      },
      body: JSON.stringify(VALID_POLICY),
    });

    // CSRF: a cross-origin form post with the victim's cookie must not change
    // governance.
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: string }).error).toBe('forbidden_origin');
    expect(mutations.versionOf(t.workspaceId)).toBe('1');
  });

  it('rejects a cookie request with NO origin header', async () => {
    const t = await tenant('op@example.test', 'Acme');

    const response = await app.request(agentPolicyPath(t.workspaceId, AGENT_A), {
      method: 'PUT',
      headers: { cookie: t.cookie, 'content-type': 'application/json' },
      body: JSON.stringify(VALID_POLICY),
    });

    // Ambient cookie authority with no provable origin is refused, matching
    // the Step 6 rule.
    expect(response.status).toBe(403);
    expect(mutations.versionOf(t.workspaceId)).toBe('1');
  });
});

describe('cross-tenant safety', () => {
  it("workspace A cannot mutate workspace B's agent", async () => {
    const a = await tenant('alice@example.test', 'Alice Co');
    const b = await tenant('bob@example.test', 'Bob Co', 'operator', AGENT_B, 'bobs-agent');

    // Alice holds Bob's exact internal agent UUID and aims at her OWN
    // workspace: the agent is not in her scope.
    const viaOwn = await put(a, VALID_POLICY, AGENT_B);
    // And she cannot borrow Bob's workspace id either.
    const viaForeign = await app.request(agentPolicyPath(b.workspaceId, AGENT_B), {
      method: 'PUT',
      headers: { cookie: a.cookie, origin: APP_URL, 'content-type': 'application/json' },
      body: JSON.stringify(VALID_POLICY),
    });

    expect(viaOwn.status).toBe(404);
    expect(viaForeign.status).toBe(404);
    // Nothing changed anywhere - including both version counters.
    expect(mutations.versionOf(a.workspaceId)).toBe('1');
    expect(mutations.versionOf(b.workspaceId)).toBe('1');
    expect(mutations.policyOf(b.workspaceId, AGENT_B)).toBeUndefined();
  });

  it('leaks no hint that the foreign agent exists', async () => {
    const a = await tenant('alice@example.test', 'Alice Co');
    await tenant('bob@example.test', 'Bob Co', 'operator', AGENT_B, 'bobs-agent');

    const foreign = await put(a, VALID_POLICY, AGENT_B);
    const nonexistent = await put(a, VALID_POLICY, UNKNOWN_UUID);

    expect(foreign.status).toBe(nonexistent.status);
    expect(await foreign.text()).toBe(await nonexistent.text());
  });

  it('two workspaces keep independent versions', async () => {
    const a = await tenant('alice@example.test', 'Alice Co');
    const b = await tenant('bob@example.test', 'Bob Co', 'operator', AGENT_B, 'bobs-agent');

    await saved(a, VALID_POLICY);
    await saved(a, VALID_POLICY);

    expect(mutations.versionOf(a.workspaceId)).toBe('3');
    expect(mutations.versionOf(b.workspaceId)).toBe('1');
  });

  it.each([
    ['a malformed agent id', 'not-a-uuid'],
    ['an unknown agent id', UNKNOWN_UUID],
  ])('returns 404 for %s without incrementing', async (_label, agentId) => {
    const t = await tenant('op@example.test', 'Acme');

    const response = await put(t, VALID_POLICY, agentId);

    expect(response.status).toBe(404);
    expect(mutations.versionOf(t.workspaceId)).toBe('1');
  });
});

describe('request validation', () => {
  it.each([
    ['an invalid mode', { ...VALID_POLICY, mode: 'enforce' }],
    ['a disabled mode', { ...VALID_POLICY, mode: 'disabled' }],
    ['a numeric spend cap', { ...VALID_POLICY, daily_spend_cap_usd: 25 }],
    ['a float spend cap', { ...VALID_POLICY, daily_spend_cap_usd: 25.5 }],
    ['a negative spend cap', { ...VALID_POLICY, daily_spend_cap_usd: '-5.000000' }],
    ['seven fractional digits', { ...VALID_POLICY, daily_spend_cap_usd: '1.0000001' }],
    ['exponent notation', { ...VALID_POLICY, daily_spend_cap_usd: '2.5e1' }],
    ['an over-capacity spend cap', { ...VALID_POLICY, daily_spend_cap_usd: '100000000.000000' }],
    ['a decimal publish cap', { ...VALID_POLICY, daily_publish_cap: 5.5 }],
    ['a negative publish cap', { ...VALID_POLICY, daily_publish_cap: -1 }],
    ['a string publish cap', { ...VALID_POLICY, daily_publish_cap: '5' }],
    ['a missing mode', { daily_spend_cap_usd: null, daily_publish_cap: null }],
    ['a missing spend cap', { mode: 'watch', daily_publish_cap: null }],
    ['an unknown field', { ...VALID_POLICY, enforce: true }],
    ['a workspace injection', { ...VALID_POLICY, workspace_id: 'other' }],
    ['a tenant injection', { ...VALID_POLICY, tenant_id: 'other' }],
    ['a client-supplied version', { ...VALID_POLICY, version: '99' }],
    ['an agent_id in the body', { ...VALID_POLICY, agent_id: 'other-agent' }],
    ['a credential in the body', { ...VALID_POLICY, api_key: 'hmp_live_x' }],
    ['an empty object', {}],
    ['an array', []],
    ['a string', 'budgeted'],
    ['null', null],
  ])('rejects %s with 400 and no increment', async (_label, body) => {
    const t = await tenant('op@example.test', 'Acme');

    const response = await put(t, body);

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe('invalid_policy');
    // Version is governance state: a rejected request must not move it.
    expect(mutations.versionOf(t.workspaceId)).toBe('1');
    expect(mutations.policyOf(t.workspaceId, AGENT_A)).toBeUndefined();
  });

  it('rejects malformed JSON safely', async () => {
    const t = await tenant('op@example.test', 'Acme');

    const response = await app.request(agentPolicyPath(t.workspaceId, AGENT_A), {
      method: 'PUT',
      headers: { cookie: t.cookie, origin: APP_URL, 'content-type': 'application/json' },
      body: '{not json',
    });

    expect(response.status).toBe(400);
    const raw = await response.text();
    expect(raw).not.toContain('SyntaxError');
    expect(mutations.versionOf(t.workspaceId)).toBe('1');
  });

  it('leaks no schema internals', async () => {
    const t = await tenant('op@example.test', 'Acme');

    const raw = await (await put(t, { ...VALID_POLICY, mode: 'nope' })).text();

    expect(raw).not.toContain('ZodError');
    expect(raw).not.toContain('invalid_enum_value');
    expect(raw).not.toMatch(/regex|select|agent_policies/i);
  });
});

describe('money and count boundaries', () => {
  it.each(['0.000000', '25.000000', '100.000000', '99999999.999999', '0.000001'])(
    'accepts spend cap %s exactly',
    async (cap) => {
      const t = await tenant('op@example.test', 'Acme');

      const body = await saved(t, { ...VALID_POLICY, daily_spend_cap_usd: cap });

      // Byte-identical: no float round trip anywhere on the path.
      expect(body.policy.daily_spend_cap_usd).toBe(cap);
    },
  );

  it('distinguishes a ZERO cap from an absent one', async () => {
    const t = await tenant('op@example.test', 'Acme');

    const zero = await saved(t, {
      mode: 'budgeted',
      daily_spend_cap_usd: '0.000000',
      daily_publish_cap: 0,
    });

    // 0 = nothing permitted; null = no limit. Never normalised to each other.
    expect(zero.policy.daily_spend_cap_usd).toBe('0.000000');
    expect(zero.policy.daily_publish_cap).toBe(0);
    expect(await (await put(t, VALID_POLICY)).text()).not.toContain('"daily_publish_cap":null');
  });

  it.each([0, 5, 100, 2_147_483_647])('accepts publish cap %i', async (cap) => {
    const t = await tenant('op@example.test', 'Acme');

    expect((await saved(t, { ...VALID_POLICY, daily_publish_cap: cap })).policy
      .daily_publish_cap).toBe(cap);
  });

  it('accepts both caps null', async () => {
    const t = await tenant('op@example.test', 'Acme');

    const body = await saved(t, {
      mode: 'watch',
      daily_spend_cap_usd: null,
      daily_publish_cap: null,
    });

    expect(body.policy.daily_spend_cap_usd).toBeNull();
    expect(body.policy.daily_publish_cap).toBeNull();
  });
});

describe('missing policy state', () => {
  it('fails safely and writes nothing', async () => {
    const { cookie, userId } = await signIn('op@example.test');
    // A workspace that somehow escaped provisioning: no policy state row.
    const workspaceId = workspaces.seedWorkspace('Orphan', [{ userId, role: 'operator' }]);
    mutations.seedAgent(workspaceId, AGENT_A, 'agent-a');

    const response = await app.request(agentPolicyPath(workspaceId, AGENT_A), {
      method: 'PUT',
      headers: { cookie, origin: APP_URL, 'content-type': 'application/json' },
      body: JSON.stringify(VALID_POLICY),
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'internal_error' });
    // No self-healing: no version row created, and no agent policy row either.
    expect(mutations.versionOf(workspaceId)).toBeUndefined();
    expect(mutations.policyOf(workspaceId, AGENT_A)).toBeUndefined();
  });

  it('leaks no SQL or table name', async () => {
    const { cookie, userId } = await signIn('op@example.test');
    const workspaceId = workspaces.seedWorkspace('Orphan', [{ userId, role: 'operator' }]);
    mutations.seedAgent(workspaceId, AGENT_A, 'agent-a');

    const raw = await (
      await app.request(agentPolicyPath(workspaceId, AGENT_A), {
        method: 'PUT',
        headers: { cookie, origin: APP_URL, 'content-type': 'application/json' },
        body: JSON.stringify(VALID_POLICY),
      })
    ).text();

    expect(raw).not.toContain('workspace_policy_state');
    expect(raw).not.toContain(workspaceId);
  });
});

describe('atomicity', () => {
  it('a failed version bump rolls the policy write back', async () => {
    const t = await tenant('op@example.test', 'Acme');
    mutations.failVersionBump = true;

    const response = await put(t, VALID_POLICY);

    expect(response.status).toBe(500);
    // Neither half may survive alone: a policy changed without a version bump
    // would be invisible to every polling agent.
    expect(mutations.policyOf(t.workspaceId, AGENT_A)).toBeUndefined();
    expect(mutations.versionOf(t.workspaceId)).toBe('1');
  });

  it('recovers on the next attempt', async () => {
    const t = await tenant('op@example.test', 'Acme');
    mutations.failVersionBump = true;
    await put(t, VALID_POLICY);

    mutations.failVersionBump = false;
    const body = await saved(t, VALID_POLICY);

    // The failed attempt consumed no version.
    expect(body.version).toBe('2');
  });
});

describe('no other mutation surface', () => {
  it.each(['POST', 'PATCH', 'DELETE'])('refuses %s on the policy path', async (method) => {
    const t = await tenant('op@example.test', 'Acme');

    const response = await app.request(agentPolicyPath(t.workspaceId, AGENT_A), {
      method,
      headers: { cookie: t.cookie, origin: APP_URL, 'content-type': 'application/json' },
      body: JSON.stringify(VALID_POLICY),
    });

    // PUT is the single mutation surface; no /set-mode, /pause or /set-cap.
    expect(response.status).toBe(404);
    expect(mutations.versionOf(t.workspaceId)).toBe('1');
  });

  it('exposes no verb-style policy routes', async () => {
    const t = await tenant('op@example.test', 'Acme');
    const base = `/v1/workspaces/${t.workspaceId}/agents/${AGENT_A}`;

    for (const path of [
      `${base}/policy/mode`,
      `${base}/pause`,
      `${base}/set-spend-cap`,
      `/v1/workspaces/${t.workspaceId}/policy`,
    ]) {
      const response = await app.request(path, {
        method: 'PUT',
        headers: { cookie: t.cookie, origin: APP_URL, 'content-type': 'application/json' },
        body: JSON.stringify(VALID_POLICY),
      });
      expect(response.status, path).toBe(404);
    }
  });
});

describe('unavailable without a database', () => {
  it('reports 503 rather than crashing', async () => {
    const noDb = createApp({ probeDatabase: () => Promise.resolve('unconfigured') });

    const response = await noDb.request(agentPolicyPath('any', AGENT_A), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(VALID_POLICY),
    });

    expect(response.status).toBe(503);
  });

  it('leaves liveness unaffected', async () => {
    const noDb = createApp({ probeDatabase: () => Promise.resolve('unconfigured') });

    expect((await noDb.request('/healthz')).status).toBe(200);
  });
});
