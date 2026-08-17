import { and, eq, type SQL } from 'drizzle-orm';

import type { DatabaseExecutor } from './executor.js';
import type { WorkspaceScope } from './workspace-scope.js';
import { workspaces } from '../schema/workspaces.js';

/**
 * Workspace demo settings (AC-19) - the only writer of `demo_enabled`.
 *
 * ─── WHY A SCOPED REPOSITORY AND NOT A GENERIC WORKSPACE UPDATE ───────────
 *
 * Publishing a workspace is the single most consequential setting the product
 * has: it turns a private tenant into an unauthenticated public page. A
 * general-purpose `updateWorkspace(fields)` would put that switch alongside
 * renaming, where a future caller could flip it as a side effect of something
 * innocuous.
 *
 * There are exactly two write methods here and neither takes a boolean from a
 * caller-shaped object: `enable` and `disable` say what they do.
 *
 * ─── THE SLUG DIES WITH THE DEMO ──────────────────────────────────────────
 *
 * The Step 3 check constraint is `demo_slug IS NULL OR demo_enabled`, so a
 * disabled workspace CANNOT retain a slug. That is not an obstacle to work
 * around - it is the schema saying a public locator only exists while the
 * thing it locates is public.
 *
 * The consequence is deliberate and documented: disabling clears the slug, so
 * re-enabling mints a NEW one and every previously-shared public URL stays
 * dead. Disabling is how an operator withdraws public access, and an old link
 * silently coming back to life months later would be a surprise in the wrong
 * direction.
 */

/** The tenant predicate every query in this file must carry. */
function workspaceScopePredicate(scope: WorkspaceScope): SQL {
  return eq(workspaces.id, scope.workspaceId);
}

/** Public demo state. Carries no secret and no membership. */
export interface DemoSettingsRow {
  readonly workspaceId: string;
  readonly name: string;
  readonly demoEnabled: boolean;
  /** Non-null only while enabled, per the schema check constraint. */
  readonly demoSlug: string | null;
}

const DEMO_COLUMNS = {
  workspaceId: workspaces.id,
  name: workspaces.name,
  demoEnabled: workspaces.demoEnabled,
  demoSlug: workspaces.demoSlug,
} as const;

export const demoSettingsQueries = {
  /** This workspace's demo state. */
  find: (executor: DatabaseExecutor, scope: WorkspaceScope) =>
    executor.select(DEMO_COLUMNS).from(workspaces).where(workspaceScopePredicate(scope)).limit(1),
} as const;

export interface DemoSettingsRepository {
  find(): Promise<DemoSettingsRow | null>;

  /**
   * Turns the public demo on with the supplied slug.
   *
   * @param slug - already generated and checked for shape by the caller. A
   *   unique-violation propagates so the caller can retry with fresh material.
   */
  enable(slug: string, at: Date): Promise<DemoSettingsRow>;

  /**
   * Turns the public demo off and CLEARS the slug.
   *
   * Idempotent: disabling an already-disabled workspace is a no-op that still
   * returns current state, because "already private" must never read as a
   * failure to a caller trying to make something private.
   */
  disable(at: Date): Promise<DemoSettingsRow>;
}

export function createDemoSettingsRepository(
  executor: DatabaseExecutor,
  scope: WorkspaceScope,
): DemoSettingsRepository {
  return {
    async find(): Promise<DemoSettingsRow | null> {
      const rows = await demoSettingsQueries.find(executor, scope);
      return rows[0] ?? null;
    },

    async enable(slug: string, at: Date): Promise<DemoSettingsRow> {
      const updated = await executor
        .update(workspaces)
        .set({ demoEnabled: true, demoSlug: slug, updatedAt: at })
        // Scoped: an operator proven for THIS workspace cannot publish another.
        .where(workspaceScopePredicate(scope))
        .returning(DEMO_COLUMNS);

      const row = updated[0];
      if (row === undefined) {
        throw new Error('Failed to enable the public demo.');
      }
      return row;
    },

    async disable(at: Date): Promise<DemoSettingsRow> {
      const updated = await executor
        .update(workspaces)
        // The slug goes with it - see the note above.
        .set({ demoEnabled: false, demoSlug: null, updatedAt: at })
        .where(and(workspaceScopePredicate(scope)))
        .returning(DEMO_COLUMNS);

      const row = updated[0];
      if (row === undefined) {
        throw new Error('Failed to disable the public demo.');
      }
      return row;
    },
  };
}
