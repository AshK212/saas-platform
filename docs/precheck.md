# The Precheck Decision Engine

> **WHOEVER DENIES, RECORDS.**
>
> A plane denial writes a durable receipt **and** a plane-owned block, in one
> transaction. An allow writes a receipt and no block. Complete as of Step 16.

> **A precheck *allow* debits immediately**, in the same transaction as its
> receipt. A follow-up event carrying that `precheck_id` **never debits again** —
> see [event contracts](event-contracts.md#precheck-linked-settlement-step-18).
> Step 18 made that guarantee explicit and enforced the receipt claim behind it.
>
> **`spend.recorded` WITHOUT a `precheck_id` still does NOT debit the
> authoritative ledger.** That remains a known deficiency and is the NEXT Credit
> step.

> **Receipt and block presentation landed in Step 17.** See
> [governance-visibility.md](governance-visibility.md). Those surfaces are
> read-only and recompute nothing: a receipt always explains itself with the
> policy that produced it.

Sources: [`packages/contracts/src/precheck.ts`](../packages/contracts/src/precheck.ts) ·
[`apps/api/src/precheck/decide.ts`](../apps/api/src/precheck/decide.ts) ·
[`apps/api/src/precheck/store.ts`](../apps/api/src/precheck/store.ts) ·
[`apps/api/src/routes/precheck.ts`](../apps/api/src/routes/precheck.ts)

---

## The contract

```http
POST /v1/actions/precheck
Authorization: Bearer hmp_live_...
Content-Type: application/json
```

```jsonc
{ "action_id": "act-123", "agent_id": "agent-a", "category": "spend", "amount_usd": "4.000000" }
```

```jsonc
// 200 allow
{ "precheck_id": "…", "decision": "allow", "remaining": { "kind": "usd", "value": "1.000000" } }

// 200 deny
{ "precheck_id": "…", "decision": "deny",
  "remaining": { "kind": "usd", "value": "1.000000" },
  "reason": "daily_spend_cap_exceeded" }
```

**A denial is 200, not 4xx.** The caller asked and received an authoritative
answer; the request succeeded. A 4xx would invite generic retry logic that
hammers a paused agent.

| Field | Rule |
| --- | --- |
| `action_id` | Required, opaque, ≤200 chars. The **idempotency key**. Not tenant authority, not `precheck_id`, not `event_id`. |
| `agent_id` | External identifier. Resolved inside the credential's workspace. |
| `category` | `llm_call` · `tool_call` · `spend` · `publish` · `other` |
| `amount_usd` | **Required for `spend`, forbidden otherwise.** Decimal string, never a JSON number. |

Strict object. No `workspace_id`, no `tenant_id`, no `policy_version`, no
`precheck_id`, no `decision` — a caller states what it wants to do; the plane
decides. There is no publish *count*: one precheck is one intended publish.

`remaining` is a **typed object**, never a bare scalar. `"5"` could mean five
dollars or five publishes, and a runtime that guessed wrong would mis-budget
silently.

Errors: 401 (no/bad/revoked key, or a browser session), 400 `invalid_request`,
413 oversized body, 503 `precheck_unavailable`, 500 on an invariant failure.

---

## Authority

```text
Authorization: Bearer <key> → api_credentials row → workspace_id → WorkspaceScope
```

**Machine authentication only.** A browser session cookie returns 401: the
operator UI *changes* policy, the runtime *asks* about it. A session that could
precheck would blur that separation.

The path has no workspace segment and the body has no tenant field, so there is
nothing to point elsewhere.

---

## The decision transaction

```text
BEGIN
  1. advisory-lock the action identity          (idempotency)
  2. return the existing receipt if replayed    -> COMMIT, done
  3. discover/resolve the agent
  4. FOR SHARE the policy version + read the agent's policy   (consistency)
  5. lock the daily ledger row, if this category needs it     (serialization)
  6. decide
  7. if allowed and tracked: commit usage through the locked capability
  8. insert the immutable receipt
  9. if DENIED: insert the plane-owned block, linked to that receipt
COMMIT
```

Everything is one transaction. There is exactly one `db.transaction(`, one
`receipts.insert(` and one `createForDeniedPrecheck(` in the store, and
guardrail tests pin all three — including that **every** repository is built on
the transaction handle `tx`, never the pooled client `db`. A block written on
`db` would commit on a separate connection and survive a rolled-back decision:
false evidence that the plane refused something it never finished deciding.

### Commit-on-allow

**The release-critical rule.** The ledger mutation and the receipt share one
transaction, so:

- a failed receipt insert **rolls the debit back** — money spent but
  unexplainable is worse than a failed request;
- a failed debit **prevents the receipt** — a receipt claiming spend that never
  landed would be false evidence.

Never commit usage and then write the receipt on another connection.

### Denied actions never mutate the ledger

`cap 25, committed 24, requested 4` → deny, committed stays **24**. There is no
preemptive increment followed by a compensating subtraction: the commit is
gated on `decision.allow`, and a source guard pins that gate because the
production transaction body has no in-process behavioural coverage without a
database.

---

## Idempotency

Identity: **`workspace_id + action_id`**, enforced by a unique constraint.

A network retry of an allowed spend must not debit twice. Commit-on-allow makes
that a money defect, not a cosmetic one, so this is enforced by the database
rather than by application discipline — see the Step 15 migration.

A replay returns the **original** receipt and changes nothing. A replay carrying
a *different* agent, category or amount **also** returns the original: historical
action identity is not reinterpreted, and re-deciding would be a second chance
to spend.

Two simultaneous retries serialize on a `pg_advisory_xact_lock` keyed on
`(workspace_id, action_id)`; one decides and the other finds the committed
receipt. Transaction-scoped, never session-scoped — Neon and PgBouncer pool per
transaction.

---

## Policy consistency

The version and the agent's caps are read **in the same transaction** with the
version row locked `FOR SHARE`.

`FOR SHARE` rather than `FOR UPDATE` because:

- it blocks the policy **mutation** path (which takes `FOR UPDATE`) for the life
  of the deciding transaction, so the snapshot cannot change underneath;
- it lets concurrent prechecks proceed together. `FOR UPDATE` would serialize
  every precheck in a workspace against every other — a severe cost on a
  per-action call.

So each decision evaluates one internally consistent `(version, policy)` pair,
and the receipt can cite a version that genuinely produced it.

### Global lock order

```text
0. event identity advisory locks   (ingest only, own domain tag)
1. precheck action advisory lock
2. workspace_policy_state          (FOR SHARE in precheck, FOR UPDATE in Step 13)
3. agents row upsert               (ingest only)
4. ledger_daily row                (FOR UPDATE)
```

Every service taking more than one takes them in this order, and acquires each
family **completely, in a deterministic total order**, before touching the next.

| Service | Takes |
| --- | --- |
| Precheck decision | 1 → 2 → 4 |
| Policy mutation (Step 13) | 2 only |
| Event ingest (Steps 10, 19) | 0 → 3 → 4 |

**Nothing takes the ledger before the policy**, so no cycle can form there.

**Ingest and precheck cannot deadlock either.** The only family they share is
(4). Ingest never wants (1) or (2); precheck never wants (0) or (3). So precheck
may wait on ingest, but ingest can never wait on precheck — and a cycle needs
both directions.

**Two ingest batches cannot deadlock.** Within (0), (3) and (4) the acquisition
sequence is sorted — event locks by `(lockKey, eventId)`, agents by external id,
ledger rows by `(agentId, day)` — so two batches naming the same resources in
opposite submission order still request them in the same sequence. And because
every (0) lock is held before any (4) lock is requested, no transaction ever
holds a ledger row while waiting for an event lock.

---

## Decision semantics

| Mode | Behaviour |
| --- | --- |
| `watch` | **Always allow. Never touch the ledger.** Receipt still required. |
| `budgeted` | Compare the relevant cap; commit on allow. |
| `paused` | **Deny every category**, including `other`. Touch nothing. |

`watch` must not silently behave as budgeted accounting: an operator who has not
opted into enforcement has not opted into having usage counted against them
either. A `$41` spend under `watch` is allowed and **no ledger row is created at
all**.

`paused` is a kill switch, not a budget — an agent that can still act "a bit" is
not paused.

| Category | Cap | Ledger on allow |
| --- | --- | --- |
| `spend` | `daily_spend_cap_usd` | `+ amount_usd` |
| `publish` | `daily_publish_cap` | `+ 1` |
| `llm_call` · `tool_call` · `other` | none | none |

The locked Credit contract defines no accounting limit for `llm_call` and
`tool_call`; inventing one would enforce a budget nobody configured. Those
categories don't lock the ledger row at all, so they never contend.

### Uncapped budgeted still records

Under `budgeted` with a **null** cap, a tracked action is allowed **and
recorded**. The ledger is authoritative committed usage independent of whether a
cap currently exists — so if an operator adds a cap later the same day, the
morning's spend is already counted rather than silently forgiven.

### Cap comparison

```text
spend:    prospective = committed + requested   allow if prospective <= cap
publish:  prospective = committed + 1           allow if prospective <= cap
```

Exact micro-dollar integers, never floats. Spending the last cent of a budget is
*within* it; the next positive request is not.

```text
committed 20, requested 5, cap 25  ->  allow, remaining 0.000000
committed 25, requested 0.000001   ->  deny,  remaining 0.000000
```

### Remaining

- allowed and committed → `cap − NEW committed`
- denied → `max(cap − CURRENT committed, 0)`. **Never** subtract what was
  refused; that would report headroom the agent never consumed.
- null cap, untracked category, or a `paused`/`watch` decision → `null`

Floored at zero, so a cap lowered below committed usage reports `0`, not a
negative that would read as credit.

---

## Plane-owned blocks — WHOEVER DENIES, RECORDS

```text
ALLOW           DENY
  ledger commit   no ledger commit
  receipt         receipt
  NO block        plane-owned block, linked to the receipt
```

### Two block owners, never confusable

| | `source = 'runtime'` | `source = 'plane'` |
| --- | --- | --- |
| Who refused | The plugin, reporting it | The control plane, deciding it |
| Written by | Event ingest (Step 10) | The precheck decision transaction |
| External id | Client-supplied, deduplicated | **NULL** |
| Module | `repositories/blocks.ts` | `repositories/plane-blocks.ts` |

Each module **hardcodes** its own `source`, and in neither is `source` a
parameter. No caller — and no future refactor passing an input object through —
can fabricate enforcement authority the plane never exercised. There is no
generic `createBlock`: a block claiming the plane denied something it never
evaluated is worse than no block at all.

The precheck request is unchanged and still accepts only `action_id`,
`agent_id`, `category`, `amount_usd`. `source`, `rule`, `reason` and `block_id`
are governance **outputs**; sending any of them is a 400.

### Why plane blocks carry no external id

`external_block_id` is nullable and unique per workspace. PostgreSQL treats
NULLs as distinct, so any number of plane blocks coexist. Synthesising a value
like `plane_<precheck_id>` would falsely imply a runtime reported it, and the
internal UUID is already canonical.

### Linkage

The foreign key is modelled **once**, on `blocks.precheck_receipt_id`. That was
a deliberate Step 3 decision and it is what makes this step simple:

- no circular FK, so no deferred constraint and no insertion puzzle;
- **the receipt stays insert-only**. Storing `block_id` on the receipt would
  require updating it after the block is written, contradicting the
  immutability that makes it trustworthy evidence.

Order is therefore receipt → block, with nothing updated afterwards. Both
directions remain queryable: a receipt's block is
`blocks WHERE precheck_receipt_id = :receipt`, served by a partial index, and
exposed as `findByReceiptId`. Because the pair is written in one transaction the
linkage is atomic either way.

### Denial evidence

| | Recorded |
| --- | --- |
| spend | `amount_usd` = requested, `count` = null |
| publish | `count` = 1, `amount_usd` = null |
| paused (`other`/`llm_call`/`tool_call`) | neither |

Publish counts never go in the spend column. The block carries the same
workspace, agent, category and instant as its receipt — one decision, not two
events milliseconds apart.

### One denial vocabulary

`reason` answers *what happened*; `rule` answers *which control fired*. They are
different vocabularies so reasons can gain nuance later without renaming a
stable governance control.

```text
daily_spend_cap_exceeded    -> daily_spend_cap     "Daily spend cap reached."
daily_publish_cap_exceeded  -> daily_publish_cap   "Daily publish cap reached."
paused                      -> agent_paused        "Agent is paused."
```

Defined **once** in `contracts/src/denial.ts` as a
`Record<PrecheckDenyReason, DenialRule>`, so adding a reason without deciding
its control fails to compile. Route code never invents a string, so the receipt,
the block and the wire response cannot disagree about why one action was
refused.

### The block reuses the decision context

No second policy read and no second ledger lock. Re-reading policy after the
decision could populate the block from a **newer** version than the receipt
cites, so the pair would tell inconsistent stories. The block is an audit side
effect, not another accounting decision.

### A policy change is not a denial

Setting `mode = paused` creates **no block**. Blocks arise from refused
*actions*: the next precheck denies and records one. This distinction is the
substance of AC-12.

### Replay

The Step 15 idempotency boundary covers blocks too. A replay of a denied action
returns the original receipt and creates **no second block** — including a
replay carrying a different agent, category or amount. Historical action
identity is not reinterpreted.

### Atomicity

Every governance artifact succeeds together or not at all:

- a failed **block** insert rolls the receipt back — a receipt with no block
  would misrepresent the audit trail;
- a failed **receipt** insert leaves no block;
- either failure leaves the ledger untouched.

## Every decision produces one receipt

Allow, deny, watch, uncapped, untracked — every governance decision is recorded.

Requests rejected **before** the decision (bad key, malformed body) correctly
produce none: no governance decision was made.

Receipts are **immutable**. The repository has an `insert` and no `update` or
`delete`, and a guardrail enforces that. A "latest receipt" that could be
overwritten would be worthless as evidence.

### Recorded evidence

| | |
| --- | --- |
| `id` | The plane-generated UUID returned as `precheck_id`. Never client-controlled. |
| `action_id` | Runtime action identity, added in Step 15 |
| `workspace_id`, `agent_id`, `category` | |
| `requested_amount_usd` / `requested_publish_count` | Exact decimal, or `1` for a publish |
| `decision`, `deny_reason` | A denial must carry a reason (check constraint) |
| `policy_version` | **Exact**, as `bigint`, never through a JS number |
| `applied_mode`, `applied_spend_cap_usd`, `applied_publish_cap` | The policy that produced it |
| `accounting_day` | Server UTC day, recorded even for untracked categories |
| `ledger_spend_before_usd`, `ledger_publish_before` | Usage as read, before any commit |
| `remaining_spend_usd`, `remaining_publish_count` | What was reported to the caller |
| `created_at` | |

A receipt explains itself **without consulting current policy**. An operator can
change caps a second later and last week's denial is still explicable — reading
today's `agent_policies` to explain an old decision would be wrong by
construction.

---

## Server time

One clock reading per decision, taken at the route and threaded through. The
UTC accounting day is derived from it **once**, so the ledger day and the
receipt's day cannot disagree. A caller's clock is never consulted, and neither
is an event's `occurred_at`.

---

## Agent discovery

An unknown `agent_id` is **discovered**, exactly as event ingest does, so a
runtime may precheck before sending its first event. Requiring registration
first would mean losing governance on an agent that restarted or deployed by a
different path — the failure mode being *less* governance, which is the wrong
direction.

Discovery does not advance `last_seen_at`: a precheck is a request for
permission, not evidence of activity. It creates no policy row — governance
state is operator-owned, and a precheck that wrote one would be an agent
configuring itself.

---

## What this does NOT do

- **No policy mutation.** The store imports the policy READ repository only; a
  guardrail asserts it cannot reach the mutation service.
- **No events.** No `agent.action`, no precheck-emitted `action.blocked`. The
  audit event stream stays uncoupled — emitting one would risk a
  deny → block → event → block-ingest loop that nobody designed.
- **No runtime block is ever rewritten** by a plane decision.
- **No receipt or block read API on the MACHINE surface.** The precheck response
  returns `precheck_id` and deliberately does **not** expose `block_id`. The
  Step 17 operator routes carry that linkage, and they are session-authenticated
  only — a runtime that can be denied must not be able to read the whole
  tenant's denial history.
- **No `spend.recorded` ledger debit** — Step 19.
- **No rate limiting.** Precheck is high-frequency and a valid key can abuse it.
  Carried as a production exposure risk; correctness first.

## Carried observation: CSRF and machine clients

The Step 6 origin guard rejects **any** non-allowlisted `Origin` header on a
state-changing `/v1/*` request — including a bearer-authenticated one that
carries no ambient cookie authority. Verified over a real socket.

Most machine clients never send `Origin`, so this rarely bites, and it is not
introduced here: `POST /v1/events` behaves identically. But a runtime behind a
browser-like HTTP client would need its origin on the allowlist. Recorded so it
is a known property rather than a surprise in staging.

## Verification status

| Behaviour | Evidence |
| --- | --- |
| Every decision branch, cap boundaries, exact arithmetic | 51 pure-function tests |
| Auth domain, validation, idempotency, watch/paused, atomicity, isolation | 70 route tests |
| Block-on-deny only, AC-08/11/12 sequences, replay, metadata, ownership, rollback | 36 block tests |
| Ordering, allow-gate, `tx`-not-`db`, ownership hardcoding, receipt immutability | boundary guards (mutation-probed) |
| Denial vocabulary agreement across packages | 35 cross-package tests |
| **Commit-on-allow serialization, retry-safety, real rollback, `FOR SHARE` consistency, atomic receipt+block, cross-tenant FK refusal** | `packages/db/tests/precheck.live.test.ts` — **gated on `TEST_DATABASE_URL`; currently SKIPPED** |

The production transaction body has **no in-process behavioural coverage** — it
needs a real database. Its invariants are pinned by source-level guards until
the live suite can run.
