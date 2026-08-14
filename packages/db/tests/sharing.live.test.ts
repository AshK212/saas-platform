import { createHash, randomBytes } from 'node:crypto';

import { eq, inArray } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { closeDatabasePool, createDatabaseClient, createDatabasePool } from '../src/client';
import { createAgentRepository } from '../src/repositories/agents';
import { createEventRepository } from '../src/repositories/events';
import { createPrecheckReceiptRepository } from '../src/repositories/receipts';
import { parseUtcAccountingDay } from '../src/accounting/utc-day';
import { createShareTokenRepository } from '../src/repositories/share-tokens';
import { createWorkspaceScope } from '../src/repositories/workspace-scope';
import { resolveShareToken } from '../src/resolvers/share-tokens';
import type { DatabaseExecutor } from '../src/repositories/executor';
import { agents } from '../src/schema/agents';
import { blocks } from '../src/schema/blocks';
import { events } from '../src/schema/events';
import { ledgerDaily } from '../src/schema/ledger';
import { agentPolicies, workspacePolicyState } from '../src/schema/policy';
import { precheckReceipts } from '../src/schema/receipts';
import { shareTokens } from '../src/schema/sharing';
import { workspaces } from '../src/schema/workspaces';

/**
 * LIVE read-only sharing against real PostgreSQL (AC-18).
 *
 * SAFETY - READ BEFORE CHANGING THE GATE
 * --------------------------------------
 * This suite WRITES DATA. It is gated on `TEST_DATABASE_URL` and **never falls
 * back to `DATABASE_URL`**. Writes are rolled back or explicitly cleaned up;
 * nothing is dropped or truncated. The connection string is never logged, and
 * no share token is ever printed.
 *
 * WHY IT EXISTS SEPARATELY
 * ------------------------
 * The in-memory suite proves the ROUTES behave. Three claims are about
 * PostgreSQL itself and cannot be established any other way:
 *
 *   - that the row on disk really contains no plaintext, only a digest;
 *   - that the workspace predicate really hides another tenant's agents,
 *     events, receipts and blocks from a share scope;
 *   - that `revoked_at IS NULL` in the resolving statement really kills a
 *     live link the moment the revocation commits.
 *
 * A fake cannot fail to store a column it never had.
 *
 * `hashToken` below transcribes `apps/api/src/share/tokens.ts`, because
 * `packages/db` cannot import from `apps/`. A drift guard in `apps/api` -
 * which depends on both - keeps the two in step.
 */

const testDatabaseUrl = process.env['TEST_DATABASE_URL']?.trim();
const hasTestDatabase = testDatabaseUrl !== undefined && testDatabaseUrl !== '';

const WORKSPACE_A_NAME = 'live-sharing-alpha';
const WORKSPACE_B_NAME = 'live-sharing-bravo';
const ALL_NAMES = [WORKSPACE_A_NAME, WORKSPACE_B_NAME];

const NOW = new Date('2026-08-14T09:00:00.000Z');

class Rollback extends Error {}

let pool: ReturnType<typeof createDatabasePool> | undefined;

afterAll(async () => {
  if (pool !== undefined) {
    await closeDatabasePool(pool);
  }
});

/** Transcription of the production token format. */
const SHARE_NAMESPACE = 'hmp_share';

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function generateToken(): { token: string; tokenPrefix: string; tokenHash: string } {
  const shareId = randomBytes(9).toString('base64url');
  const secret = randomBytes(32).toString('base64url');
  const tokenPrefix = `${SHARE_NAMESPACE}_${shareId}`;
  const token = `${tokenPrefix}_${secret}`;
  return { token, tokenPrefix, tokenHash: hashToken(token) };
}

/** The prefix half of a presented token, as the resolver derives it. */
function prefixOf(token: string): string {
  return token.slice(0, `${SHARE_NAMESPACE}_`.length + 12);
}

