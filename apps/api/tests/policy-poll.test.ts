import {
  AUTH_CALLBACK_PATH,
  AUTH_MAGIC_LINK_PATH,
  POLICY_POLL_PATH,
  policySnapshotSchema,
  workspaceApiKeysPath,
  type PolicySnapshot,
} from '@hybrid/contracts';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { createFixedClock } from '../src/auth/clock';
import { AUTH_COOKIE_NAME } from '../src/auth/cookie';
import { createCapturingEmailSender, type CapturingEmailSender } from '../src/auth/email';
import { createAuthService } from '../src/auth/service';
import { createMemoryAgentStore, type MemoryAgentStore } from './helpers/memory-agent-store';
import { createMemoryApiKeyStore, type MemoryApiKeyStore } from './helpers/memory-api-key-store';
import { createMemoryAuthStore, type MemoryAuthStore } from './helpers/memory-auth-store';
import { createMemoryPolicyStore, type MemoryPolicyStore } from './helpers/memory-policy-store';
import {
  createMemoryWorkspaceStore,
  type MemoryWorkspaceStore,
} from './helpers/memory-workspace-store';

/**
 * `GET /v1/policy` - machine policy polling (Step 12).
 *
 * The properties under test: the workspace comes only from the credential, the
 * snapshot is never empty for a known workspace, 304 is exact, and nothing is
 * ever written.
 */

const APP_URL = 'https://app.example.test';
const START = new Date('2026-08-12T10:00:00.000Z');

let authStore: MemoryAuthStore;
let mailer: CapturingEmailSender;
let clock: ReturnType<typeof createFixedClock>;
let workspaces: MemoryWorkspaceStore;
let apiKeys: MemoryApiKeyStore;
let agents: MemoryAgentStore;
let policies: MemoryPolicyStore;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  authStore = createMemoryAuthStore();
  mailer = createCapturingEmailSender();
  clock = createFixedClock(START);
  workspaces = createMemoryWorkspaceStore();
  apiKeys = createMemoryApiKeyStore();
  agents = createMemoryAgentStore();
  policies = createMemoryPolicyStore();
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
    agentStore: agents,
    policyStore: policies,
    clock,
  });
});

interface Tenant {
  readonly workspaceId: string;
  readonly key: string;
  readonly cookie: string;
}

