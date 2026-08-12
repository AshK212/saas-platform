import {
  AGENT_REGISTER_PATH,
  AUTH_CALLBACK_PATH,
  AUTH_MAGIC_LINK_PATH,
  agentListResponseSchema,
  agentResponseSchema,
  registerAgentResponseSchema,
  workspaceAgentPath,
  workspaceAgentsPath,
  workspaceApiKeysPath,
} from '@hybrid/contracts';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { createFixedClock } from '../src/auth/clock';
import { AUTH_COOKIE_NAME } from '../src/auth/cookie';
import { createCapturingEmailSender, type CapturingEmailSender } from '../src/auth/email';
import { createAuthService, type AuthService } from '../src/auth/service';
import { createMemoryAgentStore, type MemoryAgentStore } from './helpers/memory-agent-store';
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
let agents: MemoryAgentStore;
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
  agents = createMemoryAgentStore();
  app = createApp({
    probeDatabase: () => Promise.resolve('ok'),
    authService: service,
    appUrl: APP_URL,
    secureCookies: true,
    workspaceStore: workspaces,
    apiKeyStore: apiKeys,
    agentStore: agents,
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

/** Signs in an operator, creates a workspace and issues an API key for it. */
async function tenant(
  email: string,
  name: string,
): Promise<{ workspaceId: string; key: string; cookie: string }> {
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

async function register(key: string, body: unknown): Promise<Response> {
  return app.request(AGENT_REGISTER_PATH, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /v1/agents/register', () => {
  it('registers an agent inside the credential workspace', async () => {
    const t = await tenant('op@example.test', 'Acme');

    const response = await register(t.key, { agent_id: 'agent-a', name: 'Agent A' });

    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(registerAgentResponseSchema.safeParse(body).success).toBe(true);
    expect(body).toEqual({
      agent: { agent_id: 'agent-a', name: 'Agent A', last_seen_at: START.toISOString() },
    });
    expect(agents.agents[0]?.workspaceId).toBe(t.workspaceId);
  });

  it('IDEMPOTENT: the same agent_id resolves the same agent', async () => {
    const t = await tenant('op@example.test', 'Acme');

    const first = await register(t.key, { agent_id: 'agent-a' });
    clock.advance(5_000);
    const second = await register(t.key, { agent_id: 'agent-a' });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    // One logical agent, not two.
    expect(agents.agents).toHaveLength(1);
  });

  it('preserves an existing name when a later registration omits one', async () => {
    const t = await tenant('op@example.test', 'Acme');

    await register(t.key, { agent_id: 'agent-a', name: 'Agent A' });
    await register(t.key, { agent_id: 'agent-a' });

    // Omitting the name must not blank it.
    expect(agents.agents[0]?.displayName).toBe('Agent A');
  });

  it('updates the name when one is supplied', async () => {
    const t = await tenant('op@example.test', 'Acme');

    await register(t.key, { agent_id: 'agent-a', name: 'Agent A' });
    await register(t.key, { agent_id: 'agent-a', name: 'Renamed' });

    expect(agents.agents[0]?.displayName).toBe('Renamed');
  });

  it('rejects an unauthenticated caller', async () => {
    await tenant('op@example.test', 'Acme');

    const response = await app.request(AGENT_REGISTER_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent_id: 'agent-a' }),
    });

    expect(response.status).toBe(401);
    expect(agents.agents).toHaveLength(0);
  });

  it('rejects a browser session cookie', async () => {
    const t = await tenant('op@example.test', 'Acme');

    const response = await app.request(AGENT_REGISTER_PATH, {
      method: 'POST',
      headers: { cookie: t.cookie, origin: APP_URL, 'content-type': 'application/json' },
      body: JSON.stringify({ agent_id: 'agent-a' }),
    });

    // Machine registration is bearer-only; a session is not a machine identity.
    expect(response.status).toBe(401);
    expect(agents.agents).toHaveLength(0);
  });

  it('rejects a revoked key', async () => {
    const t = await tenant('op@example.test', 'Acme');
    const credentialId = apiKeys.credentials[0]?.id ?? '';
    await app.request(`${workspaceApiKeysPath(t.workspaceId)}/${credentialId}/revoke`, {
      method: 'POST',
      headers: { cookie: t.cookie, origin: APP_URL },
    });

    expect((await register(t.key, { agent_id: 'agent-a' })).status).toBe(401);
    expect(agents.agents).toHaveLength(0);
  });

  it('never accepts a key from the query string', async () => {
    const t = await tenant('op@example.test', 'Acme');

    const response = await app.request(`${AGENT_REGISTER_PATH}?api_key=${t.key}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent_id: 'agent-a' }),
    });

    expect(response.status).toBe(401);
  });

  it.each([
    ['missing agent_id', {}],
    ['empty agent_id', { agent_id: '' }],
    ['whitespace agent_id', { agent_id: '   ' }],
    ['over-long agent_id', { agent_id: 'x'.repeat(121) }],
    ['wrong type', { agent_id: 42 }],
    ['empty name', { agent_id: 'a', name: '' }],
  ])('rejects %s', async (_label, body) => {
    const t = await tenant('op@example.test', 'Acme');

    expect((await register(t.key, body)).status).toBe(400);
    expect(agents.agents).toHaveLength(0);
  });

  it('rejects a malformed JSON body without leaking a parser error', async () => {
    const t = await tenant('op@example.test', 'Acme');

    const response = await app.request(AGENT_REGISTER_PATH, {
      method: 'POST',
      headers: { authorization: `Bearer ${t.key}`, 'content-type': 'application/json' },
      body: '{not json',
    });

    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain('JSON');
  });
});

describe('WORKSPACE COMES FROM THE CREDENTIAL', () => {
  it('ignores a workspace_id in the body', async () => {
    const a = await tenant('alice@example.test', 'Alice Co');
    const b = await tenant('bob@example.test', 'Bob Co');

    await register(a.key, {
      agent_id: 'agent-a',
      workspace_id: b.workspaceId,
      workspaceId: b.workspaceId,
    });

    expect(agents.agents).toHaveLength(1);
    expect(agents.agents[0]?.workspaceId).toBe(a.workspaceId);
  });

  it('ignores an X-Workspace-Id header', async () => {
    const a = await tenant('alice@example.test', 'Alice Co');
    const b = await tenant('bob@example.test', 'Bob Co');

    await app.request(AGENT_REGISTER_PATH, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${a.key}`,
        'x-workspace-id': b.workspaceId,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ agent_id: 'agent-a' }),
    });

    expect(agents.agents[0]?.workspaceId).toBe(a.workspaceId);
  });

  it('ignores a client-supplied last_seen_at', async () => {
    const t = await tenant('op@example.test', 'Acme');
    const lie = new Date('2099-01-01T00:00:00.000Z').toISOString();

    const response = await register(t.key, { agent_id: 'agent-a', last_seen_at: lie });
    const body = (await response.json()) as { agent: { last_seen_at: string } };

    // Server time wins; the schema has no such field to begin with.
    expect(body.agent.last_seen_at).toBe(START.toISOString());
    expect(agents.agents[0]?.lastSeenAt).toEqual(START);
  });

  it('ignores a client-supplied runtime profile', async () => {
    const t = await tenant('op@example.test', 'Acme');

    await register(t.key, {
      agent_id: 'agent-a',
      runtime_profile_id: '11111111-1111-4111-8111-111111111111',
    });

    // Runtime profile linking is not part of Step 8 at all.
    expect(agents.agents[0]?.runtimeProfileId).toBeNull();
  });
});

