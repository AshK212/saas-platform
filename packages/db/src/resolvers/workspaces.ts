import { and, eq, isNotNull } from 'drizzle-orm';

import { workspaces } from '../schema/workspaces.js';
import type { DatabaseExecutor } from '../repositories/executor.js';

/**
 * Workspace resolution.
 *
 * The `workspaces` table IS the tenant boundary, so looking a workspace up
 * cannot itself be workspace-scoped without circularity. These functions
 * therefore take a raw identifier - but note what that identifier is in each
 * case, because it matters:
 *
 *   - `findWorkspaceById` takes a workspace id that a caller has ALREADY been
 *     authorized for (via membership, credential or share token). It fetches
 *     the row; it does not grant access to it.
 *   - `findDemoWorkspaceBySlug` takes a public, non-secret slug and will only
 *     ever return a workspace with `demo_enabled = true`. That predicate is the
 *     authorization: a non-demo workspace is unreachable through this path even
 *     if its slug were somehow guessed.
 *
 * Neither function creates a `WorkspaceScope`. Building the scope is the
 * caller's step, taken only after its own authorization check succeeds.
 *
 * STEP 4 SCOPE: reads only. No workspace creation, no demo behaviour, no
 * public routes.
 */

export type WorkspaceRow = typeof workspaces.$inferSelect;

/**
 * Fetches a workspace by id.
 *
 * THIS IS NOT AN AUTHORIZATION CHECK. Calling it with an id taken from user
 * input proves nothing. Authorization comes from `findMembership`, a credential
 * record, or a share token - never from the existence of the row.
 */
export async function findWorkspaceById(
  executor: DatabaseExecutor,
  workspaceId: string,
): Promise<WorkspaceRow | null> {
  const rows = await executor
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);

  return rows[0] ?? null;
}

/**
 * Resolves the public demo workspace from its non-secret slug (AC-19 path).
 *
 * The `demo_enabled` predicate is mandatory and is what makes this safe to
 * expose publicly later: a private workspace can never be returned here.
 */
export async function findDemoWorkspaceBySlug(
  executor: DatabaseExecutor,
  slug: string,
): Promise<WorkspaceRow | null> {
  const rows = await executor
    .select()
    .from(workspaces)
    .where(
      and(
        eq(workspaces.demoSlug, slug),
        eq(workspaces.demoEnabled, true),
        isNotNull(workspaces.demoSlug),
      ),
    )
    .limit(1);

  return rows[0] ?? null;
}
