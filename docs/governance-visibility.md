# Operator Governance Visibility

> **THE PLANE DECIDES; THIS SURFACE ONLY REPORTS.**
>
> Every value an operator sees here was computed and persisted by the control
> plane. Nothing is re-derived at read time, and nothing is re-derived in the
> browser. Complete as of Step 17.

> **NO HISTORICAL RECOMPUTATION.** A receipt explains itself with the policy
> that produced it. Raising a cap this morning does not rewrite yesterday's
> denial.

> **`spend.recorded` events still do NOT debit the authoritative ledger.** That
> is Step 19. Today's usage shown here is the ledger's committed total, which
> moves only on a precheck *allow*.

Sources: [`packages/contracts/src/governance.ts`](../packages/contracts/src/governance.ts) ·
[`apps/api/src/governance/read-store.ts`](../apps/api/src/governance/read-store.ts) ·
[`apps/api/src/governance/cursor.ts`](../apps/api/src/governance/cursor.ts) ·
[`apps/api/src/routes/governance.ts`](../apps/api/src/routes/governance.ts) ·
[`apps/web/src/Governance.tsx`](../apps/web/src/Governance.tsx) ·
[`apps/web/src/governance-format.ts`](../apps/web/src/governance-format.ts)

---

## What Step 17 added

Three surfaces, all read-only:

1. **Fleet enforcement state** — the agent roster now carries each agent's
   effective mode, its caps, and today's committed usage.
2. **Decision audit** — every precheck receipt, listable and drillable.
3. **Block audit** — every block, runtime- and plane-owned alike.

No new enforcement, no new writes, no new mutation route.

## The routes

```http
GET /v1/workspaces/:workspaceId/receipts
GET /v1/workspaces/:workspaceId/receipts/:receiptId
GET /v1/workspaces/:workspaceId/blocks
GET /v1/workspaces/:workspaceId/blocks/:blockId
```

**Browser sessions only.** An API key is refused with 401. A runtime that can be
denied must not also be able to read the whole tenant's denial history —
otherwise one compromised agent enumerates every other agent's governance.

**Any member may read; only an operator may mutate policy.** Governance history
is ordinary tenant data, like the agent roster. Step 17 widened *reads* and
nothing else; a member calling `PUT …/policy` is still refused.

**A foreign or malformed id is an identical 404.** Never 403 — distinguishing
"not yours" from "no such thing" is an existence oracle across tenants. Ids are
screened against a UUID pattern before reaching SQL, so a malformed id cannot
surface as a 500 and thereby distinguish itself.

### Query parameters

| Parameter | Receipts | Blocks |
| --- | --- | --- |
| `agent_id` | External id, resolved inside the workspace | same |
| `decision` | `allow` · `deny` | — |
| `source` | — | `plane` · `runtime` |
| `limit` | 1–100, default 50 | same |
| `cursor` | Opaque; pass back unmodified | same |

**Strict.** An unknown parameter is a 400, not an ignored field. A misspelled
filter that silently returned the unfiltered audit stream would be read as a
complete answer to a question that was never asked.

An `agent_id` this workspace does not have returns an **empty page**, not a 404
— reporting 404 would reveal whether the id exists in some other tenant.

### Pagination

`created_at DESC, id DESC`, with the boundary expressed as a row-value
comparison:

```sql
(created_at, id) < ($1::timestamptz, $2::uuid)
```

A burst of decisions can share one timestamp. A plain `created_at <` would skip
the remainder of that instant, silently losing rows from an audit trail — the
one place a silent loss is least acceptable. The row-value form is exactly the
ordering boundary and cannot disagree with the `ORDER BY`.

The page-boundary probe is `limit + 1`: one extra row is fetched and dropped. A
`COUNT` would be a second scan for information the client does not need.

## Fleet enforcement state

The agent roster response gains a `governance` object:

```jsonc
{
  "mode": "budgeted",
  "dailySpendCapUsd": "25.000000",   // null = uncapped, never 0
  "dailyPublishCap": 5,              // null = uncapped
  "spendCommittedUsd": "24.000000",
  "publishCountCommitted": 4,
  "accountingDay": "2026-08-13"      // the SERVER's UTC day
}
```

Four properties carry weight:

- **Mode and caps are EFFECTIVE policy**, resolved by the same Step 12 read a
  polling agent uses. The fleet view and the agent can never disagree about
  what is in force.
- **Usage comes from `ledger_daily`, never from events.** Summing
  `spend.recorded` events would show a number the plane does not enforce
  against, and the two would diverge silently.
- **Absent usage is zero, computed at read time and never persisted.** An
  operator opening a dashboard must not thereby create accounting rows for
  every agent that did nothing all day.
- **The accounting day is the server's**, derived once per roster from the
  injected clock. One reading, so a request straddling UTC midnight cannot
  report two different days across its rows.

### The read path takes no lock and writes nothing

`findDailyLedger`, never `lockDailyLedger`. Locking to render a number would
serialize every dashboard refresh against live enforcement — and, worse,
materialise today's ledger row as a side effect of looking at it.