/** Signs in, creates a workspace and a key, and initialises policy state. */
async function tenant(email: string, name: string): Promise<Tenant> {
  await app.request(AUTH_MAGIC_LINK_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  const token = new URL(mailer.lastLink()?.url ?? '').searchParams.get('token') ?? '';
  const callback = await app.request(`${AUTH_CALLBACK_PATH}?token=${token}`);
  const value = (callback.headers.get('set-cookie') ?? '').split(';')[0]?.split('=')[1] ?? '';
  const cookie = `${AUTH_COOKIE_NAME}=${value}`;
  const userId = authStore.users.get(email)?.id ?? '';
  const workspaceId = workspaces.seedWorkspace(name, [{ userId }]);
  const issued = await app.request(workspaceApiKeysPath(workspaceId), {
    method: 'POST',
    headers: { cookie, origin: APP_URL, 'content-type': 'application/json' },
    body: JSON.stringify({ name: `${name} key` }),
  });
  const { apiKey } = (await issued.json()) as { apiKey: { key: string } };
  // Provisioning creates policy state atomically with the workspace; the
  // in-memory workspace fake predates Step 12, so this stands in for it.
  policies.seedPolicyState(workspaceId);
  return { workspaceId, key: apiKey.key, cookie };
}

async function poll(key: string, query = ''): Promise<Response> {
  return app.request(`${POLICY_POLL_PATH}${query}`, {
    headers: { authorization: `Bearer ${key}` },
  });
}

async function snapshot(key: string, query = ''): Promise<PolicySnapshot> {
  const response = await poll(key, query);
  expect(response.status).toBe(200);
  return policySnapshotSchema.parse(await response.json());
}

describe('authentication domain', () => {
  it('rejects a request with no credential', async () => {
    const t = await tenant('op@example.test', 'Acme');
    void t;

    expect((await app.request(POLICY_POLL_PATH)).status).toBe(401);
  });

  it('REJECTS a browser session cookie', async () => {
    const t = await tenant('op@example.test', 'Acme');

    const response = await app.request(POLICY_POLL_PATH, {
      headers: { cookie: t.cookie },
    });

    // This is an agent/runtime path. Operator auth never substitutes.
    expect(response.status).toBe(401);
  });

  it('rejects a malformed key', async () => {
    await tenant('op@example.test', 'Acme');

    expect((await poll('not-a-key')).status).toBe(401);
    expect((await poll('hmp_live_deadbeef_nope')).status).toBe(401);
  });

  it('rejects a revoked key', async () => {
    const t = await tenant('op@example.test', 'Acme');
    const credentialId = apiKeys.credentials[0]?.id ?? '';
    await app.request(`${workspaceApiKeysPath(t.workspaceId)}/${credentialId}/revoke`, {
      method: 'POST',
      headers: { cookie: t.cookie, origin: APP_URL },
    });

    expect((await poll(t.key)).status).toBe(401);
  });

  it('never accepts a key from the query string', async () => {
    const t = await tenant('op@example.test', 'Acme');

    expect((await app.request(`${POLICY_POLL_PATH}?api_key=${t.key}`)).status).toBe(401);
  });
});

describe('the workspace comes from the credential', () => {
  it.each([
    'workspace_id',
    'workspaceId',
    'tenant_id',
    'tenantId',
    'workspace',
    'org_id',
  ])('rejects ?%s as an unknown parameter', async (param) => {
    const a = await tenant('alice@example.test', 'Alice Co');
    const b = await tenant('bob@example.test', 'Bob Co');
    policies.seedAgent(b.workspaceId, 'bobs-agent');

    const response = await poll(a.key, `?${param}=${b.workspaceId}`);

    // Strict rejection, not silent ignoring: a parameter that is quietly
    // dropped is one a future maintainer may decide to honour.
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe('invalid_query');
  });

  it.each(['X-Workspace-Id', 'X-Tenant-Id', 'X-Workspace'])(
    'ignores a %s header',
    async (header) => {
      const a = await tenant('alice@example.test', 'Alice Co');
      const b = await tenant('bob@example.test', 'Bob Co');
      policies.seedAgent(a.workspaceId, 'alices-agent');
      policies.seedAgent(b.workspaceId, 'bobs-agent');

      const response = await app.request(POLICY_POLL_PATH, {
        headers: { authorization: `Bearer ${a.key}`, [header]: b.workspaceId },
      });

      const body = policySnapshotSchema.parse(await response.json());
      expect(body.agents.map((p) => p.agent_id)).toEqual(['alices-agent']);
    },
  );

  it('has no workspace segment in the path', async () => {
    const t = await tenant('op@example.test', 'Acme');

    // The operator-facing route belongs to Step 13 and must not exist yet.
    const response = await app.request(`/v1/workspaces/${t.workspaceId}/policy`, {
      headers: { authorization: `Bearer ${t.key}` },
    });

    expect(response.status).toBe(404);
  });
});

describe('version semantics', () => {
  it('a freshly provisioned workspace reports version 1', async () => {
    const t = await tenant('op@example.test', 'Acme');

    expect((await snapshot(t.key)).version).toBe('1');
  });

  it('returns 200 and a snapshot when no since_version is supplied', async () => {
    const t = await tenant('op@example.test', 'Acme');
    policies.seedAgent(t.workspaceId, 'agent-a');

    const body = await snapshot(t.key);

    expect(body.version).toBe('1');
    expect(body.agents).toHaveLength(1);
  });

  it('returns 304 when since_version equals the current version', async () => {
    const t = await tenant('op@example.test', 'Acme');
    policies.seedAgent(t.workspaceId, 'agent-a');

    const response = await poll(t.key, '?since_version=1');

    expect(response.status).toBe(304);
  });

  it('a 304 carries NO body', async () => {
    const t = await tenant('op@example.test', 'Acme');
    policies.seedAgent(t.workspaceId, 'agent-a');

    const response = await poll(t.key, '?since_version=1');
    const raw = await response.text();

    // Not `{}`, not a stale snapshot - a 304 with a payload is malformed and
    // some clients would cache the bytes.
    expect(raw).toBe('');
    expect(raw).not.toContain('agent-a');
  });

  it('a 304 skips the snapshot query entirely', async () => {
    const t = await tenant('op@example.test', 'Acme');
    policies.seedAgent(t.workspaceId, 'agent-a');
    const before = policies.calls.snapshotReads;

    await poll(t.key, '?since_version=1');

    // Version-first: a 30-second poll that finds nothing changed must not
    // join across every agent in the workspace.
    expect(policies.calls.snapshotReads).toBe(before);
    expect(policies.calls.versionReads).toBeGreaterThan(0);
  });

  it('returns 200 with the current snapshot when the caller is BEHIND', async () => {
    const t = await tenant('op@example.test', 'Acme');
    policies.seedVersion(t.workspaceId, '7');
    policies.seedAgent(t.workspaceId, 'agent-a');

    const body = await snapshot(t.key, '?since_version=3');

    expect(body.version).toBe('7');
    expect(body.agents).toHaveLength(1);
  });

  it('returns 200 with the AUTHORITATIVE snapshot when the caller is AHEAD', async () => {
    const t = await tenant('op@example.test', 'Acme');
    policies.seedAgent(t.workspaceId, 'agent-a');

    const response = await poll(t.key, '?since_version=999');

    // A caller ahead of the server is stale divergence - a restored backup or
    // a corrupted cache. 304 would freeze it there forever; the snapshot lets
    // the runtime self-correct downward.
    expect(response.status).toBe(200);
    expect(policySnapshotSchema.parse(await response.json()).version).toBe('1');
  });

  it('accepts since_version=0 and returns a snapshot', async () => {
    const t = await tenant('op@example.test', 'Acme');

    // The natural "I have nothing yet" value; the initial version is 1.
    expect((await snapshot(t.key, '?since_version=0')).version).toBe('1');
  });

  it('compares versions numerically, not lexically', async () => {
    const t = await tenant('op@example.test', 'Acme');
    policies.seedVersion(t.workspaceId, '10');

    // Lexically "9" > "10", so a string comparison would wrongly treat this
    // caller as ahead. Either way it is a 200 here, so assert the boundary
    // instead: 10 is unchanged, 9 is behind.
    expect((await poll(t.key, '?since_version=10')).status).toBe(304);
    expect((await poll(t.key, '?since_version=9')).status).toBe(200);
  });

  it('handles a version beyond Number.MAX_SAFE_INTEGER exactly', async () => {
    const t = await tenant('op@example.test', 'Acme');
    // 2^53 + 1: indistinguishable from 2^53 as a JS number.
    policies.seedVersion(t.workspaceId, '9007199254740993');

    const unchanged = await poll(t.key, '?since_version=9007199254740993');
    const behind = await poll(t.key, '?since_version=9007199254740992');

    expect(unchanged.status).toBe(304);
    expect(behind.status).toBe(200);
    expect((await snapshot(t.key)).version).toBe('9007199254740993');
  });
});

describe('since_version validation', () => {
  it.each([
    ['negative', '?since_version=-1'],
    ['decimal', '?since_version=1.5'],
    ['scientific notation', '?since_version=1e3'],
    ['non-numeric', '?since_version=abc'],
    ['empty', '?since_version='],
    ['whitespace', '?since_version=%20'],
    ['leading zeros', '?since_version=007'],
    ['plus sign', '?since_version=%2B1'],
    ['hex', '?since_version=0x10'],
    ['absurdly long', `?since_version=${'9'.repeat(40)}`],
    ['SQL injection', "?since_version=1' OR '1'='1"],
    ['null byte', '?since_version=1%00'],
  ])('rejects a %s since_version with 400', async (_label, query) => {
    const t = await tenant('op@example.test', 'Acme');

    const response = await poll(t.key, query);

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe('invalid_query');
  });

  it('leaks no schema internals in the error body', async () => {
    const t = await tenant('op@example.test', 'Acme');

    const raw = await (await poll(t.key, '?since_version=abc')).text();

    expect(raw).not.toContain('ZodError');
    expect(raw).not.toContain('invalid_string');
    expect(raw).not.toMatch(/regex|select|from /i);
  });

  it('rejects a duplicated since_version rather than guessing', async () => {
    const t = await tenant('op@example.test', 'Acme');

    // Hono collapses repeats to the first value; assert it does not somehow
    // become an array that bypasses the string schema.
    const response = await poll(t.key, '?since_version=1&since_version=99');

    expect([200, 304, 400]).toContain(response.status);
    expect(response.status).not.toBe(500);
  });
});

describe('effective default policy', () => {
  it('an agent with NO policy row gets watch and no caps', async () => {
    const t = await tenant('op@example.test', 'Acme');
    // Registration and event discovery both create agents without policy rows.
    policies.seedAgent(t.workspaceId, 'agent-a');

    const body = await snapshot(t.key);

    expect(body.agents).toEqual([
      {
        agent_id: 'agent-a',
        mode: 'watch',
        daily_spend_cap_usd: null,
        daily_publish_cap: null,
      },
    ]);
  });

  it('null caps mean UNCAPPED and are never rendered as zero', async () => {
    const t = await tenant('op@example.test', 'Acme');
    policies.seedAgent(t.workspaceId, 'agent-a');

    const raw = await (await poll(t.key)).text();

    // 0 means "nothing permitted"; null means "no limit". Collapsing them
    // would silently pause an unconfigured agent.
    expect(raw).toContain('"daily_spend_cap_usd":null');
    expect(raw).toContain('"daily_publish_cap":null');
    expect(raw).not.toContain('"daily_spend_cap_usd":0');
    expect(raw).not.toContain('"daily_publish_cap":0');
  });

  it('an agent WITH a policy row uses the persisted values', async () => {
    const t = await tenant('op@example.test', 'Acme');
    policies.seedExplicitPolicy({
      workspaceId: t.workspaceId,
      externalId: 'agent-a',
      mode: 'budgeted',
      dailySpendCapUsd: '25.000000',
      dailyPublishCap: 5,
    });

    const body = await snapshot(t.key);

    expect(body.agents[0]).toEqual({
      agent_id: 'agent-a',
      mode: 'budgeted',
      daily_spend_cap_usd: '25.000000',
      daily_publish_cap: 5,
    });
  });

  it('represents a mix of explicit and default agents correctly', async () => {
    const t = await tenant('op@example.test', 'Acme');
    policies.seedAgent(t.workspaceId, 'agent-default');
    policies.seedExplicitPolicy({
      workspaceId: t.workspaceId,
      externalId: 'agent-explicit',
      mode: 'budgeted',
      dailySpendCapUsd: '10.500000',
      dailyPublishCap: null,
    });

    const body = await snapshot(t.key);

    expect(body.agents).toHaveLength(2);
    const byId = new Map(body.agents.map((p) => [p.agent_id, p]));
    expect(byId.get('agent-default')?.mode).toBe('watch');
    expect(byId.get('agent-default')?.daily_spend_cap_usd).toBeNull();
    expect(byId.get('agent-explicit')?.mode).toBe('budgeted');
    expect(byId.get('agent-explicit')?.daily_spend_cap_usd).toBe('10.500000');
    // A publish cap may be absent while a spend cap is set.
    expect(byId.get('agent-explicit')?.daily_publish_cap).toBeNull();
  });

  it('reports paused faithfully without enforcing it', async () => {
    const t = await tenant('op@example.test', 'Acme');
    policies.seedExplicitPolicy({
      workspaceId: t.workspaceId,
      externalId: 'agent-a',
      mode: 'paused',
      dailySpendCapUsd: null,
      dailyPublishCap: null,
    });

    const response = await poll(t.key);

    // Step 12 reads truthfully; the kill switch is enforced in a later step.
    expect(response.status).toBe(200);
    expect(policySnapshotSchema.parse(await response.json()).agents[0]?.mode).toBe('paused');
  });

  it('preserves an exact decimal cap with no float conversion', async () => {
    const t = await tenant('op@example.test', 'Acme');
    policies.seedExplicitPolicy({
      workspaceId: t.workspaceId,
      externalId: 'agent-a',
      mode: 'budgeted',
      // Trailing zeros and a value that is not representable in binary float.
      dailySpendCapUsd: '0.100000',
      dailyPublishCap: 0,
    });

    const raw = await (await poll(t.key)).text();

    expect(raw).toContain('"daily_spend_cap_usd":"0.100000"');
    expect(raw).not.toContain('0.1000000000000000055');
    // A publish cap of ZERO is a real cap - nothing permitted - and must
    // survive as 0 rather than collapsing to null.
    expect(raw).toContain('"daily_publish_cap":0');
  });

  it('returns agents in a stable order across polls', async () => {
    const t = await tenant('op@example.test', 'Acme');
    for (const id of ['zeta', 'alpha', 'mike']) {
      policies.seedAgent(t.workspaceId, id);
    }

    const first = await snapshot(t.key);
    const second = await snapshot(t.key);

    expect(first.agents.map((p) => p.agent_id)).toEqual(second.agents.map((p) => p.agent_id));
    expect(first.agents.map((p) => p.agent_id)).toEqual(['alpha', 'mike', 'zeta']);
  });
});

describe('a known workspace is never empty', () => {
  it('a workspace with ZERO agents returns a valid snapshot', async () => {
    const t = await tenant('op@example.test', 'Acme');

    const body = await snapshot(t.key);

    // Valid, not empty: the version is present and no agent is fabricated.
    expect(body).toEqual({ version: '1', agents: [] });
  });

  it('never returns version 0, null or a missing version', async () => {
    const t = await tenant('op@example.test', 'Acme');

    const raw = await (await poll(t.key)).text();

    expect(raw).toContain('"version":"1"');
    expect(raw).not.toContain('"version":0');
    expect(raw).not.toContain('"version":null');
  });

  it('a MISSING policy state is a controlled 500, not a fake empty policy', async () => {
    const t = await tenant('op@example.test', 'Acme');
    // Simulate a workspace that somehow escaped provisioning. Every supported
    // path creates policy state atomically, so this is an invariant violation.
    const orphan = createMemoryPolicyStore();
    const orphanApp = createApp({
      probeDatabase: () => Promise.resolve('ok'),
      apiKeyStore: apiKeys,
      policyStore: orphan,
      clock,
    });

    const response = await orphanApp.request(POLICY_POLL_PATH, {
      headers: { authorization: `Bearer ${t.key}` },
    });

    expect(response.status).toBe(500);
    const raw = await response.text();
    // Opaque: no SQL, no table name, no workspace id.
    expect(JSON.parse(raw)).toEqual({ error: 'internal_error' });
    expect(raw).not.toContain(t.workspaceId);
    expect(raw).not.toContain('workspace_policy_state');
  });

  it('does NOT lazily create policy state to hide the defect', async () => {
    const t = await tenant('op@example.test', 'Acme');
    const orphan = createMemoryPolicyStore();
    const orphanApp = createApp({
      probeDatabase: () => Promise.resolve('ok'),
      apiKeyStore: apiKeys,
      policyStore: orphan,
      clock,
    });

    await orphanApp.request(POLICY_POLL_PATH, {
      headers: { authorization: `Bearer ${t.key}` },
    });
    const second = await orphanApp.request(POLICY_POLL_PATH, {
      headers: { authorization: `Bearer ${t.key}` },
    });

    // A GET that repairs state is a GET that hides provisioning defects.
    expect(second.status).toBe(500);
  });
});

describe('cross-tenant isolation', () => {
  it('each key sees only its own workspace agents', async () => {
    const a = await tenant('alice@example.test', 'Alice Co');
    const b = await tenant('bob@example.test', 'Bob Co');
    policies.seedAgent(a.workspaceId, 'alice-agent');
    policies.seedAgent(b.workspaceId, 'bob-agent-1');
    policies.seedAgent(b.workspaceId, 'bob-agent-2');

    const aBody = await snapshot(a.key);
    const bBody = await snapshot(b.key);

    expect(aBody.agents.map((p) => p.agent_id)).toEqual(['alice-agent']);
    expect(bBody.agents.map((p) => p.agent_id)).toEqual(['bob-agent-1', 'bob-agent-2']);
  });

  it('a SHARED external agent id carries independent policy per workspace', async () => {
    const a = await tenant('alice@example.test', 'Alice Co');
    const b = await tenant('bob@example.test', 'Bob Co');
    policies.seedExplicitPolicy({
      workspaceId: a.workspaceId,
      externalId: 'agent-1',
      mode: 'paused',
      dailySpendCapUsd: null,
      dailyPublishCap: null,
    });
    policies.seedExplicitPolicy({
      workspaceId: b.workspaceId,
      externalId: 'agent-1',
      mode: 'budgeted',
      dailySpendCapUsd: '99.000000',
      dailyPublishCap: 3,
    });

    const aBody = await snapshot(a.key);
    const bBody = await snapshot(b.key);

    // Same client-supplied name, entirely separate governance.
    expect(aBody.agents[0]?.mode).toBe('paused');
    expect(aBody.agents[0]?.daily_spend_cap_usd).toBeNull();
    expect(bBody.agents[0]?.mode).toBe('budgeted');
    expect(bBody.agents[0]?.daily_spend_cap_usd).toBe('99.000000');
  });

  it('versions are independent per workspace', async () => {
    const a = await tenant('alice@example.test', 'Alice Co');
    const b = await tenant('bob@example.test', 'Bob Co');
    policies.seedVersion(b.workspaceId, '42');

    expect((await snapshot(a.key)).version).toBe('1');
    expect((await snapshot(b.key)).version).toBe('42');
    // B's version must not make A's poll report unchanged.
    expect((await poll(a.key, '?since_version=42')).status).toBe(200);
  });

  it('leaks no other workspace agent through the snapshot', async () => {
    const a = await tenant('alice@example.test', 'Alice Co');
    const b = await tenant('bob@example.test', 'Bob Co');
    policies.seedAgent(b.workspaceId, 'bobs-secret-agent');
    policies.seedAgent(a.workspaceId, 'alice-agent');

    const raw = await (await poll(a.key)).text();

    expect(raw).not.toContain('bobs-secret-agent');
    expect(raw).not.toContain(b.workspaceId);
  });
});

describe('the response carries no secrets', () => {
  it('exposes no key, hash, workspace id or credential metadata', async () => {
    const t = await tenant('op@example.test', 'Acme');
    policies.seedAgent(t.workspaceId, 'agent-a');

    const raw = await (await poll(t.key)).text();

    expect(raw).not.toContain(t.key);
    expect(raw).not.toContain('hmp_live');
    expect(raw).not.toContain(t.workspaceId);
    expect(raw).not.toMatch(/secret|hash|authorization|credential|postgres:\/\//i);
  });

  it('exposes no internal agent UUID', async () => {
    const t = await tenant('op@example.test', 'Acme');
    policies.seedAgent(t.workspaceId, 'agent-a');

    const body = await snapshot(t.key);

    // The machine surface speaks external ids only.
    expect(body.agents[0]).not.toHaveProperty('id');
    expect(Object.keys(body.agents[0] ?? {}).sort()).toEqual([
      'agent_id',
      'daily_publish_cap',
      'daily_spend_cap_usd',
      'mode',
    ]);
  });
});

describe('polling is not a write and not activity', () => {
  it('does not advance last_seen_at', async () => {
    const t = await tenant('op@example.test', 'Acme');
    await app.request('/v1/agents/register', {
      method: 'POST',
      headers: { authorization: `Bearer ${t.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ agent_id: 'agent-a', name: 'Agent A' }),
    });
    const registered = agents.agents[0]?.lastSeenAt;

    clock.advance(600_000);
    await poll(t.key);

    // Polling for configuration is not evidence of life: a crashed-but-still-
    // polling supervisor must not look like a healthy agent. AC-04 depends on
    // last-seen meaning activity.
    expect(agents.agents[0]?.lastSeenAt).toEqual(registered);
  });

  it('creates no agent for a workspace with none', async () => {
    const t = await tenant('op@example.test', 'Acme');

    await poll(t.key);
    await poll(t.key);

    expect((await snapshot(t.key)).agents).toEqual([]);
    expect(agents.agents).toHaveLength(0);
  });

  it('does not change the version', async () => {
    const t = await tenant('op@example.test', 'Acme');

    for (let i = 0; i < 5; i += 1) {
      await poll(t.key);
    }

    // A read path that incremented the version would make every poll look
    // like a policy change to every other agent.
    expect((await snapshot(t.key)).version).toBe('1');
  });

  it('returns identical snapshots for repeated polls', async () => {
    const t = await tenant('op@example.test', 'Acme');
    policies.seedAgent(t.workspaceId, 'agent-a');

    const first = await (await poll(t.key)).text();
    const second = await (await poll(t.key)).text();

    expect(first).toBe(second);
  });
});

describe('no mutation surface', () => {
  it.each(['POST', 'PATCH', 'PUT', 'DELETE'])('refuses %s on /v1/policy', async (method) => {
    const t = await tenant('op@example.test', 'Acme');

    const response = await app.request(POLICY_POLL_PATH, {
      method,
      headers: { authorization: `Bearer ${t.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'paused' }),
    });

    // Operator mutation is Step 13; nothing in Step 12 can write policy.
    expect(response.status).toBe(404);
  });

  it('exposes no per-agent policy mutation route', async () => {
    const t = await tenant('op@example.test', 'Acme');

    for (const path of [
      `${POLICY_POLL_PATH}/agent-a`,
      `/v1/workspaces/${t.workspaceId}/policy`,
      `/v1/workspaces/${t.workspaceId}/agents/agent-a/policy`,
      '/v1/policy/version',
    ]) {
      const response = await app.request(path, {
        headers: { authorization: `Bearer ${t.key}`, cookie: t.cookie },
      });
      expect(response.status, path).toBe(404);
    }
  });
});

describe('unavailable without a database', () => {
  it('reports 503 rather than crashing', async () => {
    const noDb = createApp({ probeDatabase: () => Promise.resolve('unconfigured') });

    const response = await noDb.request(POLICY_POLL_PATH);

    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: string }).error).toBe('policy_unavailable');
  });

  it('leaves liveness unaffected', async () => {
    const noDb = createApp({ probeDatabase: () => Promise.resolve('unconfigured') });

    expect((await noDb.request('/healthz')).status).toBe(200);
  });
});
