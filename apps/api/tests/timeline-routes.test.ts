import {
  AUTH_CALLBACK_PATH,
  AUTH_MAGIC_LINK_PATH,
  eventDetailResponseSchema,
  TIMELINE_MAX_LIMIT,
  timelineResponseSchema,
  workspaceApiKeysPath,
  workspaceEventPath,
  workspaceEventsPath,
  type EventSummary,
  type TimelineResponse,
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
import {
  createMemoryEventReadStore,
  type MemoryEventReadStore,
} from './helpers/memory-event-read-store';
import {
  createMemoryWorkspaceStore,
  type MemoryWorkspaceStore,
} from './helpers/memory-workspace-store';

/**
 * Timeline and event-detail routes (AC-05, AC-06).
 *
 * The two properties under test throughout are TENANT ISOLATION and READ-ONLY.
 * Every read is workspace-scoped, an id from another tenant is
 * indistinguishable from one that does not exist, and there is no route here
 * that writes anything.
 */

const APP_URL = 'https://app.example.test';
const START = new Date('2026-08-12T10:00:00.000Z');
const FOREIGN_UUID = '11111111-1111-4111-8111-111111111111';

let authStore: MemoryAuthStore;
let mailer: CapturingEmailSender;
let clock: ReturnType<typeof createFixedClock>;
let workspaces: MemoryWorkspaceStore;
let apiKeys: MemoryApiKeyStore;
let readStore: MemoryEventReadStore;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  authStore = createMemoryAuthStore();
  mailer = createCapturingEmailSender();
  clock = createFixedClock(START);
  workspaces = createMemoryWorkspaceStore();
  apiKeys = createMemoryApiKeyStore();
  readStore = createMemoryEventReadStore();
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
    eventReadStore: readStore,
    clock,
  });
});

interface Tenant {
  readonly workspaceId: string;
  readonly cookie: string;
}

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

async function tenant(
  email: string,
  name: string,
  role: 'operator' | 'member' = 'operator',
): Promise<Tenant> {
  const { cookie, userId } = await signIn(email);
  const workspaceId = workspaces.seedWorkspace(name, [{ userId, role }]);
  return { workspaceId, cookie };
}

async function getTimeline(t: Tenant, query = ''): Promise<Response> {
  return app.request(`${workspaceEventsPath(t.workspaceId)}${query}`, {
    headers: { cookie: t.cookie },
  });
}

async function timelineBody(t: Tenant, query = ''): Promise<TimelineResponse> {
  const response = await getTimeline(t, query);
  expect(response.status).toBe(200);
  return timelineResponseSchema.parse(await response.json());
}

/** Seeds `count` events one second apart, oldest first. */
function seedSequence(workspaceId: string, count: number, agentExternalId = 'agent-a'): void {
  for (let i = 0; i < count; i += 1) {
    readStore.seedEvent({
      workspaceId,
      eventId: `evt-${String(i).padStart(3, '0')}`,
      agentExternalId,
      type: 'heartbeat',
      receivedAt: new Date(START.getTime() + i * 1_000),
    });
  }
}

