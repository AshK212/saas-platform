# Database Foundation

Status: **Step 2 — Environment validation + Neon/Drizzle infrastructure.**
No domain schema exists yet; that is Step 3.

---

## Stack

| Concern | Choice |
| --- | --- |
| Database | Neon PostgreSQL |
| Driver | `pg` (node-postgres) over TCP + TLS |
| ORM / migrations | Drizzle (`drizzle-orm`, `drizzle-kit`) |
| Runtime | Node 20 on Render (long-lived process) |

---

## Driver decision: why `pg`, not the Neon HTTP driver

Step 1 provisionally used `drizzle-orm/neon-http` with `@neondatabase/serverless`.
**That driver cannot support the Credit phase and has been replaced.**

This is not a theoretical concern. The installed driver source
(`drizzle-orm/neon-http/session.js`) contains:

```js
async transaction(_transaction, _config = {}) {
  throw new Error("No transactions support in neon-http driver");
}
```

Each statement over the HTTP driver is an independent request with no session
continuity, so there is no connection on which `BEGIN` … `COMMIT` could hold.
That rules out every enforcement primitive the Credit phase depends on:
interactive transactions, `SELECT … FOR UPDATE`, and `SERIALIZABLE` isolation.
`neon-http` offers only `batch()`, which is a non-interactive pipeline — it
cannot make a decision based on a value it just read.

Discovering this at the ledger step would have meant reworking the data layer
mid-feature. It was therefore fixed in the foundation.

### Why `pg` rather than the Neon WebSocket driver

`@neondatabase/serverless` also offers a WebSocket `Pool` that *does* support
transactions. It was not chosen because:

- The platform deploys to **Render as a long-lived Node process**, which can
  open ordinary TCP sockets. The Neon serverless driver exists for edge and
  serverless runtimes that cannot — a constraint we do not have.
- It would add a WebSocket proxy hop to every query, and a `ws` dependency,
  since Node 20 has no stable global `WebSocket`.
- `pg` is the reference PostgreSQL client with the broadest guarantees, and is
  a `drizzle-orm` peer dependency.

Neon accepts standard TCP+TLS connections, so this is a fully supported path.

---

## Transaction capability review

The Credit phase requires transaction-sensitive enforcement. Each capability
below is answered directly for the selected driver.

| Capability | Supported | Mechanism |
| --- | --- | --- |
| Interactive transactions | **Yes** | `db.transaction(async (tx) => …)` issues real `BEGIN`/`COMMIT`/`ROLLBACK` on a single pooled session. |
| Serializing concurrent cap decisions | **Yes** | `BEGIN ISOLATION LEVEL SERIALIZABLE`, or `SELECT … FOR UPDATE` on the budget row, or `pg_advisory_xact_lock` keyed by workspace. |
| Row-level locking | **Yes** | `SELECT … FOR UPDATE` / `FOR NO KEY UPDATE`, via Drizzle's `.for('update')`. |
| Atomic ledger update | **Yes** | Read balance, evaluate, and append the ledger entry inside one transaction. |
| Atomic precheck receipt creation | **Yes** | Decision and receipt commit together or not at all. |
| Atomic plane-owned block creation | **Yes** | Block and its receipt written in the same transaction. |
| Atomic policy version change | **Yes** | Supersede the old version and insert the new one in one transaction; PostgreSQL DDL and DML are both transactional. |

**Verified in code, not just asserted.** `packages/db/tests/client.test.ts`
asserts the Drizzle client exposes a `transaction` function. The live suite
(`neon-connectivity.live.test.ts`) additionally exercises a real `COMMIT`, a
real `ROLLBACK`, `SERIALIZABLE` isolation, and `pg_try_advisory_lock` — those
six tests are **skipped until a Neon credential is supplied**.

### Known limitations to respect in Step 3+

1. **Connection pooling mode.** Neon's pooled endpoint (`-pooler`, PgBouncer in
   transaction mode) is correct for the API, but session-scoped state does not
   survive across statements outside an explicit transaction. Session-level
   advisory locks (`pg_advisory_lock`) must therefore be **transaction-scoped**
   (`pg_advisory_xact_lock`) when running through the pooler.
