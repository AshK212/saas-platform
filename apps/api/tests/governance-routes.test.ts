import {
  agentListResponseSchema,
  AUTH_CALLBACK_PATH,
  AUTH_MAGIC_LINK_PATH,
  blockDetailResponseSchema,
  blockListResponseSchema,
  GOVERNANCE_MAX_LIMIT,
  receiptDetailResponseSchema,
  receiptListResponseSchema,
  workspaceAgentsPath,
  workspaceApiKeysPath,
  workspaceBlockPath,
  workspaceBlocksPath,
  workspaceReceiptPath,
  workspaceReceiptsPath,
  type BlockListResponse,
  type ReceiptListResponse,
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
  createMemoryGovernanceStore,
  type MemoryGovernanceStore,
} from './helpers/memory-governance-store';
import {
  createMemoryWorkspaceStore,
  type MemoryWorkspaceStore,
} from './helpers/memory-workspace-store';

/**
 * Operator governance visibility (Step 17).
 *
 * The properties under test: only a browser session reads, every query is
 * workspace-scoped, historical evidence is shown as persisted, and nothing a
 * read touches is ever written.
 */

const APP_URL = 'https://app.example.test';
const START = new Date('2026-08-14T09:00:00.000Z');
const DAY = '2026-08-14';
const AGENT_A = '33333333-3333-4333-8333-333333333333';
const AGENT_B = '44444444-4444-4444-8444-444444444444';
const UNKNOWN_UUID = '55555555-5555-4555-8555-555555555555';

let authStore: MemoryAuthStore;
let mailer: CapturingEmailSender;
let clock: ReturnType<typeof createFixedClock>;
let workspaces: MemoryWorkspaceStore;
let apiKeys: MemoryApiKeyStore;
let agents: MemoryAgentStore;
let governance: MemoryGovernanceStore;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  authStore = createMemoryAuthStore();
  mailer = createCapturingEmailSender();
  clock = createFixedClock(START);
  workspaces = createMemoryWorkspaceStore();
  apiKeys = createMemoryApiKeyStore();
  agents = createMemoryAgentStore();
  governance = createMemoryGovernanceStore();
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
    governanceReadStore: governance,
    clock,
  });
});

interface Tenant {
  readonly workspaceId: string;
  readonly cookie: string;
  readonly key: string;
}

async function tenant(
  email: string,
  name: string,
  role: 'operator' | 'member' = 'operator',
): Promise<Tenant> {
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
  const workspaceId = workspaces.seedWorkspace(name, [{ userId, role }]);

  // An operator key exists so the machine-rejection assertions are real.
  const opCookie = role === 'operator' ? cookie : await operatorCookieFor(workspaceId);
  const issued = await app.request(workspaceApiKeysPath(workspaceId), {
    method: 'POST',
    headers: { cookie: opCookie, origin: APP_URL, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'runtime' }),
  });
  const body = (await issued.json()) as { apiKey?: { key: string } };
  return { workspaceId, cookie, key: body.apiKey?.key ?? '' };
}

/**
 * A member's own cookie cannot mint an API key, so borrow an operator's.
 *
 * The key exists purely so the "a machine credential is refused" assertions
 * test a real, valid key rather than a malformed string.
 */
