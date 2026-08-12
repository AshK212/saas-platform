# AI Hybrid Multi-Agent Platform

Hosted control plane for governed multi-agent work.

**Current phase: Credit — Step 2, Neon/Drizzle database foundation.**
Business functionality is intentionally **not** implemented yet. This repository
currently proves the toolchain, the workspace boundaries, the build path and the
database infrastructure. There is no domain schema — that is Step 3.

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
pnpm test:db       # live Neon suite; skips without DATABASE_URL
```

Neon PostgreSQL via `pg` over TCP, through Drizzle. The schema is empty until
Step 3, so no SQL migration exists yet.

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
