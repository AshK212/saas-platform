# ADR 0003 — Operator Workspace Authorization

- **Status:** Accepted
- **Date:** 2026-08-12
- **Phase:** Credit — Step 6
- **Targets:** AC-02 (workspace portion)

---

## Problem

Step 5 established identity. A user may belong to **several** workspaces, so
being signed in cannot mean "authorized for a tenant" — the system has to decide
*which* tenant, on every request.

The tempting shortcuts all fail:

```ts
createWorkspaceScope(req.params.workspaceId)   // caller picks the tenant
```

That single line would defeat [ADR 0001](0001-workspace-isolation.md) entirely.
Possessing a workspace UUID would become access, and UUIDs leak — through logs,
URLs, exports and support tickets.

## Decision

**Membership, proven in SQL on every request, is the only source of tenant
authorization.**

```text
Auth session -> AuthenticatedUser -> membership join -> AuthorizedWorkspace -> WorkspaceScope -> tenant repository
```

Four concrete measures:

1. **`authorizeWorkspaceForUser(executor, userId, workspaceId)`** is the sole
   sanctioned path to a scope. It returns an `AuthorizedWorkspace` — safe
   metadata, the membership role, and a trusted `WorkspaceScope` — or `null`.

2. **`createWorkspaceScope` is no longer exported from `@hybrid/db`.** The raw
   constructor performs no authorization, so application code can no longer
   reach it. The `WorkspaceScope` *type* is still exported, so callers can name
   a value they were given without being able to fabricate one.

3. **The authorization query is a join, not a filter.** It selects
   `FROM workspace_memberships INNER JOIN workspaces`, bounded by `user_id`.
   Reading workspaces and filtering afterwards is the shape where one forgotten
   line leaks every tenant.

4. **Creation is atomic.** A workspace and its creator's `operator` membership
   commit together, because a workspace whose membership failed would be
   permanently unreachable — nobody could authorize into it and no repair route
   exists.

### The request-supplied id

A browser must be able to say which workspace it wants, so `:workspaceId` in a
URL is fine. The invariant is narrow and absolute:

> The identifier is a lookup argument. The membership row is the authorization.

### Wrong workspace → 404, never 403

A 403 confirms the workspace exists, turning any endpoint into an oracle for
enumerating other tenants' ids. `404 {"error":"not_found"}` collapses "no such
workspace", "not yours" and "malformed id" into one indistinguishable answer.
A test asserts the foreign-workspace and nonexistent-workspace responses are
byte-identical.

### Roles

The locked `membership_role` enum (`operator` | `member`) from Step 3 is
preserved. The creator gets `operator` rather than the column default `member`.
No RBAC system, no permission checks — `role` is currently reported to the UI
and enforces nothing.

## Alternatives considered

**Trusting a selected-workspace cookie or `localStorage` value.** Rejected: the
browser would be asserting its own authorization. Anything client-held is
attacker-controlled. The frontend may remember a *selection*, but the server
re-proves membership on every call regardless.

**Binding one workspace into the auth session at sign-in.** Rejected — it
contradicts the explicit multi-workspace requirement, and would make switching
workspaces require re-authentication. It also revives the "current workspace"
state this architecture avoids.

**Relying on UUID unguessability.** Rejected for the same reason as ADR 0001:
identifiers are not capabilities.

**A global "current workspace" on the server.** Rejected: invisible in
signatures, unsafe under concurrency, and meaningless for background workers.

**Caching authorization decisions.** Deliberately not added. A membership lookup
is one indexed query; a cache keyed carelessly is a cross-tenant bug waiting to
happen. If added later, the key must include both user and workspace.

## Trade-offs

**Accepted costs**

- One membership query per workspace-scoped request. Bought deliberately: it is
  what makes revocation and role changes take effect immediately.
- Route handlers cannot construct a scope even when it would be convenient. That
  friction is the mechanism, not a side effect.
- 404-for-forbidden is slightly less informative to legitimate users who mistype
  an id. Worth it to remove the enumeration oracle.

**Gained**

- Cross-tenant access requires defeating both the membership join *and* Step 3's
  composite foreign keys.
- Multi-workspace users work naturally, with no session juggling.
- The bypass shape is mechanically detectable — a test fails if any
  `apps/**` file so much as calls `createWorkspaceScope`.

## Risks

| Risk | Mitigation |
| --- | --- |
| A future route authorizes once and reuses a scope across requests | Scope is request-local by construction; no cache exists. Reviewers should treat any stored scope as a defect |
| A future resolver reads workspaces without the membership join | `data-access-boundary` test asserts every select in `authorization.ts` is bounded by `userId`; the resolver export list is enumerated, so a new unscoped read must be added deliberately |
| CSRF on operator mutations | Origin guard + `SameSite=Lax`; see below |
| Role is reported but enforces nothing | Intentional today. Policy mutation (a later step) must gate on `operator` explicitly — nothing in Step 6 does that for it |
| Live behaviour unproven | Rollback and membership-uniqueness are only asserted against real PostgreSQL, and that suite is **SKIPPED** |

## CSRF — the Step 5 carry-forward

Step 5 deferred CSRF with an explicit trigger: revisit when authenticated
operator mutations arrive. `POST /v1/workspaces` is the first, so this is that
revisit.

**Two independent layers:**

1. `SameSite=Lax` — browsers withhold the session cookie from cross-site
   mutating requests, so a forged request arrives unauthenticated.
2. An **origin guard** on state-changing `/v1/*` requests, which does not depend
   on the browser honouring SameSite and also covers same-site-but-different-
   origin cases Lax permits (Lax is site-scoped; the guard is origin-scoped, so
   a sibling subdomain is rejected).

Rule: `Origin` present must be allowlisted; `Origin` absent is rejected **only
when the request carries the auth cookie** — no cookie means no ambient
authority to forge. That keeps non-browser clients working, and from Step 7 they
will authenticate with an explicit header the browser never attaches
automatically.

No CSRF token framework was added: with two layers and no cross-site mutating
routes, it would add machinery without closing a gap. **It becomes mandatory if
a split-origin deployment ever forces `SameSite=None`.**

## Migration strategy

**No schema migration.** Step 3 already defined `workspaces`,
`workspace_memberships` and the `membership_role` enum with the composite
primary key that prevents duplicate membership. Step 6 is application code over
existing tables.

One structural change inside `@hybrid/db`: `createWorkspaceScope` moved off the
package root. No application code imported it, so nothing broke.

## Future extension

- **Invitations, membership removal, ownership transfer** — none required by the
  Credit criteria; deliberately absent to avoid a generic membership CRUD
  surface.
- **Role enforcement** for policy mutation, in the step that owns policy.
- **PostgreSQL RLS** as a third layer, per ADR 0001.

## Acceptance criteria

1. A workspace and its creator membership are created atomically. ✅ (unit;
   **live rollback SKIPPED**)
2. Listing returns only the caller's memberships, bounded in SQL. ✅
3. A user cannot authorize a workspace they do not belong to, even holding its
   exact UUID. ✅
4. Foreign and nonexistent workspaces return byte-identical responses. ✅
5. One user can hold and independently authorize multiple memberships. ✅
6. No `apps/**` code can construct a `WorkspaceScope`. ✅ (export removed +
   source-scan test)
7. Cross-origin mutation with a valid session cookie is rejected. ✅ (unit +
   live HTTP)
8. New workspaces are never publicly visible. ✅
9. `/v1/auth/me` still returns identity only. ✅
10. Real PostgreSQL rollback and membership uniqueness proven.
    ❌ **BLOCKED** — no test database.
