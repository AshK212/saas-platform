# Architecture

Status: **Step 1 — Production Foundation.** This document records the foundation
as built and the boundaries that later steps must not violate.

---

## Product

Hosted **AI Hybrid Multi-Agent Platform**.

## Current Credit objective

Deliver the **governance / control-plane foundation** with the minimum
hybrid-safe runtime boundaries required to keep runtime implementations
replaceable later. The Credit phase is not an agent-execution product.

---

## Core architecture direction

```text
Web / Operator
       |
       v
Control Plane API
       |
       +--> PostgreSQL authoritative state
       |
       +--> Runtime Adapter Boundary
                  |
                  +--> future runtime implementations
```

---

## THE PLANE IS THE LEDGER; THE PLUGIN IS THE HANDS.

This is the governing invariant of the platform. Everything below is a
consequence of it.

### The control plane owns

- **Governance** — who may act, in which workspace, under what constraints.
- **Policy** — caps, budgets, pauses, publish limits, and every rule that gates
  an action.
- **Authoritative accounting** — spend, counts, and balances. Authoritative
  figures are *derived by the plane*, never accepted as a claim from a runtime.
- **Receipts, blocks and audit** — the durable, tamper-evident record of what
  was allowed, what was denied, and why.

### Runtime implementations

- Are **replaceable**. Any adapter can be swapped without changing governance.
- **Cannot mutate or bypass governance.** An adapter may be *told* to execute
  work; it may never decide whether that work is permitted, write to the ledger,
  emit a receipt or block, or persist authoritative state.
- Are given a workspace; they never choose, widen or infer one.

### The workspace boundary is mandatory

Every session, task and record is scoped to exactly one workspace. Cross-tenant
access is a defect, not a configuration option. Automated cross-tenant coverage
is tracked as AC-20.

