# Credit Acceptance Traceability

Last updated: **2026-08-13** (Step 14 — authoritative UTC-day ledger foundation).

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
| AC-07 | Budgeted + $25 daily spend cap in UI | CREDIT | `IMPLEMENTED PARTIAL` | **Step 13 delivered the configuration half; Step 14 added the accounting half.** An operator can select `budgeted` and set a `$25.000000` cap; the value is stored exactly as `numeric(14,6)`, the policy version increments atomically, and the agent receives it on its next poll. Step 14 added the authoritative workspace/agent/UTC-day ledger with exact micro-dollar arithmetic and row-level serialization. **NOT COMPLETE:** nothing compares the cap to committed usage. No precheck endpoint, no denial, and `spend.recorded` still does not debit the ledger. |
| AC-08 | $41 over-cap denial + block/receipt | CREDIT | `FOUNDATION` | **Step 14 made a correct denial possible.** The authoritative ledger serializes concurrent decisions for one agent/day via `SELECT … FOR UPDATE`, so two requests cannot both read $20 and both commit $4 past a $25 cap. Exact micro-dollar arithmetic means $41 against a $25 cap is compared without float drift. **NOT IMPLEMENTED:** nothing denies anything. No precheck endpoint, no receipt, no block — the entire decision half is Step 15. |
| AC-09 | Immediate block email | LATER | `DEFERRED` | Out of Credit phase. |
| AC-10 | Cap raised and next spend allowed within 60 seconds | CREDIT | `FOUNDATION` | **Cap mutation and poll propagation are implemented**, and Step 14 proved the accounting side: raising a cap does **not** reset today's committed spend, so the "next spend allowed" must be evaluated against real retained usage. Guardrail tests assert the policy service writes no ledger and the ledger writes no policy. **NOT IMPLEMENTED:** next-spend enforcement. Nothing allows or denies a spend. |
| AC-11 | Publish cap 5/day, 6th denied | CREDIT | `FOUNDATION` | **Publish cap is configurable** and propagates, with `0` (nothing permitted) distinct from `null` (uncapped). Step 14 added the authoritative per-UTC-day publish counter, incremented in SQL under a row lock, so six concurrent publishes count as six and never five. **NOT IMPLEMENTED:** the 6th publish is not denied. No precheck, no block. |
| AC-12 | Pause next precheck denial + unpause | CREDIT | `FOUNDATION` | **Pause and unpause are configurable** — `mode = paused`, reverted to `watch` or `budgeted` by operator choice — and both propagate on the next poll. **NOT IMPLEMENTED:** the next precheck is not denied. There is no precheck endpoint and no kill switch; a paused agent is not stopped by anything. |
| AC-13 | Event replay idempotency | CREDIT | `IMPLEMENTED / STAGING VERIFICATION BLOCKED` | **Step 10 implemented ingest**, corrected after architecture review. `POST /v1/events` is mounted, bearer-authenticated, workspace derived from the credential row. One transaction per batch; the **duplicate decision precedes every one-time side effect**, serialized by a transaction-scoped `pg_advisory_xact_lock` keyed on `(workspace_id, event_id)` and acquired in deterministic order to avoid deadlock, with the Step 3 index `UNIQUE (workspace_id, event_id)` retained as defense in depth. Replaying a batch returns 200 with `accepted: 0, duplicates: N`; the stored count is unchanged, original rows untouched, `last_seen_at` not refreshed, and a replay carrying changed content creates no alternate block, agent or linkage. 92 in-process tests plus a real-socket run against the compiled build. **NOT PASS:** the live PostgreSQL suite — the only thing that can prove the advisory lock actually serializes, that a racing duplicate creates no alternate block or agent, that overlapping batches do not deadlock, and that cross-tenant isolation holds — is **SKIPPED**, gated on a `TEST_DATABASE_URL` that does not exist. |
| AC-14 | Gone-dark | LATER | `DEFERRED` | Out of Credit phase. |
| AC-15 | 11:00 UTC digest | LATER | `DEFERRED` | Out of Credit phase. |
| AC-16 | Filtered CSV parity | LATER | `DEFERRED` | Out of Credit phase. |
| AC-17 | Daily rollup | LATER | `DEFERRED` | Out of Credit phase. |
| AC-18 | Revocable read-only share link | CREDIT | `NOT STARTED` | None. |
| AC-19 | Public demo with recurring blocks | CREDIT | `NOT STARTED` | None. |
| AC-20 | Automated cross-tenant coverage | CREDIT — foundation | `FOUNDATION ONLY` | **1368 tests, 41 files.** Step 4 added the workspace-scoped repository layer: every tenant-owned query is proven to emit `workspace_id` in its predicate against real compiled SQL (37 assertions), no bypass helper exists, and ESLint blocks raw table access from apps. A live cross-tenant suite exists and exercises two tenants sharing identical `event_id` and `external_id` values — but it is **SKIPPED**, gated on an authorized `TEST_DATABASE_URL` that does not exist. **Real PostgreSQL isolation is therefore unproven at runtime**, and most Credit feature paths still do not exist to be covered. |
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

## Summary at Step 14

- `PASS`: **0**
- `IMPLEMENTED / STAGING VERIFICATION BLOCKED`: **6** (AC-01, AC-02, AC-04, AC-05, AC-06, AC-13)
- `IMPLEMENTED PARTIAL`: **1** (AC-07)
- `FOUNDATION` / `FOUNDATION ONLY`: **6** (AC-03, AC-08, AC-10, AC-11, AC-12, AC-20)
- `BLOCKED`: **1** (AC-21)
- `NOT STARTED`: **2** (AC-18, AC-19)
- `DEFERRED`: **5** (AC-09, AC-14, AC-15, AC-16, AC-17)

6 + 1 + 6 + 1 + 2 + 5 = 21.

**Still zero PASS.** No criterion can be demonstrated without client-owned Neon,
Resend and Render. **Six** criteria are code-complete and waiting only on an
authorized environment — that queue is the single largest risk to the delivery
date, and it has grown at every step since Step 5.

**A second risk remains:** AC-07, AC-08, AC-10, AC-11 and AC-12 all have their
configuration and accounting halves built and their **decision** halves entirely
unbuilt. Step 14 removed the ledger from that remaining work, but precheck,
decisions, receipts and blocks are still one body of work, so those five
criteria will move together or not at all.

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
