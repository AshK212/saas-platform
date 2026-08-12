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
