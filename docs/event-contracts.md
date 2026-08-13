# Event Contracts

> **Contract defined in Step 9. Ingest implemented in Step 10 — `POST /v1/events`
> is now mounted.**
>
> ## ⚠ INGEST DOES NOT DEBIT THE LEDGER
>
> A `spend.recorded` event is stored as an **audit record and nothing else**. It
> does not decrement a budget, does not update `ledger_daily`, does not enforce a
> cap, and does not affect any precheck decision. **Persisting spend events is
> not spend accounting.** Authoritative debit is **Step 19**.
>
> Until then, do not read "events were accepted" as "spend was counted". A live
> test asserts that ingesting a `spend.recorded` event writes no ledger row.

Source: [`packages/contracts/src/events.ts`](../packages/contracts/src/events.ts) ·
route [`apps/api/src/routes/events.ts`](../apps/api/src/routes/events.ts) ·
ingest [`apps/api/src/events/store.ts`](../apps/api/src/events/store.ts).

---

## Endpoint target

```http
POST /v1/events
Authorization: Bearer hmp_live_...
Content-Type: application/json
```

**Authentication is API-key only**, and the workspace is derived from the
credential record:

```text
Authorization: Bearer <key> -> api_credentials row -> workspace_id
```

**No event body may carry tenant authority.** There is no `workspace_id`,
`workspaceId`, `tenant_id` or `tenantId` field anywhere in the contract, and
every object is a strict Zod object, so sending one is a hard 400 rather than a
silently-stripped field.

---

## Request

```jsonc
{
  "events": [ /* 1 to 100 events */ ]
}
```

**Batch limit: 100.** Bounds validation and transaction work for one request. An
unbounded array would let a single request pin a worker and hold a transaction
open.

**Body limit: 1 MiB** (`MAX_EVENT_BODY_BYTES`), the Step 9 carry-forward now
closed. Zod bounds the event *count* and individual field lengths but cannot
bound total bytes, because `payload` is arbitrary JSON — one event with a 50 MB
payload passes every schema rule. The limit runs as the **first middleware**, so
an oversized body is rejected before it is buffered, authenticated, parsed or
seen by the store:

```jsonc
// HTTP 413
{ "error": "payload_too_large" }
```

The response is a fixed code and never echoes request content. Verified over a
real socket against the compiled build.

**Duplicate `event_id` within one batch is rejected.** Silently de-duplicating
inside a request makes the `accepted`/`duplicates` counts ambiguous and hides a
client bug. Cross-*request* replay is a different, fully supported path — that
is AC-13 and returns 200.

---

## Common envelope

| Field | Required | Notes |
| --- | --- | --- |
| `event_id` | yes | Client-supplied, ≤200 chars. Opaque string, **not** required to be a UUID — agent ecosystems use ULID/KSUID/prefixed ids. Unique per workspace, enforced by the database. |
| `agent_id` | yes | Stable external identifier (`agents.external_id`), ≤120 chars. Never the internal UUID. |
| `type` | yes | Discriminant; see vocabulary below. |
| `occurred_at` | no | Client-reported ISO-8601 with offset. **Untrusted.** |
| `precheck_id` | no | UUID of a precheck receipt. Structural validation only. |
| `payload` | no | Free-form runtime metadata object. |

> `occurred_at` = client metadata · `received_at` = server authority
>
> A client clock may be wrong or dishonest, so it never determines ingest
> ordering. `received_at` is stamped server-side from the injected clock.

---

## Event types

The vocabulary is identical to the PostgreSQL `event_type` enum from Step 3 —
verified by a test that parses the migrated SQL.

### `agent.action`

```jsonc
{ "type": "agent.action", "event_id": "evt-1", "agent_id": "agent-a",
  "category": "llm_call" }
```

`category` is **required**: an action the plane cannot categorise cannot be
governed. `other` exists for genuinely uncategorised work.

### `spend.recorded`

```jsonc
{ "type": "spend.recorded", "event_id": "evt-101", "agent_id": "agent-a",
  "amount_usd": "1.250000", "provider": "openai" }
```

Both fields required. An unattributed or unquantified spend cannot be reconciled
against a cap.

### `action.blocked`

