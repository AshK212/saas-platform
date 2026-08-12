# Client Delivery Status

Last updated: **2026-08-12** (Step 2 — Neon/Drizzle database foundation).

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
```

No Render account, no Neon project, no Resend account, and no domain have been
provided. **None have been created under a developer account as a substitute**,
which would violate the ownership requirement. Nothing has been provisioned and
no credential exists in this repository.

As of Step 2 this is now the **critical technical blocker**, not merely an
administrative one. The database foundation is complete and validated
structurally, but the following can only be confirmed against a real
client-owned Neon project:

- live connectivity and the `SELECT 1` readiness probe returning `ok`;
- `pnpm db:migrate` actually applying a migration;
- the six `*.live.test.ts` transaction/locking tests, currently **skipped**.

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
| Render account | Item 5, staging | Node 20 services per [deployment.md](deployment.md). |
| Resend account | AC-01 magic links (later step) | Not needed for Steps 1–3. |
