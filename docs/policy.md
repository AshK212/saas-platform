# Policy Versioning, Agent Polling and Operator Mutation

> **Policy read/versioning implemented in Step 12. Operator mutation implemented
> in Step 13.**
>
> ## ⚠ CONFIGURATION EXISTS; ENFORCEMENT DOES NOT
>
> An operator can now set a mode, a spend cap and a publish cap, and an agent
> will receive them. **Nothing enforces any of it.** A `paused` agent is not
> stopped, a `$25` cap does not block a `$41` spend, and a publish cap denies
> nothing. Enforcement arrives with precheck; authoritative spend accounting is
> Step 19.
>
> Do not read "the cap is saved" as "the cap is active".

## The two surfaces

| | Machine read | Operator write |
| --- | --- | --- |
| Route | `GET /v1/policy` | `PUT /v1/workspaces/:workspaceId/agents/:agentId/policy` |
| Auth | `Authorization: Bearer <API key>` | Session cookie |
| Authorization | credential → workspace | membership → **`operator` role** |
| CSRF | n/a (no cookie) | origin-guarded |
| Effect | **read only** | **write**, version-incrementing |

> **No other current path may mutate policy.** Event ingest, agent
> registration, API-key authentication, policy polling, and the future share and
> demo routes can only read. A guardrail sweeps both packages and fails the
> build if any file other than provisioning and the mutation service writes
> `agent_policies` or `workspace_policy_state`.

Sources: [`packages/contracts/src/policy.ts`](../packages/contracts/src/policy.ts) ·
[`packages/contracts/src/agent-policy.ts`](../packages/contracts/src/agent-policy.ts) ·
[`packages/db/src/repositories/policy.ts`](../packages/db/src/repositories/policy.ts) ·
[`packages/db/src/repositories/policy-mutation.ts`](../packages/db/src/repositories/policy-mutation.ts) ·
[`apps/api/src/routes/policy.ts`](../apps/api/src/routes/policy.ts) ·
[`apps/api/src/routes/agent-policy.ts`](../apps/api/src/routes/agent-policy.ts)

---

## The model

```text
Workspace
   |
   +-- workspace_policy_state(version)      <- authoritative, monotonic, >= 1
   |
   +-- agents
          |
          +-- optional agent_policies override
          |
          +-- missing override => watch / uncapped
```

Two separate things:

- **The version** is per *workspace*. It answers "has anything changed?" in one
  cheap read, which is what makes 30-second polling affordable.
- **The effective policy** is per *agent*: the explicit `agent_policies` row if
  one exists, otherwise the deterministic default.

---

## Workspace policy initialization

Creating a workspace is one transaction with three inserts:

```text
BEGIN
  INSERT workspace
  INSERT workspace_membership   (creator, operator)
  INSERT workspace_policy_state (version = 1)
COMMIT
```

All three commit or none does. A workspace whose membership failed would be
permanently unreachable; a workspace whose **policy state** failed would report
no version, which the polling route treats as an invariant violation. Neither is
a state the system should be able to reach.

This is policy **initialization**, not policy mutation — it establishes the
version a workspace is born with and sets no modes and no caps.

Version starts at **1**, matching the `version >= 1` check constraint. Version 0
would be indistinguishable from "no state" to a polling client.

---

## The polling endpoint

```http
GET /v1/policy?since_version=<n>
Authorization: Bearer hmp_live_...
```

Polling target: **approximately every 30 seconds**.

### Authentication and workspace derivation

```text
Authorization: Bearer <key> -> api_credentials row -> workspace_id -> WorkspaceScope
```

**Machine authentication only.** A browser session cookie returns 401 — this is
an agent/runtime path, and the operator-facing policy surface is Step 13.

**The URL is deliberately workspace-less.** The credential identifies the
workspace, so there is nothing in the path for a caller to point elsewhere.
`GET /v1/workspaces/:id/policy` does not exist.

The query schema is **strict** and defines exactly one parameter. `?workspace_id=`,
`?tenant_id=` and friends are a **400** for an unknown parameter — not silently
ignored, because a quietly-dropped tenant selector is a field someone later
decides to honour. `X-Workspace-Id` and similar headers are never read.

---

## Version semantics

Version is a **decimal integer string**, e.g. `"1"`.