```jsonc
{ "type": "action.blocked", "event_id": "evt-b1", "agent_id": "agent-a",
  "category": "publish", "rule": "daily_publish_cap",
  "reason": "Daily publish cap reached",
  "count": 6, "block_id": "client-block-123" }
```

Category-aware: a **spend** denial must carry `amount_usd`; a **publish** denial
must carry `count`; neither may carry the other's field. Those are the numbers
that later explain AC-08 and AC-11 — a denial missing them is unexplainable, and
one carrying both is ambiguous.

### `heartbeat`

```jsonc
{ "type": "heartbeat", "event_id": "hb-123", "agent_id": "agent-a" }
```

Minimal by design. Because the object is strict, a heartbeat carrying
`amount_usd` is rejected rather than accepted with the field dropped.

---

## Category vocabulary

`llm_call` · `tool_call` · `spend` · `publish` · `other`

Identical to the PostgreSQL `action_category` enum. **`category` is not
`provider`** — a category is a governed action kind; a provider is a vendor
label carrying no authority.

---

## Money format

**Decimal string, e.g. `"1.250000"`.** Never a JSON number.

JSON numbers are IEEE-754 doubles in every mainstream parser, so `41.00` can
arrive as `41.000000001`. For a ledger deciding whether a $25 cap is exceeded,
that is unacceptable at any level of unlikeliness. A string crosses the wire
exactly as written and converts to `numeric(14,6)` losslessly.

Accepted: up to **8 integer** and **6 fractional** digits, non-negative, no
sign, no exponent, no leading zeros.

| Value | Result |
| --- | --- |
| `"0"`, `"0.000001"`, `"25.000000"`, `"99999999.999999"` | accepted |
| `"0.0000009"` | **rejected** — seventh decimal, never silently rounded |
| `"-5.000000"`, `"+5"`, `"4.1e1"`, `"NaN"`, `"100000000"` | rejected |
| `41.0` (JSON number) | rejected |

---

## Identity fields are distinct

| Field | Origin | Format | Maps to |
| --- | --- | --- | --- |
| `event_id` | client | opaque string | `events.event_id` |
| `precheck_id` | **plane** | UUID | `events.precheck_receipt_id` |
| `block_id` | client/runtime | opaque string | `blocks.external_block_id` |

`precheck_id` is a UUID because the plane generated it. `block_id` is a string
because a runtime generated it — and it is **not** `events.block_id`, which is
an internal UUID. See the mapping note below.

---

## Raw payload

Both strategies from the brief are used together: the **entire validated event**
is the audit source (Step 10 stores it in `events.payload`), and a dedicated
`payload` object carries runtime-specific metadata.

`payload` is the extensibility escape hatch that makes strict envelopes safe
elsewhere. It is **inert**: stored verbatim, never read for authority.
Governance-critical values such as `amount_usd` are typed envelope fields
precisely so they can never hide inside unvalidated JSON.

It rejects `workspace_id`/`tenant_id` keys as a tripwire — a client putting
tenancy in the payload has misunderstood the model, and failing loudly beats
storing an inert field a future reader might mistake for authoritative.

---

## Unknown fields

**Rejected, not stripped.** Zod's default would turn

```jsonc
{ "amout_usd": "41.00" }
```

into a valid spend event with no amount, and the ledger would under-count.
Strict objects turn that typo into a loud 400. Extensibility goes in `payload`.

This also blocks, by construction: tenant authority, policy fields (`mode`,
caps, `policy_version`, `paused`) and credentials (`api_key`, `authorization`,
tokens).

---

## Responses

### Success — HTTP 200

```jsonc
{ "accepted": 3, "duplicates": 2 }
```

An aggregate, because that is exactly what AC-13 needs: replay the same batch,
receive **200** with `accepted: 0, duplicates: N`, and observe the stored count
unchanged. Per-event status would grow the contract without strengthening that
demonstration, and would invite callers to depend on ordering.

`accepted + duplicates` always equals the number submitted — no silent drops. A
partially duplicate batch (`E1` new, `E2` duplicate, `E3` new) returns
`{ accepted: 2, duplicates: 1 }` with 200; a duplicate is **not** a validation
error.

### Invalid batch — HTTP 400

```jsonc
{ "error": "invalid_batch",
  "issues": [ { "path": "events.0.amount_usd", "message": "…" } ] }
```

