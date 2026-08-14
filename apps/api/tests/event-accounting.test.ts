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
import { createAuthService } from '../src/auth/service';
import { createMemoryAgentStore } from './helpers/memory-agent-store';
import { createMemoryApiKeyStore, type MemoryApiKeyStore } from './helpers/memory-api-key-store';
import { createMemoryAuthStore, type MemoryAuthStore } from './helpers/memory-auth-store';
import { createMemoryEventStore, type MemoryEventStore } from './helpers/memory-event-store';
import { createMemoryLedger, type MemoryLedger } from './helpers/memory-ledger';
import {
  createMemoryPrecheckStore,
  type MemoryPrecheckStore,
} from './helpers/memory-precheck-store';
import {
  createMemoryWorkspaceStore,
  type MemoryWorkspaceStore,
} from './helpers/memory-workspace-store';

/**
 * STEP 19 - AUTHORITATIVE EVENT ACCOUNTING.
 *
 *   PRECHECKED action   -> the precheck committed the usage. The event is
 *                          audit evidence and debits NOTHING.
 *   UNPRECHECKED action -> the spend already happened and is being reported.
 *                          The event IS the accounting record, and it debits
 *                          exactly once.
 *
 * ─── WHY THIS FILE CAN NOW PROVE MORE THAN STEP 18's COULD ────────────────
 *
 * Step 18 reported an honest limitation: the precheck fake owned a ledger, the
 * event fake owned none, so "the linked event did not debit" was nearly true by
 * construction. Both fakes now share ONE `MemoryLedger` - as production shares
 * one `ledger_daily` - so a double debit genuinely fails a test here.
 *
 * ─── WHAT IT STILL CANNOT PROVE ───────────────────────────────────────────
 *
 * Single-threaded JavaScript. There is no row lock because nothing can
 * interleave, so the lost-update case Step 14 corrected is invisible here.
 * Concurrency and deadlock live in
 * `packages/db/tests/event-accounting.live.test.ts`, skipped without
 * `TEST_DATABASE_URL`.
 */

const APP_URL = 'https://app.example.test';
const START = new Date('2026-08-13T10:00:00.000Z');
const DAY = '2026-08-13';

let authStore: MemoryAuthStore;
let mailer: CapturingEmailSender;
let workspaces: MemoryWorkspaceStore;
let apiKeys: MemoryApiKeyStore;
let eventStore: MemoryEventStore;
let precheck: MemoryPrecheckStore;
let ledger: MemoryLedger;
let clock: ReturnType<typeof createFixedClock>;
let app: ReturnType<typeof createApp>;

function buildApp(at: Date): void {
  authStore = createMemoryAuthStore();
  mailer = createCapturingEmailSender();
  clock = createFixedClock(at);
  workspaces = createMemoryWorkspaceStore();
  apiKeys = createMemoryApiKeyStore();
  // ONE ledger, both paths - exactly as production has one `ledger_daily`.
  ledger = createMemoryLedger();
  eventStore = createMemoryEventStore(ledger);
  precheck = createMemoryPrecheckStore(ledger);
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
    agentStore: createMemoryAgentStore(),
    eventStore,
    precheckStore: precheck,
    clock,
  });
}

