# Client Delivery Status

Last updated: **2026-08-12** (Step 11 — event timeline and raw event detail).

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
  slices in JavaScript and cannot establish any of it.

Separately, **AC-01 (magic-link sign-in) is implemented but cannot be
demonstrated**: it needs a Neon database, a Resend credential with a verified
sending domain, and a staging deployment. All three are client-owned and absent.

**Six criteria are now code-complete and blocked only on environment**
(AC-01, AC-02, AC-04, AC-05, AC-06, AC-13). That queue grows with every step,
and each addition increases the chance that the first real run against Neon
surfaces several problems at once rather than one at a time. This is the primary
schedule risk on the project.

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
| A **separate** Neon branch/database + `TEST_DATABASE_URL` | **AC-05, AC-06, AC-13** and AC-20 cross-tenant isolation — 62 live tests currently skipped | Must NOT be the production database: these suites write data (rolled back, except a few concurrency tests that must COMMIT to observe a real race and delete their own rows afterwards). A Neon branch is ideal and cheap. The suites deliberately refuse to fall back to `DATABASE_URL`, and a guardrail test enforces that for every data-writing suite. |
| Render account | Item 5, staging | Node 20 services per [deployment.md](deployment.md). |
| Resend account + verified sending domain | **AC-01 magic-link delivery — now blocking** | Supply `RESEND_API_KEY` and a verified `AUTH_FROM_EMAIL`. No Resend account was created under a developer identity. Until this exists, no real sign-in email has ever been sent. |
