# Cross-Tenant Isolation (AC-20)

> **AC-20** — "Automated cross-tenant test for all implemented Credit paths,
> passing."

One question, asked of every path the Credit phase implements: **can workspace
A read, mutate, authenticate as, account against or govern workspace B?**

---

## The one property everything rests on

Four different callers can end up holding a `WorkspaceScope`. Their inputs have
nothing in common. The shape of their resolution does:

| Authority | Presents | Scope derived from | Since |
| --- | --- | --- | --- |
| Operator session | session cookie | `workspace_memberships` row | Step 6 |
| Machine credential | `Authorization: Bearer` | `api_credentials` row | Step 7 |
| Share token | token exchanged for a scoped cookie | `share_tokens` row | Step 21 |
| Public demo | slug in the path | `workspaces` row + `demo_enabled` | Step 22 |

> **In all four, the workspace comes from a row the SERVER matched — never from
> a body, query string, header or path.**

`createWorkspaceScope` is deliberately not exported from `@hybrid/db`, so an
HTTP handler cannot mint a scope from request input, and a guard test fails if
any file under `apps/*/src` calls the raw constructor. That is what makes
isolation an invariant rather than a habit, and it is why a fifth read surface
could be added without re-arguing the question.

The three non-operator authorities are progressively weaker, and the **type
system** carries the difference rather than a comment. `ReadOnlyShareContext`
and `ReadOnlyDemoContext` carry no user, no role and no permission set, and
neither is an `AuthorizedWorkspace` — which every mutating store requires. "A
demo visitor writes something" is not a bug that was tested for and found
absent; it is a sentence that does not typecheck.

---

## Three layers, three different claims

No single layer can establish AC-20, and conflating them is how a project talks
itself into believing it is safe.

| Layer | File | Proves | Cannot prove |
| --- | --- | --- | --- |
| 1. HTTP | `apps/api/tests/ac20-cross-tenant.test.ts` | Each surface derives its scope from the right authority, over the real router with the real contracts | Anything about SQL — the stores are fakes |
| 2. Compiled SQL | `packages/db/tests/ac20-sql-isolation.test.ts` | Every tenant-owned query carries `workspace_id` in its predicate, bound as a parameter | That PostgreSQL honours it, or that constraints exist |
| 3. Live PostgreSQL | `packages/db/tests/ac20-cross-tenant.live.test.ts` | The database itself refuses cross-tenant rows | — **and it has never run** |

Layer 1 is 111 tests. Layer 2 is 172. Layer 3 is 23, and all 23 are **skipped**
for want of a `TEST_DATABASE_URL`.

**A fake cannot forget a WHERE clause it never had.** That single sentence is
why layer 1 alone would be near-worthless as isolation evidence, and why layer 3
is the one that actually settles the question.

---

## Why the test data collides on purpose

An isolation test using distinct identifiers per tenant proves almost nothing. A
repository that dropped its workspace predicate still returns the right row,
because only one row matches.

So both tenants in every layer hold the **same** external identifiers:

```
agent-1          in A and in B
evt-shared-001   in A and in B
act-shared-001   in A and in B
blk-shared-001   in A and in B
```

A missing predicate now returns the **wrong tenant's row**, and the test fails
loudly instead of passing quietly.

Internal UUIDs are the opposite case — globally unique, and therefore exactly
what an attacker would hold. Every one of B's internal ids (agent, event,
receipt, block, share, workspace) is captured and fed back through each of A's
four authorities.

The tenants are also deliberately given **different governance**: A is capped at
\$25, B at \$99; A's policy version is 1, B's is 7; A's receipt for the shared
action is a `deny`, B's is an `allow`. A leak is therefore not merely a privacy
failure — it changes an enforcement decision, and the tests assert the decision.

---

## The surface inventory

Derived from the router's own registrations, not from memory. Every row is
covered by layer 1.

### Operator session — membership authority

