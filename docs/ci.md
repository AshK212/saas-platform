# Continuous Integration (AC-21)

> **AC-21** — "CI green on `main`."

One workflow, [`.github/workflows/ci.yml`](../.github/workflows/ci.yml), with two
jobs. It verifies; it does not deploy.

---

## What each job proves

| Job | Proves | Needs a credential |
| --- | --- | --- |
| `verify` | Lint, typecheck, the whole in-process suite, production builds of every app, and that the committed migrations match the schema | No |
| `integration` | That **PostgreSQL itself** enforces tenant isolation, exactly-once accounting and lock serialization | No — it starts its own disposable database |

The split is not organisational tidiness. `verify` needs no secret and no
service, so it runs identically on a fork's pull request. `integration` needs a
database, and until Step 24 the project had no way to run one — which is why 236
live tests had never executed anywhere.

---

## Triggers

```yaml
push:         branches: [main]
pull_request: branches: [main]
workflow_dispatch:
```

`workflow_dispatch` exists so an operator can re-run the gate during client
verification without inventing a commit.

Superseded runs are cancelled **except on `main`**:

```yaml
cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}
```

`main`'s green run is the AC-21 evidence. A cancelled run is not a pass, so
blanket cancellation would quietly destroy the artifact the criterion asks for.

---

## Reproducibility

| Thing | Pinned by | Value |
| --- | --- | --- |
| Node | `.nvmrc`, read via `node-version-file` | `20.20.2` |
| pnpm | `packageManager` in `package.json`, read by `pnpm/action-setup` | `10.34.5` |
| PostgreSQL | the service image tag | `postgres:17` |
| Dependencies | `pnpm install --frozen-lockfile`, in **both** jobs | the lockfile |

Nothing floats. There is no `node-version: latest`, no `postgres:latest`, and no
bare `pnpm install` — a `package.json` edited without regenerating the lockfile
must fail the install rather than resolve to something new.

Only three actions are used, all first-party: `actions/checkout`,
`actions/setup-node`, `pnpm/action-setup`. Caching goes through `setup-node`'s
`cache: pnpm` rather than restoring `node_modules` directly, because a blindly
restored `node_modules` can survive a lockfile change and make a broken
dependency graph look fine.

---

## The static gate

```
pnpm install --frozen-lockfile
pnpm run verify      # lint -> typecheck -> test -> build
pnpm run db:drift
pnpm run db:check
```

`pnpm verify` is the repository's own canonical validation command, used as-is
rather than re-listed step by step. Re-listing would let CI and local
development drift apart; using the script means they cannot.

Because `verify` reaches `vitest run` with no path filter, every suite is
included by construction — the AC-18 sharing tests, the AC-19 demo tests, the
AC-20 HTTP and compiled-SQL isolation tests, every architecture guard, the
reference-client tests and the demo-generator tests. A path filter here is how
those would have been quietly dropped, so the CI contract test asserts there
isn't one.

### Two different schema checks

They are not redundant.

`db:check` (drizzle-kit) validates that the migration **journal** is internally
consistent — ordering, hashes, no contradictory entries.

`db:drift` runs the generator and requires that it changed nothing. This catches
the case `db:check` structurally cannot see: a schema edited in TypeScript whose
migration was never generated. The journal is untouched and therefore still
consistent, so `db:check` says "Everything's fine" while the DDL for a new
column does not exist anywhere. That surfaces at deploy time, or in an
unreviewed production migration.

`db:drift` **never commits anything**, and restores the working tree when it
fails. A generated migration names constraints, orders DDL and can silently drop
a column; CI proposing schema changes on the author's behalf is how an
unreviewed destructive migration reaches `main`. It prints the diff and tells the
author to run `pnpm db:generate` and review the result.

---

## The integration job

```yaml
services:
  postgres:
    image: postgres:17
    env:
      POSTGRES_USER: hybrid_ci
      POSTGRES_PASSWORD: hybrid_ci
      POSTGRES_DB: hybrid_ci
    options: >-
      --health-cmd "pg_isready -U hybrid_ci -d hybrid_ci"
      ...
```

Disposable credentials for a container that lives and dies inside the job. Not
secrets, not reused, never a client value. Readiness is a health check, not a
`sleep`, so a slow container cannot flake the run.

Then:

1. `pnpm run db:migrate` — applies the committed migrations to the fresh
   database.
2. `pnpm run test:db:ci` — runs the live suites and asserts they executed.

### One suite is deliberately excluded

`test:db:ci` uses [`vitest.live.ci.config.ts`](../vitest.live.ci.config.ts),
which is the local live config plus a single exclusion:
`neon-connectivity.live.test.ts`.

