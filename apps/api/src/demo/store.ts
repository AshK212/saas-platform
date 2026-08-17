import {
  createDemoSettingsRepository,
  resolvePublicDemo,
  type AuthorizedWorkspace,
  type DatabaseClient,
  type DemoSettingsRow,
  type WorkspaceScope,
} from '@hybrid/db';

import { generateDemoSlug } from './slug.js';

/**
 * Demo persistence: one management port, one resolution port.
 *
 * ─── THE FOURTH READ AUTHORITY ────────────────────────────────────────────
 *
 *   operator   session -> user -> membership -> scope
 *   machine    bearer API key -> credential row -> scope
 *   share      secret token -> share row -> scope           (AC-18)
 *   demo       public slug + enabled flag -> workspace row  (AC-19, here)
 *
 * All four end in a `WorkspaceScope`, which is what lets every read service be
 * reused untouched. They differ in what else they carry, and a demo visitor -
 * like a share viewer - carries nothing.
 *
 * ─── READ-ONLY IS STRUCTURAL ──────────────────────────────────────────────
 *
 * `ReadOnlyDemoContext` has no user, no role and no permission set. There is
 * no field a future route could inspect to decide it may write. A demo cannot
 * become writable without changing this type.
 */

/**
 * Proof that a caller may READ one publicly-demoed workspace.
 *
 * Deliberately NOT an `AuthorizedWorkspace`: that carries a membership role,
 * and manufacturing one would hand an anonymous visitor a synthetic identity
 * that some later route might trust.
 */
export interface ReadOnlyDemoContext {
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly demoSlug: string;
  /** Trusted tenant scope, built from the workspace row's own id. */
  readonly scope: WorkspaceScope;
}

/** Resolution: public slug in, read-only authority out. */
export interface DemoResolverStore {
  /**
   * @returns null for unknown, malformed and DISABLED alike. The caller must
   *   report all three identically - a visitor does not need to learn that a
   *   workspace exists but is private.
   */
  resolve(slug: string): Promise<ReadOnlyDemoContext | null>;
}

/** Management: operator-only, already inside a proven workspace. */
export interface DemoManagementStore {
  read(authorized: AuthorizedWorkspace): Promise<DemoSettingsRow | null>;
  /** Turns the demo on, minting a fresh slug. */
  enable(authorized: AuthorizedWorkspace, at: Date): Promise<DemoSettingsRow>;
  /** Turns it off and clears the slug, per the schema constraint. */
  disable(authorized: AuthorizedWorkspace, at: Date): Promise<DemoSettingsRow>;
}

/**
 * Bounded retry for a slug collision.
 *
 * `demo_slug` is UNIQUE. A collision is unlikely but the readable prefix makes
 * it less unlikely than pure randomness would - two workspaces called "Acme"
 * share a prefix and differ only in the suffix. Retrying with fresh material
 * costs nothing; relaxing the unique constraint to avoid it would be the wrong
 * trade entirely.
 */
const MAX_ENABLE_ATTEMPTS = 5;

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '23505'
  );
}

export function createDrizzleDemoManagementStore(db: DatabaseClient): DemoManagementStore {
  return {
    async read(authorized: AuthorizedWorkspace): Promise<DemoSettingsRow | null> {
      return createDemoSettingsRepository(db, authorized.scope).find();
    },

    async enable(authorized: AuthorizedWorkspace, at: Date): Promise<DemoSettingsRow> {
      const repository = createDemoSettingsRepository(db, authorized.scope);

      // Already public: keep the existing slug rather than rotating it. An
      // operator pressing "enable" twice has not asked for a new URL, and
      // silently invalidating a published one would be a nasty surprise.
      const current = await repository.find();
      if (current?.demoEnabled === true && current.demoSlug !== null) {
        return current;
      }

      let lastError: unknown;
      for (let attempt = 0; attempt < MAX_ENABLE_ATTEMPTS; attempt += 1) {
        // Fresh material per attempt: a collision means this exact slug is
        // taken, so retrying with it would fail identically.
        const slug = generateDemoSlug(authorized.workspace.name);
        try {
          return await repository.enable(slug, at);
        } catch (error: unknown) {
          if (!isUniqueViolation(error)) {
            throw error;
          }
          lastError = error;
        }
      }
      throw lastError instanceof Error
        ? lastError
        : new Error('Failed to assign a unique demo slug.');
    },

    async disable(authorized: AuthorizedWorkspace, at: Date): Promise<DemoSettingsRow> {
      return createDemoSettingsRepository(db, authorized.scope).disable(at);
    },
  };
}

export function createDrizzleDemoResolverStore(db: DatabaseClient): DemoResolverStore {
  return {
    async resolve(slug: string): Promise<ReadOnlyDemoContext | null> {
      const resolved = await resolvePublicDemo(db, slug);
      if (resolved === null) {
        return null;
      }
      return {
        workspaceId: resolved.workspaceId,
        workspaceName: resolved.workspaceName,
        demoSlug: resolved.demoSlug,
        scope: resolved.scope,
      };
    },
  };
}
