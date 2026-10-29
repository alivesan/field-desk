# Field Desk automation — Steam OTP

The approved design reads **one central Gmail inbox**. Four original mailboxes (Gmail or Outlook) will forward their Steam messages into it after the owner confirms the exact forwarding addresses and enables forwarding. The worker reads only the central inbox; it does not need OAuth access to the four source accounts. The Oracle stack is running against the synthetic Field Desk mock.

## Current status, 29 October 2026

- Synthetic parser, deduplication, polling and mock delivery tests have run. The current real Steam message layouts and Gmail authentication headers still need owner-assisted samples before live delivery can be enabled.
- The Oracle Always Free VM `field-desk-automation` exists at public IPv4 `129.225.72.140`, private IPv4 `10.0.0.230`. Docker 29.9.2, Compose 5.6.1 and 2 GB swap are active. The n8n, worker and mock containers are running; Caddy is not started.
- Three n8n workflows are imported. The synthetic `C-demo-mock` workflow completed an actual n8n CLI execution with `SUCCESS` and `status: delivered`. The VM worker's default runtime check passed against the mock. Its `--n8n` check also passed through the published webhook: a valid signed request returned 202, a repeat returned 200, and a modified body returned 401. This verifies raw-body HMAC and response status forwarding through n8n.
- n8n `/healthz` responds through VM loopback and the SSH tunnel from local port 5678 to VM `127.0.0.1:5678`. The owner profile, central Gmail OAuth credential, forwarding and real message checks are pending. The central Gmail workflow remains disabled. The mock remains the only configured Field Desk target; Caddy/HTTPS is not started.
- The production Field Desk endpoint requires owner authorization and contract verification. No live result is claimed. HQ issue alerts are sanitized local records only; no message is sent to a person.

## Message and account rules

`MAILBOXES` contains one entry, for example `central-gmail`, with `provider: "gmail"`. Its optional `trustedForwarders` list must contain the **four exact source addresses** supplied by the owner before forwarded mail is accepted. The example environment leaves this list empty. Do not enable source-account forwarding until the owner confirms the addresses and the central inbox is ready.

Every accepted message must identify exactly one Steam **username** in the email content and match exactly one currently assigned account returned by Field Desk. Recipient address is never a fallback for a forwarded message or for an unknown central recipient. A missing or ambiguous username is an exception; the worker must never guess a store.

The worker accepts two forwarding formats only after real samples confirm their layout:

- **Automatic forward preserving Steam From:** Gmail's provider authentication information must support the original Steam sender. The original message `Date` provider header is required to measure age; central Gmail arrival time cannot extend an OTP's ten-minute life.
- **Forward wrapped by a source mailbox:** the outer sender must be an exact member of `trustedForwarders` and authenticated by Gmail. The body must carry an unambiguous original Steam `From` marker and original `Date` timestamp. Missing, conflicting or stale origin data fails closed.

Both formats still require a supported Steam Guard/new-device context, one unambiguous five-character uppercase alphanumeric code, and a timestamp less than ten minutes old. Real samples should be reviewed locally with the owner and redacted into fixtures; do not paste codes or full messages into chat.

## Polling and delivery

The central Gmail workflow ticks every 15 seconds and asks the worker whether a scan is due. A **broad scan** runs at most every 60 seconds. A signed `steam.otp.requested` event opens a separate, ten-minute **account-name scan** for the named account every 15 seconds. The broad and account windows keep separate clocks so one cannot suppress the other. Provider queries include already-read messages for safe retries. Mark-read happens only after confirmed or previously recorded delivery.

Flow: central Gmail list → full message → worker sender/forwarding/age/username validation → GET `/steam/accounts` → POST `/steam/otp` with an idempotency key → mark read. A small dependency-free Node worker keeps hashes, polling times and sanitized issue reasons in a persistent ledger. It does not save OTPs or full email payloads. A lost HTTP response still needs server-side idempotency for exactly-once effects; see [CONTRACT-NOTES.md](CONTRACT-NOTES.md).

## Synthetic local use

