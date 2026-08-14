import {
  AUTH_CALLBACK_PATH,
  AUTH_MAGIC_LINK_PATH,
  EVENT_INGEST_PATH,
  PRECHECK_PATH,
  workspaceApiKeysPath,
} from '@hybrid/contracts';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { createFixedClock } from '../src/auth/clock';
import { AUTH_COOKIE_NAME } from '../src/auth/cookie';
import { createCapturingEmailSender, type CapturingEmailSender } from '../src/auth/email';
import { createAuthService, type AuthService } from '../src/auth/service';
import { createMemoryAgentStore } from './helpers/memory-agent-store';
import { createMemoryApiKeyStore, type MemoryApiKeyStore } from './helpers/memory-api-key-store';
import { createMemoryAuthStore, type MemoryAuthStore } from './helpers/memory-auth-store';
import { createMemoryEventStore, type MemoryEventStore } from './helpers/memory-event-store';
import {
  createMemoryPrecheckStore,
  type MemoryPrecheckStore,
} from './helpers/memory-precheck-store';
import {
  createMemoryWorkspaceStore,
  type MemoryWorkspaceStore,
} from './helpers/memory-workspace-store';

/**
 * STEP 18 - PRECHECK-LINKED EVENT SETTLEMENT.
 *
 *   PRECHECK COMMITS THE AUTHORITATIVE USAGE.
 *   THE FOLLOW-UP EVENT RECORDS WHAT HAPPENED.
 *   THE EVENT NEVER COMMITS THAT USAGE AGAIN.
 *
 * ─── WHAT THIS FILE CAN AND CANNOT PROVE ──────────────────────────────────
 *
 * The ledger lives in the PRECHECK store. The event store has no ledger at all
 * and no way to reach one - which is most of why the no-double-debit property
 * holds, and is asserted structurally in `event-settlement-boundary.test.ts`.
 * So "$4 stayed $4" here is strong evidence but not the whole proof; the real
 * shared-table version is `packages/db/tests/event-settlement.live.test.ts`,
 * which is skipped without `TEST_DATABASE_URL`.
 *
 * What this file DOES prove end to end through real HTTP: that a genuine
 * precheck receipt is accepted as settlement evidence, that every incoherent
 * claim on it is refused, and that a duplicate never re-examines the claim.
 *
 * ─── THE BRIDGE ───────────────────────────────────────────────────────────
 *
 * In production both routes read one `precheck_receipts` table. In process
 * they are two fakes, so `settle()` copies the decision the precheck engine
 * actually recorded into the event store's receipt table. It copies FACTS the
 * engine produced - never facts the test wants - so a test cannot accidentally
 * assert against a receipt production would not have written.
 */

const APP_URL = 'https://app.example.test';
const START = new Date('2026-08-13T10:00:00.000Z');
const FOREIGN_UUID = '11111111-1111-4111-8111-111111111111';

let authStore: MemoryAuthStore;
let mailer: CapturingEmailSender;
let workspaces: MemoryWorkspaceStore;
let apiKeys: MemoryApiKeyStore;
let eventStore: MemoryEventStore;
let precheck: MemoryPrecheckStore;
let service: AuthService;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  authStore = createMemoryAuthStore();
  mailer = createCapturingEmailSender();
  const clock = createFixedClock(START);
  service = createAuthService({
    store: authStore,
    mailer,
    clock,
    appUrl: APP_URL,
    callbackPath: AUTH_CALLBACK_PATH,
  });
  workspaces = createMemoryWorkspaceStore();
  apiKeys = createMemoryApiKeyStore();
  eventStore = createMemoryEventStore();
  precheck = createMemoryPrecheckStore();
  app = createApp({
    probeDatabase: () => Promise.resolve('ok'),
    authService: service,
    appUrl: APP_URL,
    secureCookies: true,
    workspaceStore: workspaces,
    apiKeyStore: apiKeys,
    agentStore: createMemoryAgentStore(),
    eventStore,
    precheckStore: precheck,
    clock,
  });
});

interface Tenant {
  readonly workspaceId: string;
  readonly key: string;
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
    body: JSON.stringify({ name: `${name} key` }),
  });
  const { apiKey } = (await issued.json()) as { apiKey: { key: string } };
  precheck.seedPolicyState(workspaceId);
  return { workspaceId, key: apiKey.key };
}

