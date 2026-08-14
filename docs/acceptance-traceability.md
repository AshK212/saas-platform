# Credit Acceptance Traceability

Last updated: **2026-08-14** (Step 19 — authoritative event accounting).

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
| AC-02 | Workspace + API key | CREDIT | `IMPLEMENTED / STAGING VERIFICATION BLOCKED` | **Both halves now exist.** Step 6: workspace creation with atomic creator membership, membership-bounded listing, per-request authorization producing a trusted `WorkspaceScope`. Step 7: operator-only issuance of `hmp_live_*` keys with 256-bit secrets, SHA-256 hash-at-rest, plaintext shown exactly once, immediate revocation, and bearer authentication that derives the workspace from the credential row. 118 credential tests pass and the flow was exercised end to end over real HTTP. **NOT PASS:** no client Neon, Resend or staging exists, so the acceptance behaviour has never run in an authorized environment. |
| AC-03 | Documented simulator / reference command | CREDIT — baseline | `FOUNDATION ONLY` | `apps/simulator` exists, compiles, and runs as an executable skeleton. No acceptance command is documented and no scenario is implemented. |
| AC-04 | 3 agents + last-seen within 60 seconds | CREDIT | `IMPLEMENTED / STAGING VERIFICATION BLOCKED` | **Step 8 implemented the registry:** idempotent machine registration (`POST /v1/agents/register`, bearer-authenticated, workspace derived from the credential), server-authoritative `last_seen_at`, and an operator roster ordered by last contact. Demonstrated end to end over real HTTP: three agents registered, all reporting last-seen within 60 s, with full cross-tenant isolation. **NOT PASS:** no client Neon, Render or staging exists, so the acceptance condition has never been demonstrated in an authorized environment, and the live concurrent-registration race test is skipped. |
| AC-05 | Timeline + agent filter | CREDIT — functional | `IMPLEMENTED / STAGING VERIFICATION BLOCKED` | **Step 11 implemented both halves.** `GET /v1/workspaces/:id/events` returns the workspace stream newest-first by server `received_at` with `id` as a deterministic tiebreaker, bounded pages (default 50, max 100) and opaque `(received_at, id)` cursor pagination that neither repeats nor skips rows. Per-agent filtering resolves the **external** `agent_id` inside the authorized workspace, so a shared `agent-1` cannot cross tenants; an unknown id returns an empty page rather than revealing existence. Browser-session auth only — an API key is refused. A functional operator UI lists events, filters by agent, and loads more. 66 route tests, 24 cursor tests, 25 compiled-SQL tests. **NOT PASS:** never demonstrated in an authorized environment, and the live PostgreSQL suite that proves real ordering, tiebreak and cursor behaviour is **SKIPPED**. |
| AC-06 | Raw JSON event detail | CREDIT | `IMPLEMENTED / STAGING VERIFICATION BLOCKED` | **Step 11 completed the drill-through.** `GET /v1/workspaces/:id/events/:eventId` returns the event plus `raw` — the validated event object exactly as Step 10 stored it in `events.payload`, nested structure intact. `raw` is the **validated object, not raw HTTP request data**, which is why no credential or header material can appear in it. The UI renders it via `JSON.stringify(raw, null, 2)` in a `<pre>` as a React text child; a payload containing `<script>` displays as text and there is no `dangerouslySetInnerHTML` in the app. A malformed, unknown or foreign event id is uniformly 404. **NOT PASS:** never demonstrated in an authorized environment, and the live test asserting byte-for-byte `jsonb` round-tripping is **SKIPPED**. |
| AC-07 | Budgeted + $25 daily spend cap in UI | CREDIT | `IMPLEMENTED / STAGING VERIFICATION BLOCKED` | **All four halves now exist.** Step 13: an operator sets `budgeted` and a `$25.000000` cap in the UI. Step 14: the authoritative UTC-day ledger. Step 15: `POST /v1/actions/precheck` enforces the cap. **Step 17 closes the loop — the operator can now SEE it:** the agent roster reports mode, caps and today's committed usage as `Today's spend: $24.00 / $25.00`, read from `ledger_daily` for the **server's** UTC day, formatted from exact decimal strings with no `parseFloat`, no `toFixed` and no browser-side comparison of total to cap. Caps display only under `budgeted`, and no copy claims protection because a cap exists. **NOT PASS:** never demonstrated in an authorized environment, and the live suite proving real ledger reads, real UTC-day boundaries and that reading creates no row is **SKIPPED**. |
| AC-08 | $41 over-cap denial + block/receipt | CREDIT | `IMPLEMENTED / STAGING VERIFICATION BLOCKED` | **Both artifacts now exist.** $41 against a $25 cap denies with `daily_spend_cap_exceeded`, the ledger stays at 0, and one transaction commits a durable receipt (exact policy version, applied cap, requested amount, ledger-before, remaining) **and** a plane-owned block (`source = 'plane'`, `rule = daily_spend_cap`, requested amount, linked to that receipt). A failure in either half rolls the other back. A retry creates no second block. **NOT PASS:** never demonstrated in an authorized environment; the live suite proving real transactional atomicity is SKIPPED; and the operator presentation of the block and receipt now exists (Step 17) but has itself never run against a real database. |
| AC-09 | Immediate block email | LATER | `DEFERRED` | Out of Credit phase. |
| AC-10 | Cap raised and next spend allowed within 60 seconds | CREDIT | `IMPLEMENTED / STAGING VERIFICATION BLOCKED` | **Every mechanical piece exists, and the sequence is now observable.** Raising a cap is atomic with a version bump (Step 13), does not reset committed spend (Step 14), propagates on the next ~30-second poll (Step 12), and the next precheck evaluates against the new cap and real retained usage (Step 15). **Step 17 makes each stage visible:** the fleet view shows the new cap against unchanged committed usage, and the receipt list shows the denial and the subsequent allow as two records — the denial still explaining itself with the **old** cap, because a receipt is never recomputed. **NOT PASS:** the end-to-end flow has never been exercised as one timed sequence, which requires a database and staging. |
| AC-11 | Publish cap 5/day, 6th denied | CREDIT | `IMPLEMENTED / STAGING VERIFICATION BLOCKED` | Five prechecks allow and commit `+1` each with **no blocks**; the sixth denies with `daily_publish_cap_exceeded`, commits nothing, and records a receipt plus **exactly one** plane block (`rule = daily_publish_cap`, `count = 1`, spend column null). Six receipts, one block. Concurrent publishes serialize, so six simultaneous requests allow exactly five. **NOT PASS:** never demonstrated in an authorized environment; live atomicity SKIPPED; the operator presentation now exists (Step 17) but has itself never run against a real database. |
| AC-12 | Pause next precheck denial + unpause | CREDIT | `IMPLEMENTED / STAGING VERIFICATION BLOCKED` | **The full sequence works locally.** Setting `mode = paused` through the operator route creates **no block** — a policy change is not a denial. The next precheck, in **any** category including `other`, denies with reason `paused` and records a receipt plus a plane block (`rule = agent_paused`), with no ledger effect. Unpausing restores decisions on the next action and creates no further block. **NOT PASS:** never demonstrated in an authorized environment; live atomicity SKIPPED; the operator presentation now exists (Step 17) but has itself never run against a real database. |
| AC-13 | Event replay idempotency | CREDIT | `IMPLEMENTED / STAGING VERIFICATION BLOCKED` | **Step 10 implemented ingest**, corrected after architecture review. `POST /v1/events` is mounted, bearer-authenticated, workspace derived from the credential row. One transaction per batch; the **duplicate decision precedes every one-time side effect**, serialized by a transaction-scoped `pg_advisory_xact_lock` keyed on `(workspace_id, event_id)` and acquired in deterministic order to avoid deadlock, with the Step 3 index `UNIQUE (workspace_id, event_id)` retained as defense in depth. Replaying a batch returns 200 with `accepted: 0, duplicates: N`; the stored count is unchanged, original rows untouched, `last_seen_at` not refreshed, and a replay carrying changed content creates no alternate block, agent or linkage. 92 in-process tests plus a real-socket run against the compiled build. **NOT PASS:** the live PostgreSQL suite — the only thing that can prove the advisory lock actually serializes, that a racing duplicate creates no alternate block or agent, that overlapping batches do not deadlock, and that cross-tenant isolation holds — is **SKIPPED**, gated on a `TEST_DATABASE_URL` that does not exist. |
| AC-14 | Gone-dark | LATER | `DEFERRED` | Out of Credit phase. |
| AC-15 | 11:00 UTC digest | LATER | `DEFERRED` | Out of Credit phase. |
| AC-16 | Filtered CSV parity | LATER | `DEFERRED` | Out of Credit phase. |
| AC-17 | Daily rollup | LATER | `DEFERRED` | Out of Credit phase. |
| AC-18 | Revocable read-only share link | CREDIT | `NOT STARTED` | None. |
| AC-19 | Public demo with recurring blocks | CREDIT | `NOT STARTED` | None. |
| AC-20 | Automated cross-tenant coverage | CREDIT — foundation | `FOUNDATION ONLY` | **1555 tests, 44 files.** Step 4 added the workspace-scoped repository layer: every tenant-owned query is proven to emit `workspace_id` in its predicate against real compiled SQL (37 assertions), no bypass helper exists, and ESLint blocks raw table access from apps. A live cross-tenant suite exists and exercises two tenants sharing identical `event_id` and `external_id` values — but it is **SKIPPED**, gated on an authorized `TEST_DATABASE_URL` that does not exist. **Real PostgreSQL isolation is therefore unproven at runtime**, and most Credit feature paths still do not exist to be covered. |
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

## Step 9 note: event contracts

Step 9 defined the `POST /v1/events` transport contract and nothing else — no
route, no persistence, no behaviour. `packages/contracts` still depends only on
Zod, so the same definitions serve the API, the browser app and the simulator.

Three decisions carry real weight for later acceptance:

- **Money is a decimal string, never a JSON number.** IEEE-754 rounding in a
  cap decision would be a silent accounting defect; `"0.0000009"` is rejected
  rather than rounded.
- **Strict envelopes.** `{"amout_usd": "41.00"}` is a 400, not a spend event
  with a missing amount. This also makes `workspace_id`, policy fields and
  credentials structurally unexpressible.
- **Vocabulary is verified against the migrated SQL**, so the Zod enums and the
  PostgreSQL enums cannot drift.

AC-13 moves to `FOUNDATION ONLY — CONTRACT READY`. It is **not** implemented.

## Step 10 note: event ingest

Step 10 mounted `POST /v1/events` and implemented idempotent persistence.

The decision that matters for AC-13 is **where idempotency lives**. It is the
database index `UNIQUE (workspace_id, event_id)`, reached through
`INSERT … ON CONFLICT DO NOTHING RETURNING`.

**Correction after architecture review.** The first implementation put that
insert *last*, so the agent, the receipt and the runtime block were all resolved
before the replay was detected — one-time side effects performed for an event
that was never accepted. Because `event_id` is client-supplied, that made the
replay path a way to create rows: a known event id with a fresh `block_id`
created a block; with a fresh `agent_id` it enrolled an agent. The ordering is
now **duplicate decision first**, serialized by a transaction-scoped
`pg_advisory_xact_lock` keyed on `(workspace_id, event_id)`, with locks acquired
in a deterministic total order so overlapping batches cannot deadlock. The
UNIQUE constraint is retained beneath it as defense in depth. See
[event-contracts.md](event-contracts.md).

Two further behaviours were chosen deliberately and are worth recording:

- **A duplicate replay does not refresh `last_seen_at`.** Advancing last-seen is
  gated on the insert being new. Otherwise a retry storm would make a dead agent
  look alive — and last-seen is the entire substance of AC-04.
- **An unresolved `precheck_id` fails the whole batch** rather than storing the
  event with the linkage silently dropped. A receipt in another workspace is
  reported identically to one that does not exist.

**Ingest performs no ledger debit.** A `spend.recorded` event is an audit record
only. This is stated loudly in [event-contracts.md](event-contracts.md) because
"events were accepted" must not be mistaken for "spend was counted". Step 19
owns authoritative accounting; AC-07, AC-08 and AC-10 remain `NOT STARTED`.

AC-13 moves to `IMPLEMENTED / STAGING VERIFICATION BLOCKED` — **not PASS**. The
live suite that would prove the concurrency race has never run.

## Step 8 note: agent registry

Step 8 built the registry AC-04 rests on. Registration is idempotent via
`INSERT … ON CONFLICT (workspace_id, external_id) DO UPDATE`, so the database's
own unique index — not application logic — is what prevents duplicate agents
under concurrency.

`last_seen_at` is **server-authoritative**: the request schema has no such
field, so a client cannot assert its own liveness. That matters because
last-seen is the entire substance of AC-04.

Deliberately absent, and each belongs elsewhere: event ingest (Step 10),
timeline (Step 11), policy/mode/caps (policy steps), and gone-dark detection
(deferred AC-14).

AC-04 moves to `IMPLEMENTED / STAGING VERIFICATION BLOCKED` — **not PASS**.

## Step 7 note: API credentials

Step 7 completed the credential half of AC-02. The security-critical outcome is
that **an API-key request's tenant authority comes only from
`api_credentials.workspace_id`** — verified over real HTTP with a workspace id
injected simultaneously via query string and header, which was ignored.

AC-02 moves from `PARTIAL` to `IMPLEMENTED / STAGING VERIFICATION BLOCKED`.
**Not PASS**: nothing has been demonstrated in an authorized environment, and
the live PostgreSQL credential suite (hash-only persistence, UNIQUE constraints)
is skipped for want of a test database.

See [api-authentication.md](api-authentication.md).

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

## Step 11 note: timeline and raw detail

Step 11 added the operator read surface and nothing else. It writes nothing, and
Step 10's corrected ingest ordering is untouched — the read path lives in a
separate store and route module with no method that could mutate an event.

Three decisions carry weight for later acceptance:

- **`received_at DESC, id DESC`.** A client clock never determines ordering, and
  the `id` tiebreaker is what makes cursor pagination safe across the block of
  identical timestamps that one ingest batch produces.
- **The cursor carries no tenancy.** It is client-held and therefore
  attacker-controlled; scope comes only from membership, so a forged cursor can
  at worst move the caller's own page boundary. Tested by replaying a genuine
  cursor from another workspace.
- **An unknown agent filter returns an empty page, not 404.** A 404 would reveal
  whether an external agent id exists elsewhere on the platform.

AC-05 and AC-06 both move to `IMPLEMENTED / STAGING VERIFICATION BLOCKED` —
**not PASS**. Neither has run against real PostgreSQL or in a staging
environment.

## Step 12 note: policy versioning and polling

Step 12 built the policy READ foundation that AC-07, AC-08, AC-10, AC-11 and
AC-12 will rest on. **None of those criteria advances**: nothing here enforces a
cap, evaluates a decision or lets an operator change anything.

What it establishes:

- **Every workspace is born with an authoritative policy version.** Creation is
  now one transaction with three inserts — workspace, membership, policy state
  at version 1 — because a workspace that cannot report a version is not a
  usable workspace.
- **Effective policy is computed, never persisted.** An agent with no explicit
  row is `watch` with null caps. Defaults are not written, which is what keeps
  event auto-discovery from mutating governance.
- **The version is a string.** The column is a `bigint`; a JSON number would
  lose precision above 2^53, the same defect the money contract rejects floats
  for. It is read with a `::text` cast so no JS conversion happens at all.
- **There is no policy writer.** The repository exposes none, and a guardrail
  sweeps both packages to enforce that only provisioning may insert into
  `workspace_policy_state` or `agent_policies`.

Policy polling/versioning: **FOUNDATION IMPLEMENTED**. Not an acceptance
criterion in its own right.

## Step 13 note: operator policy mutation

Step 13 added the **only** policy write path in the system:

```text
session cookie → membership → role == operator → WorkspaceScope
              → one transaction: upsert policy + increment version
