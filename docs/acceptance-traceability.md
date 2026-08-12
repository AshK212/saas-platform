# Credit Acceptance Traceability

Last updated: **2026-08-12** (Step 6 — workspace + membership authorization).

Acceptance criteria are recorded exactly as defined; this document tracks status
only and does not redefine any criterion.

## Status legend

| Status | Meaning |
| --- | --- |
| `NOT STARTED` | No implementation work has begun. |
| `FOUNDATION ONLY` | Structural groundwork exists; the acceptance condition itself is **not** met. |
| `BLOCKED` | Cannot progress until an external dependency is supplied. |
| `IMPLEMENTED / STAGING VERIFICATION BLOCKED` | Feature is complete and locally tested, but its acceptance condition has never been demonstrated in an authorized environment. **This is not PASS.** |
| `PARTIAL` | One part of a multi-part criterion is complete; the rest is not started. **This is not PASS.** |
| `PASS` | The acceptance condition has been demonstrated and verified. |
| `FAIL` | The acceptance condition was exercised and did not hold. |
| `DEFERRED` | Explicitly out of the Credit phase. |

> **No acceptance criterion is marked `PASS` through Step 3.** Steps 1–3
> deliver foundation only. Nothing below has been demonstrated against its
> acceptance condition.
>
> **A table existing is not a feature existing.** Step 3 created the relational
> structure for identity, workspaces, credentials, agents, events, policy,
> ledger, receipts, blocks and sharing — but no repository, query, API, ingest
> path or enforcement rule was written, and the migration has never been applied
> to a database. Every row below therefore keeps its Step 2 status; only the
> "Step 3 contribution" notes change.

---

## Matrix

| ID | Criterion | Classification | Status | Step 1 contribution |
| --- | --- | --- | --- | --- |
| AC-01 | Magic-link sign-in | CREDIT | `IMPLEMENTED / STAGING VERIFICATION BLOCKED` | **Step 5 implemented the complete flow** — request, single-use hashed token with 15-minute expiry, atomic redemption, HttpOnly `SameSite=Lax` session cookie, `/v1/auth/me`, server-side-revoking logout, Resend adapter. 96 auth tests pass and the flow was exercised end to end over real HTTP with a capturing mailer. **NOT PASS:** no client Neon, no client Resend and no staging exist, so the acceptance behaviour has never run in an authorized environment, no real email has been delivered, and the PostgreSQL concurrency race test is skipped. |
| AC-02 | Workspace + API key | CREDIT | `PARTIAL — WORKSPACE COMPLETE, API KEY NOT STARTED` | **Step 6 completed the workspace half:** authenticated creation with atomic creator membership, membership-bounded listing, and per-request membership authorization producing a trusted `WorkspaceScope`. Cross-tenant access returns 404; CSRF origin protection added. **The API-key half is NOT STARTED** — show-once hashed, revocable keys are Step 7. AC-02 cannot be PASS until both halves exist and are demonstrated on staging. |
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
| AC-20 | Automated cross-tenant coverage | CREDIT — foundation | `FOUNDATION ONLY` | **251 tests, 14 files.** Step 4 added the workspace-scoped repository layer: every tenant-owned query is proven to emit `workspace_id` in its predicate against real compiled SQL (37 assertions), no bypass helper exists, and ESLint blocks raw table access from apps. A live cross-tenant suite exists and exercises two tenants sharing identical `event_id` and `external_id` values — but it is **SKIPPED**, gated on an authorized `TEST_DATABASE_URL` that does not exist. **Real PostgreSQL isolation is therefore unproven at runtime**, and most Credit feature paths still do not exist to be covered. |
| AC-21 | CI green on `main` | CREDIT | `BLOCKED` | A GitHub Actions workflow (`.github/workflows/ci.yml`) is committed and its exact command sequence passes locally. **No GitHub repository, no remote, and no CI run exist**, so this criterion cannot be evaluated. It may only become `PASS` after a real green run on `main`. |

---

## Step 4 note: tenant isolation

Step 4 added the data-access boundary — `WorkspaceScope`, workspace-bound
repositories, scope resolvers and static guardrails. It implements **no**
product behaviour, so no criterion's status changed.

