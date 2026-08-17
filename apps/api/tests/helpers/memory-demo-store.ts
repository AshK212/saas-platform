import type { AuthorizedWorkspace, DemoSettingsRow, WorkspaceScope } from '@hybrid/db';

import { generateDemoSlug } from '../../src/demo/slug';
import type {
  DemoManagementStore,
  DemoResolverStore,
  ReadOnlyDemoContext,
} from '../../src/demo/store';

/**
 * In-memory demo stores, mirroring the production algorithm.
 *
 * ─── FAITHFUL ON THE TWO POINTS THAT MATTER ───────────────────────────────
 *
 * 1. `resolve` requires `demoEnabled === true`, matching the SQL predicate. A
 *    fake that looked the slug up and checked the flag afterwards would let a
 *    resolver with the same bug pass its tests.
 * 2. `disable` CLEARS the slug, matching the schema check constraint
 *    `demo_slug IS NULL OR demo_enabled`. A fake that kept it would make the
 *    rotation-on-re-enable behaviour untestable.
 */

interface StoredDemo {
  workspaceId: string;
  name: string;
  demoEnabled: boolean;
  demoSlug: string | null;
}

export interface MemoryDemoStore extends DemoManagementStore, DemoResolverStore {
  readonly workspaces: StoredDemo[];
  /** Registers a workspace in its secure default state: demo OFF. */
  seedWorkspace(workspaceId: string, name: string): void;
  /**
   * Forces the state the CHECK CONSTRAINT forbids: a slug on a PRIVATE
   * workspace.
   *
   * Unreachable through the API, and unreachable in PostgreSQL while
   * `workspaces_demo_slug_requires_demo_check` exists. It is constructible
   * here so the resolver's `demo_enabled` predicate can be tested on its own
   * merits rather than resting on the slug happening to be cleared too.
   */
  forceOrphanedSlug(workspaceId: string, slug: string): void;
  snapshot(): string;
}

export function createMemoryDemoStore(): MemoryDemoStore {
  const workspaces: StoredDemo[] = [];

  const find = (workspaceId: string): StoredDemo | undefined =>
    workspaces.find((w) => w.workspaceId === workspaceId);

  return {
    workspaces,

    seedWorkspace(workspaceId: string, name: string): void {
      // demo_enabled defaults FALSE. A workspace is never born public.
      workspaces.push({ workspaceId, name, demoEnabled: false, demoSlug: null });
    },

    forceOrphanedSlug(workspaceId: string, slug: string): void {
      const row = find(workspaceId);
      if (row !== undefined) {
        row.demoEnabled = false;
        row.demoSlug = slug;
      }
    },

    snapshot(): string {
      return JSON.stringify(workspaces);
    },

    read(authorized: AuthorizedWorkspace): Promise<DemoSettingsRow | null> {
      const row = find(authorized.workspace.id);
      return Promise.resolve(row === undefined ? null : toRow(row));
    },

    enable(authorized: AuthorizedWorkspace): Promise<DemoSettingsRow> {
      const row = find(authorized.workspace.id);
      if (row === undefined) {
        return Promise.reject(new Error('no such workspace'));
      }
      // Already public: keep the existing address rather than rotating it.
      if (row.demoEnabled && row.demoSlug !== null) {
        return Promise.resolve(toRow(row));
      }

      let slug = generateDemoSlug(row.name);
      // The unique constraint, reproduced.
      while (workspaces.some((w) => w.demoSlug === slug)) {
        slug = generateDemoSlug(row.name);
      }
      row.demoEnabled = true;
      row.demoSlug = slug;
      return Promise.resolve(toRow(row));
    },

    disable(authorized: AuthorizedWorkspace): Promise<DemoSettingsRow> {
      const row = find(authorized.workspace.id);
      if (row === undefined) {
        return Promise.reject(new Error('no such workspace'));
      }
      row.demoEnabled = false;
      // The slug goes with it - the schema forbids one on a private workspace.
      row.demoSlug = null;
      return Promise.resolve(toRow(row));
    },

    resolve(slug: string): Promise<ReadOnlyDemoContext | null> {
      // Slug AND flag together, as one predicate would be in SQL.
      const row = workspaces.find((w) => w.demoSlug === slug && w.demoEnabled);
      if (row === undefined || row.demoSlug === null) {
        return Promise.resolve(null);
      }
      return Promise.resolve({
        workspaceId: row.workspaceId,
        workspaceName: row.name,
        demoSlug: row.demoSlug,
        // `createWorkspaceScope` is deliberately not exported from the package
        // root - a scope must come from a resolver - so the fake brands one
        // the same way the other memory stores do.
        scope: { workspaceId: row.workspaceId } as unknown as WorkspaceScope,
      });
    },
  };
}

function toRow(row: StoredDemo): DemoSettingsRow {
  return {
    workspaceId: row.workspaceId,
    name: row.name,
    demoEnabled: row.demoEnabled,
    demoSlug: row.demoSlug,
  };
}