```

The invariant that matters is atomicity. A policy changed without a version bump
would be invisible to every polling agent — they would keep receiving 304 and
run indefinitely under governance the operator believes they replaced. The
increment is a single `version + 1` statement against a row already held under
`SELECT ... FOR UPDATE`, never a read-then-write, so two concurrent mutations
produce two distinct versions rather than losing one.

A rejected request — 400, 403, 404 or CSRF — increments **nothing**. The version
is itself governance state.

**Four criteria advance, none to implemented.** AC-07 becomes
`IMPLEMENTED PARTIAL`; AC-10, AC-11 and AC-12 become `FOUNDATION`. In every case
the configuration exists and the enforcement does not: no precheck endpoint, no
denial, no block, no ledger effect. A saved cap is a recorded intention, not an
active control.

## Step 14 note: the authoritative ledger

Step 14 added the accounting primitives later enforcement composes: exact
micro-dollar arithmetic, the UTC accounting day, and the
`workspace + agent + UTC day` ledger with its row lock. **No criterion becomes
implemented** — nothing here decides, denies, or records evidence.

Three decisions carry weight:

- **`SELECT … FOR UPDATE` is the whole basis of correct cap enforcement.**
  Without it, two requests both read $20 committed against a $25 cap, both
  believe $4 fits, and $28 commits. The lock makes the second wait and read $24.
  Step 15 owns the denial; Step 14 owns the serialization that makes a correct
  denial possible.
- **Money is exact micro-dollar `bigint`, never a float.** A single amount does
  survive a double at this scale — the hazard is arithmetic. `10.10 + 10.20 +
  4.70` sums to `24.999999999999996`, under-reporting spend that is exactly at a
  $25 cap, so the ledger would believe headroom remained.
- **The accounting day is UTC and is server authority.** `UtcAccountingDay` is a
  branded type, so a future route cannot pass `req.query.day` through — it is a
  compile error. A caller choosing their day could charge today's overspend to
  tomorrow.

Policy and accounting stay separate: raising a cap does not reset committed
spend, lowering one does not erase it, and remaining floors at zero rather than
reporting negative credit.

## Step 15 note: the precheck decision engine

Step 15 is the heart of the Credit phase: `POST /v1/actions/precheck` decides,
enforces, and records.

The invariant that matters is **commit-on-allow**. The ledger debit and the
receipt share one transaction, so a failed receipt insert rolls the debit back
and a failed debit prevents the receipt. Money spent but unexplainable, or a
receipt claiming spend that never landed, are both worse outcomes than a failed
request.

Four decisions carry weight:

- **A denial never mutates the ledger.** The commit is gated on `allow`; there
  is no preemptive increment with a compensating subtraction.
- **`watch` allows and records nothing.** An operator who has not opted into
  enforcement has not opted into having usage counted against them either.
- **Uncapped `budgeted` still records.** The ledger is authoritative usage
  independent of whether a cap exists, so a cap added later today applies to a
  real running total.
- **Retries are safe.** `(workspace_id, action_id)` is unique and serialized by
  an advisory lock, because commit-on-allow makes a double debit a money defect.
  This required a schema addition — see below.

**One genuine schema deficiency was found and fixed.** The Step 3
`precheck_receipts` table had no `action_id`, but the locked contract carries
one and silently dropping a contract identity would have made retries unsafe.
Migration `0002` adds the column and the composite unique constraint. Nothing
was rewritten.

**Four criteria advance to `IMPLEMENTED PARTIAL`, none to implemented.** AC-08,
AC-11 and AC-12 all name a *block* alongside the receipt, and plane-owned blocks
are Step 16.

## Step 16 note: plane-owned blocks

Step 16 completes **WHOEVER DENIES, RECORDS**. A plane denial now writes its
receipt and its block in one transaction; an allow writes no block.

The schema needed **no change**. Step 3 had already modelled the FK once, on
`blocks.precheck_receipt_id`, explicitly to avoid a circular constraint *and* to
keep receipts insert-only — so the ordering is simply receipt → block, with
nothing updated afterwards and receipt immutability intact.

Three properties are worth recording:

- **Ownership cannot be forged.** `blocks.ts` hardcodes `source = 'runtime'`,
  `plane-blocks.ts` hardcodes `'plane'`, and in neither is `source` a parameter.
  There is no generic `createBlock`.
- **A policy change is not a denial.** Setting `paused` records nothing; the
  next refused action does. That distinction is the substance of AC-12.
- **One denial vocabulary.** `reason` → `rule` is a single exhaustive mapping,
  so the receipt, the block and the wire response cannot disagree about why one
  action was refused.

**AC-08, AC-11 and AC-12 advance to `IMPLEMENTED / STAGING VERIFICATION
BLOCKED`** — every artifact those criteria name now exists and is atomic. They
are not PASS: nothing has run against a real database, and their presentation is
Step 17.

## Step 17 note: operator governance visibility

Step 17 added no enforcement and no writes. It made what the plane already
decides **visible**: fleet enforcement state on the agent roster, a receipt
audit with full decision evidence, and a block audit distinguishing plane from
runtime ownership.

The invariant that matters is **no recomputation, at either layer**.

- **The server never re-derives a past decision.** A receipt renders from
  `applied_mode`, `applied_spend_cap_usd`, `applied_publish_cap`,
  `ledger_spend_before_usd` and the persisted `deny_reason`. The route loads no
  live policy and touches no ledger. Raising a cap this morning does not rewrite
  yesterday's denial — which is exactly what makes AC-10's "deny, raise, allow"
  sequence legible after the fact rather than retroactively erased.
- **The browser never derives enforcement state.** No `parseFloat`, no
  `toFixed`, no arithmetic, and no comparison of a committed total to a cap.
  Money is formatted by string manipulation and truncated rather than rounded,
  because a rounded-up total could read as a cap reached while the plane still
  has headroom.

Three further properties are worth recording:

- **Reading creates nothing.** `findDailyLedger`, never `lockDailyLedger`.
  Absent usage is zero computed at read time. An operator opening a dashboard
  must not thereby acquire accounting rows for every idle agent, nor serialize
  the fleet view against live enforcement.
- **Usage comes from the ledger, never from events.** `spend.recorded` events
  still do not debit the authoritative ledger (Step 19), so summing them would
  show a number the plane does not enforce against, diverging silently.
- **A runtime block carries no fabricated receipt.** Ownership is persisted, and
  the UI states plainly that the control plane made no decision for a
  runtime-reported block.

**A mutation probe exposed a real coverage gap and it was closed.** Probe D
(swap `findDailyLedger` for `lockDailyLedger`) was initially caught only by
source guards: the route suite drives an in-memory store and never executes the
Drizzle read store at all, and the compiled-SQL suite tests the queries rather
than how the store composes them. A transcribed live test now executes that
composition, with a drift guard in `apps/api` keeping the transcription honest.

**AC-07 and AC-10 advance to `IMPLEMENTED / STAGING VERIFICATION BLOCKED`** —
both were partial only because their acceptance is observed through an operator
UI, and that UI now exists. Neither is PASS: nothing has run against a real
database.

## Step 18 note: precheck-linked settlement and no double debit

Step 18 changed **no acceptance criterion's status**. It closed an accounting
hole that would have made several of them wrong in production.

The invariant:

> **PRECHECK COMMITS THE AUTHORITATIVE USAGE.
> THE FOLLOW-UP EVENT RECORDS WHAT HAPPENED.
> THE EVENT NEVER COMMITS THAT USAGE AGAIN.**

A $4 precheck allow debits $4. The runtime then reports `spend.recorded` for
the work it just did, citing the receipt. The ledger must still read **$4, not
$8** — otherwise AC-07's "$25 cap" is reached at $12.50 of real spend, and
AC-08's $41 denial fires against a total nobody can explain.

Two decisions carry the weight:

- **"Linked events do not debit" is only safe if the link is TRUE.** Without
  verification, `precheck_id` becomes a way to make spend vanish: point any
  `spend.recorded` at any receipt and the plane records the money while
  charging nothing. Six checks close that — workspace, agent, event type,
  decision, category, amount — each a hard rejection that rolls the batch back.
  The amount comparison is exact micro-dollar `bigint`, so `"4"` equals
  `"4.000000"` and `4.000001` does not.
- **Nothing is written to the receipt.** No consumption flag, no settled-at
  column. Receipts stay immutable historical evidence and the linkage lives on
  `events.precheck_receipt_id`, which the Step 10 insert already carried. That
  also means there is no new mutable state to get concurrency wrong.

**The Step 10 ordering correction paid off again.** Settlement validation is
side-effect-free but it can *reject*, so it had to go strictly after the
duplicate decision — otherwise a replay carrying a stale `precheck_id` would
become a 400 instead of a duplicate. That is the changed-replay defect in a new
disguise, and a mutation probe confirmed the guards catch it eleven ways.

**One deliberate contract tightening.** A `heartbeat` carrying `precheck_id` is
now rejected. Step 9 placed the field on every variant for uniformity, but a
liveness ping is not the completion of a governed action and the linkage would
be meaningless. Two existing tests used `heartbeat` as a convenient minimal
carrier and were changed to a real follow-up event.

**No schema change and no migration.** `events.precheck_receipt_id` already
existed from Step 3, and `spend.recorded` already carried `amount_usd` as a
typed envelope field — so the amount could be compared without trusting
free-form `payload` JSON. The only addition is a read: a lean, workspace-scoped
`receiptQueries.findById`.

**Carried forward unchanged:** `spend.recorded` **without** a `precheck_id`
still does not debit the authoritative ledger. That is the next Credit step, and
Step 18 deliberately did not move it in either direction so the linked path
could be reviewed on its own.

## Step 19 note: authoritative event accounting

Step 19 changed **no acceptance criterion's status**. It closed the last
authoritative accounting gap in the Credit phase.

A NEW `spend.recorded` event carrying no `precheck_id` now debits the
authoritative UTC-day ledger **exactly once**. Before this, reported spend was
stored as audit data and moved no money, so an operator's "today's spend" was
only ever the prechecked subset.

The final model is two ingestion paths and one debit per economic action:

| Path | Trigger | Idempotency |
| --- | --- | --- |
| A | precheck **ALLOW** | `(workspace_id, action_id)` + advisory lock |
| B | NEW **unprechecked** `spend.recorded` | `(workspace_id, event_id)` + advisory lock |

The Step 18 linkage is what keeps B off a prechecked action, and event identity
is what makes B idempotent. **There is no `settled` / `accounted` / `debited`
column** — exactly-once falls out of the duplicate gate plus one transaction,
and a flag would be redundant state that could disagree with the event row.

Four decisions carry weight:

- **RECORDING IS NOT DECIDING.** The event path reads no policy. `precheck` asks
  whether an action *may* happen; this records that one *did*. A paused agent's
  reported spend is still recorded, and committed usage may legitimately exceed
  a configured cap. `$41` against a `$25` cap is the truth — clamping it would
  make the ledger a statement about policy rather than about money, and would
  hide the overspend an operator most needs to see. Only `numeric(14,6)`
  capacity can refuse, and it fails the whole batch rather than truncating.
- **The classification is receipt PRESENCE, not receipt content.** A `watch`
  precheck deliberately committed nothing; keying the debit off "the ledger did
  not move" would make its follow-up event commit on its behalf.
- **The batch became a staged transaction.** Two lock families are now
  involved, so ingest acquires each one completely, in a deterministic total
  order, before touching the next: event advisory locks by `(lockKey, eventId)`,
  agent rows by external id, then ledger rows by `(agentId, day)`. Without the
  last sort, two batches naming agents `[A,B]` and `[B,A]` would deadlock.
- **Agent-row ordering was a pre-existing hazard, now fixed.** `discover` is an
  upsert and takes a row lock; Step 10 resolved agents in submission order. The
  restructure sorts them, which removes a deadlock that predates Step 19.

**Verification honesty.** The in-process suite can now observe a double debit
for the first time: both fakes share one `MemoryLedger`, as production shares
one `ledger_daily`. Probe C (debit prechecked spend too) fails with
`expected '8.000000' to be '4.000000'` — the exact defect, caught behaviourally
rather than only by a source guard, which was the limitation reported in Step 18.
Concurrency, lost updates and deadlock remain provable only against real
PostgreSQL, and those 18 tests are skipped.

## Summary at Step 19

- `PASS`: **0**
- `IMPLEMENTED / STAGING VERIFICATION BLOCKED`: **11** (AC-01, AC-02, AC-04, AC-05, AC-06, AC-07, AC-08, AC-10, AC-11, AC-12, AC-13)
- `IMPLEMENTED PARTIAL`: **0**
- `FOUNDATION` / `FOUNDATION ONLY`: **2** (AC-03, AC-20)
- `BLOCKED`: **1** (AC-21)
- `NOT STARTED`: **2** (AC-18, AC-19)
- `DEFERRED`: **5** (AC-09, AC-14, AC-15, AC-16, AC-17)

11 + 0 + 2 + 1 + 2 + 5 = 21.

**Still zero PASS.** No criterion can be demonstrated without client-owned Neon,
Resend and Render.

**Every Credit-phase enforcement criterion is now code-complete.** AC-07, AC-08,
AC-10, AC-11 and AC-12 each have every artifact they name, end to end from
policy mutation through decision and denial to operator presentation. There is
no longer a criterion in this group waiting on further implementation.

**The environment risk is now the entire remaining risk, and it has not narrowed
at any point.** Eleven criteria are code-complete and **none** has ever run
against a real database. Every concurrency, atomicity, isolation and
accounting-day guarantee in Steps 10–19 is argued and tested-but-unrun. The
number of unverified criteria has grown at every step since Step 5; Step 17
added 18 skipped live tests, Step 18 added 13, and Step 19 adds 18 more —
including the only tests that can observe a lost update, a concurrent replay,
or a multi-agent deadlock at all.

**The Credit accounting contract is now code-complete.** Every path that can
move money exists, and each is idempotent by construction. What has never
happened is any of it running against a real database.

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