Its effect on AC-20 is real but partial: cross-tenant leakage is now structurally
difficult (branded scope, no bypass helper, lint-enforced boundary, SQL-level
proof) **in addition to** being relationally impossible via Step 3's composite
foreign keys. What is still missing for AC-20 is (a) an authorized database to
prove isolation at runtime, and (b) the Credit feature paths themselves, which
do not yet exist to be covered.

See [ADR 0001 — Workspace Isolation](adr/0001-workspace-isolation.md).

## Step 5 note: authentication

Step 5 delivered magic-link sign-in in full (see
[ADR 0002](adr/0002-authentication.md)). AC-01 moves from `NOT STARTED` to
`IMPLEMENTED / STAGING VERIFICATION BLOCKED` — **not** to `PASS`.

Three things stand between the current state and AC-01 PASS, none of them code:

1. **No client Neon database.** The auth schema has never been applied, and the
   PostgreSQL concurrency race test is skipped.
2. **No client Resend credential or verified domain.** No real email has been
   delivered; only the adapter contract is verified.
3. **No staging environment.** The agreed sign-in behaviour has never been
   demonstrated where the client can observe it.

Authentication also grants no workspace access, so it advances no other
criterion. AC-02 in particular remains `NOT STARTED`: membership and workspace
selection are Step 6.

## Step 6 note: workspace authorization

Step 6 connected identity to tenancy: authenticated users create workspaces
(creator membership committed atomically), list only their own memberships, and
authorize into a workspace through a membership join that runs on every request.
`createWorkspaceScope` was removed from the package's public surface so no HTTP
handler can mint tenant access from request input.

It also discharged the CSRF review Step 5 deferred, since workspace creation is
the first authenticated browser mutation. See
[ADR 0003](adr/0003-operator-workspace-authorization.md).

AC-02 moves to `PARTIAL`, not `PASS`: API-key issuance is Step 7, and nothing
has been demonstrated on staging.

## Summary at Step 6

- `PASS`: **0**
- `IMPLEMENTED / STAGING VERIFICATION BLOCKED`: **1** (AC-01)
- `PARTIAL`: **1** (AC-02 — workspace done, API key not started)
- `FOUNDATION ONLY`: **2** (AC-03, AC-20)
- `BLOCKED`: **1** (AC-21)
- `NOT STARTED`: **11**
- `DEFERRED`: **5** (AC-09, AC-14, AC-15, AC-16, AC-17)

**Still zero PASS.** No criterion can be demonstrated without client-owned Neon,
Resend and Render.

## Step 3 note: relational foundation per criterion

Schema created, behaviour not implemented. No status changed.

| Criterion | Step 3 relational contribution |
| --- | --- |
| AC-01 magic-link sign-in | `users` (email, case-insensitive unique, no password column). No auth, no email. |
| AC-02 workspace + API key | `workspaces`, `workspace_memberships`, `api_credentials` (hash + non-secret prefix, revocable). No issuance or authentication. |
| AC-04 3 agents + last-seen 60s | `agents` with `last_seen_at` and `UNIQUE (workspace_id, external_id)`; index by workspace + liveness. No discovery or heartbeat. |
| AC-05 timeline + agent filter | `events` with workspace and workspace+agent time indexes. No ingest or timeline API. |
| AC-06 raw JSON event detail | `events.payload` as unconstrained `jsonb`, stored verbatim. No API. |
| AC-07 / AC-08 / AC-10 / AC-11 / AC-12 | `agent_policies` (mode + non-negative caps), `workspace_policy_state` (version), `ledger_daily` (one row per agent per UTC day), `precheck_receipts`, `blocks`. No precheck, no enforcement, no mutation. |
| AC-13 event replay idempotency | `UNIQUE (workspace_id, event_id)` — the constraint idempotency will rest on. No ingest logic. |
| AC-18 revocable share link | `share_tokens` (hash + prefix, `revoked_at`). No routes. |
| AC-19 public demo | `workspaces.demo_enabled` + optional public `demo_slug`. No demo generator, no public routes, no synthetic data. |
| AC-20 cross-tenant coverage | 13 composite workspace-anchored foreign keys make cross-workspace references structurally impossible; 92 schema tests assert them. Still no cross-tenant *runtime* test, because no query layer exists. |

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