This is guarded three ways, because it is the failure that looks correct:

| Guard | Where | Catches |
| --- | --- | --- |
| Source assertion | `apps/api/tests/governance-boundary.test.ts` | the name |
| Compiled SQL | `packages/db/tests/governance.test.ts` | `FOR UPDATE` in the emitted statement |
| Live execution | `packages/db/tests/governance.live.test.ts` | a row actually left behind |

The live suite transcribes the fleet composition, because `packages/db` cannot
import from `apps/`. A drift guard in `apps/api` — which depends on both —
keeps the transcription honest.

## Receipt detail: persisted evidence

Every field is what was written at decision time:

| Field | Meaning |
| --- | --- |
| `policyVersion` | The exact version the decision evaluated against |
| `appliedMode` | The mode **then**, not the agent's mode now |
| `appliedSpendCapUsd` / `appliedPublishCap` | The caps then |
| `requestedAmountUsd` / `requestedPublishCount` | What was asked for |
| `ledgerSpendBeforeUsd` / `ledgerPublishBefore` | Committed usage as read during the decision |
| `remainingSpendUsd` / `remainingPublishCount` | Headroom reported to the caller |
| `reason` | The persisted machine-readable denial reason, `null` on an allow |
| `block` | The plane block this denial produced, `null` otherwise |

Nothing here asks "what would this decision be under today's policy?" The route
never loads live policy and never touches the ledger. The UI labels the policy
block **"at decision time"** with "Current policy may differ", because without
that wording an operator reading a denial after raising a cap would reasonably
assume the caps shown are the ones in force now.

## Block detail: who refused

`source` is **persisted state**, never inferred:

| | `plane` | `runtime` |
| --- | --- | --- |
| Who refused | The control plane | A plugin, locally |
| `precheckId` | The denial receipt | **`null`** |
| `externalBlockId` | `null` | The client's own id |
| `rule` | One of the three governance rules | Free text the plugin chose |

**A runtime block has no receipt, and none is fabricated.** The UI says so
plainly: *"Reported by the runtime. The control plane made no decision for this
block."* Inventing a decision record for a refusal the plane never made would be
a lie about who enforced what.

A runtime `rule` is free text from a system we do not control, so an
unrecognised value is shown **verbatim** rather than given an invented friendly
label.

## The browser never derives enforcement state

`apps/web/src/governance-format.ts` takes canonical decimal strings and returns
display strings. There is no `parseFloat`, no `toFixed`, no arithmetic, and no
comparison of a committed total to a cap.

- **Money is formatted by string manipulation.** `"24.000000"` → `"$24.00"`,
  truncating rather than rounding the sub-cent remainder: a rounded-up total
  could read as a cap reached while the plane still has headroom.
- **The two halves are never compared.** "Is this agent over budget?" is a
  question only the plane answers, and it answers it in the receipt. A float
  comparison in the browser could disagree with the exact micro-dollar
  comparison the precheck actually made.
- **The day is never derived locally.** A browser in UTC+13 computing its own
  "today" would show tomorrow's empty ledger beside today's caps.

Display forms are fixed:

```
Today's spend:    $24.00 / $25.00     or  $24.00 / Uncapped
Publishes today:  4 / 5               or  4 / Uncapped
```

Caps are shown **only under `budgeted`**. A leftover cap under `watch` governs
nothing, and printing it beside a watching agent would imply a budget is in
force.

**Nothing claims protection.** No copy says "safe", "protected" or "blocked" on
the strength of a cap existing. A configured cap is a recorded intention plus an
enforcement path; it is not a guarantee that anything was stopped.

## Escaping

Receipt and block text includes runtime-authored free text. Every value is
rendered as a React text child, so `<script>alert(1)</script>` in a `rule`
appears as characters. There is no `dangerouslySetInnerHTML` anywhere in
`apps/web/src`, and a guard test asserts it.

## Deliberately absent

Gone-dark alerting (AC-14), email digests (AC-15), CSV export (AC-16), daily
rollups (AC-17), share links, demo mode and simulators. Also absent: any
acknowledge, dismiss, override, retry or delete control. An editable audit trail
is not an audit trail, and a UI affordance that appeared to change the record
would misrepresent it even though the server has no route to accept the write.

## Verification status

| | |
| --- | --- |
| Default suite | 1719 tests, 48 files, passing |
| Compiled-SQL evidence | `packages/db/tests/governance.test.ts` — 42 tests |
| Route behaviour | `apps/api/tests/governance-routes.test.ts` — 56 tests |
| Source guardrails | `apps/api/tests/governance-boundary.test.ts` — 28 tests |
| Frontend guardrails | `apps/web/tests/governance-ui.test.ts` — 30 tests |
| **Live PostgreSQL** | `packages/db/tests/governance.live.test.ts` — 18 tests, **SKIPPED** |

The live suite is gated on `TEST_DATABASE_URL` and **never falls back to
`DATABASE_URL`**. It has never run: no authorized database exists. Every claim
above about real ordering, real tiebreak, real cross-tenant exclusion and real
"no row created" behaviour is **argued and tested-but-unrun**.
