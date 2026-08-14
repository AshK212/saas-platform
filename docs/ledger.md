# The Authoritative UTC-Day Ledger

> **THE PLANE IS THE LEDGER; THE PLUGIN IS THE HANDS.**
>
> This table is the single authoritative record of what has been committed. A
> runtime never writes to it. There is no second ledger for prechecks, events or
> the UI.

> ## Two ingestion paths, one per economic action
>
> As of **Step 19** the ledger has exactly two writers:
>
> | Path | Trigger | Owner |
> | --- | --- | --- |
> | **A** | a precheck **ALLOW** for spend or publish | Step 15 |
> | **B** | a NEW **unprechecked** `spend.recorded` event | Step 19 |
>
> The same economic action uses **exactly one**. A prechecked action takes A,
> and its follow-up event is audit evidence that debits nothing — the Step 18
> linkage is what keeps B off it. An unprechecked action takes B, and event
> identity is what makes B idempotent.
>
> There is no `settled` / `accounted` / `debited` column. Exactly-once comes
> from event identity plus one transaction, not from a flag that could disagree
> with the event row.

> **Recording is not deciding.** Path B consults **no policy**. A paused agent's
> reported spend is still recorded, and committed usage may legitimately exceed
> a configured cap — `$41` against a `$25` cap is the truth. Clamping it would
> make the ledger a statement about policy rather than about money, and would
> hide exactly the overspend an operator needs to see. Only `numeric(14,6)`
> capacity can refuse a write, and it does so by failing the whole batch rather
> than truncating.

Sources: [`packages/db/src/accounting/money.ts`](../packages/db/src/accounting/money.ts) ·
[`packages/db/src/accounting/utc-day.ts`](../packages/db/src/accounting/utc-day.ts) ·
[`packages/db/src/repositories/ledger.ts`](../packages/db/src/repositories/ledger.ts)

---

## The authoritative key

```text
workspace_id + agent_id + UTC day
```

Exactly one row per combination, enforced by the composite primary key on
`ledger_daily`. Two authoritative values per row:

| Column | Type | Meaning |
| --- | --- | --- |
| `spend_committed_usd` | `numeric(14, 6)` | Committed USD spend for that agent, that day |
| `publish_count_committed` | `integer` | Committed publishes for that agent, that day |

Both start at **0**, never null. Null would make "no spend yet"
indistinguishable from "unknown", and every later addition would need a coalesce
that could silently mask a missing row.

---

## The UTC accounting day

The boundary is **UTC, always**. Local time gives a different boundary per
server, per operator and per agent, and shifts twice a year under daylight
saving — so "today's spend" would depend on who was asking and in which month.

```text
2026-08-12T23:59:59.999Z  ->  2026-08-12
2026-08-13T00:00:00.000Z  ->  2026-08-13
```

One millisecond apart, two accounting days.

Derivation is `instant.toISOString().slice(0, 10)`, which renders in UTC by
definition and cannot vary with a host's `TZ`. There is no `getFullYear`,
`getMonth`, `getDate`, `toLocaleDateString`, `getTimezoneOffset` or `Intl`
anywhere in the accounting module — a guardrail test enforces each.

**DST is irrelevant** because UTC never shifts. Instants either side of both the
US and EU transitions land on exactly the day their UTC timestamp says.

### The day is server authority

`UtcAccountingDay` is a **branded type**, like `WorkspaceScope`. The only way to
obtain one is `toUtcAccountingDay(serverInstant)` or `parseUtcAccountingDay` on a
value PostgreSQL returned. A future route cannot pass `req.query.day` through —
it is a compile error, not a review catch.

That matters because a caller choosing their accounting day could charge today's
overspend to tomorrow, or replay yesterday's headroom. A guardrail test also
asserts no request schema carries a `day` field and no route reads one.

The instant itself comes from **one server clock reading per transaction**, so
the ledger day, the decision timestamp and the future receipt's recorded day
cannot disagree. Never `new Date()` called repeatedly through a decision, and
never an event's `occurred_at`, which is untrusted client metadata.

---

## Exact money: micro-dollar integers

Every authoritative amount is a `bigint` count of micro-dollars.

```text
1 USD = 1_000_000 micros
"25.123456"  <->  25123456n
maximum       =   99999999999999n  ("99999999.999999")
```

The column scale is fixed at 6, so every storable value is an exact whole number
of micros and the mapping is lossless both ways. Addition and comparison become
ordinary integer operations that cannot drift.

### Why not floats

A *single* amount at this scale does survive a double — 14 significant digits
fit. The hazard is **arithmetic**, and a ledger exists to do arithmetic:

