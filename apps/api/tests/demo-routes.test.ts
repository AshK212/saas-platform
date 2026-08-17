import { randomUUID } from 'node:crypto';

import {
  AUTH_CALLBACK_PATH,
  AUTH_MAGIC_LINK_PATH,
  demoAgentListResponseSchema,
  demoAgentsPath,
  demoBlockListResponseSchema,
  demoBlocksPath,
  demoEventDetailResponseSchema,
  demoEventListResponseSchema,
  demoEventPath,
  demoEventsPath,
  demoReceiptsPath,
  demoSettingsResponseSchema,
  demoSlugSchema,
  demoWorkspacePath,
  demoWorkspaceResponseSchema,
  workspaceDemoPath,
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
import { createMemoryDemoStore, type MemoryDemoStore } from './helpers/memory-demo-store';
import {
  createMemoryEventReadStore,
  type MemoryEventReadStore,
} from './helpers/memory-event-read-store';
import {
  createMemoryGovernanceStore,
  type MemoryGovernanceStore,
} from './helpers/memory-governance-store';
import { createMemoryPolicyMutationStore } from './helpers/memory-policy-mutation-store';
import {
  createMemoryWorkspaceStore,
  type MemoryWorkspaceStore,
} from './helpers/memory-workspace-store';

/**
 * AC-19 - public demo mode.
 *
 * Two surfaces over real HTTP: operator enable/disable under the workspace
 * path, and a public read surface reachable with no credential of any kind.
 *
 * The tests care most about two things - that a private workspace can never be
 * reached publicly, and that the public surface can never write.
 */

const APP_URL = 'https://app.example.test';
const START = new Date('2026-08-16T10:00:00.000Z');

let authStore: MemoryAuthStore;
let mailer: CapturingEmailSender;
let workspaces: MemoryWorkspaceStore;
let demo: MemoryDemoStore;
let governance: MemoryGovernanceStore;
let events: MemoryEventReadStore;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  authStore = createMemoryAuthStore();
  mailer = createCapturingEmailSender();
  const clock = createFixedClock(START);
  workspaces = createMemoryWorkspaceStore();
  demo = createMemoryDemoStore();
  governance = createMemoryGovernanceStore();
  events = createMemoryEventReadStore();
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
    apiKeyStore: createMemoryApiKeyStore(),
    agentStore: createMemoryAgentStore(),
    governanceReadStore: governance,
    eventReadStore: events,
    demoManagementStore: demo,
    demoResolverStore: demo,
    // Wired so the "a demo visitor cannot mutate policy" test exercises the
    // real authorization path rather than passing on an unconfigured 503.
    policyMutationStore: createMemoryPolicyMutationStore(),
    clock,
  });
});

interface Tenant {
  readonly workspaceId: string;
  readonly cookie: string;
  readonly name: string;
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
  demo.seedWorkspace(workspaceId, name);
  return { workspaceId, cookie, name };
}

