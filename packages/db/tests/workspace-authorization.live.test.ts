import { eq, inArray } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { closeDatabasePool, createDatabaseClient, createDatabasePool } from '../src/client';
import { createWorkspaceWithOperator } from '../src/provisioning/workspaces';
import {
  authorizeWorkspaceForUser,
  listWorkspacesForUser,
} from '../src/resolvers/authorization';
import { users } from '../src/schema/identity';
import { workspacePolicyState } from '../src/schema/policy';
import { workspaceMemberships, workspaces } from '../src/schema/workspaces';

/**
 * LIVE workspace authorization suite against real PostgreSQL.
 *
 * SAFETY - READ BEFORE CHANGING THE GATE
 * --------------------------------------
 * This suite WRITES DATA. It is gated on `TEST_DATABASE_URL` and **never falls
 * back to `DATABASE_URL`**. Writes are rolled back or explicitly cleaned up;
 * nothing is dropped or truncated. The connection string is never logged.
 *
 * WHY IT EXISTS SEPARATELY
 * ------------------------
 * The API route tests use an in-memory store and the SQL tests compile queries
 * without executing them. Neither can prove real transaction rollback or the
 * membership primary-key constraint. Only this suite can.
 */

const testDatabaseUrl = process.env['TEST_DATABASE_URL']?.trim();
const hasTestDatabase = testDatabaseUrl !== undefined && testDatabaseUrl !== '';

const EMAIL_ALICE = 'live-ws-alice@example.test';
const EMAIL_BOB = 'live-ws-bob@example.test';
const ALL_EMAILS = [EMAIL_ALICE, EMAIL_BOB];

class Rollback extends Error {}

let pool: ReturnType<typeof createDatabasePool> | undefined;

afterAll(async () => {
  if (pool !== undefined) {
    await closeDatabasePool(pool);
  }
});