describe('last-seen semantics', () => {
  it('sets last-seen on first registration', async () => {
    const t = await tenant('op@example.test', 'Acme');

    await register(t.key, { agent_id: 'agent-a' });

    expect(agents.agents[0]?.lastSeenAt).toEqual(START);
  });

  it('advances last-seen on re-registration', async () => {
    const t = await tenant('op@example.test', 'Acme');
    await register(t.key, { agent_id: 'agent-a' });

    clock.advance(45_000);
    await register(t.key, { agent_id: 'agent-a' });

    expect(agents.agents[0]?.lastSeenAt).toEqual(new Date(START.getTime() + 45_000));
  });

  it('does not preserve a stale value after valid activity', async () => {
    const t = await tenant('op@example.test', 'Acme');
    await register(t.key, { agent_id: 'agent-a' });
    const stale = agents.agents[0]?.lastSeenAt;

    clock.advance(120_000);
    await register(t.key, { agent_id: 'agent-a' });

    expect(agents.agents[0]?.lastSeenAt).not.toEqual(stale);
  });

  it('AC-04: three agents all report last-seen within 60 seconds', async () => {
    const t = await tenant('op@example.test', 'Acme');

    await register(t.key, { agent_id: 'agent-a', name: 'Agent A' });
    clock.advance(10_000);
    await register(t.key, { agent_id: 'agent-b', name: 'Agent B' });
    clock.advance(10_000);
    await register(t.key, { agent_id: 'agent-c', name: 'Agent C' });

    const response = await app.request(workspaceAgentsPath(t.workspaceId), {
      headers: { cookie: t.cookie },
    });
    const body = (await response.json()) as { agents: { agentId: string; lastSeenAt: string }[] };

    expect(body.agents).toHaveLength(3);
    const nowMs = clock.now().getTime();
    for (const agent of body.agents) {
      const age = nowMs - new Date(agent.lastSeenAt).getTime();
      expect(age).toBeLessThanOrEqual(60_000);
    }
  });

  it('lists most recently seen first', async () => {
    const t = await tenant('op@example.test', 'Acme');
    await register(t.key, { agent_id: 'agent-a' });
    clock.advance(1_000);
    await register(t.key, { agent_id: 'agent-b' });

    const body = (await (
      await app.request(workspaceAgentsPath(t.workspaceId), { headers: { cookie: t.cookie } })
    ).json()) as { agents: { agentId: string }[] };

    expect(body.agents.map((a) => a.agentId)).toEqual(['agent-b', 'agent-a']);
  });
});

