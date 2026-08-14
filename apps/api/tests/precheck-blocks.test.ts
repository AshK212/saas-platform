import {
  agentPolicyPath,
  AUTH_CALLBACK_PATH,
  AUTH_MAGIC_LINK_PATH,
  PRECHECK_PATH,
  precheckResponseSchema,
  workspaceApiKeysPath,
  type PrecheckRequest,
  type PrecheckResponse,
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
  createMemoryPrecheckStore,
  type MemoryPrecheckStore,
} from './helpers/memory-precheck-store';
import {
  createMemoryWorkspaceStore,
  type MemoryWorkspaceStore,
} from './helpers/memory-workspace-store';

/**
 * WHOEVER DENIES, RECORDS (Step 16).
 *
 * A plane denial produces a receipt AND a plane-owned block, together. An
 * allow produces a receipt and NO block. The two artifacts must agree about
 * what happened, and a retry must never produce a second one.
 */

const APP_URL = 'https://app.example.test';
const START = new Date('2026-08-14T09:00:00.000Z');
const AGENT_UUID = '33333333-3333-4333-8333-333333333333';

let authStore: MemoryAuthStore;
let mailer: CapturingEmailSender;
let clock: ReturnType<typeof createFixedClock>;
let workspaces: MemoryWorkspaceStore;
let apiKeys: MemoryApiKeyStore;
let precheck: MemoryPrecheckStore;
let policyMutations: MemoryPolicyMutationStore;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  authStore = createMemoryAuthStore();
  mailer = createCapturingEmailSender();
  clock = createFixedClock(START);
  workspaces = createMemoryWorkspaceStore();
  apiKeys = createMemoryApiKeyStore();
  precheck = createMemoryPrecheckStore();
  policyMutations = createMemoryPolicyMutationStore();
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
    precheckStore: precheck,
    policyMutationStore: policyMutations,
    clock,
  });
});

interface Tenant {
  readonly workspaceId: string;
  readonly key: string;
  readonly cookie: string;
}

async function tenant(email = 'op@example.test', name = 'Acme'): Promise<Tenant> {
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
    body: JSON.stringify({ name: 'runtime' }),
  });
  const { apiKey } = (await issued.json()) as { apiKey: { key: string } };
  precheck.seedPolicyState(workspaceId);
  policyMutations.seedPolicyState(workspaceId);
  policyMutations.seedAgent(workspaceId, AGENT_UUID, 'agent-a');
  return { workspaceId, key: apiKey.key, cookie };
}

function policy(
  t: Tenant,
  mode: 'watch' | 'budgeted' | 'paused',
  spend: string | null,
  publish: number | null,
): void {
  precheck.seedPolicy({
    workspaceId: t.workspaceId,
    agentExternalId: 'agent-a',
    mode,
    dailySpendCapUsd: spend,
    dailyPublishCap: publish,
  });
}

