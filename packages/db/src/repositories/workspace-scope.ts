/**
 * WorkspaceScope - the trusted tenant boundary token.
 *
 * WHAT IT MEANS
 * -------------
 * A `WorkspaceScope` asserts exactly one thing:
 *
 *   "This database operation is authorized to operate inside exactly one
 *    workspace."
 *
 * It carries no permissions, no user, no credential, no request and no
 * authentication logic. Those belong to the resolvers that produce a scope,
 * never to the scope itself.
 *
 * WHERE IT COMES FROM - THE TRUST BOUNDARY
 * ----------------------------------------
 * A scope is created ONLY after a trusted resolver has established workspace
 * ownership. In the final architecture that means:
 *
 *   - operator/dashboard flow -> derived from authenticated membership
 *   - API-key flow            -> derived from the credential record
 *   - share flow              -> derived from the share token record
 *   - public demo             -> derived from the demo slug/config
 *
 * A workspace id arriving in an HTTP body or query string is NOT authorization.
 * No route may ever accept a caller-supplied `workspace_id` and turn it into a
 * scope. None of those resolvers exist yet; this file defines the shape they
 * must produce.
 *
 * WHY IT IS BRANDED
 * -----------------
 * The brand means a bare `{ workspaceId }` object literal does not satisfy the
 * type. Producing a scope requires calling `createWorkspaceScope`, so tenant
 * context cannot be conjured accidentally at a call site that merely happens to
 * have a string in hand. Deliberate subversion via a cast is still possible -
 * this defends against mistakes, not against an author who intends harm.
 *
 * NO AMBIENT STATE
 * ----------------
 * There is deliberately no module-level "current workspace", no singleton, no
 * environment variable and no AsyncLocalStorage. Scope travels as an explicit
 * argument so that HTTP handlers, background workers, the simulator, tests and
 * future runtime paths all supply it the same way, and so concurrent work in
 * different workspaces cannot interfere.
 */

declare const workspaceScopeBrand: unique symbol;

export interface WorkspaceScope {
  /** Brand. Prevents an untrusted object literal from satisfying this type. */
  readonly [workspaceScopeBrand]: true;
  /** The single workspace every scoped operation is confined to. */
  readonly workspaceId: string;
}

/** Thrown when a scope is requested for something that is not a workspace id. */
export class WorkspaceScopeError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'WorkspaceScopeError';
  }
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Creates a trusted workspace scope.
 *
 * Call this ONLY from a resolver that has already proven the caller owns the
 * workspace. Passing a workspace id straight from user input defeats the entire
 * isolation model.
 *
 * The id is validated as a UUID so a malformed value fails here rather than
 * silently producing a query that matches nothing - or, worse, one that a
 * future refactor coerces into matching something.
 *
 * @throws {WorkspaceScopeError} when the value is not a UUID.
 */
export function createWorkspaceScope(workspaceId: string): WorkspaceScope {
  if (!UUID_PATTERN.test(workspaceId)) {
    // The value is echoed because a workspace id is an identifier, not a
    // secret, and a malformed id is far easier to debug when it is shown.
    throw new WorkspaceScopeError(`Workspace id must be a UUID, received: ${workspaceId}`);
  }

  // The only cast in the module: this function IS the trusted constructor.
  return { workspaceId } as unknown as WorkspaceScope;
}

/** True when two scopes address the same workspace. */
export function isSameWorkspace(a: WorkspaceScope, b: WorkspaceScope): boolean {
  return a.workspaceId === b.workspaceId;
}