describe.skipIf(!hasTestDatabase)('live read-only sharing', () => {
  function getDb(): ReturnType<typeof createDatabaseClient> {
    pool ??= createDatabasePool({
      connectionString: testDatabaseUrl as string,
      maxConnections: 4,
      applicationName: 'hybrid-sharing-live-test',
    });
    return createDatabaseClient(pool);
  }

  async function seedWorkspace(
    executor: DatabaseExecutor,
    name: string,
    externalId = 'agent-a',
  ): Promise<{ workspaceId: string; agentId: string }> {
    const [ws] = await executor.insert(workspaces).values({ name }).returning();
    const workspaceId = ws?.id ?? '';
    await executor.insert(workspacePolicyState).values({ workspaceId, version: 1 });
    const [agent] = await executor.insert(agents).values({ workspaceId, externalId }).returning();
    const agentId = agent?.id ?? '';
    await executor.insert(agentPolicies).values({
      workspaceId,
      agentId,
      mode: 'budgeted',
      dailySpendCapUsd: '25.000000',
      dailyPublishCap: 5,
    });
    return { workspaceId, agentId };
  }

  /** Issues a share the way the production store does. */
  async function issueShare(
    executor: DatabaseExecutor,
    workspaceId: string,
  ): Promise<{ token: string; shareId: string }> {
    const generated = generateToken();
    const row = await createShareTokenRepository(
      executor,
      createWorkspaceScope(workspaceId),
    ).insert({ tokenPrefix: generated.tokenPrefix, tokenHash: generated.tokenHash });
    return { token: generated.token, shareId: row.id };
  }

  async function cleanup(db: ReturnType<typeof createDatabaseClient>): Promise<void> {
    const rows = await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(inArray(workspaces.name, ALL_NAMES));
    for (const row of rows) {
      await db.delete(shareTokens).where(eq(shareTokens.workspaceId, row.id));
      await db.delete(events).where(eq(events.workspaceId, row.id));
      await db.delete(blocks).where(eq(blocks.workspaceId, row.id));
      await db.delete(precheckReceipts).where(eq(precheckReceipts.workspaceId, row.id));
      await db.delete(ledgerDaily).where(eq(ledgerDaily.workspaceId, row.id));
      await db.delete(agentPolicies).where(eq(agentPolicies.workspaceId, row.id));
      await db.delete(agents).where(eq(agents.workspaceId, row.id));
      await db.delete(workspacePolicyState).where(eq(workspacePolicyState.workspaceId, row.id));
    }
    await db.delete(workspaces).where(inArray(workspaces.name, ALL_NAMES));
  }

  it('1. ISSUANCE PERSISTS A DIGEST AND NO PLAINTEXT', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const { workspaceId } = await seedWorkspace(tx, WORKSPACE_A_NAME);
        const { token } = await issueShare(tx, workspaceId);

        // Read the WHOLE row back, every column, and search it.
        const stored = await tx
          .select()
          .from(shareTokens)
          .where(eq(shareTokens.workspaceId, workspaceId));

        expect(stored).toHaveLength(1);
        const serialised = JSON.stringify(stored[0]);
        // A fake cannot fail to store a column it never had; this can.
        expect(serialised).not.toContain(token);
        // The SECRET half in particular. The prefix is public and IS stored.
        expect(serialised).not.toContain(token.slice(token.lastIndexOf('_') + 1));
        expect(stored[0]?.tokenHash).toBe(hashToken(token));
        expect(stored[0]?.revokedAt).toBeNull();

        throw new Rollback();
      });
    } catch (error: unknown) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('2. a valid token resolves to its workspace', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const { workspaceId } = await seedWorkspace(tx, WORKSPACE_A_NAME);
        const { token } = await issueShare(tx, workspaceId);

        const resolved = await resolveShareToken(tx, prefixOf(token), hashToken(token));

        expect(resolved?.workspaceId).toBe(workspaceId);
        expect(resolved?.workspaceName).toBe(WORKSPACE_A_NAME);
        expect(resolved?.scope.workspaceId).toBe(workspaceId);

        throw new Rollback();
      });
    } catch (error: unknown) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('3. THE PREFIX ALONE IS NOT A CREDENTIAL', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const { workspaceId } = await seedWorkspace(tx, WORKSPACE_A_NAME);
        const { token } = await issueShare(tx, workspaceId);

        // The prefix is shown to operators in the management list. If it were
        // sufficient on its own, that list would be a set of live links.
        const wrongDigest = await resolveShareToken(tx, prefixOf(token), hashToken('wrong'));
        expect(wrongDigest).toBeNull();

        // And the digest alone, under a mismatched prefix, is also refused:
        // the two halves are cryptographically bound.
        const wrongPrefix = await resolveShareToken(
          tx,
          `${SHARE_NAMESPACE}_${'A'.repeat(12)}`,
          hashToken(token),
        );
        expect(wrongPrefix).toBeNull();

        throw new Rollback();
      });
    } catch (error: unknown) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('4. A REVOKED TOKEN STOPS RESOLVING IMMEDIATELY', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const { workspaceId } = await seedWorkspace(tx, WORKSPACE_A_NAME);
        const { token, shareId } = await issueShare(tx, workspaceId);
        const scope = createWorkspaceScope(workspaceId);

        expect(await resolveShareToken(tx, prefixOf(token), hashToken(token))).not.toBeNull();

        await createShareTokenRepository(tx, scope).revoke(shareId, NOW);

        // No cache, no grace window: the predicate is in the same statement.
        expect(await resolveShareToken(tx, prefixOf(token), hashToken(token))).toBeNull();

        // The row is RETAINED, so the withdrawal stays auditable.
        const stored = await tx
          .select()
          .from(shareTokens)
          .where(eq(shareTokens.id, shareId));
        expect(stored).toHaveLength(1);
        expect(stored[0]?.revokedAt).not.toBeNull();

        throw new Rollback();
      });
    } catch (error: unknown) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('5. revocation is idempotent and keeps the FIRST instant', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const { workspaceId } = await seedWorkspace(tx, WORKSPACE_A_NAME);
        const { shareId } = await issueShare(tx, workspaceId);
        const repository = createShareTokenRepository(tx, createWorkspaceScope(workspaceId));

        const first = await repository.revoke(shareId, NOW);
        const later = new Date('2026-08-15T09:00:00.000Z');
        const second = await repository.revoke(shareId, later);

        expect(first?.revokedAt).not.toBeNull();
        // A second revoke must not overwrite when it actually happened.
        expect(second?.revokedAt?.toISOString()).toBe(first?.revokedAt?.toISOString());

        throw new Rollback();
      });
    } catch (error: unknown) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('6. MULTIPLE LINKS REVOKE INDEPENDENTLY', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const { workspaceId } = await seedWorkspace(tx, WORKSPACE_A_NAME);
        const first = await issueShare(tx, workspaceId);
        const second = await issueShare(tx, workspaceId);

        await createShareTokenRepository(tx, createWorkspaceScope(workspaceId)).revoke(
          first.shareId,
          NOW,
        );

        expect(
          await resolveShareToken(tx, prefixOf(first.token), hashToken(first.token)),
        ).toBeNull();
        // The survivor is untouched.
        expect(
          await resolveShareToken(tx, prefixOf(second.token), hashToken(second.token)),
        ).not.toBeNull();

        throw new Rollback();
      });
    } catch (error: unknown) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it("7. CROSS-TENANT: A's token cannot revoke or list B's shares", async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const a = await seedWorkspace(tx, WORKSPACE_A_NAME);
        const b = await seedWorkspace(tx, WORKSPACE_B_NAME);
        const bobs = await issueShare(tx, b.workspaceId);

        const asA = createShareTokenRepository(tx, createWorkspaceScope(a.workspaceId));

        // A's scope cannot see or touch B's share, even holding its exact id.
        expect(await asA.list()).toEqual([]);
        expect(await asA.findById(bobs.shareId)).toBeNull();
        expect(await asA.revoke(bobs.shareId, NOW)).toBeNull();

        // Which is to say B's link still works.
        expect(
          await resolveShareToken(tx, prefixOf(bobs.token), hashToken(bobs.token)),
        ).not.toBeNull();

        throw new Rollback();
      });
    } catch (error: unknown) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it("8. CROSS-TENANT: A's share scope reads only A's data", async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        // Same EXTERNAL agent id in both tenants - only the composite scope
        // keeps them apart.
        const a = await seedWorkspace(tx, WORKSPACE_A_NAME, 'agent-shared');
        const b = await seedWorkspace(tx, WORKSPACE_B_NAME, 'agent-shared');
        const { token } = await issueShare(tx, a.workspaceId);

        // Seed B with a full set of data.
        const [bobsEvent] = await tx
          .insert(events)
          .values({
            workspaceId: b.workspaceId,
            eventId: 'evt-bob',
            agentId: b.agentId,
            type: 'heartbeat',
            payload: {},
            receivedAt: NOW,
          })
          .returning();
        const bobsReceipt = await createPrecheckReceiptRepository(
          tx,
          createWorkspaceScope(b.workspaceId),
        ).insert({
          actionId: 'act-bob',
          agentId: b.agentId,
          category: 'spend',
          requestedAmountUsd: '4.000000',
          requestedPublishCount: null,
          decision: 'allow',
          policyVersion: '1',
          appliedMode: 'budgeted',
          appliedSpendCapUsd: '25.000000',
          appliedPublishCap: 5,
          accountingDay: parseUtcAccountingDay('2026-08-14'),
          ledgerSpendBeforeUsd: '0.000000',
          ledgerPublishBefore: null,
          remainingSpendUsd: null,
          remainingPublishCount: null,
          denyReason: null,
        });
        const [bobsBlock] = await tx
          .insert(blocks)
          .values({
            workspaceId: b.workspaceId,
            agentId: b.agentId,
            source: 'plane',
            category: 'spend',
            rule: 'daily_spend_cap',
            reason: 'Daily spend cap reached.',
            precheckReceiptId: bobsReceipt.id,
          })
          .returning();

        // Resolve A's token and read EVERYTHING through the scope it yields.
        const resolved = await resolveShareToken(tx, prefixOf(token), hashToken(token));
        const scope = resolved?.scope;
        expect(scope).toBeDefined();
        if (scope === undefined) throw new Error('unreachable');

        expect(await createAgentRepository(tx, scope).listAll()).toHaveLength(1);
        expect(
          (await createAgentRepository(tx, scope).listAll())[0]?.id,
        ).toBe(a.agentId);

        // B's EXACT uuids, offered to A's scope.
        expect(
          await createEventRepository(tx, scope).findDetailById(bobsEvent?.id ?? ''),
        ).toBeNull();
        expect(
          await createPrecheckReceiptRepository(tx, scope).findAuditById(bobsReceipt.id),
        ).toBeNull();
        expect(await createEventRepository(tx, scope).listTimeline({ limit: 50 })).toEqual([]);
        expect(
          await createPrecheckReceiptRepository(tx, scope).listAudit({ limit: 50 }),
        ).toEqual([]);
        expect(bobsBlock?.id).toBeDefined();

        throw new Rollback();
      });
    } catch (error: unknown) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('9. the unique constraints hold', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const { workspaceId } = await seedWorkspace(tx, WORKSPACE_A_NAME);
        const generated = generateToken();
        const repository = createShareTokenRepository(tx, createWorkspaceScope(workspaceId));

        await repository.insert({
          tokenPrefix: generated.tokenPrefix,
          tokenHash: generated.tokenHash,
        });

        // The same digest twice must be refused by the DATABASE, not merely by
        // application discipline.
        await expect(
          repository.insert({
            tokenPrefix: `${SHARE_NAMESPACE}_${'Q'.repeat(12)}`,
            tokenHash: generated.tokenHash,
          }),
        ).rejects.toThrow();

        throw new Rollback();
      });
    } catch (error: unknown) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('10. A SHARE READ MUTATES NOTHING', async () => {
    const db = getDb();

    // Committed state, so a stray write would survive to be observed.
    try {
      const { workspaceId, agentId } = await seedWorkspace(db, WORKSPACE_A_NAME);
      const { token } = await issueShare(db, workspaceId);

      const before = {
        agents: JSON.stringify(
          await db.select().from(agents).where(eq(agents.workspaceId, workspaceId)),
        ),
        ledger: JSON.stringify(
          await db.select().from(ledgerDaily).where(eq(ledgerDaily.workspaceId, workspaceId)),
        ),
        shares: JSON.stringify(
          await db.select().from(shareTokens).where(eq(shareTokens.workspaceId, workspaceId)),
        ),
        policy: JSON.stringify(
          await db
            .select()
            .from(workspacePolicyState)
            .where(eq(workspacePolicyState.workspaceId, workspaceId)),
        ),
      };

      // Resolve and read, repeatedly, exactly as a viewer refreshing would.
      for (let i = 0; i < 3; i += 1) {
        const resolved = await resolveShareToken(db, prefixOf(token), hashToken(token));
        const scope = resolved?.scope;
        if (scope === undefined) throw new Error('unreachable');
        await createAgentRepository(db, scope).listAll();
        await createEventRepository(db, scope).listTimeline({ limit: 50 });
        await createPrecheckReceiptRepository(db, scope).listAudit({ limit: 50 });
      }

      // Viewing is not agent activity: no last-seen, no ledger row, no policy
      // version bump, and no write to the share row itself.
      expect(
        JSON.stringify(await db.select().from(agents).where(eq(agents.workspaceId, workspaceId))),
      ).toBe(before.agents);
      expect(
        JSON.stringify(
          await db.select().from(ledgerDaily).where(eq(ledgerDaily.workspaceId, workspaceId)),
        ),
      ).toBe(before.ledger);
      expect(
        JSON.stringify(
          await db.select().from(shareTokens).where(eq(shareTokens.workspaceId, workspaceId)),
        ),
      ).toBe(before.shares);
      expect(
        JSON.stringify(
          await db
            .select()
            .from(workspacePolicyState)
            .where(eq(workspacePolicyState.workspaceId, workspaceId)),
        ),
      ).toBe(before.policy);
      expect(agentId).toBeDefined();
    } finally {
      await cleanup(db);
    }
  });
});