**The whole batch is rejected if any event is invalid.** Partial acceptance
would leave the caller unsure what landed, and "no silent drops" is locked.

Issues carry `path` and `message` only, capped at 20. A raw Zod error tree would
expose schema internals and union-resolution detail. `toValidationIssues()` is
exported so the API and simulator agree on the shape.

---

### Unauthenticated — HTTP 401

```jsonc
{ "error": "unauthorized" }
```

One identical body for every failure category: no key, malformed key, unknown
key, revoked key, or a browser session cookie presented instead of a key. A
distinguishable response would let a caller probe which keys exist.

### Unconfigured — HTTP 503

```jsonc
{ "error": "events_unavailable" }
```

Returned when no database is wired. `/healthz` stays 200 — liveness must never
depend on a feature's configuration.

---

## The ingest algorithm

### The invariant

> **The duplicate decision happens before any event-specific one-time side
> effect.**

The idempotency identity is `(workspace_id, event_id)` and nothing else. Once an
event exists under that identity, a later submission reusing the id is a
duplicate whatever its content claims, and cannot reinterpret history.

One transaction per batch:

```text
BEGIN
  lock every event identity in the batch, in deterministic key order
  for each event:
    1. SELECT the event by (workspace_id, event_id)
       if present -> duplicates++, CONTINUE — no further work at all
    2. discover/resolve the agent      — WITHOUT touching last_seen
    3. resolve precheck_id if present  — unresolved => abort the whole batch
    4. resolve/create runtime block    — idempotent on external id
    5. INSERT ON CONFLICT (workspace_id, event_id) DO NOTHING RETURNING
    6. accepted++, advance agent last_seen
COMMIT
```

### Why the lock

Deciding "is this a duplicate?" *before* doing the work makes it a **read**, and
a bare read is race-prone: two concurrent transactions can both observe absence,
both perform side effects, and only then discover one of them lost.

`pg_advisory_xact_lock`, keyed deterministically on `(workspace_id, event_id)`,
closes that window. Whoever holds it is the only transaction evaluating that
identity, so its SELECT is authoritative and exactly one caller reaches the side
effects.

**Transaction-scoped, never session-scoped.** Session-held
`pg_advisory_lock` must not be used: Neon and PgBouncer pool per transaction, so
a session lock would outlive the request, attach to whichever request next
borrowed that connection, and eventually wedge the pool. `pg_advisory_xact_lock`
releases at COMMIT or ROLLBACK with no unlock call to leak.

**Key derivation** —
`SHA-256("hybrid:event-ingest:v1\0" + workspace_id + "\0" + event_id)`, first 8
bytes read big-endian and folded into the signed 64-bit range PostgreSQL
`bigint` requires. It is pure: no clock, no randomness, no counter, nothing
process-local, so two Render instances derive the same key. Components are
NUL-separated under a domain tag, so `('ws-a','b-c')` and `('ws-a-b','c')`
cannot collide by concatenation. A collision between two genuinely different
identities costs an unnecessary serialization, not correctness — the constraint
below is what guarantees uniqueness.

**Deadlock safety.** Advisory xact locks are held until COMMIT, so a batch
holding several can deadlock against another wanting the same ones in the
opposite order (`A=[E1,E2]`, `B=[E2,E1]`). All locks for a batch are therefore
acquired up front, sorted by `(lock_key, event_id)` — a **total** order both
batches compute identically, so the cycle cannot form. The event id is the
tiebreaker so that even a hash collision still yields a total order.

**Isolation assumption.** This relies on READ COMMITTED (the PostgreSQL default,
and what the driver uses): each statement takes a fresh snapshot, so once the
lock is acquired the SELECT sees the winner's committed row.

### The constraint is still the guarantee

`UNIQUE (workspace_id, event_id)` and `ON CONFLICT DO NOTHING` are **retained**
beneath the lock. The advisory lock is a coordination mechanism; the constraint
is the guarantee. Correctness must not depend on every future caller remembering
to take a lock.

### AC-13: replay is idempotent

