/**
 * Tenant provisioning - the only writes in this package outside `identity/`.
 *
 * Deliberately tiny. Every function here creates a tenant or its founding
 * membership, and nothing else. There is no generic workspace update, no
 * membership CRUD, no invitation, no removal and no ownership transfer - none
 * is required by the Credit phase, and a generic mutation surface here would
 * be reachable by any future caller holding a database handle.
 */

export { createWorkspaceWithOperator } from './workspaces.js';
export type { CreateWorkspaceInput } from './workspaces.js';