The column is a PostgreSQL `bigint`. Serialising it as a JSON number would mean
silent precision loss above 2^53 — the same class of defect the money contract
rejects floats for. It is read with an explicit `::text` cast so PostgreSQL
renders the exact integer and no JS conversion ever happens. `since_version`
uses the identical domain, so caller and server can never be comparing different
representations. Comparison is by `BigInt`, not by string (which would order
`"9"` after `"10"`) and not by `Number`.

| Caller state | Response |
| --- | --- |
| No `since_version` | **200** + snapshot |
| `since_version == current` | **304**, empty body |
| `since_version < current` | **200** + current snapshot |
| `since_version > current` | **200** + current snapshot |
| `since_version` malformed | **400** `invalid_query` |

**A caller ahead of the server gets 200, not 304.** Being ahead is stale
divergence — a restored backup, a rolled-back deploy, a corrupted local cache.
Returning 304 would freeze the runtime in that wrong state permanently; the
authoritative snapshot lets it self-correct downward.

`since_version=0` is accepted and always yields a snapshot: it is the natural
"I have nothing yet" value, and the initial version is 1.

Rejected as **400**: negatives, decimals, scientific notation, leading zeros,
`+1`, hex, non-numerics, empty, and anything over 19 digits.

### 304 carries no body

`c.body(null, 304)`, never `c.json({})`. A 304 with a payload is malformed and
some clients would cache the bytes. A 304 also **skips the snapshot query
entirely** — see below.

---

## Efficiency: version first

```text
1. read workspace policy version        (single primary-key lookup)
2. compare with since_version
3. equal      -> 304, stop here
4. otherwise  -> load the effective agent snapshot
```

The overwhelmingly common answer to a 30-second poll is "nothing changed", so
that answer costs one tiny read rather than a join across every agent. No cache
is introduced: a primary-key read is already cheap, and cache invalidation would
be a new correctness problem to own before there is evidence it is needed.

---

## The snapshot

```jsonc
{
  "version": "1",
  "agents": [
    {
      "agent_id": "agent-a",
      "mode": "watch",
      "daily_spend_cap_usd": null,
      "daily_publish_cap": null
    }
  ]
}
```

A **snapshot, not a command set**. It describes current state; the runtime
decides how to apply it.

- `agent_id` is the **external** machine-facing id. The internal UUID is never
  exposed on this surface.
- `daily_spend_cap_usd` is a **decimal string or null**, straight from
  `numeric(14,6)`, never through a JS float.
- `daily_publish_cap` is a **non-negative integer or null**.
- `null` means **uncapped**. `0` means **nothing permitted**. Those are
  different, and collapsing them would either silently pause an unconfigured
  agent or silently uncap a fully-capped one.
- No workspace id, no credential metadata, no secrets.

---

## Effective default policy

| Field | Default when no `agent_policies` row exists |
| --- | --- |
| `mode` | `watch` |
| `daily_spend_cap_usd` | `null` |
| `daily_publish_cap` | `null` |

`watch` means observe and record, enforce nothing. It is the only safe default:
`budgeted` would apply caps nobody configured, and `paused` would halt an agent
the operator never chose to stop.

**Defaults are computed, never persisted.** No fake row is written, and no zero
is stored as a stand-in for absent. That matters because agents are created by
registration *and* by event auto-discovery — if discovery had to write a policy
row, **event ingest would be mutating governance**, which is exactly the
separation Step 10 established.

The query is a `LEFT JOIN` **from agents**, so an agent with no policy row is
still returned. Joining from policies would silently omit exactly those agents,
which is the "empty policy for a known workspace" failure this step exists to
prevent. The join condition repeats `workspace_id` alongside `agent_id`, so a
policy row can never pair with another tenant's agent.

### Locked mode vocabulary

`watch` · `budgeted` · `paused` — identical to the `agent_mode` PostgreSQL enum,
verified by a test that parses the migrated SQL. No `disabled`, `enforce` or
`unrestricted`.

A `paused` mode is **reported faithfully and enforced nowhere**. Step 12 reads
truthfully; precheck decisions and the kill switch are later steps.

---

## "A known workspace is never empty" — what it means

It does **not** mean a workspace with zero agents fabricates one. It means the
control plane never returns `null`, `undefined`, a missing version or version 0
for a valid workspace.

A workspace with no agents returns:

```jsonc
{ "version": "1", "agents": [] }
```

That is a valid snapshot.

### Missing policy state

If a workspace somehow has no `workspace_policy_state` row, that is an
**invariant violation**, and the route returns a controlled **500**
(`{"error":"internal_error"}`) with no SQL, no table name and no workspace id.

