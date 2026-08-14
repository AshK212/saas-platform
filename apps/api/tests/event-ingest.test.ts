import {
  AGENT_REGISTER_PATH,
  AUTH_CALLBACK_PATH,
  AUTH_MAGIC_LINK_PATH,
  EVENT_INGEST_PATH,
  eventIngestResponseSchema,
  workspaceApiKeysPath,
} from '@hybrid/contracts';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { createFixedClock } from '../src/auth/clock';
import { AUTH_COOKIE_NAME } from '../src/auth/cookie';
import { createCapturingEmailSender, type CapturingEmailSender } from '../src/auth/email';
import { createAuthService, type AuthService } from '../src/auth/service';
import { MAX_EVENT_BODY_BYTES } from '../src/routes/events';
import { createMemoryAgentStore, type MemoryAgentStore } from './helpers/memory-agent-store';
import { createMemoryApiKeyStore, type MemoryApiKeyStore } from './helpers/memory-api-key-store';
import { createMemoryAuthStore, type MemoryAuthStore } from './helpers/memory-auth-store';
import { createMemoryEventReadStore } from './helpers/memory-event-read-store';
import { createMemoryEventStore, type MemoryEventStore } from './helpers/memory-event-store';
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
let eventStore: MemoryEventStore;
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
  eventStore = createMemoryEventStore();
  app = createApp({
    probeDatabase: () => Promise.resolve('ok'),
    authService: service,
    appUrl: APP_URL,
    secureCookies: true,
    workspaceStore: workspaces,
    apiKeyStore: apiKeys,
    agentStore: agents,
    eventStore,
    // Wired so the "a key cannot read the timeline" assertion exercises the
    // real authentication path rather than passing on an unconfigured 503.
    eventReadStore: createMemoryEventReadStore(),
    clock,
  });
});

async function tenant(
  email: string,
  name: string,
): Promise<{ workspaceId: string; key: string; cookie: string }> {
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
  return { workspaceId, key: apiKey.key, cookie };
}

