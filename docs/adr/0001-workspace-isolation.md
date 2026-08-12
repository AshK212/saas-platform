# ADR 0001 — Workspace Isolation

- **Status:** Accepted
- **Date:** 2026-08-12
- **Phase:** Credit — Step 4

---

## Problem

How do we ensure every tenant-owned read and write remains workspace-scoped?

Cross-tenant leakage is release-blocking. The failure mode is not exotic — it is
one forgotten `WHERE` clause:

```ts
db.select().from(events)                 // every tenant's events
db.query.events.findMany()               // every tenant's events
findAgentById(agentId)                   // any tenant's agent
```

Each looks reasonable in review. The platform is a governance control plane, so
a single leak of another tenant's spend, policy or audit history is a
product-ending defect rather than a bug to patch later.

The design must make the unsafe version **hard to write**, not merely
discouraged.

---

## Decision

Three layers, all required:

1. **An explicit, trusted `WorkspaceScope`.** A branded value carrying exactly
   one `workspaceId`, produced only by `createWorkspaceScope()` after a trusted
   resolver has established ownership. It holds no permissions, no user, no
   credential and no request.

2. **Workspace-bound repositories.** Tenant-owned data is reachable only through
   `packages/db/src/repositories/`. Every factory takes `(executor, scope)` and
   returns methods already bound to that workspace. No method accepts a
   workspace id, so no caller can re-target another tenant. There is no
   tenant-free variant of any method and no escape hatch.

3. **Database composite constraints (Step 3).** Every reference between
   tenant-owned rows is a composite foreign key
   `child(workspace_id, parent_id) -> parent(workspace_id, id)`.

Scope travels as an **explicit argument**. There is no ambient tenant state —
no global, no singleton, no environment variable, and AsyncLocalStorage is not
used as an enforcement mechanism.

```text
Trusted auth / resolver
        |
        v
WorkspaceScope            (branded; workspaceId only)
        |
        v
Workspace-bound Repository
        |
        v
Drizzle / PostgreSQL
        |
        +--> WHERE workspace_id = scope.workspaceId
        |
        +--> composite workspace foreign keys
```

### The trust boundary

A scope is created **only** after ownership is proven:

| Flow | Workspace derived from |
| --- | --- |
| Operator / dashboard | authenticated membership |
| API key | the credential record |
| Read-only share | the share token record |
| Public demo | the demo slug, with `demo_enabled = true` |

A `workspace_id` in an HTTP body or query string is **not** authorization. No
route may accept one and turn it into a scope. None of these resolvers exist
yet; Step 4 defines the shape they must produce.

### Resolvers vs repositories

| | `resolvers/` | `repositories/` |
| --- | --- | --- |
| Purpose | establish which workspace a caller may enter | operate inside one workspace |
| Scope | cannot require one (it is the output) | always required |
| Bound by | a single authenticated `user_id`, or `demo_enabled = true` | `workspace_id` |

`users` is a **global** table — one human, many workspaces — and must never be
treated as tenant-owned. Asking "which workspaces does this user belong to?"
legitimately spans workspaces; that is identity resolution, not tenant business.

---

## Alternatives considered

**Global / ambient tenant state** (module singleton, `setCurrentWorkspace()`).
Rejected: invisible in repository signatures, so review cannot see whether a
call is scoped, and it breaks under concurrency — two requests for different
tenants in the same process can interleave. A background worker or the simulator
would have no natural place to set it.

**AsyncLocalStorage as the enforcement mechanism.** Rejected as the *only*
mechanism for the same reason: scope stays invisible at the call site, and a
missing context yields a silent wrong answer rather than a compile error. It
remains viable later as an ergonomic *carrier* that still hands an explicit
scope to repositories.

**Relying on UUID unguessability.** Rejected outright. UUIDs are identifiers,
not capabilities. Ids leak through logs, URLs, exports, support tickets and
error messages, and an id obtained by any means would grant cross-tenant read.

**Relying only on composite foreign keys.** Rejected — and this is the most
seductive error. A foreign key constrains *relationships*; it does nothing to
`SELECT * FROM events`. Step 3's constraints prevent invalid links, not
unscoped reads. See "Defence in depth" below.

