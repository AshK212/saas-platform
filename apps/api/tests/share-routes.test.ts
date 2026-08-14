import {
  AUTH_CALLBACK_PATH,
  AUTH_MAGIC_LINK_PATH,
  SHARE_ACCESS_PATH,
  SHARE_AGENTS_PATH,
  SHARE_BLOCKS_PATH,
  SHARE_EVENTS_PATH,
  SHARE_RECEIPTS_PATH,
  SHARE_WORKSPACE_PATH,
  revokeShareLinkPath,
  shareAgentListResponseSchema,
  shareEventDetailResponseSchema,
  shareEventListResponseSchema,
  shareLinkCreatedResponseSchema,
  shareLinkListResponseSchema,
  workspaceShareLinksPath,
} from '@hybrid/contracts';
import { randomUUID } from 'node:crypto';

import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { createFixedClock } from '../src/auth/clock';
import { AUTH_COOKIE_NAME } from '../src/auth/cookie';
import { createCapturingEmailSender, type CapturingEmailSender } from '../src/auth/email';
import { createAuthService } from '../src/auth/service';
import { SHARE_COOKIE_NAME } from '../src/share/cookie';
import { createMemoryAgentStore } from './helpers/memory-agent-store';
import { createMemoryApiKeyStore } from './helpers/memory-api-key-store';
import { createMemoryAuthStore, type MemoryAuthStore } from './helpers/memory-auth-store';
import {
  createMemoryEventReadStore,
  type MemoryEventReadStore,
} from './helpers/memory-event-read-store';
import {
  createMemoryGovernanceStore,
  type MemoryGovernanceStore,
} from './helpers/memory-governance-store';
import { createMemoryPolicyMutationStore } from './helpers/memory-policy-mutation-store';
import { createMemoryShareStore, type MemoryShareStore } from './helpers/memory-share-store';
import {
  createMemoryWorkspaceStore,
  type MemoryWorkspaceStore,
} from './helpers/memory-workspace-store';

/**
 * AC-18 - revocable read-only workspace sharing.
 *
 * Two surfaces exercised through real HTTP: operator management under the
 * workspace path, and the public read surface reachable with nothing but a
 * token. The tests care most about the boundary BETWEEN them - a management
 * route must never accept a share token, and a share token must never reach
 * anything that writes.
 */

const APP_URL = 'https://app.example.test';
const START = new Date('2026-08-14T10:00:00.000Z');
const FOREIGN_UUID = '11111111-1111-4111-8111-111111111111';

let authStore: MemoryAuthStore;
let mailer: CapturingEmailSender;
let workspaces: MemoryWorkspaceStore;
let shares: MemoryShareStore;
let governance: MemoryGovernanceStore;
let events: MemoryEventReadStore;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  authStore = createMemoryAuthStore();
  mailer = createCapturingEmailSender();
  const clock = createFixedClock(START);
  workspaces = createMemoryWorkspaceStore();
  shares = createMemoryShareStore();
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
    shareManagementStore: shares,
    shareResolverStore: shares,
    // Wired so the "a share cookie cannot mutate policy" test exercises the
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

async function tenant(email: string, name: string, role: 'operator' | 'member' = 'operator'): Promise<Tenant> {
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
  return { workspaceId, cookie, name };
}

