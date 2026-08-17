import { and, eq, isNotNull } from 'drizzle-orm';

import type { DatabaseExecutor } from '../repositories/executor.js';
import { createWorkspaceScope, type WorkspaceScope } from '../repositories/workspace-scope.js';
import { workspaces } from '../schema/workspaces.js';

/**
 * Public demo resolution - the PUBLIC READ-ONLY authorization boundary (AC-19).
 *
 * ─── THE SLUG IS A LOCATOR, NOT A SECRET ──────────────────────────────────
 *
 * This is the crucial difference from AC-18 sharing. A share token is a
 * 256-bit bearer credential and its secrecy is the security model. A demo slug
 * is meant to be published - printed in a deck, pasted on a website - so it
 * has NO secrecy to rely on and none is assumed.
 *
 * The security model here is therefore the FLAG, not the name:
 *
 *   demo_enabled = true   AND   demo_slug = <slug>
 *
 * Both live in the WHERE clause of the single statement below. A private
 * workspace is unreachable through this path even if someone learns or guesses
 * its former slug, because the row simply is not returned.
 *
 * ─── WHY A RESOLVER AND NOT A REPOSITORY ──────────────────────────────────
 *
 * Repositories require a `WorkspaceScope`. This lookup cannot have one: its
 * purpose is to DISCOVER which workspace a public slug names. Same shape as
 * membership resolution, API-credential resolution and share resolution.
 *
 * It is still tightly bounded: there is no "list demo workspaces", no "find by
 * id", and no way to enumerate anything. The only input is a slug, and the
 * only rows reachable are ones an operator deliberately published.
 *
 * ─── RE-RESOLVED ON EVERY REQUEST ─────────────────────────────────────────
 *
 * `demo_enabled` is checked in the same statement every time, so an operator
 * disabling the demo takes effect on the visitor's very next request. There is
 * no cached decision and nothing to invalidate.
 */

/** A resolved public demo. Carries no user, no role and no credential. */
export interface ResolvedDemoWorkspace {
  /** Derived from the matched row. Not caller-supplied. */
  readonly workspaceId: string;
  /** Display name, so a visitor knows whose fleet they are looking at. */
  readonly workspaceName: string;
  readonly demoSlug: string;
  /** Trusted tenant scope, built from the row's own id. */
  readonly scope: WorkspaceScope;
}

/**
 * Resolves a public demo slug to its workspace.
 *
 * @param slug - the public locator from the URL.
 * @returns null for unknown, malformed and DISABLED alike. The three are
 *   deliberately indistinguishable: a visitor has no need to learn that a
 *   workspace exists but is private.
 */
export async function resolvePublicDemo(
  executor: DatabaseExecutor,
  slug: string,
): Promise<ResolvedDemoWorkspace | null> {
  const rows = await executor
    .select({
      id: workspaces.id,
      name: workspaces.name,
      demoSlug: workspaces.demoSlug,
    })
    .from(workspaces)
    .where(
      and(
        eq(workspaces.demoSlug, slug),
        // THE AUTHORIZATION. Not a post-hoc JavaScript check - a predicate, so
        // a disabled workspace is never in the result set to begin with.
        eq(workspaces.demoEnabled, true),
        isNotNull(workspaces.demoSlug),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (row === undefined || row.demoSlug === null) {
    return null;
  }

  return {
    workspaceId: row.id,
    workspaceName: row.name,
    demoSlug: row.demoSlug,
    // Built from the ROW's id, never from anything a caller sent.
    scope: createWorkspaceScope(row.id),
  };
}