**Database-per-tenant.** Rejected for this phase: strong isolation, but
migration fan-out across N databases, connection-pool exhaustion on Neon,
cross-tenant operator reporting becomes hard, and onboarding requires
provisioning. Disproportionate to Credit scope.

**PostgreSQL Row-Level Security.** Deferred — see below.

---

## Trade-offs

**Accepted costs**

- Every tenant-owned call site passes a scope. Slightly more verbose; that
  verbosity is the point, since it makes an unscoped call visible in review.
- Concrete named methods instead of generic CRUD means new access patterns
  require a new repository method rather than an ad-hoc query. This is also the
  mechanism that stops event ingest, a share link or the public demo from ever
  acquiring a generic "update anything" capability that could mutate policy.
- Query scoping is a convention enforced by code review, lint and tests — not by
  the type system alone. A determined author can still cast around it.

**Gained**

- Unsafe access requires deliberate effort and trips a lint error.
- Repositories work identically inside a transaction, so the ledger step can
  reuse them without redesign.
- Two independent layers must both fail for a leak to occur.

---

## Risks

| Risk | Mitigation |
| --- | --- |
| A future repository method forgets the workspace predicate | `tenant-scoping.test.ts` renders the real SQL of every query and asserts `workspace_id` participates; `data-access-boundary.test.ts` asserts every `.select()` in a repository file pairs with a scope predicate |
| Application code bypasses repositories | ESLint blocks `@hybrid/db/schema` and `drizzle-orm` imports in `apps/**`; raw tables are not re-exported from the package root |
| Someone adds an escape hatch under deadline | Tests assert no export named `unsafeDb`, `withoutWorkspace`, `allTenants`, `adminQuery`, … |
| A scope is built from user input | Documented trust boundary; `findMembership` exists to be the check that precedes it. **Not yet mechanically enforced** — no auth layer exists |
| Isolation is only proven structurally, not at runtime | Live suite exists and is currently SKIPPED for want of a database — see Acceptance criteria |

---

## Migration strategy

Nothing to migrate. Step 4 adds a data-access layer over the Step 3 schema; no
table, constraint or migration changed, and no runtime behaviour existed to
break. The only structural change is that raw schema tables moved off the
`@hybrid/db` root export to the `@hybrid/db/schema` subpath, which no
application code was using.

Future feature steps add repository methods; they must not add unscoped ones.

---

## Future extension

**PostgreSQL Row-Level Security** is the natural third layer and is
*deliberately not* introduced now. RLS would push isolation into the database
itself, surviving even an application bug. It also brings:

- per-connection session context (`SET LOCAL app.workspace_id`), which interacts
  awkwardly with PgBouncer transaction pooling on Neon;
- privileged-role bypass questions (`BYPASSRLS`, table owners);
- migration and background-job complexity;
- a testing burden of its own.

RLS is a **defence-in-depth addition**, never a substitute for explicit
repository scoping. If adopted, the repository layer stays exactly as it is.

Also deferred: an ergonomic scope carrier for HTTP handlers, and per-workspace
connection roles.

---

## Acceptance criteria

Step 4 architecture is accepted when all of the following hold:

1. Every tenant-owned data-access method requires a `WorkspaceScope`. ✅
2. Every tenant-owned query emits `workspace_id` in its predicate, proven
   against real compiled SQL. ✅ (37 assertions)
3. No public tenant-bypass helper exists. ✅ (asserted by test)
4. Raw schema tables are not reachable from the `@hybrid/db` root export, and
   application code cannot import them. ✅ (ESLint, verified to fire)
5. A wrong-workspace lookup returns `null`, indistinguishable from "not found",
   leaking no existence signal. ✅
6. Repositories accept both a pooled client and a transaction handle. ✅ (type
   level; exercised for real in the live suite)
7. No ambient tenant state exists. ✅ (asserted by test)
8. Destructive live tests gate on `TEST_DATABASE_URL` and never fall back to
   `DATABASE_URL`. ✅ (asserted by test, and verified by running with
   `DATABASE_URL` set — the suite still skipped)
9. Real PostgreSQL cross-tenant isolation is proven end to end.
   ❌ **BLOCKED** — no authorized test database. Suite written and skipping.

Criterion 9 is the sole outstanding item and is blocked on the client, not on
implementation.
