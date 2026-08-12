# Credit Acceptance Traceability

Last updated: **2026-08-12** (Step 2 — Neon/Drizzle database foundation).

Acceptance criteria are recorded exactly as defined; this document tracks status
only and does not redefine any criterion.

## Status legend

| Status | Meaning |
| --- | --- |
| `NOT STARTED` | No implementation work has begun. |
| `FOUNDATION ONLY` | Structural groundwork exists; the acceptance condition itself is **not** met. |
| `BLOCKED` | Cannot progress until an external dependency is supplied. |
| `PASS` | The acceptance condition has been demonstrated and verified. |
| `FAIL` | The acceptance condition was exercised and did not hold. |
| `DEFERRED` | Explicitly out of the Credit phase. |

> **No acceptance criterion is marked `PASS` through Step 2.** Steps 1 and 2
> deliver foundation only. Nothing below has been demonstrated against its
> acceptance condition.
>
> Step 2 added database infrastructure (transaction-capable driver, environment
> validation, migration mechanism, readiness endpoint). It implements **no**
> business behaviour, so it changes no criterion's status. It does materially
> strengthen the foundation beneath the enforcement rows (AC-07, AC-08, AC-10,
> AC-11, AC-12, AC-13), which all require atomic, serialized database
> decisions — see the note below the matrix.

---

## Matrix

| ID | Criterion | Classification | Status | Step 1 contribution |
| --- | --- | --- | --- | --- |
| AC-01 | Magic-link sign-in | CREDIT | `NOT STARTED` | None. Auth and Resend are explicitly out of Step 1 scope. |
| AC-02 | Workspace + API key | CREDIT | `NOT STARTED` | None. Workspace scoping exists only as a type-level concept (`WorkspaceId`) in `runtime-core`. |
| AC-03 | Documented simulator / reference command | CREDIT — baseline | `FOUNDATION ONLY` | `apps/simulator` exists, compiles, and runs as an executable skeleton. No acceptance command is documented and no scenario is implemented. |
| AC-04 | 3 agents + last-seen within 60 seconds | CREDIT | `NOT STARTED` | None. |
| AC-05 | Timeline + agent filter | CREDIT — functional | `NOT STARTED` | None. The web app is an empty shell by design. |
| AC-06 | Raw JSON event detail | CREDIT | `NOT STARTED` | None. |
| AC-07 | Budgeted + $25 daily spend cap in UI | CREDIT | `NOT STARTED` | None. |
| AC-08 | $41 over-cap denial + block/receipt | CREDIT | `NOT STARTED` | None. |
| AC-09 | Immediate block email | LATER | `DEFERRED` | Out of Credit phase. |
| AC-10 | Cap raised and next spend allowed within 60 seconds | CREDIT | `NOT STARTED` | None. |
| AC-11 | Publish cap 5/day, 6th denied | CREDIT | `NOT STARTED` | None. |
| AC-12 | Pause next precheck denial + unpause | CREDIT | `NOT STARTED` | None. |
| AC-13 | Event replay idempotency | CREDIT | `NOT STARTED` | None. |
| AC-14 | Gone-dark | LATER | `DEFERRED` | Out of Credit phase. |
| AC-15 | 11:00 UTC digest | LATER | `DEFERRED` | Out of Credit phase. |
| AC-16 | Filtered CSV parity | LATER | `DEFERRED` | Out of Credit phase. |
| AC-17 | Daily rollup | LATER | `DEFERRED` | Out of Credit phase. |
| AC-18 | Revocable read-only share link | CREDIT | `NOT STARTED` | None. |
| AC-19 | Public demo with recurring blocks | CREDIT | `NOT STARTED` | None. |
| AC-20 | Automated cross-tenant coverage | CREDIT — foundation | `FOUNDATION ONLY` | Vitest established and running (**55 tests, 8 files**), with live-credential tests separated into their own suite. The mandatory workspace boundary is recorded as an architecture invariant, and the database client carries no ambient tenant context that could defeat a cross-tenant test. **No cross-tenant test exists**, because no tenant model exists yet. |
| AC-21 | CI green on `main` | CREDIT | `BLOCKED` | A GitHub Actions workflow (`.github/workflows/ci.yml`) is committed and its exact command sequence passes locally. **No GitHub repository, no remote, and no CI run exist**, so this criterion cannot be evaluated. It may only become `PASS` after a real green run on `main`. |

---

## Summary at Step 2

- `PASS`: **0**
- `FOUNDATION ONLY`: **2** (AC-03, AC-20)
- `BLOCKED`: **1** (AC-21)
- `NOT STARTED`: **13**
- `DEFERRED`: **5** (AC-09, AC-14, AC-15, AC-16, AC-17)

Unchanged from Step 1 — as expected, since Step 2 is infrastructure.

## Step 2 note: foundation beneath the enforcement criteria

AC-07, AC-08, AC-10, AC-11, AC-12 and AC-13 all require decisions that are
atomic and correct under concurrency: a cap check and its ledger write must
commit together, a denial must produce a block and receipt together, and a
replayed event must not double-count.

Step 1's provisional `neon-http` driver **could not have delivered any of
this** — it throws `No transactions support in neon-http driver`. Step 2
replaced it with `pg` over TCP, which supports interactive transactions,
`SELECT … FOR UPDATE`, `SERIALIZABLE` isolation and advisory locks.

This removes a latent blocker from those six criteria. **It does not advance
their status**: none of the enforcement behaviour is implemented, and the
transactional guarantees are verified against a live database only by the
`*.live.test.ts` suite, which is currently **skipped** for want of a Neon
credential.

## Note on AC-21

AC-21 requires CI **green on `main`**. The existence of a workflow YAML file
does not satisfy it. The local equivalent of every CI step
(`lint`, `typecheck`, `test`, `build`) passes on this machine, but GitHub-hosted
execution has never occurred because no client repository has been supplied. See
[client-delivery-status.md](client-delivery-status.md).

## Rerun policy

After any fix made in response to an acceptance failure, the **full Credit
acceptance suite is rerun** — not only the failing criterion. This document is
updated with the result of that full rerun.
