import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  AUTH_CALLBACK_PATH,
  AUTH_MAGIC_LINK_PATH,
  EVENT_INGEST_PATH,
  workspaceApiKeysPath,
} from '@hybrid/contracts';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { createFixedClock } from '../src/auth/clock';
import { AUTH_COOKIE_NAME } from '../src/auth/cookie';
import { createCapturingEmailSender, type CapturingEmailSender } from '../src/auth/email';
import { createAuthService } from '../src/auth/service';
import { createMemoryAgentStore } from './helpers/memory-agent-store';
import { createMemoryApiKeyStore } from './helpers/memory-api-key-store';
import { createMemoryAuthStore, type MemoryAuthStore } from './helpers/memory-auth-store';
import { createMemoryEventStore, type MemoryEventStore } from './helpers/memory-event-store';
import { createMemoryWorkspaceStore, type MemoryWorkspaceStore } from './helpers/memory-workspace-store';

/**
 * DUPLICATE PAYLOAD IMMUTABILITY.
 *
 * THE INVARIANT
 * -------------
 *   The duplicate decision must be made BEFORE any event-specific one-time
 *   side effect.
 *
 * The identity is `(workspace_id, event_id)` and nothing else. Once an event
 * exists under that identity, a later submission reusing the id must be
 * reported as a duplicate and must not be allowed to reinterpret history -
 * whatever its content claims.
 *
 * These tests exist because the original Step 10 ordering resolved the agent,
 * the precheck receipt and the runtime block BEFORE the insert revealed the
 * event was a replay. Every one of those is a state change performed on behalf
 * of an event that was never accepted.
 *
 * The threat is not hypothetical: `event_id` is client-supplied, so anything
 * that can submit events can pick an id it knows is already stored and use the
 * replay path to create rows.
 */

const APP_URL = 'https://app.example.test';
const START = new Date('2026-08-12T10:00:00.000Z');
const UNKNOWN_RECEIPT = '11111111-1111-4111-8111-111111111111';

let authStore: MemoryAuthStore;
let mailer: CapturingEmailSender;
let clock: ReturnType<typeof createFixedClock>;
let workspaces: MemoryWorkspaceStore;
let apiKeys: ReturnType<typeof createMemoryApiKeyStore>;
let eventStore: MemoryEventStore;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  authStore = createMemoryAuthStore();
  mailer = createCapturingEmailSender();
  clock = createFixedClock(START);
  workspaces = createMemoryWorkspaceStore();
  apiKeys = createMemoryApiKeyStore();
  eventStore = createMemoryEventStore();
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
    clock,
  });
});

async function tenant(email = 'op@example.test'): Promise<{ workspaceId: string; key: string }> {
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
    body: JSON.stringify({ name: 'ingest' }),
  });
  const { apiKey } = (await issued.json()) as { apiKey: { key: string } };
  return { workspaceId, key: apiKey.key };
}

async function ingest(key: string, events: unknown[]): Promise<Response> {
  return app.request(EVENT_INGEST_PATH, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ events }),
  });
}

/** Snapshot of everything a duplicate must be incapable of changing. */
function snapshot(): string {
  return JSON.stringify({
    events: eventStore.events,
    agents: eventStore.agents,
    blocks: eventStore.blocks,
    receipts: eventStore.receipts,
  });
}

const ORIGINAL_BLOCKED = {
  event_id: 'evt-duplicate',
  agent_id: 'agent-a',
  type: 'action.blocked',
  block_id: 'block-original',
  category: 'publish',
  count: 1,
  rule: 'rule-original',
  reason: 'reason-original',
} as const;

describe('the reported case: a replay must not create an alternate block', () => {
  it('does not create block-should-never-exist', async () => {
    const t = await tenant();
    const first = await ingest(t.key, [ORIGINAL_BLOCKED]);
    expect(await first.json()).toEqual({ accepted: 1, duplicates: 0 });

    const before = snapshot();
    clock.advance(60_000);

    const replay = await ingest(t.key, [
      {
        event_id: 'evt-duplicate',
        agent_id: 'agent-a',
        type: 'action.blocked',
        block_id: 'block-should-never-exist',
        category: 'publish',
        count: 1,
        rule: 'different-rule',
        reason: 'different-reason',
      },
    ]);

    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ accepted: 0, duplicates: 1 });

    // THE ASSERTION THE ORIGINAL ORDERING FAILED.
    expect(eventStore.blocks.map((b) => b.externalBlockId)).toEqual(['block-original']);
    expect(eventStore.blocks).toHaveLength(1);

    // And nothing else moved either.
    expect(snapshot()).toBe(before);
  });

  it('leaves the original block rule and reason intact', async () => {
    const t = await tenant();
    await ingest(t.key, [ORIGINAL_BLOCKED]);

    await ingest(t.key, [
      { ...ORIGINAL_BLOCKED, rule: 'different-rule', reason: 'different-reason' },
    ]);

    expect(eventStore.blocks[0]?.rule).toBe('rule-original');
    expect(eventStore.blocks[0]?.reason).toBe('reason-original');
  });
});