async function setDemo(t: Tenant, enabled: boolean, cookie = t.cookie): Promise<Response> {
  return app.request(workspaceDemoPath(t.workspaceId), {
    method: 'PUT',
    headers: { cookie, origin: APP_URL, 'content-type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
}

/** Enables and returns the public slug. */
async function enableDemo(t: Tenant): Promise<string> {
  const response = await setDemo(t, true);
  const body = demoSettingsResponseSchema.parse(await response.json());
  if (body.demo.slug === null) throw new Error('no slug');
  return body.demo.slug;
}

/** A public request: NO cookie, NO token, NO key. */
const publicGet = async (path: string): Promise<Response> => app.request(path);

const agentIds = new Map<string, string>();

function seedWorkspaceData(t: Tenant, agentExternalId = 'agent-a'): void {
  const agentId = randomUUID();
  agentIds.set(t.workspaceId, agentId);
  governance.seedAgent({
    workspaceId: t.workspaceId,
    id: agentId,
    externalId: agentExternalId,
    displayName: 'Agent A',
    lastSeenAt: START,
  });
  governance.seedPolicy({
    workspaceId: t.workspaceId,
    agentId,
    mode: 'budgeted',
    dailySpendCapUsd: '25.000000',
    dailyPublishCap: 5,
  });
  governance.seedLedger({
    workspaceId: t.workspaceId,
    agentId,
    day: '2026-08-16',
    spendCommittedUsd: '4.000000',
    publishCountCommitted: 1,
  });
  governance.seedReceipt({
    workspaceId: t.workspaceId,
    agentId,
    actionId: 'act-1',
    category: 'spend',
    decision: 'deny',
    denyReason: 'daily_spend_cap_exceeded',
    createdAt: START,
  });
  governance.seedBlock({
    workspaceId: t.workspaceId,
    agentId,
    source: 'plane',
    category: 'spend',
    rule: 'daily_spend_cap',
    reason: 'Daily spend cap reached.',
    createdAt: START,
  });
  events.seedEvent({
    workspaceId: t.workspaceId,
    eventId: 'evt-1',
    agentExternalId,
    type: 'heartbeat',
    receivedAt: START,
  });
}

// ───────────────────────────────────────────────────────────────────────────

describe('enabling the demo is operator-only', () => {
  it('rejects an unauthenticated request', async () => {
    const t = await tenant('op@example.test', 'Acme');

    const response = await app.request(workspaceDemoPath(t.workspaceId), {
      method: 'PUT',
      headers: { origin: APP_URL, 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });

    expect(response.status).toBe(401);
    expect(demo.workspaces[0]?.demoEnabled).toBe(false);
  });

  it('REJECTS A MEMBER', async () => {
    // Publishing a tenant is a decision on behalf of everyone in it.
    const t = await tenant('member@example.test', 'Acme', 'member');

    const response = await setDemo(t, true);

    expect(response.status).toBe(403);
    expect(demo.workspaces[0]?.demoEnabled).toBe(false);
  });

  it('CSRF: a foreign origin cannot publish a workspace', async () => {
    const t = await tenant('op@example.test', 'Acme');

    const response = await app.request(workspaceDemoPath(t.workspaceId), {
      method: 'PUT',
      headers: {
        cookie: t.cookie,
        origin: 'https://evil.example.test',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ enabled: true }),
    });

    expect(response.status).toBe(403);
    expect(demo.workspaces[0]?.demoEnabled).toBe(false);
  });

  it("cannot publish another operator's workspace", async () => {
    const a = await tenant('alice@example.test', 'Alice Co');
    const b = await tenant('bob@example.test', 'Bob Co');

    const response = await app.request(workspaceDemoPath(b.workspaceId), {
      method: 'PUT',
      headers: { cookie: a.cookie, origin: APP_URL, 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });

    expect(response.status).toBe(404);
    expect(demo.workspaces.every((w) => !w.demoEnabled)).toBe(true);
  });

  it('rejects a body carrying unknown fields', async () => {
    const t = await tenant('op@example.test', 'Acme');

    const response = await app.request(workspaceDemoPath(t.workspaceId), {
      method: 'PUT',
      headers: { cookie: t.cookie, origin: APP_URL, 'content-type': 'application/json' },
      // A caller must not believe it chose its own slug.
      body: JSON.stringify({ enabled: true, slug: 'squatted-name' }),
    });

    expect(response.status).toBe(400);
    expect(demo.workspaces[0]?.demoEnabled).toBe(false);
  });

  it('DEFAULTS TO PRIVATE', async () => {
    const t = await tenant('op@example.test', 'Acme');

    const response = await app.request(workspaceDemoPath(t.workspaceId), {
      headers: { cookie: t.cookie },
    });
    const body = demoSettingsResponseSchema.parse(await response.json());

    // A workspace is never born public.
    expect(body.demo).toEqual({ enabled: false, slug: null, publicPath: null });
  });
});

describe('slug assignment', () => {
  it('mints a readable, contract-shaped slug', async () => {
    const t = await tenant('op@example.test', 'Acme Robotics');

    const slug = await enableDemo(t);

    expect(demoSlugSchema.safeParse(slug).success).toBe(true);
    expect(slug).toMatch(/^acme-robotics-[a-z0-9]+$/);
  });

  it('LEAKS NO INTERNAL IDENTIFIER', async () => {
    const t = await tenant('op@example.test', 'Acme');

    const slug = await enableDemo(t);

    // A uuid in a public URL is an identity someone would try elsewhere.
    expect(slug).not.toContain(t.workspaceId);
    expect(slug).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
    expect(slug).not.toContain('op@example.test');
  });

  it('handles a name with no usable characters', async () => {
    const t = await tenant('op@example.test', '株式会社');

    const slug = await enableDemo(t);

    expect(demoSlugSchema.safeParse(slug).success).toBe(true);
    expect(slug).toMatch(/^demo-[a-z0-9]+$/);
  });

  it('gives two same-named workspaces different slugs', async () => {
    const a = await tenant('alice@example.test', 'Acme');
    const b = await tenant('bob@example.test', 'Acme');

    const first = await enableDemo(a);
    const second = await enableDemo(b);

    expect(first).not.toBe(second);
  });

  it('enabling twice keeps the same address', async () => {
    const t = await tenant('op@example.test', 'Acme');

    const first = await enableDemo(t);
    const second = await enableDemo(t);

    // Pressing the button again is not a request for a new URL.
    expect(second).toBe(first);
  });
});

describe('THE PUBLIC DEMO NEEDS NO CREDENTIAL', () => {
  it('opens with only a slug', async () => {
    const t = await tenant('op@example.test', 'Acme');
    seedWorkspaceData(t);
    const slug = await enableDemo(t);

    // No cookie, no Authorization header, nothing.
    const response = await publicGet(demoWorkspacePath(slug));

    expect(response.status).toBe(200);
    expect(demoWorkspaceResponseSchema.parse(await response.json()).workspace).toEqual({
      name: 'Acme',
      slug,
    });
  });

  it('shows the real fleet, blocks, receipts and timeline', async () => {
    const t = await tenant('op@example.test', 'Acme');
    seedWorkspaceData(t);
    const slug = await enableDemo(t);

    const fleet = demoAgentListResponseSchema.parse(
      await (await publicGet(demoAgentsPath(slug))).json(),
    );
    const blocks = demoBlockListResponseSchema.parse(
      await (await publicGet(demoBlocksPath(slug))).json(),
    );
    const timeline = demoEventListResponseSchema.parse(
      await (await publicGet(demoEventsPath(slug))).json(),
    );

    expect(fleet.agents).toHaveLength(1);
    // Today's spend from the LEDGER, not summed from events.
    expect(fleet.agents[0]?.governance.spendCommittedUsd).toBe('4.000000');
    expect(fleet.agents[0]?.governance.dailySpendCapUsd).toBe('25.000000');
    // A REAL plane-owned block - the thing AC-19 exists to show.
    expect(blocks.blocks).toHaveLength(1);
    expect(blocks.blocks[0]?.source).toBe('plane');
    expect(blocks.blocks[0]?.rule).toBe('daily_spend_cap');
    expect(timeline.events).toHaveLength(1);
    expect((await publicGet(demoReceiptsPath(slug))).status).toBe(200);
  });

  it('serves the validated raw event payload', async () => {
    const t = await tenant('op@example.test', 'Acme');
    const hostile = '<script>alert(1)</script>';
    const seeded = events.seedEvent({
      workspaceId: t.workspaceId,
      eventId: 'evt-xss',
      agentExternalId: 'agent-a',
      type: 'heartbeat',
      receivedAt: START,
      payload: { note: hostile },
    });
    const slug = await enableDemo(t);

    const body = demoEventDetailResponseSchema.parse(
      await (await publicGet(demoEventPath(slug, seeded.id))).json(),
    );

    // Returned unchanged - it is audit data. The page renders it as a React
    // text child, so it displays as characters.
    expect((body.event.raw as { note: string }).note).toBe(hostile);
  });
});

describe('A PRIVATE WORKSPACE IS UNREACHABLE', () => {
  it('a disabled demo is dead immediately', async () => {
    const t = await tenant('op@example.test', 'Acme');
    seedWorkspaceData(t);
    const slug = await enableDemo(t);
    expect((await publicGet(demoAgentsPath(slug))).status).toBe(200);

    // THE AC-19 WITHDRAWAL FLOW.
    expect((await setDemo(t, false)).status).toBe(200);

    for (const path of [
      demoWorkspacePath(slug),
      demoAgentsPath(slug),
      demoEventsPath(slug),
      demoReceiptsPath(slug),
      demoBlocksPath(slug),
    ]) {
      const response = await publicGet(path);
      expect(response.status, path).toBe(404);
      expect(await response.json()).toEqual({ error: 'demo_not_found' });
    }
  });

  it('RE-ENABLING MINTS A NEW ADDRESS, and the old one stays dead', async () => {
    const t = await tenant('op@example.test', 'Acme');
    const original = await enableDemo(t);
    await setDemo(t, false);

    const reissued = await enableDemo(t);

    // The schema forbids a slug on a private workspace, so disabling clears
    // it. A withdrawn URL silently resuming months later would be a surprise
    // in the wrong direction.
    expect(reissued).not.toBe(original);
    expect((await publicGet(demoWorkspacePath(original))).status).toBe(404);
    expect((await publicGet(demoWorkspacePath(reissued))).status).toBe(200);
  });

  it.each([
    ['an unknown slug', 'never-existed-abc123'],
    ['a malformed slug', 'Not A Slug!'],
    ['a uuid', '11111111-1111-4111-8111-111111111111'],
    ['an empty segment', '%20'],
  ])('refuses %s identically', async (_label, slug) => {
    const t = await tenant('op@example.test', 'Acme');
    await enableDemo(t);

    const response = await publicGet(demoWorkspacePath(slug));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'demo_not_found' });
  });

  it('THE FLAG ALONE IS ENOUGH: an orphaned slug still resolves to nothing', async () => {
    // Constructs the state the CHECK CONSTRAINT forbids - a slug on a private
    // workspace - to prove the resolver's `demo_enabled` predicate carries its
    // own weight, rather than passing only because disabling also clears the
    // slug. Defence in depth, tested as depth.
    const t = await tenant('op@example.test', 'Acme');
    seedWorkspaceData(t);
    demo.forceOrphanedSlug(t.workspaceId, 'orphaned-slug-abc123');

    for (const path of [
      demoWorkspacePath('orphaned-slug-abc123'),
      demoAgentsPath('orphaned-slug-abc123'),
      demoBlocksPath('orphaned-slug-abc123'),
    ]) {
      const response = await publicGet(path);
      expect(response.status, path).toBe(404);
      expect(await response.json()).toEqual({ error: 'demo_not_found' });
    }
  });

  it('a never-enabled workspace exposes nothing', async () => {
    const a = await tenant('alice@example.test', 'Alice Co');
    seedWorkspaceData(a);
    // Bob enables so a valid slug exists in the system; Alice never does.
    const b = await tenant('bob@example.test', 'Bob Co');
    await enableDemo(b);

    // There is no slug for Alice, and no way to ask for one.
    expect(demo.workspaces.find((w) => w.workspaceId === a.workspaceId)?.demoSlug).toBeNull();
  });
});

describe('CROSS-TENANT ISOLATION', () => {
  it("A's demo exposes only A", async () => {
    const a = await tenant('alice@example.test', 'Alice Co');
    const b = await tenant('bob@example.test', 'Bob Co');
    // The same external agent id in both tenants.
    seedWorkspaceData(a, 'agent-shared');
    seedWorkspaceData(b, 'agent-shared');
    const slug = await enableDemo(a);

    const fleet = demoAgentListResponseSchema.parse(
      await (await publicGet(demoAgentsPath(slug))).json(),
    );

    expect(fleet.agents).toHaveLength(1);
    expect(fleet.agents[0]?.id).toBe(agentIds.get(a.workspaceId));
    expect(JSON.stringify(fleet)).not.toContain(b.workspaceId);
  });

  it("B's exact event uuid is invisible through A's demo", async () => {
    const a = await tenant('alice@example.test', 'Alice Co');
    const b = await tenant('bob@example.test', 'Bob Co');
    const bobsEvent = events.seedEvent({
      workspaceId: b.workspaceId,
      eventId: 'evt-bob',
      agentExternalId: 'agent-b',
      type: 'heartbeat',
      receivedAt: START,
    });
    const slug = await enableDemo(a);

    const response = await publicGet(demoEventPath(slug, bobsEvent.id));

    // Identical to an event that never existed.
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'demo_not_found' });
  });

  it("B's receipts and blocks never appear in A's demo", async () => {
    const a = await tenant('alice@example.test', 'Alice Co');
    const b = await tenant('bob@example.test', 'Bob Co');
    seedWorkspaceData(b);
    const slug = await enableDemo(a);

    expect(await (await publicGet(demoReceiptsPath(slug))).json()).toEqual({
      receipts: [],
      nextCursor: null,
    });
    expect(await (await publicGet(demoBlocksPath(slug))).json()).toEqual({
      blocks: [],
      nextCursor: null,
    });
  });

  it('an agent filter cannot reach across tenants', async () => {
    const a = await tenant('alice@example.test', 'Alice Co');
    const b = await tenant('bob@example.test', 'Bob Co');
    seedWorkspaceData(b, 'agent-bob');
    const slug = await enableDemo(a);

    const response = await publicGet(`${demoEventsPath(slug)}?agent_id=agent-bob`);

    expect(demoEventListResponseSchema.parse(await response.json()).events).toEqual([]);
  });

  it("B's slug cannot be used to read A", async () => {
    const a = await tenant('alice@example.test', 'Alice Co');
    const b = await tenant('bob@example.test', 'Bob Co');
    seedWorkspaceData(a);
    seedWorkspaceData(b, 'agent-bob');
    await enableDemo(a);
    const bobsSlug = await enableDemo(b);

    const fleet = demoAgentListResponseSchema.parse(
      await (await publicGet(demoAgentsPath(bobsSlug))).json(),
    );

    // Each slug resolves to its OWN workspace.
    expect(fleet.agents[0]?.id).toBe(agentIds.get(b.workspaceId));
  });
});

