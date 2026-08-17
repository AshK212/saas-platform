# Deployment

Status: **documentation and configuration only.**

> **Nothing has been deployed.** No Render service exists, no Neon database has
> been provisioned, and no connection to either has been attempted or verified
> from this repository. Everything below describes intent and the configuration
> committed to support it.

---

## Render

### Services

| Service | Type | Source | Status |
| --- | --- | --- | --- |
| `hybrid-api` | Node web service | `apps/api` | Not created |
| `hybrid-web` | Static site | `apps/web` | Not created |

A [`render.yaml`](../render.yaml) blueprint is committed at the repository root.
It is **unvalidated against Render** — it has never been applied. Its build and
start commands intentionally mirror the scripts that *are* validated locally, so
the risk is confined to Render's blueprint schema rather than to the commands
themselves.

### Node version

**Node 20** (`20.20.2`, pinned in [`.nvmrc`](../.nvmrc) and enforced by the
`engines` field). Set `NODE_VERSION=20.20.2` on both services.

> Node 20 reached end of life on 2026-04-30 and no longer receives security
> patches. The stack is locked to Node 20 for this phase; moving to an active
> LTS line should be raised with the client as a follow-up decision.

### API service

```text
Build command:  corepack enable && pnpm install --frozen-lockfile && pnpm run build:api
Start command:  pnpm run start:api
Health check:   /healthz
```

`pnpm run start:api` runs `node dist/index.js` in `apps/api`.

The server binds `HOST` and `PORT` from the environment. Render supplies `PORT`;
`HOST` must be set to `0.0.0.0` so the service is reachable outside its
container. Locally both default to `127.0.0.1:3000`.

### Web service

```text
Build command:  corepack enable && pnpm install --frozen-lockfile && pnpm run build:web
Publish path:   apps/web/dist
```

A rewrite of `/*` to `/index.html` is configured for client-side routing.

### Authentication and cookie deployment

**Serve the web app and the API under one hostname.** Same-site deployment means
no CORS, and `SameSite=Lax` session cookies work normally. A split-origin
deployment would require `SameSite=None; Secure`, which weakens the CSRF
posture — see [authentication.md](authentication.md).

Required on the API service for sign-in to work:

| Variable | Notes |
| --- | --- |
| `APP_URL` | Absolute https origin of the browser app. Builds the emailed link and is the only post-callback redirect destination |
| `RESEND_API_KEY` | Secret; `sync: false` in the blueprint |
| `AUTH_FROM_EMAIL` | Must be verified in the client's Resend account |
| `NODE_ENV=production` | Required for the `Secure` cookie attribute |

HTTPS is mandatory in production: without it the `Secure` cookie is never sent.

### Environment variables

Environment variables are the **only** channel for configuration and secrets.
Nothing sensitive is committed.

- Secrets are set in the Render dashboard, marked `sync: false` in the blueprint
  so their values never appear in Git.
- Only `VITE_`-prefixed variables reach the browser bundle. **Never place a
  secret behind a `VITE_` prefix** — it will be inlined into public JavaScript.
- See [`.env.example`](../.env.example) for the expected variable set.

### The public demo generator (AC-19)

The demo generator is a **third process**, not a service Render needs to route
traffic to. It runs the reference client in `demo` mode:

```
pnpm --filter @hybrid/simulator start demo
```

Deploy it as a Render **background worker**, not a web service — it listens on
no port and answers no request. It needs `CONTROL_PLANE_URL` and a workspace
API key in `CONTROL_PLANE_API_KEY` (a secret, `sync: false`), plus the
optional `DEMO_GENERATOR_INTERVAL_MS` and `DEMO_BLOCK_INTERVAL_MS`.

Three deployment notes that are easy to get wrong:

1. **It needs no database access and must not be given any.** The whole
   `@hybrid/db` package is blocked in that workspace by lint and by an
   architecture guard. Do not add `DATABASE_URL` to the worker.
2. **Recurring blocks depend on the demo workspace's policy**, not on the
   worker's configuration: `agent-a` must be `budgeted` with a daily spend cap
   below $41, set through the operator UI. If it is not, the worker runs
   happily and produces no blocks — and says so in its log.