describe('authentication and domain separation', () => {
  it('rejects an unauthenticated timeline request', async () => {
    const t = await tenant('op@example.test', 'Acme');

    expect((await app.request(workspaceEventsPath(t.workspaceId))).status).toBe(401);
  });

  it('rejects an unauthenticated detail request', async () => {
    const t = await tenant('op@example.test', 'Acme');
    const event = readStore.seedEvent({
      workspaceId: t.workspaceId,
      eventId: 'evt-1',
      agentExternalId: 'agent-a',
      type: 'heartbeat',
      receivedAt: START,
    });

    expect((await app.request(workspaceEventPath(t.workspaceId, event.id))).status).toBe(401);
  });

  it('REFUSES a machine API key on the operator timeline', async () => {
    const t = await tenant('op@example.test', 'Acme');
    const issued = await app.request(workspaceApiKeysPath(t.workspaceId), {
      method: 'POST',
      headers: { cookie: t.cookie, origin: APP_URL, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'ingest' }),
    });
    const { apiKey } = (await issued.json()) as { apiKey: { key: string } };
    seedSequence(t.workspaceId, 3);

    const response = await app.request(workspaceEventsPath(t.workspaceId), {
      headers: { authorization: `Bearer ${apiKey.key}` },
    });

    // Machine keys ingest; browser sessions read. A key that can write events
    // must not be able to read the tenant's history back.
    expect(response.status).toBe(401);
  });

  it('REFUSES a machine API key on event detail', async () => {
    const t = await tenant('op@example.test', 'Acme');
    const issued = await app.request(workspaceApiKeysPath(t.workspaceId), {
      method: 'POST',
      headers: { cookie: t.cookie, origin: APP_URL, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'ingest' }),
    });
    const { apiKey } = (await issued.json()) as { apiKey: { key: string } };
    const event = readStore.seedEvent({
      workspaceId: t.workspaceId,
      eventId: 'evt-1',
      agentExternalId: 'agent-a',
      type: 'heartbeat',
      receivedAt: START,
    });

    const response = await app.request(workspaceEventPath(t.workspaceId, event.id), {
      headers: { authorization: `Bearer ${apiKey.key}` },
    });

    expect(response.status).toBe(401);
  });

  it('allows a non-operator member to read', async () => {
    // Events are ordinary tenant data, unlike API keys. Membership suffices,
    // matching the rule already set for the agent roster.
    const t = await tenant('member@example.test', 'Acme', 'member');
    seedSequence(t.workspaceId, 2);

    const body = await timelineBody(t);

    expect(body.events).toHaveLength(2);
  });

  it('returns 404 for a workspace the caller does not belong to', async () => {
    const a = await tenant('alice@example.test', 'Alice Co');
    const b = await tenant('bob@example.test', 'Bob Co');
    seedSequence(b.workspaceId, 3);

    const response = await app.request(workspaceEventsPath(b.workspaceId), {
      headers: { cookie: a.cookie },
    });

    // Not 403: a 403 would confirm the workspace exists.
    expect(response.status).toBe(404);
  });
});

describe('timeline ordering', () => {
  it('returns an empty page for a workspace with no events', async () => {
    const t = await tenant('op@example.test', 'Acme');

    const body = await timelineBody(t);

    expect(body).toEqual({ events: [], nextCursor: null });
  });

  it('returns a single event', async () => {
    const t = await tenant('op@example.test', 'Acme');
    seedSequence(t.workspaceId, 1);

    const body = await timelineBody(t);

    expect(body.events).toHaveLength(1);
    expect(body.events[0]?.eventId).toBe('evt-000');
    expect(body.nextCursor).toBeNull();
  });

  it('orders newest first by received_at', async () => {
    const t = await tenant('op@example.test', 'Acme');
    seedSequence(t.workspaceId, 5);

    const body = await timelineBody(t);

    expect(body.events.map((e) => e.eventId)).toEqual([
      'evt-004',
      'evt-003',
      'evt-002',
      'evt-001',
      'evt-000',
    ]);
  });

  it('IGNORES client-reported occurred_at for ordering', async () => {
    const t = await tenant('op@example.test', 'Acme');
    readStore.seedEvent({
      workspaceId: t.workspaceId,
      eventId: 'older-received',
      agentExternalId: 'agent-a',
      type: 'heartbeat',
      receivedAt: START,
      // A client claiming the far future must not jump the queue.
      occurredAt: new Date('2099-01-01T00:00:00.000Z'),
    });
    readStore.seedEvent({
      workspaceId: t.workspaceId,
      eventId: 'newer-received',
      agentExternalId: 'agent-a',
      type: 'heartbeat',
      receivedAt: new Date(START.getTime() + 1_000),
      occurredAt: new Date('1999-01-01T00:00:00.000Z'),
    });

    const body = await timelineBody(t);

    expect(body.events.map((e) => e.eventId)).toEqual(['newer-received', 'older-received']);
  });

  it('breaks a received_at tie deterministically', async () => {
    const t = await tenant('op@example.test', 'Acme');
    // One batch is one transaction stamped from one clock read, so identical
    // received_at is the normal case, not an edge case.
    for (let i = 0; i < 6; i += 1) {
      readStore.seedEvent({
        workspaceId: t.workspaceId,
        eventId: `evt-${String(i)}`,
        agentExternalId: 'agent-a',
        type: 'heartbeat',
        receivedAt: START,
      });
    }

    const first = await timelineBody(t);
    const second = await timelineBody(t);

    expect(first.events.map((e) => e.id)).toEqual(second.events.map((e) => e.id));
    // Descending by id, the documented tiebreaker.
    const ids = first.events.map((e) => e.id);
    expect([...ids].sort().reverse()).toEqual(ids);
  });
});