describe('NO MUTATION IS REACHABLE FROM THE PUBLIC DEMO', () => {
  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])(
    'refuses %s on every demo read path',
    async (method) => {
      const t = await tenant('op@example.test', 'Acme');
      const slug = await enableDemo(t);

      for (const path of [
        demoWorkspacePath(slug),
        demoAgentsPath(slug),
        demoEventsPath(slug),
        demoReceiptsPath(slug),
        demoBlocksPath(slug),
      ]) {
        const response = await app.request(path, {
          method,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        });
        expect(response.status, `${method} ${path}`).toBe(404);
      }
    },
  );

  it.each([
    ['policy', (id: string) => `/v1/workspaces/${id}/agents/${randomUUID()}/policy`, 'PUT'],
    ['api keys', (id: string) => `/v1/workspaces/${id}/api-keys`, 'POST'],
    ['demo settings', (id: string) => `/v1/workspaces/${id}/demo`, 'PUT'],
    ['workspaces', () => '/v1/workspaces', 'POST'],
  ])('an anonymous visitor cannot reach %s', async (_label, build, method) => {
    const t = await tenant('op@example.test', 'Acme');
    await enableDemo(t);

    const response = await app.request(build(t.workspaceId), {
      method,
      headers: { origin: APP_URL, 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });

    expect([401, 403]).toContain(response.status);
    expect(demo.workspaces[0]?.demoEnabled).toBe(true);
  });

  it('READING CHANGES NOTHING', async () => {
    const t = await tenant('op@example.test', 'Acme');
    seedWorkspaceData(t);
    const slug = await enableDemo(t);
    const governanceBefore = governance.snapshot();
    const demoBefore = demo.snapshot();

    for (const path of [
      demoWorkspacePath(slug),
      demoAgentsPath(slug),
      demoEventsPath(slug),
      demoReceiptsPath(slug),
      demoBlocksPath(slug),
    ]) {
      await publicGet(path);
    }

    // No last-seen refresh, no ledger row, no policy version, no demo write.
    expect(governance.snapshot()).toBe(governanceBefore);
    expect(demo.snapshot()).toBe(demoBefore);
  });
});