3. **The worker runs until stopped.** It exits non-zero only on a rejected
   credential, which is deliberate: retrying forever against a key the plane
   will never accept is noise. Configure the restart policy accordingly, and
   treat a restart loop as "the key is wrong", not as flakiness.

Turning the demo **off** is an operator action in the product, not a
deployment action. Stopping the worker only stops new activity — the page stays
public until the toggle is switched.

### Health and readiness endpoints

| Endpoint | Purpose | Render usage |
| --- | --- | --- |
| `GET /healthz` | Liveness. Never touches the database. Always `200`. | Use as `healthCheckPath` **today**, while no database is required. |
| `GET /readyz` | Readiness. Runs `SELECT 1`. `200` ready / `503` otherwise. | Switch `healthCheckPath` to this **once the API genuinely requires the database** (Step 3+), so Render withholds traffic from an instance that cannot serve it. |

Both verified locally against the compiled server, with and without a database
configured. Neither is yet verified against a deployed Render service.

See [database.md](database.md) for the full liveness/readiness rationale.

### Ownership

Staging and production services must ultimately live under **Ashir's Render
account**, not a developer account. See
[client-delivery-status.md](client-delivery-status.md) — this is currently
**BLOCKED**.

---

## Neon

> Full database architecture, driver rationale and transaction-capability
> analysis live in **[database.md](database.md)**. This section covers
> deployment concerns only.

- **Neon PostgreSQL** is the database for the platform. It holds the
  authoritative governance state described in
  [architecture.md](architecture.md).
- **Ownership: the Neon project must be created under Ashir's account.** No
  Neon project has been created, and none was created under a developer account
  as a substitute.
- **`DATABASE_URL` is environment-only.** It is never committed, never
  hard-coded, and never read implicitly by `packages/db` — the connection string
  must be passed explicitly into `createDatabasePool()`.
- **Two connection strings, used for different things.** Neon issues a pooled
  (`-pooler`) endpoint and a direct one. Use **pooled for the running API** and
  **direct for migrations**, because DDL through a transaction-mode pooler is
  unreliable.
- **No credentials are committed.** `.env` and `.env.*` are gitignored;
  `.env.example` contains an empty `DATABASE_URL` placeholder.
- **Drizzle migrations will be checked into Git**, under
  `packages/db/migrations/`. That directory is deliberately *not* gitignored.
  It is currently empty: no schema exists yet, so no migration has been
  generated.
- **Actual database validation happens in the next database-foundation step
  (Step 2)**, which introduces environment validation for `DATABASE_URL`, the
  domain schema, and the first migration.

### Migration execution strategy

```bash
pnpm db:generate   # author: diff schema -> SQL. No credential needed.
pnpm db:check      # validate migration journal. No credential needed.
pnpm db:migrate    # apply pending migrations. REQUIRES DATABASE_URL.
```

**No migration credential is stored in Git or in CI.** CI runs only the offline
`db:check`. Applying migrations is a deploy-time action using the environment's
own `DATABASE_URL`.

#### Staging procedure

1. Merge the migration to `main`; CI must be green.
2. Run `pnpm db:migrate` against staging using Neon's **direct (unpooled)**
   connection string, supplied from Render's environment — as a one-off job or
   a pre-deploy step, never from a developer laptop against a shared database.
3. Confirm `GET /readyz` returns `200` with `{"database":"ok"}`.
4. Deploy the application.

#### Production caution

- **Migrations are forward-only.** Drizzle generates no automatic down
  migration; a mistake is corrected with a new forward migration.
- **Take a Neon branch or backup immediately before migrating.** Neon's
  branching makes this cheap and it is the only real rollback path.
- **Run migrations as a separate, gated step — never automatically on
  application boot.** Concurrent instances starting at once would race on DDL.
- **Expect-and-tolerate ordering:** deploy schema changes that are backward
  compatible with the running code first, then the code. This avoids downtime
  and keeps rollback viable.
- Migrations acquire locks; apply them during low-traffic windows once the
  platform carries real load.

**Status: no migration has ever been executed**, because no database exists.
`db:generate` and `db:check` have been run locally and pass; `db:migrate` has
been executed only to confirm it fails correctly when `DATABASE_URL` is absent.
