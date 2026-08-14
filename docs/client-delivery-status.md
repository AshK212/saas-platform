# Client Delivery Status

Last updated: **2026-08-14** (Step 20 — the Credit reference client).

This document tracks **contractual and operational** obligations, separately
from code completion. An item is not satisfied merely because it is documented,
configured, or technically ready.

Code status is tracked in
[acceptance-traceability.md](acceptance-traceability.md).

---

## Summary

| # | Requirement | Status |
| --- | --- | --- |
| 1 | Repository ownership — Ashir GitHub organization | `BLOCKED` |
| 2 | Project service accounts / resources — Ashir-owned | `BLOCKED` |
| 3 | Developer access as collaborator | `BLOCKED` |
| 4 | Daily pushes | `NOT SATISFIED` |
| 5 | Staging refreshed at least every 2 business days | `NOT STARTED` |
| 6 | Day-5 live walkthrough | `NOT SCHEDULED` |
| 7 | Known-gap disclosure before completion | `ON TRACK` |
| 8 | Full Credit acceptance rerun after any acceptance fix | `POLICY RECORDED` |
| 9 | 30-day warranty after accepted Credit completion | `NOT STARTED` |

---

## Detail

### 1. Repository ownership: Ashir GitHub organization

```text
BLOCKED — client GitHub repository has not yet been supplied.
Local development only.
Do not claim ownership/daily-push requirement satisfied.
```

A local Git repository has been initialized at the project root on the default
branch `main`. **No remote is configured and none has been invented.** The
repository must be created under Ashir's GitHub organization and that
organization must be the owner; the local repository is then re-pointed at it.

### 2. Project service accounts / resources: Ashir-owned

```text
BLOCKED — no client-owned accounts have been supplied.

NEON CONNECTIVITY:
BLOCKED — client-owned Neon resource / DATABASE_URL not supplied.

RESEND DELIVERY:
BLOCKED — client-owned Resend credential/domain unavailable.
```

No Render account, no Neon project, no Resend account, and no domain have been
provided. **None have been created under a developer account as a substitute**,
which would violate the ownership requirement. Nothing has been provisioned and
no credential exists in this repository.

As of Step 3 this is the **critical technical blocker**, and its cost has grown:
a complete 15-table schema and a checked-in migration now exist and have
**never been executed against any PostgreSQL server**. The following can only be
confirmed against a real client-owned Neon project:

- live connectivity and the `SELECT 1` readiness probe returning `ok`;
- `pnpm db:migrate` actually applying `0000_dusty_skullbuster.sql`;
- that every constraint, composite foreign key and check behaves as intended at
  runtime (statically reviewed and unit-asserted, but never executed);
- the six Step 2 transaction/locking tests, currently **skipped**;
- the three Step 4 cross-tenant isolation tests (AC-20), currently **skipped**,
  which require a separate `TEST_DATABASE_URL` — never the production database;
- the five Step 5 live authentication tests, currently **skipped**, including
  the PostgreSQL concurrency race proof that two simultaneous magic-link
  callbacks cannot both create a session. Single-threaded JavaScript cannot
  establish that, so it remains genuinely unproven;
- the six Step 6 live workspace tests, currently **skipped**, including real
  transaction rollback (a failed creator membership must leave no orphaned
  workspace) and the membership uniqueness constraint. In-memory fakes cannot
  prove either;
- the six Step 7 live API-credential tests, currently **skipped**, including
  hash-only persistence and the `key_prefix` / `secret_hash` UNIQUE
  constraints;
- the six Step 8 live agent tests, currently **skipped**, including the
  concurrent-registration race (two simultaneous registrations must yield
  exactly one agent) and the `(workspace_id, external_id)` UNIQUE constraint.
  Single-threaded JavaScript cannot establish either;
- the **sixteen Step 10 live event-ingest tests**, currently **skipped**. These
  are the ones that would actually prove **AC-13**: the
  `(workspace_id, event_id)` UNIQUE constraint, a two-way and a ten-way
  concurrent replay of the same event resolving to exactly one stored row,
  a racing duplicate creating no alternate block and no alternate agent,
  overlapping batches (`[E1,E2]` against `[E2,E1]`) completing without
  deadlock, batch rollback on an unresolved reference, cross-workspace block
  and receipt isolation, and the absence of any ledger write. Every one is a
  claim about what **PostgreSQL** does under concurrency, and the correctness
  of ingest now rests on a `pg_advisory_xact_lock` that **no in-process test
  can exercise at all**. Single-threaded JavaScript makes a read-then-act
  sequence authoritative for free; PostgreSQL does not;
