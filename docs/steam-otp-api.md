# Steam Guard (OTP) API — Field Desk side

For the e-mail automation (Astra's worker and its n8n workflows). Field Desk keeps the newest Steam Guard code of each Steam
account, shows it to HQ and to the store teams that hold the account, and can be asked by a store team to look for a code
(the request webhook). This page is the contract; the code is `server/steam-otp.ts` and the `/api/v1/steam/*` part of
`server/api.ts`; `tests/server-steam-otp.test.ts` exercises every row of the tables below.

## Settings (environment, configured privately on the server)

| Variable | Meaning |
|---|---|
| `FD_STEAM_API_KEY` | Bearer token of the automation. Unset or blank: both API routes answer `503 not_configured`. Use a long random value (`openssl rand -base64 32`). |
| `FD_STEAM_WEBHOOK_URL` | Where a store team's "Request code" is sent (`http` or `https`). |
| `FD_STEAM_WEBHOOK_SECRET` | Secret that signs every webhook request. |

The webhook is on only when **both** webhook settings are set (a half-configured pair is logged as a warning and treated as
off). Then, and only then, store teams see the Request code button. With `deploy/docker-compose.yml` the three variables
come from `deploy/.env` (see `deploy/.env.example`; empty values mean off). There is no UI for any of this.

## The key and its scopes

`FD_STEAM_API_KEY` is sent as `Authorization: Bearer <key>` and is compared in constant time.

* It is the **only** credential accepted on `/api/v1/steam/*`. HQ, admin and store-team sessions (cookies) are refused there
  with `401`, whether or not a key rides along.
* It is accepted **nowhere else**: on every other route it is just an unknown header (no session, so `401`), and it cannot
  sign in.
* Its scopes are fixed and exact — nothing can be added or removed:

| Scope | Allows |
|---|---|
| `steam-accounts:read` | `GET /api/v1/steam/accounts` |
| `steam-otp:write` | `POST /api/v1/steam/otp` |

## Errors

Every error body from these routes is `{ "error": "<snake_case_code>", "message": "<short human text>" }`. The message never
repeats the code, the key, the `Authorization` header or any part of the request body. Success bodies are shown below.
All responses carry `Cache-Control: no-store`.

## `GET /api/v1/steam/accounts`

Scope `steam-accounts:read`. A **bare JSON array**, one record per Steam account (accounts without a username are skipped),
sorted by username. There is never a code in it.

```json
[
  {
    "accountUsername": "store_alpha",
    "accountEmail": "login-alpha@example.invalid",
    "username": "store_alpha",
    "email": "login-alpha@example.invalid",
    "assignedStoreId": "s1",
    "assignedStoreName": "Store Alpha",
    "active": true,
    "receivedAt": "2026-10-24T06:00:00.000Z",
    "expiresAt": "2026-10-24T06:10:00.000Z"
  },
  {
    "accountUsername": "store_gamma", "accountEmail": null, "username": "store_gamma", "email": null,
    "assignedStoreId": null, "assignedStoreName": null, "active": false, "receivedAt": null, "expiresAt": null
  }
]
```

* `username` / `email` repeat `accountUsername` / `accountEmail`: the mock server and the worker read those two names.
* `accountEmail` is the account's e-mail, `null` if HQ has not entered one.
* `assignedStoreId` / `assignedStoreName` — the store the account is working for **now**:
  1. the store that holds the account **for playing** in this weekend (the Saturday of today's Monday–Sunday week, in
     `EVENT_TZ`, default Asia/Kolkata); if two stores somehow play with it, `null` (ambiguous);
  2. else, if **exactly one** store holds it at all (any purpose) and that store's event day is not past, that store;
  3. else `null` (nobody, or more than one).
* `active`, `receivedAt`, `expiresAt` describe the current **unexpired** code: `active: true` with its two times, or
  `false` with both `null`. `receivedAt` is when Steam sent the e-mail; `expiresAt` is `receivedAt` + 10 minutes.

## `POST /api/v1/steam/otp`

Scope `steam-otp:write`. Hands over a Steam Guard code the automation read from an e-mail.

Headers: `Authorization: Bearer <key>`, `Content-Type: application/json`, and optionally `Idempotency-Key`
(`^[\x21-\x7e]{1,128}$`, e.g. `steam-email-<sha256>`). Body limit **16 KB**.

```json
{ "accountUsername": "store_alpha", "accountEmail": "login-alpha@example.invalid", "code": "AB3DE", "receivedAt": "2026-10-24T06:00:00.000Z" }
```

| Field | Rule |
|---|---|
| `accountUsername`, `accountEmail` | At least one, strings. Matched trimmed and case-insensitively. Both given must name the same account. An e-mail only matches accounts that have one. |
| `code` | `^[A-Z0-9]{5}$` |
| `receivedAt` | ISO 8601 with `Z` or an offset (`2026-10-24T06:00:00.000Z`), in the window **(now − 10 min, now + 30 s]** |

Success, `200`:

```json
{ "ok": true, "accountUsername": "store_alpha", "accountEmail": "login-alpha@example.invalid", "assignedStoreId": "s1",
  "receivedAt": "2026-10-24T06:00:00.000Z", "expiresAt": "2026-10-24T06:10:00.000Z" }
```

The answer never contains the code. `expiresAt` is always `receivedAt` + 10 minutes, never counted from when the request
arrives, and a repeat never extends it.

### Order the server decides things in

1. key (`503` / `401`), `Idempotency-Key` shape, body size and JSON, which account, the code's shape, `receivedAt` being a time;
2. **idempotency** (before the window, so a late retry of something already stored still gets its answer);
3. the time window, then whether a store holds the account, then ordering against the current code.

### Idempotency

* A fingerprint is **account username + code + `receivedAt` in milliseconds**.
* Same `Idempotency-Key`, same fingerprint → `200` with the stored result plus `"duplicate": true`, nothing written, even
  if the time window has closed or the assignment changed since.
* Same key, different fingerprint → `409 idempotency_key_reused`.
* Only successful (`200`) requests store their key. A refused request leaves the key free.
* Keys live in a server-only table in Field Desk's database (they survive restarts and are part of its backups). They hold
  a hash of the fingerprint and the answer sent — never the code — and are kept **48 hours** (the contract asks for at
  least 24) and then pruned.
* Without a key the ordering rules below still make a repeat safe.

### Ordering and expiry (against the account's current code)

| Situation | Result |
|---|---|
| `receivedAt` **older** than the current code's | `409 older_than_current`, nothing changes |
| **equal** `receivedAt`, **different** code | `409 conflicting_code`, nothing changes |
| **equal** `receivedAt`, **same** code | `200` with `"duplicate": true`; expiry is not extended |
| **newer** `receivedAt` | replaces the code; its expiry is its own `receivedAt` + 10 minutes |

### A store must hold the account

`409 not_assigned` when there is no current assignment by the rule under `GET` (nobody, several stores and none plays this
weekend, or the only holders' event days are past). The worker should treat this as "not yet", not as a fault of the email.

### Status and error codes

| Route | Status | `error` | When |
|---|---|---|---|
| both | 401 | `unauthorized` | no `Authorization`, not `Bearer`, or the wrong key (also a session cookie with no key) |
| both | 404 | `not_found` | any other path under `/api/v1/` |
| both | 405 | `method_not_allowed` | wrong method for the route (`Allow` header says which) |
| both | 503 | `not_configured` | `FD_STEAM_API_KEY` unset |
| both | 500 | `internal_error` | anything unexpected; generic, nothing about the request is included or logged |
| GET accounts | 200 | — | the array |
| POST otp | 200 | — | stored, or `"duplicate": true` (same key and payload; or same `receivedAt` and code) |
| POST otp | 400 | `invalid_body` | not a JSON object; `receivedAt` missing or not text; no `accountUsername` / `accountEmail`; either not text |
| POST otp | 400 | `unknown_account` | no account, or more than one, matches; username and e-mail disagree |
| POST otp | 400 | `invalid_code` | `code` missing or not 5 characters of `A–Z` / `0–9` |
| POST otp | 400 | `stale_or_future` | `receivedAt` not ISO with a zone, 10 minutes old or older, or more than 30 s ahead |
| POST otp | 400 | `invalid_idempotency_key` | `Idempotency-Key` present but not `^[\x21-\x7e]{1,128}$` |
| POST otp | 409 | `not_assigned` | no store holds the account right now |
| POST otp | 409 | `idempotency_key_reused` | same key, different username / code / `receivedAt` |
| POST otp | 409 | `older_than_current` | an older `receivedAt` than the stored code's |
| POST otp | 409 | `conflicting_code` | same `receivedAt` as the stored code, a different code |
| POST otp | 413 | `body_too_large` | body over 16 KB |

Note for the worker: it currently counts every non-2xx as "Field Desk unavailable" and retries until the e-mail expires.
That is safe for all of these, but the `400` and `409` rows are permanent for that payload (`not_assigned` can clear once HQ
assigns the account); only `5xx` is truly temporary.

## Who sees the code in Field Desk

The newest code is stored on the Steam account (`accounts` document, HQ-only) as
`otp: { code, receivedAt, expiresAt }`. It is written **only** by this endpoint: any batch from a client — HQ's included —
that adds, changes or removes it is refused (`403 protected`), and a restored backup keeps the server's current code.

* **HQ** sees it on the Steam accounts page with a countdown.
* The **store team and the named field admin of every store that currently holds the account** (any purpose, event day not
  past) get it in their store's `steamLogin.otp`, **only while unexpired** when the page is read (and the card hides it by
  its own clock). Other stores' teams and admins never receive it, nor does anyone get the account itself.
* A new code reaches HQ and those stores live over the existing event stream.

## Request webhook — `steam.otp.requested`

When a store team (or its admin, or HQ) presses **Request code** on the Steam card, Field Desk sends a signed event to
`FD_STEAM_WEBHOOK_URL`. It is a polling hint ("look for this account's e-mail now"), not a Steam login request.

The browser calls `POST /api/steam/otp-request` with `{ "storeId": "s1" }` (a normal session; the store's team or admin, or
HQ) and gets `{ "ok": true, "requestedAt": "<ISO>", "duplicate": false }`.

Payload (JSON, UTF-8):

```json
{
  "id": "6f1c3a0e-8a5b-4c5e-9d57-2b6f0f6a0c11",
  "type": "steam.otp.requested",
  "at": "2026-10-24T06:00:00.000Z",
  "storeId": "s1",
  "storeName": "Store Alpha",
  "accountUsername": "store_alpha",
  "accountEmail": "login-alpha@example.invalid"
}
```

`accountEmail` is left out when the account has none; `accountUsername` is always there. Nothing else is sent: no password,
no code.

**Signature.** The body is serialised once; the exact UTF-8 bytes sent are signed:
`X-FieldDesk-Signature: sha256=<lowercase hex HMAC-SHA256(FD_STEAM_WEBHOOK_SECRET, raw body)>`, with
`Content-Type: application/json`. Verify over the raw bytes before parsing.

**Delivery and retries.**

* One attempt has a **5 s** timeout.
* `2xx` ends delivery (the worker answers `202` accepted, `200` duplicate).
* A timeout, a network error or a `5xx` is retried after **5 s, 15 s, 45 s, then every 90 s**, with the **same `id` and the
  same bytes (and signature)**, until **10 minutes after `at`**; then Field Desk gives up.
* Any other answer (`4xx`, a redirect) is final: no retry.
* Pending requests are kept **in memory only**. A restart forgets them — acceptable for a polling hint; the team simply
  presses the button again.

**Rate limit.** One request per store per **60 s**. A press inside that window returns the existing request
(`"duplicate": true`, same `requestedAt`) and sends nothing. A refused or failed request still counts for that minute.

**On the store card.** "Request code" → "Requested — waiting for the email… (m:ss)" (for up to 10 minutes) → the code in big
type with "expires in m:ss" and Copy → after expiry back to the button. The "call HQ for the OTP" line stays as the fallback
whenever there is no code, and is the only thing shown when the webhook is not configured.

## Privacy

* The routes' bodies, the `Authorization` header, codes, the webhook address and secret, and `Idempotency-Key` values are
  never logged. Field Desk has no per-request access log; its error log for these routes carries only the kind of failure
  (an error's own message can quote a request, so it is not logged). The one info line for a stored code names the
  account id and store id only.
* The code is never in an answer: not in `POST`'s, not in `GET /accounts`. It is stored in Field Desk's database (as the
  rest of the Steam logins are), so backups hold it; keep them private.
* Error messages never repeat what was sent.
* The reverse proxy in `deploy/Caddyfile` writes no access log; if you add one, do not log request bodies or the
  `Authorization` header.
* The key is the only secret the automation holds for Field Desk; rotate it by changing `FD_STEAM_API_KEY` and restarting.
