# Field Desk automation — Steam OTP first

This branch implements the local foundation and Workflow C for multiple Gmail and Hotmail/Outlook mailboxes. All changes live under automation/. It does not edit Field Desk, deploy to either server, send alerts to people, or access Toornament.

## Status and limits

- Tested with synthetic email: parsing plain text/HTML, username-first matching, ambiguous-account rejection, ten-minute expiry, raw-body HMAC, durable message deduplication, retry after failure, polling windows, and delivery to a local mock store card.
- n8n exports have structural/generation checks. **Import and actual execution in n8n are not yet verified:** Docker is unavailable on the build PC.
- Gmail/Hotmail accounts are not connected. Current Steam login/new-device email formats and provider authentication headers still require owner-assisted real logins. Synthetic fixtures are not evidence of the current real format.
- Real Field Desk endpoint/card integration remains blocked on Claude's API and the contract notes below. The mock implements the proposed idempotency and expiry behavior; it does not prove the real API does.
- HQ alerts are stored as sanitized local issues only; no email or Telegram is sent. Choose and authorize a notification destination separately.

## Design

Each mailbox gets one copy of its provider workflow and its own OAuth credential. Built-in n8n Schedule, HTTP Request, IF and Split Out nodes handle provider access, pagination and marking read. Gmail uses its API; Hotmail uses Microsoft Graph with delegated OAuth supporting personal Microsoft accounts. No IMAP password is required by these templates.

A small dependency-free Node worker performs parsing, signature checking and serial delivery with a persistent ledger. This avoids storing codes in workflow state and coordinates duplicate deliveries across overlapping runs. Only hashed email/event identifiers, polling times and sanitized issue reasons reach its state file. Provider tokens stay in n8n credentials; the Field Desk API key stays in the worker environment.

Flow: provider list of recent Steam emails → full email → worker validation → GET /steam/accounts → POST /steam/otp → mark email read. List queries include already-read messages so delivery and mark-read failures can retry. The ledger prevents normal duplicate POSTs, including across restarts. A lost HTTP response/crash requires server-side idempotency for exactly-once effects; see CONTRACT-NOTES.md.

The parser requires sender `noreply@steampowered.com`, a provider Authentication-Results DMARC pass for steampowered.com, a supported Guard/new-device context, one five-character uppercase alphanumeric code, and a timestamp under ten minutes old. No account-name match falls back to email only when the name is absent, and then only for one assigned account. Unsupported or ambiguous emails fail closed and remain unread by this automation. Actual provider header layouts must be verified before enabling delivery.

## Quick synthetic demo without Docker

Requires Node 24. From the repository root:

```powershell
node automation/scripts/demo-local.mjs
```

Open http://127.0.0.1:8790/mock/store. A synthetic email has been processed through the worker and its code appears on a synthetic store card for ten minutes. This is not the live Field Desk UI or an n8n execution. Ctrl+C stops it. No real secrets, mailbox access, or outbound calls are used.

Run tests:

```powershell
node --test automation/tests/*.test.mjs
```

Tests make loopback HTTP calls. Restricted execution environments may need local-network permission. Test/demo ledger files are under ignored automation/test-output/ and contain no codes.

## Windows PC with Docker Desktop

1. Install/start Docker Desktop using Linux containers. Stop the standalone demo first if it occupies port 8790.
2. Generate an ignored local environment file without printing secrets:

```powershell
node automation/scripts/init-local.mjs
cd automation/deploy
docker compose --env-file .env -f compose.local.yaml up -d
```

3. Open http://localhost:5678 and complete n8n owner-account setup immediately. Use its built-in user login. No obsolete basic-auth environment switch is used.
4. Import `workflows/C-demo-mock.json` first. Create an n8n Header Auth credential named **OTP Worker**: header name `Authorization`, value `Bearer ` followed by the generated WORKER_TOKEN from your local .env. Bind it to the worker HTTP node. Run only this synthetic demo and open http://localhost:8790/mock/store.
5. Leave real mailbox templates inactive until OAuth authorization, live-format validation and the account directory are ready. The local stack defaults to the mock URL. Do not change to the live API without the owner's permission.

Stopping: `docker compose --env-file .env -f compose.local.yaml down`. Do not add `-v`; that removes credentials and ledger volumes. The PC must remain awake and Docker running for continuous polling.

## Mailbox setup — repeat for all 5–6 accounts

1. Assign stable nonsecret IDs such as gmail-1, gmail-2, outlook-1. Set worker `MAILBOXES` JSON to objects containing `id` and `provider` (`gmail` or `outlook`). Keep IDs stable across restarts/imports because they form the dedupe namespace.
2. Import `gmail-mailbox.json` or `outlook-mailbox.json`, rename it to identify that mailbox, and set its **MAILBOX ID** node to the configured ID.
3. Create and select the corresponding OAuth credential on **List recent messages**, **Get full message**, and **Mark message read**. Bind **OTP Worker** to **Ask worker if due** and **Process in worker**.
4. Gmail: create a Google OAuth application, enable Gmail API, use the redirect URI displayed by n8n, and authorize the mailbox. Reading and removing UNREAD require Gmail modify access. For an external app in testing, add each mailbox as a test user and resolve token-expiration/consent status before unattended operation.
5. Hotmail: create a Microsoft application allowing personal Microsoft accounts (or both personal and organizational if needed), use the n8n redirect URI and delegated Mail.ReadWrite + offline_access permissions. Bind the n8n Microsoft Outlook OAuth2 credential. A client secret goes into that credential only.
6. Each workflow ticks every 15 seconds, but the worker permits provider scanning once per 60 seconds normally, or every 15 seconds during a signed request window. HTTP nodes paginate. Mark-read is only reached after confirmed or previously recorded delivery.
7. Complete a throwaway login in the owner's presence and validate both real login/new-device emails. Keep execution saving disabled; do not pin real email data or paste emails/codes into chat. Manual runs can display transient data in the editor, so use synthetic data for editor debugging.

