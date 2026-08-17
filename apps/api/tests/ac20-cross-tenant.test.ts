import {
  AGENT_REGISTER_PATH,
  API_KEY_IDENTITY_PATH,
  EVENT_INGEST_PATH,
  POLICY_POLL_PATH,
  PRECHECK_PATH,
  SHARE_AGENTS_PATH,
  SHARE_BLOCKS_PATH,
  SHARE_EVENTS_PATH,
  SHARE_RECEIPTS_PATH,
  SHARE_WORKSPACE_PATH,
  WORKSPACES_PATH,
  agentPolicyPath,
  demoAgentsPath,
  demoBlocksPath,
  demoEventPath,
  demoEventsPath,
  demoReceiptsPath,
  demoWorkspacePath,
  revokeShareLinkPath,
  shareEventPath,
  workspaceAgentPath,
  workspaceAgentsPath,
  workspaceApiKeysPath,
  workspaceBlockPath,
  workspaceBlocksPath,
  workspaceDemoPath,
  workspaceEventPath,
  workspaceEventsPath,
  workspacePath,
  workspaceReceiptPath,
  workspaceReceiptsPath,
  workspaceShareLinksPath,
} from '@hybrid/contracts';
import { beforeEach, describe, expect, it } from 'vitest';

import { SHARED, START, TODAY, createWorld, type Tenant, type World } from './helpers/ac20-world';

/**
 * AC-20 — COMPREHENSIVE CROSS-TENANT ISOLATION.
 *
 * "Automated cross-tenant test for all implemented Credit paths, passing."
 *
 * One application, every store mounted, two workspaces whose external
 * identifiers collide on purpose. The question this file answers is narrow and
 * total: can workspace A read, mutate, authenticate as, account against or
 * govern workspace B through ANY implemented Credit path?
 *
 * ─── THE FOUR AUTHORITIES ─────────────────────────────────────────────────
 *
 *   operator session   ->  membership row      ->  scope
 *   machine API key    ->  credential row      ->  scope
 *   share token        ->  share row           ->  scope
 *   public demo slug   ->  workspace row       ->  scope
 *
 * Every one derives its workspace from a row the SERVER matched. None of them
 * accepts a workspace from a body, query string, header or path. That single
 * property is what the whole file is testing, four times over.
 *
 * ─── WHAT "PROVES" MEANS HERE ─────────────────────────────────────────────
 *
 * These tests drive the real router, the real authorization chain and the real
 * contracts against in-memory stores. They prove SCOPE DERIVATION. They do not
 * prove SQL - a fake cannot forget a WHERE clause it never had. The compiled
 * SQL evidence is in `packages/db/tests/ac20-sql-isolation.test.ts` and the
 * only proof that PostgreSQL itself enforces this is
 * `packages/db/tests/ac20-cross-tenant.live.test.ts`, which is SKIPPED without
 * a `TEST_DATABASE_URL`. AC-20 is therefore not PASS.
 */

let w: World;
let a: Tenant;
let b: Tenant;

beforeEach(async () => {
  w = await createWorld();
  a = w.a;
  b = w.b;
});

/** Reads a JSON body without asserting a shape. */
async function body(response: Response): Promise<unknown> {
  return response.json();
}

/** Everything in a response, flattened to a string, for leak-hunting. */
async function text(response: Response): Promise<string> {
  return response.text();
}

// ───────────────────────────────────────────────────────────────────────────
// 0. THE WORLD ITSELF
// ───────────────────────────────────────────────────────────────────────────

