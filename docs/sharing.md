# Revocable Read-Only Sharing (AC-18)

> **A share token is a bearer credential granting READ-ONLY access to exactly
> ONE workspace.**
>
> It is not a user, not a membership and not an API key. It carries no role and
> authorizes no mutation of any kind — not by policy, but by construction: the
> type it produces has no field a route could inspect to decide otherwise.

> **Revocation is immediate.** Every read re-resolves the token against the
> database, including `revoked_at IS NULL`. There is no cache, no grace window
> and no derived session that could outlive the link.

Sources: [`packages/contracts/src/share.ts`](../packages/contracts/src/share.ts) ·
[`apps/api/src/share/`](../apps/api/src/share/) ·
[`apps/api/src/routes/share-management.ts`](../apps/api/src/routes/share-management.ts) ·
[`apps/api/src/routes/share-public.ts`](../apps/api/src/routes/share-public.ts) ·
[`apps/web/src/SharedView.tsx`](../apps/web/src/SharedView.tsx)

---

## Three read authorities

The plane now has three ways to prove a right to read one workspace. All three
end in a `WorkspaceScope`; they differ in what else they carry.

| | Proof chain | Also carries |
| --- | --- | --- |
| **Operator** | session → user → membership → scope | user, role |
| **Machine** | bearer API key → credential row → scope | credential id |
| **Share** | share token → share row → scope | *nothing* |

That "nothing" is the security property. `ReadOnlyShareContext` has no user, no
role and no permission set, so a share cannot become writable without changing
its type.

It is deliberately **not** an `AuthorizedWorkspace` — that type carries a
membership role, and manufacturing one would hand a viewer a synthetic identity
that some later route might trust.

## Token format

```
hmp_share_<shareId>_<secret>
```

| Part | Bytes | Bits | Public? |
| --- | --- | --- | --- |
| `hmp_share` | — | — | namespace marker |
| `shareId` | 9 → 12 base64url chars | 72 | **public** — stored as `token_prefix` |
| `secret` | 32 → 43 base64url chars | **256** | secret |

The public id is **independent random material**, not a slice of the secret.
The alternative — storing the first N characters of the secret as the lookup
prefix — publishes part of it. Here the prefix an operator sees in the
management list reveals nothing, and the secret keeps all 256 bits.

256 bits is also what makes this safe to hand out as an unauthenticated link:
there is nothing to guess, and no rate limit could matter at that size.

The `share` marker means a share token can never be mistaken for an API key —
`parseApiKey` rejects it on the namespace before anything else.

## Hash at rest

`token_hash = SHA-256(full token)`, hex. The digest covers the **full** token,
prefix included, so the two halves are cryptographically bound rather than
merely stored side by side.

SHA-256 rather than bcrypt/argon2 for the same reason as sessions and API keys:
a work factor defends low-entropy human secrets against dictionaries. Against
256-bit CSPRNG output there is no dictionary, so it would add latency for
nothing and would prevent the indexed equality lookup resolution needs. What
SHA-256 provides, and what matters, is one-wayness.

**The table has no column capable of holding a plaintext token**, and the
repository's `insert` takes an already-computed prefix and digest — so a leak
from that layer is impossible by signature, not by discipline.

## Show once

Issuance returns the plaintext in that one response and never again.

There is no recovery endpoint, and none can be added: the server kept only a
digest and genuinely cannot reproduce the token. A lost link is **revoked and
reissued**, which is cheap; a recoverable secret is not.

The management list returns `id`, `tokenPrefix`, `createdAt` and `revokedAt`.
The public URL is built **only** at issuance, from the fresh plaintext.

## Operator management

```http
POST /v1/workspaces/:workspaceId/share-links              → 201 { shareLink, token }
GET  /v1/workspaces/:workspaceId/share-links              → 200 { shareLinks }
POST /v1/workspaces/:workspaceId/share-links/:id/revoke   → 200 { shareLinks: [one] }
```

**Operator only.** A member may already read everything in the workspace, so
this is not about withholding data from them. Issuing a share link creates a
durable, external, unauthenticated door on behalf of everyone in the tenant,
and it survives the person who made it. Same reasoning as API-key issuance.

Both mutations are cookie-authenticated, so the Step 6 origin guard applies: a
foreign origin can neither mint nor revoke a link.

**Revocation is idempotent** and keeps the **first** instant — a second revoke
must not overwrite when the withdrawal actually happened. The row is retained,
never deleted, so an operator investigating an exposure can see that a link
existed and was withdrawn.

## The public surface

```http
POST /v1/share/access        { token }   → sets an HttpOnly cookie
GET  /v1/share/workspace
GET  /v1/share/agents
GET  /v1/share/events[?agent_id&limit&cursor]
GET  /v1/share/events/:eventId
GET  /v1/share/receipts
GET  /v1/share/blocks
```

### Why an exchange, and not a token in every path

