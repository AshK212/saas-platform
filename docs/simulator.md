# The Reference Client (AC-03)

> **The simulator is an ordinary API consumer with no privileged standing.**
>
> It holds one workspace API key and speaks only the four machine routes. It
> imports no database package, knows no workspace id, and cannot set a cap,
> pause an agent, or change anything the plane governs.

> **THE PLANE IS THE LEDGER; THE PLUGIN IS THE HANDS.**
>
> The client asks `POST /v1/actions/precheck` and obeys the answer. It never
> computes a verdict itself — no `41 > 25`, no publish counter, no "is this
> agent paused". A client that decided for itself would be a second governance
> engine, and its copy of the cap would go stale the moment an operator changed
> it.

Sources: [`apps/simulator/src/client.ts`](../apps/simulator/src/client.ts) ·
[`apps/simulator/src/runtime.ts`](../apps/simulator/src/runtime.ts) ·
[`apps/simulator/src/scenarios.ts`](../apps/simulator/src/scenarios.ts)

---

## Why it exists

To prove the **public API is sufficient** to run a governed fleet.

If a Credit flow cannot be driven from here, that is a finding about the API,
not something to work around by reaching behind it. Architecture guards enforce
that the client stays unprivileged, and its tests drive it over a real socket
rather than a stubbed `fetch` — a stub would let a client that sends malformed
JSON or mishandles a 304 pass every test.

## The command

```bash
CONTROL_PLANE_URL=https://api.example.test \
CONTROL_PLANE_API_KEY=hmp_live_... \
pnpm simulator <scenario> [flags]
```

`pnpm simulator` runs the compiled client; `pnpm simulator:dev` runs it from
source. Build first with `pnpm build:simulator` (or `pnpm build`).

### Scenarios

| Scenario | Exercises |
| --- | --- |
| `stream` | continuous three-agent activity with policy polling |
| `baseline` | one pass of three-agent activity — AC-04, AC-05, AC-06 |
| `over-cap` | agent-a attempts $41 against its cap — AC-08 |
| `cap-raise-retry` | retry under a **new** action id after a raise — AC-10 |
| `publish-burst` | six publish attempts by agent-b — AC-11 |
| `pause-probe` | agent-a acts while paused — AC-12 |
| `replay` | submit one batch twice, byte-identical — AC-13 |
| `unprechecked-spend` | report spend with no precheck — Step 19 |

### Flags

| Flag | Default | Notes |
| --- | --- | --- |
| `--api-url <url>` | `CONTROL_PLANE_URL` | not a secret; a flag is fine |
| `--poll-interval <ms>` | `30000` | policy poll cadence |
| `--tick-interval <ms>` | `5000` | `stream` activity cadence |
| `--timeout <ms>` | `10000` | per-request timeout |
| `--run-id <id>` | random | pins the id namespace for a reproducible run |
| `--cycles <n>` | unbounded | `stream` only |

## The API key

**Environment only. There is deliberately no `--api-key` flag.**

A flag would put a live workspace credential into shell history, into `ps`
output for every user on the machine, and into any CI log that echoes its
command line. None of that is recoverable afterwards.

There is also **no default**. A synthetic production-looking fallback would let
the client "work" while pointing somewhere unintended, and is the kind of value
that eventually gets committed.

The key is read in exactly one place — the `Authorization` header — and never
logged, never returned, and never attached to an error. `ControlPlaneError`
carries a status and a short reason and deliberately does **not** carry the
request init: a thrown object holding headers is a credential one
`console.error` away from a terminal. As a second line of defence, all output
passes through a redactor.

Copy `.env.example` to `.env` for local use. Never commit a real key.

## Operator authority vs runtime authority

This is the distinction the product rests on.

| | Operator (web app, session cookie) | Runtime (this client, API key) |
| --- | --- | --- |
| Set mode and caps | ✅ | ❌ |
| Pause / unpause | ✅ | ❌ |
| Read receipts, blocks, timeline | ✅ | ❌ |
| Register an agent | ❌ | ✅ |
| Poll policy | ❌ | ✅ |
| Ask precheck | ❌ | ✅ |
| Report events | ❌ | ✅ |

**Every acceptance scenario below has an operator precondition the simulator
cannot satisfy itself.** That is the point, not a limitation: a runtime that
could raise its own cap would make governance decorative. The server refuses a
machine credential on operator routes, and a guard test asserts the client
never even constructs one.

## Identity and retry semantics

Both `action_id` and `event_id` are client-supplied, and the server treats each
as **immutable** once it has decided or stored under it. That makes reuse a
correctness question:

- **Retrying an uncertain request reuses the SAME id.** A lost HTTP response
  does not mean the server did nothing. The client serialises each body once
  and replays those exact bytes, so a retry carries the same identity and
  server-side idempotency decides the outcome. Retrying with a fresh id turns
  "did my $4 land?" into a second $4 spend.
- **A genuinely new attempt gets a NEW id.** After an operator raises a cap,
  the retry is a new action — see AC-10 below.

Retries are bounded and apply only to uncertain outcomes: a 5xx, a 429, or a
transport failure. A 4xx is a decision, not a blip, and is never retried.

## What the client never does

- **No local governance.** It does not compare a total to a cap or interpret a
  mode. It asks.
- **No local authoritative ledger.** The server ledger is authority. The client
  keeps no running spend total and never tries to reconcile one.
- **No block for a plane denial.** When precheck denies, the plane has already
  written the receipt **and** its own block, atomically, before answering.
  Emitting an `action.blocked` too would put two records in the audit for one
  refusal, and an operator could not tell which system actually stopped the
  work. `action.blocked` remains valid **only** for a denial the runtime made
  on its own account.
- **No float arithmetic.** Amounts are exact decimal strings end to end.

---

# Credit walkthrough

Run once staging credentials exist. Steps marked **operator** happen in the web
app; steps marked **runtime** are simulator commands.

| # | Who | Action | Verifies |
| --- | --- | --- | --- |
| 1 | operator | Sign in by magic link | AC-01 |
| 2 | operator | Create or select a workspace | AC-02 |
| 3 | operator | Issue a workspace API key, copy it once | AC-02 |
| 4 | runtime | `CONTROL_PLANE_API_KEY=... pnpm simulator stream` | — |
| 5 | operator | Agents view: three agents, last seen < 60s | **AC-04** |
| 6 | operator | Events view: filter by agent; open one for raw JSON | **AC-05, AC-06** |
| 7 | operator | Set agent-a to `budgeted`, daily spend cap `$25` | **AC-07** |
| 8 | runtime | `pnpm simulator over-cap` — attempts `$41` | — |
| 9 | operator | Governance view: the denial, its receipt, its plane block | **AC-08** |
| 10 | operator | Raise agent-a's cap to `$100` | — |
| 11 | runtime | `pnpm simulator cap-raise-retry` — **new action id** | **AC-10** |
| 12 | operator | Set agent-b to `budgeted`, daily publish cap `5` | — |
| 13 | runtime | `pnpm simulator publish-burst` — six attempts | **AC-11** |
| 14 | operator | Pause agent-a | — |
| 15 | runtime | `pnpm simulator pause-probe` — expect a denial | **AC-12** |
| 16 | operator | Unpause agent-a, then rerun step 11 with a new run id | **AC-12** |
| 17 | runtime | `pnpm simulator replay` | — |
| 18 | operator | Events view: the count is unchanged | **AC-13** |

## Step 11 in detail — why a NEW action id

**`action_id` is the precheck idempotency key.** The denied attempt has a
durable receipt under its id, and the plane correctly replays that same denial
for that id **forever** — which is exactly what makes a network retry safe.

So retrying after a cap raise with the **original** id returns the old denial
and looks precisely like "the raise did not take effect". A retry after a
policy change is a **new action** and needs a new identity.

`cap-raise-retry` uses a different ordinal, so its action id differs from the
one `over-cap` used. Between runs, `--run-id` also changes unless pinned.

## Step 13 in detail — the sixth publish

One precheck is one publish; the contract carries no count. The burst is six
prechecks with **six distinct action ids** — reusing one would replay the first
decision six times and prove nothing about the cap.

The client stops executing at the first denial. The sixth publish does not
happen, and the plane has already recorded why.

## Step 17 in detail — the replay

The batch is built **once** and held. Both submissions send the identical
bytes: same event ids, same payloads, nothing regenerated. A scenario that
rebuilt the batch would generate fresh ids and prove the opposite of what AC-13
asks.

Expected: `accepted 3, duplicates 0` then `accepted 0, duplicates 3`, with the
stored event count unchanged.

## Verification status

| | |
| --- | --- |
| Reference-client tests | 25, against a **real HTTP socket** |
| Architecture guards | 30 |
| Compiled CLI | exercised against a local fake control plane |
| **Staging** | **BLOCKED** |

**AC-03 is `IMPLEMENTED / STAGING VERIFICATION BLOCKED`, not PASS.** The
documented command exists and works against controlled HTTP fixtures. It has
never run against an authorized staging environment, because no client-owned
Neon, Render or GitHub resource exists. The walkthrough above is written to be
executed the day one does.

The simulator's existence does **not** advance AC-04 through AC-13. Those
require the operator steps and a real control plane.