async function decide(t: Tenant, body: PrecheckRequest): Promise<PrecheckResponse> {
  const response = await app.request(PRECHECK_PATH, {
    method: 'POST',
    headers: { authorization: `Bearer ${t.key}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return precheckResponseSchema.parse(await response.json());
}

const spend = (actionId: string, amount: string): PrecheckRequest => ({
  action_id: actionId,
  agent_id: 'agent-a',
  category: 'spend',
  amount_usd: amount,
});

const publish = (actionId: string): PrecheckRequest => ({
  action_id: actionId,
  agent_id: 'agent-a',
  category: 'publish',
});

describe('NO BLOCK ON ALLOW', () => {
  it.each([
    ['watch', 'watch' as const, '25.000000', 5],
    ['budgeted within cap', 'budgeted' as const, '25.000000', 5],
    ['uncapped budgeted', 'budgeted' as const, null, null],
  ])('%s produces a receipt and no block', async (_label, mode, cap, publishCap) => {
    const t = await tenant();
    policy(t, mode, cap, publishCap);

    const response = await decide(t, spend('act-1', '1.000000'));

    expect(response.decision).toBe('allow');
    expect(precheck.receipts).toHaveLength(1);
    // An allow is not a denial. No incidental block.
    expect(precheck.blocks).toHaveLength(0);
  });

  it.each(['llm_call', 'tool_call', 'other'] as const)(
    'an allowed %s produces no block',
    async (category) => {
      const t = await tenant();
      policy(t, 'budgeted', '25.000000', 5);

      const response = await decide(t, {
        action_id: `act-${category}`,
        agent_id: 'agent-a',
        category,
      });

      expect(response.decision).toBe('allow');
      expect(precheck.blocks).toHaveLength(0);
    },
  );

  it('a watch-mode $41 spend produces no block even with a $25 cap set', async () => {
    const t = await tenant();
    policy(t, 'watch', '25.000000', null);

    await decide(t, spend('act-1', '41.000000'));

    // Watch allows; a cap left over from a previous budgeted period must not
    // manufacture a denial artifact.
    expect(precheck.blocks).toHaveLength(0);
    expect(precheck.ledger).toHaveLength(0);
  });

  it('five allowed publishes produce five receipts and no blocks', async () => {
    const t = await tenant();
    policy(t, 'budgeted', null, 5);

    for (let i = 1; i <= 5; i += 1) {
      expect((await decide(t, publish(`act-${String(i)}`))).decision).toBe('allow');
    }

    expect(precheck.receipts).toHaveLength(5);
    expect(precheck.blocks).toHaveLength(0);
  });
});

describe('AC-08 sequence: $41 against a $25 cap', () => {
  it('denies, records a receipt AND a plane block, and leaves the ledger at zero', async () => {
    const t = await tenant();
    policy(t, 'budgeted', '25.000000', null);

    const response = await decide(t, spend('act-1', '41.000000'));

    expect(response.decision).toBe('deny');
    expect(response.reason).toBe('daily_spend_cap_exceeded');

    // Exactly one of each, linked.
    expect(precheck.receipts).toHaveLength(1);
    expect(precheck.blocks).toHaveLength(1);
    const receipt = precheck.receipts[0];
    const block = precheck.blockForReceipt(receipt?.id ?? '');
    expect(block).toBeDefined();

    // Plane-owned, with no external identity.
    expect(block?.source).toBe('plane');
    expect(block?.externalBlockId).toBeNull();

    // The denial evidence AC-08 will present.
    expect(block?.category).toBe('spend');
    expect(block?.rule).toBe('daily_spend_cap');
    expect(block?.amountUsd).toBe('41.000000');
    expect(block?.count).toBeNull();
    expect(receipt?.appliedSpendCapUsd).toBe('25.000000');

    // A DENIAL NEVER MOVES THE LEDGER.
    expect(precheck.ledger.find((r) => r.spendCommittedUsd !== '0.000000')).toBeUndefined();
  });

  it('block and receipt agree on every shared field', async () => {
    const t = await tenant();
    policy(t, 'budgeted', '25.000000', null);
    await decide(t, spend('act-1', '41.000000'));

    const receipt = precheck.receipts[0];
    const block = precheck.blockForReceipt(receipt?.id ?? '');

    // The two artifacts must tell one story.
    expect(block?.workspaceId).toBe(receipt?.workspaceId);
    expect(block?.agentExternalId).toBe(receipt?.agentExternalId);
    expect(block?.category).toBe(receipt?.category);
    expect(block?.precheckReceiptId).toBe(receipt?.id);
    expect(block?.amountUsd).toBe(receipt?.requestedAmountUsd);
    // Same decision instant, not two events milliseconds apart.
    expect(block?.createdAt).toEqual(START);
  });

  it('the machine reason and the block rule come from one mapping', async () => {
    const t = await tenant();
    policy(t, 'budgeted', '25.000000', null);

    const response = await decide(t, spend('act-1', '41.000000'));
    const block = precheck.blockForReceipt(response.precheck_id);

    // reason = what happened; rule = which control fired. Never invented
    // independently at the call site.
    expect(response.reason).toBe('daily_spend_cap_exceeded');
    expect(precheck.receipts[0]?.denyReason).toBe('daily_spend_cap_exceeded');
    expect(block?.rule).toBe('daily_spend_cap');
    expect(block?.reason).toBe('Daily spend cap reached.');
  });
});

describe('AC-11 sequence: publish cap of 5', () => {
  it('allows five with no blocks, denies the sixth with exactly one block', async () => {
    const t = await tenant();
    policy(t, 'budgeted', null, 5);

    const decisions: string[] = [];
    for (let i = 1; i <= 6; i += 1) {
      decisions.push((await decide(t, publish(`act-${String(i)}`))).decision);
    }

    expect(decisions).toEqual(['allow', 'allow', 'allow', 'allow', 'allow', 'deny']);
    expect(precheck.receipts).toHaveLength(6);
    // ONE block, for the sixth action only.
    expect(precheck.blocks).toHaveLength(1);

    const sixth = precheck.receipts[5];
    const block = precheck.blockForReceipt(sixth?.id ?? '');
    expect(block?.category).toBe('publish');
    expect(block?.rule).toBe('daily_publish_cap');
    expect(block?.reason).toBe('Daily publish cap reached.');
    // Publish metadata in the count column, NEVER the spend column.
    expect(block?.count).toBe(1);
    expect(block?.amountUsd).toBeNull();

    // The denial changed nothing.
    expect(precheck.ledger[0]?.publishCountCommitted).toBe(5);
  });
});

describe('AC-12 sequence: pause then unpause', () => {
  it('setting paused creates NO block until an action is denied', async () => {
    const t = await tenant();
    policy(t, 'budgeted', '25.000000', 5);

    // The operator pauses through the Step 13 route.
    const mutation = await app.request(agentPolicyPath(t.workspaceId, AGENT_UUID), {
      method: 'PUT',
      headers: { cookie: t.cookie, origin: APP_URL, 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'paused',
        daily_spend_cap_usd: null,
        daily_publish_cap: null,
      }),
    });
    expect(mutation.status).toBe(200);

    // A POLICY CHANGE IS NOT A DENIAL. Blocks arise from refused actions.
    expect(precheck.blocks).toHaveLength(0);
    expect(precheck.receipts).toHaveLength(0);
  });

  it.each(['llm_call', 'tool_call', 'spend', 'publish', 'other'] as const)(
    'a paused %s denies with a block',
    async (category) => {
      const t = await tenant();
      policy(t, 'paused', '100.000000', 10);

      const response = await decide(t, {
        action_id: `act-${category}`,
        agent_id: 'agent-a',
        category,
        ...(category === 'spend' ? { amount_usd: '1.000000' } : {}),
      });

      expect(response.decision).toBe('deny');
      expect(response.reason).toBe('paused');

      const block = precheck.blockForReceipt(response.precheck_id);
      expect(block?.rule).toBe('agent_paused');
      expect(block?.reason).toBe('Agent is paused.');
      expect(block?.category).toBe(category);
      expect(block?.source).toBe('plane');
      // Nothing committed.
      expect(precheck.ledger).toHaveLength(0);
    },
  );

  it('a paused denial records metadata only where relevant', async () => {
    const t = await tenant();
    policy(t, 'paused', null, null);

    await decide(t, { action_id: 'act-1', agent_id: 'agent-a', category: 'other' });
    await decide(t, spend('act-2', '3.000000'));
    await decide(t, publish('act-3'));

    const [other, spendBlock, publishBlock] = precheck.blocks;
    // `other` refuses without an amount or a count to record.
    expect(other?.amountUsd).toBeNull();
    expect(other?.count).toBeNull();
    expect(spendBlock?.amountUsd).toBe('3.000000');
    expect(spendBlock?.count).toBeNull();
    expect(publishBlock?.count).toBe(1);
    expect(publishBlock?.amountUsd).toBeNull();
  });

  it('unpausing lets the next action through with no new block', async () => {
    const t = await tenant();
    policy(t, 'paused', null, null);
    await decide(t, { action_id: 'act-1', agent_id: 'agent-a', category: 'other' });
    expect(precheck.blocks).toHaveLength(1);

    // The operator unpauses; the fake stands in for the propagated policy.
    policy(t, 'budgeted', '25.000000', null);
    const resumed = await decide(t, spend('act-2', '5.000000'));

    expect(resumed.decision).toBe('allow');
    // Still exactly the one block from the earlier denial.
    expect(precheck.blocks).toHaveLength(1);
    expect(precheck.receipts).toHaveLength(2);
  });
});

describe('replay never creates a second block', () => {
  it('an identical replay of a denial returns the original and adds nothing', async () => {
    const t = await tenant();
    policy(t, 'budgeted', '25.000000', null);
    const first = await decide(t, spend('act-1', '41.000000'));

    const replay = await decide(t, spend('act-1', '41.000000'));

    expect(replay.precheck_id).toBe(first.precheck_id);
    expect(replay.decision).toBe('deny');
    expect(precheck.receipts).toHaveLength(1);
    expect(precheck.blocks).toHaveLength(1);
  });

  it('a CHANGED replay creates no alternate block', async () => {
    const t = await tenant();
    policy(t, 'budgeted', '25.000000', 5);
    const first = await decide(t, spend('act-1', '41.000000'));

    // Same action id, entirely different action.
    const changed = await decide(t, publish('act-1'));

    expect(changed.precheck_id).toBe(first.precheck_id);
    expect(precheck.blocks).toHaveLength(1);
    // The original block still describes the original spend refusal.
    expect(precheck.blocks[0]?.category).toBe('spend');
    expect(precheck.blocks[0]?.amountUsd).toBe('41.000000');
  });

  it('a replay of an ALLOW still creates no block', async () => {
    const t = await tenant();
    policy(t, 'budgeted', '25.000000', null);
    await decide(t, spend('act-1', '5.000000'));

    await decide(t, spend('act-1', '5.000000'));

    expect(precheck.blocks).toHaveLength(0);
    expect(precheck.receipts).toHaveLength(1);
  });

  it('a different action id after a denial creates its own block', async () => {
    const t = await tenant();
    policy(t, 'budgeted', '25.000000', null);
    await decide(t, spend('act-1', '41.000000'));

    await decide(t, spend('act-2', '41.000000'));

    expect(precheck.blocks).toHaveLength(2);
    expect(precheck.blocks[0]?.precheckReceiptId).not.toBe(
      precheck.blocks[1]?.precheckReceiptId,
    );
  });
});

describe('atomicity of the denial artifacts', () => {
  it('a failed BLOCK insert rolls the receipt back', async () => {
    const t = await tenant();
    policy(t, 'budgeted', '25.000000', null);
    precheck.failBlockInsert = true;

    const response = await app.request(PRECHECK_PATH, {
      method: 'POST',
      headers: { authorization: `Bearer ${t.key}`, 'content-type': 'application/json' },
      body: JSON.stringify(spend('act-1', '41.000000')),
    });

    expect(response.status).toBe(500);
    // A denial that cannot be fully recorded must not be half-recorded: a
    // receipt with no block would misrepresent the audit trail.
    expect(precheck.receipts).toHaveLength(0);
    expect(precheck.blocks).toHaveLength(0);
    expect(precheck.ledger.find((r) => r.spendCommittedUsd !== '0.000000')).toBeUndefined();
  });

  it('a failed RECEIPT insert leaves no block', async () => {
    const t = await tenant();
    policy(t, 'budgeted', '25.000000', null);
    precheck.failReceiptInsert = true;

    await app.request(PRECHECK_PATH, {
      method: 'POST',
      headers: { authorization: `Bearer ${t.key}`, 'content-type': 'application/json' },
      body: JSON.stringify(spend('act-1', '41.000000')),
    });

    expect(precheck.receipts).toHaveLength(0);
    expect(precheck.blocks).toHaveLength(0);
  });

  it('recovers cleanly on the next attempt', async () => {
    const t = await tenant();
    policy(t, 'budgeted', '25.000000', null);
    precheck.failBlockInsert = true;
    await app.request(PRECHECK_PATH, {
      method: 'POST',
      headers: { authorization: `Bearer ${t.key}`, 'content-type': 'application/json' },
      body: JSON.stringify(spend('act-1', '41.000000')),
    });

    precheck.failBlockInsert = false;
    const response = await decide(t, spend('act-1', '41.000000'));

    // The failed attempt consumed neither the action id nor any artifact.
    expect(response.decision).toBe('deny');
    expect(precheck.receipts).toHaveLength(1);
    expect(precheck.blocks).toHaveLength(1);
  });
});

describe('the caller cannot influence plane ownership', () => {
  it.each(['source', 'rule', 'reason', 'block_id', 'precheck_id'])(
    'rejects a %s field in the request',
    async (field) => {
      const t = await tenant();
      policy(t, 'budgeted', '25.000000', null);

      const response = await app.request(PRECHECK_PATH, {
        method: 'POST',
        headers: { authorization: `Bearer ${t.key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ...spend('act-1', '41.000000'), [field]: 'plane' }),
      });

      // Governance outputs are not inputs.
      expect(response.status).toBe(400);
      expect(precheck.blocks).toHaveLength(0);
      expect(precheck.receipts).toHaveLength(0);
    },
  );

  it('every plane block is marked plane, never runtime', async () => {
    const t = await tenant();
    policy(t, 'paused', null, null);

    for (const category of ['spend', 'publish', 'other'] as const) {
      await decide(t, {
        action_id: `act-${category}`,
        agent_id: 'agent-a',
        category,
        ...(category === 'spend' ? { amount_usd: '1.000000' } : {}),
      });
    }

    expect(precheck.blocks).toHaveLength(3);
    for (const block of precheck.blocks) {
      expect(block.source).toBe('plane');
      expect(block.externalBlockId).toBeNull();
    }
  });
});