describe('page sizing', () => {
  it('defaults to 50', async () => {
    const t = await tenant('op@example.test', 'Acme');
    seedSequence(t.workspaceId, 60);

    const body = await timelineBody(t);

    expect(body.events).toHaveLength(50);
    expect(body.nextCursor).not.toBeNull();
  });

  it('honours an explicit limit', async () => {
    const t = await tenant('op@example.test', 'Acme');
    seedSequence(t.workspaceId, 10);

    expect((await timelineBody(t, '?limit=3')).events).toHaveLength(3);
  });

  it('accepts the maximum', async () => {
    const t = await tenant('op@example.test', 'Acme');
    seedSequence(t.workspaceId, 120);

    const body = await timelineBody(t, `?limit=${String(TIMELINE_MAX_LIMIT)}`);

    expect(body.events).toHaveLength(TIMELINE_MAX_LIMIT);
  });

  it.each([
    ['zero', '?limit=0'],
    ['above the maximum', '?limit=101'],
    ['absurd', '?limit=9999'],
    ['negative', '?limit=-1'],
    ['fractional', '?limit=1.5'],
    ['non-numeric', '?limit=abc'],
    ['empty', '?limit='],
    ['scientific notation', '?limit=1e3'],
  ])('rejects a %s limit with 400', async (_label, query) => {
    const t = await tenant('op@example.test', 'Acme');
    seedSequence(t.workspaceId, 5);

    const response = await getTimeline(t, query);

    // Never silently clamped to the default - that would hide a client bug.
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe('invalid_query');
  });

  it('rejects an unknown query parameter', async () => {
    const t = await tenant('op@example.test', 'Acme');

    // A misspelled `agent-id` must not silently return the whole stream.
    expect((await getTimeline(t, '?agent-id=agent-a')).status).toBe(400);
  });

  it('never returns raw payloads in a timeline row', async () => {
    const t = await tenant('op@example.test', 'Acme');
    readStore.seedEvent({
      workspaceId: t.workspaceId,
      eventId: 'evt-1',
      agentExternalId: 'agent-a',
      type: 'heartbeat',
      receivedAt: START,
      payload: { enormous: 'x'.repeat(5_000) },
    });

    const raw = await (await getTimeline(t)).text();

    // A page holds up to 100 rows; embedding payloads would make the response
    // size a function of untrusted client data.
    expect(raw).not.toContain('enormous');
    expect(raw).not.toContain('xxxx');
  });
});