There is deliberately **no lazy create-on-read**. A GET that repairs state is a
GET that hides provisioning defects, and it would also make a read path a
writer. The invariant is enforced where workspaces are created instead.

---

## Errors

| Case | Status |
| --- | --- |
| No, malformed, unknown or revoked key | 401 |
| Browser session cookie instead of a key | 401 |
| Unknown query parameter or malformed `since_version` | 400 `invalid_query` |
| Unchanged | 304, empty body |
| Valid | 200 + snapshot |
| Database unconfigured | 503 `policy_unavailable` |
| Missing policy state (invariant) | 500 `internal_error` |

---

## Operator mutation (Step 13)

```http
PUT /v1/workspaces/:workspaceId/agents/:agentId/policy
Cookie: hybrid_auth_session=...
Origin: https://app.example
Content-Type: application/json
```

```jsonc
{ "mode": "budgeted", "daily_spend_cap_usd": "25.000000", "daily_publish_cap": null }
```

```jsonc
// 200
{
  "policy": {
    "agent_id": "agent-a",
    "mode": "budgeted",
    "daily_spend_cap_usd": "25.000000",
    "daily_publish_cap": null
  },
  "version": "2"
}
```

### Authorization chain

```text
session cookie → AuthenticatedUser → membership → role == operator
              → AuthorizedWorkspace → WorkspaceScope → versioned transaction
```

**An API key is refused with 401.** A runtime must never edit the governance it
is subject to. It may read policy through `/v1/policy`; it may not write it
anywhere.

**A `member` gets 403 `insufficient_role`, not 404.** They already legitimately
know the workspace exists, so hiding it would be theatre. Reading a policy is
ordinary tenant data and any member may do it — the same split as API-key
management.

**Cross-tenant is 404.** An operator holding another workspace's exact internal
agent UUID gets the same response as for an id that does not exist, and neither
workspace's version moves. A globally unique UUID is not authorization.

**CSRF.** `PUT` is a state-changing method, so the Step 6 origin guard applies:
a foreign `Origin` carrying the victim's cookie is 403, and so is a cookie
request with no `Origin` at all.

### PUT, not PATCH

The body is the **complete** policy. A partial update would need conflict rules
for three fields, and "clear the spend cap" would become indistinguishable from
"leave it alone". Every field is written on every save, so `null` really clears.

There are deliberately no `/set-mode`, `/pause` or `/set-spend-cap` routes: one
mutation surface is easier to secure and audit than five.

### The request accepts no authority

Strict object. There is no `workspace_id`, no `tenant_id`, no `agent_id` (the
agent is the path) and no `version` — the version is server-authoritative, and
accepting one would let a caller assert governance history. Unknown fields are a
400, so a typo like `daily_spend_cap` fails loudly instead of silently leaving
an agent uncapped.

---

## Atomic mutation and version increment

```text
BEGIN
  1. SELECT version FROM workspace_policy_state
       WHERE workspace_id = $1 FOR UPDATE
     -- serializes concurrent mutations in this workspace from the start
     -- missing row aborts HERE, before anything is written
  2. SELECT agent WHERE workspace_id = $1 AND id = $2
     -- not found => no write, reported as not-found
  3. INSERT INTO agent_policies (...) VALUES (...)
       ON CONFLICT (workspace_id, agent_id) DO UPDATE SET ...
  4. UPDATE workspace_policy_state SET version = version + 1
       WHERE workspace_id = $1 RETURNING version::text
COMMIT
```

**Neither half can commit alone.** A policy changed without a version bump would
be invisible to every polling agent — they would keep sending `since_version=N`,
receive 304, and run indefinitely under governance the operator believes they
replaced. A version bumped without a policy change would make every agent
re-download an unchanged snapshot and corrupt the history precheck receipts will
later cite.

The response's `policy` and `version` therefore always describe the same
committed transaction.

### Why not read-then-write

`SELECT version` then `UPDATE ... SET version = <read + 1>` **loses increments**:
two transactions both read 10 and both write 11. Step 4 is a single
`version + 1` statement evaluated by PostgreSQL against a row it holds a lock
on, so two committed mutations always produce two distinct versions. The
`FOR UPDATE` at step 1 starts that serialization before any work rather than at
the last statement.

### Concurrency semantics

| Scenario | Result |
| --- | --- |
| Two agents, same workspace, concurrently | Versions 2 and 3; final 3 |
| Eight concurrent mutations | Eight distinct versions; final 9 |
| **Same agent** twice concurrently | Both commit; version +2; last writer wins the row |
| Two workspaces concurrently | Independent counters; both reach 2 |

