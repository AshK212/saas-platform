import {
  AUTH_CALLBACK_PATH,
  AUTH_MAGIC_LINK_PATH,
  SHARE_ACCESS_PATH,
  workspaceApiKeysPath,
  workspaceDemoPath,
  workspaceShareLinksPath,
} from '@hybrid/contracts';

import { createApp } from '../../src/app';
import { createFixedClock } from '../../src/auth/clock';
import { AUTH_COOKIE_NAME } from '../../src/auth/cookie';
import { createCapturingEmailSender } from '../../src/auth/email';
import { createAuthService } from '../../src/auth/service';
import { SHARE_COOKIE_NAME } from '../../src/share/cookie';
import { createMemoryAgentStore, type MemoryAgentStore } from './memory-agent-store';
import { createMemoryApiKeyStore, type MemoryApiKeyStore } from './memory-api-key-store';
import { createMemoryAuthStore, type MemoryAuthStore } from './memory-auth-store';
import { createMemoryDemoStore, type MemoryDemoStore } from './memory-demo-store';
import { createMemoryEventReadStore, type MemoryEventReadStore } from './memory-event-read-store';
import { createMemoryEventStore, type MemoryEventStore } from './memory-event-store';
import { createMemoryGovernanceStore, type MemoryGovernanceStore } from './memory-governance-store';
import { createMemoryLedger, type MemoryLedger } from './memory-ledger';
import {
  createMemoryPolicyMutationStore,
  type MemoryPolicyMutationStore,
} from './memory-policy-mutation-store';
import { createMemoryPolicyStore, type MemoryPolicyStore } from './memory-policy-store';
import { createMemoryPrecheckStore, type MemoryPrecheckStore } from './memory-precheck-store';
import { createMemoryShareStore, type MemoryShareStore } from './memory-share-store';
import { createMemoryWorkspaceStore, type MemoryWorkspaceStore } from './memory-workspace-store';

/**
 * THE AC-20 TWO-TENANT WORLD.
 *
 * One application with EVERY store wired, and two workspaces inside it whose
 * external identifiers collide on purpose.
 *
 * ─── WHY ONE APP AND NOT ONE PER SUITE ────────────────────────────────────
 *
 * The scattered route suites each wire the two or three stores their feature
 * needs. That is right for testing a feature and wrong for testing isolation:
 * a leak between the timeline and the governance audit cannot appear in a test
 * that has only one of them mounted. AC-20 asks whether workspace A can reach
 * workspace B through ANY implemented path, so every path has to be mounted at
 * once, in one process, over one router.
 *
 * ─── WHY THE IDENTIFIERS COLLIDE ──────────────────────────────────────────
 *
 * Isolation tests that use distinct ids per tenant prove almost nothing: a
 * repository that forgot its workspace predicate still returns the right row,
 * because only one row matches. Every external identifier here is therefore
 * deliberately shared between A and B - the same `agent-1`, the same
 * `evt-shared-001`, the same `act-shared-001` - so a missing predicate returns
 * the WRONG TENANT'S ROW rather than nothing, and the test fails loudly.
 *
 * Internal UUIDs are the opposite case: globally unique, and therefore the
 * thing an attacker would actually hold. Those are captured from B and fed
 * back through A's authorities.
 *
 * ─── WHAT THIS HARNESS CAN AND CANNOT PROVE ───────────────────────────────
 *
 * It drives the REAL router, the REAL authorization middleware, the REAL
 * contracts and the REAL scope derivation. What it does not drive is SQL: the
 * stores are in-memory fakes. So it proves that each surface derives its
 * workspace from the right authority and never from request input.
 *
 * It cannot prove that a Drizzle query carries `workspace_id` in its WHERE
 * clause. That is the job of the compiled-SQL suite
 * (`packages/db/tests/ac20-sql-isolation.test.ts`), and of the live suite
 * (`packages/db/tests/ac20-cross-tenant.live.test.ts`) which alone can prove
 * PostgreSQL enforces it. Three layers, three different claims, stated
 * separately so none is mistaken for another.
 */

export const APP_URL = 'https://app.example.test';
export const START = new Date('2026-08-16T10:00:00.000Z');
export const TODAY = '2026-08-16';

/** Identifiers deliberately reused by BOTH tenants. */
export const SHARED = {
  agentExternalId: 'agent-1',
  secondAgentExternalId: 'agent-2',
  eventId: 'evt-shared-001',
  actionId: 'act-shared-001',
  blockExternalId: 'blk-shared-001',
} as const;

