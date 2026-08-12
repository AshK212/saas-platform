# API Authentication

Status: **Step 7 — implemented, staging verification blocked.**

The platform has **two independent authentication domains**. They are never
interchangeable, and tests assert both directions of that separation.

```text
OPERATOR (browser)                    AGENT (machine)
────────────────────                  ────────────────────
Session cookie                        Authorization: Bearer <key>
   -> AuthenticatedUser                  -> credential row
   -> membership (SQL)                   -> credential.workspace_id
   -> AuthorizedWorkspace                -> WorkspaceScope
   -> WorkspaceScope
```

> **The caller never selects the workspace for an API-key-authenticated
> request.** It is derived from `api_credentials.workspace_id` on the matched
> row. A `workspace_id` in a body, query string, header or path is ignored.

> **Plaintext API keys are not recoverable.** They are shown once at issuance
> and only a hash is stored. A lost key must be revoked and replaced.

---

## Key format

```text
hmp_live_<keyId>_<secret>
```

| Segment | Size | Secret? |
| --- | --- | --- |
| `hmp` | product marker | no |
| `live` | environment/version marker | no |
| `keyId` | 12 base64url chars (9 bytes, 72 bits) | **no** — stored as `key_prefix` |
| `secret` | 43 base64url chars (32 bytes, **256 bits**) | **yes** |

Total 65 characters. Both halves come from `crypto.randomBytes`.

**The public id is independent random material**, not a slice of the secret.
The common alternative — publishing the first N characters of the secret as the
lookup prefix — would expose part of it. Here `key_prefix` reveals nothing and
the secret keeps its full 256 bits.

**Parsed by fixed offsets, not by splitting on `_`.** base64url's alphabet
includes `_`, so a split-based parser fails intermittently depending on the
bytes drawn. Every segment is fixed-width, so slicing is exact.

### Hashing

```text
secret_hash = SHA-256(full key string), hex
```

The digest covers the **full key**, so prefix and secret are cryptographically
bound rather than merely stored side by side.

SHA-256 rather than bcrypt/argon2 for the same reason as session tokens: work
factors exist to slow brute force against low-entropy human secrets. Against
256-bit CSPRNG output there is no dictionary to try, so a work factor would add
per-request latency while defending against nothing — and would prevent the
indexed equality lookup authentication needs. One-wayness is the property that
matters, and SHA-256 provides it.

### Lookup

```sql
WHERE key_prefix = $1 AND secret_hash = $2 AND revoked_at IS NULL
```

One indexed read. **The prefix is an identifier, never authority** — a correct
prefix with a wrong digest does not authenticate.

---

## Credential management (operator only)

| Method | Path | Requires |
| --- | --- | --- |
| POST | `/v1/workspaces/:workspaceId/api-keys` | session + membership + **operator** + allowed `Origin` |
| GET | `/v1/workspaces/:workspaceId/api-keys` | session + membership + **operator** |
| POST | `/v1/workspaces/:workspaceId/api-keys/:credentialId/revoke` | session + membership + **operator** + allowed `Origin` |

- A **`member`** receives `403 insufficient_role`. They are a proven member, so
  403 reveals nothing new.
- A **non-member** receives `404 not_found`, matching Step 6 — 403 would confirm
  the workspace exists and enable tenant enumeration.
- Issuance and revocation are cookie-authenticated browser mutations, so they
  pass the Step 6 origin guard.
- **API keys cannot manage API keys.** Management handlers read only the session
  cookie; a bearer key gets `401`.

### Show-once

Plaintext exists in exactly three places, all transient:

1. server memory during the issuance request;
2. the issuance response body;
3. transient React state in the browser, until dismissed or reloaded.

It is never persisted, never logged, and appears in exactly one contract
(`issuedApiKeySchema`) — asserted by a guardrail test. There is no retrieval
endpoint and no recovery path.

### Revocation

Sets `revoked_at`; the row is **never deleted** because it is audit history.
`revoked_at IS NULL` is part of the authentication query, so a revoked key stops
working immediately — no cache, no grace window. Revocation is idempotent and
preserves the original timestamp.

---

## Agent authentication

```http
Authorization: Bearer hmp_live_...
```

**Bearer header only.** Keys are never accepted from a query string, URL path or
request body — those land in access logs, browser history, proxy logs and
`Referer` headers. The scheme is matched case-insensitively per RFC 7235.

Every failure — missing header, wrong scheme, malformed key, unknown key,
revoked key — returns one identical `401 {"error":"unauthorized"}`. Nothing
distinguishes them, so a credential cannot be enumerated or probed.

`last_used_at` is best-effort telemetry: a failed write never denies a caller
with a valid credential.

### `POST /v1/agents/register` (Step 8)

Machine registration and discovery. Bearer key only — a session cookie is
rejected.

```jsonc
// request                          // response
{ "agent_id": "agent-a",            { "agent": { "agent_id": "agent-a",
  "name": "Agent A" }                            "name": "Agent A",
                                                 "last_seen_at": "…" } }
```

The request schema has **no `workspace_id`** and **no `last_seen_at`**: the
workspace comes from the credential row, and last-seen is server time. Anything
extra a caller sends is discarded by the schema.

Idempotent — `INSERT … ON CONFLICT (workspace_id, external_id) DO UPDATE`. The
same `agent_id` always resolves the same agent within a workspace, and is an
entirely separate agent in another.

**Field ownership.** A machine caller may set only `last_seen_at`, `updated_at`
and its self-reported `name`. It cannot touch `workspace_id`,
`runtime_profile_id`, policy, caps, mode or pause state — and no route exists
through which it could.

### `GET /v1/api-key/me`

A **foundational probe**, not a product surface. It exists so the bearer
boundary can be demonstrated end to end before any agent or event route exists.
Returns `{ authenticated: true, workspaceId }` and nothing else — no user, no
tenant data, no secret.

---

## What API keys may never do

**API-key callers must never gain policy-mutation authority.** Policy changes
happen only through authenticated operator flows:

```text
AuthenticatedUser -> membership -> WorkspaceScope -> policy service
```

An API key is not a human and carries no membership or role. Later steps may let
key-authenticated callers register agents, ingest events, read policy and run
prechecks — but **never** write policy. Neither may a share link or the public
demo. Any future route blurring that line is a defect.

There are also deliberately **no per-key scopes, permissions or expiry**. Every
key is simply workspace-bound; a partially-enforced capability field would be
worse than none.

---

## Testing

| Suite | Command | Requires |
| --- | --- | --- |
| Tokens, issuance, revocation, bearer auth | `pnpm test` | nothing |
| Live credential persistence + UNIQUE constraints | `pnpm test:db` | `TEST_DATABASE_URL` |

The live suite writes data, is gated on `TEST_DATABASE_URL`, **never** falls back
to `DATABASE_URL`, and rolls every transaction back.