For the same-agent case the row ends as **exactly one** of the two submitted
policies — never a mix of fields from both. No optimistic-locking token is
exposed: the requirements do not ask for one, and adding a client-supplied
version would create a new way for a caller to assert authority.

### Always increments

A save with values identical to the stored ones **still increments**. The
operator performed a governance write, and suppressing the bump would make the
version history depend on a value comparison — two operators saving the same
values would see different histories depending on who went first. Deterministic
beats clever.

A **rejected** request increments nothing: not a 400, not a 403, not a 404, not
a CSRF rejection. The version is itself governance state.

### Missing policy state

Aborts at step 1, before any write, and returns a controlled 500. **No
self-healing**: creating the version row during a mutation would hide the
provisioning defect and accept a governance write against a workspace whose
history never existed.

---

## Propagation

A committed write is visible **immediately** — there is no server-side delay
anywhere. The runtime's ~30-second poll cadence is the only latency in the loop:

```text
operator saves          -> version 1 becomes 2
agent polls since_version=1 -> 200 with the new snapshot at version 2
agent polls since_version=2 -> 304
```

This is the propagation half of AC-10. The enforcement half does not exist yet.

---

## Money and counts on the write path

The operator may type `25`, `25.00` or `25.000000`. Normalisation is **pure
string manipulation** in `normalizeSpendCapInput` — no `parseFloat`, no
`toFixed`, no arithmetic — so the digits typed are the digits stored in
`numeric(14,6)`.

Refused rather than rounded: negatives, `+5`, exponent notation, seven decimals,
nine integer digits, `025`, `.5`, `25.`, `1,000`, `$25`. Publish counts refuse
`5.5`, `-1`, `05` and anything above `int4`.

`0` and `null` stay distinct on the write path exactly as on the read path.

---

## What polling does NOT do

- **No policy mutation.** No mode change, no cap change, no version increment,
  no override creation. The repository has no writer at all, and a guardrail
  test sweeps both packages to enforce that only provisioning may insert into
  `workspace_policy_state` or `agent_policies`.
- **No `last_seen_at` refresh.** Polling for configuration is not evidence of
  life: a crashed-but-still-polling supervisor must not look like a healthy
  agent, and last-seen is the substance of AC-04.
- **No ledger read or write.** No accounting of any kind.
- **No events, no blocks, no receipts.**
- **No enforcement.** Nothing acts on `paused` or on a cap here.

## What mutation does NOT do

- **No enforcement.** Storing `paused` pauses nothing; storing a cap blocks
  nothing.
- **No ledger effect.** Raising a cap from 25 to 100 does **not** reset or
  adjust today's committed spend — that would let an operator erase history by
  editing configuration. The mutation module imports no ledger table.
- **No receipts, no blocks, no events.** Those are enforcement artifacts.
- **No policy-change event stream.** The requirements do not ask for one.
- **No policy history table.** Monotonic version plus the receipt's recorded
  version is the evidence model; a change-audit product is not in scope.

## Not implemented in Step 13

- **Precheck decisions and receipts.** Every future receipt will record the
  exact policy version it evaluated against; the version model exists for that.
- **The authoritative UTC-day ledger** — Step 14.
- **Ledger debit** — Step 19. `spend.recorded` still does **not** debit the
  authoritative ledger.
- **Cap, publish and pause ENFORCEMENT** (AC-07, AC-08, AC-10, AC-11, AC-12).

## Verification status

| Behaviour | Evidence |
| --- | --- |
| Poll auth, 304, version semantics, defaults, isolation, no-write | 68 route tests |
| Mutation auth, role, CSRF, cross-tenant, validation, boundaries, atomicity | 66 route tests |
| Write → poll propagation on shared state | 8 tests |
| Money/count normalisation and the operator contract | 60 contract tests |
| Workspace predicate, join scoping, `::text` cast, no unversioned writer | 15 compiled-SQL tests + boundary guards |
| Atomic provisioning, LEFT JOIN, bigint round trip, exact decimals | `packages/db/tests/policy.live.test.ts` — **SKIPPED** |
| Concurrent versioning, lost-increment prevention, rollback, cross-tenant | `packages/db/tests/policy-mutation.live.test.ts` — **SKIPPED** |

Both live suites have **never been executed**: no test database is available,
and none was invented. The concurrency guarantees above are argued and
tested-but-unrun.