2. **Migrations must use the direct (unpooled) endpoint.** DDL through a
   transaction-mode pooler is unreliable.
3. **`SERIALIZABLE` can raise serialization failures** (`40001`). Enforcement
   code must retry these; that retry policy belongs to the ledger step.
4. **Neon auto-suspend.** An idle project cold-starts on first connection,
   which can take a few hundred milliseconds. The readiness probe allows for
   this with a 5-second timeout, and the live suite with 20 seconds.
5. **Pool sizing.** `max` defaults to 10 per process. Total connections across
   Render instances must stay under the Neon plan limit.

---

## Environment configuration

`DATABASE_URL` is the only database configuration input.

- **Server-side only.** Read exclusively through `@hybrid/config/server`, which
  throws if imported in a browser context. ESLint additionally forbids
  `@hybrid/config/server` and `@hybrid/db` imports from `apps/web/src/**`.
- **Validated when present.** Must be a syntactically valid `postgres://` or
  `postgresql://` URL with a host. Validation errors never quote the value,
  because it contains a password.
- **No fallback, ever.** A missing value stays missing in every environment. It
  is never replaced with a localhost default.
- **Optional at startup.** See the liveness/readiness split below.
- **Never committed.** `.env` and `.env.*` are gitignored; `.env.example` holds
  an empty placeholder.

`packages/db` never reads `process.env` itself — a connection string must be
passed explicitly into `createDatabasePool()`, so a credential can never be
picked up implicitly.

---

## Liveness vs readiness

These are deliberately separate endpoints, because conflating them causes an
orchestrator to restart a healthy process during a database outage it cannot
fix.

| Endpoint | Question | Touches the database | Behaviour |
| --- | --- | --- | --- |
| `GET /healthz` | Is the process alive? | **Never** | Always `200 {"status":"ok"}` |
| `GET /readyz` | Can it serve database-backed traffic? | Yes, `SELECT 1` | `200` ready, else `503` |

`/readyz` response shape is fixed:

```json
{ "status": "ready" | "not_ready",
  "checks": { "database": "ok" | "unconfigured" | "unreachable" } }
```

`unconfigured` (a deployment gap) and `unreachable` (an outage) are reported
distinctly so whoever is paged is pointed at the right problem.

**No detail leaks to clients.** `/readyz` is typically unauthenticated, so the
body carries a status and nothing else — no error text, no host, no driver
message. Full diagnostics go to server-side logs with credentials redacted.

---

## Migration workflow

```text
packages/db/
  src/schema/        Drizzle table definitions  (empty until Step 3)
  migrations/        Generated SQL + meta/_journal.json  (checked into Git)
  drizzle.config.ts  drizzle-kit configuration
  src/migrate.ts     runtime migration runner
```

| Command | Needs `DATABASE_URL` | Purpose |
| --- | --- | --- |
| `pnpm db:generate` | No | Diff schema → new SQL migration |
| `pnpm db:check` | No | Validate migration journal consistency |
| `pnpm db:migrate` | **Yes** | Apply pending migrations |

Offline commands are usable — and CI-runnable — without any credential.
`drizzle.config.ts` guards the online commands and fails immediately with an
actionable message when `DATABASE_URL` is absent, instead of surfacing an opaque
driver error.

**`pnpm db:migrate` intentionally does not use `drizzle-kit`.** `drizzle-kit` is
a devDependency and a build-time tool; production deploys should not install dev
tooling to apply schema changes. `src/migrate.ts` uses Drizzle's runtime
migrator, needing only `drizzle-orm` and `pg`. It applies migrations inside a
transaction, uses a single connection to avoid concurrent DDL, and logs only the
redacted connection target.

### Current state

`pnpm db:generate` runs successfully and reports `0 tables` /
`No schema changes, nothing to migrate`. It has therefore produced
`migrations/meta/_journal.json` (an empty, valid journal) and **no SQL
migration** — because there is no schema to migrate yet.

No fake or placeholder domain table was created to manufacture a migration
artifact. The migration mechanism is proven — config loads, schema is read, the
journal is initialised, `db:check` passes — and the first real migration will be
generated in Step 3.
