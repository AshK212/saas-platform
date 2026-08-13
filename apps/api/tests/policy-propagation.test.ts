import {
  agentPolicyPath,
  agentPolicyResponseSchema,
  AUTH_CALLBACK_PATH,
  AUTH_MAGIC_LINK_PATH,
  POLICY_POLL_PATH,
  policySnapshotSchema,
  workspaceApiKeysPath,
  type AgentPolicyMutationRequest,
  type PolicySnapshot,
} from '@hybrid/contracts';
import type { AuthenticatedApiCredential, AuthorizedWorkspace } from '@hybrid/db';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { createFixedClock } from '../src/auth/clock';
import { AUTH_COOKIE_NAME } from '../src/auth/cookie';
import { createCapturingEmailSender, type CapturingEmailSender } from '../src/auth/email';
import { createAuthService } from '../src/auth/service';
import { MissingPolicyStateError, type PolicySnapshotResult, type PolicyStore } from '../src/policy/store';
import type { AgentPolicyMutationResult, PolicyMutationStore } from '../src/policy/mutation-store';
import { createMemoryApiKeyStore, type MemoryApiKeyStore } from './helpers/memory-api-key-store';
import { createMemoryAuthStore, type MemoryAuthStore } from './helpers/memory-auth-store';
import {
  createMemoryWorkspaceStore,
  type MemoryWorkspaceStore,
} from './helpers/memory-workspace-store';

/**
 * END-TO-END POLICY PROPAGATION (Step 13 write -> Step 12 read).
 *
 * The previous two suites test each half against its own fake. This one wires
 * the operator write path and the machine poll path to ONE shared state, which
 * is the only way to prove the thing that actually matters to AC-10:
 *
 *   an operator saves a cap -> the version increments -> the very next agent
 *   poll sees the new values, with no delay anywhere in the server.
 *
 * The runtime's ~30-second cadence is the only latency in the loop; a committed
 * write is visible immediately.
 */

const APP_URL = 'https://app.example.test';
const START = new Date('2026-08-12T10:00:00.000Z');
const AGENT_A = '33333333-3333-4333-8333-333333333333';

interface SharedState {
  version: bigint;
  readonly agents: { id: string; externalId: string }[];
  policy: { mode: string; spend: string | null; publish: number | null } | null;
}

/** One backing store behind both the write port and the read port. */
function createSharedPolicyState(): {
  state: SharedState;
  reader: PolicyStore;
  writer: PolicyMutationStore;
} {
  const state: SharedState = { version: 1n, agents: [], policy: null };

  const effective = (): PolicySnapshotResult => ({
    version: state.version.toString(),
    agents: state.agents.map((agent) => ({
      agent_id: agent.externalId,
      mode: (state.policy?.mode ?? 'watch') as 'watch' | 'budgeted' | 'paused',
      daily_spend_cap_usd: state.policy?.spend ?? null,
      daily_publish_cap: state.policy?.publish ?? null,
    })),
  });

  const reader: PolicyStore = {
    getVersion(_credential: AuthenticatedApiCredential): Promise<string> {
      if (state.version === 0n) {
        return Promise.reject(new MissingPolicyStateError());
      }
      return Promise.resolve(state.version.toString());
    },
    getSnapshot(_credential: AuthenticatedApiCredential): Promise<PolicySnapshotResult> {
      return Promise.resolve(effective());
    },
  };

  const writer: PolicyMutationStore = {
    setAgentPolicy(
      _authorized: AuthorizedWorkspace,
      agentId: string,
      request: AgentPolicyMutationRequest,
    ): Promise<AgentPolicyMutationResult | null> {
      const agent = state.agents.find((a) => a.id === agentId);
      if (agent === undefined) {
        return Promise.resolve(null);
      }
      state.policy = {
        mode: request.mode,
        spend: request.daily_spend_cap_usd,
        publish: request.daily_publish_cap,
      };
      // Policy and version move together, as one committed unit.
      state.version += 1n;
      return Promise.resolve({
        policy: {
          agent_id: agent.externalId,
          mode: request.mode,
          daily_spend_cap_usd: request.daily_spend_cap_usd,
          daily_publish_cap: request.daily_publish_cap,
        },
        version: state.version.toString(),
      });
    },
    getAgentPolicy(
      _authorized: AuthorizedWorkspace,
      agentId: string,
    ): Promise<AgentPolicyMutationResult | null> {
      const agent = state.agents.find((a) => a.id === agentId);
      if (agent === undefined) {
        return Promise.resolve(null);
      }
      return Promise.resolve({
        policy: {
          agent_id: agent.externalId,
          mode: (state.policy?.mode ?? 'watch') as 'watch' | 'budgeted' | 'paused',
          daily_spend_cap_usd: state.policy?.spend ?? null,
          daily_publish_cap: state.policy?.publish ?? null,
        },
        version: state.version.toString(),
      });
    },
  };

  return { state, reader, writer };
}

let authStore: MemoryAuthStore;
let mailer: CapturingEmailSender;
let clock: ReturnType<typeof createFixedClock>;
let workspaces: MemoryWorkspaceStore;
let apiKeys: MemoryApiKeyStore;
let shared: ReturnType<typeof createSharedPolicyState>;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  authStore = createMemoryAuthStore();
  mailer = createCapturingEmailSender();
  clock = createFixedClock(START);
  workspaces = createMemoryWorkspaceStore();
  apiKeys = createMemoryApiKeyStore();
  shared = createSharedPolicyState();
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
    policyStore: shared.reader,
    policyMutationStore: shared.writer,
    clock,
  });
});