```text
0.1 added ten times     ->  0.9999999999999999,  not 1
10.10 + 10.20 + 4.70    ->  24.999999999999996,  not 25
```

The second is the dangerous direction: committed spend that is exactly at a $25
cap reads as *under* it, so the ledger believes headroom remains and allows a
further spend past the cap. Both cases are asserted as tests.

There is no `parseFloat`, `Number()`, `toFixed()` or float addition anywhere on
the authoritative path.

### Why not a decimal library

The fixed scale turns this into integer arithmetic, which `bigint` already does
exactly. A general decimal library would add supply-chain surface to solve a
problem the fixed scale has already removed.

### Canonical form

**Always six fractional digits** — `0.000000`, `25.000000`. PostgreSQL may hand
back `0` or `25.0` depending on the path; everything crossing the repository
boundary is normalised, so `25`, `25.0` and `25.000000` never all appear for one
amount. The wire contract in `@hybrid/contracts` defines the same shape
independently (it cannot import the database package), and an agreement test in
`apps/api` — which depends on both — proves the two never drift.

---

## Repository primitives

```ts
createLedgerRepository(executor, scope)
  .findDailyLedger(agentId, day)   // read, NO lock. Observability only.
  .lockDailyLedger(agentId, day)   // create if absent, lock, return capability
```

That is the **entire** public surface: a read and a lock. Mutation lives on the
capability the lock returns:

```ts
interface LockedDailyLedger {
  readonly current: DailyLedgerState;
  commitSpend(amountUsd: string): Promise<DailyLedgerState>;
  commitPublish(count?: number): Promise<DailyLedgerState>;
}
```

### Why mutation is a capability, not a method

An earlier revision exposed `commitSpend(agentId, day, amount)` directly on the
repository. It could be called **without ever locking** — a read-modify-write
with no serialization, which is precisely the lost-update race this module
exists to prevent. Correct sequencing must not rest on developer discipline.

Now the unsafe call is not merely discouraged, it is **unspeakable**: the
mutation functions do not exist until `lockDailyLedger` has returned. Writing
the wrong thing is a compile error, not a review catch.

### The key is bound, not passed

No mutation method takes a workspace, agent or day. The capability closes over
exactly the row it locked, so `locked.commitSpend(...)` cannot be pointed at a
different agent or day than the one serialized — removing an entire class of
mismatched-key bugs. Live-tested: mutating through a capability leaves
neighbouring agent-rows and next-day rows untouched.

### Valid only inside the acquiring transaction

The lock lives until the caller's transaction commits or rolls back. The
capability is a transaction-local value and is never stored or returned across
one.

### `current` tracks the transaction

`locked.current` reflects every mutation made through the capability so far, so
Step 15 can decide against it, commit, and read the new state as receipt
evidence — with no unlocked re-read, which would both waste a query and
reintroduce a stale-read hazard.

```text
current: 20.000000  ->  commitSpend("4.000000")  ->  current: 24.000000
```

### Transaction composition

Every primitive takes the **caller's** `DatabaseExecutor`. This module never
opens a transaction of its own — a guardrail asserts `.transaction(` never
appears in it.

If it did, a decision service holding a row lock would find its ledger write
committing on a different connection: the lock would protect nothing, and the
receipt could commit while the debit rolled back.

### Conflict-safe row creation

```sql
INSERT INTO ledger_daily (...) VALUES (...)
ON CONFLICT (workspace_id, agent_id, day) DO NOTHING
```

then read the winner. The first action of a UTC day can arrive concurrently, and
a bare `SELECT absent -> INSERT` would let both requests insert. `DO NOTHING`,
never `DO UPDATE` — a `DO UPDATE` would reset a day's spend to zero whenever two
requests raced, silently erasing committed accounting.

### Row locking — the core primitive

`lockDailyLedger` ends in `SELECT ... FOR UPDATE`. Without it:

```text
cap = $25, committed = $20
request A wants $4    reads 20, thinks it fits
request B wants $4    reads 20, thinks it fits
both commit           final = $28, over a $25 cap
```

With it, the second transaction **waits**, then reads $24 and can be denied.
Step 15 owns the denial; Step 14 owns the serialization that makes a correct
denial possible.

The lock is per row, so different agents and different days never block one
another — one busy agent cannot stall the fleet. Both are live-tested.

`findDailyLedger` deliberately does **not** lock.

> **`findDailyLedger` is not valid for read-compare-write governance
> decisions.** The value is stale the instant it returns, so deciding against it
> would let two concurrent requests both believe they fit under a cap. It exists
> for reporting surfaces that only display a number. Enforcement uses
> `lockDailyLedger`.

