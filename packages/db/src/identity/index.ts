/**
 * Global identity data access.
 *
 * THE RULE FOR THIS DIRECTORY
 * ---------------------------
 * These records are GLOBAL and user-owned: users, magic-link challenges and
 * browser authentication sessions. None carries a `workspace_id`, so none takes
 * a `WorkspaceScope` - demanding one would be circular, since identity is
 * resolved before any workspace is.
 *
 * The three data-access categories in this package:
 *
 *   identity/      global, user-owned. Upstream of every tenant.   (this dir)
 *   resolvers/     establish WHICH workspace a caller may enter.
 *   repositories/  operate INSIDE one workspace. Always scoped.
 *
 * Nothing here may read or write tenant-owned data, and every function is
 * anchored on a specific email, user id or token hash. There is no
 * "list all users" and no "list all sessions", and none may be added.
 *
 * SECRETS: only SHA-256 hashes cross this boundary. Plaintext magic-link and
 * session tokens are handled by the auth service and never reach the database.
 */

export { findOrCreateUserByEmail, findUserByEmail, findUserById, normaliseEmail } from './users.js';
export type { UserRow } from './users.js';

export {
  consumeMagicLink,
  findLatestMagicLinkIssuedAt,
  insertMagicLink,
} from './magic-links.js';
export type { ConsumedMagicLink, IssueMagicLinkInput, MagicLinkRow } from './magic-links.js';

export {
  findActiveAuthSession,
  insertAuthSession,
  revokeAuthSession,
  touchAuthSession,
} from './auth-sessions.js';
export type { ActiveAuthSession, AuthSessionRow, CreateAuthSessionInput } from './auth-sessions.js';
