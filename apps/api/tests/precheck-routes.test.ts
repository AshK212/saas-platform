import {
  AUTH_CALLBACK_PATH,
  AUTH_MAGIC_LINK_PATH,
  PRECHECK_PATH,
  precheckResponseSchema,
  workspaceApiKeysPath,
  type PrecheckResponse,
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
import {
  createMemoryPrecheckStore,
  type MemoryPrecheckStore,
} from './helpers/memory-precheck-store';
import {
  createMemoryWorkspaceStore,
  type MemoryWorkspaceStore,
} from './helpers/memory-workspace-store';

/**
 * `POST /v1/actions/precheck` (Step 15).
 *
 * The properties under test: only a machine key decides, the workspace comes
 * only from the credential, EVERY decision produces exactly one receipt, a
 * denial never moves the ledger, and a retry never debits twice.
 */

const APP_URL = 'https://app.example.test';
const START = new Date('2026-08-13T09:00:00.000Z');
const DAY = '2026-08-13';

let authStore: MemoryAuthStore;
let mailer: CapturingEmailSender;
let clock: ReturnType<typeof createFixedClock>;
let workspaces: MemoryWorkspaceStore;
let apiKeys: MemoryApiKeyStore;
let agents: MemoryAgentStore;
let precheck: MemoryPrecheckStore;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  authStore = createMemoryAuthStore();
  mailer = createCapturingEmailSender();
  clock = createFixedClock(START);
  workspaces = createMemoryWorkspaceStore();
  apiKeys = createMemoryApiKeyStore();
  agents = createMemoryAgentStore();
  precheck = createMemoryPrecheckStore();
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
    precheckStore: precheck,
    clock,
  });
});

interface Tenant {
  readonly workspaceId: string;
  readonly key: string;
  readonly cookie: string;
}

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
    body: JSON.stringify({ name: `${name} runtime` }),
  });
  const { apiKey } = (await issued.json()) as { apiKey: { key: string } };
  precheck.seedPolicyState(workspaceId);
  return { workspaceId, key: apiKey.key, cookie };
}