describe('cursor pagination', () => {
  it('walks every event exactly once with no duplicates or gaps', async () => {
    const t = await tenant('op@example.test', 'Acme');
    seedSequence(t.workspaceId, 25);

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;

    do {
      const query: string = `?limit=7${cursor === null ? '' : `&cursor=${cursor}`}`;
      const body: TimelineResponse = await timelineBody(t, query);
      seen.push(...body.events.map((e: EventSummary) => e.eventId));
      cursor = body.nextCursor;
      pages += 1;
      expect(pages).toBeLessThan(10);
    } while (cursor !== null);

    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);
    // And in the same newest-first order the single-page read would give.
    const single = await timelineBody(t, '?limit=100');
    expect(seen).toEqual(single.events.map((e) => e.eventId));
  });

  it('pages correctly when every received_at is identical', async () => {
    // The case the id tiebreaker exists for: without it, paging a block of
    // equal timestamps repeats and skips rows.
    const t = await tenant('op@example.test', 'Acme');
    for (let i = 0; i < 12; i += 1) {
      readStore.seedEvent({
        workspaceId: t.workspaceId,
        eventId: `evt-${String(i)}`,
        agentExternalId: 'agent-a',
        type: 'heartbeat',
        receivedAt: START,
      });
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const body: TimelineResponse = await timelineBody(
        t,
        `?limit=5${cursor === null ? '' : `&cursor=${cursor}`}`,
      );
      seen.push(...body.events.map((e: EventSummary) => e.eventId));
      cursor = body.nextCursor;
    } while (cursor !== null);

    expect(seen).toHaveLength(12);
    expect(new Set(seen).size).toBe(12);
  });

  it('reports a null cursor on the final page', async () => {
    const t = await tenant('op@example.test', 'Acme');
    seedSequence(t.workspaceId, 6);

    // Exactly one page worth: there is nothing after it.
    expect((await timelineBody(t, '?limit=6')).nextCursor).toBeNull();
  });

  it.each([
    ['not base64url', '?cursor=!!!!'],
    ['base64 of non-JSON', `?cursor=${Buffer.from('not json', 'utf8').toString('base64url')}`],
    ['base64 of an array', `?cursor=${Buffer.from('[]', 'utf8').toString('base64url')}`],
    ['base64 of null', `?cursor=${Buffer.from('null', 'utf8').toString('base64url')}`],
    [
      'missing fields',
      `?cursor=${Buffer.from(JSON.stringify({ r: '2026-08-12T10:00:00.000Z' }), 'utf8').toString('base64url')}`,
    ],
    [
      'a non-uuid id',
      `?cursor=${Buffer.from(JSON.stringify({ r: '2026-08-12T10:00:00.000Z', i: 'nope' }), 'utf8').toString('base64url')}`,
    ],
    [
      'an unparseable date',
      `?cursor=${Buffer.from(JSON.stringify({ r: 'nonsense', i: FOREIGN_UUID }), 'utf8').toString('base64url')}`,
    ],
    [
      'extra keys',
      `?cursor=${Buffer.from(JSON.stringify({ r: '2026-08-12T10:00:00.000Z', i: FOREIGN_UUID, workspace_id: 'x' }), 'utf8').toString('base64url')}`,
    ],
    [
      'a SQL injection attempt',
      `?cursor=${Buffer.from(JSON.stringify({ r: '2026-08-12T10:00:00.000Z', i: "' OR 1=1--" }), 'utf8').toString('base64url')}`,
    ],
    ['empty', '?cursor='],
  ])('returns a safe 400 for a cursor that is %s', async (_label, query) => {
    const t = await tenant('op@example.test', 'Acme');
    seedSequence(t.workspaceId, 5);

    const response = await getTimeline(t, query);

    expect(response.status).toBe(400);
    const raw = await response.text();
    // No crash, no stack, no SQL, and no silent fallback to page one.
    expect(raw).toContain('invalid_query');
    expect(raw).not.toMatch(/SyntaxError|select|from events/i);
  });

  it('a cursor from another workspace cannot reach that workspace', async () => {
    const a = await tenant('alice@example.test', 'Alice Co');
    const b = await tenant('bob@example.test', 'Bob Co');
    seedSequence(a.workspaceId, 3, 'agent-a');
    seedSequence(b.workspaceId, 10, 'agent-b');

    // Take a genuine cursor from B's stream...
    const bPage = await timelineBody(b, '?limit=2');
    expect(bPage.nextCursor).not.toBeNull();

    // ...and replay it as A. The cursor carries no tenancy; scope comes from
    // A's membership, so this can only move A's own page boundary.
    const aPage = await timelineBody(a, `?cursor=${bPage.nextCursor ?? ''}`);

    for (const event of aPage.events) {
      expect(readStore.rows.find((r) => r.id === event.id)?.workspaceId).toBe(a.workspaceId);
    }
  });

  it('encodes no workspace id in the cursor', async () => {
    const t = await tenant('op@example.test', 'Acme');
    seedSequence(t.workspaceId, 5);

    const body = await timelineBody(t, '?limit=2');
    const decoded = Buffer.from(body.nextCursor ?? '', 'base64url').toString('utf8');

    // Tenancy in a client-held token would be an invitation to forge one.
    expect(decoded).not.toContain(t.workspaceId);
    expect(Object.keys(JSON.parse(decoded) as object).sort()).toEqual(['i', 'r']);
  });
});