/** Configures an agent's policy, as the operator route would. */
function policy(
  t: Tenant,
  mode: 'watch' | 'budgeted' | 'paused',
  spend: string | null = '25.000000',
  publish: number | null = 5,
  agentExternalId = 'agent-a',
): void {
  precheck.seedPolicy({
    workspaceId: t.workspaceId,
    agentExternalId,
    mode,
    dailySpendCapUsd: spend,
    dailyPublishCap: publish,
  });
}

async function runPrecheck(t: Tenant, body: unknown): Promise<Record<string, unknown>> {
  const response = await app.request(PRECHECK_PATH, {
    method: 'POST',
    headers: { authorization: `Bearer ${t.key}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await response.json()) as Record<string, unknown>;
}

async function ingest(t: Tenant, events: unknown[]): Promise<Response> {
  return app.request(EVENT_INGEST_PATH, {
    method: 'POST',
    headers: { authorization: `Bearer ${t.key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ events }),
  });
}

/**
 * Makes the receipt the precheck engine wrote visible to event ingest.
 *
 * Copies only what the engine recorded. In production this is one table and no
 * bridge exists.
 */
function settle(t: Tenant, precheckId: string): string {
  const recorded = precheck.receipts.find((r) => r.id === precheckId);
  if (recorded === undefined) {
    throw new Error(`no receipt ${precheckId}`);
  }
  return eventStore.seedReceipt(t.workspaceId, {
    agentExternalId: recorded.agentExternalId,
    category: recorded.category,
    decision: recorded.decision,
    requestedAmountUsd: recorded.requestedAmountUsd,
    requestedPublishCount: recorded.requestedPublishCount,
  });
}

/**
 * Today's committed spend, read the way the plane reads it.
 *
 * An absent row is ZERO COMMITTED, not "unknown" - the same read semantics
 * Step 17 uses. It matters here because a `budgeted` decision consults the
 * ledger under lock even when it denies, so the row may exist at zero while a
 * `watch` decision leaves no row at all. Both mean the same thing: nothing was
 * committed, and these tests are about committed amounts.
 */
function committedSpend(t: Tenant, agentExternalId = 'agent-a'): string {
  const row = precheck.usageOf(t.workspaceId, agentExternalId, '2026-08-13');
  return row?.spendCommittedUsd ?? '0.000000';
}

function committedPublishes(t: Tenant, agentExternalId = 'agent-a'): number {
  return precheck.usageOf(t.workspaceId, agentExternalId, '2026-08-13')?.publishCountCommitted ?? 0;
}

/** A well-formed settled spend event. */
const spendEvent = (
  eventId: string,
  precheckId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  type: 'spend.recorded',
  event_id: eventId,
  agent_id: 'agent-a',
  amount_usd: '4.000000',
  provider: 'openai',
  precheck_id: precheckId,
  ...overrides,
});

async function issues(response: Response): Promise<{ path: string; message: string }[]> {
  const body = (await response.json()) as { issues?: { path: string; message: string }[] };
  return body.issues ?? [];
}

// ───────────────────────────────────────────────────────────────────────────