That suite is the Step 2 probe for the **production** database. It gates on
`DATABASE_URL` rather than `TEST_DATABASE_URL` and asks questions about the
deployed Neon endpoint. CI has no Neon — it has a disposable container, and
`DATABASE_URL` is scoped to the migration step — so in CI that suite would skip,
and the integration job's contract is that nothing skips.

The two tempting fixes are both wrong. Setting `DATABASE_URL` for the test step
breaks the invariant every live suite depends on, for the sake of one
non-behavioural probe. Pointing the probe at the container makes it report "Neon
connectivity: OK" having contacted something that is not Neon, which is worse
than not running it.

So CI runs **230 live tests** and does **not** verify Neon-specific
connectivity. That stays a staging-time check, listed under known gaps below.

The obvious hazard — a standalone second config drifting from the first, so CI
silently stops collecting a suite — is covered by a contract assertion that the
two `include` globs are identical and that nothing beyond Neon connectivity is
excluded.

### Why `DATABASE_URL` appears at all

The migration runner reads `DATABASE_URL` by contract: it is the same command a
deploy would use, and pointing it at a different variable purely for tests would
mean CI exercised a code path production does not have.

So `DATABASE_URL` is set **at step scope**, on the migration step alone:

```yaml
- name: Apply migrations to the disposable database
  env:
    DATABASE_URL: postgresql://hybrid_ci:hybrid_ci@localhost:5432/hybrid_ci
  run: pnpm run db:migrate
```

It therefore does not exist in the environment of the test step. The invariant
every live suite depends on — **live tests read `TEST_DATABASE_URL` and never
fall back to `DATABASE_URL`** — stays literally true rather than merely
intended, and the CI contract test asserts the scoping structurally: no
workflow-level and no job-level `DATABASE_URL` may exist.

---

## Skipped is not passed

The most dangerous possible outcome of this pipeline is a green integration job
that ran nothing.

Every live suite gates itself on `TEST_DATABASE_URL` and skips when it is absent.
That is correct locally. But it means a job whose database never came up, whose
URL was mistyped, or whose variable was renamed prints

```
Tests  236 skipped (236)
```

and **exits 0**. Vitest is behaving correctly; the job is simply not testing
anything. A pipeline that reports that as integration success is worse than
having no integration job, because it manufactures confidence.

`test:db:ci` therefore runs the suites with a JSON reporter and hands the counts
to [`scripts/check-live-coverage.mjs`](../scripts/check-live-coverage.mjs), which
fails when a database is configured and:

- any test skipped, or
- no test was collected, or
- no test passed, or
- any test failed.

And it fails when `CI` is set but `TEST_DATABASE_URL` is not — because the
integration job's contract is that it *provides* a database, so an absent URL
means the job is broken, not that skipping is acceptable.

The exit code alone cannot distinguish "everything passed" from "everything
skipped": both are 0. The counts can.

### Local behaviour is unchanged

`pnpm test:db` with no `TEST_DATABASE_URL` still skips, quietly and safely. No
developer needs PostgreSQL installed to run `pnpm verify`, and `verify` does not
invoke the live suites at all. The strong database environment is CI's job.

| Command | No `TEST_DATABASE_URL` | With one |
| --- | --- | --- |
| `pnpm test` | runs, unaffected | runs, unaffected |
| `pnpm verify` | runs, unaffected | runs, unaffected |
| `pnpm test:db` | skips | runs |
| `pnpm test:db:ci` | skips, prints "SKIPPED IS NOT PASSED", exits 0 — unless `CI` is set, then **fails** | runs 230 tests, and fails if any skipped |

---

## Security posture

- `permissions: contents: read`, and nothing else. No `packages: write`, no
  `id-token: write`, no `pull-requests: write`. Nothing is published, tagged or
  commented on.
- **No `pull_request_target`.** It runs untrusted PR code with the base
  repository's secrets and a writable token, and is the single most exploited
  GitHub Actions misconfiguration. Ordinary `pull_request` is used.
- **No secrets at all.** The workflow contains no `secrets.` reference, and the
  contract test asserts it never names `NEON`, `RENDER`, `RESEND`, a deploy key,
  `neon.tech`, `onrender.com` or `sslmode=require`. PR jobs cannot leak what
  they were never given.
- Every database URL in the file is `localhost:5432` with disposable
  `hybrid_ci` credentials.
- No connection string is ever logged; the migration runner prints only a
  redacted target.

## No failure can be swallowed

No `continue-on-error`, no `|| true`, no `|| exit 0`, no `set +e`, no
`if: always()`. The integration job is **not** advisory. A red test makes CI
red.