describe('agent filtering', () => {
  it('returns only that agent events', async () => {
    const t = await tenant('op@example.test', 'Acme');
    seedSequence(t.workspaceId, 3, 'agent-a');
    seedSequence(t.workspaceId, 2, 'agent-b');

    const body = await timelineBody(t, '?agent_id=agent-b');

    expect(body.events).toHaveLength(2);
    for (const event of body.events) {
      expect(event.agent.agentId).toBe('agent-b');
    }
  });

  it('returns an empty page for an agent this workspace does not have', async () => {
    const t = await tenant('op@example.test', 'Acme');
    seedSequence(t.workspaceId, 3, 'agent-a');

    const body = await timelineBody(t, '?agent_id=agent-nonexistent');

    // Documented choice: empty, not 404. A 404 would reveal whether the id
    // exists somewhere on the platform.
    expect(body).toEqual({ events: [], nextCursor: null });
  });

  it('an agent id existing only in ANOTHER workspace also returns empty', async () => {
    const a = await tenant('alice@example.test', 'Alice Co');
    const b = await tenant('bob@example.test', 'Bob Co');
    seedSequence(b.workspaceId, 4, 'bobs-agent');
    seedSequence(a.workspaceId, 2, 'agent-a');

    const body = await timelineBody(a, '?agent_id=bobs-agent');

    // Identical to the unknown-agent response - no existence hint.
    expect(body).toEqual({ events: [], nextCursor: null });
  });

  it('a SHARED external agent id resolves per workspace', async () => {
    const a = await tenant('alice@example.test', 'Alice Co');
    const b = await tenant('bob@example.test', 'Bob Co');
    // Both tenants legitimately have `agent-1`; they are different rows.
    seedSequence(a.workspaceId, 2, 'agent-1');
    seedSequence(b.workspaceId, 7, 'agent-1');

    const aBody = await timelineBody(a, '?agent_id=agent-1');
    const bBody = await timelineBody(b, '?agent_id=agent-1');

    expect(aBody.events).toHaveLength(2);
    expect(bBody.events).toHaveLength(7);
    const aAgentIds = new Set(aBody.events.map((e) => e.agent.id));
    const bAgentIds = new Set(bBody.events.map((e) => e.agent.id));
    // Same external name, disjoint internal identities.
    expect([...aAgentIds].some((id) => bAgentIds.has(id))).toBe(false);
  });

  it('paginates within a filter', async () => {
    const t = await tenant('op@example.test', 'Acme');
    seedSequence(t.workspaceId, 12, 'agent-a');
    seedSequence(t.workspaceId, 12, 'agent-b');

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const body: TimelineResponse = await timelineBody(
        t,
        `?agent_id=agent-a&limit=5${cursor === null ? '' : `&cursor=${cursor}`}`,
      );
      for (const event of body.events) {
        expect(event.agent.agentId).toBe('agent-a');
      }
      seen.push(...body.events.map((e: EventSummary) => e.id));
      cursor = body.nextCursor;
    } while (cursor !== null);

    expect(seen).toHaveLength(12);
    expect(new Set(seen).size).toBe(12);
  });
});