The obvious design is `/v1/share/:token/events`. It is simpler and stateless —
and it writes a live bearer credential into every access log line, proxy log,
browser history entry and outbound `Referer` header, for the whole life of the
session. A share link is meant to be pasted into a chat or an email; it will
end up somewhere it was not meant to be, and multiplying its exposure by the
number of requests is the wrong default.

With the exchange, the token appears in **exactly one** request body. Cookies
are not written to access logs and are not sent as `Referer`.

### What is in the cookie

**The same share token, and deliberately nothing else.**

The tempting design is a signed session carrying the share id. That would be a
*second, independent* credential — and a second credential can outlive the
first. A viewer still reading after the operator revoked the link is precisely
the failure this criterion exists to prevent.

Because the cookie holds the original token, every read re-resolves it. There
is nothing to invalidate separately: revocation is authoritative by
construction rather than by remembering to propagate it.

| Attribute | Value | Why |
| --- | --- | --- |
| `HttpOnly` | ✅ | script cannot read it, so XSS cannot exfiltrate the link |
| `Secure` | production | never sent over plaintext HTTP |
| `SameSite` | `Lax` | GET-only surface; keeps a pasted link working when followed |
| `Path` | `/v1/share` | the browser never offers it to an operator route |
| `Max-Age` | 8 hours | convenience, **not** the security control |

**Never** `localStorage`, `sessionStorage` or `IndexedDB` — all readable by any
script on the page.

### Error semantics

Unknown, malformed, revoked and belonging-to-another-workspace all return
**exactly** `404 {"error":"invalid_share"}`. Distinguishing them would let the
holder of a dead link learn whether it once existed, and would let anyone probe
for live prefixes. Operator management may show revoked state, because the
operator is already authorized to know.

## Reuse, not copy

The share routes call the **same read stores** the operator routes call, and
present rows through the **same mappers** (`apps/api/src/read-models.ts`).

To make that possible, the read stores were changed to take a `WorkspaceScope`
rather than an `AuthorizedWorkspace`. A scoped read has no business knowing how
the scope was proven, and the previous signature would have forced the share
path to fabricate a membership.

Nothing about policy defaults, ledger reads, timeline ordering, receipt
presentation or block ownership is reimplemented. A parallel set would drift,
and a shared view slowly describing a different system than the operator sees
is worse than no shared view — both look authoritative.

## What a share can never do

- Mutate policy, API keys, share links, workspaces, agents, events or prechecks
- Move `last_seen_at`, the ledger, a policy version, a receipt or a block
- Read another workspace, with any id, filter or cursor
- See an API key, a digest, a session, or its own token echoed back
- Reach an operator route — the cookie is not even sent to one

Viewing is not activity. Every read store on this path is write-free, and a
live test asserts the database is byte-identical after repeated shared reads.

## Rate limiting — a production concern

A public bearer link is abuse-sensitive. What exists today:

- a 256-bit unguessable token, so enumeration is not a threat;
- bounded pagination on every list (default 50, max 100);
- GET-only, body-less reads with no expensive aggregate.

What does **not** exist is distributed request-rate limiting. That belongs in
shared edge middleware and is recorded as a **production deployment concern**,
not something invented per-route here. It is not claimed as implemented.

---

# AC-18 acceptance walkthrough

Steps marked **operator** happen in the web app; **viewer** steps happen in a
private window.

| # | Who | Action | Expected |
| --- | --- | --- | --- |
| 1 | operator | Sign in, open a workspace | — |
| 2 | operator | Share links → **Create share link** | URL shown **once**, with a copy warning |
| 3 | — | Inspect `share_tokens` (staging) | digest and prefix only; **no plaintext** |
| 4 | viewer | Paste the URL into a **private window** | Workspace loads |
| 5 | viewer | — | **No sign-in prompt** |
| 6 | viewer | — | Fleet, governance, timeline, event JSON visible |
| 7 | viewer | Look for edit controls | **None** — no policy editor, no keys, no share management, no sign-out |
| 8 | viewer | Attempt a mutation (devtools) | Refused |
| 9 | operator | **Revoke** the link | Row shows `Revoked <time>` |
| 10 | viewer | **Refresh** | "This shared link is not available" |
| 11 | viewer | Re-paste the original URL | Same failure — the plaintext buys nothing |

## Verification status

| | |
| --- | --- |
| Route + behaviour tests | `apps/api/tests/share-routes.test.ts` — 51 |
| Architecture guards | `apps/api/tests/share-boundary.test.ts` — 47 |
| **Live PostgreSQL** | `packages/db/tests/sharing.live.test.ts` — **10, SKIPPED** |

The live suite is gated on `TEST_DATABASE_URL` and **never falls back to
`DATABASE_URL`**. It has never run: no authorized database exists. Steps 3 and
the cross-tenant claims above are therefore **argued and tested-but-unrun**
against real PostgreSQL.

**AC-18 is `IMPLEMENTED / STAGING VERIFICATION BLOCKED`, not PASS.**
