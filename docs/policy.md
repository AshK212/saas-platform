# Policy Versioning and Agent Polling

> **Policy read/versioning implemented in Step 12. Operator mutation is Step 13.**
>
> Nothing in this document describes a way to change a policy. There is no
> mutation route, no mutation contract and no policy writer in the data layer —
> only provisioning may insert the initial version row.

Sources: [`packages/contracts/src/policy.ts`](../packages/contracts/src/policy.ts) ·
[`packages/db/src/repositories/policy.ts`](../packages/db/src/repositories/policy.ts) ·
[`apps/api/src/routes/policy.ts`](../apps/api/src/routes/policy.ts)

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

## Not implemented in Step 12

- **Operator policy mutation** — Step 13. Version increment will be atomic with
  the change itself, in one transaction.
- **Precheck decisions and receipts.** Every future receipt will record the
  exact policy version it evaluated against; this step is the foundation for
  that.
- **Ledger debit** — Step 19. `spend.recorded` still does **not** debit the
  authoritative ledger.
- **Cap and pause enforcement** (AC-07, AC-08, AC-10, AC-11, AC-12).
- **Any policy UI.** No spend-cap, mode or publish-cap controls exist.

## Verification status

| Behaviour | Evidence |
| --- | --- |
| Auth domain, 304, version semantics, defaults, isolation, no-write | 67 route tests |
| Workspace predicate, join scoping, `::text` cast, no writer | 15 compiled-SQL tests |
| Atomic provisioning, rollback, LEFT JOIN, bigint round trip, exact decimals | `packages/db/tests/policy.live.test.ts` — **gated on `TEST_DATABASE_URL`; currently SKIPPED** |

The live suite has **never been executed**: no test database is available, and
none was invented.
