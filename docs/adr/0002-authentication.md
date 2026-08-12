# ADR 0002 — Magic-Link Authentication

- **Status:** Accepted
- **Date:** 2026-08-12
- **Phase:** Credit — Step 5
- **Targets:** AC-01 (magic-link sign-in)

---

## Problem

Operators need to sign in. The platform is a governance control plane, so the
sign-in path must not become the weakest link in it, and it must not quietly
grant tenant access.

Two failures to design against:

1. **Credential handling.** A passwordless flow moves the secret into email and
   a cookie. Storing either in a replayable form, leaking one into a log or a
   URL, or letting one be reused would be a full account takeover.
2. **Boundary erosion.** The obvious shortcut is to treat "logged in" as
   "authorized for a workspace". That collapses [ADR 0001](0001-workspace-isolation.md)
   and makes cross-tenant access one careless line away.

---

## Decision

**Passwordless magic-link sign-in, with authentication strictly separated from
workspace authorization.**

```text
Browser -> Auth routes -> Auth service -> AuthStore -> PostgreSQL
                              |
                              +-> AuthEmailSender (Resend | capturing)
```

### Identity model

Requesting a link for an unknown address **creates the identity**. There is no
separate registration step.

This is not only simpler; it is what allows the endpoint to answer identically
for every address. A "register first" path would itself be an account-existence
oracle, since the two flows would have to differ observably.

Creating an identity grants nothing. A user with no membership can reach no
workspace.

### Token handling

| Property | Choice |
| --- | --- |
| Entropy | 32 bytes (256 bits) from `crypto.randomBytes`, base64url → 43 chars |
| At rest | SHA-256 hex digest only. Plaintext exists in the email URL and the cookie, never in the database |
| Magic-link lifetime | **15 minutes** |
| Session lifetime | **14 days** |
| Reuse | Single-use, enforced by an atomic conditional `UPDATE` |
| Issuance cooldown | **60 seconds** per address, enforced in the database |

**Why SHA-256 rather than bcrypt/argon2.** Password hashes exist to slow brute
force against low-entropy human secrets. These are 256-bit CSPRNG values: there
is no dictionary to try, so a work factor would add latency per request while
defending against nothing. A fast hash also permits the indexed equality lookup
the design needs, which a per-row-salted hash cannot. What SHA-256 does give —
and what matters — is one-wayness, so a database disclosure yields digests that
cannot be replayed.

### Single-use under concurrency

Redemption is **one statement**:

```sql
UPDATE auth_magic_links
   SET consumed_at = $now
 WHERE token_hash  = $hash
   AND consumed_at IS NULL
   AND expires_at  > $now
RETURNING id, user_id, email
```

There is deliberately no `SELECT` followed by a later `UPDATE`; that has a
read-modify-write window in which two callbacks both observe an unconsumed
token.

With two concurrent callbacks, PostgreSQL serialises on the row lock. Under
READ COMMITTED the second `UPDATE` blocks until the first commits, then
re-evaluates its `WHERE` against the newly committed row version (EvalPlanQual),
sees `consumed_at IS NOT NULL`, and matches zero rows. Exactly one caller gets a
row, so exactly one session is created. Expiry is evaluated in the same
statement against the same `$now`, so a token cannot expire between check and
update.

Redemption and session creation share one transaction, so a failure between them
cannot burn a token without issuing a session.

### Session and cookie

`HttpOnly` (unreadable by JavaScript, so XSS cannot exfiltrate it),
`Secure` in production, `SameSite=Lax`, `Path=/`, explicit `Max-Age` matching
server-side expiry. The token is never placed in `localStorage` or
`sessionStorage` — both are script-readable.

**Logout revokes server-side.** Clearing the cookie alone is a UI gesture; a
copy taken beforehand would keep working until expiry.

### CSRF

`SameSite=Lax` is the defence: browsers withhold the cookie from cross-site
`POST`/`PUT`/`DELETE`, so a third-party page cannot drive a mutating request as
the user. Lax still sends it on top-level `GET` navigation, which is exactly what
following an emailed link needs.

Logout is `POST` for this reason — a `GET` logout is reachable by navigation,
prefetchers and link scanners.

No CSRF token framework is introduced: with Lax cookies and no cross-site
mutating routes, it would add machinery without closing a gap. **When Step 6+
adds operator mutations, this must be revisited** — specifically if any route is
ever made reachable cross-origin, or if `SameSite=None` is ever required for a
split-origin deployment. At that point double-submit tokens or an origin check
become mandatory.

### Anti-enumeration

`POST /v1/auth/magic-link` returns `{ ok: true }` for a known address, an
unknown address, an address inside its cooldown, **and when email delivery
fails**. That last case matters: a 500 on delivery failure would differ between
addresses that do and do not trigger a send.

Only a malformed address is rejected (400) — a fact about the input, not about
any account.

The callback collapses malformed, unknown, expired and already-used into one
`auth=invalid_link` outcome.

### Token leakage

The API — not the browser app — handles the callback, then redirects to a clean
URL. The token never reaches the browser's address bar, history, or an onward
`Referer`. Nothing logs a token or a full magic-link URL. The web app strips the
outcome marker with `replaceState` so even that does not persist.