async function ingest(key: string, body: unknown): Promise<Response> {
  return app.request(EVENT_INGEST_PATH, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const hb = (eventId: string, agentId = 'agent-a'): unknown => ({
  type: 'heartbeat',
  event_id: eventId,
  agent_id: agentId,
});

describe('authentication and domain separation', () => {
  it('rejects a request with no credential', async () => {
    const response = await app.request(EVENT_INGEST_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events: [hb('e1')] }),
    });

    expect(response.status).toBe(401);
    expect(eventStore.events).toHaveLength(0);
  });

  it('rejects a browser session cookie', async () => {
    const t = await tenant('op@example.test', 'Acme');

    const response = await app.request(EVENT_INGEST_PATH, {
      method: 'POST',
      headers: { cookie: t.cookie, origin: APP_URL, 'content-type': 'application/json' },
      body: JSON.stringify({ events: [hb('e1')] }),
    });

    // Operator auth never substitutes for machine auth.
    expect(response.status).toBe(401);
    expect(eventStore.events).toHaveLength(0);
  });

  it('rejects a revoked key', async () => {
    const t = await tenant('op@example.test', 'Acme');
    const credentialId = apiKeys.credentials[0]?.id ?? '';
    await app.request(`${workspaceApiKeysPath(t.workspaceId)}/${credentialId}/revoke`, {
      method: 'POST',
      headers: { cookie: t.cookie, origin: APP_URL },
    });

    expect((await ingest(t.key, { events: [hb('e1')] })).status).toBe(401);
    expect(eventStore.events).toHaveLength(0);
  });

  it('never accepts a key from the query string', async () => {
    const t = await tenant('op@example.test', 'Acme');

    const response = await app.request(`${EVENT_INGEST_PATH}?api_key=${t.key}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events: [hb('e1')] }),
    });

    expect(response.status).toBe(401);
  });
});

describe('AC-13 replay idempotency', () => {
  it('accepts a new batch then reports the exact replay as all duplicates', async () => {
    const t = await tenant('op@example.test', 'Acme');
    const batch = { events: [hb('e1'), hb('e2'), hb('e3')] };

    const first = await ingest(t.key, batch);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ accepted: 3, duplicates: 0 });
    expect(eventStore.events).toHaveLength(3);

    const replay = await ingest(t.key, batch);

    // The core AC-13 proof: 200, nothing new, count unchanged.
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ accepted: 0, duplicates: 3 });
    expect(eventStore.events).toHaveLength(3);
  });

  it('leaves the original stored row byte-identical after replay', async () => {
    const t = await tenant('op@example.test', 'Acme');
    const original = {
      type: 'agent.action',
      event_id: 'e1',
      agent_id: 'agent-a',
      category: 'llm_call',
      payload: { model: 'first' },
    };
    await ingest(t.key, { events: [original] });
    const before = structuredClone(eventStore.events[0]);

    clock.advance(60_000);
    // A replay carrying DIFFERENT content under the same event_id must not
    // rewrite history.
    await ingest(t.key, {
      events: [{ ...original, category: 'publish', payload: { model: 'tampered' } }],
    });

    expect(eventStore.events).toHaveLength(1);
    expect(eventStore.events[0]).toEqual(before);
  });

  it('MIXED: E1 new, E2 duplicate, E3 new', async () => {
    const t = await tenant('op@example.test', 'Acme');
    await ingest(t.key, { events: [hb('e2')] });

    const response = await ingest(t.key, { events: [hb('e1'), hb('e2'), hb('e3')] });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accepted: 2, duplicates: 1 });
    expect(eventStore.events.map((e) => e.eventId).sort()).toEqual(['e1', 'e2', 'e3']);
  });

  it('validates the response against the shared contract', async () => {
    const t = await tenant('op@example.test', 'Acme');

    const body: unknown = await (await ingest(t.key, { events: [hb('e1')] })).json();

    expect(eventIngestResponseSchema.safeParse(body).success).toBe(true);
  });

  it('accepted + duplicates always equals the submitted count', async () => {
    const t = await tenant('op@example.test', 'Acme');
    await ingest(t.key, { events: [hb('e1')] });

    const body = (await (
      await ingest(t.key, { events: [hb('e1'), hb('e2'), hb('e3')] })
    ).json()) as { accepted: number; duplicates: number };

    // No silent drops.
    expect(body.accepted + body.duplicates).toBe(3);
  });

  it('the same event_id in another workspace is a separate event', async () => {
    const a = await tenant('alice@example.test', 'Alice Co');
    const b = await tenant('bob@example.test', 'Bob Co');

    await ingest(a.key, { events: [hb('shared-id')] });
    const response = await ingest(b.key, { events: [hb('shared-id')] });

    expect(await response.json()).toEqual({ accepted: 1, duplicates: 0 });
    expect(eventStore.events).toHaveLength(2);
  });
});

describe('agent discovery and last-seen', () => {
  it('discovers an agent that never called /agents/register', async () => {
    const t = await tenant('op@example.test', 'Acme');

    await ingest(t.key, { events: [hb('e1', 'agent-new')] });

    expect(eventStore.agents.map((a) => a.externalId)).toEqual(['agent-new']);
    expect(eventStore.agents[0]?.lastSeenAt).toEqual(START);
    expect(eventStore.agents[0]?.workspaceId).toBe(t.workspaceId);
  });

  it('DUPLICATE REPLAY DOES NOT REFRESH last-seen', async () => {
    const t = await tenant('op@example.test', 'Acme');
    await ingest(t.key, { events: [hb('e1')] });

    clock.advance(600_000);
    await ingest(t.key, { events: [hb('e1')] });

    // A retry storm must not make a stale agent look alive.
    expect(eventStore.agents[0]?.lastSeenAt).toEqual(START);
  });

  it('a genuinely new event advances last-seen', async () => {
    const t = await tenant('op@example.test', 'Acme');
    await ingest(t.key, { events: [hb('e1')] });

    clock.advance(30_000);
    await ingest(t.key, { events: [hb('e2')] });

    expect(eventStore.agents).toHaveLength(1);
    expect(eventStore.agents[0]?.lastSeenAt).toEqual(new Date(START.getTime() + 30_000));
    expect(eventStore.events).toHaveLength(2);
  });

  it('creates no second agent on replay', async () => {
    const t = await tenant('op@example.test', 'Acme');
    await ingest(t.key, { events: [hb('e1', 'agent-x')] });
    await ingest(t.key, { events: [hb('e1', 'agent-x')] });

    expect(eventStore.agents).toHaveLength(1);
  });

  it('invents no display name for a discovered agent', async () => {
    const t = await tenant('op@example.test', 'Acme');

    await ingest(t.key, { events: [hb('e1', 'agent-new')] });

    expect(eventStore.agents[0]).not.toHaveProperty('displayName', 'agent-new');
  });
});

describe('server-authoritative timestamps', () => {
  it('sets received_at from the server clock', async () => {
    const t = await tenant('op@example.test', 'Acme');

    await ingest(t.key, { events: [hb('e1')] });

    expect(eventStore.events[0]?.receivedAt).toEqual(START);
  });

  it('stores occurred_at as untrusted metadata without affecting received_at', async () => {
    const t = await tenant('op@example.test', 'Acme');
    const clientClaim = '2099-01-01T00:00:00.000Z';

    await ingest(t.key, {
      events: [{ type: 'heartbeat', event_id: 'e1', agent_id: 'agent-a', occurred_at: clientClaim }],
    });

    expect(eventStore.events[0]?.occurredAt).toEqual(new Date(clientClaim));
    expect(eventStore.events[0]?.receivedAt).toEqual(START);
  });
});

describe('raw audit payload', () => {
  it('stores the entire validated event, nested payload included', async () => {
    const t = await tenant('op@example.test', 'Acme');
    const event = {
      type: 'spend.recorded',
      event_id: 'evt-1',
      agent_id: 'agent-a',
      amount_usd: '1.250000',
      provider: 'openai',
      payload: { model: 'gpt-x', nested: { attempt: 2 } },
    };

    await ingest(t.key, { events: [event] });

    // AC-06 drill-through source.
    expect(eventStore.events[0]?.payload).toEqual(event);
  });

  it('stores no credential or header material in the payload', async () => {
    const t = await tenant('op@example.test', 'Acme');

    await ingest(t.key, { events: [hb('e1')] });

    const raw = JSON.stringify(eventStore.events[0]?.payload);
    expect(raw).not.toContain(t.key);
    expect(raw).not.toContain('Bearer');
    expect(raw).not.toContain('authorization');
  });

  it('maps type and category, leaving category null where none applies', async () => {
    const t = await tenant('op@example.test', 'Acme');

    await ingest(t.key, {
      events: [
        hb('e1'),
        { type: 'agent.action', event_id: 'e2', agent_id: 'agent-a', category: 'tool_call' },
        {
          type: 'spend.recorded',
          event_id: 'e3',
          agent_id: 'agent-a',
          amount_usd: '1.000000',
          provider: 'openai',
        },
      ],
    });

    const byId = new Map(eventStore.events.map((e) => [e.eventId, e]));
    expect(byId.get('e1')?.category).toBeNull();
    expect(byId.get('e2')?.category).toBe('tool_call');
    // No category is invented just to fill the column.
    expect(byId.get('e3')?.category).toBeNull();
  });
});

describe('runtime action.blocked', () => {
  const blocked = (eventId: string, blockId?: string): unknown => ({
    type: 'action.blocked',
    event_id: eventId,
    agent_id: 'agent-a',
    category: 'publish',
    rule: 'daily_publish_cap',
    reason: 'Daily publish cap reached',
    count: 6,
    ...(blockId === undefined ? {} : { block_id: blockId }),
  });

  it('creates a runtime block and links the event to its internal UUID', async () => {
    const t = await tenant('op@example.test', 'Acme');

    await ingest(t.key, { events: [blocked('e1', 'client-block-123')] });

    expect(eventStore.blocks).toHaveLength(1);
    expect(eventStore.blocks[0]?.externalBlockId).toBe('client-block-123');
    expect(eventStore.blocks[0]?.source).toBe('runtime');
    // events.block_id holds the INTERNAL uuid, not the client string.
    expect(eventStore.events[0]?.blockId).toBe(eventStore.blocks[0]?.id);
    expect(eventStore.events[0]?.blockId).not.toBe('client-block-123');
  });

  it('REPLAY of a blocked event creates no second block', async () => {
    const t = await tenant('op@example.test', 'Acme');
    await ingest(t.key, { events: [blocked('e1', 'client-block-123')] });

    const replay = await ingest(t.key, { events: [blocked('e1', 'client-block-123')] });

    expect(await replay.json()).toEqual({ accepted: 0, duplicates: 1 });
    expect(eventStore.blocks).toHaveLength(1);
    expect(eventStore.events).toHaveLength(1);
  });

  it('two different events referencing one external block id share the block', async () => {
    const t = await tenant('op@example.test', 'Acme');

    await ingest(t.key, {
      events: [blocked('e1', 'client-block-123'), blocked('e2', 'client-block-123')],
    });

    expect(eventStore.events).toHaveLength(2);
    expect(eventStore.blocks).toHaveLength(1);
    expect(eventStore.events[0]?.blockId).toBe(eventStore.events[1]?.blockId);
  });

  it('the same external block id in another workspace is independent', async () => {
    const a = await tenant('alice@example.test', 'Alice Co');
    const b = await tenant('bob@example.test', 'Bob Co');

    await ingest(a.key, { events: [blocked('e1', 'client-block-123')] });
    await ingest(b.key, { events: [blocked('e1', 'client-block-123')] });

    expect(eventStore.blocks).toHaveLength(2);
    expect(eventStore.blocks[0]?.id).not.toBe(eventStore.blocks[1]?.id);
  });

  it('does not rewrite an existing block when re-reported', async () => {
    const t = await tenant('op@example.test', 'Acme');
    await ingest(t.key, { events: [blocked('e1', 'blk-1')] });

    await ingest(t.key, {
      events: [
        {
          type: 'action.blocked',
          event_id: 'e2',
          agent_id: 'agent-a',
          category: 'publish',
          rule: 'tampered_rule',
          reason: 'tampered reason',
          count: 99,
          block_id: 'blk-1',
        },
      ],
    });

    // The first report is the audit record.
    expect(eventStore.blocks).toHaveLength(1);
    expect(eventStore.blocks[0]?.rule).toBe('daily_publish_cap');
    expect(eventStore.blocks[0]?.count).toBe(6);
  });

  it('ingests an anonymous blocked event with no block linkage', async () => {
    const t = await tenant('op@example.test', 'Acme');

    const response = await ingest(t.key, { events: [blocked('e1')] });

    // Without a stable external id there is nothing to deduplicate on, so no
    // block row is created; the event still persists with its rule and reason
    // in the raw payload.
    expect(response.status).toBe(200);
    expect(eventStore.blocks).toHaveLength(0);
    expect(eventStore.events[0]?.blockId).toBeNull();
  });
});

describe('precheck linkage', () => {
  it('links an event to a receipt in the same workspace', async () => {
    const t = await tenant('op@example.test', 'Acme');
    const receiptId = eventStore.seedReceipt(t.workspaceId);

    const response = await ingest(t.key, {
      events: [
        {
          type: 'spend.recorded',
          event_id: 'e1',
          agent_id: 'agent-a',
          amount_usd: '4.000000',
          provider: 'openai',
          precheck_id: receiptId,
        },
      ],
    });

    expect(response.status).toBe(200);
    expect(eventStore.events[0]?.precheckReceiptId).toBe(receiptId);
  });

  it('REJECTS an unknown precheck_id rather than dropping the linkage', async () => {
    const t = await tenant('op@example.test', 'Acme');

    const response = await ingest(t.key, {
      events: [
        {
          type: 'heartbeat',
          event_id: 'e1',
          agent_id: 'agent-a',
          precheck_id: '11111111-1111-4111-8111-111111111111',
        },
      ],
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; issues: { path: string }[] };
    expect(body.error).toBe('invalid_batch');
    expect(body.issues[0]?.path).toBe('events.0.precheck_id');
    // Nothing stored - no silent drop.
    expect(eventStore.events).toHaveLength(0);
  });

  it("a receipt in another workspace behaves exactly like an unknown one", async () => {
    const a = await tenant('alice@example.test', 'Alice Co');
    const b = await tenant('bob@example.test', 'Bob Co');
    const bobsReceipt = eventStore.seedReceipt(b.workspaceId);

    const foreign = await ingest(a.key, {
      events: [
        { type: 'heartbeat', event_id: 'e1', agent_id: 'agent-a', precheck_id: bobsReceipt },
      ],
    });
    const unknown = await ingest(a.key, {
      events: [
        {
          type: 'heartbeat',
          event_id: 'e1',
          agent_id: 'agent-a',
          precheck_id: '11111111-1111-4111-8111-111111111111',
        },
      ],
    });

    expect(foreign.status).toBe(unknown.status);
    expect(await foreign.text()).toBe(await unknown.text());
    expect(eventStore.events).toHaveLength(0);
  });

  it('rolls back the whole batch when one linkage is unresolved', async () => {
    const t = await tenant('op@example.test', 'Acme');

    await ingest(t.key, {
      events: [
        hb('e1'),
        {
          type: 'heartbeat',
          event_id: 'e2',
          agent_id: 'agent-a',
          precheck_id: '11111111-1111-4111-8111-111111111111',
        },
      ],
    });

    // e1 must not survive a batch that failed.
    expect(eventStore.events).toHaveLength(0);
  });
});

describe('batch failure semantics', () => {
  it('rolls back and reports no accepted events on a persistence failure', async () => {
    const t = await tenant('op@example.test', 'Acme');
    eventStore.failOnEventId = 'e3';

    const response = await ingest(t.key, { events: [hb('e1'), hb('e2'), hb('e3')] });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'internal_error' });
    // Counts must describe committed state; nothing committed.
    expect(eventStore.events).toHaveLength(0);
  });

  it('does not leak internal error detail', async () => {
    const t = await tenant('op@example.test', 'Acme');
    eventStore.failOnEventId = 'e1';

    const raw = await (await ingest(t.key, { events: [hb('e1')] })).text();

    expect(raw).not.toContain('persistence failure');
    expect(raw).not.toMatch(/insert|events|postgres/i);
  });
});

describe('route-level contract enforcement', () => {
  it.each([
    ['empty batch', { events: [] }],
    ['missing events array', {}],
    ['unknown top-level field', { events: [hb('e1')], extra: 1 }],
    ['workspace field in body', { events: [hb('e1')], workspace_id: 'x' }],
    ['workspace field inside an event', { events: [{ ...(hb('e1') as object), workspace_id: 'x' }] }],
    ['unknown event type', { events: [{ type: 'agent.thought', event_id: 'e1', agent_id: 'a' }] }],
    [
      'malformed decimal',
      {
        events: [
          {
            type: 'spend.recorded',
            event_id: 'e1',
            agent_id: 'a',
            amount_usd: '0.0000009',
            provider: 'openai',
          },
        ],
      },
    ],
    ['duplicate event_id in one batch', { events: [hb('same'), hb('same')] }],
  ])('returns 400 for %s', async (_label, body) => {
    const t = await tenant('op@example.test', 'Acme');

    const response = await ingest(t.key, body);

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe('invalid_batch');
    expect(eventStore.events).toHaveLength(0);
  });

  it('returns 400 for a batch over 100 events', async () => {
    const t = await tenant('op@example.test', 'Acme');
    const events = Array.from({ length: 101 }, (_v, i) => hb(`e${String(i)}`));

    expect((await ingest(t.key, { events })).status).toBe(400);
    expect(eventStore.events).toHaveLength(0);
  });

  it('accepts exactly 100 events', async () => {
    const t = await tenant('op@example.test', 'Acme');
    const events = Array.from({ length: 100 }, (_v, i) => hb(`e${String(i)}`));

    const response = await ingest(t.key, { events });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accepted: 100, duplicates: 0 });
  });

  it('returns a safe 400 for malformed JSON', async () => {
    const t = await tenant('op@example.test', 'Acme');

    const response = await app.request(EVENT_INGEST_PATH, {
      method: 'POST',
      headers: { authorization: `Bearer ${t.key}`, 'content-type': 'application/json' },
      body: '{not json',
    });

    expect(response.status).toBe(400);
    const raw = await response.text();
    expect(raw).not.toContain('JSON.parse');
    expect(raw).not.toContain('SyntaxError');
  });

  it('never returns raw Zod internals', async () => {
    const t = await tenant('op@example.test', 'Acme');

    const raw = await (await ingest(t.key, { events: [] })).text();

    expect(raw).not.toContain('invalid_type');
    expect(raw).not.toContain('too_small');
    expect(raw).not.toContain('ZodError');
  });
});

describe('body size protection', () => {
  it('documents a 1 MiB limit', () => {
    expect(MAX_EVENT_BODY_BYTES).toBe(1_048_576);
  });

  it('accepts a large but in-limit body', async () => {
    const t = await tenant('op@example.test', 'Acme');
    // ~500 KB of legitimate runtime metadata.
    const events = Array.from({ length: 50 }, (_v, i) => ({
      type: 'heartbeat',
      event_id: `e${String(i)}`,
      agent_id: 'agent-a',
      payload: { blob: 'x'.repeat(10_000) },
    }));

    const response = await ingest(t.key, { events });

    expect(response.status).toBe(200);
  });

  it('rejects an oversized body with 413 and stores nothing', async () => {
    const t = await tenant('op@example.test', 'Acme');
    const events = [
      { type: 'heartbeat', event_id: 'big', agent_id: 'agent-a', payload: { blob: 'x'.repeat(1_200_000) } },
    ];

    const response = await ingest(t.key, { events });

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: 'payload_too_large' });
    // The store was never reached.
    expect(eventStore.events).toHaveLength(0);
    expect(eventStore.agents).toHaveLength(0);
  });

  it('does not echo body content in the 413 response', async () => {
    const t = await tenant('op@example.test', 'Acme');
    const marker = 'SECRETMARKER';
    const events = [
      {
        type: 'heartbeat',
        event_id: 'big',
        agent_id: 'agent-a',
        payload: { blob: marker + 'x'.repeat(1_200_000) },
      },
    ];

    const raw = await (await ingest(t.key, { events })).text();

    expect(raw).not.toContain(marker);
  });
});

describe('unavailable without a database', () => {
  it('reports 503 rather than crashing', async () => {
    const noDb = createApp({ probeDatabase: () => Promise.resolve('unconfigured') });

    const response = await noDb.request(EVENT_INGEST_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events: [hb('e1')] }),
    });

    expect(response.status).toBe(503);
  });

  it('/healthz stays 200', async () => {
    const noDb = createApp({ probeDatabase: () => Promise.resolve('unconfigured') });

    expect((await noDb.request('/healthz')).status).toBe(200);
  });
});

describe('the ingest path stays write-only', () => {
  it('exposes no GET on the ingest path itself', async () => {
    const t = await tenant('op@example.test', 'Acme');
    await ingest(t.key, { events: [hb('e1')] });

    // Step 11 added the READ surface under /v1/workspaces/:id/events, which is
    // operator-authenticated. The machine ingest path gained nothing.
    for (const path of [EVENT_INGEST_PATH, `${EVENT_INGEST_PATH}/e1`]) {
      const response = await app.request(path, { headers: { cookie: t.cookie } });
      expect(response.status, path).toBe(404);
    }
  });

  it('an ingest API key cannot read the workspace timeline', async () => {
    const t = await tenant('op@example.test', 'Acme');
    await ingest(t.key, { events: [hb('e1')] });

    const response = await app.request(`/v1/workspaces/${t.workspaceId}/events`, {
      headers: { authorization: `Bearer ${t.key}` },
    });

    // The domains stay separate: machine keys write, browser sessions read.
    expect(response.status).toBe(401);
  });

  it('registration still works alongside ingest', async () => {
    const t = await tenant('op@example.test', 'Acme');

    const response = await app.request(AGENT_REGISTER_PATH, {
      method: 'POST',
      headers: { authorization: `Bearer ${t.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ agent_id: 'agent-a', name: 'Agent A' }),
    });

    expect(response.status).toBe(200);
  });
});