Job timeouts are 20 and 25 minutes. The live suites include lock-serialization
and deadlock-ordering tests, and a genuine deadlock must eventually fail the job
rather than hang a runner — so the bound is deliberately close to the real
runtime rather than absurdly high.

---

## The CI contract test

[`tests/ci-contract.test.ts`](../tests/ci-contract.test.ts) treats the workflow
as an architecture artifact and asserts 57 properties of it, in the same suite as
everything else. **Weakening the pipeline now breaks the build it was weakened
to fix.**

It reads the YAML by indentation rather than through a parser — the project has
no YAML dependency and adding one to assert on a file we author ourselves would
buy a supply-chain edge for very little. The block and step extractors are what
make step-scoped assertions possible, so the suite can tell "`TEST_DATABASE_URL`
appears in *this step's* env" from "it appears somewhere in the file".

Forbidden-token assertions read the workflow with comments stripped. The
workflow's own comments explain why there is no deployment step and why the
migration runner needs `DATABASE_URL`; searching the raw document flagged those
explanations as violations, which would push the next author to delete the
reasoning rather than keep it.

The eight cases covering the skip-detector run the real script as a subprocess
against synthetic reports, so its behaviour is proven rather than its source text
inspected.

### Mutation evidence

Seven deliberate weakenings, each applied, run, and reverted byte-identically:

| Probe | Weakening | Tests failed |
| --- | --- | --- |
| A | `--frozen-lockfile` removed | 1 |
| B | live tests given `DATABASE_URL` instead of `TEST_DATABASE_URL` | 1 |
| C | PostgreSQL integration job deleted | 12 |
| D | triggers point at `develop`, so `main` is untested | 2 |
| E | `pull_request_target` added | 1 |
| F | `contents: write` + `packages: write` granted | 2 |
| G1 | live job downgraded to plain `test:db` | 2 |
| G2 | the skip-detector stops caring about skips | 3, including two behavioural |

---

## Node 20 end-of-life

Node 20 reached end of life on **2026-04-30** and no longer receives security
patches. That is already recorded in [deployment.md](deployment.md#node-version)
and is not restated here as a new finding.

What matters for AC-21: CI pins the same Node 20 the project pins everywhere
else, and the runtime major was deliberately **not** changed during this step.
The stack is locked to Node 20 by `engines`, `.nvmrc` and the pnpm 10 constraint
(pnpm 11 requires Node ≥ 22.13), so a runtime migration touches the package
manager, the lockfile, every workspace and the deployment target at once. Doing
that inside the step that introduces the CI gate would make a red build
ambiguous — was it the pipeline or the runtime? — and AC-21 asks for a
trustworthy gate, not a simultaneous upgrade.

The migration is next-phase work. When it happens, CI is the right place to
prove it, and the pin lives in exactly one file.

## The PostgreSQL major is provisional

`postgres:17` is pinned because a pinned major is required and 17 is a
reasonable production target. **No PostgreSQL major is declared anywhere in this
repository**, and no client Neon project exists to read one from. When Ashir's
Neon project is provisioned, its major must be checked against this pin and the
pin updated to match — testing against a different major than production is a
gap, not a guarantee.

---

## Status

**AC-21: `IMPLEMENTED / CLIENT GITHUB VERIFICATION BLOCKED`. Not PASS.**

What exists and passes locally: the workflow, 57 contract assertions, every
non-GitHub-specific command in it, and mutation evidence that the gate cannot be
quietly weakened.

What has never happened: a GitHub Actions run. **There is no remote.** AC-21
asks for CI *green on `main`*, and no run has ever occurred anywhere, so the
criterion cannot be assessed. It becomes PASS after the workflow is pushed to
the client-owned repository and a run on `main` succeeds.

Three things in this file are also unproven as a consequence, and are not
claimed:

1. **The integration job has never executed.** No Docker daemon and no local
   PostgreSQL were available, so the disposable-service path, the migration step
   and the 236 live tests have not run anywhere. What *was* proven locally is
   that the skip gate opens: with `TEST_DATABASE_URL` set to an unreachable
   host, the live suites execute and fail rather than skip — so a real database
   will run them.
2. **The workflow YAML has never been parsed by GitHub.** It is asserted to be
   tab-free, evenly indented, free of duplicate top-level keys and structurally
   consistent, which is not the same as accepted by Actions.
3. **Neon-specific connectivity is not covered by CI at all**, by design — see
   the exclusion above. Readiness through the pooler, the negotiated TLS
   behaviour and the actual server version of the client's project can only be
   checked against the client's project, at staging time.