As of Step 3 this is enforced **structurally in PostgreSQL**, not only by
convention: every reference between tenant-owned rows is a composite foreign key
anchored on `workspace_id`. See [Tenant hierarchy](#tenant-hierarchy) below and
[database.md](database.md) for the full constraint matrix.

### Hermes / OpenClaw

Future Hermes and OpenClaw adapters are **not Credit functionality**. They are
downstream consumers of the `RuntimeAdapter` seam. No vendor type, SDK or
concept may enter `packages/runtime-core` — doing so breaks the replaceability
guarantee the package exists to provide.

> **Enforcement of these invariants is not implemented in Step 1.** They are
> recorded here as architecture constraints binding on later steps.

---

## Monorepo layout

```text
apps/
  api/           Control-plane API (Hono). /healthz + /readyz, composition skeleton.
  web/           Operator shell (React + Vite + Tailwind). Step 1: shell only.
  simulator/     Reference client. Step 1: executable skeleton only.

packages/
  contracts/     Shared transport/domain contracts (Zod).
  config/        Configuration boundary; browser-safe root, server-only subpath.
  db/            Neon PostgreSQL + Drizzle boundary. No domain schema yet.
  runtime-core/  Vendor-neutral runtime adapter boundary. Types only.
```

The database foundation — driver choice, transaction guarantees, migration
workflow and the liveness/readiness split — is documented separately in
[database.md](database.md).

---

## Tenant hierarchy

```text
User (global identity, no workspace_id)
  |
  +-- WorkspaceMembership --> Workspace  (the tenant boundary)
                                |
                                +-- ApiCredential      (hash + prefix only)
                                +-- ShareToken         (hash + prefix only)
                                +-- RuntimeProfile
                                |     |
                                +-- Agent  --------------+
                                |     |                  |
                                |     +-- Session -- Task|
                                |     +-- AgentPolicy    |
                                |     +-- LedgerDaily    |  (workspace, agent, UTC day)
                                |     +-- PrecheckReceipt|
                                |     +-- Block ---------+  (-> PrecheckReceipt)
                                |
                                +-- WorkspacePolicyState  (version counter)
                                +-- Event  (-> Agent, PrecheckReceipt, Block)
```

Users are the only global entity: one human, one identity, many workspaces.
Tenant scoping is a property of membership, never of the user record.

### Workspace scoping

Every tenant-owned table carries a `NOT NULL workspace_id`. Step 4 will add the
repository layer that scopes every query by it. The schema does not depend on
that layer being correct.

### Two authentication domains (Step 7)

```text
OPERATOR (browser)                    AGENT (machine)
Session cookie                        Authorization: Bearer <key>
   -> AuthenticatedUser                  -> credential row
   -> membership (SQL)                   -> credential.workspace_id
   -> AuthorizedWorkspace                -> WorkspaceScope
   -> WorkspaceScope
```

They are never interchangeable: a bearer key cannot manage credentials or reach
`/v1/auth/me`, and a session cookie cannot authenticate an agent request. Both
directions are asserted by tests.

> **The caller never selects the workspace for an API-key-authenticated
> request.** It comes from `api_credentials.workspace_id` on the matched row. A
> `workspace_id` in a body, query string, header or path is ignored.

> **API-key callers may never mutate policy.** Policy changes happen only
> through authenticated operator flows. The same prohibition applies to share
> links and the public demo.

Details: [api-authentication.md](api-authentication.md).

### Operator authorization chain (Step 6)

```text
Auth Session
    |
    v
AuthenticatedUser          identity only - no workspace, role or permission
    |
    v
Membership Authorization   authorizeWorkspaceForUser(executor, userId, workspaceId)
    |                      membership proven by SQL join on every request
    v
AuthorizedWorkspace        safe metadata + role + trusted scope
    |
    v
WorkspaceScope
    |
    v
Tenant Repository
```

Two rules govern this chain:

> **`workspace_id` from a request is NOT authorization.**
> It is a lookup argument. The membership row is the authorization.

> **Membership must be validated at every workspace authorization boundary.**
> There is no cached grant, no session-bound workspace and no server-side
> "current workspace". A user may belong to many workspaces, and each is
> authorized independently, on every call.

`createWorkspaceScope` is deliberately **not exported** from `@hybrid/db`, so an
HTTP handler cannot mint a scope from request input. The only way to obtain one
is `authorizeWorkspaceForUser`, which requires a membership row to exist. A test
fails if any file under `apps/` so much as calls the raw constructor.

A workspace the caller cannot reach returns **404, never 403** — a 403 would
confirm the workspace exists and turn the endpoint into an enumeration oracle.

Full reasoning: [ADR 0003 — Operator Workspace Authorization](adr/0003-operator-workspace-authorization.md).

### The four read authorities (Steps 6, 7, 21, 22)

Four different callers can end up holding a `WorkspaceScope`. Their inputs
differ completely; the shape of the resolution does not.

| Authority | Input | Scope derived from | Added |
| --- | --- | --- | --- |
| Operator session | session cookie | membership row | Step 6 |
| Machine credential | `Authorization: Bearer` | `api_credentials` row | Step 7 |
| Share token | exchanged token → scoped cookie | `workspace_shares` row | Step 21 |
| Public demo | slug in the path | `workspaces` row + `demo_enabled` | Step 22 |

> **In every one of the four, the scope comes from a row the SERVER matched —
> never from request input.** That is the single property that makes tenant
> isolation an invariant rather than a habit, and it is why a new read surface
> can be added without re-arguing isolation each time.

The three non-operator authorities are progressively weaker, and the type system
carries the difference rather than a comment. A machine credential authorizes
four routes. `ReadOnlyShareContext` and `ReadOnlyDemoContext` carry **no user,
no role and no permission set**, and neither is an `AuthorizedWorkspace` — so
they cannot be passed to a mutating store, because every mutating store requires
one. "A demo visitor writes something" is not a bug that was tested for and
found absent; it is a sentence that does not typecheck.

The two public surfaces differ in one respect that matters. A **share token is a
bearer secret** — 256 bits, hashed at rest, shown once, kept out of URLs. A
**demo slug is a public locator** — it is meant to be printed in a deck, so it
is stored in plaintext and appears in the path, and the authorization is the
`demo_enabled` predicate in the resolving statement instead. Applying the token
discipline to a slug would be ceremony; applying the slug reasoning to a token
would be a breach. See [sharing.md](sharing.md) and [demo.md](demo.md).

### Application-layer scoping (Step 4)

Tenant-owned data is reachable only through workspace-bound repositories:

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

- **Explicit scope.** Every repository factory takes `(executor, scope)`; no
  method accepts a workspace id, so no caller can re-target another tenant.
- **No ambient scope.** No global, no singleton, no environment variable, and
  AsyncLocalStorage is not used as an enforcement mechanism. Scope is an
  argument, so it is visible in review and safe under concurrency.
- **A UUID is not authorization.** Ids leak through logs, URLs and support
  tickets. Every lookup is workspace-qualified even when the id is globally
  unique.
- **Wrong workspace is "not found".** A row in another workspace returns `null`,
  identical to a row that does not exist. No `EXISTS_IN_ANOTHER_WORKSPACE`
  signal is ever produced.
- **Transaction-compatible.** Repositories accept a pooled client or a
  transaction handle, so the ledger step can run scoped reads inside the same
  transaction that locks the ledger row.
- **Resolvers are the only unscoped reads.** They establish scope and are each
  bounded by an authenticated `user_id` or by `demo_enabled = true`.

Full reasoning, alternatives and risks:
[ADR 0001 — Workspace Isolation](adr/0001-workspace-isolation.md).

### Composite foreign-key defence

Where a tenant-owned row references another, the foreign key is composite:

```text
child(workspace_id, parent_id)  ->  parent(workspace_id, id)
```

Each parent therefore carries a `UNIQUE (workspace_id, id)` constraint purely to
serve as that target. The effect is that an event in workspace A referencing an
agent in workspace B is **rejected by PostgreSQL**, not merely avoided by
application code.

**These constraints do not replace query scoping.** A foreign key constrains
*relationships*; it does nothing whatsoever to:

```sql
SELECT * FROM events;
```

which happily returns every tenant's rows. The two layers address different
failure modes and both are mandatory:

| Layer | Prevents | Does not prevent |
| --- | --- | --- |
| Composite foreign keys | invalid cross-workspace *relationships* | unscoped reads |
| Repository scoping | unscoped *reads and writes* | a malformed relationship written with a valid-looking pair |

Concluding that either one makes the other unnecessary is the most likely way
this architecture would be eroded.

### Audit record preservation

Events, precheck receipts, blocks and ledger rows are audit-critical. Every
foreign key from them uses `ON DELETE RESTRICT`, so history cannot vanish
because an agent or membership changed. Cascading deletes exist only on three
pure link/config tables (`workspace_memberships`, `workspace_policy_state`,
`agent_policies`). Credentials and share tokens are revoked with a timestamp
rather than deleted.

### UTC ledger day

The ledger is keyed by `(workspace_id, agent_id, day)` where `day` is a
PostgreSQL `date` representing the **UTC** accounting day. Local-time daily
boundaries are never stored, and the column is mapped as a string so a
JavaScript `Date` cannot shift it into the server's local zone.

### Decimal money representation

All USD values are `numeric(14, 6)` — fixed precision, never floating point,
surfaced to JavaScript as a string. Scale 6 keeps micro-dollar per-call AI costs
from being rounded away.

### Immutable historical receipts

A precheck receipt must explain its own decision forever. It therefore snapshots
the policy version, the *applied* mode and caps, the ledger state read at
decision time, and the remaining headroom. Explaining an old decision never
requires reading today's mutable policy. Receipts are insert-only, which is why
the receipt↔block foreign key is modelled once, on the block.

> Tables existing does not mean features exist. No repository, query, ingest
> path or enforcement rule is implemented — see
> [acceptance-traceability.md](acceptance-traceability.md).

### Dependency direction

Applications depend on packages. Packages never depend on applications, and
never on each other except through explicit, declared workspace dependencies.
There are no circular dependencies.

```text
apps/api        -> @hybrid/contracts, @hybrid/config, @hybrid/db
apps/web        -> @hybrid/contracts
apps/simulator  -> @hybrid/contracts
packages/config -> (zod only)
packages/db     -> @hybrid/config, drizzle-orm, pg
packages/runtime-core -> (nothing)
```

`packages/db` depends on `@hybrid/config` only for its migration CLI, so there
is exactly one environment-validation path in the repository. `@hybrid/config`
does not depend on `@hybrid/db`, so no cycle exists.

`packages/runtime-core` has **zero runtime dependencies** by design.

---

## Security boundaries established in Step 1

| Boundary | Mechanism |
| --- | --- |
| Server secrets must not reach the browser | `@hybrid/config` root export is browser-safe; all `process.env` access is behind the separate `@hybrid/config/server` subpath, which throws if imported in a browser context. |
| Browser code cannot import server config or the database | ESLint `no-restricted-imports` blocks `@hybrid/config/server` and `@hybrid/db` from `apps/web/src/**`. |
| Credentials never enter Git | `.gitignore` excludes `.env`, `.env.*` (except `.env.example`), key material and secret files. `.env.example` holds placeholders only. |
| Database access is constructed in one place | `createDatabasePool()` is the only driver construction site, and it never reads `process.env` itself — the connection string must be passed in. |
| Dependency failures do not leak to clients | `/readyz` returns a fixed status enum only. Driver messages and hosts stay in server-side logs, with credentials redacted by `redactConnectionStrings()`. |

---

## TypeScript foundation

`tsconfig.base.json` enables `strict` plus the modern safety options:
`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`,
`noImplicitReturns`, `noFallthroughCasesInSwitch`,
`noPropertyAccessFromIndexSignature`, `noUnusedLocals`, `noUnusedParameters`,
`verbatimModuleSyntax`, `isolatedModules`.

There is no `any` in the codebase and no rule was weakened to make compilation
pass. One narrowing cast exists, in `packages/config/src/server.ts`, documented
inline: the server package deliberately does not load the DOM lib, so `window`
is narrowed explicitly for the browser-context guard.

### Build graph

The root `tsconfig.json` is a solution file driving `tsc --build` over the
packages, the API and the simulator via project references, so build order is
derived from the dependency graph rather than hand-maintained.

Two projects sit outside that graph on purpose:

- `apps/web` — Vite owns the build; `tsc` is used only for typechecking.
- `tsconfig.tests.json` — typechecks test files with `noEmit`, so tests can
  never be emitted into any package's published `dist/`.

### Linting

ESLint uses the TypeScript parser and TypeScript-specific rules, but not the
type-checked rule sets. Type correctness is already enforced end to end by
`tsc --build` under a strict config, so type-aware linting would duplicate that
work while adding project-service wiring to maintain per package. It can be
enabled later without touching a single source file.

There are no blanket suppressions. The only inline disables in the repository
are two `no-console` exemptions on process entry points, each with a reason.

---

## Deliberately not implemented in Step 1

Authentication and magic links, Resend email, users/workspaces/memberships
schema, API key issuance, API authentication, agents, events, `POST /v1/events`,
timelines, policies and policy mutation, ledger, precheck API, receipts, blocks,
pause logic, publish/spend enforcement, share links, public demo, demo
generator, simulator event streams, Hermes/OpenClaw integration, routing,
delegation, skills, persistent memory, orchestration, and dashboard
functionality.

These belong to their own steps. See
[acceptance-traceability.md](acceptance-traceability.md) for per-criterion
status.