With Node 24, run `node automation/scripts/demo-local.mjs` from the repository root and open `http://127.0.0.1:8790/mock/store`. This uses synthetic data only and does not exercise n8n. Run `node --test automation/tests/*.test.mjs` for worker tests.

With Docker Desktop, generate a local ignored `.env` using `node automation/scripts/init-local.mjs`, then from `automation/deploy` run `docker compose --env-file .env -f compose.local.yaml up -d`. Set up the n8n owner login at `http://localhost:5678`. Import `C-demo-mock.json`, create an **OTP Worker** Header Auth credential with header `Authorization` and value `Bearer <WORKER_TOKEN>`, and bind it to worker HTTP nodes. Run only the synthetic demo. The mock card is at `http://localhost:8790/mock/store`. Stop with `docker compose --env-file .env -f compose.local.yaml down`; do not add `-v` unless intentionally deleting credentials and ledger state.

## Central Gmail setup

1. Confirm the central Gmail account and obtain the four exact source forwarding addresses from the owner. Keep `trustedForwarders` empty until those addresses are confirmed. Set a stable central mailbox ID; it is part of the delivery deduplication namespace.
2. Import the central Gmail workflow and set its `MAILBOX ID` to the configured ID. Create **one** Google OAuth credential for the central inbox and bind it to its Gmail nodes. Gmail API modify scope is needed to read messages and mark them read. For a Google app in testing, add the central account as a test user and resolve consent/token expiry before unattended polling.
3. Bind the **OTP Worker** credential to worker HTTP nodes. Keep the workflow inactive while the owner supplies real automatic-forward and wrapped-forward samples and their Gmail authentication headers. Verify original timestamps, sender proof, username extraction and duplicate behavior against those samples.
4. Only after owner confirmation, configure forwarding on the four source accounts and allowlist their exact addresses. No direct source-account OAuth credential is used by this design. Activate delivery only after the mock workflow and Field Desk contract checks pass.

The signed request webhook is `/webhook/steam-request` after the workflow is active. It forwards the raw request body to the worker, which checks `X-FieldDesk-Signature: sha256=<HMAC-SHA256>` and stores a ten-minute account-name polling window. Invalid signatures do not change polling. The webhook is a search hint; the automation never signs in to Steam.

## Secrets, deployment and troubleshooting

`deploy/.env`, OAuth credentials and runtime state must not be committed. `N8N_ENCRYPTION_KEY` must remain stable and be backed up with n8n and worker volumes. `WORKER_TOKEN` authenticates n8n to the internal worker; `FD_API_KEY` is for Field Desk account read and OTP write; `FD_WEBHOOK_SECRET` verifies signed requests. `FIELD_DESK_BASE_URL` points to the mock until live use is approved. `MAILBOXES` holds the one central Gmail ID and exact forwarder allowlist, not passwords or OAuth tokens.

See [deploy/README.md](deploy/README.md) for the VM setup and bootstrap sequence. The worker has no published host port. Production concurrency is capped at two executions. The n8n configuration uses `N8N_WEBHOOK_URL`; its earlier `WEBHOOK_URL` setting has been removed. Both instance and workflow settings avoid saving execution payloads, but manual editor runs may display transient email content. Do not pin real data or enable payload logging. Review sanitized issues with authenticated GET `http://otp-worker:8787/issues` from n8n; entries contain mailbox IDs, hashed message IDs, time and reason, not codes.

If nothing runs, check workflow activation, central mailbox ID, Google OAuth, token and worker reachability. `sender_auth_unverified`, missing original dates or untrusted forwarders require real-header review with the owner; do not weaken validation to pass an unknown format. `unmatched_or_ambiguous_account` requires a verified username and assignment. `fielddesk_unavailable` requires contract and connectivity checks; expired codes are not retried indefinitely.

Acceptance checkpoint: all 24 automated tests, mock container startup, both worker runtime checks, three workflow imports, synthetic n8n CLI execution, signed-request webhook response checks and n8n `/healthz` have passed. Next: owner profile through SSH tunnel → central Gmail OAuth → owner-confirmed forwarding and real samples → duplicate/expiry/failure checks → Field Desk API contract checks → owner-approved live store-card test. Those later steps remain pending until actually verified.