describe('cross-tenant isolation', () => {
  it('a denial in one workspace creates no artifact in another', async () => {
    const a = await tenant('alice@example.test', 'Alice Co');
    const b = await tenant('bob@example.test', 'Bob Co');
    policy(a, 'paused', null, null);
    policy(b, 'budgeted', '100.000000', null);

    await decide(a, { action_id: 'act-1', agent_id: 'agent-a', category: 'other' });
    await decide(b, spend('act-2', '5.000000'));

    expect(precheck.blocks).toHaveLength(1);
    expect(precheck.blocks[0]?.workspaceId).toBe(a.workspaceId);
    // B's allow produced no block anywhere.
    expect(precheck.blocks.filter((x) => x.workspaceId === b.workspaceId)).toHaveLength(0);
  });

  it('the same action id in two workspaces yields two independent blocks', async () => {
    const a = await tenant('alice@example.test', 'Alice Co');
    const b = await tenant('bob@example.test', 'Bob Co');
    policy(a, 'paused', null, null);
    policy(b, 'paused', null, null);

    const fromA = await decide(a, { action_id: 'shared', agent_id: 'agent-a', category: 'other' });
    const fromB = await decide(b, { action_id: 'shared', agent_id: 'agent-a', category: 'other' });

    expect(fromA.precheck_id).not.toBe(fromB.precheck_id);
    expect(precheck.blocks).toHaveLength(2);
    expect(precheck.blocks[0]?.workspaceId).not.toBe(precheck.blocks[1]?.workspaceId);
  });
});

describe('the precheck response is unchanged', () => {
  it('exposes no block id', async () => {
    const t = await tenant();
    policy(t, 'budgeted', '25.000000', null);

    const response = await app.request(PRECHECK_PATH, {
      method: 'POST',
      headers: { authorization: `Bearer ${t.key}`, 'content-type': 'application/json' },
      body: JSON.stringify(spend('act-1', '41.000000')),
    });
    const raw = await response.text();

    // The Step 15 contract is unchanged: `precheck_id` is sufficient, and a
    // later receipt-detail endpoint will expose the linkage. Adding a field
    // now would widen the public contract for no present need.
    expect(Object.keys(JSON.parse(raw) as object).sort()).toEqual([
      'decision',
      'precheck_id',
      'reason',
      'remaining',
    ]);
    expect(raw).not.toContain('block');
  });
});