describe('THE NO-DOUBLE-DEBIT INVARIANT', () => {
  it('$4 prechecked then reported stays $4, not $8', async () => {
    const t = await tenant('op@example.test', 'Acme');
    policy(t, 'budgeted');

    // Initial: nothing committed.
    expect(committedSpend(t)).toBe('0.000000');

    // The precheck is the accounting authority.
    const decision = await runPrecheck(t, {
      action_id: 'act-1',
      agent_id: 'agent-a',
      category: 'spend',
      amount_usd: '4.000000',
    });
    expect(decision['decision']).toBe('allow');
    expect(committedSpend(t)).toBe('4.000000');

    const receiptId = settle(t, decision['precheck_id'] as string);
    const receiptsBefore = eventStore.receipts.length;

    // The follow-up event records what happened.
    const response = await ingest(t, [spendEvent('evt-1', receiptId)]);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accepted: 1, duplicates: 0 });

    // THE ASSERTION THIS WHOLE STEP EXISTS FOR.
    expect(committedSpend(t)).toBe('4.000000');
    expect(eventStore.events).toHaveLength(1);
    expect(eventStore.events[0]?.precheckReceiptId).toBe(receiptId);
    // No receipt created, none modified.
    expect(eventStore.receipts).toHaveLength(receiptsBefore);
    expect(precheck.receipts).toHaveLength(1);
  });

  it('a prechecked publish is not counted twice', async () => {
    const t = await tenant('op@example.test', 'Acme');
    policy(t, 'budgeted');

    const decision = await runPrecheck(t, {
      action_id: 'act-1',
      agent_id: 'agent-a',
      category: 'publish',
    });
    expect(decision['decision']).toBe('allow');
    expect(committedPublishes(t)).toBe(1);

    const receiptId = settle(t, decision['precheck_id'] as string);

    // There is no `publish.recorded` in the vocabulary, and inventing one would
    // be a contract change for no reason. A completed publish is an
    // `agent.action` with category `publish`.
    const response = await ingest(t, [
      {
        type: 'agent.action',
        event_id: 'evt-1',
        agent_id: 'agent-a',
        category: 'publish',
        precheck_id: receiptId,
      },
    ]);

    expect(response.status).toBe(200);
    expect(committedPublishes(t)).toBe(1);
  });

  it('MANY legitimate follow-up events settle one precheck without re-debiting', async () => {
    // `precheck_id` is NOT event identity. A runtime may legitimately emit both
    // an `agent.action` and a `spend.recorded` for one authorized action, or
    // retry-with-new-id after a crash. None of them may debit.
    const t = await tenant('op@example.test', 'Acme');
    policy(t, 'budgeted');

    const decision = await runPrecheck(t, {
      action_id: 'act-1',
      agent_id: 'agent-a',
      category: 'spend',
      amount_usd: '4.000000',
    });
    const receiptId = settle(t, decision['precheck_id'] as string);

    const response = await ingest(t, [
      spendEvent('evt-1', receiptId),
      spendEvent('evt-2', receiptId),
      {
        type: 'agent.action',
        event_id: 'evt-3',
        agent_id: 'agent-a',
        category: 'spend',
        precheck_id: receiptId,
      },
    ]);

    expect(await response.json()).toEqual({ accepted: 3, duplicates: 0 });
    expect(eventStore.events).toHaveLength(3);
    // Three linked events, one debit.
    expect(committedSpend(t)).toBe('4.000000');
  });

  it('WATCH MODE: the precheck did not debit, and the event does not either', async () => {
    // The receipt captures the authoritative decision semantics. `watch`
    // deliberately records nothing, and a follow-up event is not a second
    // chance to make an accounting decision - it is audit evidence.
    const t = await tenant('op@example.test', 'Acme');
    policy(t, 'watch', '25.000000', 5);

    const decision = await runPrecheck(t, {
      action_id: 'act-1',
      agent_id: 'agent-a',
      category: 'spend',
      amount_usd: '4.000000',
    });
    expect(decision['decision']).toBe('allow');
    // Watch allows and records nothing.
    expect(committedSpend(t)).toBe('0.000000');

    const receiptId = settle(t, decision['precheck_id'] as string);
    const response = await ingest(t, [spendEvent('evt-1', receiptId)]);

    expect(response.status).toBe(200);
    expect(eventStore.events).toHaveLength(1);
    // Still nothing. An operator who has not opted into enforcement has not
    // opted into having usage counted against them by the back door either.
    expect(committedSpend(t)).toBe('0.000000');
  });
});

describe('receipt authority is workspace-scoped', () => {
  it("REJECTS another workspace's receipt by its exact uuid", async () => {
    const a = await tenant('alice@example.test', 'Alice Co');
    const b = await tenant('bob@example.test', 'Bob Co');
    policy(b, 'budgeted');

    const decision = await runPrecheck(b, {
      action_id: 'act-1',
      agent_id: 'agent-a',
      category: 'spend',
      amount_usd: '4.000000',
    });
    const bobsReceipt = settle(b, decision['precheck_id'] as string);

    const response = await ingest(a, [spendEvent('evt-1', bobsReceipt)]);

    expect(response.status).toBe(400);
    // Indistinguishable from a receipt that does not exist.
    expect((await issues(response))[0]?.message).toBe('Unknown precheck_id for this workspace.');
    expect(eventStore.events).toHaveLength(0);
    expect(committedSpend(b)).toBe('4.000000');
  });

  it('reports a foreign receipt and an unknown one identically', async () => {
    const a = await tenant('alice@example.test', 'Alice Co');
    const b = await tenant('bob@example.test', 'Bob Co');
    policy(b, 'budgeted');
    const decision = await runPrecheck(b, {
      action_id: 'act-1',
      agent_id: 'agent-a',
      category: 'spend',
      amount_usd: '4.000000',
    });
    const bobsReceipt = settle(b, decision['precheck_id'] as string);

    const foreign = await ingest(a, [spendEvent('evt-1', bobsReceipt)]);
    const unknown = await ingest(a, [spendEvent('evt-1', FOREIGN_UUID)]);

    expect(foreign.status).toBe(unknown.status);
    expect(await issues(foreign)).toEqual(await issues(unknown));
  });

  it('a forged uuid is rejected and stores nothing', async () => {
    const t = await tenant('op@example.test', 'Acme');

    const response = await ingest(t, [spendEvent('evt-1', FOREIGN_UUID)]);

    expect(response.status).toBe(400);
    expect(eventStore.events).toHaveLength(0);
    expect(eventStore.agents).toHaveLength(0);
  });
});

