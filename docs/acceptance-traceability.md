# Credit Acceptance Traceability

Last updated: **2026-08-14** (Step 21 — revocable read-only sharing).

Acceptance criteria are recorded exactly as defined; this document tracks status
only and does not redefine any criterion.

## Status legend

| Status | Meaning |
| --- | --- |
| `NOT STARTED` | No implementation work has begun. |
| `FOUNDATION ONLY` | Structural groundwork exists; the acceptance condition itself is **not** met. |
| `BLOCKED` | Cannot progress until an external dependency is supplied. |
| `IMPLEMENTED / STAGING VERIFICATION BLOCKED` | Feature is complete and locally tested, but its acceptance condition has never been demonstrated in an authorized environment. **This is not PASS.** |
| `IMPLEMENTED / CLIENT GITHUB VERIFICATION BLOCKED` | Same standing, different missing resource: the artifact is complete and locally verified, but its acceptance condition can only be observed inside a client-owned GitHub repository, and none exists. **This is not PASS.** |
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
| AC-03 | Documented simulator / reference command | CREDIT — baseline | `IMPLEMENTED / STAGING VERIFICATION BLOCKED` | **Step 20 built the reference client.** One documented command — `CONTROL_PLANE_URL=… CONTROL_PLANE_API_KEY=… pnpm simulator <scenario>` — with eight scenarios covering the Credit flows (baseline, over-cap, cap-raise retry, publish burst, pause probe, replay, unprechecked spend, continuous stream) and a full operator walkthrough in [simulator.md](simulator.md). It is an ORDINARY API CONSUMER: one workspace API key, four machine routes, no database import, no workspace id, no operator authority — each enforced by lint and by architecture guards. 25 tests drive it over a **real HTTP socket**; 30 guards pin the boundaries; the compiled CLI was exercised against a local fake control plane. **NOT PASS:** it has never run against an authorized staging environment, because no client-owned Neon, Render or GitHub resource exists. |
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
| AC-18 | Revocable read-only share link | CREDIT | `IMPLEMENTED / STAGING VERIFICATION BLOCKED` | **Step 21 implemented the whole criterion.** An operator issues a `hmp_share_<id>_<secret>` link carrying **256 bits** of CSPRNG secret; only a SHA-256 digest and an INDEPENDENT non-secret prefix are stored, and the plaintext is returned exactly once with no recovery endpoint. The link opens in a private window with **no sign-in**, showing fleet governance state, the timeline with raw JSON drill-through, receipts and blocks — all through the SAME read stores and mappers the operator UI uses, driven by a scope derived from the share ROW. It renders **no edit controls** and authorizes **no mutation**: `ReadOnlyShareContext` carries no user, no role and no permission set. The token is POSTed once and exchanged for an HttpOnly `Path=/v1/share` cookie holding that same token, so every read re-resolves it against `revoked_at IS NULL` — revocation kills an open session on the next request, and re-pasting the original URL buys nothing. Unknown, malformed, revoked and cross-tenant all return an identical `invalid_share`. 51 route tests, 47 architecture guards. **NOT PASS:** never demonstrated in an authorized environment, and the 10 live tests proving hash-at-rest on disk and cross-tenant isolation are **SKIPPED**. |
| AC-19 | Public demo with recurring blocks | CREDIT | `IMPLEMENTED / STAGING VERIFICATION BLOCKED` | **Step 22 implemented the whole criterion.** An operator toggles a workspace public and receives a slug-addressed URL that opens for **anyone, with no credential of any kind** — no account, no invitation, no token, no cookie — showing the live fleet with ledger-sourced spend against caps, the enforcement blocks, the precheck receipts and the event timeline with raw JSON drill-through, all through the **same read stores and the same row mappers** the operator UI and the AC-18 share surface use. The slug is a **public locator, not a bearer secret**: authorization is the `demo_enabled = true` predicate carried in the WHERE clause of every resolution, so a private workspace is never in the result set and a leaked former slug buys nothing. Disable is immediate and total — the flag drops and the slug is cleared in one statement, so a page already open dies on its next 15-second refresh; re-enabling issues a NEW slug and the old URL stays dead. `ReadOnlyDemoContext` carries no user, no role and no permission set and is deliberately not an `AuthorizedWorkspace`, so no mutating store will accept it; the public router is GET-only and imports no mutation store at all. Recurring blocks are produced by a **mode of the reference client** over the real machine API — register, poll, precheck, report — which cannot fabricate a block, cannot edit policy, and obeys an `allow` rather than lowering the cap to keep the demo interesting; each cycle carries a **fresh `action_id`**, without which the plane would replay the first decision forever and write no new block. 41 route tests, 39 architecture guards, 14 generator tests. The compiled API was exercised over a **real TCP socket** and the compiled generator ran **unbounded** against a fake plane enforcing precheck idempotency, producing 4 over-cap attempts with **4 distinct action ids and 4 distinct plane-written blocks**, zero replays. **NOT PASS:** never demonstrated in an authorized environment, and the 11 live tests proving the SQL predicate, the check constraint and cross-tenant isolation against real PostgreSQL are **SKIPPED**. |
| AC-20 | Automated cross-tenant coverage | CREDIT — foundation | `IMPLEMENTED / STAGING VERIFICATION BLOCKED` | **Step 23 built the comprehensive suite.** A single application with all fourteen stores mounted drives TWO workspaces whose external identifiers collide on purpose - the same `agent-1`, `evt-shared-001`, `act-shared-001` and `blk-shared-001` in both - so a missing workspace predicate returns the WRONG TENANT'S ROW rather than nothing. Both tenants are also given different governance ($25 vs $99 caps, versions 1 vs 7, a `deny` vs an `allow` on the shared action), so a leak changes an enforcement decision and not merely a privacy boundary. Every one of B's internal UUIDs - agent, event, receipt, block, share, workspace - is captured and fed back through each of A's four authorities. **Three layers, three separate claims:** 111 HTTP tests prove every surface derives its scope from the right authority and never from a body, query string, header or path; 172 compiled-SQL tests prove EVERY tenant-owned query in the package carries `workspace_id` as a bound parameter, with a guard that fails if a new query builder appears uncovered; 23 live PostgreSQL tests would prove the database itself refuses cross-tenant rows. Authority confusion is tested explicitly - an API key cannot mutate policy or read operator history even for its own workspace, a session cannot ingest or precheck, a share cookie reaches no operator or machine route, and NO non-GET route exists under any public prefix (asserted by interrogating the router, not by probing known paths). 28 authority checks also ran against the COMPILED build over a real TCP socket. Eleven mutation probes were applied and reverted; each failed as intended, and one exposed a genuine gap in the new suite that was then closed. Full detail in [tenant-isolation.md](tenant-isolation.md). **NOT PASS:** the 23 live tests are **SKIPPED** for want of a `TEST_DATABASE_URL`, so every workspace-scoped unique constraint, every composite foreign key, the ledger primary key and the demo CHECK constraint remain argued and unrun. AC-20 asks for an automated cross-tenant test that PASSES, and one third of it has never executed. |
| AC-21 | CI green on `main` | CREDIT | `IMPLEMENTED / CLIENT GITHUB VERIFICATION BLOCKED` | **Step 24 built the gate.** One workflow, two jobs. `verify` runs the repository's own canonical `pnpm verify` (lint, typecheck, the whole 2528-test in-process suite, production builds of API, web and simulator) plus TWO schema checks that are not redundant: `db:check` validates the migration journal's internal consistency, and the new `db:drift` runs the generator and fails if anything changed - catching a schema edit whose migration was never generated, which `db:check` structurally cannot see. `integration` starts a **disposable PostgreSQL 17 service** and runs the live suites against it, which is the first time this project has had any way to execute the 236 live tests - including the AC-20 cross-tenant acceptance. Reproducibility is total: Node from `.nvmrc` (20.20.2), pnpm from `packageManager` (10.34.5), a pinned Postgres major, `--frozen-lockfile` in both jobs, and only first-party actions. **`DATABASE_URL` is scoped to the migration STEP alone**, so the live-test step's environment contains only `TEST_DATABASE_URL` and the never-fall-back invariant is literally true rather than intended. A green job that ran nothing is treated as the primary hazard: `test:db:ci` hands the run's counts to `scripts/check-live-coverage.mjs`, which fails on any skip, an empty collection, zero passes, or `CI` set without a database - because "236 skipped" exits 0 and would otherwise be indistinguishable from success. Local development is unchanged: `pnpm test:db` still skips safely and no developer needs PostgreSQL for `pnpm verify`. Security posture is `contents: read` only, no `pull_request_target`, no secret of any kind, no deployment step, and no swallowed failure (`continue-on-error`, `|| true`, `if: always()` all absent). 53 contract assertions in `tests/ci-contract.test.ts` pin every one of these properties, eight of them by running the skip-detector as a subprocess; seven mutation probes were applied and reverted, each caught. Full detail in [ci.md](ci.md). **NOT PASS:** there is **no GitHub remote**, so no Actions run has ever occurred and the workflow YAML has never been parsed by GitHub. Two consequences are unproven and not claimed: the integration job has never executed (no Docker or local PostgreSQL was available), and the live suites have therefore still never run - though it WAS proven locally that the skip gate opens, since pointing `TEST_DATABASE_URL` at an unreachable host makes the suites execute and fail rather than skip. |

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