describe('the precheck variant', () => {
  it('reports a duplicate rather than 400 when a replay carries an unknown precheck_id', async () => {
    const t = await tenant();
    await ingest(t.key, [{ event_id: 'evt-p1', agent_id: 'agent-a', type: 'heartbeat' }]);
    const before = snapshot();

    const replay = await ingest(t.key, [
      {
        event_id: 'evt-p1',
        agent_id: 'agent-a',
        type: 'heartbeat',
        precheck_id: UNKNOWN_RECEIPT,
      },
    ]);

    // A known event id is settled before any linkage is even considered, so a
    // bogus reference on a replay cannot fail a batch that changes nothing.
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ accepted: 0, duplicates: 1 });
    expect(snapshot()).toBe(before);
  });

  it('creates no receipt and rewrites no linkage', async () => {
    const t = await tenant();
    const receiptId = eventStore.seedReceipt(t.workspaceId);
    const settled = {
      event_id: 'evt-p2',
      agent_id: 'agent-a',
      type: 'spend.recorded',
      amount_usd: '4.000000',
      provider: 'openai',
      precheck_id: receiptId,
    } as const;

    await ingest(t.key, [settled]);
    await ingest(t.key, [{ ...settled, precheck_id: UNKNOWN_RECEIPT }]);

    expect(eventStore.receipts).toHaveLength(1);
    expect(eventStore.events[0]?.precheckReceiptId).toBe(receiptId);
  });

  it('a NEW event with an unknown precheck_id is still a 400', async () => {
    // The correction must not turn unresolved references into silent successes.
    const t = await tenant();

    const response = await ingest(t.key, [
      { event_id: 'evt-new', agent_id: 'agent-a', type: 'heartbeat', precheck_id: UNKNOWN_RECEIPT },
    ]);

    expect(response.status).toBe(400);
    expect(eventStore.events).toHaveLength(0);
  });
});

describe('agent discovery is a side effect too', () => {
  it('does not create agent-fake-new on replay', async () => {
    const t = await tenant();
    await ingest(t.key, [{ event_id: 'evt-x', agent_id: 'agent-original', type: 'heartbeat' }]);
    const originalAgentId = eventStore.agents[0]?.id;

    const replay = await ingest(t.key, [
      { event_id: 'evt-x', agent_id: 'agent-fake-new', type: 'heartbeat' },
    ]);

    expect(await replay.json()).toEqual({ accepted: 0, duplicates: 1 });
    // A reused event id must not be a way to enrol agents.
    expect(eventStore.agents.map((a) => a.externalId)).toEqual(['agent-original']);
    expect(eventStore.events[0]?.agentId).toBe(originalAgentId);
  });

  it('does not touch the original agent either', async () => {
    const t = await tenant();
    await ingest(t.key, [{ event_id: 'evt-x', agent_id: 'agent-original', type: 'heartbeat' }]);

    clock.advance(600_000);
    await ingest(t.key, [{ event_id: 'evt-x', agent_id: 'agent-fake-new', type: 'heartbeat' }]);

    expect(eventStore.agents).toHaveLength(1);
    expect(eventStore.agents[0]?.lastSeenAt).toEqual(START);
  });
});

describe('duplicate payload immutability matrix', () => {
  const BASE = {
    event_id: 'evt-matrix',
    agent_id: 'agent-a',
    type: 'agent.action',
    category: 'llm_call',
    payload: { original: true },
    occurred_at: '2026-08-12T09:00:00.000Z',
  } as const;

  const MUTATIONS: [string, Record<string, unknown>][] = [
    ['agent_id', { agent_id: 'agent-other' }],
    ['category', { category: 'publish' }],
    ['payload', { payload: { tampered: true } }],
    ['occurred_at', { occurred_at: '2099-01-01T00:00:00.000Z' }],
    ['precheck_id', { precheck_id: UNKNOWN_RECEIPT }],
    [
      'type (to action.blocked, adding rule/reason/block_id)',
      {
        type: 'action.blocked',
        category: 'publish',
        rule: 'injected-rule',
        reason: 'injected-reason',
        count: 99,
        block_id: 'block-injected',
      },
    ],
    [
      'type (to spend.recorded, adding amount metadata)',
      { type: 'spend.recorded', category: undefined, amount_usd: '999.000000', provider: 'openai' },
    ],
  ];

  it.each(MUTATIONS)('a replay with a changed %s changes nothing', async (_label, mutation) => {
    const t = await tenant();
    await ingest(t.key, [BASE]);
    const before = snapshot();

    const replaced: Record<string, unknown> = { ...BASE, ...mutation };
    for (const [key, value] of Object.entries(replaced)) {
      if (value === undefined) delete replaced[key];
    }

    const replay = await ingest(t.key, [replaced]);

    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ accepted: 0, duplicates: 1 });
    expect(snapshot()).toBe(before);
  });

  it('still rejects a structurally invalid replay with 400', async () => {
    // Step 9 validation is unchanged: matching a stored event_id is not a way
    // past the contract.
    const t = await tenant();
    await ingest(t.key, [BASE]);

    const response = await ingest(t.key, [{ ...BASE, amount_usd: '1.000000' }]);

    expect(response.status).toBe(400);
    expect(eventStore.events).toHaveLength(1);
  });
});