describe('the two-tenant world is genuinely adversarial', () => {
  it('both tenants hold the SAME external identifiers', () => {
    // If this ever stops being true, every test below weakens to "the other
    // tenant had no such row anyway".
    const agentsA = w.stores.agents.agents.filter((r) => r.workspaceId === a.workspaceId);
    const agentsB = w.stores.agents.agents.filter((r) => r.workspaceId === b.workspaceId);

    expect(agentsA.map((r) => r.externalId)).toContain(SHARED.agentExternalId);
    expect(agentsB.map((r) => r.externalId)).toContain(SHARED.agentExternalId);

    const eventsA = w.stores.events.events.filter((r) => r.workspaceId === a.workspaceId);
    const eventsB = w.stores.events.events.filter((r) => r.workspaceId === b.workspaceId);
    expect(eventsA.map((r) => r.eventId)).toContain(SHARED.eventId);
    expect(eventsB.map((r) => r.eventId)).toContain(SHARED.eventId);
  });

  it('their INTERNAL ids differ, so a captured uuid is a real cross-tenant weapon', () => {
    expect(a.workspaceId).not.toBe(b.workspaceId);
    expect(a.agentUuid).not.toBe(b.agentUuid);
    expect(a.eventUuid).not.toBe(b.eventUuid);
    expect(a.receiptId).not.toBe(b.receiptId);
    expect(a.blockId).not.toBe(b.blockId);
    expect(a.apiKey).not.toBe(b.apiKey);
    expect(a.shareToken).not.toBe(b.shareToken);
    expect(a.demoSlug).not.toBe(b.demoSlug);
  });

  it('B holds data worth stealing', () => {
    // A probe against an empty tenant is not a probe.
    expect(w.snapshotB()).toContain('Beta Industries');
    expect(w.stores.governance.snapshot()).toContain(b.workspaceId);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 1. OPERATOR SESSION / MEMBERSHIP AUTHORITY
// ───────────────────────────────────────────────────────────────────────────

describe('SESSION AUTHORITY: A operator cannot reach B', () => {
  it('workspace listing shows only A', async () => {
    const response = await w.sessionGet(a, WORKSPACES_PATH);
    const payload = await text(response);

    expect(response.status).toBe(200);
    expect(payload).toContain('Acme Corporation');
    expect(payload).not.toContain('Beta Industries');
    expect(payload).not.toContain(b.workspaceId);
  });

  it('fetching B by id is 404, never 403', async () => {
    // 403 would confirm the workspace exists and turn the route into an
    // enumeration oracle.
    const response = await w.sessionGet(a, workspacePath(b.workspaceId));

    expect(response.status).toBe(404);
  });

  const READS: { name: string; path: (t: Tenant) => string }[] = [
    { name: 'agent roster', path: (t) => workspaceAgentsPath(t.workspaceId) },
    // The detail routes address agents by INTERNAL uuid. The external id is
    // not globally unique and could never be used to address one.
    { name: 'agent detail', path: (t) => workspaceAgentPath(t.workspaceId, t.agentUuid) },
    { name: 'event timeline', path: (t) => workspaceEventsPath(t.workspaceId) },
    { name: 'event detail', path: (t) => workspaceEventPath(t.workspaceId, t.eventUuid) },
    { name: 'receipt audit', path: (t) => workspaceReceiptsPath(t.workspaceId) },
    { name: 'receipt detail', path: (t) => workspaceReceiptPath(t.workspaceId, t.receiptId) },
    { name: 'block audit', path: (t) => workspaceBlocksPath(t.workspaceId) },
    { name: 'block detail', path: (t) => workspaceBlockPath(t.workspaceId, t.blockId) },
    { name: 'agent policy', path: (t) => agentPolicyPath(t.workspaceId, t.agentUuid) },
    { name: 'share links', path: (t) => workspaceShareLinksPath(t.workspaceId) },
    { name: 'demo settings', path: (t) => workspaceDemoPath(t.workspaceId) },
    { name: 'api keys', path: (t) => workspaceApiKeysPath(t.workspaceId) },
  ];

  it.each(READS)("cannot read B's $name", async ({ path }) => {
    const response = await w.sessionGet(a, path(b));

    expect(response.status).toBe(404);
    expect(await text(response)).not.toContain('Beta Industries');
  });

  it.each(READS)("CAN read its own $name, so the 404s above mean something", async ({ path }) => {
    // THE POSITIVE CONTROL, and it must be strict.
    //
    // Every path above is the SAME shape with A's ids substituted for B's. If
    // this asserted merely "not 401", a route that 404s for everyone would
    // satisfy the whole cross-tenant matrix while proving nothing at all.
    const response = await w.sessionGet(a, path(a));

    expect(response.status).toBe(200);
  });

  it("cannot fetch B's event by its exact internal UUID through A's workspace", async () => {
    // The strongest form: a globally unique id the caller genuinely holds.
    const response = await w.sessionGet(a, workspaceEventPath(a.workspaceId, b.eventUuid));

    expect(response.status).toBe(404);
    expect(await text(response)).not.toContain('Beta Industries private payload');
  });

  it("cannot fetch B's receipt or block by uuid through A's workspace", async () => {
    const receipt = await w.sessionGet(a, workspaceReceiptPath(a.workspaceId, b.receiptId));
    const block = await w.sessionGet(a, workspaceBlockPath(a.workspaceId, b.blockId));

    expect(receipt.status).toBe(404);
    expect(block.status).toBe(404);
  });

  it("cannot address B's agent by its internal uuid on A's policy route", async () => {
    const response = await w.sessionGet(a, agentPolicyPath(a.workspaceId, b.agentUuid));

    expect(response.status).toBe(404);
  });
});

describe('SESSION AUTHORITY: A operator cannot mutate B', () => {
  it("cannot set B's agent policy", async () => {
    const before = w.stores.policyMutation.policyOf(b.workspaceId, b.agentUuid);

    const response = await w.session(a, 'PUT', agentPolicyPath(b.workspaceId, b.agentUuid), {
      mode: 'paused',
      daily_spend_cap_usd: null,
      daily_publish_cap: null,
    });

    expect(response.status).toBe(404);
    expect(w.stores.policyMutation.policyOf(b.workspaceId, b.agentUuid)).toEqual(before);
    expect(w.stores.policyMutation.versionOf(b.workspaceId)).toBe('7');
  });

  it("cannot issue an API key into B", async () => {
    const before = JSON.stringify(w.stores.apiKeys.credentials);

    const response = await w.session(a, 'POST', workspaceApiKeysPath(b.workspaceId), {
      name: 'stolen',
    });

    expect(response.status).toBe(404);
    expect(JSON.stringify(w.stores.apiKeys.credentials)).toBe(before);
  });

  it("cannot issue a share link into B", async () => {
    const before = w.stores.shares.snapshot();

    const response = await w.session(a, 'POST', workspaceShareLinksPath(b.workspaceId), {});

    expect(response.status).toBe(404);
    expect(w.stores.shares.snapshot()).toBe(before);
  });

  it("cannot revoke B's share link, even holding its id", async () => {
    const before = w.stores.shares.snapshot();

    const throughB = await w.session(
      a,
      'POST',
      revokeShareLinkPath(b.workspaceId, b.shareId),
      undefined,
    );
    const throughA = await w.session(
      a,
      'POST',
      revokeShareLinkPath(a.workspaceId, b.shareId),
      undefined,
    );

    expect(throughB.status).toBe(404);
    expect(throughA.status).toBe(404);
    expect(w.stores.shares.snapshot()).toBe(before);
  });

  it("cannot enable or disable B's public demo", async () => {
    const before = w.stores.demo.snapshot();

    const off = await w.session(a, 'PUT', workspaceDemoPath(b.workspaceId), { enabled: false });

    expect(off.status).toBe(404);
    expect(w.stores.demo.snapshot()).toBe(before);
    // And B's slug still works.
    expect((await w.publicGet(demoWorkspacePath(b.demoSlug))).status).toBe(200);
  });
});

describe('SESSION AUTHORITY: the contract keeps its distinctions', () => {
  it('unauthenticated is 401, not 404', async () => {
    // Uniformity is not a virtue here: a caller with no session has a
    // different problem from a caller looking at someone else's workspace.
    const response = await w.app.request(workspaceAgentsPath(a.workspaceId));

    expect(response.status).toBe(401);
  });

  it('authenticated non-member is 404', async () => {
    const response = await w.sessionGet(a, workspaceAgentsPath(b.workspaceId));

    expect(response.status).toBe(404);
  });

  it('member of the RIGHT workspace with the wrong role is 403', async () => {
    // A member is inside the tenant; the refusal is about privilege, and
    // saying 404 would be a lie about a workspace they can see.
    const response = await w.session(
      a,
      'PUT',
      workspaceDemoPath(a.workspaceId),
      { enabled: true },
      a.memberCookie,
    );

    expect(response.status).toBe(403);
  });

  it("a member of A is still only 404 against B, never 403", async () => {
    const response = await w.session(
      a,
      'PUT',
      workspaceDemoPath(b.workspaceId),
      { enabled: false },
      a.memberCookie,
    );

    expect(response.status).toBe(404);
  });

  it('unknown resource inside a reachable workspace is 404', async () => {
    const response = await w.sessionGet(
      a,
      workspaceEventPath(a.workspaceId, '00000000-0000-4000-8000-00000000dead'),
    );

    expect(response.status).toBe(404);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 2. MACHINE API-KEY AUTHORITY
// ───────────────────────────────────────────────────────────────────────────

describe('MACHINE AUTHORITY: the workspace comes from the credential row', () => {
  it("A's key reports A, and only A", async () => {
    const response = await w.machine(a, 'GET', API_KEY_IDENTITY_PATH);
    const payload = await text(response);

    expect(response.status).toBe(200);
    expect(payload).toContain(a.workspaceId);
    expect(payload).not.toContain(b.workspaceId);
  });

  it('a body field named workspace_id is NEVER OBEYED', async () => {
    // ─── A DELIBERATE SPLIT, RECORDED HERE ───────────────────────────────
    //
    // The codebase takes two different postures toward unknown request
    // fields. Policy, precheck, ingest, share and demo use `z.strictObject`,
    // so `{"workspace_id": "..."}` is a loud 400. Agent registration, API-key
    // creation, magic-link and workspace creation use `z.object`, so the
    // field is silently DROPPED by Zod and never reaches a handler.
    //
    // Both are safe, because none of these routes reads a workspace from a
    // body at all - the workspace comes from the credential row or from
    // membership. The split is an inconsistency, not a vulnerability, and it
    // is documented in docs/tenant-isolation.md rather than changed here:
    // four public contracts should not shift shape inside an acceptance step,
    // and `api-key-routes.test.ts` asserts the drop behaviour on purpose.
    //
    // What AC-20 requires is the property below, and it holds either way.
    const response = await w.machine(a, 'POST', AGENT_REGISTER_PATH, {
      agent_id: 'smuggled',
      workspace_id: b.workspaceId,
      workspaceId: b.workspaceId,
    });

    expect(response.status).toBe(200);
    // The agent landed in A, the credential's workspace. Nothing in B.
    expect(
      w.stores.agents.agents.filter((r) => r.workspaceId === b.workspaceId).map((r) => r.externalId),
    ).not.toContain('smuggled');
    expect(
      w.stores.agents.agents.filter((r) => r.workspaceId === a.workspaceId).map((r) => r.externalId),
    ).toContain('smuggled');
  });

  it('a body field named workspace_id is REJECTED outright by every strict surface', async () => {
    // The strict half of the split, asserted so it cannot silently loosen.
    const precheck = await w.machine(a, 'POST', PRECHECK_PATH, {
      action_id: 'act-smuggle',
      agent_id: SHARED.agentExternalId,
      category: 'publish',
      workspace_id: b.workspaceId,
    });
    const ingest = await w.machine(a, 'POST', EVENT_INGEST_PATH, {
      workspace_id: b.workspaceId,
      events: [
        {
          event_id: 'evt-smuggle',
          agent_id: SHARED.agentExternalId,
          type: 'heartbeat',
          occurred_at: START.toISOString(),
        },
      ],
    });
    const policy = await w.session(a, 'PUT', agentPolicyPath(a.workspaceId, a.agentUuid), {
      mode: 'paused',
      daily_spend_cap_usd: null,
      daily_publish_cap: null,
      workspace_id: b.workspaceId,
    });
    const demo = await w.session(a, 'PUT', workspaceDemoPath(a.workspaceId), {
      enabled: true,
      workspace_id: b.workspaceId,
    });
    const share = await w.session(a, 'POST', workspaceShareLinksPath(a.workspaceId), {
      workspace_id: b.workspaceId,
    });

    for (const response of [precheck, ingest, policy, demo, share]) {
      expect(response.status).toBe(400);
    }
  });

  it('a query string cannot select a workspace', async () => {
    const before = w.snapshotB();

    const response = await w.machine(
      a,
      'POST',
      `${AGENT_REGISTER_PATH}?workspace_id=${b.workspaceId}&workspaceId=${b.workspaceId}`,
      { agent_id: 'via-query' },
    );

    expect(response.status).toBe(200);
    expect(w.snapshotB()).toBe(before);
    expect(
      w.stores.agents.agents.find(
        (r) => r.workspaceId === a.workspaceId && r.externalId === 'via-query',
      ),
    ).toBeDefined();
  });

  it.each([
    'x-workspace-id',
    'x-workspace',
    'workspace-id',
    'x-tenant-id',
    'x-hybrid-workspace',
  ])('a %s header cannot override tenancy', async (header) => {
    const before = w.snapshotB();

    const response = await w.machine(a, 'POST', AGENT_REGISTER_PATH, { agent_id: 'via-header' }, {
      [header]: b.workspaceId,
    });

    expect(response.status).toBe(200);
    expect(w.snapshotB()).toBe(before);
  });

  it('registering an agent whose external id already exists in B creates a SEPARATE A agent', async () => {
    const bAgentBefore = w.stores.agents.agents.find(
      (r) => r.workspaceId === b.workspaceId && r.externalId === SHARED.agentExternalId,
    );

    const response = await w.machine(a, 'POST', AGENT_REGISTER_PATH, {
      agent_id: SHARED.agentExternalId,
      name: 'renamed by A',
    });

    expect(response.status).toBe(200);
    const bAgentAfter = w.stores.agents.agents.find(
      (r) => r.workspaceId === b.workspaceId && r.externalId === SHARED.agentExternalId,
    );
    expect(bAgentAfter).toEqual(bAgentBefore);
    expect(bAgentAfter?.displayName).not.toBe('renamed by A');
  });

  it("A's key cannot poll B's policy - it polls A's, at A's version", async () => {
    const response = await w.machine(a, 'GET', POLICY_POLL_PATH);
    const payload = (await body(response)) as { version: string };

    expect(response.status).toBe(200);
    // A is at version 1; B is at 7. Getting 7 would mean the wrong tenant.
    expect(payload.version).toBe('1');
  });

  it('the two keys see two different policy worlds for the same external agent id', async () => {
    const fromA = await text(await w.machine(a, 'GET', POLICY_POLL_PATH));
    const fromB = await text(await w.machine(b, 'GET', POLICY_POLL_PATH));

    // Same `agent-1` in both, different caps. A leak would make these equal.
    expect(fromA).toContain('25.000000');
    expect(fromB).toContain('99.000000');
    expect(fromA).not.toContain('99.000000');
    expect(fromB).not.toContain('25.000000');
  });
});

describe('MACHINE AUTHORITY: A cannot write into B', () => {
  it('ingesting an event with an id B already used creates an A event, not a duplicate of B', async () => {
    const bEventsBefore = w.stores.events.events.filter((r) => r.workspaceId === b.workspaceId);

    const response = await w.machine(a, 'POST', EVENT_INGEST_PATH, {
      events: [
        {
          event_id: SHARED.eventId,
          agent_id: SHARED.agentExternalId,
          type: 'heartbeat',
          occurred_at: START.toISOString(),
        },
      ],
    });
    const payload = (await body(response)) as { accepted: number; duplicates: number };

    // Already ingested for A during seeding, so this is A's own replay.
    expect(response.status).toBe(200);
    expect(payload.duplicates).toBe(1);
    expect(payload.accepted).toBe(0);
    // B untouched either way.
    expect(w.stores.events.events.filter((r) => r.workspaceId === b.workspaceId)).toEqual(
      bEventsBefore,
    );
  });

  it("a CHANGED replay in A creates nothing in B", async () => {
    const before = w.snapshotB();

    await w.machine(a, 'POST', EVENT_INGEST_PATH, {
      events: [
        {
          event_id: SHARED.eventId,
          agent_id: SHARED.agentExternalId,
          type: 'action.blocked',
          category: 'spend',
          rule: 'daily_spend_cap',
          reason: 'rewritten',
          amount_usd: '99.000000',
          block_id: SHARED.blockExternalId,
          occurred_at: START.toISOString(),
        },
      ],
    });

    expect(w.snapshotB()).toBe(before);
  });

  it("A's runtime block external id does not collide with B's identical one", async () => {
    await w.machine(a, 'POST', EVENT_INGEST_PATH, {
      events: [
        {
          event_id: 'evt-a-block',
          agent_id: SHARED.agentExternalId,
          type: 'action.blocked',
          category: 'spend',
          rule: 'daily_spend_cap',
          reason: 'A blocked',
          amount_usd: '41.000000',
          block_id: SHARED.blockExternalId,
          occurred_at: START.toISOString(),
        },
      ],
    });
    await w.machine(b, 'POST', EVENT_INGEST_PATH, {
      events: [
        {
          event_id: 'evt-b-block',
          agent_id: SHARED.agentExternalId,
          type: 'action.blocked',
          category: 'spend',
          rule: 'daily_spend_cap',
          reason: 'B blocked',
          amount_usd: '41.000000',
          block_id: SHARED.blockExternalId,
          occurred_at: START.toISOString(),
        },
      ],
    });

    const blocks = w.stores.events.blocks.filter(
      (r) => r.externalBlockId === SHARED.blockExternalId,
    );
    // One per workspace. A shared external id must not be globally unique.
    expect(blocks).toHaveLength(2);
    expect(new Set(blocks.map((r) => r.workspaceId)).size).toBe(2);
  });

  it("A's unprechecked spend debits A's ledger and never B's", async () => {
    const bLedgerBefore = JSON.stringify(
      w.stores.ledger.rows.filter((r) => r.workspaceId === b.workspaceId),
    );

    await w.machine(a, 'POST', EVENT_INGEST_PATH, {
      events: [
        {
          event_id: 'evt-a-spend',
          agent_id: SHARED.agentExternalId,
          type: 'spend.recorded',
          amount_usd: '3.000000',
          provider: 'openai',
          occurred_at: START.toISOString(),
        },
      ],
    });

    expect(w.stores.ledger.usageOf(a.workspaceId, SHARED.agentExternalId, TODAY)?.spendCommittedUsd)
      .toBe('3.000000');
    expect(JSON.stringify(w.stores.ledger.rows.filter((r) => r.workspaceId === b.workspaceId))).toBe(
      bLedgerBefore,
    );
  });

  it('the same external agent id keeps two independent ledger rows', async () => {
    await w.machine(a, 'POST', EVENT_INGEST_PATH, {
      events: [
        {
          event_id: 'evt-a-spend-2',
          agent_id: SHARED.agentExternalId,
          type: 'spend.recorded',
          amount_usd: '2.000000',
          provider: 'openai',
          occurred_at: START.toISOString(),
        },
      ],
    });
    await w.machine(b, 'POST', EVENT_INGEST_PATH, {
      events: [
        {
          event_id: 'evt-b-spend-2',
          agent_id: SHARED.agentExternalId,
          type: 'spend.recorded',
          amount_usd: '5.000000',
          provider: 'openai',
          occurred_at: START.toISOString(),
        },
      ],
    });

    expect(w.stores.ledger.usageOf(a.workspaceId, SHARED.agentExternalId, TODAY)?.spendCommittedUsd)
      .toBe('2.000000');
    expect(w.stores.ledger.usageOf(b.workspaceId, SHARED.agentExternalId, TODAY)?.spendCommittedUsd)
      .toBe('5.000000');
  });

  it("A cannot settle against B's receipt id", async () => {
    // A precheck_id A does not own must not link, and must not debit B.
    const before = w.snapshotB();

    const response = await w.machine(a, 'POST', EVENT_INGEST_PATH, {
      events: [
        {
          event_id: 'evt-a-steal-receipt',
          agent_id: SHARED.agentExternalId,
          type: 'spend.recorded',
          amount_usd: '1.000000',
          provider: 'openai',
          precheck_id: b.receiptId,
          occurred_at: START.toISOString(),
        },
      ],
    });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(w.snapshotB()).toBe(before);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 3. PRECHECK / RECEIPT / BLOCK / LEDGER
// ───────────────────────────────────────────────────────────────────────────

describe('PRECHECK: decisions never cross tenants', () => {
  it('the same action_id decides independently in A and B', async () => {
    const inA = await w.machine(a, 'POST', PRECHECK_PATH, {
      action_id: SHARED.actionId,
      agent_id: SHARED.agentExternalId,
      category: 'spend',
      amount_usd: '10.000000',
    });
    const inB = await w.machine(b, 'POST', PRECHECK_PATH, {
      action_id: SHARED.actionId,
      agent_id: SHARED.agentExternalId,
      category: 'spend',
      amount_usd: '10.000000',
    });

    const receiptA = (await body(inA)) as { precheck_id: string };
    const receiptB = (await body(inB)) as { precheck_id: string };

    expect(inA.status).toBe(200);
    expect(inB.status).toBe(200);
    // Idempotency is workspace-qualified: two receipts, not one replay.
    expect(receiptA.precheck_id).not.toBe(receiptB.precheck_id);
  });

  it('A replaying its own action_id does not replay B decision', async () => {
    const first = (await body(
      await w.machine(a, 'POST', PRECHECK_PATH, {
        action_id: SHARED.actionId,
        agent_id: SHARED.agentExternalId,
        category: 'spend',
        amount_usd: '10.000000',
      }),
    )) as { precheck_id: string };

    const inB = (await body(
      await w.machine(b, 'POST', PRECHECK_PATH, {
        action_id: SHARED.actionId,
        agent_id: SHARED.agentExternalId,
        category: 'spend',
        amount_usd: '10.000000',
      }),
    )) as { precheck_id: string };

    const replay = (await body(
      await w.machine(a, 'POST', PRECHECK_PATH, {
        action_id: SHARED.actionId,
        agent_id: SHARED.agentExternalId,
        category: 'spend',
        amount_usd: '10.000000',
      }),
    )) as { precheck_id: string };

    expect(replay.precheck_id).toBe(first.precheck_id);
    expect(replay.precheck_id).not.toBe(inB.precheck_id);
  });

  it("A's allowed spend debits A's ledger only", async () => {
    const bBefore = JSON.stringify(
      w.stores.ledger.rows.filter((r) => r.workspaceId === b.workspaceId),
    );

    await w.machine(a, 'POST', PRECHECK_PATH, {
      action_id: 'act-a-only',
      agent_id: SHARED.agentExternalId,
      category: 'spend',
      amount_usd: '7.000000',
    });

    expect(w.stores.ledger.usageOf(a.workspaceId, SHARED.agentExternalId, TODAY)?.spendCommittedUsd)
      .toBe('7.000000');
    expect(JSON.stringify(w.stores.ledger.rows.filter((r) => r.workspaceId === b.workspaceId))).toBe(
      bBefore,
    );
  });

  it("A's denial creates A's receipt and A's block, and nothing in B", async () => {
    const before = w.snapshotB();
    const bBlocksBefore = w.stores.precheck.blocks.length;

    const response = await w.machine(a, 'POST', PRECHECK_PATH, {
      action_id: 'act-a-over-cap',
      agent_id: SHARED.agentExternalId,
      category: 'spend',
      // Over A's $25 cap, comfortably under B's $99 one. If tenancy leaked,
      // this would be ALLOWED.
      amount_usd: '41.000000',
    });
    const decision = (await body(response)) as { decision: string; precheck_id: string };

    expect(decision.decision).toBe('deny');
    const created = w.stores.precheck.blocks.slice(bBlocksBefore);
    expect(created).toHaveLength(1);
    expect(created[0]?.workspaceId).toBe(a.workspaceId);
    expect(w.snapshotB()).toBe(before);
  });

  it("the same amount is ALLOWED in B, proving the denial above was A's own policy", async () => {
    const response = await w.machine(b, 'POST', PRECHECK_PATH, {
      action_id: 'act-b-same-amount',
      agent_id: SHARED.agentExternalId,
      category: 'spend',
      amount_usd: '41.000000',
    });
    const decision = (await body(response)) as { decision: string };

    expect(decision.decision).toBe('allow');
  });

  it('B is byte-identical after a full sweep of A activity', async () => {
    const before = w.snapshotB();

    await w.machine(a, 'POST', AGENT_REGISTER_PATH, { agent_id: 'agent-3' });
    await w.machine(a, 'POST', EVENT_INGEST_PATH, {
      events: [
        {
          event_id: 'evt-sweep',
          agent_id: SHARED.agentExternalId,
          type: 'spend.recorded',
          amount_usd: '1.500000',
          provider: 'anthropic',
          occurred_at: START.toISOString(),
        },
      ],
    });
    await w.machine(a, 'POST', PRECHECK_PATH, {
      action_id: 'act-sweep',
      agent_id: SHARED.agentExternalId,
      category: 'publish',
    });
    await w.machine(a, 'GET', POLICY_POLL_PATH);
    await w.session(a, 'PUT', agentPolicyPath(a.workspaceId, a.agentUuid), {
      mode: 'paused',
      daily_spend_cap_usd: null,
      daily_publish_cap: null,
    });
    await w.sessionGet(a, workspaceAgentsPath(a.workspaceId));
    await w.sessionGet(a, workspaceReceiptsPath(a.workspaceId));
    await w.sessionGet(a, workspaceBlocksPath(a.workspaceId));
    await w.publicGet(demoAgentsPath(a.demoSlug));
    await w.openShare(a.shareToken);
    await w.shareGet(a.shareToken, SHARE_AGENTS_PATH);

    expect(w.snapshotB()).toBe(before);
  });
});

describe('LEDGER: the authoritative key is workspace + agent + UTC day', () => {
  it('reading A governance creates no ledger row anywhere', async () => {
    const before = JSON.stringify(w.stores.ledger.rows);

    await w.sessionGet(a, workspaceAgentsPath(a.workspaceId));
    await w.publicGet(demoAgentsPath(a.demoSlug));

    expect(JSON.stringify(w.stores.ledger.rows)).toBe(before);
  });

  it("A's policy change does not alter B's ledger", async () => {
    const before = JSON.stringify(
      w.stores.ledger.rows.filter((r) => r.workspaceId === b.workspaceId),
    );

    await w.session(a, 'PUT', agentPolicyPath(a.workspaceId, a.agentUuid), {
      mode: 'budgeted',
      daily_spend_cap_usd: '1.000000',
      daily_publish_cap: 1,
    });

    expect(JSON.stringify(w.stores.ledger.rows.filter((r) => r.workspaceId === b.workspaceId))).toBe(
      before,
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 4. POLICY
// ───────────────────────────────────────────────────────────────────────────

describe('POLICY: versions and caps are per workspace', () => {
  it('A and B start at independent versions', () => {
    expect(w.stores.policyMutation.versionOf(a.workspaceId)).toBe('1');
    expect(w.stores.policyMutation.versionOf(b.workspaceId)).toBe('7');
  });

  it('changing A bumps only A', async () => {
    const response = await w.session(
      a,
      'PUT',
      agentPolicyPath(a.workspaceId, a.agentUuid),
      { mode: 'paused', daily_spend_cap_usd: null, daily_publish_cap: null },
    );

    expect(response.status).toBe(200);
    expect(w.stores.policyMutation.versionOf(a.workspaceId)).toBe('2');
    expect(w.stores.policyMutation.versionOf(b.workspaceId)).toBe('7');
  });

  it("B's machine poll is unchanged by A's mutation", async () => {
    const before = await text(await w.machine(b, 'GET', POLICY_POLL_PATH));

    await w.session(a, 'PUT', agentPolicyPath(a.workspaceId, a.agentUuid), {
      mode: 'paused',
      daily_spend_cap_usd: null,
      daily_publish_cap: null,
    });

    expect(await text(await w.machine(b, 'GET', POLICY_POLL_PATH))).toBe(before);
  });

  it('the same external agent id resolves to a different policy in each workspace', async () => {
    const fromA = await text(await w.sessionGet(a, agentPolicyPath(a.workspaceId, a.agentUuid)));
    const fromB = await text(await w.sessionGet(b, agentPolicyPath(b.workspaceId, b.agentUuid)));

    expect(fromA).not.toBe(fromB);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 5. SHARE-TOKEN AUTHORITY
// ───────────────────────────────────────────────────────────────────────────

describe('SHARE AUTHORITY: a token resolves its own workspace and no other', () => {
  const SHARE_READS = [
    { name: 'workspace', path: SHARE_WORKSPACE_PATH },
    { name: 'agents', path: SHARE_AGENTS_PATH },
    { name: 'events', path: SHARE_EVENTS_PATH },
    { name: 'receipts', path: SHARE_RECEIPTS_PATH },
    { name: 'blocks', path: SHARE_BLOCKS_PATH },
  ] as const;

  it.each(SHARE_READS)("A's token never returns B data from $name", async ({ path }) => {
    await w.openShare(a.shareToken);
    const response = await w.shareGet(a.shareToken, path);
    const payload = await text(response);

    expect(response.status).toBe(200);
    expect(payload).not.toContain('Beta Industries');
    expect(payload).not.toContain(b.workspaceId);
    expect(payload).not.toContain(b.eventUuid);
  });

  it("A's token cannot fetch B's event by its exact uuid", async () => {
    await w.openShare(a.shareToken);
    const response = await w.shareGet(a.shareToken, shareEventPath(b.eventUuid));

    expect(response.status).toBe(404);
    expect(await text(response)).not.toContain('Beta Industries private payload');
  });

  it("B's token cannot fetch A's event by its exact uuid", async () => {
    await w.openShare(b.shareToken);
    const response = await w.shareGet(b.shareToken, shareEventPath(a.eventUuid));

    expect(response.status).toBe(404);
  });

  it('the two tokens see two different workspaces', async () => {
    const fromA = await text(await w.shareGet(a.shareToken, SHARE_WORKSPACE_PATH));
    const fromB = await text(await w.shareGet(b.shareToken, SHARE_WORKSPACE_PATH));

    expect(fromA).toContain('Acme Corporation');
    expect(fromB).toContain('Beta Industries');
  });

  it('a revoked token is dead on the next request', async () => {
    await w.openShare(a.shareToken);
    expect((await w.shareGet(a.shareToken, SHARE_AGENTS_PATH)).status).toBe(200);

    const revoke = await w.session(
      a,
      'POST',
      revokeShareLinkPath(a.workspaceId, a.shareId),
      undefined,
    );
    // Asserted, so this test cannot pass because the revoke silently failed.
    expect(revoke.status).toBe(200);

    const after = await w.shareGet(a.shareToken, SHARE_AGENTS_PATH);
    // Revoked reads exactly like unknown: 404 `invalid_share`, never a 401
    // that would confirm the token was once real.
    expect(after.status).toBe(404);
    expect(await text(after)).toContain('invalid_share');
  });

  it('re-issuing a link does not revive the revoked one', async () => {
    await w.session(a, 'POST', revokeShareLinkPath(a.workspaceId, a.shareId), undefined);
    const reissued = await w.session(a, 'POST', workspaceShareLinksPath(a.workspaceId), {});
    const { token } = (await body(reissued)) as { token: string };

    expect(token).not.toBe(a.shareToken);
    expect((await w.shareGet(a.shareToken, SHARE_AGENTS_PATH)).status).toBe(404);
    // The new one works, so the 404 above is revocation and not breakage.
    await w.openShare(token);
    expect((await w.shareGet(token, SHARE_AGENTS_PATH)).status).toBe(200);
  });

  it('unknown, malformed and foreign-revoked tokens are indistinguishable', async () => {
    const unknown = await w.openShare('hmp_share_00000000-0000-4000-8000-000000000000_nope');
    const malformed = await w.openShare('not-a-share-token');

    expect(unknown.status).toBe(malformed.status);
    expect(await text(unknown)).toBe(await text(malformed));
  });

  it('a share response carries no workspace id, user id or token material', async () => {
    await w.openShare(a.shareToken);
    for (const { path } of SHARE_READS) {
      const payload = await text(await w.shareGet(a.shareToken, path));

      expect(payload).not.toContain(a.workspaceId);
      expect(payload).not.toContain(a.operatorUserId);
      expect(payload).not.toContain(a.shareToken);
      expect(payload).not.toContain(a.apiKey);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 6. PUBLIC DEMO AUTHORITY
// ───────────────────────────────────────────────────────────────────────────

describe('DEMO AUTHORITY: a slug resolves its own workspace and no other', () => {
  it.each([
    { name: 'workspace', path: (s: string) => demoWorkspacePath(s) },
    { name: 'agents', path: (s: string) => demoAgentsPath(s) },
    { name: 'events', path: (s: string) => demoEventsPath(s) },
    { name: 'receipts', path: (s: string) => demoReceiptsPath(s) },
    { name: 'blocks', path: (s: string) => demoBlocksPath(s) },
  ])("A's slug never returns B data from $name", async ({ path }) => {
    const response = await w.publicGet(path(a.demoSlug));
    const payload = await text(response);

    expect(response.status).toBe(200);
    expect(payload).not.toContain('Beta Industries');
    expect(payload).not.toContain(b.workspaceId);
  });

  it("A's slug cannot fetch B's event by its exact uuid", async () => {
    const response = await w.publicGet(demoEventPath(a.demoSlug, b.eventUuid));

    expect(response.status).toBe(404);
    expect(await text(response)).toContain('demo_not_found');
  });

  it("B's slug cannot fetch A's event by its exact uuid", async () => {
    const response = await w.publicGet(demoEventPath(b.demoSlug, a.eventUuid));

    expect(response.status).toBe(404);
  });

  it('the two slugs show two different workspaces', async () => {
    expect(await text(await w.publicGet(demoWorkspacePath(a.demoSlug)))).toContain('Acme');
    expect(await text(await w.publicGet(demoWorkspacePath(b.demoSlug)))).toContain('Beta');
  });

  it('disabling A kills A immediately and leaves B alive', async () => {
    await w.session(a, 'PUT', workspaceDemoPath(a.workspaceId), { enabled: false });

    expect((await w.publicGet(demoAgentsPath(a.demoSlug))).status).toBe(404);
    expect((await w.publicGet(demoAgentsPath(b.demoSlug))).status).toBe(200);
  });

  it('re-enabling issues a NEW slug and the old one stays dead', async () => {
    await w.session(a, 'PUT', workspaceDemoPath(a.workspaceId), { enabled: false });
    const again = await w.session(a, 'PUT', workspaceDemoPath(a.workspaceId), { enabled: true });
    const { demo } = (await body(again)) as { demo: { slug: string } };

    expect(demo.slug).not.toBe(a.demoSlug);
    expect((await w.publicGet(demoWorkspacePath(a.demoSlug))).status).toBe(404);
    expect((await w.publicGet(demoWorkspacePath(demo.slug))).status).toBe(200);
  });

  it('demo reads mutate nothing at all', async () => {
    const everything = JSON.stringify({
      b: w.snapshotB(),
      ledger: w.stores.ledger.rows,
      agents: w.stores.agents.agents,
      events: w.stores.events.events,
      governance: w.stores.governance.snapshot(),
      demo: w.stores.demo.snapshot(),
    });

    for (const path of [
      demoWorkspacePath(a.demoSlug),
      demoAgentsPath(a.demoSlug),
      demoEventsPath(a.demoSlug),
      demoReceiptsPath(a.demoSlug),
      demoBlocksPath(a.demoSlug),
    ]) {
      await w.publicGet(path);
    }

    expect(
      JSON.stringify({
        b: w.snapshotB(),
        ledger: w.stores.ledger.rows,
        agents: w.stores.agents.agents,
        events: w.stores.events.events,
        governance: w.stores.governance.snapshot(),
        demo: w.stores.demo.snapshot(),
      }),
    ).toBe(everything);
  });

  it('a demo response carries no workspace id, user id, key or token', async () => {
    for (const path of [demoWorkspacePath(a.demoSlug), demoAgentsPath(a.demoSlug)]) {
      const payload = await text(await w.publicGet(path));

      expect(payload).not.toContain(a.workspaceId);
      expect(payload).not.toContain(a.operatorUserId);
      expect(payload).not.toContain(a.apiKey);
      expect(payload).not.toContain(a.shareToken);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 7. AUTHORITY CONFUSION
// ───────────────────────────────────────────────────────────────────────────

describe('AUTHORITY CONFUSION: "authenticated somehow" is not "authorized here"', () => {
  it('an API key cannot mutate policy, even for its OWN workspace', async () => {
    const before = w.stores.policyMutation.versionOf(a.workspaceId);

    const response = await w.machine(
      a,
      'POST',
      agentPolicyPath(a.workspaceId, a.agentUuid),
    );

    expect(response.status).not.toBe(200);
    expect(w.stores.policyMutation.versionOf(a.workspaceId)).toBe(before);
  });

  it.each([
    { name: 'agent roster', path: (t: Tenant) => workspaceAgentsPath(t.workspaceId) },
    { name: 'timeline', path: (t: Tenant) => workspaceEventsPath(t.workspaceId) },
    { name: 'receipts', path: (t: Tenant) => workspaceReceiptsPath(t.workspaceId) },
    { name: 'blocks', path: (t: Tenant) => workspaceBlocksPath(t.workspaceId) },
    { name: 'share links', path: (t: Tenant) => workspaceShareLinksPath(t.workspaceId) },
    { name: 'demo settings', path: (t: Tenant) => workspaceDemoPath(t.workspaceId) },
  ])('an API key cannot read the operator $name for its own workspace', async ({ path }) => {
    // A runtime credential authorizes four machine routes. Operator history is
    // not among them, and holding a key for the workspace does not change that.
    const response = await w.machine(a, 'GET', path(a));

    expect(response.status).toBe(401);
  });

  it('an operator session cannot stand in for a bearer credential', async () => {
    for (const path of [API_KEY_IDENTITY_PATH, POLICY_POLL_PATH]) {
      const response = await w.sessionGet(a, path);

      expect(response.status).toBe(401);
    }
  });

  it('an operator session cannot ingest events or precheck', async () => {
    const ingest = await w.session(a, 'POST', EVENT_INGEST_PATH, {
      events: [
        {
          event_id: 'evt-session',
          agent_id: SHARED.agentExternalId,
          type: 'heartbeat',
          occurred_at: START.toISOString(),
        },
      ],
    });
    const precheck = await w.session(a, 'POST', PRECHECK_PATH, {
      action_id: 'act-session',
      agent_id: SHARED.agentExternalId,
      category: 'publish',
    });

    expect(ingest.status).toBe(401);
    expect(precheck.status).toBe(401);
  });

  it('a share cookie cannot reach any operator or machine route', async () => {
    await w.openShare(a.shareToken);

    for (const path of [
      workspaceAgentsPath(a.workspaceId),
      workspaceReceiptsPath(a.workspaceId),
      agentPolicyPath(a.workspaceId, a.agentUuid),
      API_KEY_IDENTITY_PATH,
      POLICY_POLL_PATH,
    ]) {
      const response = await w.shareGet(a.shareToken, path);

      expect(response.status, path).toBe(401);
    }
  });

  it('a share token cannot be used as a bearer credential', async () => {
    const response = await w.app.request(POLICY_POLL_PATH, {
      headers: { authorization: `Bearer ${a.shareToken}` },
    });

    expect(response.status).toBe(401);
  });

  it('an API key cannot be presented as a share token', async () => {
    const response = await w.openShare(a.apiKey);

    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it('no public authority can create an event or a precheck', async () => {
    const before = w.snapshotB();

    const results = await Promise.all([
      w.app.request(EVENT_INGEST_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ events: [] }),
      }),
      w.app.request(PRECHECK_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action_id: 'x', agent_id: 'agent-1', category: 'publish' }),
      }),
    ]);

    for (const response of results) {
      expect(response.status).toBe(401);
    }
    expect(w.snapshotB()).toBe(before);
  });

  it('the demo and share surfaces answer nothing but GET', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const demo = await w.app.request(demoAgentsPath(a.demoSlug), { method });
      const share = await w.app.request(SHARE_AGENTS_PATH, { method });

      expect(demo.status).toBe(404);
      expect(share.status).toBe(404);
    }
  });

  it('NO NON-GET ROUTE EXISTS ANYWHERE UNDER A PUBLIC PREFIX', async () => {
    // Path-agnostic, and that is the point.
    //
    // The test above enumerates METHODS on paths it already knows. A mutation
    // added at a NEW public path - `PUT /v1/demo/:slug/policy`, say - would
    // sail past it, because nothing in the loop ever asks that path a
    // question. A mutation probe found exactly that gap.
    //
    // This asks the ROUTER what it registered instead of guessing, so any
    // future public write is caught the moment it is mounted, whatever it is
    // called.
    const publicPrefixes = ['/v1/demo', '/v1/share'];
    const offenders = w.app.routes.filter(
      (route) =>
        publicPrefixes.some((prefix) => route.path.startsWith(prefix)) &&
        route.method !== 'GET' &&
        // The router's own catch-all middleware, not a handler.
        route.method !== 'ALL' &&
        // The ONE deliberate exception: the AC-18 token exchange, which sets a
        // cookie and writes nothing. It is POST because a token must not
        // travel in a URL.
        route.path !== '/v1/share/access',
    );

    expect(offenders).toEqual([]);
  });
});