### What the mutation primitives do NOT do

`commitSpend` and `commitPublish` record what a caller has already decided to
commit. Neither loads a cap, compares anything, or decides. The capability knows
nothing of modes, caps, policy versions or allow/deny. They also stay
independent: **a spend never touches the publish counter, and a publish never
touches committed spend** — asserted separately.

Capacity is checked in exact micro-dollars before the write, so a caller gets a
typed `LedgerCapacityError` rather than a PostgreSQL numeric overflow. The
addition itself is done in SQL (`spend_committed_usd + $1::numeric`), which is
exact and makes the statement atomic on its own — defense in depth behind the
row lock, and no JavaScript read-modify-write of an authoritative amount.
Nothing wraps and nothing truncates.

### No reset, no delete

There is no `resetLedger`, `clearUsage`, `deleteLedger` or `setSpend`, and no
`.delete(` anywhere in the module. Committed accounting is evidence — an
application-level erase would let a cap breach be made to disappear.

---

## Cap changes never touch the ledger

```text
cap $25 -> $100    today's committed spend is unchanged
cap $100 -> $25    today's committed spend is unchanged
committed $41, new cap $25  ->  remaining = 0, never -16
```

Policy and accounting are **separate state**. Raising a cap must not grant
retroactive headroom, and lowering one must not erase usage — otherwise an
operator could clear a breach by editing configuration.

The two only meet in `remainingMicros`/`remainingCount`, which floor at zero. A
negative remaining would read as credit and would underflow any later
subtraction.

A guardrail test asserts the policy mutation service contains no ledger write
and the ledger contains no policy write.

---

## Cross-tenant safety

Every query carries all three predicates — `workspace_id`, `agent_id`, `day` —
with the workspace taken from the `WorkspaceScope`, never from caller input.

`lockOrCreate` first verifies the agent belongs to the scope, so holding another
tenant's agent UUID creates nothing and reports the same "not found" as an agent
that does not exist. The composite foreign key to `agents(workspace_id, id)`
would also refuse the insert, but that surfaces as an opaque driver error — the
explicit check is the primary defence, the FK the second.

The ledger **never creates agents**. Discovery belongs to registration and event
ingest; this module assumes a workspace-owned agent identity from a trusted
caller.

---

## The intended Step 15 transaction

```ts
await db.transaction(async (tx) => {
  const policy = /* load caps and mode */;

  const ledger = createLedgerRepository(tx, scope);
  const locked = await ledger.lockDailyLedger(agentId, utcDay);   // serializes
  if (locked === null) { /* agent not in this workspace */ }

  const decision = evaluate(policy, locked.current, requested);

  if (decision.allow) {
    await locked.commitSpend(requested);
  }

  // Step 15: write the receipt, recording the exact policy version and
  // `locked.current` as evidence. Maybe write a block.
});
```

This is the easy path, and the unsafe one requires deliberately breaking module
boundaries. Every primitive composes into that single caller-owned transaction,
which is why none of them opens one.

---

## Not implemented in Step 14

- **`POST /v1/actions/precheck`**, allow/deny decisions, receipts, plane-owned
  blocks — Step 15.
- **Event-driven spend debit.** `spend.recorded` is still an audit record only.
- **Cap, publish and pause enforcement** (AC-07, AC-08, AC-10, AC-11, AC-12).
- **Any HTTP route.** There is no `GET /ledger` and no `POST /ledger`.
- **Any UI.** No usage totals are displayed; showing a number the system does
  not yet enforce would imply protection that does not exist.

## Verification status

| Behaviour | Evidence |
| --- | --- |
| Exact arithmetic, UTC boundaries, DST, overflow, floor-at-zero | 97 unit tests |
| Workspace/agent/day predicates, `FOR UPDATE`, conflict target, no DELETE | 15 compiled-SQL tests |
| Wire/storage money agreement, day-not-from-HTTP, no local time | 32 cross-package tests |
| **No mutation without a locked capability**, bound key, no standalone export, caller-owned transaction | boundary guards (mutation-probed) |
| Row-lock serialization, stale-state prevention, first-row race, per-row independence, wrong-row immunity, exact `numeric` round trip, cross-tenant refusal | `packages/db/tests/ledger.live.test.ts` — **gated on `TEST_DATABASE_URL`; currently SKIPPED** |

The live suite has **never been executed**: no test database is available, and
none was invented. Whether `SELECT ... FOR UPDATE` genuinely serializes two
transactions is the one claim no in-process test can settle, and it is the claim
all later cap enforcement rests on.