async function operatorCookieFor(workspaceId: string): Promise<string> {
  const email = `op-${workspaceId}@example.test`;
  await app.request(AUTH_MAGIC_LINK_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  const token = new URL(mailer.lastLink()?.url ?? '').searchParams.get('token') ?? '';
  const callback = await app.request(`${AUTH_CALLBACK_PATH}?token=${token}`);
  const value = (callback.headers.get('set-cookie') ?? '').split(';')[0]?.split('=')[1] ?? '';
  workspaces.memberships.push({
    workspaceId,
    userId: authStore.users.get(email)?.id ?? '',
    role: 'operator',
  });
  return `${AUTH_COOKIE_NAME}=${value}`;
}

async function get(t: Tenant, path: string): Promise<Response> {
  return app.request(path, { headers: { cookie: t.cookie } });
}

async function receiptList(t: Tenant, query = ''): Promise<ReceiptListResponse> {
  const response = await get(t, `${workspaceReceiptsPath(t.workspaceId)}${query}`);
  expect(response.status).toBe(200);
  return receiptListResponseSchema.parse(await response.json());
}

async function blockList(t: Tenant, query = ''): Promise<BlockListResponse> {
  const response = await get(t, `${workspaceBlocksPath(t.workspaceId)}${query}`);
  expect(response.status).toBe(200);
  return blockListResponseSchema.parse(await response.json());
}

/** Seeds an agent in both the roster fake and the governance fake. */
function seedAgent(t: Tenant, id: string, externalId: string): void {
  governance.seedAgent({ workspaceId: t.workspaceId, id, externalId, displayName: externalId });
}

describe('authentication and permissions', () => {
  it.each([
    ['receipt list', (t: Tenant) => workspaceReceiptsPath(t.workspaceId)],
    ['receipt detail', (t: Tenant) => workspaceReceiptPath(t.workspaceId, UNKNOWN_UUID)],
    ['block list', (t: Tenant) => workspaceBlocksPath(t.workspaceId)],
    ['block detail', (t: Tenant) => workspaceBlockPath(t.workspaceId, UNKNOWN_UUID)],
  ])('rejects an unauthenticated %s request', async (_label, build) => {
    const t = await tenant('op@example.test', 'Acme');

    expect((await app.request(build(t))).status).toBe(401);
  });

  it.each([
    ['receipt list', (t: Tenant) => workspaceReceiptsPath(t.workspaceId)],
    ['block list', (t: Tenant) => workspaceBlocksPath(t.workspaceId)],
  ])('REFUSES a machine API key on the %s', async (_label, build) => {
    const t = await tenant('op@example.test', 'Acme');

    const response = await app.request(build(t), {
      headers: { authorization: `Bearer ${t.key}` },
    });

    // A runtime that can be denied must not be able to read the whole
    // tenant's denial history.
    expect(response.status).toBe(401);
  });

  it('a MEMBER may read receipts and blocks', async () => {
    const t = await tenant('member@example.test', 'Acme', 'member');
    seedAgent(t, AGENT_A, 'agent-a');
    governance.seedReceipt({
      workspaceId: t.workspaceId,
      agentId: AGENT_A,
      actionId: 'act-1',
      category: 'other',
      decision: 'allow',
      createdAt: START,
    });

    // Governance history is ordinary tenant data, like the agent roster.
    expect((await receiptList(t)).receipts).toHaveLength(1);
    expect((await blockList(t)).blocks).toEqual([]);
  });

  it('a member still cannot mutate policy', async () => {
    const t = await tenant('member@example.test', 'Acme', 'member');

    const response = await app.request(
      `/v1/workspaces/${t.workspaceId}/agents/${AGENT_A}/policy`,
      {
        method: 'PUT',
        headers: { cookie: t.cookie, origin: APP_URL, 'content-type': 'application/json' },
        body: JSON.stringify({
          mode: 'paused',
          daily_spend_cap_usd: null,
          daily_publish_cap: null,
        }),
      },
    );

    // Step 17 widened READS only.
    expect([403, 503]).toContain(response.status);
    expect(response.status).not.toBe(200);
  });

  it('returns 404 for a workspace the caller does not belong to', async () => {
    const a = await tenant('alice@example.test', 'Alice Co');
    const b = await tenant('bob@example.test', 'Bob Co');

    const response = await app.request(workspaceReceiptsPath(b.workspaceId), {
      headers: { cookie: a.cookie },
    });

    expect(response.status).toBe(404);
  });
});

describe('fleet governance state', () => {
  it('reports effective policy and today usage per agent', async () => {
    const t = await tenant('op@example.test', 'Acme');
    seedAgent(t, AGENT_A, 'agent-a');
    governance.seedPolicy({
      workspaceId: t.workspaceId,
      agentId: AGENT_A,
      mode: 'budgeted',
      dailySpendCapUsd: '25.000000',
      dailyPublishCap: 5,
    });
    governance.seedLedger({
      workspaceId: t.workspaceId,
      agentId: AGENT_A,
      day: DAY,
      spendCommittedUsd: '24.000000',
      publishCountCommitted: 4,
    });

    const response = await get(t, workspaceAgentsPath(t.workspaceId));
    const body = agentListResponseSchema.parse(await response.json());

    expect(body.agents[0]?.governance).toEqual({
      mode: 'budgeted',
      dailySpendCapUsd: '25.000000',
      dailyPublishCap: 5,
      spendCommittedUsd: '24.000000',
      publishCountCommitted: 4,
      accountingDay: DAY,
    });
  });

  it('an agent with no policy row reports the WATCH default', async () => {
    const t = await tenant('op@example.test', 'Acme');
    seedAgent(t, AGENT_A, 'agent-a');

    const response = await get(t, workspaceAgentsPath(t.workspaceId));
    const body = agentListResponseSchema.parse(await response.json());

    // The Step 12 default, computed by the backend. The frontend must not
    // re-derive it.
    expect(body.agents[0]?.governance?.mode).toBe('watch');
    expect(body.agents[0]?.governance?.dailySpendCapUsd).toBeNull();
    expect(body.agents[0]?.governance?.dailyPublishCap).toBeNull();
  });

  it('an agent with no ledger row reports ZERO without creating one', async () => {
    const t = await tenant('op@example.test', 'Acme');
    seedAgent(t, AGENT_A, 'agent-a');
    const before = governance.snapshot();

    const response = await get(t, workspaceAgentsPath(t.workspaceId));
    const body = agentListResponseSchema.parse(await response.json());

    expect(body.agents[0]?.governance?.spendCommittedUsd).toBe('0.000000');
    expect(body.agents[0]?.governance?.publishCountCommitted).toBe(0);
    // Opening a dashboard must not create accounting rows.
    expect(governance.snapshot()).toBe(before);
  });

  it('returns money as EXACT decimal strings', async () => {
    const t = await tenant('op@example.test', 'Acme');
    seedAgent(t, AGENT_A, 'agent-a');
    governance.seedPolicy({
      workspaceId: t.workspaceId,
      agentId: AGENT_A,
      mode: 'budgeted',
      dailySpendCapUsd: '25.000000',
      dailyPublishCap: null,
    });
    governance.seedLedger({
      workspaceId: t.workspaceId,
      agentId: AGENT_A,
      day: DAY,
      spendCommittedUsd: '24.000000',
      publishCountCommitted: 0,
    });

    const raw = await (await get(t, workspaceAgentsPath(t.workspaceId))).text();

    expect(raw).toContain('"spendCommittedUsd":"24.000000"');
    expect(raw).toContain('"dailySpendCapUsd":"25.000000"');
    // Never a JSON number.
    expect(raw).not.toContain('"spendCommittedUsd":24');
  });

  it('uses the SERVER accounting day, crossing UTC midnight', async () => {
    const t = await tenant('op@example.test', 'Acme');
    seedAgent(t, AGENT_A, 'agent-a');
    governance.seedLedger({
      workspaceId: t.workspaceId,
      agentId: AGENT_A,
      day: '2026-08-15',
      spendCommittedUsd: '7.000000',
      publishCountCommitted: 0,
    });

    // Still the 14th: yesterday's row is not shown.
    let body = agentListResponseSchema.parse(
      await (await get(t, workspaceAgentsPath(t.workspaceId))).json(),
    );
    expect(body.agents[0]?.governance?.spendCommittedUsd).toBe('0.000000');

    clock.advance(new Date('2026-08-15T00:00:00.000Z').getTime() - START.getTime());
    body = agentListResponseSchema.parse(
      await (await get(t, workspaceAgentsPath(t.workspaceId))).json(),
    );
    expect(body.agents[0]?.governance?.accountingDay).toBe('2026-08-15');
    expect(body.agents[0]?.governance?.spendCommittedUsd).toBe('7.000000');
  });

  it('never leaks another workspace usage', async () => {
    const a = await tenant('alice@example.test', 'Alice Co');
    const b = await tenant('bob@example.test', 'Bob Co');
    seedAgent(a, AGENT_A, 'agent-1');
    seedAgent(b, AGENT_B, 'agent-1');
    governance.seedLedger({
      workspaceId: b.workspaceId,
      agentId: AGENT_B,
      day: DAY,
      spendCommittedUsd: '99.000000',
      publishCountCommitted: 9,
    });

    const body = agentListResponseSchema.parse(
      await (await get(a, workspaceAgentsPath(a.workspaceId))).json(),
    );

    // Same external agent name, entirely separate usage.
    expect(body.agents).toHaveLength(1);
    expect(body.agents[0]?.governance?.spendCommittedUsd).toBe('0.000000');
  });
});

describe('receipt list', () => {
  function seedDecisions(t: Tenant, count: number, decision: 'allow' | 'deny' = 'allow'): void {
    for (let i = 0; i < count; i += 1) {
      governance.seedReceipt({
        workspaceId: t.workspaceId,
        agentId: AGENT_A,
        actionId: `act-${String(i).padStart(3, '0')}`,
        category: 'spend',
        decision,
        denyReason: decision === 'deny' ? 'daily_spend_cap_exceeded' : null,
        createdAt: new Date(START.getTime() + i * 1_000),
      });
    }
  }

  it('returns an empty page for a workspace with no decisions', async () => {
    const t = await tenant('op@example.test', 'Acme');

    expect(await receiptList(t)).toEqual({ receipts: [], nextCursor: null });
  });

  it('orders newest first', async () => {
    const t = await tenant('op@example.test', 'Acme');
    seedAgent(t, AGENT_A, 'agent-a');
    seedDecisions(t, 4);

    const body = await receiptList(t);

    expect(body.receipts.map((r) => r.actionId)).toEqual([
      'act-003',
      'act-002',
      'act-001',
      'act-000',
    ]);
  });

  it('pages without duplicates or gaps', async () => {
    const t = await tenant('op@example.test', 'Acme');
    seedAgent(t, AGENT_A, 'agent-a');
    seedDecisions(t, 23);

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const body: ReceiptListResponse = await receiptList(
        t,
        `?limit=7${cursor === null ? '' : `&cursor=${cursor}`}`,
      );
      seen.push(...body.receipts.map((r) => r.actionId));
      cursor = body.nextCursor;
      pages += 1;
      expect(pages).toBeLessThan(10);
    } while (cursor !== null);

    expect(seen).toHaveLength(23);
    expect(new Set(seen).size).toBe(23);
  });

  it('pages correctly when every timestamp is identical', async () => {
    const t = await tenant('op@example.test', 'Acme');
    seedAgent(t, AGENT_A, 'agent-a');
    for (let i = 0; i < 12; i += 1) {
      governance.seedReceipt({
        workspaceId: t.workspaceId,
        agentId: AGENT_A,
        actionId: `act-${String(i)}`,
        category: 'other',
        decision: 'allow',
        createdAt: START,
      });
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const body: ReceiptListResponse = await receiptList(
        t,
        `?limit=5${cursor === null ? '' : `&cursor=${cursor}`}`,
      );
      seen.push(...body.receipts.map((r) => r.actionId));
      cursor = body.nextCursor;
    } while (cursor !== null);

    // The id tiebreaker is what makes this work.
    expect(new Set(seen).size).toBe(12);
  });

  it('filters by decision', async () => {
    const t = await tenant('op@example.test', 'Acme');
    seedAgent(t, AGENT_A, 'agent-a');
    seedDecisions(t, 3, 'allow');
    governance.seedReceipt({
      workspaceId: t.workspaceId,
      agentId: AGENT_A,
      actionId: 'denied',
      category: 'spend',
      decision: 'deny',
      denyReason: 'daily_spend_cap_exceeded',
      createdAt: new Date(START.getTime() + 9_000),
    });

    const denied = await receiptList(t, '?decision=deny');

    expect(denied.receipts).toHaveLength(1);
    expect(denied.receipts[0]?.actionId).toBe('denied');
    expect((await receiptList(t, '?decision=allow')).receipts).toHaveLength(3);
  });

  it('filters by external agent id', async () => {
    const t = await tenant('op@example.test', 'Acme');
    seedAgent(t, AGENT_A, 'agent-a');
    seedAgent(t, AGENT_B, 'agent-b');
    seedDecisions(t, 2);
    governance.seedReceipt({
      workspaceId: t.workspaceId,
      agentId: AGENT_B,
      actionId: 'b-1',
      category: 'other',
      decision: 'allow',
      createdAt: START,
    });

    const body = await receiptList(t, '?agent_id=agent-b');

    expect(body.receipts).toHaveLength(1);
    expect(body.receipts[0]?.agent.agentId).toBe('agent-b');
  });

  it('an unknown agent filter returns an empty page, not 404', async () => {
    const t = await tenant('op@example.test', 'Acme');
    seedAgent(t, AGENT_A, 'agent-a');
    seedDecisions(t, 2);

    // A 404 would reveal whether the id exists in some other tenant.
    expect(await receiptList(t, '?agent_id=never-existed')).toEqual({
      receipts: [],
      nextCursor: null,
    });
  });

  it("another workspace's agent id also returns empty", async () => {
    const a = await tenant('alice@example.test', 'Alice Co');
    const b = await tenant('bob@example.test', 'Bob Co');
    seedAgent(b, AGENT_B, 'bobs-agent');
    governance.seedReceipt({
      workspaceId: b.workspaceId,
      agentId: AGENT_B,
      actionId: 'bobs',
      category: 'other',
      decision: 'allow',
      createdAt: START,
    });

    expect(await receiptList(a, '?agent_id=bobs-agent')).toEqual({
      receipts: [],
      nextCursor: null,
    });
  });

  it.each([
    ['zero limit', '?limit=0'],
    ['above maximum', `?limit=${String(GOVERNANCE_MAX_LIMIT + 1)}`],
    ['non-numeric limit', '?limit=abc'],
    ['unknown parameter', '?agent-id=agent-a'],
    ['unknown filter', '?status=denied'],
    ['invalid decision', '?decision=maybe'],
    ['malformed cursor', '?cursor=!!!'],
    ['tampered cursor', `?cursor=${Buffer.from('{}', 'utf8').toString('base64url')}`],
  ])('rejects %s with 400', async (_label, query) => {
    const t = await tenant('op@example.test', 'Acme');

    const response = await get(t, `${workspaceReceiptsPath(t.workspaceId)}${query}`);

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe('invalid_query');
  });
});