## Step 20 note: the reference client

Step 20 advanced exactly one criterion — **AC-03**, from `FOUNDATION ONLY` to
`IMPLEMENTED / STAGING VERIFICATION BLOCKED` — and deliberately advanced no
others. A simulator existing does not demonstrate AC-04 through AC-13; those
need the operator steps and a real control plane.

The client's job is to prove the **public API is sufficient** to run a governed
fleet. That proof is only worth something if the client is genuinely
unprivileged, so three properties are enforced rather than asserted:

- **No database.** HTTP only. The whole `@hybrid/db` package is blocked by a
  simulator-specific lint rule and by an architecture guard, so the proof
  cannot be quietly undermined by reaching behind the API.
- **No operator authority.** It cannot set a cap, pause an agent, or read a
  receipt. Every acceptance scenario documents an operator precondition it
  cannot satisfy itself — which is the product, not a limitation. A runtime
  that could raise its own cap would make governance decorative.
- **No local governance.** It never computes a verdict: no `41 > 25`, no
  publish counter, no mode inspection. A second engine drifts from the first
  the moment an operator changes policy.

Two decisions in the client are worth recording, because both are the kind of
thing a reasonable implementer gets wrong:

- **A retry reuses the SAME id; a new attempt gets a NEW one.** The body is
  serialised once and replayed byte-identically, so a lost response cannot
  become a second $4 spend. But after an operator raises a cap, the retry is a
  *new action* — the denied `action_id` has a durable receipt and correctly
  replays its denial forever, which would look exactly like the raise not
  taking effect. `docs/simulator.md` states this prominently.