describe('event detail (AC-06)', () => {
  it('returns the raw validated event verbatim', async () => {
    const t = await tenant('op@example.test', 'Acme');
    const payload = {
      type: 'spend.recorded',
      event_id: 'evt-1',
      agent_id: 'agent-a',
      amount_usd: '1.250000',
      provider: 'openai',
      payload: { model: 'gpt-x', nested: { attempt: 2, tags: ['a', 'b'] } },
    };
    const seeded = readStore.seedEvent({
      workspaceId: t.workspaceId,
      eventId: 'evt-1',
      agentExternalId: 'agent-a',
      type: 'spend.recorded',
      receivedAt: START,
      payload,
    });

    const response = await app.request(workspaceEventPath(t.workspaceId, seeded.id), {
      headers: { cookie: t.cookie },
    });

    expect(response.status).toBe(200);
    const body = eventDetailResponseSchema.parse(await response.json());
    // Byte-for-byte, nested structure included.
    expect(body.event.raw).toEqual(payload);
    expect(body.event.id).toBe(seeded.id);
    expect(body.event.eventId).toBe('evt-1');
  });

  it('preserves a script-looking payload string as DATA', async () => {
    const t = await tenant('op@example.test', 'Acme');
    const hostile = '<script>alert(1)</script>';
    const seeded = readStore.seedEvent({
      workspaceId: t.workspaceId,
      eventId: 'evt-xss',
      agentExternalId: 'agent-a',
      type: 'heartbeat',
      receivedAt: START,
      payload: { note: hostile },
    });

    const response = await app.request(workspaceEventPath(t.workspaceId, seeded.id), {
      headers: { cookie: t.cookie },
    });
    const body = eventDetailResponseSchema.parse(await response.json());

    // The API returns it unchanged - it is audit data and must not be mangled.
    // Rendering safety is the UI's job, and the UI renders it as a React text
    // child with no dangerouslySetInnerHTML anywhere.
    expect((body.event.raw as { note: string }).note).toBe(hostile);
    expect(response.headers.get('content-type')).toContain('application/json');
  });

  it('exposes safe block linkage', async () => {
    const t = await tenant('op@example.test', 'Acme');
    const seeded = readStore.seedEvent({
      workspaceId: t.workspaceId,
      eventId: 'evt-blocked',
      agentExternalId: 'agent-a',
      type: 'action.blocked',
      category: 'publish',
      receivedAt: START,
      block: { externalBlockId: 'client-block-123', source: 'runtime' },
    });

    const response = await app.request(workspaceEventPath(t.workspaceId, seeded.id), {
      headers: { cookie: t.cookie },
    });
    const body = eventDetailResponseSchema.parse(await response.json());

    expect(body.event.block?.externalBlockId).toBe('client-block-123');
    expect(body.event.block?.source).toBe('runtime');
    // Rule, reason and amount belong to block detail, which is a later step.
    expect(body.event.block).not.toHaveProperty('rule');
    expect(body.event.block).not.toHaveProperty('reason');
  });

  it('returns null block and precheck when there is no linkage', async () => {
    const t = await tenant('op@example.test', 'Acme');
    const seeded = readStore.seedEvent({
      workspaceId: t.workspaceId,
      eventId: 'evt-1',
      agentExternalId: 'agent-a',
      type: 'heartbeat',
      receivedAt: START,
    });

    const response = await app.request(workspaceEventPath(t.workspaceId, seeded.id), {
      headers: { cookie: t.cookie },
    });
    const body = eventDetailResponseSchema.parse(await response.json());

    expect(body.event.block).toBeNull();
    expect(body.event.precheckId).toBeNull();
  });

  it.each([
    ['an unknown uuid', FOREIGN_UUID],
    ['a malformed id', 'not-a-uuid'],
    ['a client event_id rather than the internal uuid', 'evt-1'],
    ['an empty-looking id', '%20'],
  ])('returns 404 for %s', async (_label, id) => {
    const t = await tenant('op@example.test', 'Acme');
    readStore.seedEvent({
      workspaceId: t.workspaceId,
      eventId: 'evt-1',
      agentExternalId: 'agent-a',
      type: 'heartbeat',
      receivedAt: START,
    });

    const response = await app.request(`${workspaceEventsPath(t.workspaceId)}/${id}`, {
      headers: { cookie: t.cookie },
    });

    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: string }).error).toBe('not_found');
  });

  it("CROSS-TENANT: a foreign event's exact uuid is 404", async () => {
    const a = await tenant('alice@example.test', 'Alice Co');
    const b = await tenant('bob@example.test', 'Bob Co');
    const bobsEvent = readStore.seedEvent({
      workspaceId: b.workspaceId,
      eventId: 'bobs-secret-event',
      agentExternalId: 'agent-b',
      type: 'heartbeat',
      receivedAt: START,
      payload: { secret: 'bob-only' },
    });

    // Alice holds the exact internal UUID. A UUID is not authorization.
    const viaOwn = await app.request(workspaceEventPath(a.workspaceId, bobsEvent.id), {
      headers: { cookie: a.cookie },
    });
    // And she cannot borrow Bob's workspace id either.
    const viaForeign = await app.request(workspaceEventPath(b.workspaceId, bobsEvent.id), {
      headers: { cookie: a.cookie },
    });

    expect(viaOwn.status).toBe(404);
    expect(viaForeign.status).toBe(404);
    expect(await viaOwn.text()).not.toContain('bob-only');
    expect(await viaForeign.text()).not.toContain('bob-only');
  });
});