describe('operator agent reads', () => {
  it('rejects an unauthenticated caller', async () => {
    const t = await tenant('op@example.test', 'Acme');

    expect((await app.request(workspaceAgentsPath(t.workspaceId))).status).toBe(401);
  });

  it('rejects an API key on the operator roster', async () => {
    const t = await tenant('op@example.test', 'Acme');
    await register(t.key, { agent_id: 'agent-a' });

    const response = await app.request(workspaceAgentsPath(t.workspaceId), {
      headers: { authorization: `Bearer ${t.key}` },
    });

    // Domain separation: a machine credential is not an operator identity.
    expect(response.status).toBe(401);
  });

  it('returns safe metadata only', async () => {
    const t = await tenant('op@example.test', 'Acme');
    await register(t.key, { agent_id: 'agent-a', name: 'Agent A' });

    const response = await app.request(workspaceAgentsPath(t.workspaceId), {
      headers: { cookie: t.cookie },
    });
    const body = (await response.json()) as { agents: Record<string, unknown>[] };

    expect(agentListResponseSchema.safeParse(body).success).toBe(true);
    expect(Object.keys(body.agents[0] ?? {}).sort()).toEqual([
      'agentId',
      'createdAt',
      'id',
      'lastSeenAt',
      'name',
    ]);
  });

  it('exposes no policy, mode or credential material', async () => {
    const t = await tenant('op@example.test', 'Acme');
    await register(t.key, { agent_id: 'agent-a' });

    const raw = await (
      await app.request(workspaceAgentsPath(t.workspaceId), { headers: { cookie: t.cookie } })
    ).text();

    for (const forbidden of ['mode', 'cap', 'paused', 'policy', 'secret', 'hash', 'runtimeProfile']) {
      expect(raw.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it('allows a member, not only an operator', async () => {
    const t = await tenant('op@example.test', 'Acme');
    await register(t.key, { agent_id: 'agent-a' });
    const member = await signIn('member@example.test');
    workspaces.memberships.push({
      workspaceId: t.workspaceId,
      userId: member.userId,
      role: 'member',
    });

    // The roster is ordinary tenant data, unlike credentials.
    const response = await app.request(workspaceAgentsPath(t.workspaceId), {
      headers: { cookie: member.cookie },
    });

    expect(response.status).toBe(200);
  });

  it('returns an empty list for a workspace with no agents', async () => {
    const t = await tenant('op@example.test', 'Acme');

    const response = await app.request(workspaceAgentsPath(t.workspaceId), {
      headers: { cookie: t.cookie },
    });

    expect(await response.json()).toEqual({ agents: [] });
  });

  it('fetches one agent by internal id', async () => {
    const t = await tenant('op@example.test', 'Acme');
    await register(t.key, { agent_id: 'agent-a', name: 'Agent A' });
    const id = agents.agents[0]?.id ?? '';

    const response = await app.request(workspaceAgentPath(t.workspaceId, id), {
      headers: { cookie: t.cookie },
    });

    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(agentResponseSchema.safeParse(body).success).toBe(true);
    expect((body as { agent: { agentId: string } }).agent.agentId).toBe('agent-a');
  });

  it.each([
    ['a malformed id', 'not-a-uuid'],
    ['a sql fragment', "' OR 1=1 --"],
    ['an unknown id', '11111111-1111-4111-8111-111111111111'],
  ])('returns 404 for %s', async (_label, id) => {
    const t = await tenant('op@example.test', 'Acme');

    const response = await app.request(
      `${workspaceAgentsPath(t.workspaceId)}/${encodeURIComponent(id)}`,
      { headers: { cookie: t.cookie } },
    );

    expect(response.status).toBe(404);
  });
});

describe('CROSS-TENANT isolation', () => {
  it('the same agent_id in two workspaces yields two independent agents', async () => {
    const a = await tenant('alice@example.test', 'Alice Co');
    const b = await tenant('bob@example.test', 'Bob Co');

    await register(a.key, { agent_id: 'agent-1', name: 'Alice Agent' });
    await register(b.key, { agent_id: 'agent-1', name: 'Bob Agent' });

    expect(agents.agents).toHaveLength(2);
    const ids = agents.agents.map((x) => x.id);
    expect(new Set(ids).size).toBe(2);
  });

  it('each operator sees only their own agent', async () => {
    const a = await tenant('alice@example.test', 'Alice Co');
    const b = await tenant('bob@example.test', 'Bob Co');
    await register(a.key, { agent_id: 'agent-1', name: 'Alice Agent' });
    await register(b.key, { agent_id: 'agent-1', name: 'Bob Agent' });

    const listA = (await (
      await app.request(workspaceAgentsPath(a.workspaceId), { headers: { cookie: a.cookie } })
    ).json()) as { agents: { name: string }[] };
    const listB = (await (
      await app.request(workspaceAgentsPath(b.workspaceId), { headers: { cookie: b.cookie } })
    ).json()) as { agents: { name: string }[] };

    expect(listA.agents.map((x) => x.name)).toEqual(['Alice Agent']);
    expect(listB.agents.map((x) => x.name)).toEqual(['Bob Agent']);
  });

  it("B's internal agent id queried through A returns not-found", async () => {
    const a = await tenant('alice@example.test', 'Alice Co');
    const b = await tenant('bob@example.test', 'Bob Co');
    await register(b.key, { agent_id: 'agent-1', name: 'Bob Agent' });
    const bobsAgentId = agents.agents[0]?.id ?? '';

    const response = await app.request(workspaceAgentPath(a.workspaceId, bobsAgentId), {
      headers: { cookie: a.cookie },
    });

    // Holding the exact UUID grants nothing.
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('Bob Agent');
  });

  it('a non-member cannot list another workspace roster', async () => {
    const a = await tenant('alice@example.test', 'Alice Co');
    const b = await tenant('bob@example.test', 'Bob Co');
    await register(b.key, { agent_id: 'agent-1', name: 'Bob Agent' });

    const response = await app.request(workspaceAgentsPath(b.workspaceId), {
      headers: { cookie: a.cookie },
    });

    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('Bob Agent');
  });

  it("registering with A's key never touches B's agent", async () => {
    const a = await tenant('alice@example.test', 'Alice Co');
    const b = await tenant('bob@example.test', 'Bob Co');
    await register(b.key, { agent_id: 'agent-1', name: 'Bob Agent' });
    const before = agents.agents[0]?.lastSeenAt;

    clock.advance(30_000);
    await register(a.key, { agent_id: 'agent-1' });

    const bobsAgent = agents.agents.find((x) => x.workspaceId === b.workspaceId);
    expect(bobsAgent?.lastSeenAt).toEqual(before);
    expect(bobsAgent?.displayName).toBe('Bob Agent');
  });
});

describe('unavailable without a database', () => {
  it('registration reports 503', async () => {
    const noDb = createApp({ probeDatabase: () => Promise.resolve('unconfigured') });

    const response = await noDb.request(AGENT_REGISTER_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent_id: 'a' }),
    });

    expect(response.status).toBe(503);
  });

  it('/healthz stays 200', async () => {
    const noDb = createApp({ probeDatabase: () => Promise.resolve('unconfigured') });

    expect((await noDb.request('/healthz')).status).toBe(200);
  });
});