describe('the ordering is pinned in the source', () => {
  // Behavioural tests prove the current code is right. This proves the next
  // edit cannot quietly reintroduce the defect by moving one line.
  const source = readFileSync(
    path.resolve(import.meta.dirname, '..', 'src', 'events', 'store.ts'),
    'utf8',
  );
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  const positionOf = (needle: string): number => {
    const at = code.indexOf(needle);
    if (at < 0) expect.unreachable(`store.ts no longer contains ${needle}`);
    return at;
  };

  it('locks every identity before the loop begins', () => {
    expect(positionOf('lockRepo.lockEvents(')).toBeLessThan(positionOf('for (const [index, event]'));
  });

  it.each([
    ['agent discovery', 'agentRepo.discover('],
    ['receipt lookup', 'receiptRepo.findById('],
    // Step 18 settlement validation is side-effect-free, but it can REJECT.
    // Running it before the duplicate decision would make a replay carrying a
    // fake precheck_id fail the batch instead of reporting a duplicate, which
    // is the changed-replay defect in a new disguise.
    ['settlement validation', 'checkPrecheckLinkage('],
    ['block creation', 'blockRepo.resolveOrCreateRuntimeBlock('],
    ['the insert', 'eventRepo.insertIfNew('],
    ['last-seen advancement', 'agentRepo.touchLastSeen('],
  ])('the duplicate check precedes %s', (_label, needle) => {
    expect(positionOf('eventRepo.findByEventId(')).toBeLessThan(positionOf(needle));
  });

  it('resolves the agent before validating linkage against it', () => {
    // The receipt stores an internal agent UUID; the wire carries an external
    // id. Comparing them requires the resolution to have happened first.
    expect(positionOf('agentRepo.discover(')).toBeLessThan(positionOf('checkPrecheckLinkage('));
  });

  it('retains ON CONFLICT as database defense in depth', () => {
    // The advisory lock coordinates; the constraint guarantees. Replacing the
    // constraint with the lock would make correctness depend on every caller
    // remembering to take it.
    const repository = readFileSync(
      path.resolve(import.meta.dirname, '..', '..', '..', 'packages', 'db', 'src', 'repositories', 'events.ts'),
      'utf8',
    );

    expect(repository).toContain('onConflictDoNothing');
    expect(repository).toContain('target: [events.workspaceId, events.eventId]');
  });
});

describe('a genuinely new event still gets its side effects', () => {
  it('reuses an existing block for a different event id', async () => {
    // Distinct from a replay: two different events may legitimately reference
    // the same external block.
    const t = await tenant();
    await ingest(t.key, [ORIGINAL_BLOCKED]);

    const second = await ingest(t.key, [{ ...ORIGINAL_BLOCKED, event_id: 'evt-second' }]);

    expect(await second.json()).toEqual({ accepted: 1, duplicates: 0 });
    expect(eventStore.blocks).toHaveLength(1);
    expect(eventStore.events).toHaveLength(2);
    expect(eventStore.events[1]?.blockId).toBe(eventStore.blocks[0]?.id);
  });

  it('discovers a new agent and advances last-seen for a new event', async () => {
    const t = await tenant();
    await ingest(t.key, [{ event_id: 'evt-1', agent_id: 'agent-a', type: 'heartbeat' }]);

    clock.advance(30_000);
    await ingest(t.key, [{ event_id: 'evt-2', agent_id: 'agent-b', type: 'heartbeat' }]);

    expect(eventStore.agents.map((a) => a.externalId).sort()).toEqual(['agent-a', 'agent-b']);
    expect(eventStore.agents[1]?.lastSeenAt).toEqual(new Date(START.getTime() + 30_000));
    // The untouched agent kept its original timestamp.
    expect(eventStore.agents[0]?.lastSeenAt).toEqual(START);
  });

  it('handles a mixed batch: new gets effects, duplicate gets none', async () => {
    const t = await tenant();
    await ingest(t.key, [ORIGINAL_BLOCKED]);
    const originalBlockId = eventStore.blocks[0]?.id;

    const mixed = await ingest(t.key, [
      // Duplicate id carrying a hostile alternate block.
      { ...ORIGINAL_BLOCKED, block_id: 'block-should-never-exist' },
      // Genuinely new, with its own legitimate new block.
      { ...ORIGINAL_BLOCKED, event_id: 'evt-new', block_id: 'block-legitimate' },
    ]);

    expect(await mixed.json()).toEqual({ accepted: 1, duplicates: 1 });
    expect(eventStore.blocks.map((b) => b.externalBlockId).sort()).toEqual([
      'block-legitimate',
      'block-original',
    ]);
    expect(eventStore.events[0]?.blockId).toBe(originalBlockId);
  });
});