Replaying an identical batch returns **200** with `accepted: 0, duplicates: N`,
the stored count is unchanged, and the original rows are untouched — including
`received_at`. A replay carrying *different* content under the same `event_id`
does **not** rewrite history: `DO NOTHING`, never `DO UPDATE`. The repositories
for `events` and `blocks` expose no `update` or `delete` at all, and a guardrail
test enforces that.

### Duplicate payload immutability

Because `event_id` is client-supplied, the replay path would otherwise be a way
to create rows. It is not. A replay reusing a stored id with a changed
`agent_id`, `type`, `category`, `payload`, `occurred_at`, `precheck_id`,
`block_id`, amount/count metadata, or rule/reason:

- is reported as a duplicate;
- creates **no** alternate block;
- discovers **no** alternate agent;
- creates no receipt and rewrites no linkage;
- moves no `last_seen_at`;
- leaves every stored row byte-identical.

An unknown `precheck_id` on a *replay* does **not** produce a 400, because the
identity is settled before any linkage is considered — a batch that changes
nothing cannot fail on a reference it never needed. On a **new** event an
unknown `precheck_id` is still a 400.

This is not a validation bypass. Step 9 validation runs first and is unchanged:
a structurally invalid event is a 400 even when its `event_id` matches a stored
event. The rule concerns valid-but-different duplicate payloads only.

### Duplicate replay does not refresh last-seen

Advancing `agents.last_seen_at` is the one genuinely once-only side effect, so
it is deferred until after the insert reports the event was new. A retry storm
therefore cannot make a stale agent look alive — which matters because AC-04
reads last-seen as evidence of liveness.

Agent *discovery* still runs for a replayed event, because the insert needs the
agent's internal UUID. That is safe only because discovery is itself idempotent
and does not touch `last_seen_at`.

### Agents are discovered, not required to register

An event naming an unknown `agent_id` creates the agent row rather than failing.
Requiring registration first would mean losing governance events from an agent
that restarted or was deployed by a different path. A discovered agent gets no
invented display name.

### Blocks are deduplicated on the external id

Reached only for a **new** event. `UNIQUE (workspace_id, external_block_id)` is
the dedup boundary, so two *different* events may legitimately reference the
same external block and share one row — that is dedup, and it is distinct from
a replay, which never reaches block handling at all. `source` is hardcoded to
`'runtime'`: a self-declared block is a report, not an enforcement, and only the
precheck path may mint a plane-owned block.

An `action.blocked` event with no `block_id` has no stable dedup key, so no
block row is created; the event still persists with its `rule` and `reason` in
the raw payload.

### An unresolved `precheck_id` fails the batch

If `precheck_id` names no receipt **in this workspace**, the request returns 400
with `path: "events.<i>.precheck_id"` and the whole transaction rolls back. The
alternative — storing the event with the linkage silently removed — would be a
silent drop of meaning. A receipt belonging to another workspace is reported
byte-identically to one that does not exist; a UUID is not authorization.

Ingest can only *verify* a receipt, never create one. A self-issued receipt
would be an approval an agent granted itself.

### Batch atomicity

The batch is all-or-nothing. A failure at event 3 of 3 leaves events 1 and 2
uncommitted, and the caller receives an opaque 500. The returned counts always
describe committed state.

---

## Database mapping

| Contract field | Destination |
| --- | --- |
| `event_id` | `events.event_id` |
| `agent_id` | resolve `agents.external_id` → `agents.id`, **within the authenticated workspace** |
| `type` | `events.type` (enum matches exactly) |
| `category` | `events.category` (nullable; absent for `spend.recorded`/`heartbeat`) |
| whole validated event | `events.payload` |
| `occurred_at` | `events.occurred_at` (nullable, untrusted) |
| `precheck_id` | `events.precheck_receipt_id` |
| `block_id` | **resolve** to `blocks.external_block_id` → `blocks.id` |
| — | `events.received_at` server-generated |
| — | `events.workspace_id` from the API credential |

**The mapping nuance flagged in Step 9 is now resolved as predicted.**
`events.block_id` is a `uuid` with a composite FK to `blocks(workspace_id, id)`,
while the wire `block_id` is a client string. Ingest resolves the client id
against `blocks.external_block_id` (unique per workspace) and stores the
internal UUID; the string is never cast. **No migration was needed** — the
Step 3 schema was correct as-is.