- **A plane denial produces no client-side block.** The plane already wrote the
  receipt and its own block before answering. An `action.blocked` event too
  would put two records in the audit for one refusal, and an operator could not
  tell which system stopped the work.

**Verification is honest about its limits.** 25 tests drive the client over a
real HTTP socket rather than a stubbed `fetch` — a stub would let a client that
sends malformed JSON or mishandles a 304 pass everything. The compiled CLI was
then run against a local fake control plane, so the executable itself is
proven, not just its modules. None of that is staging.

## Step 21 note: revocable read-only sharing

Step 21 advanced **AC-18** from `NOT STARTED` to
`IMPLEMENTED / STAGING VERIFICATION BLOCKED`, and advanced nothing else. AC-19
remains `NOT STARTED`.

Sharing introduces a **third read authority**. Operator membership, an API
credential and now a share token all end in a `WorkspaceScope` and differ only
in what else they carry — and a share carries *nothing*: no user, no role, no
permission set. Read-only is a property of the type, not a check a future route
might forget.

Three decisions carry the weight:

- **The cookie holds the token, not a derived session.** The tempting design is
  a signed session carrying the share id. That would be a second, independent
  credential, and a second credential can outlive the first — a viewer still
  reading after revocation is exactly the failure the criterion exists to
  prevent. Holding the original token means every read re-resolves it against
  `revoked_at IS NULL`, so revocation is authoritative by construction.
- **The token appears in one request, not every request.**
  `/v1/share/:token/events` would be simpler and would write a live bearer
  credential into every access log, proxy log, history entry and `Referer` for
  the life of the session. It is POSTed once instead, in a body, and the
  browser URL is stripped immediately after.
- **Reuse, not copy.** The share routes call the same read stores and the same
  row mappers the operator UI uses. Making that possible meant changing those
  stores to take a `WorkspaceScope` rather than an `AuthorizedWorkspace` — a
  scoped read has no business knowing how the scope was proven, and the old
  signature would have forced the share path to fabricate a membership. A
  parallel read model would have drifted, and a shared view describing a
  different system than the operator sees is worse than none.

**No schema change.** The Step 3 `share_tokens` table already had exactly the
right shape — a unique prefix, a unique digest, a `revoked_at` timestamp and no
column capable of holding a plaintext token.

