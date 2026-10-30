# Steam Guard (OTP) API — Field Desk side

For the e-mail automation (Astra's worker and its n8n workflows). Field Desk keeps the newest Steam Guard code of each Steam
account, shows it to HQ and to the store teams that hold the account, and can be asked by a store team to look for a code
(the request webhook, which also says when a lookup is over). This page is the contract; the code is `server/steam-otp.ts` and the `/api/v1/steam/*` part of
`server/api.ts`; `tests/server-steam-otp.test.ts` exercises every row of the tables below.

## Settings (environment, configured privately on the server)

| Variable | Meaning |
|---|---|
| `FD_STEAM_API_KEY` | Bearer token of the automation. Unset or blank: both API routes answer `503 not_configured`. Use a long random value (`openssl rand -base64 32`). |
| `FD_STEAM_WEBHOOK_URL` | Where a store team's "Get code" (and the end of a lookup) is sent (`http` or `https`). |
| `FD_STEAM_WEBHOOK_SECRET` | Secret that signs every webhook request. |

The webhook is on only when **both** webhook settings are set (a half-configured pair is logged as a warning and treated as
off). Then, and only then, store teams see the Get code button. With `deploy/docker-compose.yml` the three variables
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
    "eligibleStoreIds": ["s1"],
    "holders": [{ "storeId": "s1", "storeName": "Store Alpha", "purpose": "play", "date": "2026-10-24" }],
    "active": true,
    "receivedAt": "2026-10-24T06:00:00.000Z",
    "expiresAt": "2026-10-24T06:10:00.000Z"
  },
  {
    "accountUsername": "store_gamma", "accountEmail": null, "username": "store_gamma", "email": null,
    "assignedStoreId": null, "assignedStoreName": null, "eligibleStoreIds": [], "holders": [],
    "active": false, "receivedAt": null, "expiresAt": null
  }
]
```

* `username` / `email` repeat `accountUsername` / `accountEmail`: the mock server and the worker read those two names.
* `accountEmail` is the account's e-mail, `null` if HQ has not entered one.
* `assignedStoreId` / `assignedStoreName` — the one store the account is working for **now** (kept as they always were, for
  compatibility — `null` no longer means "nobody"; use `eligibleStoreIds`):
  1. the store that holds the account **for playing** in this weekend (the Saturday of today's Monday–Sunday week, in
     `EVENT_TZ`, default Asia/Kolkata); if two stores somehow play with it, `null` (ambiguous);
  2. else, if **exactly one** store holds it at all (any purpose) and that store's event day is not past, that store;
  3. else `null` (nobody, or more than one).
* `eligibleStoreIds` — the ids of **every** store holding the account, for any purpose, whose event day is not past, sorted. An
  account is **deliverable** when this is not empty. A Steam account can be held by several stores: one store per weekend
  for playing (exclusive) and any number for downloads (shared).
* `holders` — the same stores, in the same order: `{ "storeId", "storeName", "purpose": "play" | "download", "date" }`
  (`date` is the store's event day, `yyyy-mm-dd`).
* `active`, `receivedAt`, `expiresAt` describe the current **unexpired** code: `active: true` with its two times, or
  `false` with both `null`. `receivedAt` is when Steam sent the e-mail; `expiresAt` is `receivedAt` + 10 minutes.

## `POST /api/v1/steam/otp`

Scope `steam-otp:write`. Hands over a Steam Guard code the automation read from an e-mail.

Headers: `Authorization: Bearer <key>`, `Content-Type: application/json`, and optionally `Idempotency-Key`
(`^[\x21-\x7e]{1,128}$`, e.g. `steam-email-<sha256>`). Body limit **16 KB**.

```json
{ "accountUsername": "store_alpha", "accountEmail": "login-alpha@example.invalid", "code": "AB3DE", "receivedAt": "2026-10-24T06:00:00.000Z",
  "requestId": "6f1c3a0e-8a5b-4c5e-9d57-2b6f0f6a0c11" }