describe('cross-tenant timeline isolation', () => {
  it('each operator sees only their own workspace stream', async () => {
    const a = await tenant('alice@example.test', 'Alice Co');
    const b = await tenant('bob@example.test', 'Bob Co');
    seedSequence(a.workspaceId, 3, 'agent-a');
    seedSequence(b.workspaceId, 5, 'agent-b');

    const aBody = await timelineBody(a);
    const bBody = await timelineBody(b);

    expect(aBody.events).toHaveLength(3);
    expect(bBody.events).toHaveLength(5);
    const aIds = new Set(aBody.events.map((e) => e.id));
    for (const event of bBody.events) {
      expect(aIds.has(event.id)).toBe(false);
    }
  });

  it('leaks no foreign payload through the timeline', async () => {
    const a = await tenant('alice@example.test', 'Alice Co');
    const b = await tenant('bob@example.test', 'Bob Co');
    readStore.seedEvent({
      workspaceId: b.workspaceId,
      eventId: 'bobs',
      agentExternalId: 'agent-b',
      type: 'heartbeat',
      receivedAt: START,
      payload: { secret: 'bob-only' },
    });
    seedSequence(a.workspaceId, 2, 'agent-a');

    const raw = await (await getTimeline(a)).text();

    expect(raw).not.toContain('bob-only');
    expect(raw).not.toContain('bobs');
  });
});

describe('no credential material in responses', () => {
  it('the timeline body carries no key or token material', async () => {
    const t = await tenant('op@example.test', 'Acme');
    const issued = await app.request(workspaceApiKeysPath(t.workspaceId), {
      method: 'POST',
      headers: { cookie: t.cookie, origin: APP_URL, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'ingest' }),
    });
    const { apiKey } = (await issued.json()) as { apiKey: { key: string } };
    seedSequence(t.workspaceId, 3);

    const raw = await (await getTimeline(t)).text();

    expect(raw).not.toContain(apiKey.key);
    expect(raw).not.toContain('hmp_live');
    expect(raw).not.toContain(t.cookie);
    expect(raw).not.toMatch(/authorization|secret_hash|postgres:\/\//i);
  });
});

describe('read-only surface', () => {
  it.each(['POST', 'PATCH', 'PUT', 'DELETE'])(
    'refuses %s on the workspace timeline',
    async (method) => {
      const t = await tenant('op@example.test', 'Acme');

      const response = await app.request(workspaceEventsPath(t.workspaceId), {
        method,
        headers: { cookie: t.cookie, origin: APP_URL, 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });

      // The audit stream is append-only; there is no dismiss or edit route.
      expect(response.status).toBe(404);
    },
  );

  it.each(['PATCH', 'PUT', 'DELETE'])('refuses %s on event detail', async (method) => {
    const t = await tenant('op@example.test', 'Acme');
    const seeded = readStore.seedEvent({
      workspaceId: t.workspaceId,
      eventId: 'evt-1',
      agentExternalId: 'agent-a',
      type: 'heartbeat',
      receivedAt: START,
    });

    const response = await app.request(workspaceEventPath(t.workspaceId, seeded.id), {
      method,
      headers: { cookie: t.cookie, origin: APP_URL },
    });

    expect(response.status).toBe(404);
  });

  it('adds no export or rollup route', async () => {
    const t = await tenant('op@example.test', 'Acme');

    // AC-16 (export) and AC-17 (rollups) are deferred.
    for (const path of [
      `${workspaceEventsPath(t.workspaceId)}.csv`,
      `${workspaceEventsPath(t.workspaceId)}/export`,
      `${workspaceEventsPath(t.workspaceId)}/summary`,
      `/v1/workspaces/${t.workspaceId}/rollups`,
    ]) {
      const response = await app.request(path, { headers: { cookie: t.cookie } });
      expect(response.status, path).toBe(404);
    }
  });
});

describe('unavailable without a database', () => {
  it('reports 503 rather than crashing', async () => {
    const noDb = createApp({ probeDatabase: () => Promise.resolve('unconfigured') });

    const response = await noDb.request('/v1/workspaces/any/events');

    expect(response.status).toBe(503);
  });

  it('leaves liveness unaffected', async () => {
    const noDb = createApp({ probeDatabase: () => Promise.resolve('unconfigured') });

    expect((await noDb.request('/healthz')).status).toBe(200);
  });
});