**A mutation probe exposed a real coverage gap and it was closed.** Probe A
(resolve globally rather than from the token's own row) initially passed every
behavioural test, because only one workspace held a share link in them — a
resolver picking the wrong row would still have looked correct. A test where
both tenants hold links, issued in the "wrong" order, now makes that probe
fail.

## Summary at Step 24

- `PASS`: **0**
- `IMPLEMENTED / STAGING VERIFICATION BLOCKED`: **15** (AC-01 … AC-08, AC-10 … AC-13, AC-18, AC-19, AC-20)
- `IMPLEMENTED / CLIENT GITHUB VERIFICATION BLOCKED`: **1** (AC-21)
- `IMPLEMENTED PARTIAL`: **0**
- `FOUNDATION` / `FOUNDATION ONLY`: **0**
- `BLOCKED`: **0**
- `NOT STARTED`: **0**
- `DEFERRED`: **5** (AC-09, AC-14, AC-15, AC-16, AC-17)

15 + 1 + 0 + 0 + 0 + 0 + 5 = 21.

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

**The Credit accounting contract is now code-complete**, a reference client can
drive the whole flow over the public API (Step 20), and a workspace can be
shared read-only and revoked (Step 21). Every path that
can move money exists, and each is idempotent by construction.

What has never happened is any of it running against a real database or a real
staging deployment. Thirteen criteria are code-complete and blocked on exactly
one thing.

**No Credit-phase criterion remains unstarted.** AC-19 was the last, and Step
22 implemented it. Everything the Credit phase asks for now exists as code.

What that sentence does **not** mean: the number of criteria that have been
demonstrated is still **zero**, and it has been zero at every step. The gap
between "code-complete" and "verified" has widened monotonically for eighteen
steps and has never once narrowed. Fourteen criteria are now waiting on the
same single unblocker — a client-owned Neon database, a Render deployment and a
GitHub repository — and the count of skipped live tests has grown again, by 11.

**Every implementation-side Credit criterion is now complete.** Sixteen of the
sixteen non-deferred criteria have their code, their tests and their
documentation. Nothing remains to be built.

What remains is entirely environmental, and it is one thing wearing two hats: a
client-owned GitHub repository and a client-owned Neon/Render staging
environment. AC-21 needs the first. The other fifteen need the second.

**Step 24 turned the environmental blocker into something a single external
action resolves.** The CI pipeline now carries a disposable PostgreSQL service,
so the 236 live tests no longer need Neon in order to execute - they need only a
repository to run in. The first push to a client-owned remote will, in one run,
either produce the AC-20 database evidence that fifteen criteria are waiting on,
or tell us precisely what is wrong. Neither outcome is available today.

**Step 23 completed AC-20's implementation and, in doing so, sharpened the
statement of what is missing.** Isolation is now asserted in three layers, and
only the third can settle it. Layers one and two are arguments about code -
that each surface derives its scope from the right authority, and that every
query carries the predicate. Layer three is the only one that can watch
PostgreSQL refuse a row, and it has never run. Fifteen criteria are now
code-complete and blocked on the same single unblocker.

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

AC-21 requires CI **green on `main`**. The existence of a workflow YAML file does
not satisfy it, and Step 24 does not pretend otherwise.

What Step 24 delivered is the gate itself: two jobs, a disposable PostgreSQL 17
service, two distinct schema checks, an enforcement script that makes an
all-skipped integration run a failure, and 53 contract assertions that stop the
pipeline being quietly weakened later. Every command in it that is not
GitHub-specific was executed locally and passes.

Three things stand between that and PASS, and none of them is code:

1. **No remote exists.** No Actions run has occurred anywhere, so "green on
   `main`" has no referent. A developer-owned repository would not count — the
   delivery contract places ownership with Ashir.
2. **The workflow YAML has never been parsed by GitHub.** It is asserted to be
   tab-free, evenly indented and structurally consistent. That is not the same
   as accepted by Actions.
3. **The integration job has never executed.** No Docker daemon or local
   PostgreSQL was available on this machine. The skip gate was proven to open —
   with `TEST_DATABASE_URL` pointed at an unreachable host the live suites
   execute and fail rather than skip — but the disposable-service path, the
   migration step and the 236 live tests themselves remain unrun.

The first push to a client-owned repository resolves all three in a single run.

See [ci.md](ci.md) for the pipeline and
[client-delivery-status.md](client-delivery-status.md) for the obligation.

## Rerun policy

After any fix made in response to an acceptance failure, the **full Credit
acceptance suite is rerun** — not only the failing criterion. This document is
updated with the result of that full rerun.