| Method | Path | R/W | A → B |
| --- | --- | --- | --- |
| GET | `/v1/workspaces` | R | B absent from the list |
| GET | `/v1/workspaces/:id` | R | 404 |
| GET/POST | `/v1/workspaces/:id/api-keys` | R/W | 404, no credential created |
| POST | `/v1/workspaces/:id/api-keys/:credentialId/revoke` | W | 404 |
| GET | `/v1/workspaces/:id/agents` | R | 404 |
| GET | `/v1/workspaces/:id/agents/:agentUuid` | R | 404 |
| GET | `/v1/workspaces/:id/events` | R | 404 |
| GET | `/v1/workspaces/:id/events/:eventUuid` | R | 404 for B's exact uuid |
| GET | `/v1/workspaces/:id/receipts` | R | 404 |
| GET | `/v1/workspaces/:id/receipts/:receiptId` | R | 404 for B's exact uuid |
| GET | `/v1/workspaces/:id/blocks` | R | 404 |
| GET | `/v1/workspaces/:id/blocks/:blockId` | R | 404 for B's exact uuid |
| GET/PUT | `/v1/workspaces/:id/agents/:agentUuid/policy` | R/W | 404, B's version unmoved |
| GET/POST | `/v1/workspaces/:id/share-links` | R/W | 404, no link issued |
| POST | `/v1/workspaces/:id/share-links/:shareId/revoke` | W | 404, B's link still live |
| GET/PUT | `/v1/workspaces/:id/demo` | R/W | 404, B's demo still public |

### Machine credential — four routes, and only four

| Method | Path | R/W | A → B |
| --- | --- | --- | --- |
| POST | `/v1/agents/register` | W | Lands in A; body/query/header workspace ignored |
| GET | `/v1/policy` | R | A's policy at A's version |
| POST | `/v1/actions/precheck` | W | A's receipt, A's ledger, A's block |
| POST | `/v1/events` | W | A's events, A's ledger |
| GET | `/v1/api-key/me` | R | Reports A only |

### Share token — read-only, revocable

`GET /v1/share/workspace`, `/agents`, `/events`, `/events/:id`, `/receipts`,
`/blocks`, plus the one `POST /v1/share/access` exchange, which sets a cookie
and writes nothing.

### Public demo slug — read-only, anonymous

`GET /v1/demo/:slug`, `/agents`, `/events`, `/events/:id`, `/receipts`,
`/blocks`.

### The simulator is a client, not an authority

It holds one workspace API key, constructs no operator route, imports no
database package, and never names a workspace. Enforced by a simulator-specific
lint rule and by architecture guards, not by convention.

---

## Authority confusion

Isolation fails just as completely if "authenticated somehow" becomes
"authorized here". Tested explicitly, in-process and over a real socket:

- An **API key cannot mutate policy**, even for its own workspace.
- An **API key cannot read operator history** — roster, timeline, receipts,
  blocks, share links, demo settings — for its own workspace. A runtime
  credential authorizes four routes, and holding one for the tenant does not
  widen that.
- A **session cookie cannot stand in for a bearer credential**, and cannot
  ingest events or precheck.
- A **share cookie reaches no operator or machine route**, and a share token
  presented as a bearer credential is refused.
- An **API key presented as a share token** is refused.
- **No public authority can create an event or a precheck.**
- **No non-GET route exists under `/v1/demo` or `/v1/share`** — asserted by
  interrogating the router's registrations rather than by probing known paths,
  so a future public write is caught the moment it is mounted.

---

## Database defence in depth

The layer that survives a missing WHERE clause. Every one is exercised by layer
3, and every one is therefore currently **unverified**.

**Workspace-scoped unique constraints.** `(workspace_id, event_id)`,
`(workspace_id, action_id)`, `(workspace_id, external_id)` on agents,
`(workspace_id, external_block_id)`. Both halves are tested: two tenants may
hold the same identifier, and a second row in **one** tenant is still refused —
without which "scoped" could quietly mean "gone", and idempotency would be
broken rather than isolated.

**Composite foreign keys.** `(workspace_id, agent_id)` on events, ledger rows,
receipts, blocks and agent policies; `(workspace_id, precheck_receipt_id)` on
block linkage. A row in A pointing at an agent in B cannot be inserted, whatever
the application layer believes.

**The ledger primary key.** `(workspace_id, agent_id, day)`. One external agent
id in two tenants is two rows, always.

**The locked-ledger capability gate.** `lockDailyLedger` resolves the agent
inside the scope **before** its create-if-absent insert, so a foreign agent
UUID yields `null` and leaves no phantom row. The composite FK would also
refuse the insert, but as an opaque driver error rather than a clean "not
found" — the guard is there so the failure is legible.

