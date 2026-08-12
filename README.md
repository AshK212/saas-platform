# AI Hybrid Multi-Agent Platform

Hosted control plane for governed multi-agent work.

**Current phase: Credit — Step 6, workspace + membership authorization.**
The platform provides the toolchain and build path, the database infrastructure,
the core relational schema with checked-in migrations, the workspace-scoped
data-access layer, and passwordless magic-link sign-in.

Business functionality beyond sign-in and workspace selection is intentionally
**not** implemented yet: no API keys, agents, events, policy, ledger, precheck,
sharing or demo. **Being signed in grants access to no workspace** — tenant
access comes only from a membership, re-proven on every request.

---

## Monorepo structure

```text
apps/
  api/           Control-plane API (Hono). Step 1: GET /healthz only.
  web/           Operator shell (React + Vite + Tailwind). Step 1: shell only.
  simulator/     Reference client. Step 1: executable skeleton only.

packages/
  contracts/     Shared transport/domain contracts (Zod).
  config/        Config boundary: browser-safe root, server-only subpath.
  db/            Neon PostgreSQL + Drizzle boundary. No domain schema yet.
  runtime-core/  Vendor-neutral runtime adapter boundary. Types only.

docs/            Architecture, deployment, acceptance and delivery status.
```

## Locked stack

Node 20 · TypeScript (strict) · pnpm workspaces · Hono · React · Vite ·
Tailwind CSS · Drizzle ORM · Neon PostgreSQL · Zod · Vitest · ESLint ·
Render.com

## Prerequisites

| Tool | Version |
| --- | --- |
| Node.js | **20** (`20.20.2`, pinned in `.nvmrc`; enforced by `engines`) |
| pnpm | **10.34.5** (pinned via `packageManager`; enable with `corepack enable`) |
| Git | any recent version |

pnpm 11 requires Node ≥ 22.13 and is therefore incompatible with the locked
Node 20 stack.

## Install

```bash
corepack enable
pnpm install
```

`pnpm-lock.yaml` is the only lockfile. Do not commit `package-lock.json` or
`yarn.lock`.

## Development

```bash
pnpm dev:api     # API with watch reload (http://127.0.0.1:3000)
pnpm dev:web     # Web app (http://localhost:5173)
```

The web app and the API both consume `@hybrid/contracts`, so run `pnpm build`
once after a fresh clone to produce the workspace packages' `dist/` output.

## Validation

```bash
pnpm lint        # ESLint across the workspace
pnpm typecheck   # tsc --build + web + test typechecking
pnpm test        # Vitest
pnpm build       # tsc --build + Vite production build
pnpm verify      # all of the above, in order, failing fast
```

`pnpm verify` is the complete local baseline and is the exact sequence CI runs.
It fails on any lint, type, test or build error.

## Health and readiness

```bash
pnpm build
pnpm start:api

curl http://127.0.0.1:3000/healthz   # liveness  - never touches the database
curl http://127.0.0.1:3000/readyz    # readiness - runs SELECT 1
```

```jsonc
// GET /healthz -> always 200
{ "status": "ok" }

// GET /readyz -> 200 when ready, 503 otherwise
{ "status": "not_ready", "checks": { "database": "unconfigured" } }
```

`/healthz` stays `200` even with no database configured or reachable; only
`/readyz` reflects dependency state. See [docs/database.md](docs/database.md).

## Database

```bash
pnpm db:generate   # author a migration from the Drizzle schema (no credential)
pnpm db:check      # validate the migration journal          (no credential)
pnpm db:migrate    # apply migrations                        (needs DATABASE_URL)
pnpm test:db       # live suites; skip without credentials
```

Neon PostgreSQL via `pg` over TCP, through Drizzle. 15 tables and one checked-in
migration (`0000_dusty_skullbuster.sql`). **The migration has never been applied
to a database** — no Neon project exists yet.

## Authentication

