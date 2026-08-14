# The Precheck Decision Engine

> **Step 15 implements the decision and the receipt. Plane-owned blocks are
> Step 16.**
>
> A denial produces a durable receipt but **no block row yet**. That is the only
> enforcement gap in this step, and it is why AC-08, AC-11 and AC-12 are not
> complete.

> **`spend.recorded` events still do NOT debit the authoritative ledger.** That
> is Step 19, and it is a different path from this one. A precheck *allow* does
> debit, immediately and in the same transaction as its receipt.

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
COMMIT
```

Everything is one transaction. There is exactly one `db.transaction(` and one
`receipts.insert(` in the store, and guardrail tests pin both.

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
1. precheck action advisory lock
2. workspace_policy_state      (FOR SHARE in precheck, FOR UPDATE in Step 13)
3. ledger_daily row            (FOR UPDATE)
```

Every service taking more than one takes them in this order. Step 13's policy
mutation takes only (2). Step 10's event ingest takes only its own advisory
family, under a different domain tag so an `event_id` and an `action_id` sharing
text never share a lock. **Nothing takes the ledger before the policy**, so no
cycle can form.

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

## What Step 15 does NOT do

- **No plane-owned blocks.** A denial has a receipt but no block row. Step 16
  implements *whoever denies, records*.
- **No policy mutation.** The store imports the policy READ repository only; a
  guardrail asserts it cannot reach the mutation service.
- **No events.** No `agent.action`, no `action.blocked`. The audit event stream
  stays uncoupled until it is deliberately joined.
- **No receipt read API or dashboard.** The response returns `precheck_id`;
  presentation is a later step.
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
| Ordering, allow-gate, no policy/block/event coupling, receipt immutability | boundary guards (mutation-probed) |
| **Commit-on-allow serialization, retry-safety, real rollback, `FOR SHARE` consistency** | `packages/db/tests/precheck.live.test.ts` — **gated on `TEST_DATABASE_URL`; currently SKIPPED** |

The production transaction body has **no in-process behavioural coverage** — it
needs a real database. Its invariants are pinned by source-level guards until
the live suite can run.