describe('receipt detail shows PERSISTED evidence', () => {
  it('renders the decision as it was recorded', async () => {
    const t = await tenant('op@example.test', 'Acme');
    seedAgent(t, AGENT_A, 'agent-a');
    const receiptId = governance.seedReceipt({
      workspaceId: t.workspaceId,
      agentId: AGENT_A,
      actionId: 'act-1',
      category: 'spend',
      decision: 'deny',
      denyReason: 'daily_spend_cap_exceeded',
      policyVersion: '4',
      appliedMode: 'budgeted',
      appliedSpendCapUsd: '25.000000',
      appliedPublishCap: null,
      requestedAmountUsd: '41.000000',
      ledgerSpendBeforeUsd: '0.000000',
      ledgerPublishBefore: 0,
      remainingSpendUsd: '25.000000',
      accountingDay: DAY,
      createdAt: START,
    });

    const response = await get(t, workspaceReceiptPath(t.workspaceId, receiptId));
    const body = receiptDetailResponseSchema.parse(await response.json());

    // The AC-08 explanation, entirely from persisted fields.
    expect(body.receipt.decision).toBe('deny');
    expect(body.receipt.reason).toBe('daily_spend_cap_exceeded');
    expect(body.receipt.requestedAmountUsd).toBe('41.000000');
    expect(body.receipt.appliedSpendCapUsd).toBe('25.000000');
    expect(body.receipt.ledgerSpendBeforeUsd).toBe('0.000000');
    expect(body.receipt.remainingSpendUsd).toBe('25.000000');
    expect(body.receipt.appliedMode).toBe('budgeted');
    expect(body.receipt.policyVersion).toBe('4');
  });

  it('a POLICY CHANGE TODAY does not rewrite yesterday explanation', async () => {
    const t = await tenant('op@example.test', 'Acme');
    seedAgent(t, AGENT_A, 'agent-a');
    const receiptId = governance.seedReceipt({
      workspaceId: t.workspaceId,
      agentId: AGENT_A,
      actionId: 'act-1',
      category: 'spend',
      decision: 'deny',
      denyReason: 'daily_spend_cap_exceeded',
      policyVersion: '2',
      appliedMode: 'budgeted',
      appliedSpendCapUsd: '25.000000',
      requestedAmountUsd: '41.000000',
      createdAt: START,
    });

    // The operator raises the cap and unpauses afterwards.
    governance.seedPolicy({
      workspaceId: t.workspaceId,
      agentId: AGENT_A,
      mode: 'watch',
      dailySpendCapUsd: '999.000000',
      dailyPublishCap: null,
    });

    const body = receiptDetailResponseSchema.parse(
      await (await get(t, workspaceReceiptPath(t.workspaceId, receiptId))).json(),
    );

    // Still explains itself with the policy that produced it.
    expect(body.receipt.appliedSpendCapUsd).toBe('25.000000');
    expect(body.receipt.appliedMode).toBe('budgeted');
    expect(body.receipt.policyVersion).toBe('2');
    expect(body.receipt.decision).toBe('deny');
  });

  it('an ALLOW receipt reports no block and no reason', async () => {
    const t = await tenant('op@example.test', 'Acme');
    seedAgent(t, AGENT_A, 'agent-a');
    const receiptId = governance.seedReceipt({
      workspaceId: t.workspaceId,
      agentId: AGENT_A,
      actionId: 'act-1',
      category: 'spend',
      decision: 'allow',
      requestedAmountUsd: '4.000000',
      ledgerSpendBeforeUsd: '20.000000',
      remainingSpendUsd: '1.000000',
      createdAt: START,
    });

    const body = receiptDetailResponseSchema.parse(
      await (await get(t, workspaceReceiptPath(t.workspaceId, receiptId))).json(),
    );

    expect(body.receipt.decision).toBe('allow');
    expect(body.receipt.reason).toBeNull();
    // Nothing implies a block exists.
    expect(body.receipt.block).toBeNull();
  });

  it('a paused denial carries no spend or publish quantities', async () => {
    const t = await tenant('op@example.test', 'Acme');
    seedAgent(t, AGENT_A, 'agent-a');
    const receiptId = governance.seedReceipt({
      workspaceId: t.workspaceId,
      agentId: AGENT_A,
      actionId: 'act-1',
      category: 'other',
      decision: 'deny',
      denyReason: 'paused',
      appliedMode: 'paused',
      createdAt: START,
    });

    const body = receiptDetailResponseSchema.parse(
      await (await get(t, workspaceReceiptPath(t.workspaceId, receiptId))).json(),
    );

    expect(body.receipt.reason).toBe('paused');
    expect(body.receipt.requestedAmountUsd).toBeNull();
    expect(body.receipt.requestedPublishCount).toBeNull();
    expect(body.receipt.ledgerSpendBeforeUsd).toBeNull();
  });

  it('exposes the plane block linkage on a denial', async () => {
    const t = await tenant('op@example.test', 'Acme');
    seedAgent(t, AGENT_A, 'agent-a');
    const receiptId = governance.seedReceipt({
      workspaceId: t.workspaceId,
      agentId: AGENT_A,
      actionId: 'act-1',
      category: 'spend',
      decision: 'deny',
      denyReason: 'daily_spend_cap_exceeded',
      createdAt: START,
    });
    const blockId = governance.seedBlock({
      workspaceId: t.workspaceId,
      agentId: AGENT_A,
      source: 'plane',
      category: 'spend',
      rule: 'daily_spend_cap',
      reason: 'Daily spend cap reached.',
      precheckReceiptId: receiptId,
      amountUsd: '41.000000',
      createdAt: START,
    });

    const body = receiptDetailResponseSchema.parse(
      await (await get(t, workspaceReceiptPath(t.workspaceId, receiptId))).json(),
    );

    // Block -> Why? -> Receipt navigation, both directions.
    expect(body.receipt.block).toEqual({ id: blockId, rule: 'daily_spend_cap' });
  });

  it.each([
    ['an unknown uuid', UNKNOWN_UUID],
    ['a malformed id', 'not-a-uuid'],
  ])('returns 404 for %s', async (_label, id) => {
    const t = await tenant('op@example.test', 'Acme');

    const response = await get(t, `${workspaceReceiptsPath(t.workspaceId)}/${id}`);

    expect(response.status).toBe(404);
  });

  it("CROSS-TENANT: a foreign receipt's exact uuid is 404", async () => {
    const a = await tenant('alice@example.test', 'Alice Co');
    const b = await tenant('bob@example.test', 'Bob Co');
    seedAgent(b, AGENT_B, 'bobs-agent');
    const bobsReceipt = governance.seedReceipt({
      workspaceId: b.workspaceId,
      agentId: AGENT_B,
      actionId: 'bobs-secret',
      category: 'other',
      decision: 'deny',
      denyReason: 'paused',
      createdAt: START,
    });

    const viaOwn = await get(a, workspaceReceiptPath(a.workspaceId, bobsReceipt));
    const viaForeign = await app.request(workspaceReceiptPath(b.workspaceId, bobsReceipt), {
      headers: { cookie: a.cookie },
    });

    expect(viaOwn.status).toBe(404);
    expect(viaForeign.status).toBe(404);
    expect(await viaOwn.text()).not.toContain('bobs-secret');
  });
});