An email address shared by multiple Steam accounts is safe only if the email identifies the account. Forwarding is not configured; the initial implementation connects the original mailboxes directly.

## Signed request webhook

Import `steam-request-webhook.json`, bind **OTP Worker**, and publish/activate it after local testing. Production path is `/webhook/steam-request` (not the editor's `/webhook-test/` path). It forwards the binary raw body without reserializing JSON. The worker validates the signature, deduplicates the event ID, and persists a ten-minute accelerated polling window. Invalid signatures cannot trigger polling.

On Windows, the private Oracle network cannot reach the PC without a separately approved connection. Use synthetic local requests; do not expose n8n publicly as a workaround.

## Credentials and environment names

Never commit values. `deploy/.env` and runtime files are ignored. Values belong in n8n credentials or local environment configuration.

| Name | Purpose |
|---|---|
| Gmail OAuth2 credential per mailbox | Google client ID/secret and authorized account tokens |
| Microsoft Outlook OAuth2 credential per mailbox | Microsoft application credentials and authorized account tokens |
| OTP Worker / httpHeaderAuth | Internal worker bearer credential |
| WORKER_TOKEN | Must match OTP Worker credential |
| FD_API_KEY | Dedicated Field Desk account-read + steam-otp-write key; local generated value is mock-only |
| FD_WEBHOOK_SECRET | Shared signing secret agreed with Claude |
| FIELD_DESK_BASE_URL | Local mock by default; approved live value is https://fieldesk.runs-at.dev/api/v1 |
| N8N_ENCRYPTION_KEY | Stable n8n credential encryption key; back up securely |
| MAILBOXES | JSON array of stable mailbox IDs and provider types; no password or token |
| STATE_PATH | Worker ledger file location in persistent volume |
| HOST / PORT | Worker/mock bind configuration |
| PRIVATE_IP / N8N_DOMAIN | Oracle private interface and HTTPS hostname |

The worker is not exposed on the host. Both workflow and instance settings disable saved successful, failed and manual execution payloads, progress snapshots and diagnostics. Do not enable HTTP payload debugging or reverse proxy request-body logging.

## Oracle preparation and updates

See deploy/README.md. Prepared files include separate n8n + worker + Caddy services, persistent volumes, Asia/Kolkata timezone, a 2 GB swap setup and private-port firewall rules. The owner/Claude provisions the VM and Oracle network rules. setup.sh and deployment have not been run on a server. Request permission before running them. Use only the second VM.

On first deployment complete n8n account setup before wider access. Never copy the demo workflow or mock to production as a substitute for the real API. Back up n8n volume, worker ledger and encryption key together. Test pinned image updates locally before changing production; do not blindly downgrade a migrated n8n database.

## Troubleshooting and acceptance

- No runs: check workflow is published/active, MAILBOX ID matches MAILBOXES, OAuth credential is on all provider nodes, PC is awake, and worker token matches. Credential/provider failures appear as failed runs with payload retention disabled.
- `sender_auth_unverified`: inspect provider authentication metadata locally with the owner. Do not disable sender validation to make a sample pass. Adjust parser against verified real samples with redacted fixtures.
- `unmatched_or_ambiguous_account`: fix account directory/assignment or account-name extraction. Never select a store by guesswork.
- `fielddesk_unavailable`: check URL, token scopes and endpoint readiness; codes retry on subsequent scans only while fresh. The worker intentionally does not include API error bodies in issues.
- `ambiguous_or_missing_code`: email template is unsupported or ambiguous; validate a real sample locally. Do not broaden to an arbitrary five-character substring.
- Polling remains normal: check webhook production URL, signature raw bytes, event timestamp and worker secret. Burst windows expire ten minutes after event.at.
- Sanitized exceptions: authenticated GET `http://otp-worker:8787/issues` using an n8n HTTP Request node with **OTP Worker** credential. It returns mailbox IDs, hashed message IDs, time and reason only. Review this until HQ alerts are authorized. Issues are bounded to 100 entries/24 hours.

Acceptance order: automated tests → Docker startup/import → synthetic n8n demo → Gmail authorization/test → Hotmail authorization/test → both real Steam email formats → duplicate/expiry/failure checks → Claude's API contract checks → owner-approved real Field Desk store-card test. The last steps are intentionally not claimed complete.

## Sources

- n8n node definitions: https://github.com/n8n-io/n8n/tree/master/packages/nodes-base/nodes/HttpRequest and https://github.com/n8n-io/n8n/tree/master/packages/nodes-base/nodes/Webhook
- Gmail API messages: https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages
- Microsoft Graph messages (including personal-account delegated permissions): https://learn.microsoft.com/en-us/graph/api/user-list-messages
- n8n execution-data configuration: https://github.com/n8n-io/n8n-docs/blob/main/docs/deploy/host-n8n/configure-n8n/basic-configuration/use-environment-variables/executions.md