- the **thirteen Step 11 live timeline tests**, currently **skipped**. These
  prove **AC-05** and **AC-06** against real PostgreSQL: that
  `ORDER BY received_at DESC, id DESC` is a total order over rows sharing a
  timestamp, that the row-value cursor boundary pages a static dataset without
  repeating or skipping rows (including when *every* timestamp is identical),
  that `jsonb` returns a stored payload byte-for-byte, and that the workspace
  predicate isolates tenants at runtime. The in-memory read store sorts and
  slices in JavaScript and cannot establish any of it;
- the **sixteen Step 12 live policy tests**, currently **skipped**. These prove
  that workspace creation really commits policy state atomically and really
  rolls all three inserts back when one fails, that the `LEFT JOIN` returns
  agents with no policy row, that a `bigint` version beyond 2^53 round-trips
  exactly, that `numeric(14,6)` yields an exact decimal string rather than a
  float, and that policy rows cannot cross tenants. **The atomic-provisioning
  change made in Step 12 has never run against a real database**;
- the **fourteen Step 13 live policy-mutation tests**, currently **skipped**.
  These are the ones that prove the central Step 13 invariant: that two
  concurrent mutations produce two distinct versions rather than both reading N
  and both writing N+1, that `SELECT ... FOR UPDATE` really serializes them,
  that eight simultaneous mutations yield eight distinct versions, that a
  same-agent race leaves one complete policy rather than a mix of fields, and
  that a failure in either half rolls the other back. Single-threaded JavaScript
  makes an increment atomic for free; PostgreSQL does not. **Every concurrency
  guarantee in Step 13 is argued and tested-but-unrun**;
- the **eighteen Step 14 live ledger tests**, currently **skipped**. These prove
  the claim every later spend and publish cap rests on: that
  `SELECT … FOR UPDATE` genuinely makes a second transaction WAIT rather than
  read stale committed usage. Also unproven without them: that two concurrent
  first-actions of a UTC day yield exactly one row, that locks on different
  agents and different days do not block one another, that `numeric(14,6)`
  round-trips an exact decimal, and that the composite foreign key refuses a
  cross-tenant agent. **Without a test database, the serialization that makes a
  correct cap denial possible has never actually been observed**;
- the **twenty Step 15 live precheck tests**, currently **skipped**. These are
  the ones that prove the governance engine actually governs: that two
  concurrent $4 spends against a $25 cap with $20 committed produce exactly one
  allow and one deny rather than both allowing; that six simultaneous publishes
  against a cap of 5 allow exactly five; that two simultaneous retries of one
  action debit once; and that a failed receipt insert rolls the ledger debit
  back. **The entire commit-on-allow guarantee — the heart of the Credit
  phase — is argued and tested-but-unrun.** The production decision transaction
  has no in-process behavioural coverage at all, because it needs a database;
  its invariants are currently held by source-level guards. **Step 16 raised
  this suite to 30 tests**, adding the ones that prove a denied precheck commits
  its receipt and its plane-owned block *together* — and that a failure in
  either half leaves neither, with the ledger untouched. **AC-08, AC-11 and
  AC-12 all now hinge on that transactional atomicity, and it has never been
  observed.**
- the **eighteen Step 17 live governance tests**, currently **skipped**. These
  prove what the operator surface reports is actually what the database holds:
  that a burst of decisions sharing one timestamp pages without repeating or
  skipping a row, that another tenant's receipt and block are invisible by exact
  uuid including through the joins, that `numeric(14,6)` hands back `24.999999`
  as a string rather than a lossy double, and that **reading the fleet creates
  no ledger row**. That last one cannot be tested any other way: an in-memory
  store cannot fail to write a row it was never asked to write. A mutation probe
  during Step 17 confirmed the gap was real, which is why this suite exists.

- the **thirteen Step 18 live settlement tests**, currently **skipped**. These
  are the only tests in the repository where the precheck debit and the event
  path touch ONE real `ledger_daily` table, and therefore the only place the
  headline accounting invariant can actually fail: precheck $4, report it, and
  the ledger must still read $4 rather than $8. In process the two are separate
  fakes and the event store has no ledger at all, so the property is nearly
  true by construction there. Also unproven without them: that the workspace
  predicate genuinely hides another tenant's receipt from event ingest, and
  that two concurrent replays of one linked event produce exactly one row and
  zero accounting. **A release-critical money invariant has never been observed
  against a real database.**

- the **eighteen Step 19 live accounting tests**, currently **skipped**. Event
  ingest now moves money, and these are the only tests that can observe the
  three ways that can go wrong under concurrency: a LOST UPDATE (two debits
  reading the same total, which `SELECT … FOR UPDATE` exists to prevent), a
  concurrent replay of one event debiting twice, and two batches naming the
  same agents in opposite order DEADLOCKING on ledger rows. Single-threaded
  JavaScript makes all three true for free; PostgreSQL does not, and each is a
  money defect if wrong. **A production accounting path has never executed
  against a real database.**