beforeEach(() => {
  buildApp(START);
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

async function ingest(t: Tenant, events: unknown[]): Promise<Response> {
  return app.request(EVENT_INGEST_PATH, {
    method: 'POST',
    headers: { authorization: `Bearer ${t.key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ events }),
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

/** Copies the recorded decision into the event store's receipt table. */
function settle(t: Tenant, precheckId: string): string {
  const recorded = precheck.receipts.find((r) => r.id === precheckId);
  if (recorded === undefined) throw new Error(`no receipt ${precheckId}`);
  return eventStore.seedReceipt(t.workspaceId, {
    agentExternalId: recorded.agentExternalId,
    category: recorded.category,
    decision: recorded.decision,
    requestedAmountUsd: recorded.requestedAmountUsd,
    requestedPublishCount: recorded.requestedPublishCount,
  });
}

/** Authoritative committed spend. Absent row reads as zero. */
function committed(t: Tenant, agent = 'agent-a', day = DAY): string {
  return ledger.usageOf(t.workspaceId, agent, day)?.spendCommittedUsd ?? '0.000000';
}

const spend = (
  eventId: string,
  amountUsd: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  type: 'spend.recorded',
  event_id: eventId,
  agent_id: 'agent-a',
  amount_usd: amountUsd,
  provider: 'openai',
  ...overrides,
});

// ───────────────────────────────────────────────────────────────────────────

describe('AN UNPRECHECKED SPEND DEBITS EXACTLY ONCE', () => {
  it('records $4 and moves the authoritative ledger to $4', async () => {
    const t = await tenant('op@example.test', 'Acme');
    expect(committed(t)).toBe('0.000000');

    const response = await ingest(t, [spend('evt-1', '4.000000')]);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accepted: 1, duplicates: 0 });
    expect(committed(t)).toBe('4.000000');
    expect(eventStore.events).toHaveLength(1);
    // Last-seen advances on an accepted event.
    expect(eventStore.agents[0]?.lastSeenAt).toEqual(START);
    // NO synthetic receipt and NO plane block - no decision was made.
    expect(eventStore.receipts).toHaveLength(0);
    expect(precheck.receipts).toHaveLength(0);
    expect(precheck.blocks).toHaveLength(0);
  });

  it('sums a sequence EXACTLY, with no float drift', async () => {
    // 10.10 + 10.20 + 4.70 is 24.999999999999996 in IEEE-754. The ledger must
    // read 25.000000 - this is the exact combination documented in Step 14.
    const t = await tenant('op@example.test', 'Acme');

    await ingest(t, [
      spend('evt-1', '10.100000'),
      spend('evt-2', '10.200000'),
      spend('evt-3', '4.700000'),
    ]);

    expect(committed(t)).toBe('25.000000');
  });

  it.each(['4', '4.0', '4.000000'])('accepts %s as the same exact amount', async (written) => {
    const t = await tenant('op@example.test', 'Acme');

    await ingest(t, [spend('evt-1', written)]);

    expect(committed(t)).toBe('4.000000');
  });

  it('accumulates a micro-dollar without loss', async () => {
    const t = await tenant('op@example.test', 'Acme');

    await ingest(t, [spend('evt-1', '0.000001'), spend('evt-2', '0.000002')]);

    expect(committed(t)).toBe('0.000003');
  });

  it('debits the reporting agent only', async () => {
    const t = await tenant('op@example.test', 'Acme');

    await ingest(t, [
      spend('evt-1', '4.000000'),
      spend('evt-2', '6.000000', { agent_id: 'agent-b' }),
    ]);

    expect(committed(t, 'agent-a')).toBe('4.000000');
    expect(committed(t, 'agent-b')).toBe('6.000000');
  });

  it('debits nothing for a non-spend event', async () => {
    const t = await tenant('op@example.test', 'Acme');

    await ingest(t, [
      { type: 'heartbeat', event_id: 'evt-1', agent_id: 'agent-a' },
      { type: 'agent.action', event_id: 'evt-2', agent_id: 'agent-a', category: 'spend' },
      {
        type: 'action.blocked',
        event_id: 'evt-3',
        agent_id: 'agent-a',
        category: 'spend',
        rule: 'vendor_guard',
        reason: 'Refused locally.',
        amount_usd: '9.000000',
      },
    ]);

    // Only `spend.recorded` is a report of money that moved. An
    // `agent.action` with category spend carries no amount, and a BLOCKED
    // spend is money that was NOT spent.
    expect(committed(t)).toBe('0.000000');
    expect(eventStore.events).toHaveLength(3);
  });
});

describe('A DUPLICATE NEVER REACHES ACCOUNTING', () => {
  it('replaying the same spend leaves the ledger at $4', async () => {
    const t = await tenant('op@example.test', 'Acme');

    const first = await ingest(t, [spend('evt-1', '4.000000')]);
    const seenAfterFirst = eventStore.agents[0]?.lastSeenAt;
    const second = await ingest(t, [spend('evt-1', '4.000000')]);

    expect(await first.json()).toEqual({ accepted: 1, duplicates: 0 });
    expect(await second.json()).toEqual({ accepted: 0, duplicates: 1 });
    expect(committed(t)).toBe('4.000000');
    expect(eventStore.events).toHaveLength(1);
    // A replay refreshes nothing.
    expect(eventStore.agents[0]?.lastSeenAt).toEqual(seenAfterFirst);
  });

  it('A CHANGED REPLAY DOES NOT RE-ACCOUNT', async () => {
    // Replacement content is not historical truth. $400 on a replay of an
    // accepted $4 is a duplicate, not a $400 debit and not a rejection.
    const t = await tenant('op@example.test', 'Acme');
    await ingest(t, [spend('evt-1', '4.000000')]);
    const stored = { ...eventStore.events[0] };

    const replay = await ingest(t, [spend('evt-1', '400.000000')]);

    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ accepted: 0, duplicates: 1 });
    expect(committed(t)).toBe('4.000000');
    expect(eventStore.events).toHaveLength(1);
    expect(eventStore.events[0]).toEqual(stored);
  });

  it('ten replays still leave $4', async () => {
    const t = await tenant('op@example.test', 'Acme');

    for (let i = 0; i < 10; i += 1) {
      await ingest(t, [spend('evt-1', '4.000000')]);
    }

    expect(committed(t)).toBe('4.000000');
    expect(eventStore.events).toHaveLength(1);
  });

  it('a MIXED batch debits only the new event', async () => {
    const t = await tenant('op@example.test', 'Acme');
    await ingest(t, [spend('evt-1', '4.000000')]);

    const response = await ingest(t, [spend('evt-1', '4.000000'), spend('evt-2', '6.000000')]);

    expect(await response.json()).toEqual({ accepted: 1, duplicates: 1 });
    // 4 + 6, not 4 + 4 + 6.
    expect(committed(t)).toBe('10.000000');
  });
});

describe('THE PRECHECKED PATH IS UNCHANGED', () => {
  it('$4 prechecked then reported is still $4, not $8', async () => {
    // THE STEP 18 REGRESSION, now genuinely observable: one shared ledger.
    const t = await tenant('op@example.test', 'Acme');
    policy(t, 'budgeted');

    const decision = await runPrecheck(t, {
      action_id: 'act-1',
      agent_id: 'agent-a',
      category: 'spend',
      amount_usd: '4.000000',
    });
    expect(decision['decision']).toBe('allow');
    expect(committed(t)).toBe('4.000000');

    const receiptId = settle(t, decision['precheck_id'] as string);
    await ingest(t, [spend('evt-1', '4.000000', { precheck_id: receiptId })]);

    expect(committed(t)).toBe('4.000000');
    expect(eventStore.events).toHaveLength(1);
  });

  it('WATCH: precheck committed nothing, and the linked event still commits nothing', async () => {
    // The classification is receipt PRESENCE, not receipt content. If the
    // debit keyed off "the ledger did not move", a watch-linked event would
    // retroactively commit on the precheck's behalf.
    const t = await tenant('op@example.test', 'Acme');
    policy(t, 'watch');

    const decision = await runPrecheck(t, {
      action_id: 'act-1',
      agent_id: 'agent-a',
      category: 'spend',
      amount_usd: '4.000000',
    });
    expect(decision['decision']).toBe('allow');
    expect(committed(t)).toBe('0.000000');

    const receiptId = settle(t, decision['precheck_id'] as string);
    const response = await ingest(t, [spend('evt-1', '4.000000', { precheck_id: receiptId })]);

    expect(response.status).toBe(200);
    expect(eventStore.events).toHaveLength(1);
    expect(committed(t)).toBe('0.000000');
  });

  it('a batch mixing linked and unlinked spend debits only the unlinked one', async () => {
    const t = await tenant('op@example.test', 'Acme');
    policy(t, 'budgeted');
    const decision = await runPrecheck(t, {
      action_id: 'act-1',
      agent_id: 'agent-a',
      category: 'spend',
      amount_usd: '4.000000',
    });
    const receiptId = settle(t, decision['precheck_id'] as string);
    expect(committed(t)).toBe('4.000000');

    await ingest(t, [
      spend('evt-1', '4.000000', { precheck_id: receiptId }),
      spend('evt-2', '6.000000'),
    ]);

    // 4 from the precheck + 6 from the unprechecked event. Not 14.
    expect(committed(t)).toBe('10.000000');
  });
});

describe('RECORDING IS NOT DECIDING', () => {
  it('records spend that EXCEEDS the configured cap', async () => {
    const t = await tenant('op@example.test', 'Acme');
    policy(t, 'budgeted', '25.000000', 5);

    // 24 already committed through a precheck.
    await runPrecheck(t, {
      action_id: 'act-1',
      agent_id: 'agent-a',
      category: 'spend',
      amount_usd: '24.000000',
    });
    expect(committed(t)).toBe('24.000000');

    // Then $17 of unprechecked spend is REPORTED. It already happened.
    const response = await ingest(t, [spend('evt-1', '17.000000')]);

    expect(response.status).toBe(200);
    // $41 against a $25 cap. The truth, not the cap.
    expect(committed(t)).toBe('41.000000');
    // No denial, no block, no receipt - nothing was decided.
    expect(precheck.blocks).toHaveLength(0);
    expect(precheck.receipts).toHaveLength(1);
    expect(precheck.receipts[0]?.decision).toBe('allow');
  });

  it('records spend for a PAUSED agent', async () => {
    // Paused stops future actions; it does not erase past ones. Suppressing
    // this would hide spend that actually happened.
    const t = await tenant('op@example.test', 'Acme');
    policy(t, 'paused', null, null);

    const response = await ingest(t, [spend('evt-1', '4.000000')]);

    expect(response.status).toBe(200);
    expect(committed(t)).toBe('4.000000');
    expect(precheck.blocks).toHaveLength(0);
  });

  it.each(['watch', 'budgeted', 'paused'] as const)(
    'records identically under %s',
    async (mode) => {
      const t = await tenant('op@example.test', 'Acme');
      policy(t, mode, '1.000000', 1);

      await ingest(t, [spend('evt-1', '9.000000')]);

      // Mode changes what a PRECHECK decides. It changes nothing about
      // recording what already occurred.
      expect(committed(t)).toBe('9.000000');
    },
  );

  it('records for an agent with NO policy at all', async () => {
    const t = await tenant('op@example.test', 'Acme');

    await ingest(t, [spend('evt-1', '4.000000')]);

    expect(committed(t)).toBe('4.000000');
  });
});

describe('BATCH ATOMICITY', () => {
  it('one batch of mixed events debits the sum', async () => {
    const t = await tenant('op@example.test', 'Acme');

    const response = await ingest(t, [
      spend('evt-1', '4.000000'),
      { type: 'heartbeat', event_id: 'evt-2', agent_id: 'agent-a' },
      spend('evt-3', '6.000000'),
    ]);

    expect(await response.json()).toEqual({ accepted: 3, duplicates: 0 });
    expect(committed(t)).toBe('10.000000');
  });

  it('A FAILURE AFTER AN EARLIER DEBIT ROLLS THE LEDGER BACK', async () => {
    const t = await tenant('op@example.test', 'Acme');
    await ingest(t, [spend('evt-0', '1.000000')]);
    expect(committed(t)).toBe('1.000000');

    // evt-3 fails at persistence, after evt-1 has already debited.
    eventStore.failOnEventId = 'evt-3';
    const response = await ingest(t, [spend('evt-1', '4.000000'), spend('evt-3', '6.000000')]);

    expect(response.status).toBe(500);
    // Back to the pre-batch value. No partial accounting, no partial events.
    expect(committed(t)).toBe('1.000000');
    expect(eventStore.events).toHaveLength(1);
  });

  it('an unresolved precheck_id rolls back a debit from earlier in the batch', async () => {
    const t = await tenant('op@example.test', 'Acme');

    const response = await ingest(t, [
      spend('evt-1', '4.000000'),
      spend('evt-2', '6.000000', { precheck_id: '11111111-1111-4111-8111-111111111111' }),
    ]);

    expect(response.status).toBe(400);
    expect(committed(t)).toBe('0.000000');
    expect(eventStore.events).toHaveLength(0);
  });

  it('several spends for ONE agent in one batch accumulate correctly', async () => {
    // Production reuses a single locked capability for the agent-day, whose
    // tracked state advances after each commit. A stale read would lose all
    // but the last.
    const t = await tenant('op@example.test', 'Acme');

    await ingest(t, [
      spend('evt-1', '1.250000'),
      spend('evt-2', '1.250000'),
      spend('evt-3', '1.250000'),
      spend('evt-4', '1.250000'),
    ]);

    expect(committed(t)).toBe('5.000000');
  });

  it('several agents in one batch land on their own rows', async () => {
    const t = await tenant('op@example.test', 'Acme');

    await ingest(t, [
      spend('evt-1', '1.000000', { agent_id: 'agent-c' }),
      spend('evt-2', '2.000000', { agent_id: 'agent-a' }),
      spend('evt-3', '3.000000', { agent_id: 'agent-b' }),
      spend('evt-4', '4.000000', { agent_id: 'agent-a' }),
    ]);

    expect(committed(t, 'agent-a')).toBe('6.000000');
    expect(committed(t, 'agent-b')).toBe('3.000000');
    expect(committed(t, 'agent-c')).toBe('1.000000');
  });
});

describe('THE ACCOUNTING DAY IS THE SERVER’S', () => {
  it('IGNORES occurred_at entirely', async () => {
    // A caller reporting yesterday's timestamp must not move spend into
    // yesterday's ledger, where today's cap no longer sees it.
    const t = await tenant('op@example.test', 'Acme');

    await ingest(t, [
      spend('evt-1', '4.000000', { occurred_at: '2026-08-01T00:00:00.000Z' }),
    ]);

    expect(committed(t, 'agent-a', '2026-08-13')).toBe('4.000000');
    expect(ledger.usageOf(t.workspaceId, 'agent-a', '2026-08-01')).toBeUndefined();
  });

  it('a FUTURE occurred_at does not move spend forward either', async () => {
    const t = await tenant('op@example.test', 'Acme');

    await ingest(t, [
      spend('evt-1', '4.000000', { occurred_at: '2027-01-01T00:00:00.000Z' }),
    ]);

    expect(committed(t, 'agent-a', '2026-08-13')).toBe('4.000000');
    expect(ledger.usageOf(t.workspaceId, 'agent-a', '2027-01-01')).toBeUndefined();
  });

  it('crosses UTC midnight on the SERVER instant', async () => {
    buildApp(new Date('2026-08-13T23:59:59.999Z'));
    const before = await tenant('op@example.test', 'Acme');
    await ingest(before, [spend('evt-1', '4.000000')]);
    expect(committed(before, 'agent-a', '2026-08-13')).toBe('4.000000');

    buildApp(new Date('2026-08-14T00:00:00.000Z'));
    const after = await tenant('op@example.test', 'Acme');
    await ingest(after, [spend('evt-1', '6.000000')]);

    expect(committed(after, 'agent-a', '2026-08-14')).toBe('6.000000');
    expect(ledger.usageOf(after.workspaceId, 'agent-a', '2026-08-13')).toBeUndefined();
  });

  it('one batch straddling midnight uses ONE day', async () => {
    // `received_at` and the accounting day derive from the same instant, so a
    // batch can never be audited on day N and accounted on day N+1.
    buildApp(new Date('2026-08-13T23:59:59.999Z'));
    const t = await tenant('op@example.test', 'Acme');

    await ingest(t, [spend('evt-1', '4.000000'), spend('evt-2', '6.000000')]);

    expect(committed(t, 'agent-a', '2026-08-13')).toBe('10.000000');
    expect(ledger.rows).toHaveLength(1);
  });
});

describe('CROSS-TENANT ISOLATION', () => {
  it('the same external agent id in two tenants keeps separate ledgers', async () => {
    const a = await tenant('alice@example.test', 'Alice Co');
    const b = await tenant('bob@example.test', 'Bob Co');

    await ingest(a, [spend('evt-1', '4.000000')]);
    await ingest(b, [spend('evt-1', '6.000000')]);

    // Same `event_id`, same `agent_id`, different workspaces: two events, two
    // ledger rows, no interference.
    expect(committed(a)).toBe('4.000000');
    expect(committed(b)).toBe('6.000000');
    expect(ledger.rows).toHaveLength(2);
  });

  it("one tenant's replay does not affect the other's accounting", async () => {
    const a = await tenant('alice@example.test', 'Alice Co');
    const b = await tenant('bob@example.test', 'Bob Co');

    await ingest(a, [spend('evt-1', '4.000000')]);
    await ingest(a, [spend('evt-1', '4.000000')]);
    await ingest(b, [spend('evt-1', '6.000000')]);

    expect(committed(a)).toBe('4.000000');
    expect(committed(b)).toBe('6.000000');
  });
});

describe('LEDGER CAPACITY IS NOT A POLICY CAP', () => {
  it('a policy cap never blocks recording, but numeric capacity does', async () => {
    // `numeric(14,6)` holds at most 99,999,999.999999 per agent per day. That
    // is a REPRESENTATIONAL limit, not a governance one: exceeding it cannot be
    // truncated, wrapped or clamped, because any of those would silently
    // record a total that is not what happened.
    const t = await tenant('op@example.test', 'Acme');

    await ingest(t, [spend('evt-1', '99999999.000000')]);
    expect(committed(t)).toBe('99999999.000000');

    // One more dollar overflows the column.
    const response = await ingest(t, [spend('evt-2', '1.000000')]);

    expect(response.status).toBe(500);
    // Atomic: the overflowing event is NOT stored, and the prior total stands.
    expect(committed(t)).toBe('99999999.000000');
    expect(eventStore.events).toHaveLength(1);
  });

  it('records right up to the capacity boundary', async () => {
    const t = await tenant('op@example.test', 'Acme');

    await ingest(t, [spend('evt-1', '99999999.999999')]);

    expect(committed(t)).toBe('99999999.999999');
  });
});