`spend.recorded` and `heartbeat` carry no `category`. The column is left NULL
rather than filled with an invented value, which would fabricate governance
data.

---

## The read surface (Step 11 — AC-05, AC-06)

```http
GET /v1/workspaces/:workspaceId/events
GET /v1/workspaces/:workspaceId/events/:eventId
```

**Browser sessions read; machine keys write.** These routes consult only the
session cookie — an API key is never accepted, not even as a fallback. A machine
that can submit events cannot read the tenant's history back. Tests assert both
directions.

Authorization is the operator chain, re-proven per request:

```text
session cookie → AuthenticatedUser → membership → AuthorizedWorkspace
              → WorkspaceScope → event repository
```

Any workspace **member** may read. Events are ordinary tenant data, unlike API
keys, which are operator-only because they are secret-adjacent — the same rule
already applied to the agent roster.

### Timeline

| Query param | Notes |
| --- | --- |
| `agent_id` | External agent id, resolved **inside** the authorized workspace |
| `limit` | Default **50**, maximum **100**. `0`, negatives, fractions, `1e3` and non-numerics are 400 — never silently clamped |
| `cursor` | Opaque; pass back unmodified |

```jsonc
{
  "events": [
    { "id": "…", "eventId": "evt-123",
      "agent": { "id": "…", "agentId": "agent-a", "name": "Agent A" },
      "type": "heartbeat", "category": null,
      "occurredAt": null, "receivedAt": "…",
      "precheckId": null, "block": null }
  ],
  "nextCursor": "…"          // null on the last page
}
```

An unknown query parameter is a **400**, so a misspelled `agent-id` cannot
silently return the unfiltered stream.

**Rows carry no raw payload.** A page holds up to 100 rows and a payload is
arbitrary client JSON, so embedding them would make the response size a function
of untrusted input. The raw object belongs to detail — the main reason list and
detail are separate endpoints.

### Ordering

`received_at DESC, id DESC`.

`received_at` is server-assigned and therefore the only trustworthy axis;
ordering by the client's `occurred_at` would let a caller rewrite its own
position in the history. Two events routinely share a `received_at` — one ingest
batch is one transaction stamped from one clock read — so `id` breaks the tie.
Without that tiebreaker the sort is non-deterministic and pagination repeats or
skips rows.

### Cursor

The cursor encodes exactly the ordering boundary, `(received_at, id)`, as
base64url JSON `{ "r": …, "i": … }`. The query applies it as a **row-value
comparison** — `(received_at, id) < ($1::timestamptz, $2::uuid)` — one expression
that cannot disagree with the ORDER BY.

**It carries no authority.** The workspace is deliberately absent: a cursor is
client-held and therefore attacker-controlled, so if tenancy could be read from
it, forging one would be a cross-tenant read. Scope comes only from the
membership check, and the cursor is applied *inside* it. The worst a forged
cursor can do is move the caller's own page boundary within their own workspace
— asserted by test. It carries no secret, no session and no user identity;
base64url is encoding, not encryption.

Every malformed form — bad base64, non-JSON, arrays, `null`, missing or extra
keys, non-UUID id, unparseable date, SQL-injection text — returns a safe **400**.
Never a silent fall back to page one, which would restart a paging loop.

### Agent filter

`agent_id` is the **external** id. It is resolved to an internal UUID inside the
authorized workspace, so workspace A asking for `agent-1` filters A's `agent-1`;
B may independently have its own.

An external id this workspace does not have returns
`{"events": [], "nextCursor": null}` — **not** 404. A 404 would reveal whether
the id exists somewhere on the platform. An id belonging only to another tenant
returns byte-identically.

### Detail and raw JSON (AC-06)

`:eventId` is the **internal UUID** carried by timeline rows, not the
client-supplied `event_id` — which is unique only per workspace and may contain
any character. A malformed id, an unknown id and another tenant's id are all
**404**; a UUID is not authorization.

```jsonc
{ "event": { "…summary fields…", "raw": { /* the validated event */ } } }
```

> **`raw` is the VALIDATED EVENT OBJECT, not raw HTTP request data.**
>
> It is exactly what the Step 9 contract accepted and Step 10 stored in
> `events.payload` — post-parse, post-validation. It is not request bytes, not
> headers, not the HTTP envelope. That distinction is why no credential material
> can appear here: the `Authorization` header never reached the validated object
> in the first place.