---

## Alternatives considered

**Passwords.** Rejected: credential storage, reset flows, breach reuse, and
strength policy — all avoided entirely by not having a password. The locked
requirements specify magic links.

**JWT / stateless sessions.** Rejected. A signed token cannot be revoked before
expiry without a denylist, which reintroduces the state it was meant to avoid.
For a governance product, "sign out actually signs out" is worth a database read
per request.

**Storing a session token in `localStorage`.** Rejected: script-readable, so any
XSS is a full account compromise. `HttpOnly` removes that class of attack.

**Separate registration flow.** Rejected — it is an enumeration oracle by
construction (see above).

**bcrypt/argon2 for tokens.** Rejected — wrong tool for high-entropy secrets,
and incompatible with indexed lookup.

**A CSRF token framework now.** Deferred, with an explicit trigger for
revisiting (above).

**Redis-backed rate limiting.** Not available and not invented. See Risks.

---

## Trade-offs

**Accepted costs**

- A database round trip per authenticated request to resolve the session. Bought
  deliberately, in exchange for real revocation.
- Email is now on the critical path of sign-in; a Resend outage blocks new
  sign-ins (existing sessions are unaffected).
- Magic links are only as secure as the recipient's inbox. Inherent to the
  model; mitigated by the 15-minute lifetime and single use.
- The issuance cooldown is per address, so a distributed attacker rotating
  addresses is not throttled by it.

**Gained**

- No password to store, leak, reset or reuse.
- Revocation is real and immediate.
- No bearer credential is recoverable from a database disclosure.
- Identity and tenancy stay separable, preserving ADR 0001.

---

## Risks

| Risk | Mitigation |
| --- | --- |
| Multi-instance rate limiting is incomplete | The cooldown is database-backed so it holds across instances, but it is per address only. A shared limiter (Redis or a database counter keyed by IP) is still needed before public exposure. **Not solved; documented.** |
| Concurrency proof is unexecuted | The race test exists and requires `TEST_DATABASE_URL`. The in-memory suite is single-threaded and cannot prove PostgreSQL behaviour. Currently **SKIPPED** |
| A future route accepts `workspace_id` from the caller | Documented boundary below; ESLint blocks raw DB access from apps; Step 6 must route through a membership resolver |
| Session table growth | Expired and revoked rows are retained for audit. A cleanup policy is documented but not implemented |
| Email provider compromise or inbox access | Short lifetime, single use. Inherent to passwordless |

---

## The workspace authorization boundary

**Authentication proves identity. It authorizes no workspace.**

`AuthenticatedUser` carries exactly `userId`, `email`, `authSessionId` — no
workspace, membership, role or permission. There is nothing in it from which a
`WorkspaceScope` could be built, and a test asserts those three keys and no
others.

The intended chain, which **Step 6 implements**:

```text
Authenticated user
   -> membership resolver (findMembership: is this workspace one of THIS user's?)
   -> authorized workspace
   -> createWorkspaceScope(...)
```

Forbidden, permanently:

```ts
createWorkspaceScope(req.body.workspace_id)    // caller-selected tenant
createWorkspaceScope(req.query.workspace_id)   // caller-selected tenant
```

A workspace id in a request is an *argument*, never authorization. It is
acceptable only after `findMembership` proves it belongs to the authenticated
user.

---

## Migration strategy

New tables only — `auth_magic_links` and `auth_sessions` — in their own
migration `0001`. The Step 3 migration `0000` is untouched, since rewriting an
applied migration is unsafe.

Both are global (no `workspace_id`) and cascade from `users`, because they are
ephemeral credentials rather than tenant audit history. No existing table,
constraint or row is modified, so there is nothing to roll back beyond dropping
the two tables.

**Cleanup policy (documented, not implemented):** consumed and expired magic
links may be purged after ~30 days; revoked and expired sessions after ~90 days
for audit. Deliberately not a scheduled worker in Step 5 — row volume is
negligible until there are users, and an unnecessary background job is
operational surface.

---

## Acceptance criteria

Step 5 architecture is accepted when:

1. Magic-link tokens are ≥256-bit CSPRNG and stored only as hashes. ✅
2. Session tokens are ≥256-bit CSPRNG and stored only as hashes. ✅
3. A token cannot be redeemed twice. ✅ (unit + HTTP; **live race SKIPPED**)
4. An expired token cannot be redeemed and creates no session. ✅
5. Sessions expire, can be revoked, and logout revokes server-side. ✅
6. The session cookie is HttpOnly, SameSite=Lax, Secure in production. ✅
7. Responses reveal no account existence, token, hash or internal error. ✅
8. The token never appears in a redirect URL, browser history or a log. ✅
9. No open redirect exists. ✅ (no `returnTo`; destination from APP_URL only)
10. `/healthz` stays 200 regardless of database or email configuration. ✅
11. Authentication constructs no `WorkspaceScope`. ✅
12. Real PostgreSQL concurrency is proven. ❌ **BLOCKED** — no test database.
13. Real email delivery is proven. ❌ **BLOCKED** — no client Resend credential.

Items 12 and 13 are blocked on client-owned resources, not on implementation.