**The demo CHECK constraint.** `demo_slug IS NULL OR demo_enabled`. This is what
makes disabling total: a slug cannot outlive its flag, so a retired demo URL
cannot be left addressable in the table.

---

## Mutation-test evidence

Six deliberate defects, each applied, run, and reverted byte-identically. Each
was run twice where the layers differ — once against the production repository,
once against the fake behind the HTTP suite — because a probe against only one
layer tells you nothing about the other.

| Probe | Applied to | Caught by | Tests failed |
| --- | --- | --- | --- |
| **A** — workspace predicate removed from a detail lookup | `receipts.findAuditById` | SQL layer + prior-step guards (and `tsc`) | 6 |
| **A′** — same, in the fake | `memory-event-read-store.findDetail` | HTTP layer, on **all four authorities** | 8 |
| **B** — machine authority trusts `x-workspace-id` | `api-keys/authenticate.ts` | HTTP layer + prior-step header guards | 6 |
| **C** — idempotency lookup unscoped | `receipts.findByActionId` | SQL layer (and `tsc`) | 4 |
| **C′** — same, in the fake | `memory-precheck-store` | HTTP layer | 4 |
| **D** — ledger capability gate unscoped | `ledger.findScopedAgent` | SQL layer (and `tsc`) | 5 |
| **D′** — same, in the fake | `memory-ledger` row key | HTTP layer | 4 |
| **E** — share detail lookup unscoped | `shareTokens.findById` | SQL layer (and `tsc`) | 4 |
| **E′** — share token becomes a workspace **selector** | `memory-share-store` resolver | HTTP layer | 11 |
| **E″** — demo slug becomes a workspace **selector** | `memory-demo-store` resolver | HTTP layer | 13 |
| **F** — public authority reaches a mutation route | `PUT /v1/demo/:slug/policy` | Step 22 structural guards — **and initially NOT the AC-20 suite** | 2 → 3 |

**Probe F exposed a real gap in the new suite.** The authority-confusion test
enumerated methods against paths it already knew, so a mutation mounted at a
*new* public path sailed past it. That was fixed by asking the router what it
registered instead of guessing; the probe now fails three tests rather than two.

---

## Known gaps, stated plainly

1. **No live database run.** The 23 tests that would prove PostgreSQL enforces
   any of this are skipped. Every claim in "Database defence in depth" above is
   argued and unrun. This is the whole reason AC-20 is not PASS.

2. **Layer 1 drives fakes.** They are faithful on the properties that matter and
   the mutation probes confirm they bite, but they are not the production
   repositories. A defect present only in Drizzle query construction is caught
   by layer 2 or not at all.

3. **A deliberate inconsistency in request-body strictness.** Policy, precheck,
   ingest, share and demo use `z.strictObject`, so `{"workspace_id": "..."}` is
   a loud 400. Agent registration, API-key creation, magic-link and workspace
   creation use `z.object`, so the field is silently dropped by Zod.

   **Neither is a vulnerability** — none of those routes reads a workspace from
   a body at all, and both behaviours are asserted. But the project's own
   rationale (written into `createShareLinkRequestSchema`) argues for rejection,
   "so a caller does not believe a silently ignored field took effect".
   Standardising on `strictObject` would change the shape of four public
   contracts and contradict a test that asserts the drop on purpose, so it is
   recorded here as a recommendation rather than made inside an acceptance step.

4. **Concurrency is untested.** Whether two simultaneous requests in different
   tenants can interfere — through the advisory lock, `SELECT … FOR UPDATE`, or
   a shared connection — is observable only against real PostgreSQL.

---

## Status

**AC-20: `IMPLEMENTED / STAGING VERIFICATION BLOCKED`. Not PASS.**

The comprehensive automated suite exists and passes locally: 111 HTTP tests, 172
compiled-SQL tests, 28 authority checks against the compiled build over a real
TCP socket, and eleven mutation probes that each failed as intended.

What has never happened is the live run. AC-20 asks for an automated
cross-tenant test that **passes**, and one third of that test has never
executed. It becomes PASS when `TEST_DATABASE_URL` exists and
`packages/db/tests/ac20-cross-tenant.live.test.ts` reports 23 passed rather than
23 skipped.