describe('block list and detail', () => {
  it('shows BOTH runtime and plane blocks', async () => {
    const t = await tenant('op@example.test', 'Acme');
    seedAgent(t, AGENT_A, 'agent-a');
    governance.seedBlock({
      workspaceId: t.workspaceId,
      agentId: AGENT_A,
      source: 'plane',
      category: 'spend',
      rule: 'daily_spend_cap',
      reason: 'Daily spend cap reached.',
      precheckReceiptId: UNKNOWN_UUID,
      createdAt: new Date(START.getTime() + 1_000),
    });
    governance.seedBlock({
      workspaceId: t.workspaceId,
      agentId: AGENT_A,
      source: 'runtime',
      category: 'publish',
      rule: 'client_rule',
      reason: 'Runtime refused.',
      externalBlockId: 'client-block-1',
      createdAt: START,
    });

    const body = await blockList(t);

    expect(body.blocks).toHaveLength(2);
    expect(body.blocks.map((b) => b.source)).toEqual(['plane', 'runtime']);
  });

  it('a runtime block has NO receipt and keeps its external id', async () => {
    const t = await tenant('op@example.test', 'Acme');
    seedAgent(t, AGENT_A, 'agent-a');
    governance.seedBlock({
      workspaceId: t.workspaceId,
      agentId: AGENT_A,
      source: 'runtime',
      category: 'publish',
      rule: 'client_rule',
      reason: 'Runtime refused.',
      externalBlockId: 'client-block-1',
      createdAt: START,
    });

    const body = await blockList(t);

    // A plugin reporting its own refusal has no plane receipt; none is
    // fabricated.
    expect(body.blocks[0]?.precheckId).toBeNull();
    expect(body.blocks[0]?.externalBlockId).toBe('client-block-1');
  });

  it('a plane block carries a receipt and no external id', async () => {
    const t = await tenant('op@example.test', 'Acme');
    seedAgent(t, AGENT_A, 'agent-a');
    governance.seedBlock({
      workspaceId: t.workspaceId,
      agentId: AGENT_A,
      source: 'plane',
      category: 'spend',
      rule: 'daily_spend_cap',
      reason: 'Daily spend cap reached.',
      precheckReceiptId: UNKNOWN_UUID,
      createdAt: START,
    });

    const body = await blockList(t);

    expect(body.blocks[0]?.precheckId).toBe(UNKNOWN_UUID);
    expect(body.blocks[0]?.externalBlockId).toBeNull();
  });

  it('filters by source', async () => {
    const t = await tenant('op@example.test', 'Acme');
    seedAgent(t, AGENT_A, 'agent-a');
    for (const source of ['plane', 'runtime', 'runtime'] as const) {
      governance.seedBlock({
        workspaceId: t.workspaceId,
        agentId: AGENT_A,
        source,
        category: 'other',
        rule: 'r',
        reason: 'x',
        createdAt: START,
      });
    }

    expect((await blockList(t, '?source=plane')).blocks).toHaveLength(1);
    expect((await blockList(t, '?source=runtime')).blocks).toHaveLength(2);
  });

  it('block detail carries the refused quantity', async () => {
    const t = await tenant('op@example.test', 'Acme');
    seedAgent(t, AGENT_A, 'agent-a');
    const blockId = governance.seedBlock({
      workspaceId: t.workspaceId,
      agentId: AGENT_A,
      source: 'plane',
      category: 'spend',
      rule: 'daily_spend_cap',
      reason: 'Daily spend cap reached.',
      amountUsd: '41.000000',
      createdAt: START,
    });

    const body = blockDetailResponseSchema.parse(
      await (await get(t, workspaceBlockPath(t.workspaceId, blockId))).json(),
    );

    expect(body.block.amountUsd).toBe('41.000000');
    expect(body.block.count).toBeNull();
    expect(body.block.rule).toBe('daily_spend_cap');
  });

  it.each([
    ['an invalid source', '?source=operator'],
    ['an unknown parameter', '?owner=plane'],
  ])('rejects %s with 400', async (_label, query) => {
    const t = await tenant('op@example.test', 'Acme');

    expect((await get(t, `${workspaceBlocksPath(t.workspaceId)}${query}`)).status).toBe(400);
  });

  it("CROSS-TENANT: a foreign block's exact uuid is 404", async () => {
    const a = await tenant('alice@example.test', 'Alice Co');
    const b = await tenant('bob@example.test', 'Bob Co');
    seedAgent(b, AGENT_B, 'bobs-agent');
    const bobsBlock = governance.seedBlock({
      workspaceId: b.workspaceId,
      agentId: AGENT_B,
      source: 'plane',
      category: 'other',
      rule: 'agent_paused',
      reason: 'bob-only-secret',
      createdAt: START,
    });

    const response = await get(a, workspaceBlockPath(a.workspaceId, bobsBlock));

    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('bob-only-secret');
  });
});