describe.skipIf(!hasTestDatabase)('live workspace authorization', () => {
  function getDb(): ReturnType<typeof createDatabaseClient> {
    pool ??= createDatabasePool({
      connectionString: testDatabaseUrl as string,
      maxConnections: 3,
      applicationName: 'hybrid-workspace-live-test',
    });
    return createDatabaseClient(pool);
  }

  it('creates workspace, creator membership AND policy state atomically', async () => {
    const db = getDb();

    try {
      const [alice] = await db.insert(users).values({ email: EMAIL_ALICE }).returning();

      const created = await createWorkspaceWithOperator(db, {
        name: 'Live Workspace',
        creatorUserId: alice?.id ?? '',
      });

      expect(created.role).toBe('operator');

      const membershipRows = await db
        .select()
        .from(workspaceMemberships)
        .where(eq(workspaceMemberships.workspaceId, created.id));
      expect(membershipRows).toHaveLength(1);
      expect(membershipRows[0]?.userId).toBe(alice?.id);

      // Step 12: a workspace that cannot report a policy version is not a
      // usable workspace, so the third row commits with the other two.
      const policyRows = await db
        .select()
        .from(workspacePolicyState)
        .where(eq(workspacePolicyState.workspaceId, created.id));
      expect(policyRows).toHaveLength(1);
      expect(policyRows[0]?.version).toBe(1);

      // Secure defaults: never publicly visible.
      const workspaceRows = await db.select().from(workspaces).where(eq(workspaces.id, created.id));
      expect(workspaceRows[0]?.demoEnabled).toBe(false);
      expect(workspaceRows[0]?.demoSlug).toBeNull();
    } finally {
      await db
        .delete(workspacePolicyState)
        .where(
          inArray(
            workspacePolicyState.workspaceId,
            db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.name, 'Live Workspace')),
          ),
        );
      await db.delete(users).where(inArray(users.email, ALL_EMAILS));
      await db.delete(workspaces).where(eq(workspaces.name, 'Live Workspace'));
    }
  });

  it('ROLLBACK: a failing membership insert leaves no orphaned workspace or policy state', async () => {
    const db = getDb();
    const before = await db.select().from(workspaces).where(eq(workspaces.name, 'Doomed'));

    // A non-existent creator makes the membership FK fail inside the same
    // transaction as the workspace insert - and now also before the policy
    // state insert, so all three must roll back together.
    await expect(
      createWorkspaceWithOperator(db, {
        name: 'Doomed',
        creatorUserId: '00000000-0000-4000-8000-000000000000',
      }),
    ).rejects.toThrow();

    const after = await db.select().from(workspaces).where(eq(workspaces.name, 'Doomed'));

    // An orphaned workspace would be permanently unreachable; an orphaned
    // policy state would outlive its workspace.
    expect(after).toHaveLength(before.length);
  });

  it('isolates two users and their workspaces', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const [alice] = await tx.insert(users).values({ email: EMAIL_ALICE }).returning();
        const [bob] = await tx.insert(users).values({ email: EMAIL_BOB }).returning();

        const [wsA] = await tx.insert(workspaces).values({ name: 'Alpha' }).returning();
        const [wsB] = await tx.insert(workspaces).values({ name: 'Bravo' }).returning();

        await tx.insert(workspaceMemberships).values([
          { workspaceId: wsA?.id ?? '', userId: alice?.id ?? '', role: 'operator' },
          { workspaceId: wsB?.id ?? '', userId: bob?.id ?? '', role: 'operator' },
        ]);

        // Alice is authorized for her own workspace...
        const aliceOwn = await authorizeWorkspaceForUser(tx, alice?.id ?? '', wsA?.id ?? '');
        expect(aliceOwn?.workspace.name).toBe('Alpha');
        expect(aliceOwn?.scope.workspaceId).toBe(wsA?.id);

        // ...and NOT for Bob's, even holding its exact UUID.
        expect(await authorizeWorkspaceForUser(tx, alice?.id ?? '', wsB?.id ?? '')).toBeNull();
        expect(await authorizeWorkspaceForUser(tx, bob?.id ?? '', wsA?.id ?? '')).toBeNull();

        // Listing never crosses the boundary.
        const aliceList = await listWorkspacesForUser(tx, alice?.id ?? '');
        expect(aliceList.map((w) => w.name)).toEqual(['Alpha']);

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('MULTI-WORKSPACE: one user authorized for two workspaces independently', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const [user] = await tx.insert(users).values({ email: EMAIL_ALICE }).returning();
        const [alpha] = await tx.insert(workspaces).values({ name: 'Alpha' }).returning();
        const [beta] = await tx.insert(workspaces).values({ name: 'Beta' }).returning();

        await tx.insert(workspaceMemberships).values([
          { workspaceId: alpha?.id ?? '', userId: user?.id ?? '', role: 'operator' },
          { workspaceId: beta?.id ?? '', userId: user?.id ?? '', role: 'member' },
        ]);

        const list = await listWorkspacesForUser(tx, user?.id ?? '');
        expect(list.map((w) => w.name)).toEqual(['Alpha', 'Beta']);

        const scopeA = await authorizeWorkspaceForUser(tx, user?.id ?? '', alpha?.id ?? '');
        const scopeB = await authorizeWorkspaceForUser(tx, user?.id ?? '', beta?.id ?? '');

        // Two distinct scopes, each earned by its own membership row.
        expect(scopeA?.scope.workspaceId).toBe(alpha?.id);
        expect(scopeB?.scope.workspaceId).toBe(beta?.id);
        expect(scopeA?.workspace.role).toBe('operator');
        expect(scopeB?.workspace.role).toBe('member');

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('prevents duplicate membership for the same user and workspace', async () => {
    const db = getDb();

    try {
      await db.transaction(async (tx) => {
        const [user] = await tx.insert(users).values({ email: EMAIL_ALICE }).returning();
        const [ws] = await tx.insert(workspaces).values({ name: 'Alpha' }).returning();

        await tx
          .insert(workspaceMemberships)
          .values({ workspaceId: ws?.id ?? '', userId: user?.id ?? '', role: 'operator' });

        // The composite primary key must reject a second row.
        await expect(
          tx
            .insert(workspaceMemberships)
            .values({ workspaceId: ws?.id ?? '', userId: user?.id ?? '', role: 'member' }),
        ).rejects.toThrow();

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it('leaves no residue', async () => {
    const db = getDb();

    const remaining = await db.select().from(users).where(inArray(users.email, ALL_EMAILS));

    expect(remaining).toEqual([]);
  });
});