async function post(key: string, body: unknown): Promise<Response> {
  return app.request(PRECHECK_PATH, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function decide(key: string, body: unknown): Promise<PrecheckResponse> {
  const response = await post(key, body);
  expect(response.status).toBe(200);
  return precheckResponseSchema.parse(await response.json());
}

const spend = (actionId: string, amount: string, agentId = 'agent-a'): unknown => ({
  action_id: actionId,
  agent_id: agentId,
  category: 'spend',
  amount_usd: amount,
});

const publish = (actionId: string, agentId = 'agent-a'): unknown => ({
  action_id: actionId,
  agent_id: agentId,
  category: 'publish',
});

describe('authentication domain', () => {
  it('rejects a request with no credential', async () => {
    await tenant('op@example.test', 'Acme');

    const response = await app.request(PRECHECK_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(spend('act-1', '1.000000')),
    });

    expect(response.status).toBe(401);
    expect(precheck.receipts).toHaveLength(0);
  });

  it('REJECTS a browser session cookie', async () => {
    const t = await tenant('op@example.test', 'Acme');

    const response = await app.request(PRECHECK_PATH, {
      method: 'POST',
      headers: { cookie: t.cookie, origin: APP_URL, 'content-type': 'application/json' },
      body: JSON.stringify(spend('act-1', '1.000000')),
    });

    // The operator UI CHANGES policy; the runtime ASKS about it.
    expect(response.status).toBe(401);
    expect(precheck.receipts).toHaveLength(0);
  });

  it('rejects a revoked key', async () => {
    const t = await tenant('op@example.test', 'Acme');
    const credentialId = apiKeys.credentials[0]?.id ?? '';
    await app.request(`${workspaceApiKeysPath(t.workspaceId)}/${credentialId}/revoke`, {
      method: 'POST',
      headers: { cookie: t.cookie, origin: APP_URL },
    });

    expect((await post(t.key, spend('act-1', '1.000000'))).status).toBe(401);
    expect(precheck.receipts).toHaveLength(0);
  });

  it('NO RECEIPT is created for a rejected request', async () => {
    const t = await tenant('op@example.test', 'Acme');

    await post('hmp_live_deadbeef_nope', spend('act-1', '1.000000'));
    await post(t.key, { action_id: 'act-2' });

    // No governance decision was made, so there is nothing to record.
    expect(precheck.receipts).toHaveLength(0);
  });
});

describe('the workspace comes from the credential', () => {
  it.each(['workspace_id', 'workspaceId', 'tenant_id', 'org_id'])(
    'rejects a %s field in the body',
    async (field) => {
      const a = await tenant('alice@example.test', 'Alice Co');
      const b = await tenant('bob@example.test', 'Bob Co');

      const response = await post(a.key, {
        ...(spend('act-1', '1.000000') as object),
        [field]: b.workspaceId,
      });

      expect(response.status).toBe(400);
      expect(precheck.receipts).toHaveLength(0);
    },
  );

  it('ignores a tenant header', async () => {
    const a = await tenant('alice@example.test', 'Alice Co');
    const b = await tenant('bob@example.test', 'Bob Co');

    await app.request(PRECHECK_PATH, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${a.key}`,
        'X-Workspace-Id': b.workspaceId,
        'content-type': 'application/json',
      },
      body: JSON.stringify(spend('act-1', '1.000000')),
    });

    expect(precheck.receipts[0]?.workspaceId).toBe(a.workspaceId);
  });
});

describe('request validation', () => {
  it.each([
    ['a missing action_id', { agent_id: 'agent-a', category: 'spend', amount_usd: '1.000000' }],
    ['an empty action_id', { action_id: '', agent_id: 'agent-a', category: 'other' }],
    ['a missing agent_id', { action_id: 'act-1', category: 'other' }],
    ['an invalid category', { action_id: 'act-1', agent_id: 'agent-a', category: 'deploy' }],
    ['spend with no amount', { action_id: 'act-1', agent_id: 'agent-a', category: 'spend' }],
    ['a numeric amount', { action_id: 'act-1', agent_id: 'agent-a', category: 'spend', amount_usd: 1 }],
    ['a float amount', { action_id: 'act-1', agent_id: 'agent-a', category: 'spend', amount_usd: 1.5 }],
    [
      'a negative amount',
      { action_id: 'act-1', agent_id: 'agent-a', category: 'spend', amount_usd: '-1.000000' },
    ],
    [
      'seven decimals',
      { action_id: 'act-1', agent_id: 'agent-a', category: 'spend', amount_usd: '1.0000001' },
    ],
    [
      'exponent notation',
      { action_id: 'act-1', agent_id: 'agent-a', category: 'spend', amount_usd: '4.1e1' },
    ],
    [
      'an over-capacity amount',
      { action_id: 'act-1', agent_id: 'agent-a', category: 'spend', amount_usd: '100000000.000000' },
    ],
    [
      'an amount on a publish',
      { action_id: 'act-1', agent_id: 'agent-a', category: 'publish', amount_usd: '1.000000' },
    ],
    [
      'an amount on a tool_call',
      { action_id: 'act-1', agent_id: 'agent-a', category: 'tool_call', amount_usd: '1.000000' },
    ],
    ['an unknown field', { action_id: 'act-1', agent_id: 'agent-a', category: 'other', extra: 1 }],
    [
      'a client-supplied precheck_id',
      { action_id: 'act-1', agent_id: 'agent-a', category: 'other', precheck_id: 'x' },
    ],
    [
      'a client-supplied policy version',
      { action_id: 'act-1', agent_id: 'agent-a', category: 'other', policy_version: '99' },
    ],
    [
      'a client-supplied decision',
      { action_id: 'act-1', agent_id: 'agent-a', category: 'other', decision: 'allow' },
    ],
    ['an empty object', {}],
    ['an array', []],
    ['null', null],
  ])('rejects %s with 400 and no receipt', async (_label, body) => {
    const t = await tenant('op@example.test', 'Acme');

    const response = await post(t.key, body);

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe('invalid_request');
    expect(precheck.receipts).toHaveLength(0);
    expect(precheck.ledger).toHaveLength(0);
  });

  it('rejects malformed JSON safely', async () => {
    const t = await tenant('op@example.test', 'Acme');

    const response = await app.request(PRECHECK_PATH, {
      method: 'POST',
      headers: { authorization: `Bearer ${t.key}`, 'content-type': 'application/json' },
      body: '{not json',
    });

    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain('SyntaxError');
  });

  it('leaks no schema internals', async () => {
    const t = await tenant('op@example.test', 'Acme');

    const raw = await (
      await post(t.key, { action_id: 'act-1', agent_id: 'agent-a', category: 'nope' })
    ).text();

    expect(raw).not.toContain('ZodError');
    expect(raw).not.toMatch(/invalid_enum|regex|precheck_receipts/i);
  });
});

describe('AC-07 shape: budgeted spend against a $25 cap', () => {
  async function budgetedTenant(cap: string | null, publishCap: number | null): Promise<Tenant> {
    const t = await tenant('op@example.test', 'Acme');
    precheck.seedPolicy({
      workspaceId: t.workspaceId,
      agentExternalId: 'agent-a',
      mode: 'budgeted',
      dailySpendCapUsd: cap,
      dailyPublishCap: publishCap,
    });
    return t;
  }

  it('allows 20, then 5 to exactly the cap, then denies a micro-dollar', async () => {
    const t = await budgetedTenant('25.000000', null);

    const first = await decide(t.key, spend('act-1', '20.000000'));
    expect(first.decision).toBe('allow');
    expect(first.remaining).toEqual({ kind: 'usd', value: '5.000000' });
    expect(precheck.usageOf(t.workspaceId, 'agent-a', DAY)?.spendCommittedUsd).toBe('20.000000');

    const second = await decide(t.key, spend('act-2', '5.000000'));
    expect(second.decision).toBe('allow');
    expect(second.remaining).toEqual({ kind: 'usd', value: '0.000000' });
    expect(precheck.usageOf(t.workspaceId, 'agent-a', DAY)?.spendCommittedUsd).toBe('25.000000');

    const third = await decide(t.key, spend('act-3', '0.000001'));
    expect(third.decision).toBe('deny');
    expect(third.reason).toBe('daily_spend_cap_exceeded');
    // A DENIAL NEVER MOVES THE LEDGER.
    expect(precheck.usageOf(t.workspaceId, 'agent-a', DAY)?.spendCommittedUsd).toBe('25.000000');

    // Three decisions, three receipts.
    expect(precheck.receipts).toHaveLength(3);
    expect(precheck.receipts.map((r) => r.decision)).toEqual(['allow', 'allow', 'deny']);
  });

  it('AC-08 shape: $41 against a $25 cap denies and commits nothing', async () => {
    const t = await budgetedTenant('25.000000', null);

    const response = await decide(t.key, spend('act-1', '41.000000'));

    expect(response.decision).toBe('deny');
    expect(response.reason).toBe('daily_spend_cap_exceeded');
    expect(response.remaining).toEqual({ kind: 'usd', value: '25.000000' });
    expect(precheck.usageOf(t.workspaceId, 'agent-a', DAY)?.spendCommittedUsd).toBe('0.000000');

    const receipt = precheck.receipts[0];
    expect(receipt?.decision).toBe('deny');
    expect(receipt?.requestedAmountUsd).toBe('41.000000');
    expect(receipt?.appliedSpendCapUsd).toBe('25.000000');
    expect(receipt?.ledgerSpendBeforeUsd).toBe('0.000000');
    expect(receipt?.denyReason).toBe('daily_spend_cap_exceeded');
  });

  it('AC-11 shape: five publishes allowed, the sixth denied', async () => {
    const t = await budgetedTenant(null, 5);

    const outcomes: PrecheckResponse[] = [];
    for (let i = 1; i <= 6; i += 1) {
      outcomes.push(await decide(t.key, publish(`act-${String(i)}`)));
    }

    expect(outcomes.map((o) => o.decision)).toEqual([
      'allow',
      'allow',
      'allow',
      'allow',
      'allow',
      'deny',
    ]);
    expect(outcomes[5]?.reason).toBe('daily_publish_cap_exceeded');
    // Exactly five committed; the denial changed nothing.
    expect(precheck.usageOf(t.workspaceId, 'agent-a', DAY)?.publishCountCommitted).toBe(5);
    // Six durable receipts.
    expect(precheck.receipts).toHaveLength(6);
  });

  it('a spend never touches the publish counter and vice versa', async () => {
    const t = await budgetedTenant('25.000000', 5);

    await decide(t.key, spend('act-1', '5.000000'));
    expect(precheck.usageOf(t.workspaceId, 'agent-a', DAY)?.publishCountCommitted).toBe(0);

    await decide(t.key, publish('act-2'));
    expect(precheck.usageOf(t.workspaceId, 'agent-a', DAY)?.spendCommittedUsd).toBe('5.000000');
  });

  it('an untracked category commits nothing and reports no remaining', async () => {
    const t = await budgetedTenant('25.000000', 5);

    for (const category of ['llm_call', 'tool_call', 'other'] as const) {
      const response = await decide(t.key, {
        action_id: `act-${category}`,
        agent_id: 'agent-a',
        category,
      });
      expect(response.decision, category).toBe('allow');
      expect(response.remaining, category).toBeNull();
    }

    expect(precheck.ledger).toHaveLength(0);
    expect(precheck.receipts).toHaveLength(3);
    // No ledger was consulted, so there is no "before" to record.
    expect(precheck.receipts[0]?.ledgerSpendBeforeUsd).toBeNull();
  });
});

describe('watch mode', () => {
  it('ALLOWS a $41 spend and commits NOTHING', async () => {
    const t = await tenant('op@example.test', 'Acme');
    precheck.seedPolicy({
      workspaceId: t.workspaceId,
      agentExternalId: 'agent-a',
      mode: 'watch',
      dailySpendCapUsd: '25.000000',
      dailyPublishCap: 5,
    });

    const response = await decide(t.key, spend('act-1', '41.000000'));

    expect(response.decision).toBe('allow');
    expect(response.remaining).toBeNull();
    // Watch must not silently behave as budgeted accounting.
    expect(precheck.ledger).toHaveLength(0);
    // The receipt still exists and records the mode that allowed it.
    expect(precheck.receipts).toHaveLength(1);
    expect(precheck.receipts[0]?.appliedMode).toBe('watch');
  });

  it('allows a publish without incrementing the counter', async () => {
    const t = await tenant('op@example.test', 'Acme');
    precheck.seedPolicy({
      workspaceId: t.workspaceId,
      agentExternalId: 'agent-a',
      mode: 'watch',
      dailySpendCapUsd: null,
      dailyPublishCap: 1,
    });

    await decide(t.key, publish('act-1'));
    await decide(t.key, publish('act-2'));

    expect(precheck.ledger).toHaveLength(0);
    expect(precheck.receipts).toHaveLength(2);
  });

  it('is the DEFAULT for an agent with no explicit policy', async () => {
    const t = await tenant('op@example.test', 'Acme');

    const response = await decide(t.key, spend('act-1', '999.000000', 'never-configured'));

    expect(response.decision).toBe('allow');
    expect(precheck.ledger).toHaveLength(0);
    expect(precheck.receipts[0]?.appliedMode).toBe('watch');
  });
});

describe('budgeted but uncapped still records', () => {
  it('allows and COMMITS with a null spend cap', async () => {
    const t = await tenant('op@example.test', 'Acme');
    precheck.seedPolicy({
      workspaceId: t.workspaceId,
      agentExternalId: 'agent-a',
      mode: 'budgeted',
      dailySpendCapUsd: null,
      dailyPublishCap: null,
    });

    const response = await decide(t.key, spend('act-1', '41.000000'));

    expect(response.decision).toBe('allow');
    expect(response.remaining).toBeNull();
    // If an operator adds a cap later today, the morning's spend is already
    // counted rather than silently forgiven.
    expect(precheck.usageOf(t.workspaceId, 'agent-a', DAY)?.spendCommittedUsd).toBe('41.000000');
  });

  it('allows and COMMITS with a null publish cap', async () => {
    const t = await tenant('op@example.test', 'Acme');
    precheck.seedPolicy({
      workspaceId: t.workspaceId,
      agentExternalId: 'agent-a',
      mode: 'budgeted',
      dailySpendCapUsd: null,
      dailyPublishCap: null,
    });

    await decide(t.key, publish('act-1'));
    await decide(t.key, publish('act-2'));

    expect(precheck.usageOf(t.workspaceId, 'agent-a', DAY)?.publishCountCommitted).toBe(2);
  });
});

describe('paused mode', () => {
  async function pausedTenant(): Promise<Tenant> {
    const t = await tenant('op@example.test', 'Acme');
    precheck.seedPolicy({
      workspaceId: t.workspaceId,
      agentExternalId: 'agent-a',
      mode: 'paused',
      dailySpendCapUsd: '100.000000',
      dailyPublishCap: 10,
    });
    return t;
  }

  it.each(['llm_call', 'tool_call', 'spend', 'publish', 'other'] as const)(
    'DENIES %s',
    async (category) => {
      const t = await pausedTenant();

      const response = await decide(t.key, {
        action_id: `act-${category}`,
        agent_id: 'agent-a',
        category,
        ...(category === 'spend' ? { amount_usd: '0.000001' } : {}),
      });

      expect(response.decision).toBe('deny');
      expect(response.reason).toBe('paused');
      expect(response.remaining).toBeNull();
    },
  );

  it('commits nothing and still records a receipt', async () => {
    const t = await pausedTenant();

    await decide(t.key, spend('act-1', '1.000000'));

    expect(precheck.ledger).toHaveLength(0);
    expect(precheck.receipts).toHaveLength(1);
    expect(precheck.receipts[0]?.appliedMode).toBe('paused');
    expect(precheck.receipts[0]?.denyReason).toBe('paused');
  });
});

describe('action idempotency', () => {
  async function budgetedTenant(): Promise<Tenant> {
    const t = await tenant('op@example.test', 'Acme');
    precheck.seedPolicy({
      workspaceId: t.workspaceId,
      agentExternalId: 'agent-a',
      mode: 'budgeted',
      dailySpendCapUsd: '25.000000',
      dailyPublishCap: 5,
    });
    return t;
  }

  it('a replay returns the ORIGINAL decision and debits nothing more', async () => {
    const t = await budgetedTenant();
    const first = await decide(t.key, spend('act-1', '5.000000'));

    const replay = await decide(t.key, spend('act-1', '5.000000'));

    // The network retry that would otherwise double-charge.
    expect(replay.precheck_id).toBe(first.precheck_id);
    expect(replay.decision).toBe('allow');
    expect(precheck.usageOf(t.workspaceId, 'agent-a', DAY)?.spendCommittedUsd).toBe('5.000000');
    expect(precheck.receipts).toHaveLength(1);
  });

  it('a CHANGED replay does not reinterpret history', async () => {
    const t = await budgetedTenant();
    const first = await decide(t.key, spend('act-1', '5.000000'));

    const changed = await decide(t.key, spend('act-1', '10.000000', 'different-agent'));

    // Historical action identity is authoritative; re-deciding would be a
    // second chance to spend.
    expect(changed.precheck_id).toBe(first.precheck_id);
    expect(precheck.usageOf(t.workspaceId, 'agent-a', DAY)?.spendCommittedUsd).toBe('5.000000');
    expect(precheck.receipts).toHaveLength(1);
    expect(precheck.receipts[0]?.requestedAmountUsd).toBe('5.000000');
  });

  it('a replayed DENIAL stays denied', async () => {
    const t = await budgetedTenant();
    const first = await decide(t.key, spend('act-1', '41.000000'));

    const replay = await decide(t.key, spend('act-1', '41.000000'));

    expect(replay.decision).toBe('deny');
    expect(replay.precheck_id).toBe(first.precheck_id);
    expect(replay.reason).toBe('daily_spend_cap_exceeded');
    expect(precheck.receipts).toHaveLength(1);
  });

  it('a different action id decides afresh', async () => {
    const t = await budgetedTenant();
    await decide(t.key, spend('act-1', '5.000000'));

    const second = await decide(t.key, spend('act-2', '5.000000'));

    expect(precheck.usageOf(t.workspaceId, 'agent-a', DAY)?.spendCommittedUsd).toBe('10.000000');
    expect(second.remaining).toEqual({ kind: 'usd', value: '15.000000' });
    expect(precheck.receipts).toHaveLength(2);
  });

  it('the same action id in another workspace is a separate action', async () => {
    const a = await tenant('alice@example.test', 'Alice Co');
    const b = await tenant('bob@example.test', 'Bob Co');
    for (const t of [a, b]) {
      precheck.seedPolicy({
        workspaceId: t.workspaceId,
        agentExternalId: 'agent-a',
        mode: 'budgeted',
        dailySpendCapUsd: '25.000000',
        dailyPublishCap: null,
      });
    }

    const first = await decide(a.key, spend('shared-action', '5.000000'));
    const second = await decide(b.key, spend('shared-action', '5.000000'));

    expect(second.precheck_id).not.toBe(first.precheck_id);
    expect(precheck.receipts).toHaveLength(2);
  });
});

describe('atomicity', () => {
  it('a failed receipt insert ROLLS THE DEBIT BACK', async () => {
    const t = await tenant('op@example.test', 'Acme');
    precheck.seedPolicy({
      workspaceId: t.workspaceId,
      agentExternalId: 'agent-a',
      mode: 'budgeted',
      dailySpendCapUsd: '25.000000',
      dailyPublishCap: null,
    });
    precheck.failReceiptInsert = true;

    const response = await post(t.key, spend('act-1', '5.000000'));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'internal_error' });
    // Money spent but unexplainable is worse than a failed request.
    expect(precheck.ledger.find((r) => r.spendCommittedUsd !== '0.000000')).toBeUndefined();
    expect(precheck.receipts).toHaveLength(0);
  });

  it('recovers on the next attempt', async () => {
    const t = await tenant('op@example.test', 'Acme');
    precheck.seedPolicy({
      workspaceId: t.workspaceId,
      agentExternalId: 'agent-a',
      mode: 'budgeted',
      dailySpendCapUsd: '25.000000',
      dailyPublishCap: null,
    });
    precheck.failReceiptInsert = true;
    await post(t.key, spend('act-1', '5.000000'));

    precheck.failReceiptInsert = false;
    const response = await decide(t.key, spend('act-1', '5.000000'));

    // The failed attempt consumed neither the action id nor any budget.
    expect(response.decision).toBe('allow');
    expect(precheck.usageOf(t.workspaceId, 'agent-a', DAY)?.spendCommittedUsd).toBe('5.000000');
  });

  it('a missing policy state fails safely with no receipt', async () => {
    const t = await tenant('op@example.test', 'Acme');
    // A workspace that somehow escaped provisioning: an API key exists, but no
    // policy state row. Every supported path creates one atomically with the
    // workspace, so this is an invariant violation rather than an empty policy.
    const orphan = createMemoryPrecheckStore();
    const orphanApp = createApp({
      probeDatabase: () => Promise.resolve('ok'),
      apiKeyStore: apiKeys,
      precheckStore: orphan,
      clock,
    });

    const response = await orphanApp.request(PRECHECK_PATH, {
      method: 'POST',
      headers: { authorization: `Bearer ${t.key}`, 'content-type': 'application/json' },
      body: JSON.stringify(spend('act-1', '1.000000')),
    });

    expect(response.status).toBe(500);
    // Opaque: no SQL, no table name, no workspace id.
    expect(await response.json()).toEqual({ error: 'internal_error' });
    // No governance artifact of any kind.
    expect(orphan.receipts).toHaveLength(0);
    expect(orphan.ledger).toHaveLength(0);
  });
});

describe('cross-tenant isolation', () => {
  it('each key decides only in its own workspace', async () => {
    const a = await tenant('alice@example.test', 'Alice Co');
    const b = await tenant('bob@example.test', 'Bob Co');
    precheck.seedPolicy({
      workspaceId: a.workspaceId,
      agentExternalId: 'agent-1',
      mode: 'paused',
      dailySpendCapUsd: null,
      dailyPublishCap: null,
    });
    precheck.seedPolicy({
      workspaceId: b.workspaceId,
      agentExternalId: 'agent-1',
      mode: 'budgeted',
      dailySpendCapUsd: '100.000000',
      dailyPublishCap: null,
    });

    // A SHARED external agent id carries independent governance.
    const fromA = await decide(a.key, spend('act-a', '1.000000', 'agent-1'));
    const fromB = await decide(b.key, spend('act-b', '1.000000', 'agent-1'));

    expect(fromA.decision).toBe('deny');
    expect(fromA.reason).toBe('paused');
    expect(fromB.decision).toBe('allow');
  });

  it('one workspace ledger never affects another', async () => {
    const a = await tenant('alice@example.test', 'Alice Co');
    const b = await tenant('bob@example.test', 'Bob Co');
    for (const t of [a, b]) {
      precheck.seedPolicy({
        workspaceId: t.workspaceId,
        agentExternalId: 'agent-a',
        mode: 'budgeted',
        dailySpendCapUsd: '25.000000',
        dailyPublishCap: null,
      });
    }

    await decide(a.key, spend('act-1', '25.000000'));
    const bDecision = await decide(b.key, spend('act-2', '25.000000'));

    // A exhausted its budget; B's is untouched.
    expect(bDecision.decision).toBe('allow');
    expect(precheck.usageOf(b.workspaceId, 'agent-a', DAY)?.spendCommittedUsd).toBe('25.000000');
  });
});

describe('receipt evidence', () => {
  it('records the exact policy version that produced the decision', async () => {
    const t = await tenant('op@example.test', 'Acme');
    precheck.seedVersion(t.workspaceId, '7');
    precheck.seedPolicy({
      workspaceId: t.workspaceId,
      agentExternalId: 'agent-a',
      mode: 'budgeted',
      dailySpendCapUsd: '25.000000',
      dailyPublishCap: null,
    });

    await decide(t.key, spend('act-1', '1.000000'));
    // The operator changes policy afterwards.
    precheck.seedVersion(t.workspaceId, '8');

    // The old receipt still cites the version that decided it.
    expect(precheck.receipts[0]?.policyVersion).toBe('7');
  });

  it('snapshots the applied caps so a later change cannot rewrite history', async () => {
    const t = await tenant('op@example.test', 'Acme');
    precheck.seedPolicy({
      workspaceId: t.workspaceId,
      agentExternalId: 'agent-a',
      mode: 'budgeted',
      dailySpendCapUsd: '25.000000',
      dailyPublishCap: 5,
    });

    await decide(t.key, spend('act-1', '41.000000'));

    const receipt = precheck.receipts[0];
    expect(receipt?.appliedSpendCapUsd).toBe('25.000000');
    expect(receipt?.appliedPublishCap).toBe(5);
    expect(receipt?.accountingDay).toBe(DAY);
  });

  it('records the UTC accounting day even for an untracked category', async () => {
    const t = await tenant('op@example.test', 'Acme');

    await decide(t.key, { action_id: 'act-1', agent_id: 'agent-a', category: 'other' });

    expect(precheck.receipts[0]?.accountingDay).toBe(DAY);
  });

  it('uses the SERVER clock, crossing the UTC midnight boundary', async () => {
    const t = await tenant('op@example.test', 'Acme');
    // 23:59:59.999Z on the 13th.
    clock.advance(new Date('2026-08-13T23:59:59.999Z').getTime() - START.getTime());
    await decide(t.key, { action_id: 'act-1', agent_id: 'agent-a', category: 'other' });

    clock.advance(1);
    await decide(t.key, { action_id: 'act-2', agent_id: 'agent-a', category: 'other' });

    expect(precheck.receipts[0]?.accountingDay).toBe('2026-08-13');
    expect(precheck.receipts[1]?.accountingDay).toBe('2026-08-14');
  });

  it('records one publish as requested count 1', async () => {
    const t = await tenant('op@example.test', 'Acme');
    precheck.seedPolicy({
      workspaceId: t.workspaceId,
      agentExternalId: 'agent-a',
      mode: 'budgeted',
      dailySpendCapUsd: null,
      dailyPublishCap: 5,
    });

    await decide(t.key, publish('act-1'));

    expect(precheck.receipts[0]?.requestedPublishCount).toBe(1);
    expect(precheck.receipts[0]?.requestedAmountUsd).toBeNull();
  });

  it('the response carries no secrets', async () => {
    const t = await tenant('op@example.test', 'Acme');

    const raw = await (
      await post(t.key, { action_id: 'act-1', agent_id: 'agent-a', category: 'other' })
    ).text();

    expect(raw).not.toContain(t.key);
    expect(raw).not.toContain('hmp_live');
    expect(raw).not.toContain(t.workspaceId);
    expect(Object.keys(JSON.parse(raw) as object).sort()).toEqual([
      'decision',
      'precheck_id',
      'remaining',
    ]);
  });
});

describe('no other surface', () => {
  it.each(['GET', 'PUT', 'PATCH', 'DELETE'])('refuses %s on the precheck path', async (method) => {
    const t = await tenant('op@example.test', 'Acme');

    const response = await app.request(PRECHECK_PATH, {
      method,
      headers: { authorization: `Bearer ${t.key}` },
    });

    expect(response.status).toBe(404);
  });

  it('exposes no receipt read route on the MACHINE surface', async () => {
    const t = await tenant('op@example.test', 'Acme');
    await decide(t.key, { action_id: 'act-1', agent_id: 'agent-a', category: 'other' });
    const receiptId = precheck.receipts[0]?.id ?? '';

    // Step 17 added an OPERATOR audit surface under
    // /v1/workspaces/:id/receipts, reachable only with a session cookie. The
    // precheck path itself gained nothing, and there is no unscoped route.
    for (const path of [`/v1/receipts/${receiptId}`, `${PRECHECK_PATH}/${receiptId}`]) {
      const response = await app.request(path, { headers: { cookie: t.cookie } });
      expect(response.status, path).toBe(404);
    }
  });

  it('an API key cannot read the operator audit surface', async () => {
    const t = await tenant('op@example.test', 'Acme');

    for (const path of [
      `/v1/workspaces/${t.workspaceId}/receipts`,
      `/v1/workspaces/${t.workspaceId}/blocks`,
    ]) {
      const response = await app.request(path, {
        headers: { authorization: `Bearer ${t.key}` },
      });
      // No governance store wired here, so the route reports unavailable
      // rather than authenticating a machine credential. The dedicated 401
      // assertion lives in governance-routes.test.ts, where it IS wired.
      expect([401, 503], path).toContain(response.status);
      expect(response.status, path).not.toBe(200);
    }
  });
});

describe('unavailable without a database', () => {
  it('reports 503 rather than crashing', async () => {
    const noDb = createApp({ probeDatabase: () => Promise.resolve('unconfigured') });

    const response = await noDb.request(PRECHECK_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(spend('act-1', '1.000000')),
    });

    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: string }).error).toBe('precheck_unavailable');
  });

  it('leaves liveness unaffected', async () => {
    const noDb = createApp({ probeDatabase: () => Promise.resolve('unconfigured') });

    expect((await noDb.request('/healthz')).status).toBe(200);
  });
});