describe('read-only surface', () => {
  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])(
    'refuses %s on receipts and blocks',
    async (method) => {
      const t = await tenant('op@example.test', 'Acme');

      for (const path of [
        workspaceReceiptsPath(t.workspaceId),
        workspaceReceiptPath(t.workspaceId, UNKNOWN_UUID),
        workspaceBlocksPath(t.workspaceId),
        workspaceBlockPath(t.workspaceId, UNKNOWN_UUID),
      ]) {
        const response = await app.request(path, {
          method,
          headers: { cookie: t.cookie, origin: APP_URL, 'content-type': 'application/json' },
          body: JSON.stringify({}),
        });
        // Audit evidence is not editable.
        expect(response.status, `${method} ${path}`).toBe(404);
      }
    },
  );

  it('reading changes nothing at all', async () => {
    const t = await tenant('op@example.test', 'Acme');
    seedAgent(t, AGENT_A, 'agent-a');
    governance.seedReceipt({
      workspaceId: t.workspaceId,
      agentId: AGENT_A,
      actionId: 'act-1',
      category: 'other',
      decision: 'allow',
      createdAt: START,
    });
    const before = governance.snapshot();

    await get(t, workspaceAgentsPath(t.workspaceId));
    await receiptList(t);
    await blockList(t);
    const receiptId = (await receiptList(t)).receipts[0]?.id ?? '';
    await get(t, workspaceReceiptPath(t.workspaceId, receiptId));

    // No ledger row, no policy row, no last-seen refresh, no receipt, no block.
    expect(governance.snapshot()).toBe(before);
  });
});