describe('the claim must be coherent with the receipt', () => {
  async function allowedSpend(t: Tenant, amount = '4.000000'): Promise<string> {
    const decision = await runPrecheck(t, {
      action_id: `act-${amount}`,
      agent_id: 'agent-a',
      category: 'spend',
      amount_usd: amount,
    });
    return settle(t, decision['precheck_id'] as string);
  }

  it('REJECTS a receipt belonging to a different agent', async () => {
    const t = await tenant('op@example.test', 'Acme');
    policy(t, 'budgeted');
    const receiptId = await allowedSpend(t);

    // agent-b claiming agent-a's authorization. If this were allowed, one
    // prechecked $4 could absolve spend across the whole fleet.
    const response = await ingest(t, [
      spendEvent('evt-1', receiptId, { agent_id: 'agent-b' }),
    ]);

    expect(response.status).toBe(400);
    expect((await issues(response))[0]?.message).toBe('precheck_id belongs to a different agent.');
    expect(eventStore.events).toHaveLength(0);
    expect(committedSpend(t)).toBe('4.000000');
  });

  it('REJECTS a publish receipt used as spend evidence', async () => {
    const t = await tenant('op@example.test', 'Acme');
    policy(t, 'budgeted');
    const decision = await runPrecheck(t, {
      action_id: 'act-1',
      agent_id: 'agent-a',
      category: 'publish',
    });
    const receiptId = settle(t, decision['precheck_id'] as string);

    const response = await ingest(t, [spendEvent('evt-1', receiptId)]);

    expect(response.status).toBe(400);
    expect((await issues(response))[0]?.message).toBe(
      'precheck_id references a publish decision, not spend.',
    );
    expect(eventStore.events).toHaveLength(0);
  });

  it.each(['llm_call', 'tool_call', 'other'] as const)(
    'REJECTS a %s receipt used as spend evidence',
    async (category) => {
      // An untracked category does not become spend merely by being referenced.
      const t = await tenant('op@example.test', 'Acme');
      policy(t, 'budgeted');
      const decision = await runPrecheck(t, {
        action_id: 'act-1',
        agent_id: 'agent-a',
        category,
      });
      const receiptId = settle(t, decision['precheck_id'] as string);

      const response = await ingest(t, [spendEvent('evt-1', receiptId)]);

      expect(response.status).toBe(400);
      expect(eventStore.events).toHaveLength(0);
    },
  );

  it('REJECTS a spend receipt used as publish evidence', async () => {
    const t = await tenant('op@example.test', 'Acme');
    policy(t, 'budgeted');
    const receiptId = await allowedSpend(t);

    const response = await ingest(t, [
      {
        type: 'agent.action',
        event_id: 'evt-1',
        agent_id: 'agent-a',
        category: 'publish',
        precheck_id: receiptId,
      },
    ]);

    expect(response.status).toBe(400);
    expect(eventStore.events).toHaveLength(0);
    expect(committedPublishes(t)).toBe(0);
  });

  it('REJECTS AN INFLATED AMOUNT', async () => {
    const t = await tenant('op@example.test', 'Acme');
    policy(t, 'budgeted');
    const receiptId = await allowedSpend(t, '4.000000');

    // $4 authorized, $41 claimed. Accepting this would record $41 of spend
    // while charging the ledger $4 - the exact hole this step closes.
    const response = await ingest(t, [
      spendEvent('evt-1', receiptId, { amount_usd: '41.000000' }),
    ]);

    expect(response.status).toBe(400);
    expect((await issues(response))[0]?.message).toBe(
      'amount_usd does not match the amount this precheck authorized.',
    );
    expect(eventStore.events).toHaveLength(0);
    expect(committedSpend(t)).toBe('4.000000');
  });

  it('REJECTS an amount that is off by ONE MICRO-DOLLAR', async () => {
    const t = await tenant('op@example.test', 'Acme');
    policy(t, 'budgeted');
    const receiptId = await allowedSpend(t, '4.000000');

    const response = await ingest(t, [
      spendEvent('evt-1', receiptId, { amount_usd: '4.000001' }),
    ]);

    expect(response.status).toBe(400);
    expect(eventStore.events).toHaveLength(0);
  });

  it.each(['4', '4.0', '4.00', '4.000000'])(
    'ACCEPTS %s as the same money as 4.000000',
    async (written) => {
      // All four are valid wire representations of the same amount. String
      // equality would reject three of them.
      const t = await tenant('op@example.test', 'Acme');
      policy(t, 'budgeted');
      const receiptId = await allowedSpend(t, '4.000000');

      const response = await ingest(t, [
        spendEvent('evt-1', receiptId, { amount_usd: written }),
      ]);

      expect(response.status).toBe(200);
      expect(eventStore.events).toHaveLength(1);
      expect(committedSpend(t)).toBe('4.000000');
    },
  );

  it('REJECTS a DENIED receipt as evidence of success', async () => {
    const t = await tenant('op@example.test', 'Acme');
    policy(t, 'budgeted', '25.000000', 5);

    const decision = await runPrecheck(t, {
      action_id: 'act-1',
      agent_id: 'agent-a',
      category: 'spend',
      amount_usd: '41.000000',
    });
    expect(decision['decision']).toBe('deny');
    const receiptId = settle(t, decision['precheck_id'] as string);
    const blocksBefore = precheck.blocks.length;

    const response = await ingest(t, [
      spendEvent('evt-1', receiptId, { amount_usd: '41.000000' }),
    ]);

    expect(response.status).toBe(400);
    expect((await issues(response))[0]?.message).toBe(
      'precheck_id references a denied decision.',
    );
    expect(eventStore.events).toHaveLength(0);
    // The denial and its plane block are untouched.
    expect(precheck.blocks).toHaveLength(blocksBefore);
    expect(precheck.receipts[0]?.decision).toBe('deny');
    expect(committedSpend(t)).toBe('0.000000');
  });

  it('a runtime action.blocked MAY cite a denied receipt', async () => {
    // The coherent direction: a runtime reporting the denial it was given.
    const t = await tenant('op@example.test', 'Acme');
    policy(t, 'budgeted', '25.000000', 5);
    const decision = await runPrecheck(t, {
      action_id: 'act-1',
      agent_id: 'agent-a',
      category: 'spend',
      amount_usd: '41.000000',
    });
    const receiptId = settle(t, decision['precheck_id'] as string);

    const response = await ingest(t, [
      {
        type: 'action.blocked',
        event_id: 'evt-1',
        agent_id: 'agent-a',
        category: 'spend',
        rule: 'daily_spend_cap',
        reason: 'Daily spend cap reached.',
        amount_usd: '41.000000',
        precheck_id: receiptId,
      },
    ]);

    expect(response.status).toBe(200);
    expect(eventStore.events).toHaveLength(1);
    expect(committedSpend(t)).toBe('0.000000');
  });

  it('REJECTS a heartbeat carrying a precheck_id', async () => {
    // A liveness ping is not the completion of a governed action, so there is
    // nothing for it to follow up on. Meaningless linkage in an audit trail is
    // worse than none. This TIGHTENS the Step 9 contract, which placed
    // precheck_id on every variant for uniformity.
    const t = await tenant('op@example.test', 'Acme');
    policy(t, 'budgeted');
    const receiptId = await allowedSpend(t);

    const response = await ingest(t, [
      { type: 'heartbeat', event_id: 'evt-1', agent_id: 'agent-a', precheck_id: receiptId },
    ]);

    expect(response.status).toBe(400);
    expect((await issues(response))[0]?.message).toBe('A heartbeat cannot reference a precheck.');
    expect(eventStore.events).toHaveLength(0);
  });

  it('a heartbeat WITHOUT a precheck_id is unaffected', async () => {
    const t = await tenant('op@example.test', 'Acme');

    const response = await ingest(t, [
      { type: 'heartbeat', event_id: 'evt-1', agent_id: 'agent-a' },
    ]);

    expect(response.status).toBe(200);
    expect(eventStore.events).toHaveLength(1);
  });

  it('names the offending event in a mixed batch, and stores none of it', async () => {
    const t = await tenant('op@example.test', 'Acme');
    policy(t, 'budgeted');
    const receiptId = await allowedSpend(t);

    const response = await ingest(t, [
      spendEvent('evt-0', receiptId),
      spendEvent('evt-1', receiptId, { amount_usd: '41.000000' }),
      spendEvent('evt-2', receiptId),
    ]);

    expect(response.status).toBe(400);
    expect((await issues(response))[0]?.path).toBe('events.1.precheck_id');
    // Whole batch rolled back - no partial commit.
    expect(eventStore.events).toHaveLength(0);
  });
});