/** Issues a link and returns its plaintext token. */
async function issue(t: Tenant): Promise<{ token: string; shareId: string }> {
  const response = await app.request(workspaceShareLinksPath(t.workspaceId), {
    method: 'POST',
    headers: { cookie: t.cookie, origin: APP_URL, 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  const body = shareLinkCreatedResponseSchema.parse(await response.json());
  return { token: body.token, shareId: body.shareLink.id };
}

/** Exchanges a token for the viewing cookie, as the browser does. */
async function openShare(token: string): Promise<{ status: number; cookie: string }> {
  const response = await app.request(SHARE_ACCESS_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  const raw = response.headers.get('set-cookie') ?? '';
  const value = raw.split(';')[0]?.split('=')[1] ?? '';
  return { status: response.status, cookie: `${SHARE_COOKIE_NAME}=${value}` };
}

const sharedGet = async (cookie: string, path: string): Promise<Response> =>
  app.request(path, { headers: { cookie } });

/** Internal agent uuids per workspace, so assertions can name them. */
const agentIds = new Map<string, string>();

function seedWorkspaceData(t: Tenant, agentExternalId = 'agent-a'): void {
  // A real uuid: the wire contract requires one, and a fake that used a
  // readable string would let a schema violation pass unnoticed.
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
    day: '2026-08-14',
    spendCommittedUsd: '4.000000',
    publishCountCommitted: 1,
  });
  governance.seedReceipt({
    workspaceId: t.workspaceId,
    agentId,
    actionId: 'act-1',
    category: 'spend',
    decision: 'allow',
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

describe('management is operator-only', () => {
  it('rejects an unauthenticated issue', async () => {
    const t = await tenant('op@example.test', 'Acme');

    const response = await app.request(workspaceShareLinksPath(t.workspaceId), {
      method: 'POST',
      headers: { origin: APP_URL, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(401);
    expect(shares.shares).toHaveLength(0);
  });

  it('REJECTS A MEMBER', async () => {
    // A member may read everything already. Issuing an external, durable,
    // unauthenticated door is a decision on behalf of the whole workspace.
    const t = await tenant('member@example.test', 'Acme', 'member');

    const response = await app.request(workspaceShareLinksPath(t.workspaceId), {
      method: 'POST',
      headers: { cookie: t.cookie, origin: APP_URL, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(403);
    expect(shares.shares).toHaveLength(0);
  });

  it('rejects a member revoking', async () => {
    const operator = await tenant('op@example.test', 'Acme');
    const { shareId } = await issue(operator);
    const member = await tenant('member@example.test', 'Other', 'member');

    const response = await app.request(revokeShareLinkPath(member.workspaceId, shareId), {
      method: 'POST',
      headers: { cookie: member.cookie, origin: APP_URL },
    });

    expect(response.status).toBe(403);
    expect(shares.shares[0]?.revokedAt).toBeNull();
  });

  it('an operator can issue', async () => {
    const t = await tenant('op@example.test', 'Acme');

    const { token } = await issue(t);

    expect(token).toMatch(/^hmp_share_[A-Za-z0-9_-]{12}_[A-Za-z0-9_-]{43}$/);
    expect(shares.shares).toHaveLength(1);
  });

  it('CSRF: a foreign origin cannot issue', async () => {
    const t = await tenant('op@example.test', 'Acme');

    const response = await app.request(workspaceShareLinksPath(t.workspaceId), {
      method: 'POST',
      headers: {
        cookie: t.cookie,
        origin: 'https://evil.example.test',
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(403);
    expect(shares.shares).toHaveLength(0);
  });

  it('CSRF: a foreign origin cannot revoke', async () => {
    const t = await tenant('op@example.test', 'Acme');
    const { shareId } = await issue(t);

    const response = await app.request(revokeShareLinkPath(t.workspaceId, shareId), {
      method: 'POST',
      headers: { cookie: t.cookie, origin: 'https://evil.example.test' },
    });

    expect(response.status).toBe(403);
    expect(shares.shares[0]?.revokedAt).toBeNull();
  });

  it("cannot manage another workspace's shares", async () => {
    const a = await tenant('alice@example.test', 'Alice Co');
    const b = await tenant('bob@example.test', 'Bob Co');
    const bobs = await issue(b);

    const list = await app.request(workspaceShareLinksPath(b.workspaceId), {
      headers: { cookie: a.cookie },
    });
    const revoke = await app.request(revokeShareLinkPath(a.workspaceId, bobs.shareId), {
      method: 'POST',
      headers: { cookie: a.cookie, origin: APP_URL },
    });

    expect(list.status).toBe(404);
    // Alice's own workspace has no such share, so it reads as absent.
    expect(revoke.status).toBe(404);
    expect(shares.shares[0]?.revokedAt).toBeNull();
  });

  it('rejects an issue body carrying unknown fields', async () => {
    const t = await tenant('op@example.test', 'Acme');

    const response = await app.request(workspaceShareLinksPath(t.workspaceId), {
      method: 'POST',
      headers: { cookie: t.cookie, origin: APP_URL, 'content-type': 'application/json' },
      // A caller inventing a scope must not believe it took effect.
      body: JSON.stringify({ scope: 'write', workspace_id: FOREIGN_UUID }),
    });

    expect(response.status).toBe(400);
    expect(shares.shares).toHaveLength(0);
  });
});

describe('SHOW ONCE, AND HASH AT REST', () => {
  it('returns the plaintext exactly once', async () => {
    const t = await tenant('op@example.test', 'Acme');
    const { token } = await issue(t);

    const list = await app.request(workspaceShareLinksPath(t.workspaceId), {
      headers: { cookie: t.cookie },
    });
    const raw = await list.text();

    // The list can never return it: the server kept only a digest.
    expect(raw).not.toContain(token);
    expect(shareLinkListResponseSchema.parse(JSON.parse(raw)).shareLinks).toHaveLength(1);
  });

  it('STORES NO PLAINTEXT ANYWHERE', async () => {
    const t = await tenant('op@example.test', 'Acme');
    const { token } = await issue(t);

    const stored = JSON.stringify(shares.shares);

    expect(stored).not.toContain(token);
    // The secret half in particular. The prefix is public and IS stored.
    expect(stored).not.toContain(token.slice(token.lastIndexOf('_') + 1));
  });

  it('never returns a digest', async () => {
    const t = await tenant('op@example.test', 'Acme');
    await issue(t);
    const digest = shares.shares[0]?.tokenHash ?? '';

    const list = await app.request(workspaceShareLinksPath(t.workspaceId), {
      headers: { cookie: t.cookie },
    });

    expect(digest).not.toBe('');
    expect(await list.text()).not.toContain(digest);
  });

  it('two links are independent secrets', async () => {
    const t = await tenant('op@example.test', 'Acme');

    const first = await issue(t);
    const second = await issue(t);

    expect(first.token).not.toBe(second.token);
    expect(shares.shares[0]?.tokenPrefix).not.toBe(shares.shares[1]?.tokenPrefix);
  });
});

describe('THE PUBLIC VIEW NEEDS NO LOGIN', () => {
  it('opens with only a token and reveals the workspace name', async () => {
    const t = await tenant('op@example.test', 'Acme');
    const { token } = await issue(t);

    // No session cookie anywhere in this request.
    const opened = await openShare(token);

    expect(opened.status).toBe(200);
    expect(opened.cookie).toContain(SHARE_COOKIE_NAME);
  });

  it('reads the fleet, timeline, receipts and blocks', async () => {
    const t = await tenant('op@example.test', 'Acme');
    seedWorkspaceData(t);
    const { token } = await issue(t);
    const { cookie } = await openShare(token);

    const agents = await sharedGet(cookie, SHARE_AGENTS_PATH);
    const timeline = await sharedGet(cookie, SHARE_EVENTS_PATH);
    const receipts = await sharedGet(cookie, SHARE_RECEIPTS_PATH);
    const blocks = await sharedGet(cookie, SHARE_BLOCKS_PATH);

    expect(agents.status).toBe(200);
    const fleet = shareAgentListResponseSchema.parse(await agents.json());
    expect(fleet.agents).toHaveLength(1);
    // Governance state is the point of a shared view.
    expect(fleet.agents[0]?.governance.spendCommittedUsd).toBe('4.000000');
    expect(fleet.agents[0]?.governance.dailySpendCapUsd).toBe('25.000000');

    expect(shareEventListResponseSchema.parse(await timeline.json()).events).toHaveLength(1);
    expect(receipts.status).toBe(200);
    expect(blocks.status).toBe(200);
  });

  it('serves the raw validated event payload', async () => {
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
    const { token } = await issue(t);
    const { cookie } = await openShare(token);

    const response = await sharedGet(cookie, `${SHARE_EVENTS_PATH}/${seeded.id}`);
    const body = shareEventDetailResponseSchema.parse(await response.json());

    // Returned unchanged - it is audit data. The UI renders it as a React text
    // child, so it displays as characters.
    expect((body.event.raw as { note: string }).note).toBe(hostile);
  });

  it('a request with NO share cookie is refused', async () => {
    const response = await app.request(SHARE_AGENTS_PATH);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'invalid_share' });
  });

  it('AN OPERATOR SESSION IS NOT A SHARE CREDENTIAL', async () => {
    const t = await tenant('op@example.test', 'Acme');
    seedWorkspaceData(t);

    // A perfectly valid operator cookie, offered to the share surface.
    const response = await sharedGet(t.cookie, SHARE_AGENTS_PATH);

    expect(response.status).toBe(404);
  });

  it('A SHARE COOKIE IS NOT AN OPERATOR CREDENTIAL', async () => {
    const t = await tenant('op@example.test', 'Acme');
    const { token } = await issue(t);
    const { cookie } = await openShare(token);

    // Offered to operator surfaces. None of them consults it.
    const shareList = await app.request(workspaceShareLinksPath(t.workspaceId), {
      headers: { cookie },
    });
    const create = await app.request(workspaceShareLinksPath(t.workspaceId), {
      method: 'POST',
      headers: { cookie, origin: APP_URL, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(shareList.status).toBe(401);
    expect(create.status).toBe(401);
    expect(shares.shares).toHaveLength(1);
  });
});

describe('an invalid share is indistinguishable from a revoked one', () => {
  it.each([
    ['a malformed token', 'not-a-share-token'],
    ['a well-shaped but unknown token', `hmp_share_${'A'.repeat(12)}_${'B'.repeat(43)}`],
    ['an API key', 'hmp_live_AbCdEfGhIjKl_' + 'C'.repeat(43)],
    ['an empty token', ''],
  ])('refuses %s', async (_label, token) => {
    const response = await app.request(SHARE_ACCESS_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'invalid_share' });
  });

  it('a revoked token reports exactly what an unknown one reports', async () => {
    const t = await tenant('op@example.test', 'Acme');
    const { token, shareId } = await issue(t);
    await app.request(revokeShareLinkPath(t.workspaceId, shareId), {
      method: 'POST',
      headers: { cookie: t.cookie, origin: APP_URL },
    });

    const revoked = await app.request(SHARE_ACCESS_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    const unknown = await app.request(SHARE_ACCESS_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: `hmp_share_${'Z'.repeat(12)}_${'Y'.repeat(43)}` }),
    });

    expect(revoked.status).toBe(unknown.status);
    expect(await revoked.json()).toEqual(await unknown.json());
  });
});

describe('REVOCATION KILLS AN OPEN SESSION', () => {
  it('the private window dies on refresh', async () => {
    // THE AC-18 ACCEPTANCE FLOW.
    const t = await tenant('op@example.test', 'Acme');
    seedWorkspaceData(t);
    const { token, shareId } = await issue(t);

    // 1. The viewer opens the link and reads.
    const { cookie } = await openShare(token);
    expect((await sharedGet(cookie, SHARE_AGENTS_PATH)).status).toBe(200);

    // 2. The operator revokes.
    const revoke = await app.request(revokeShareLinkPath(t.workspaceId, shareId), {
      method: 'POST',
      headers: { cookie: t.cookie, origin: APP_URL },
    });
    expect(revoke.status).toBe(200);

    // 3. The viewer refreshes. Same cookie, same browser - now dead.
    for (const path of [
      SHARE_WORKSPACE_PATH,
      SHARE_AGENTS_PATH,
      SHARE_EVENTS_PATH,
      SHARE_RECEIPTS_PATH,
      SHARE_BLOCKS_PATH,
    ]) {
      const response = await sharedGet(cookie, path);
      expect(response.status, path).toBe(404);
      expect(await response.json()).toEqual({ error: 'invalid_share' });
    }
  });

  it('re-exchanging the original plaintext does not restore access', async () => {
    const t = await tenant('op@example.test', 'Acme');
    const { token, shareId } = await issue(t);
    await app.request(revokeShareLinkPath(t.workspaceId, shareId), {
      method: 'POST',
      headers: { cookie: t.cookie, origin: APP_URL },
    });

    // The browser still holds the URL. It buys nothing.
    const reopened = await openShare(token);
    expect(reopened.status).toBe(404);
  });

  it('revoking is idempotent and keeps the first instant', async () => {
    const t = await tenant('op@example.test', 'Acme');
    const { shareId } = await issue(t);

    const first = await app.request(revokeShareLinkPath(t.workspaceId, shareId), {
      method: 'POST',
      headers: { cookie: t.cookie, origin: APP_URL },
    });
    const second = await app.request(revokeShareLinkPath(t.workspaceId, shareId), {
      method: 'POST',
      headers: { cookie: t.cookie, origin: APP_URL },
    });

    expect(first.status).toBe(200);
    // Not an error: "already safe" must not read as a failure.
    expect(second.status).toBe(200);
    const firstBody = shareLinkListResponseSchema.parse(await first.json());
    const secondBody = shareLinkListResponseSchema.parse(await second.json());
    expect(secondBody.shareLinks[0]?.revokedAt).toBe(firstBody.shareLinks[0]?.revokedAt);
  });

  it('REVOKING ONE LINK LEAVES THE OTHER WORKING', async () => {
    const t = await tenant('op@example.test', 'Acme');
    seedWorkspaceData(t);
    const first = await issue(t);
    const second = await issue(t);

    await app.request(revokeShareLinkPath(t.workspaceId, first.shareId), {
      method: 'POST',
      headers: { cookie: t.cookie, origin: APP_URL },
    });

    expect((await openShare(first.token)).status).toBe(404);
    const survivor = await openShare(second.token);
    expect(survivor.status).toBe(200);
    expect((await sharedGet(survivor.cookie, SHARE_AGENTS_PATH)).status).toBe(200);
  });

  it('a revoked row is retained, not deleted', async () => {
    const t = await tenant('op@example.test', 'Acme');
    const { shareId } = await issue(t);

    await app.request(revokeShareLinkPath(t.workspaceId, shareId), {
      method: 'POST',
      headers: { cookie: t.cookie, origin: APP_URL },
    });

    // An operator investigating an exposure needs to see that a link existed
    // and was withdrawn.
    const list = shareLinkListResponseSchema.parse(
      await (
        await app.request(workspaceShareLinksPath(t.workspaceId), { headers: { cookie: t.cookie } })
      ).json(),
    );
    expect(list.shareLinks).toHaveLength(1);
    expect(list.shareLinks[0]?.revokedAt).not.toBeNull();
  });
});

describe('CROSS-TENANT ISOLATION', () => {
  it("workspace A's token exposes only A", async () => {
    const a = await tenant('alice@example.test', 'Alice Co');
    const b = await tenant('bob@example.test', 'Bob Co');
    // Same external agent id in both tenants.
    seedWorkspaceData(a, 'agent-shared');
    seedWorkspaceData(b, 'agent-shared');

    const { token } = await issue(a);
    const { cookie } = await openShare(token);

    const fleet = shareAgentListResponseSchema.parse(
      await (await sharedGet(cookie, SHARE_AGENTS_PATH)).json(),
    );

    expect(fleet.agents).toHaveLength(1);
    expect(fleet.agents[0]?.id).toBe(agentIds.get(a.workspaceId));
    expect(JSON.stringify(fleet)).not.toContain(b.workspaceId);
  });

  it('WHEN BOTH TENANTS HAVE LINKS, each resolves to its OWN workspace', async () => {
    // The scope must come from the TOKEN'S row, not from "a share row". With
    // only one tenant holding a link, a resolver that picked the wrong row
    // would still look correct - so both must hold one.
    const a = await tenant('alice@example.test', 'Alice Co');
    const b = await tenant('bob@example.test', 'Bob Co');
    seedWorkspaceData(a, 'agent-shared');
    seedWorkspaceData(b, 'agent-shared');

    // B issues FIRST, so the earliest share row belongs to the other tenant.
    const bobs = await issue(b);
    const alices = await issue(a);

    const asBob = await openShare(bobs.token);
    const asAlice = await openShare(alices.token);

    const bobFleet = shareAgentListResponseSchema.parse(
      await (await sharedGet(asBob.cookie, SHARE_AGENTS_PATH)).json(),
    );
    const aliceFleet = shareAgentListResponseSchema.parse(
      await (await sharedGet(asAlice.cookie, SHARE_AGENTS_PATH)).json(),
    );

    expect(bobFleet.agents[0]?.id).toBe(agentIds.get(b.workspaceId));
    expect(aliceFleet.agents[0]?.id).toBe(agentIds.get(a.workspaceId));
    expect(bobFleet.agents[0]?.id).not.toBe(aliceFleet.agents[0]?.id);
  });

  it("B's exact event uuid is invisible through A's share", async () => {
    const a = await tenant('alice@example.test', 'Alice Co');
    const b = await tenant('bob@example.test', 'Bob Co');
    const bobsEvent = events.seedEvent({
      workspaceId: b.workspaceId,
      eventId: 'evt-bob',
      agentExternalId: 'agent-b',
      type: 'heartbeat',
      receivedAt: START,
    });

    const { token } = await issue(a);
    const { cookie } = await openShare(token);

    const response = await sharedGet(cookie, `${SHARE_EVENTS_PATH}/${bobsEvent.id}`);

    // Identical to an event that never existed. No existence leak.
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'invalid_share' });
  });

  it("B's receipts and blocks never appear in A's share", async () => {
    const a = await tenant('alice@example.test', 'Alice Co');
    const b = await tenant('bob@example.test', 'Bob Co');
    seedWorkspaceData(b);

    const { token } = await issue(a);
    const { cookie } = await openShare(token);

    const receipts = await (await sharedGet(cookie, SHARE_RECEIPTS_PATH)).json();
    const blocks = await (await sharedGet(cookie, SHARE_BLOCKS_PATH)).json();

    expect(receipts).toEqual({ receipts: [], nextCursor: null });
    expect(blocks).toEqual({ blocks: [], nextCursor: null });
  });

  it('an agent filter cannot reach across tenants', async () => {
    const a = await tenant('alice@example.test', 'Alice Co');
    const b = await tenant('bob@example.test', 'Bob Co');
    seedWorkspaceData(b, 'agent-bob');

    const { token } = await issue(a);
    const { cookie } = await openShare(token);

    const response = await sharedGet(cookie, `${SHARE_EVENTS_PATH}?agent_id=agent-bob`);

    // Resolved inside A's workspace, where no such agent exists.
    expect(shareEventListResponseSchema.parse(await response.json()).events).toEqual([]);
  });
});

describe('NO MUTATION IS REACHABLE WITH A SHARE TOKEN', () => {
  it.each([
    ['policy', (id: string) => `/v1/workspaces/${id}/agents/${FOREIGN_UUID}/policy`, 'PUT'],
    ['api keys', (id: string) => `/v1/workspaces/${id}/api-keys`, 'POST'],
    ['share links', (id: string) => `/v1/workspaces/${id}/share-links`, 'POST'],
    ['workspaces', () => '/v1/workspaces', 'POST'],
  ])('a share cookie cannot reach %s', async (_label, build, method) => {
    const t = await tenant('op@example.test', 'Acme');
    const { token } = await issue(t);
    const { cookie } = await openShare(token);

    const response = await app.request(build(t.workspaceId), {
      method,
      headers: { cookie, origin: APP_URL, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });

    // 401 (no session) or 403 (origin) - never a success.
    expect([401, 403]).toContain(response.status);
  });

  it.each([
    ['event ingest', '/v1/events'],
    ['precheck', '/v1/actions/precheck'],
    ['agent registration', '/v1/agents/register'],
  ])('a share cookie is not a machine credential for %s', async (_label, path) => {
    const t = await tenant('op@example.test', 'Acme');
    const { token } = await issue(t);
    const { cookie } = await openShare(token);

    const response = await app.request(path, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ events: [] }),
    });

    // Those routes read the Authorization header only.
    expect([401, 503]).toContain(response.status);
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])(
    'refuses %s on every share read path',
    async (method) => {
      const t = await tenant('op@example.test', 'Acme');
      const { token } = await issue(t);
      const { cookie } = await openShare(token);

      for (const path of [SHARE_AGENTS_PATH, SHARE_EVENTS_PATH, SHARE_RECEIPTS_PATH, SHARE_BLOCKS_PATH]) {
        const response = await app.request(path, {
          method,
          headers: { cookie, 'content-type': 'application/json' },
          body: JSON.stringify({}),
        });
        expect(response.status, `${method} ${path}`).toBe(404);
      }
    },
  );

  it('READING CHANGES NOTHING', async () => {
    const t = await tenant('op@example.test', 'Acme');
    seedWorkspaceData(t);
    const { token } = await issue(t);
    const { cookie } = await openShare(token);
    const before = governance.snapshot();
    const sharesBefore = shares.snapshot();

    await sharedGet(cookie, SHARE_AGENTS_PATH);
    await sharedGet(cookie, SHARE_EVENTS_PATH);
    await sharedGet(cookie, SHARE_RECEIPTS_PATH);
    await sharedGet(cookie, SHARE_BLOCKS_PATH);

    // No last-seen refresh, no ledger row, no policy version, no share write.
    expect(governance.snapshot()).toBe(before);
    expect(shares.snapshot()).toBe(sharesBefore);
  });
});

describe('the public surface leaks no secrets', () => {
  it('carries no key, cookie, digest or workspace id', async () => {
    const t = await tenant('op@example.test', 'Acme');
    seedWorkspaceData(t);
    const { token } = await issue(t);
    const { cookie } = await openShare(token);
    const digest = shares.shares[0]?.tokenHash ?? '';

    const bodies = await Promise.all(
      [SHARE_WORKSPACE_PATH, SHARE_AGENTS_PATH, SHARE_EVENTS_PATH, SHARE_RECEIPTS_PATH, SHARE_BLOCKS_PATH].map(
        async (path) => (await sharedGet(cookie, path)).text(),
      ),
    );
    const combined = bodies.join('\n');

    expect(combined).not.toContain(token);
    expect(combined).not.toContain(digest);
    expect(combined).not.toContain('hmp_live');
    expect(combined).not.toContain('hmp_share');
    expect(combined).not.toContain(t.workspaceId);
    expect(combined).not.toMatch(/secret|password|authorization|postgres:\/\//i);
  });

  it('the exchange reveals the workspace NAME and nothing else', async () => {
    const t = await tenant('op@example.test', 'Acme');
    const { token } = await issue(t);

    const response = await app.request(SHARE_ACCESS_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });

    expect(await response.json()).toEqual({ workspace: { name: 'Acme' } });
  });

  it('the viewing cookie is HttpOnly and path-scoped', async () => {
    const t = await tenant('op@example.test', 'Acme');
    const { token } = await issue(t);

    const response = await app.request(SHARE_ACCESS_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    const setCookie = response.headers.get('set-cookie') ?? '';

    // HttpOnly: script cannot read it, so XSS cannot exfiltrate the link.
    expect(setCookie).toMatch(/HttpOnly/i);
    // Path-scoped: the browser never offers it to an operator route.
    expect(setCookie).toMatch(/Path=\/v1\/share/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
  });
});

describe('unavailable without a database', () => {
  it.each([
    ['management', workspaceShareLinksPath('any')],
    ['public agents', SHARE_AGENTS_PATH],
  ])('reports 503 on %s rather than crashing', async (_label, path) => {
    const noDb = createApp({ probeDatabase: () => Promise.resolve('unconfigured') });

    expect((await noDb.request(path)).status).toBe(503);
  });

  it('leaves liveness unaffected', async () => {
    const noDb = createApp({ probeDatabase: () => Promise.resolve('unconfigured') });

    expect((await noDb.request('/healthz')).status).toBe(200);
  });
});