Passwordless magic-link sign-in. Requires `DATABASE_URL`, `APP_URL`,
`RESEND_API_KEY` and `AUTH_FROM_EMAIL`; without them the auth routes return
`503` and `/healthz` is unaffected.

```text
POST /v1/auth/magic-link   { email }   -> 200 { ok: true }   (identical for every valid address)
GET  /v1/auth/callback?token=...       -> 302, sets HttpOnly session cookie
GET  /v1/auth/me                       -> 200 { user: { id, email } } | 401
POST /v1/auth/logout                   -> 200, revokes the session server-side
```

Tokens are 256-bit and stored only as SHA-256 hashes; magic links are single-use
and expire in 15 minutes. **Signing in authorizes no workspace** — see
[docs/authentication.md](docs/authentication.md) and
[ADR 0002](docs/adr/0002-authentication.md).

## Workspaces

```text
POST /v1/workspaces        { name }  -> 201 { workspace: { id, name, role } }
GET  /v1/workspaces                  -> 200 { workspaces: [...] }   only your memberships
GET  /v1/workspaces/:id              -> 200 { workspace } | 404
```

All three require authentication. Creation also requires an allowed `Origin`
(CSRF guard) and makes the creator an `operator` member in the same transaction.

**A workspace id in a request is a lookup argument, not authorization.**
Membership is re-proven in SQL on every call, so holding another tenant's UUID
returns `404` — identical to a workspace that does not exist. See
[ADR 0003](docs/adr/0003-operator-workspace-authorization.md).

### Tenant isolation

Tenant-owned data is reachable only through workspace-scoped repositories:

```ts
const scope = createWorkspaceScope(workspaceId);   // from a trusted resolver
const agents = createAgentRepository(db, scope);   // or (tx, scope)
await agents.findByExternalId('agent-1');          // WHERE workspace_id = ... AND external_id = ...
```

Raw schema tables are not exported from `@hybrid/db`, and ESLint blocks
application code from importing `@hybrid/db/schema` or `drizzle-orm`. See
[ADR 0001](docs/adr/0001-workspace-isolation.md).

### Live database tests

| Variable | Used by | Writes data |
| --- | --- | --- |
| `DATABASE_URL` | read-only connectivity + transaction checks | no |
| `TEST_DATABASE_URL` | cross-tenant isolation + live auth suites | yes — always rolled back |

The isolation suite **never** falls back to `DATABASE_URL`. Point
`TEST_DATABASE_URL` at a throwaway database or Neon branch, never production.

## Environment setup

```bash
cp .env.example .env
```

`.env.example` contains placeholders only — never real secrets. `.env` and
`.env.*` are gitignored. Secrets are supplied at runtime through environment
variables, never through Git.

Only `VITE_`-prefixed variables reach the browser bundle; never place a secret
behind that prefix.

## Documentation

- [Architecture](docs/architecture.md) — foundation, boundaries and invariants
- [Authentication](docs/authentication.md) — magic-link flow, cookies, CORS, limits
- [ADR 0001](docs/adr/0001-workspace-isolation.md) · [ADR 0002](docs/adr/0002-authentication.md) · [ADR 0003](docs/adr/0003-operator-workspace-authorization.md)
- [Database](docs/database.md) — driver choice, transactions, migrations, readiness
- [Deployment](docs/deployment.md) — Render and Neon direction
- [Acceptance traceability](docs/acceptance-traceability.md) — AC-01 … AC-21 status
- [Client delivery status](docs/client-delivery-status.md) — contractual obligations

## Scope notice

The following are **deliberately absent** in Step 1: authentication and magic
links, email, workspaces and memberships, API keys and API authentication,
agents, events, timelines, policies, ledger, prechecks, receipts, blocks, pause
and spend enforcement, share links, the public demo, simulator scenarios, and
any Hermes/OpenClaw runtime integration.

Each belongs to a later step. See
[acceptance-traceability.md](docs/acceptance-traceability.md) for per-criterion
status.