describe('the public demo leaks no secrets', () => {
  it('carries no key, cookie, digest or workspace id', async () => {
    const t = await tenant('op@example.test', 'Acme');
    seedWorkspaceData(t);
    const slug = await enableDemo(t);

    const bodies = await Promise.all(
      [
        demoWorkspacePath(slug),
        demoAgentsPath(slug),
        demoEventsPath(slug),
        demoReceiptsPath(slug),
        demoBlocksPath(slug),
      ].map(async (path) => (await publicGet(path)).text()),
    );
    const combined = bodies.join('\n');

    expect(combined).not.toContain(t.workspaceId);
    expect(combined).not.toContain('hmp_live');
    expect(combined).not.toContain('hmp_share');
    expect(combined).not.toMatch(/secret|password|authorization|postgres:\/\//i);
  });
});

describe('demo and share are independent', () => {
  it('the demo store never reads or writes share state', () => {
    // Separate authorities. Revoking a share must not disable the demo, and
    // disabling the demo must not revoke shares - the two never meet.
    const serialised = demo.snapshot();

    expect(serialised).not.toContain('token');
    expect(serialised).not.toContain('share');
  });
});

describe('unavailable without a database', () => {
  it.each([
    ['management', workspaceDemoPath('any')],
    ['public', demoAgentsPath('some-slug')],
  ])('reports 503 on %s rather than crashing', async (_label, path) => {
    const noDb = createApp({ probeDatabase: () => Promise.resolve('unconfigured') });

    expect((await noDb.request(path)).status).toBe(503);
  });

  it('leaves liveness unaffected', async () => {
    const noDb = createApp({ probeDatabase: () => Promise.resolve('unconfigured') });

    expect((await noDb.request('/healthz')).status).toBe(200);
  });
});