describe('idempotency still comes first', () => {
  it('a duplicate linked event is a duplicate, and debits nothing', async () => {
    const t = await tenant('op@example.test', 'Acme');
    policy(t, 'budgeted');
    const decision = await runPrecheck(t, {
      action_id: 'act-1',
      agent_id: 'agent-a',
      category: 'spend',
      amount_usd: '4.000000',
    });
    const receiptId = settle(t, decision['precheck_id'] as string);

    const first = await ingest(t, [spendEvent('evt-1', receiptId)]);
    const second = await ingest(t, [spendEvent('evt-1', receiptId)]);

    expect(await first.json()).toEqual({ accepted: 1, duplicates: 0 });
    expect(await second.json()).toEqual({ accepted: 0, duplicates: 1 });
    expect(eventStore.events).toHaveLength(1);
    expect(committedSpend(t)).toBe('4.000000');
    expect(precheck.receipts).toHaveLength(1);
  });

  it('A REPLAY WITH A FORGED RECEIPT IS STILL JUST A DUPLICATE', async () => {
    // The duplicate decision precedes settlement validation, so the
    // replacement linkage is never examined. Validating first would turn a
    // replay into a 400 - the changed-replay defect in a new disguise.
    const t = await tenant('op@example.test', 'Acme');
    policy(t, 'budgeted');
    const receiptId = await (async (): Promise<string> => {
      const decision = await runPrecheck(t, {
        action_id: 'act-1',
        agent_id: 'agent-a',
        category: 'spend',
        amount_usd: '4.000000',
      });
      return settle(t, decision['precheck_id'] as string);
    })();

    await ingest(t, [spendEvent('evt-1', receiptId)]);

    const replay = await ingest(t, [spendEvent('evt-1', FOREIGN_UUID)]);

    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ accepted: 0, duplicates: 1 });
    // The stored linkage is the ORIGINAL, unrewritten.
    expect(eventStore.events).toHaveLength(1);
    expect(eventStore.events[0]?.precheckReceiptId).toBe(receiptId);
    expect(committedSpend(t)).toBe('4.000000');
  });

  it.each([
    ['an inflated amount', { amount_usd: '41.000000' }],
    ['a different agent', { agent_id: 'agent-b' }],
    ['no linkage at all', { precheck_id: undefined }],
  ])('a replay with %s changes nothing', async (_label, overrides) => {
    const t = await tenant('op@example.test', 'Acme');
    policy(t, 'budgeted');
    const decision = await runPrecheck(t, {
      action_id: 'act-1',
      agent_id: 'agent-a',
      category: 'spend',
      amount_usd: '4.000000',
    });
    const receiptId = settle(t, decision['precheck_id'] as string);

    await ingest(t, [spendEvent('evt-1', receiptId)]);
    const before = { ...eventStore.events[0] };

    const replay = await ingest(t, [spendEvent('evt-1', receiptId, overrides)]);

    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ accepted: 0, duplicates: 1 });
    expect(eventStore.events).toHaveLength(1);
    expect(eventStore.events[0]).toEqual(before);
    expect(committedSpend(t)).toBe('4.000000');
  });
});

describe('an unprechecked spend is unchanged by this step', () => {
  it('is accepted and still does NOT debit the ledger', async () => {
    // CARRIED DEFICIENCY. `spend.recorded` without a precheck_id records an
    // audit row and moves no money. That is the NEXT Credit step, and Step 18
    // deliberately did not change it in either direction.
    const t = await tenant('op@example.test', 'Acme');
    policy(t, 'budgeted');

    const response = await ingest(t, [
      {
        type: 'spend.recorded',
        event_id: 'evt-1',
        agent_id: 'agent-a',
        amount_usd: '4.000000',
        provider: 'openai',
      },
    ]);

    expect(response.status).toBe(200);
    expect(eventStore.events).toHaveLength(1);
    expect(committedSpend(t)).toBe('0.000000');
  });
});
