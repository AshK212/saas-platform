# Public Demo Mode (AC-19)

A workspace can be published as a **public, read-only, live** control plane
page: a URL that opens for anyone, with no account, no invitation and no
credential of any kind, showing the real fleet, the real ledger-backed spend,
the real receipts and the real blocks — refreshing on its own, and producing a
new enforcement block every few minutes.

It is not a mock. Every number on the page came out of the same read stores
that serve the operator UI, through the same row mappers, over the same
governance path.

---

## Two surfaces

| Surface                                     | Who reaches it        | What it can do             |
| ------------------------------------------- | --------------------- | -------------------------- |
| `PUT/GET /v1/workspaces/:workspaceId/demo`  | Operator session only | Turn the demo on and off   |
| `GET /v1/demo/:slug…`                       | Anyone, anonymously   | Read. Only read.           |

The management surface is an ordinary authenticated workspace route: session
cookie, membership, and an explicit `operator` role check. Publishing a tenant
is a decision made on behalf of everybody in it, so a `member` is refused with
403 — the same posture as API-key issuance and policy editing.

The public surface takes no credential at all.

---

## The fourth read authority

The platform now resolves a `WorkspaceScope` four ways. Every one of them ends
in a scope derived from a **row the server matched**, never from request input:

| Authority                | Input                       | Resolved from            |
| ------------------------ | --------------------------- | ------------------------ |
| Operator session (AC-01) | session cookie              | membership row           |
| Machine key (AC-02)      | `Authorization: Bearer`     | credential row           |
| Share token (AC-18)      | exchanged token → cookie    | share row                |
| **Public demo (AC-19)**  | **slug in the path**        | **workspace row**        |

The demo authority is the weakest of the four by construction. It is a
`ReadOnlyDemoContext` — workspace id, workspace name, slug, scope — and it
carries **no user, no role and no permission set**. It is deliberately *not* an
`AuthorizedWorkspace`, so it cannot be passed to anything that expects one.
Every mutating store in the codebase requires an `AuthorizedWorkspace`, which
means "a demo visitor writes something" is not a bug that was tested for and
found absent — it is a sentence that does not typecheck.

---

## The slug is a locator, not a secret

This is the crucial difference from AC-18 sharing, and it drives the whole
design.

A **share token** is a 256-bit bearer credential. Its secrecy *is* the security
model, which is why AC-18 hashes it at rest, shows it once, keeps it out of
URLs, and exchanges it for a cookie.

A **demo slug** is meant to be published — printed in a deck, pasted on a
website, read aloud. It has no secrecy to protect and none is assumed. It is
stored in plaintext, it appears in the path, it will be in access logs, and
none of that matters.

The security model is therefore the **flag**, not the name:

```sql
WHERE demo_slug = $1 AND demo_enabled = true
```

Both live in the `WHERE` clause of one statement, so a private workspace is not
"fetched and then rejected" — it is never in the result set. Someone who learns
a former slug gets exactly the same answer as someone who guesses at random.

Slugs are still generated with `crypto.randomBytes`, not `Math.random`, and
carry an eight-character random suffix. Not because the slug is a secret, but
because guessable public URLs (`/demo/acme`) invite drive-by enumeration of who
your customers are, and because a collision must be a non-event.

---

## Enabling, disabling, and why the slug rotates

```
PUT /v1/workspaces/:workspaceId/demo   { "enabled": true }
→ { "demo": { "enabled": true, "slug": "acme-k7m2p4qx", "publicPath": "/demo/acme-k7m2p4qx" } }
```

The caller does **not** choose the slug. A caller-chosen slug is a namespace
grab (`/demo/login`, `/demo/admin`) and a way to impersonate another company's
name in a URL your product serves.

Enabling an already-enabled workspace is idempotent and keeps the existing
address, so a link in a deck does not die because someone clicked the toggle
twice.

**Disable is immediate and total.** It sets `demo_enabled = false` and clears
`demo_slug` in one statement. The next public request — including the next
15-second auto-refresh of a page already open on someone's screen — resolves
nothing and gets `404 demo_not_found`. There is no cached decision, no session
to expire and nothing to invalidate.

Clearing the slug is not optional: the schema constraint from Step 3 forbids a
slug on a private workspace.

```sql
CHECK (demo_slug IS NULL OR demo_enabled)
```

**Consequence: re-enabling issues a NEW slug.** The old URL stays dead forever.
That is a real behaviour change for anyone who bookmarked it, and it is the
right trade: "I turned the demo off" should mean the link is *gone*, not
dormant and quietly revivable. The operator toggle says so in plain words
before you confirm.

---

## What the public page shows

