# Authentication

Status: **Step 5 — implemented, staging verification blocked.**

Design rationale, alternatives and risks live in
[ADR 0002](adr/0002-authentication.md). This document is the operational
reference.

> **Authentication proves identity. It authorizes no workspace.**
>
> ```text
> Authenticated user -> membership resolver -> authorized workspace -> WorkspaceScope
> ```
>
> The middle two steps are **Step 6**. Nothing in Step 5 can construct a
> `WorkspaceScope`.

---

## Flow

```text
1. POST /v1/auth/magic-link  { email }
        -> identity found or created
        -> 256-bit token generated, SHA-256 stored, 15-minute expiry
        -> Resend delivers <APP_URL>/v1/auth/callback?token=<plaintext>
        -> 200 { ok: true }            (identical for every valid address)

2. GET /v1/auth/callback?token=...
        -> atomic single-use redeem + session creation, one transaction
        -> Set-Cookie: hybrid_auth_session=<256-bit token>; HttpOnly; SameSite=Lax
        -> 302 to <APP_URL>/?auth=success        (token stripped)

3. GET /v1/auth/me            -> 200 { user: { id, email } }  |  401

4. POST /v1/auth/logout       -> session revoked server-side, cookie cleared
```

## Endpoints

| Method | Path | Auth | Behaviour |
| --- | --- | --- | --- |
| POST | `/v1/auth/magic-link` | none | `200 {ok:true}` for any valid address; `400` only for a malformed one; `503` if auth is unconfigured |
| GET | `/v1/auth/callback` | none | `302` to `?auth=success` or `?auth=invalid_link`; sets cookie on success |
| GET | `/v1/auth/me` | cookie | `200 {user:{id,email}}` or `401` |
| POST | `/v1/auth/logout` | cookie | `200 {ok:true}` always; revokes server-side |

`/healthz` and `/readyz` are unaffected by authentication and remain
independent of email and database configuration.

## Parameters

| Setting | Value |
| --- | --- |
| Token entropy | 32 bytes (256 bits), base64url, 43 characters |
| Token at rest | SHA-256 hex digest only |
| Magic-link lifetime | 15 minutes |
| Session lifetime | 14 days |
| Issuance cooldown | 60 seconds per email address |
| Cookie name | `hybrid_auth_session` |

## Configuration

| Variable | Required for | Notes |
| --- | --- | --- |
| `DATABASE_URL` | all auth | Without it the auth routes return `503` |
| `APP_URL` | all auth | Absolute origin. No localhost fallback in production |
| `RESEND_API_KEY` | sending email | **Secret.** Never logged or returned |
| `AUTH_FROM_EMAIL` | sending email | Must be a Resend-verified sender |
| `WEB_ORIGIN` | cross-origin only | Leave unset for the same-site deployment |

If any is missing the service is simply absent, the auth routes answer `503`,
and the process still starts — liveness never depends on a feature's
configuration.

## Deployment: cookies, CORS and origins

**Same-site is the intended architecture.** The browser app and the API should
share one origin, so `SameSite=Lax` works, no CORS is involved, and no
credentialed cross-origin exception is needed.

- **Development:** the Vite dev server proxies `/v1/*` to
  `http://127.0.0.1:3000`, so the browser sees a single origin
  (`localhost:5173`). `Secure` is omitted because localhost has no HTTPS —
  setting it would silently break the cookie.
- **Staging / production on Render:** serve the web app and the API under one
  hostname (a path rewrite in front of both). Set `NODE_ENV=production` so the
  cookie is issued `Secure`. HTTPS is required.

**If a split-origin deployment is ever chosen instead**, it needs all of:

- `WEB_ORIGIN` set to the exact browser origin — never `*`, which browsers
  reject alongside credentials anyway;
- `credentials: 'include'` on the client (already the case);
- `SameSite=None; Secure` on the cookie, which **weakens the CSRF posture** and
  makes the CSRF work in ADR 0002 mandatory rather than deferred.

That trade is why same-site is preferred.

## Security properties

- Plaintext tokens are never persisted — only SHA-256 digests.
- Tokens never appear in a redirect URL, browser history, `Referer`, or any log.
- Redemption is a single atomic conditional `UPDATE`; two concurrent callbacks
  cannot both succeed.
- Logout revokes server-side, so a retained cookie stops working immediately.
- Responses never reveal whether an account exists.
- No open redirect: the callback destination comes only from `APP_URL`; there is
  no `returnTo` parameter.
- Provider and SQL errors are never surfaced to clients.

## Testing

| Suite | Command | Requires |
| --- | --- | --- |
| Unit + HTTP auth | `pnpm test` | nothing |
| Live PostgreSQL auth, incl. concurrency race | `pnpm test:db` | `TEST_DATABASE_URL` |

The default suite uses an in-memory store and a capturing mailer, so no email is
sent and no database is needed. **The in-memory store is single-threaded and
cannot prove PostgreSQL concurrency** — that is what the live race test is for,
and it is currently skipped.

No test sends real email. There is no "console email provider": the capturing
mailer keeps links in process, so a bearer token cannot reach CI logs.

## Known limitations

- **Rate limiting is partial.** The 60-second cooldown is database-backed and
  therefore multi-instance safe, but it is keyed on email address only. A
  distributed attacker rotating addresses is not throttled. A shared limiter
  (Redis, or a database counter keyed by IP) is required before public exposure.
  This is not solved.
- **No scheduled cleanup.** Expired magic links and revoked sessions accumulate.
  Suggested policy: purge consumed/expired links after ~30 days and
  revoked/expired sessions after ~90 days. Not implemented in Step 5.
## CSRF protection (added in Step 6)

The Step 5 review was deferred with an explicit trigger; `POST /v1/workspaces`
was the first authenticated browser mutation, so the work was done in Step 6.

Two independent layers protect every state-changing `/v1/*` request:

1. **`SameSite=Lax`** — browsers withhold the session cookie from cross-site
   POST/PUT/PATCH/DELETE, so a forged request arrives unauthenticated.
2. **An origin guard** — does not depend on the browser honouring SameSite, and
   also covers same-site-but-different-origin cases Lax permits (Lax is
   site-scoped; the guard is origin-scoped, so a sibling subdomain is rejected).

The rule:

| Condition | Outcome |
| --- | --- |
| `Origin` present and allowlisted | allowed |
| `Origin` present, not allowlisted | **403 `forbidden_origin`** |
| `Origin` absent **and** auth cookie present | **403** |
| `Origin` absent, no cookie | allowed |

The last row keeps non-browser clients working: `curl` and the simulator send no
`Origin`, present no cookie, and from Step 7 will authenticate with an explicit
header that browsers never attach automatically — so they are not forgeable this
way.

Safe methods are never blocked, so uptime probes and the emailed sign-in link
keep working. The allowlist comes from `APP_URL` plus `WEB_ORIGIN` when set; an
empty allowlist rejects every cookie-authenticated mutation, which is the safe
direction for a misconfigured deployment. The 403 body never echoes the offending
origin or the allowlist.

**A CSRF token framework is still not needed** — but becomes mandatory if a
split-origin deployment ever forces `SameSite=None`.