Separately, **AC-01 (magic-link sign-in) is implemented but cannot be
demonstrated**: it needs a Neon database, a Resend credential with a verified
sending domain, and a staging deployment. All three are client-owned and absent.

**Twelve criteria are now code-complete and blocked only on environment**
(AC-01, AC-02, AC-03, AC-04, AC-05, AC-06, AC-07, AC-08, AC-10, AC-11, AC-12,
AC-13) —
every Credit-phase enforcement criterion among them. That queue has grown at
every step since Step 5, and each addition increases the chance that the first
real run against Neon surfaces several problems at once rather than one at a
time. **This is now the entire remaining risk on the Credit phase**, and it is
no longer offset by remaining implementation work: the enforcement path is
finished end to end and has never executed against a real database.

Local structural validation passes. That is **not** production Neon validation
and is not reported as such.

### 3. Developer: collaborator

```text
BLOCKED — depends on item 1.
```

Collaborator access cannot be granted on a repository that does not exist. The
developer must hold collaborator access, not ownership.

### 4. Daily pushes

```text
NOT SATISFIED — pushing is impossible without a remote.
```

The daily-push obligation begins on the day the client repository is supplied.
Work to date exists as local commits only. Local commit history does not count
toward this requirement.

### 5. Staging refreshed at least every 2 business days

```text
NOT STARTED — no staging environment exists.
```

Depends on items 1 and 2. Intended staging shape is documented in
[deployment.md](deployment.md), including the `render.yaml` blueprint — but
nothing has been deployed and the blueprint is unvalidated against Render.

### 6. Day-5 live walkthrough

```text
NOT SCHEDULED — no date agreed.
```

A walkthrough of a foundation-only build would show a health endpoint and an
empty application shell. It should be scheduled against a milestone with
demonstrable functionality, and the day-5 clock should be confirmed with the
client relative to the agreed project start date.

### 7. Known-gap disclosure before completion

```text
ON TRACK — gaps are being disclosed continuously.
```

Every Step 1 gap, blocker and unvalidated assumption is recorded in this
document, in [acceptance-traceability.md](acceptance-traceability.md), and in
the Step 1 completion report. No acceptance criterion has been reported as
passing. Formal pre-completion disclosure is still owed at Credit completion.

### 8. Full Credit acceptance rerun after any acceptance fix

```text
POLICY RECORDED — not yet exercised (no acceptance run has occurred).
```

The policy is recorded in
[acceptance-traceability.md](acceptance-traceability.md): after any fix made in
response to an acceptance failure, the **entire** Credit acceptance suite is
rerun, not only the failing criterion.

### 9. 30-day warranty after accepted Credit completion

```text
NOT STARTED — the warranty clock has not begun.
```

The 30-day warranty period starts on **client acceptance** of Credit
completion. Credit is not complete and has not been accepted.

---

## Critical path

Items 1 and 2 block items 3, 4, 5 and AC-21. The single highest-priority
external action is:

> **Ashir to create the GitHub repository under the client organization and
> supply the URL, then provision the Render and Neon resources under
> client-owned accounts.**

Until then the project remains local-only, and no ownership, push, staging or
CI obligation can be reported as satisfied.

### What the client must supply, precisely

| Item | Needed for | Notes |
| --- | --- | --- |
| GitHub repository URL under Ashir's org | Items 1, 3, 4; AC-21 | Developer added as collaborator, not owner. |
| Neon project + `DATABASE_URL` | Live database validation, migrations, `/readyz` | Both the **pooled** and **direct** connection strings. Supply out of band — never in Git, chat or a ticket. |
| A **separate** Neon branch/database + `TEST_DATABASE_URL` | **AC-05 – AC-13**, policy atomicity, ledger serialization, precheck commit-on-allow, retry safety, **and denial receipt+block atomicity** — 143 live tests currently skipped | Must NOT be the production database: these suites write data (rolled back, except a few concurrency tests that must COMMIT to observe a real race and delete their own rows afterwards). A Neon branch is ideal and cheap. The suites deliberately refuse to fall back to `DATABASE_URL`, and a guardrail test enforces that for every data-writing suite. |
| Render account | Item 5, staging | Node 20 services per [deployment.md](deployment.md). |
| Resend account + verified sending domain | **AC-01 magic-link delivery — now blocking** | Supply `RESEND_API_KEY` and a verified `AUTH_FROM_EMAIL`. No Resend account was created under a developer identity. Until this exists, no real sign-in email has ever been sent. |