`GET /v1/demo/:slug` and its five sub-resources return exactly what the
operator sees, minus anything operational:

- **Fleet** — agents, enforcement mode, today's spend against the cap, today's
  publishes against the cap. Spend comes from `ledger_daily`, the authoritative
  ledger. It is never summed from events, in the API or in the browser.
- **Blocks** — the enforcement audit, newest first.
- **Decisions** — precheck receipts, allow and deny.
- **Activity** — the event timeline, with raw payload detail.

What it does **not** expose: workspace ids, user ids, emails, API keys or their
prefixes, share links, policy editing, credential management, or any other
tenant's anything.

Unknown slug, malformed slug, disabled demo and another tenant's record all
produce one identical answer:

```json
{ "error": "demo_not_found" }
```

404, every time. A visitor has no need to learn that a workspace exists but is
private, and distinguishing the cases would let anyone probe for it.

Viewing is not activity: no `last_seen_at` moves, no ledger row is created, no
policy version is bumped and no receipt is written. Every read store on this
path is write-free.

---

## Recurring synthetic activity

A demo page with a static fleet is a screenshot. AC-19 asks for live activity
including a real enforcement block every few minutes.

```bash
pnpm --filter @hybrid/simulator start demo
```

The generator is a **mode of the reference client** (`docs/simulator.md`), not a
second program. It holds one workspace API key and speaks only the four machine
routes: register, poll policy, precheck, report events.

### It cannot fabricate a block

A block is not something a client can write. It exists only as the product of:

```
precheck → the server evaluates policy → DENY → receipt + block, atomically
```

So the generator periodically attempts a spend it expects to be refused, and
lets the server decide. What lands on the public page is a real denial with a
real receipt, written by the plane inside its own transaction.

If the attempt is **allowed** — because an operator raised the cap — the
generator obeys. It reports the spend like any runtime would, logs that no
block was created, and does **not** quietly lower the cap to keep the demo
interesting. The generator holds runtime authority only; it constructs no
operator route, and a guard test asserts as much.

### Every cycle needs a new action id

`action_id` is the precheck idempotency key. Reusing one across cycles would
replay the *first* decision forever: the plane would return the original
receipt and write **no new block**. The page would show one block from an hour
ago and never another — and every log line would look healthy.

Each block attempt therefore carries a fresh ordinal, and so a genuinely new
action id. A retry of an *uncertain* attempt is the opposite case and
deliberately reuses its id.

### Prerequisite: an appropriate demo policy

Recurring blocks require `agent-a` to be `budgeted` with a daily spend cap
below \$41. Set it through the normal operator policy UI. The generator will
not arrange this for itself — that is the whole point of the previous section.

### Cadence

| Setting                      | Default | Floor | Meaning                    |
| ---------------------------- | ------- | ----- | -------------------------- |
| `DEMO_GENERATOR_INTERVAL_MS` | 20000   | 1000  | ordinary fleet activity    |
| `DEMO_BLOCK_INTERVAL_MS`     | 180000  | 5000  | over-cap attempt cadence   |

Also settable as `--tick-interval` and `--block-interval`. The floors exist so
a typo cannot turn the demo generator into a load test against the plane.

A transient failure is survivable: the cycle is logged and the loop continues,
because a demo that dies forever after one 503 is worse than one that misses a
cycle. A rejected credential is different and is fatal — retrying against a key
the plane will never accept is noise, not resilience.

---

## Operating it

1. Sign in as an operator.
2. Configure the demo workspace's policy — `agent-a` budgeted, cap under \$41.
3. Issue a workspace API key for the generator.
4. Toggle **Public demo** on. Copy the URL.
5. Run the generator with that key.
6. To take it down: toggle off. The URL is dead on the next request, and a new
   one will be issued if you ever turn it back on.

---

## Verification status

AC-19 is **IMPLEMENTED**; acceptance is **BLOCKED pending staging**.

Proven locally, against compiled artifacts:

- The compiled API answers the public demo routes over a real TCP socket,
  including every failure path, with no unhandled error.
- The compiled generator, run unbounded against a fake plane that enforces
  precheck idempotency exactly as the real one does, produced four over-cap
  attempts with **four distinct action ids** and **four distinct plane-written
  blocks**, with zero idempotent replays.
- Seven mutation probes were applied and reverted; each was caught.

Not proven, and not claimed:

- No PostgreSQL execution. `packages/db/tests/demo.live.test.ts` is written and
  gates on `TEST_DATABASE_URL`; without one it **skips**, and skipping is not
  proof. It never falls back to `DATABASE_URL`.
- No staging deployment, so no criterion is marked PASS.