describe('no secrets in governance responses', () => {
  it('carries no key, cookie or workspace id', async () => {
    const t = await tenant('op@example.test', 'Acme');
    seedAgent(t, AGENT_A, 'agent-a');
    governance.seedReceipt({
      workspaceId: t.workspaceId,
      agentId: AGENT_A,
      actionId: 'act-1',
      category: 'other',
      decision: 'allow',
      createdAt: START,
    });

    const raw = await (await get(t, workspaceReceiptsPath(t.workspaceId))).text();

    expect(raw).not.toContain(t.key);
    expect(raw).not.toContain('hmp_live');
    expect(raw).not.toContain(t.cookie);
    expect(raw).not.toContain(t.workspaceId);
    expect(raw).not.toMatch(/secret|hash|authorization|postgres:\/\//i);
  });
});

describe('unavailable without a database', () => {
  it.each([
    ['receipts', '/v1/workspaces/any/receipts'],
    ['blocks', '/v1/workspaces/any/blocks'],
  ])('reports 503 on %s rather than crashing', async (_label, path) => {
    const noDb = createApp({ probeDatabase: () => Promise.resolve('unconfigured') });

    expect((await noDb.request(path)).status).toBe(503);
  });

  it('leaves liveness unaffected', async () => {
    const noDb = createApp({ probeDatabase: () => Promise.resolve('unconfigured') });

    expect((await noDb.request('/healthz')).status).toBe(200);
  });
});