```

| Field | Rule |
|---|---|
| `accountUsername`, `accountEmail` | At least one, strings. Matched trimmed and case-insensitively. Both given must name the same account. An e-mail only matches accounts that have one. |
| `code` | `^[A-Z0-9]{5}$` |
| `receivedAt` | ISO 8601 with `Z` or an offset (`2026-10-24T06:00:00.000Z`), in the window **(now − 10 min, now + 30 s]** |
| `requestId` | Optional: the `requestId` of the lookup this email answers (see the request webhook). A string matching `^[\x21-\x7e]{1,200}$`, else `400 invalid_request_id`. It is **not** part of the idempotency fingerprint and changes no accept / refuse / ordering rule: it only adds `request` to the answer. |

Success, `200`:

```json
{ "ok": true, "accountUsername": "store_alpha", "accountEmail": "login-alpha@example.invalid", "assignedStoreId": "s1",
  "receivedAt": "2026-10-24T06:00:00.000Z", "expiresAt": "2026-10-24T06:10:00.000Z",
  "eligibleStoreIds": ["s1"], "displayed": true, "displayedStoreIds": ["s1"], "request": { "id": "6f1c3a0e-8a5b-4c5e-9d57-2b6f0f6a0c11", "status": "open" } }
```

The answer never contains the code. `expiresAt` is always `receivedAt` + 10 minutes, never counted from when the request
arrives, and a repeat never extends it.

Every `200` (duplicates too) also says:

* `assignedStoreId` — as in `GET`: the one current store, or `null` when several stores hold the account (the code is
  accepted all the same).
* `eligibleStoreIds` — every store holding the account now, as in `GET`.
* `displayedStoreIds` — the holders whose card shows **exactly this code** now (same `receivedAt`; see "Who sees the code in
  Field Desk" and "Lookups on the store card"), sorted. Empty is normal: the code is stored for HQ all the same.
* `displayed` — when `requestId` named a lookup of one of the holders, whether **that** store's card shows this code; else whether
  any card does (`displayedStoreIds` is not empty).
* `request`, only when `requestId` was sent: `{ "id", "status" }`, where `status` is `open` (it is that store's current lookup and
  its 10 minutes are not over), `closed` (the team dismissed it or started a newer one, or its 10 minutes are over) or `unknown`
  (not a lookup of a store holding this account that Field Desk remembers). Any holder's lookup can be asked about, not only the assigned store's. On a retry answered from an idempotency key, `displayed` and
  `request`, `eligibleStoreIds` and `displayedStoreIds` are worked out again, not replayed. Stop watching a request that is `closed` or `unknown`.

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

The code is accepted when the account has **at least one** eligible holder (`eligibleStoreIds` not empty), however many.
`409 not_assigned` only when it has none: nobody holds it, or every holder's event day is past. The worker should treat this as
"not yet", not as a fault of the email.

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
| POST otp | 400 | `invalid_request_id` | `requestId` present but not a string of 1–200 visible ASCII characters |
| POST otp | 400 | `invalid_idempotency_key` | `Idempotency-Key` present but not `^[\x21-\x7e]{1,128}$` |
| POST otp | 409 | `not_assigned` | no store holds the account right now (`eligibleStoreIds` would be empty) |
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

* **HQ** sees it on the Steam accounts page with a countdown (always the newest code).
* The **store team and the named field admin of every store that currently holds the account** (any purpose, event day not
  past) get it in their store's `steamLogin.otp`, **only while unexpired** when the page is read (and the card hides it by
  its own clock), and only if their card may show it (see "Lookups on the store card"). Other stores' teams and admins never receive it, nor does anyone get the account itself.
* A new code reaches HQ and those stores live over the existing event stream.
* **A shared account** — held by more than one store now (several downloads, or a play store and a download store) — shows its
  code to a store **only inside that store's own lookup**: the e-mail cannot say which store's PC asked, so a store that did not
  ask never sees another store's code, and every store whose open lookup fits the code (`receivedAt` ≥ `requestedAt` − 60 s)
  sees the newest one. With no lookup there is nothing on the card. An account with a single holder behaves as before (the
  code shows with no lookup). Without the request webhook nobody can start a lookup, so the plain rule applies there.

## Request webhook — `steam.otp.requested` and `steam.otp.request.closed`

A team signing in to one Steam account on several PCs one after another makes Steam e-mail a new code each time. So a
**lookup** is the team's "look for the next code": it is started by **Get code** or **Check for new code** on the Steam card
(a store's team or admin, or HQ), it watches for 10 minutes, and each press is a new one with its own id. Field Desk sends a
signed event to `FD_STEAM_WEBHOOK_URL` when a lookup starts and, if it ends early, when it ends. Both are polling hints, not
Steam login requests.

The browser calls `POST /api/steam/otp-request` with `{ "storeId": "s1", "seen": "<ISO>" }` (a normal session; `seen`
is optional: the `receivedAt` of the code on the phone's screen) and gets `{ "ok": true, "requestId": "<id>", "requestedAt": "<ISO>", "duplicate": false }`.
`POST /api/steam/otp-dismiss` with `{ "storeId", "receivedAt" }` is **Logged in**: it answers `{ "ok": true }`.

* There is **no per-minute limit**. A press within **5 s** of the store's last lookup is a double tap: the same lookup comes
  back (`"duplicate": true`, same `requestId` and `requestedAt`) and nothing is sent.
* A store may start **20 lookups in 10 minutes**; the 21st is `429 too-many` ("Too many code requests — wait a minute, or call HQ.") and sends nothing.
* A new lookup while the previous one is still inside its 10 minutes **supersedes** it; Logged in **dismisses** it. Either way
  its delivery retries stop and a `steam.otp.request.closed` is sent for it (not when its 10 minutes are already over).

### `steam.otp.requested`

Payload (JSON, UTF-8):

```json
{
  "id": "6f1c3a0e-8a5b-4c5e-9d57-2b6f0f6a0c11",
  "type": "steam.otp.requested",
  "at": "2026-10-24T06:00:00.000Z",
  "requestId": "6f1c3a0e-8a5b-4c5e-9d57-2b6f0f6a0c11",
  "requestedAt": "2026-10-24T06:00:00.000Z",
  "acceptFrom": "2026-10-24T05:59:00.000Z",
  "watchUntil": "2026-10-24T06:10:00.000Z",
  "storeId": "s1",
  "storeName": "Store Alpha",
  "accountUsername": "store_alpha",
  "accountEmail": "login-alpha@example.invalid",
  "eligibleStoreIds": ["s1", "s2"]
}
```

`requestId` is `id` and `requestedAt` is `at` (the older fields stay, so a worker that reads only those keeps working);
`acceptFrom` is `requestedAt` − 60 s and `watchUntil` is `requestedAt` + 10 min. `accountEmail` is left out when the account
has none; `accountUsername` is always there. `eligibleStoreIds` lists every store holding the account (as in `GET`, sorted;
`storeId` is one of them), so the worker can check the store without a `GET`. Nothing else is sent: no password, no code.

### `steam.otp.request.closed`

Same URL, signature and timeout. The lookup ended before its `watchUntil`:

```json
{
  "id": "0b7d1f0c-3a52-4d0e-8f43-6c1d7c4b2e90",
  "type": "steam.otp.request.closed",
  "at": "2026-10-24T06:03:00.000Z",
  "requestId": "6f1c3a0e-8a5b-4c5e-9d57-2b6f0f6a0c11",
  "storeId": "s1",
  "accountUsername": "store_alpha",
  "accountEmail": "login-alpha@example.invalid",
  "reason": "dismissed"
}
```

`reason` is `dismissed` (Logged in) or `superseded` (a newer lookup). `accountEmail` is left out when the account has none.
It is delivered with the same retry policy but only until the original request's `watchUntil`, and not at all if that has
passed. A `4xx` answer to it is final **and expected**: the current worker answers `400 unsupported_event` to every type but
`steam.otp.requested`; Field Desk logs that at `info` (`steam-otp-close-refused`), never as a warning. The worker can learn the
same from `request.status` in the answer to `POST /api/v1/steam/otp`.

**Signature.** The body is serialised once; the exact UTF-8 bytes sent are signed:
`X-FieldDesk-Signature: sha256=<lowercase hex HMAC-SHA256(FD_STEAM_WEBHOOK_SECRET, raw body)>`, with
`Content-Type: application/json`. Verify over the raw bytes before parsing.

**Delivery and retries.**

* One attempt has a **5 s** timeout.
* `2xx` ends delivery (the worker answers `202` accepted, `200` duplicate).
* A timeout, a network error or a `5xx` is retried after **5 s, 15 s, 45 s, then every 90 s**, with the **same `id` and the
  same bytes (and signature)**, until the request's `watchUntil`; then Field Desk gives up. A superseded or dismissed request
  stops being retried at once.
* Any other answer (`4xx`, a redirect) is final: no retry.
* Delivery retries are kept **in memory only**; a restart forgets them. The lookup itself is on the store (below) and survives
  restarts: the team's card keeps waiting, and an email that arrives still shows.

## Lookups on the store card

Each store keeps the state of its team's lookups (`store.otpState`: the current `lookup { id, requestedAt }`, `seenThrough`,
`dismissedAt`). Only the server writes it: any client batch that changes it, HQ's included, is refused (`403 protected`), and
teams and admins never receive it — their `steamLogin` carries the result (`otp`, `otpLookup`). Every phone of the team gets it live.

The code the card may show is the account's unexpired code, and then:

1. not one the team has moved past — `receivedAt` ≤ `seenThrough` (set by Logged in, and by Check for new code for the code on screen);
2. if a lookup exists: only a code with `receivedAt` ≥ `requestedAt` − 60 s — even after the lookup's own 10 minutes, so a later
   code for a later sign-in still shows;
3. else, after Logged in: nothing until the next lookup;
4. else (no state at all, as before the feature): the code — unless the account is **shared** (see "Who sees the code in Field
   Desk"), when a card shows a code only inside its own lookup, so with no lookup: nothing.

The account's code keeps its own expiry (`receivedAt` + 10 min), never extended and never shortened by a lookup or by Logged in;
HQ's account always has the newest code. Logged in does not invalidate anything in Steam.

The card: **Get code** → "Waiting for a new Steam email… (m:ss)" (up to 10 minutes, and never the previous code) → the code in big
type with "expires in m:ss", Copy, **Logged in** and **Check for new code** ("Signing in on another PC?"). Logged in goes back to
Get code at once; Check for new code starts a new lookup and waits again. The "call HQ for the OTP" line stays as the fallback
whenever there is no code, and is the only thing shown when the webhook is not configured.

## Freshness policy for the automation

For each lookup (`steam.otp.requested`):

* accept only emails of the **matching account** dated at or after `requestedAt` − 60 s (`acceptFrom`);
* watch until `watchUntil` (10 minutes), and prefer the **newest** eligible email;
* never fall back to an older email outside that window;
* a new email with the **same code** is eligible — dedupe by email identity (its message id), not by the code;
* send the lookup's `requestId` with each code it answers;
* stop watching when the answer says `request.status` is `closed` or `unknown`, or a `steam.otp.request.closed` arrives for it.

## For the automation (shared accounts)

* **Deliver when `eligibleStoreIds` is not empty** (in `GET /accounts`), instead of requiring `assignedStoreId`, which is `null`
  whenever several stores hold the account.
* **Accept a request event when its `storeId` is in `eligibleStoreIds`** (the event carries the list).
* **Track lookups per `requestId`.** One account may have open lookups from several stores at once; a
  `steam.otp.request.closed` ends that request only.
* When an email arrives, send the `requestId` of a lookup it fits (any open one for that account). Field Desk shows the newest
  fitting code to every store whose lookup it fits, so one `POST` serves them all; `displayedStoreIds` says which cards got it.

Compatibility: Field Desk applies the same window itself when it decides what a team's card shows, so codes from the current
worker (no `requestId`, every Steam email it parses) are handled correctly: they are stored for HQ, and shown only when they
are eligible.

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