export interface Tenant {
  readonly label: 'A' | 'B';
  readonly workspaceId: string;
  readonly name: string;
  /** Operator session cookie header value. */
  readonly cookie: string;
  readonly operatorUserId: string;
  /** A member (non-operator) of the SAME workspace. */
  readonly memberCookie: string;
  /** Plaintext workspace API key. Machine authority. */
  readonly apiKey: string;
  /** Internal agent UUID for `SHARED.agentExternalId` in this workspace. */
  agentUuid: string;
  /** Internal UUIDs captured for cross-tenant probing. */
  eventUuid: string;
  receiptId: string;
  blockId: string;
  /** Share token plaintext, issued once. */
  shareToken: string;
  shareId: string;
  /** Public demo slug. */
  demoSlug: string;
}

export interface World {
  readonly app: ReturnType<typeof createApp>;
  readonly stores: {
    readonly auth: MemoryAuthStore;
    readonly workspaces: MemoryWorkspaceStore;
    readonly apiKeys: MemoryApiKeyStore;
    readonly agents: MemoryAgentStore;
    readonly events: MemoryEventStore;
    readonly eventReads: MemoryEventReadStore;
    readonly policy: MemoryPolicyStore;
    readonly policyMutation: MemoryPolicyMutationStore;
    readonly precheck: MemoryPrecheckStore;
    readonly governance: MemoryGovernanceStore;
    readonly shares: MemoryShareStore;
    readonly demo: MemoryDemoStore;
    /** ONE ledger, shared by ingest and precheck exactly as production shares one table. */
    readonly ledger: MemoryLedger;
  };
  readonly a: Tenant;
  readonly b: Tenant;
  /** A public request: no cookie, no bearer, no share cookie. */
  publicGet(path: string): Promise<Response>;
  /** GET as an operator session. */
  sessionGet(tenant: Tenant, path: string): Promise<Response>;
  /** Mutating request as an operator session, with a same-origin Origin header. */
  session(
    tenant: Tenant,
    method: 'POST' | 'PUT' | 'DELETE' | 'PATCH',
    path: string,
    body?: unknown,
    cookie?: string,
  ): Promise<Response>;
  /** Machine request carrying a workspace API key. */
  machine(
    tenant: Tenant,
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<Response>;
  /** GET through a share-view cookie holding `token`. */
  shareGet(token: string, path: string): Promise<Response>;
  /** Exchanges a share token for its cookie. */
  openShare(token: string): Promise<Response>;
  /** Everything B owns, serialized. Used to prove A's activity changed nothing. */
  snapshotB(): string;
}

/**
 * Builds the world.
 *
 * Order matters: B is provisioned FIRST and seeded with data, so every
 * cross-tenant probe afterwards is aimed at a workspace that genuinely holds
 * the row being asked for. A probe against an empty tenant proves nothing -
 * "not found" would be the right answer either way.
 */
export async function createWorld(): Promise<World> {
  const auth = createMemoryAuthStore();
  const mailer = createCapturingEmailSender();
  const clock = createFixedClock(START);
  const workspaces = createMemoryWorkspaceStore();
  const apiKeys = createMemoryApiKeyStore();
  const agents = createMemoryAgentStore();
  const ledger = createMemoryLedger();
  const events = createMemoryEventStore(ledger);
  const eventReads = createMemoryEventReadStore();
  const policy = createMemoryPolicyStore();
  const policyMutation = createMemoryPolicyMutationStore();
  const precheck = createMemoryPrecheckStore(ledger);
  const governance = createMemoryGovernanceStore();
  const shares = createMemoryShareStore();
  const demo = createMemoryDemoStore();

  const app = createApp({
    probeDatabase: () => Promise.resolve('ok'),
    authService: createAuthService({
      store: auth,
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
    eventStore: events,
    eventReadStore: eventReads,
    policyStore: policy,
    policyMutationStore: policyMutation,
    precheckStore: precheck,
    governanceReadStore: governance,
    shareManagementStore: shares,
    shareResolverStore: shares,
    demoManagementStore: demo,
    demoResolverStore: demo,
    clock,
  });

  async function signIn(email: string): Promise<{ cookie: string; userId: string }> {
    await app.request(AUTH_MAGIC_LINK_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const token = new URL(mailer.lastLink()?.url ?? '').searchParams.get('token') ?? '';
    const callback = await app.request(`${AUTH_CALLBACK_PATH}?token=${token}`);
    const value = (callback.headers.get('set-cookie') ?? '').split(';')[0]?.split('=')[1] ?? '';
    return { cookie: `${AUTH_COOKIE_NAME}=${value}`, userId: auth.users.get(email)?.id ?? '' };
  }

  const json = { 'content-type': 'application/json' };

  /** Hono's `request` may answer synchronously; every caller wants a promise. */
  const request = async (path: string, init?: RequestInit): Promise<Response> =>
    app.request(path, init);

  async function provision(label: 'A' | 'B', name: string): Promise<Tenant> {
    const operator = await signIn(`operator-${label.toLowerCase()}@example.test`);
    const member = await signIn(`member-${label.toLowerCase()}@example.test`);
    const workspaceId = workspaces.seedWorkspace(name, [
      { userId: operator.userId, role: 'operator' },
      { userId: member.userId, role: 'member' },
    ]);

    // The demo store models the `workspaces` row itself, so it needs the row
    // to exist before the toggle route can flip a flag on it.
    demo.seedWorkspace(workspaceId, name);

    const keyResponse = await app.request(workspaceApiKeysPath(workspaceId), {
      method: 'POST',
      headers: { cookie: operator.cookie, origin: APP_URL, ...json },
      body: JSON.stringify({ name: `${name} runtime` }),
    });
    const { apiKey } = (await keyResponse.json()) as { apiKey: { key: string } };

    return {
      label,
      workspaceId,
      name,
      cookie: operator.cookie,
      operatorUserId: operator.userId,
      memberCookie: member.cookie,
      apiKey: apiKey.key,
      agentUuid: '',
      eventUuid: '',
      receiptId: '',
      blockId: '',
      shareToken: '',
      shareId: '',
      demoSlug: '',
    };
  }

  const b = await provision('B', 'Beta Industries');
  const a = await provision('A', 'Acme Corporation');

  const world: World = {
    app,
    stores: {
      auth,
      workspaces,
      apiKeys,
      agents,
      events,
      eventReads,
      policy,
      policyMutation,
      precheck,
      governance,
      shares,
      demo,
      ledger,
    },
    a,
    b,

    publicGet: (path) => request(path),

    sessionGet: (tenant, path) => request(path, { headers: { cookie: tenant.cookie } }),

    session: (tenant, method, path, body, cookie) =>
      request(path, {
        method,
        headers: { cookie: cookie ?? tenant.cookie, origin: APP_URL, ...json },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),

    machine: (tenant, method, path, body, extraHeaders) =>
      request(path, {
        method,
        headers: {
          authorization: `Bearer ${tenant.apiKey}`,
          ...json,
          ...(extraHeaders ?? {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),

    shareGet: (token, path) =>
      request(path, { headers: { cookie: `${SHARE_COOKIE_NAME}=${token}` } }),

    openShare: (token) =>
      request(SHARE_ACCESS_PATH, {
        method: 'POST',
        headers: { origin: APP_URL, ...json },
        body: JSON.stringify({ token }),
      }),

    snapshotB: () =>
      JSON.stringify({
        agents: agents.agents.filter((r) => r.workspaceId === b.workspaceId),
        ingestAgents: events.agents.filter((r) => r.workspaceId === b.workspaceId),
        events: events.events.filter((r) => r.workspaceId === b.workspaceId),
        ingestBlocks: events.blocks.filter((r) => r.workspaceId === b.workspaceId),
        ingestReceipts: events.receipts.filter((r) => r.workspaceId === b.workspaceId),
        timeline: eventReads.rows.filter((r) => r.workspaceId === b.workspaceId),
        receipts: precheck.receipts.filter((r) => r.workspaceId === b.workspaceId),
        planeBlocks: precheck.blocks.filter((r) => r.workspaceId === b.workspaceId),
        ledger: ledger.rows.filter((r) => r.workspaceId === b.workspaceId),
        policyVersion: policyMutation.versionOf(b.workspaceId),
        shares: shares.shares.filter((r) => r.workspaceId === b.workspaceId),
        demo: demo.workspaces.filter((r) => r.workspaceId === b.workspaceId),
      }),
  };

  await seedTenant(world, b);
  await seedTenant(world, a);

  return world;
}

/**
 * Gives a tenant a full set of Credit-phase records, using the SHARED external
 * identifiers so both tenants collide everywhere it is legal to collide.
 *
 * Written through the real API wherever a route exists for it. Where a route
 * does not exist - governance read rows, which the operator UI reads but no
 * public write path creates - the store is seeded directly, and the internal
 * UUIDs it mints are captured so later probes can aim at them.
 */
async function seedTenant(world: World, tenant: Tenant): Promise<void> {
  const { stores } = world;

  // Machine path: register the agent through the REAL bearer-authenticated
  // route, so the workspace comes from the credential row.
  await world.machine(tenant, 'POST', '/v1/agents/register', {
    agent_id: SHARED.agentExternalId,
    name: `${tenant.name} first agent`,
  });
  await world.machine(tenant, 'POST', '/v1/agents/register', {
    agent_id: SHARED.secondAgentExternalId,
  });

  // Machine path: ingest an event whose external id is shared with the other
  // tenant. Duplicate detection must be workspace-qualified for both to exist.
  await world.machine(tenant, 'POST', '/v1/events', {
    events: [
      {
        event_id: SHARED.eventId,
        agent_id: SHARED.agentExternalId,
        type: 'heartbeat',
        occurred_at: START.toISOString(),
      },
    ],
  });

  // ONE internal agent id, as production has one `agents` table.
  //
  // The fakes each maintain their own agent list, and left alone they would
  // mint three different UUIDs for one logical agent. That would quietly
  // weaken every probe below: an id captured from B's roster would fail
  // against B's own policy route too, so a cross-tenant 404 would prove
  // nothing. The registry's id is therefore adopted by the governance and
  // policy fakes, so a captured UUID is genuinely B's everywhere.
  const registered = stores.agents.agents.find(
    (r) => r.workspaceId === tenant.workspaceId && r.externalId === SHARED.agentExternalId,
  );
  if (registered === undefined) {
    throw new Error('agent registration did not reach the registry');
  }
  const agentUuid = registered.id;
  tenant.agentUuid = agentUuid;
  stores.governance.seedAgent({
    workspaceId: tenant.workspaceId,
    id: agentUuid,
    externalId: SHARED.agentExternalId,
    displayName: `${tenant.name} first agent`,
    lastSeenAt: START,
  });
  stores.governance.seedPolicy({
    workspaceId: tenant.workspaceId,
    agentId: agentUuid,
    mode: 'budgeted',
    dailySpendCapUsd: '25.000000',
    dailyPublishCap: 5,
  });
  stores.governance.seedLedger({
    workspaceId: tenant.workspaceId,
    agentId: agentUuid,
    day: TODAY,
    spendCommittedUsd: tenant.label === 'A' ? '4.000000' : '19.000000',
    publishCountCommitted: tenant.label === 'A' ? 1 : 3,
  });
  tenant.receiptId = stores.governance.seedReceipt({
    workspaceId: tenant.workspaceId,
    agentId: agentUuid,
    actionId: SHARED.actionId,
    category: 'spend',
    decision: 'deny',
    denyReason: 'daily_spend_cap_exceeded',
    createdAt: START,
  });
  tenant.blockId = stores.governance.seedBlock({
    workspaceId: tenant.workspaceId,
    agentId: agentUuid,
    source: 'plane',
    category: 'spend',
    rule: 'daily_spend_cap',
    reason: `${tenant.name} daily spend cap reached.`,
    createdAt: START,
  });

  stores.eventReads.seedAgent({
    workspaceId: tenant.workspaceId,
    externalId: SHARED.agentExternalId,
    displayName: `${tenant.name} first agent`,
  });
  const timelineRow = stores.eventReads.seedEvent({
    workspaceId: tenant.workspaceId,
    eventId: SHARED.eventId,
    agentExternalId: SHARED.agentExternalId,
    type: 'heartbeat',
    receivedAt: START,
    payload: { secret: `${tenant.name} private payload` },
  });
  tenant.eventUuid = timelineRow.id;

  // Policy state for the machine poll route and the operator mutation route.
  stores.policy.seedPolicyState(tenant.workspaceId, tenant.label === 'A' ? '1' : '7');
  stores.policy.seedAgent(tenant.workspaceId, SHARED.agentExternalId);
  stores.policy.seedExplicitPolicy({
    workspaceId: tenant.workspaceId,
    externalId: SHARED.agentExternalId,
    mode: 'budgeted',
    dailySpendCapUsd: tenant.label === 'A' ? '25.000000' : '99.000000',
    dailyPublishCap: tenant.label === 'A' ? 5 : 50,
  });
  stores.policyMutation.seedPolicyState(tenant.workspaceId, tenant.label === 'A' ? '1' : '7');
  stores.policyMutation.seedAgent(tenant.workspaceId, agentUuid, SHARED.agentExternalId);

  // Precheck state, so a decision can actually be taken in this workspace.
  stores.precheck.seedPolicyState(tenant.workspaceId, tenant.label === 'A' ? '1' : '7');
  stores.precheck.seedPolicy({
    workspaceId: tenant.workspaceId,
    agentExternalId: SHARED.agentExternalId,
    mode: 'budgeted',
    dailySpendCapUsd: tenant.label === 'A' ? '25.000000' : '99.000000',
    dailyPublishCap: tenant.label === 'A' ? 5 : 50,
  });

  // A share link and a public demo, both issued through the real operator
  // routes so the authority chain is genuine.
  const shareResponse = await world.session(
    tenant,
    'POST',
    workspaceShareLinksPath(tenant.workspaceId),
    {},
  );
  const shareBody = (await shareResponse.json()) as {
    shareLink: { id: string };
    token: string;
  };
  // The plaintext lives at the TOP level, shown exactly once. The summary
  // carries only non-secret metadata.
  tenant.shareToken = shareBody.token;
  tenant.shareId = shareBody.shareLink.id;

  const demoResponse = await world.session(tenant, 'PUT', workspaceDemoPath(tenant.workspaceId), {
    enabled: true,
  });
  const demoBody = (await demoResponse.json()) as { demo: { slug: string } };
  tenant.demoSlug = demoBody.demo.slug;
}