interface Tenant {
  readonly workspaceId: string;
  readonly cookie: string;
  readonly key: string;
}

async function tenant(): Promise<Tenant> {
  const email = 'op@example.test';
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
  const workspaceId = workspaces.seedWorkspace('Acme', [{ userId }]);
  const issued = await app.request(workspaceApiKeysPath(workspaceId), {
    method: 'POST',
    headers: { cookie, origin: APP_URL, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'runtime' }),
  });
  const { apiKey } = (await issued.json()) as { apiKey: { key: string } };
  shared.state.agents.push({ id: AGENT_A, externalId: 'agent-a' });
  return { workspaceId, cookie, key: apiKey.key };
}

async function save(t: Tenant, body: unknown): Promise<string> {
  const response = await app.request(agentPolicyPath(t.workspaceId, AGENT_A), {
    method: 'PUT',
    headers: { cookie: t.cookie, origin: APP_URL, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return agentPolicyResponseSchema.parse(await response.json()).version;
}

async function poll(t: Tenant, query = ''): Promise<Response> {
  return app.request(`${POLICY_POLL_PATH}${query}`, {
    headers: { authorization: `Bearer ${t.key}` },
  });
}

async function snapshot(t: Tenant, query = ''): Promise<PolicySnapshot> {
  const response = await poll(t, query);
  expect(response.status).toBe(200);
  return policySnapshotSchema.parse(await response.json());
}

describe('AC-10 foundation: a saved cap reaches the next poll', () => {
  it('an agent polling at the old version receives the new policy', async () => {
    const t = await tenant();
    // The agent is up to date at version 1.
    expect((await poll(t, '?since_version=1')).status).toBe(304);

    const version = await save(t, {
      mode: 'budgeted',
      daily_spend_cap_usd: '25.000000',
      daily_publish_cap: null,
    });
    expect(version).toBe('2');

    // Its very next poll - no server-side delay of any kind.
    const body = await snapshot(t, '?since_version=1');

    expect(body.version).toBe('2');
    expect(body.agents[0]).toEqual({
      agent_id: 'agent-a',
      mode: 'budgeted',
      daily_spend_cap_usd: '25.000000',
      daily_publish_cap: null,
    });
  });

  it('the following poll at the new version is 304', async () => {
    const t = await tenant();
    await save(t, {
      mode: 'budgeted',
      daily_spend_cap_usd: '25.000000',
      daily_publish_cap: null,
    });

    expect((await poll(t, '?since_version=2')).status).toBe(304);
  });

  it('AC-10 shape: raising the cap propagates immediately', async () => {
    const t = await tenant();
    await save(t, {
      mode: 'budgeted',
      daily_spend_cap_usd: '25.000000',
      daily_publish_cap: null,
    });
    expect((await poll(t, '?since_version=2')).status).toBe(304);

    // The operator raises the cap.
    const raised = await save(t, {
      mode: 'budgeted',
      daily_spend_cap_usd: '100.000000',
      daily_publish_cap: null,
    });

    expect(raised).toBe('3');
    const body = await snapshot(t, '?since_version=2');
    expect(body.version).toBe('3');
    expect(body.agents[0]?.daily_spend_cap_usd).toBe('100.000000');
  });

  it('AC-11 shape: a publish cap of 5 propagates', async () => {
    const t = await tenant();

    await save(t, {
      mode: 'budgeted',
      daily_spend_cap_usd: null,
      daily_publish_cap: 5,
    });

    expect((await snapshot(t)).agents[0]?.daily_publish_cap).toBe(5);
  });

  it('AC-12 shape: pause and unpause both propagate', async () => {
    const t = await tenant();

    await save(t, { mode: 'paused', daily_spend_cap_usd: null, daily_publish_cap: null });
    expect((await snapshot(t)).agents[0]?.mode).toBe('paused');

    await save(t, { mode: 'watch', daily_spend_cap_usd: null, daily_publish_cap: null });
    const resumed = await snapshot(t);
    expect(resumed.agents[0]?.mode).toBe('watch');
    expect(resumed.version).toBe('3');
  });

  it('every save advances the version an agent can observe', async () => {
    const t = await tenant();
    const observed: string[] = [];

    for (const mode of ['watch', 'budgeted', 'paused'] as const) {
      await save(t, { mode, daily_spend_cap_usd: null, daily_publish_cap: null });
      observed.push((await snapshot(t)).version);
    }

    expect(observed).toEqual(['2', '3', '4']);
  });

  it('a rejected save leaves the polled version untouched', async () => {
    const t = await tenant();

    await app.request(agentPolicyPath(t.workspaceId, AGENT_A), {
      method: 'PUT',
      headers: { cookie: t.cookie, origin: 'https://attacker.example', 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'paused', daily_spend_cap_usd: null, daily_publish_cap: null }),
    });

    // A CSRF attempt must not even move the version an agent polls on.
    expect((await poll(t, '?since_version=1')).status).toBe(304);
    expect((await snapshot(t)).agents[0]?.mode).toBe('watch');
  });

  it('the write response version equals the version the agent then reads', async () => {
    const t = await tenant();

    const written = await save(t, {
      mode: 'budgeted',
      daily_spend_cap_usd: '25.000000',
      daily_publish_cap: 5,
    });
    const polled = await snapshot(t);

    // The two halves describe the same committed transaction.
    expect(polled.version).toBe(written);
  });
});