The UI renders it with `JSON.stringify(raw, null, 2)` inside a `<pre>` as a
React **text child**. A payload containing `<script>alert(1)</script>` displays
as text; there is no `dangerouslySetInnerHTML` anywhere in the app.

### Block linkage

`block.externalBlockId` is the identity a runtime recognises; `block.id` is
ours. Both are exposed so AC-08/AC-11 can later navigate from an event to its
denial. Deliberately **not** included: rule, reason, amount and cap — block
detail is a later step, and half-rendering a denial is worse than not rendering
one.

### Errors

| Case | Status |
| --- | --- |
| No session | 401 |
| API key presented instead of a session | 401 |
| Workspace not a member of / nonexistent | 404 |
| Malformed query, limit or cursor | 400 `invalid_query` |
| Unknown, malformed or foreign event id | 404 `not_found` |
| Database unconfigured | 503 |

No SQL, no stack traces and no tenant hints in any body.

### Read-only, and no bulk export

There is no PATCH, DELETE or "dismiss" route; the repository exposes no update
or delete. Reading a `spend.recorded` event performs no accounting, no
reconciliation and no ledger backfill. CSV/JSON export is the deferred **AC-16**
and daily rollups the deferred **AC-17** — neither is reachable, and page sizes
are hard-capped partly so a single call cannot become an export.

---

## Not implemented in Step 11

- **Ledger debit / spend accounting** — Step 19. See the warning at the top.
  When it arrives it hangs off the **same "this event is new" branch** as
  `last_seen`, which is what makes exactly-once accounting reachable: a
  duplicate returns before that branch, so it can never produce a second debit,
  a second receipt effect, a second block, or a false liveness update. The
  ordering correction above is a prerequisite for Steps 18–19, not a cosmetic
  cleanup.
- **Cap enforcement and precheck decisions** — the precheck steps. Ingest reads
  no policy table and cannot mutate policy.
- **Plane-owned blocks** — only `source = 'runtime'` is writable here.
- **Precheck receipt creation** — ingest can verify a receipt, never issue one.
- **Bulk export** (AC-16) and **rollups/summaries** (AC-17).
- **Block and receipt detail views** — linkage ids only.
- **Gone-dark inference** from last-seen (AC-14/15).
- **Share links** (AC-18) and the **public demo** (AC-19). The read repository
  takes a `WorkspaceScope`, which is the seam those will later resolve through,
  but every Step 11 route is browser/operator only.
- **Simulator event generation.**

---

## Verification status

| Behaviour | Evidence |
| --- | --- |
| Timeline auth, ordering, paging, filtering, detail, tenant isolation | 66 route tests + 24 cursor tests |
| Workspace predicate, join scoping, ORDER BY, bound cursor params | 25 compiled-SQL tests (`.toSQL()`) |
| Real ordering, tiebreak, cursor paging, payload exactness, isolation | `packages/db/tests/timeline.live.test.ts` — **SKIPPED** |
| Route, auth, validation, counts, 413, rollback | 53 in-process route tests |
| Duplicate payload immutability (block, agent, precheck, payload mutations) | 25 in-process tests, incl. source-level ordering guards |
| Lock key determinism, range, collision, total ordering | 15 unit tests |
| Unconfigured 503, 413, 404-on-GET, CSRF 403, no key in logs | compiled build over a real HTTP socket |
| UNIQUE constraint, concurrent replay race, **racing duplicate creates no alternate block/agent**, **overlapping-batch deadlock safety**, cross-tenant isolation, no ledger write | `packages/db/tests/event-ingest.live.test.ts` — **gated on `TEST_DATABASE_URL`; currently SKIPPED** |

The advisory lock is the one part of this design that **no in-process test can
exercise**. Single-threaded JavaScript makes a read-then-act sequence
authoritative for free; PostgreSQL does not. Whether the lock actually
serializes concurrent requests, and whether overlapping batches deadlock, is
knowable only from the live suite.

The live suite has **never been executed**: no test database is available, and
none was invented. AC-13 is therefore IMPLEMENTED but **not** verified against
real PostgreSQL. See
[`acceptance-traceability.md`](./acceptance-traceability.md).
