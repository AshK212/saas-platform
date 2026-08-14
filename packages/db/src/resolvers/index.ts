/**
 * Scope resolvers - the ONLY code permitted to operate without a WorkspaceScope.
 *
 * THE RULE FOR THIS DIRECTORY
 * ---------------------------
 * A resolver answers "which workspace may this caller act in?". It is the input
 * to `createWorkspaceScope`, so it cannot itself require a scope.
 *
 * Every function here is still bounded:
 *   - membership resolvers are anchored on a single authenticated `user_id`;
 *   - the demo resolver is anchored on `demo_enabled = true`;
 *   - `findWorkspaceById` fetches a row a caller was already authorized for and
 *     grants nothing by itself.
 *
 * There is no "list all workspaces" and no "list all memberships" function, and
 * none may be added. Anything that reads tenant-owned business data belongs in
 * `../repositories/` behind a scope.
 */

export { authenticateApiCredential } from './api-credentials.js';
export type { AuthenticatedApiCredential } from './api-credentials.js';

export { authorizeWorkspaceForUser, listWorkspacesForUser } from './authorization.js';
export type {
  AuthorizedWorkspace,
  AuthorizedWorkspaceSummary,
  MembershipRole,
} from './authorization.js';

export { findMembership, listMembershipsForUser } from './memberships.js';
export type { MembershipRow } from './memberships.js';

export { findDemoWorkspaceBySlug, findWorkspaceById } from './workspaces.js';
export type { WorkspaceRow } from './workspaces.js';
export { resolveShareToken } from './share-tokens.js';
export type { ResolvedShareToken } from './share-tokens.js';
