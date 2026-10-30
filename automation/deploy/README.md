# Automation deployment

This directory prepares the OTP automation. The local stack uses synthetic mock accounts and codes. Nothing here starts or changes the Field Desk service.

## Local phase C

1. Copy `.env.example` to `.env` here and fill `N8N_ENCRYPTION_KEY`, `WORKER_TOKEN`, `FD_API_KEY`, and `FD_WEBHOOK_SECRET` with independent, random values. The included `MAILBOXES` entry represents one central Gmail inbox; its `trustedForwarders` list remains empty until the owner confirms the active source addresses. Leave `PRIVATE_IP` and `N8N_DOMAIN` blank for local use, and leave `FIELD_DESK_BASE_URL` commented out. `.env` is ignored by Git.
2. From this directory run `docker compose -f compose.local.yaml config --quiet`, then `docker compose -f compose.local.yaml up -d`.
3. Open n8n at `http://127.0.0.1:5678` and the synthetic mock display at `http://127.0.0.1:8790/mock/store`. The worker is reachable only to other containers at `http://otp-worker:8787`.

The `automation` directory is mounted read only at `/app`; the worker saves its state in a separate Docker volume at `/data/state.json`. The mock keeps demo data in memory. The n8n image is pinned to [stable 2.44.6](https://github.com/n8n-io/n8n/releases/tag/n8n%402.44.6), released 22 October 2026. Upgrade by choosing and testing a new explicit version, then changing both Compose files together.

## Oracle Ubuntu 24.04 preparation

For initial synthetic acceptance testing, use `-f compose.yaml -f compose.mock.yaml -f compose.bootstrap.yaml` and start only `n8n otp-worker mock`. The existing VM completed that stage and, with owner authorization on 30 October 2026, now runs **`compose.yaml` alone against production**. The mock is removed. Owner setup is complete and https://n8n.129-225-72-140.sslip.io/healthz returns 200 with verified TLS. Private pre-HTTPS and pre-production configuration backups are in ignored `automation/data/backups/`. The bootstrap override binds n8n to loopback, uses temporary HTTP cookies, and runs without Caddy; never combine it with a public HTTPS launch. All stages retain the same persistent volumes. Central Gmail OAuth has not been configured, and its workflow remains disabled.

Use a host with an assigned `10.0.0.0/16` private IPv4 address. Choose `N8N_DOMAIN=n8n.<public-ip-with-dots-replaced-by-dashes>.sslip.io` and confirm that it resolves to the host's public IPv4. In the Oracle security list or network security group, allow public TCP 80 and 443, retain the existing SSH rule, and allow TCP 5678 only from `10.0.0.0/16`. Restrict SSH to your own source address if that is your existing policy.

The Oracle Always Free VM `field-desk-automation` is already created at public IPv4 `129.225.72.140` and private IPv4 `10.0.0.230`. Docker 29.9.2, Compose 5.6.1 and 2 GB swap were confirmed active on 29 October 2026. `setup.sh` remains the reproducible Ubuntu 24.04 preparation script. It installs Docker from its official repository, adds swap only when needed, and inserts persistent port rules without flushing existing firewall or SSH rules. Its persistent rule allows loopback TCP 5678 for the SSH tunnel before dropping non-private sources, and protects Docker forwarding. On 30 October the owner explicitly authorized adding stateful TCP 5678 from `10.0.0.0/16` to the subnet security list; that single rule was applied and verified with previous ingress and all egress preserved. Check `sudo systemctl status fielddesk-automation-firewall.service`, `sudo iptables -S INPUT`, and `sudo iptables -S DOCKER-USER` after Docker restarts.

The read-only default of `automation/scripts/oracle-private-webhook.py` verifies the known subnet and all associated security lists using the owner's OCI SDK profile. It refuses broader existing 5678 ingress; `--apply` adds only the missing exact rule using the list's ETag. The official Python `oci` SDK is required. The local SDK environment and metadata backup are ignored under `automation/data/`. No compute instance or Field Desk server is changed by that helper.

### VM import and mock check

`python3 automation/scripts/init-vm.py --private-ip 10.0.0.230 --domain n8n.129-225-72-140.sslip.io`, run from the repository root, creates `automation/deploy/.env` on the VM with fresh secrets and the mock endpoint. It uses exclusive creation and refuses to overwrite an existing file; it does not print secrets. Do not run it again over the existing VM configuration.

`python3 automation/scripts/prepare-n8n-import.py`, run from the repository root, creates inactive workflow exports and a temporary `automation/data/n8n-import/credentials.json` containing the worker bearer token. On the Ubuntu host, the checkout owner is UID 1001 while n8n runs as UID/GID 1000. Before a read-only CLI import, set group 1000 and permissions 750 on `automation/data/n8n-import` and 640 on its JSON files. For example, from the repository root:

```bash
sudo chgrp 1000 automation/data/n8n-import automation/data/n8n-import/*.json
chmod 750 automation/data/n8n-import
chmod 640 automation/data/n8n-import/*.json
```

From `automation/deploy`, the imports used a read-only bind mount and a one-off n8n process:

```bash
sudo docker compose -f compose.yaml -f compose.mock.yaml -f compose.bootstrap.yaml run --rm --no-deps -v /home/ubuntu/field-desk/automation/data/n8n-import:/import:ro n8n import:credentials --input=/import/credentials.json
sudo docker compose -f compose.yaml -f compose.mock.yaml -f compose.bootstrap.yaml run --rm --no-deps -v /home/ubuntu/field-desk/automation/data/n8n-import:/import:ro n8n import:workflow --input=/import/workflows.json
```

Three workflows are imported. After a successful import, the plaintext `credentials.json` was removed from the VM; do not retain or commit it. The synthetic `C-demo-mock` workflow returned `SUCCESS` through an actual n8n CLI execution. The default worker check also passed against the mock:

```bash
sudo docker compose -f compose.yaml -f compose.mock.yaml -f compose.bootstrap.yaml exec -T otp-worker node /app/scripts/check-runtime.mjs
```

The optional `--n8n` mode passed through the actual published n8n webhook: valid signed request 202, duplicate 200, modified body 401. It verifies raw-body HMAC and response status forwarding through n8n. Repeat it only on a mock stack, with the same Compose overrides. The synthetic demo also returned `status: delivered` and `SUCCESS` through n8n CLI. Production rejects both the new `mockOnly` demo and known legacy demo message IDs before calling Field Desk. n8n uses `N8N_WEBHOOK_URL` rather than the deprecated `WEBHOOK_URL` setting, and production execution concurrency is capped at two.

For a fresh production installation, create a private `.env` containing all four random secrets, the one central Gmail `MAILBOXES` entry with the owner's confirmed `trustedForwarders` addresses, `PRIVATE_IP`, `N8N_DOMAIN`, and `FIELD_DESK_BASE_URL`. **The owner must authorize use of `https://fieldesk.runs-at.dev/api/v1` before setting it or activating any live workflow.** Do not configure the source accounts to forward until the owner confirms them. Check the values with `docker compose -f compose.yaml config --quiet`, then start only after authorization with `docker compose -f compose.yaml up -d`. Caddy obtains HTTPS for the supplied domain. n8n publishes 5678 on the private IP, while the worker has no published port.

Keep `N8N_ENCRYPTION_KEY` stable: n8n credentials cannot be decrypted after a key change. Back up the `.env` securely along with the `n8n_data` and `worker_data` Docker volumes before upgrades. Stop the stack or use a consistent snapshot when backing up the volumes; test restoration separately. Execution payload persistence is disabled in both Compose files to avoid retaining OTP values, but workflow definitions and credentials remain in n8n's persistent volume. Keep n8n's owner login secured and review workflows before activation.

## Existing VM: production handoff and checks

The approved switch has run on `field-desk-automation`. `python3 automation/scripts/promote-production.py` preserves the n8n encryption key, worker token and mailbox configuration. On its first run it generates independent production `FD_API_KEY` and `FD_WEBHOOK_SECRET` on the VM and sets `FIELD_DESK_BASE_URL=https://fieldesk.runs-at.dev/api/v1`. Subsequent runs reuse that handoff, avoiding accidental rotation.

The private, owner-readable handoff is `/home/ubuntu/field-desk/automation/data/private/fielddesk-otp-production.env` (directory 700, file 600). It contains **names and values for the app**, with these mappings:

| Automation setting | Field Desk setting |
|---|---|
| `FD_API_KEY` | `FD_STEAM_API_KEY` |
| `FD_WEBHOOK_SECRET` | `FD_STEAM_WEBHOOK_SECRET` |
| private webhook URL | `FD_STEAM_WEBHOOK_URL` |

The URL is `http://10.0.0.230:5678/webhook/steam-request`. The owner/Claude privately transferred these three values, **merged them into** Field Desk's existing environment, and restarted its service. Do not replace its whole environment file. Do not paste the values into chat, commit them, or include them in shell command arguments. Astra does not access the Field Desk server. The authenticated account API now returns 200; a wrong key returns 401.

From `/home/ubuntu/field-desk/automation/deploy`, the production launch is:

```bash
sudo docker compose -f compose.yaml config --quiet
sudo systemctl restart fielddesk-automation-firewall
sudo docker compose -f compose.yaml up -d --remove-orphans
```

Only n8n, worker and Caddy should remain. Private port 5678 is bound to `10.0.0.230` and loopback, with no public wildcard binding. The worker port is internal only. The owner login, n8n credentials and both persistent data volumes are preserved.

Production verification, run on this VM, uses the private host interface and never posts an OTP:

```bash
sudo docker run --rm --network host \
  --env-file /home/ubuntu/field-desk/automation/deploy/.env \
  -v /home/ubuntu/field-desk/automation:/app:ro \
  node:24-alpine node /app/scripts/check-production.mjs
```

Verified on 30 October: private health 200, unsigned webhook 401, correctly signed malformed event 400, tampered bytes 401; public HTTPS health 200 with certificate verification, and public TCP 5678 blocked. The owner/Claude privately merged `FD_STEAM_*` into Field Desk; the authenticated account API returned 200 and a wrong key returned 401. The owner tested host and container reachability. An actual Request code press from Field Desk at `10.0.0.242` at `05:40:57.338Z` for store `n8lhdhtyh77k` was accepted at `05:40:58.249Z`; the inferred polling boost began at `05:40:57.321Z` and expired at `05:50:57.321Z`. These checks establish API authentication and the real request path. Gmail OAuth is connected; the owner selected request-only trusted Redirect processing. A later real request at `17:02:39.658Z` delivered at `17:03:16.434Z`, with the owner confirming the code appeared on the assigned store card.

The production check fails with a nonzero exit status for API 401 or 503. During a fresh bootstrap only, append `--allow-pending` to the check command to tolerate 503 with an explicit `PENDING` result; 401 still fails. Do not use that override as production readiness evidence. The check never submits an OTP; by default it sends no valid polling hint. Explicit `--poll-hint` opens a real account window and can cause the active mail reader to deliver a real code; reserve it for an intended owner-assisted test.

For updates, securely back up the environment and data volumes, copy the reviewed `automation/` sources without overwriting `.env` or `data/`, and rerun the production launch. Recreate `otp-worker` when worker source changes; a mounted source update alone does not restart Node. Keep explicit image versions tested together, inspect Compose service status, and rerun the production check. Never change `N8N_ENCRYPTION_KEY` during an update.


Workflow source changes require a separate n8n update: copying JSON files or restarting Compose does not change workflows stored in `n8n_data`. Back up the database and export the existing workflows privately before editing. In the n8n editor, open the **existing workflow**, record its ID, credential bindings and activation state, and apply the reviewed node/settings changes there. Preserve that workflow ID and recheck every worker/Gmail credential binding; do not create a duplicate workflow from the source export. Keep Gmail inactive until its owner checks pass. Save and publish the updated webhook workflow as required by the editor, restore only its intended activation state, then rerun the production check and an owner-assisted Request code event. For rollback, restore the reviewed prior definition into that same workflow or restore the consistent pre-upgrade database and environment backup. Never overwrite production credentials with the mock-only bootstrap importer.

On 30 October the reviewed parser, readiness and Spam/loop changes were deployed under the owner's Gmail setup request. A private consistent SQLite backup, prior workflow export and source snapshot were created under `automation/data/backups/gmail-setup-*/`. The installed CLI's `export:workflow` and `import:workflow` were used for the **single existing inactive Gmail workflow**, with its existing ID/project and node credential bindings carried into the update. The worker was recreated; the published webhook was retained. Post-import checks confirmed the existing ID and credentials, `includeSpamTrash=true`, Loop Over Items, Gmail inactive, webhook active, and production readiness passing (API 200 and accepted/deduplicated polling hint). No OTP was submitted. Owner-entered Google client credentials and consent are now saved, and the credential is bound to all Gmail nodes. The owner later chose request-only trusted forwarding instead of requiring original authentication; use the policy below and complete the real login test.

The editor uses `N8N_PUSH_BACKEND=sse` because its WebSocket connection in the in-app browser failed before manual execution could start. The supported streaming mode resolved that failure; authentication and origin validation remain enabled. A header-only check subsequently completed in the editor and read four messages. No message body, snippet or OTP was requested.

Avoid running a second n8n CLI **execution** alongside the production service on this 1 GB VM. A temporary one-off check timed out after 180 seconds and coincided with database connection timeouts. The one-off container was stopped; SQLite quick-check passed, a fresh private backup captured the saved Gmail connection, and n8n was restarted/recreated during recovery and the transport update. Both `/healthz` and `/healthz/readiness` recovered to 200. Use the existing editor for manual checks, and use database-aware readiness after maintenance. Imports/exports were separately verified, but should still be done with a current private backup and minimal concurrent load.

## Owner-selected request-only forwarding

The owner wants the existing Hotmail Redirects read from central Gmail, including Spam, despite failed original DMARC. `requestOnly: true` and `allowRequestedRedirects: true` enable this narrow policy. Only an exact confirmed recipient and a body username with an active signed Field Desk request can deliver. No broad scans run while idle, no Hotmail credentials are needed, and a fresh successful delivery closes the account window.

On the existing automation VM, back up n8n and worker data, then run `python3 automation/scripts/enable-requested-redirects.py` from the repository root. It privately backs up `.env`, changes only mailbox policy flags, and preserves keys, mailbox ID and source addresses. Deploy the reviewed worker sources and recreate `otp-worker`. Publish the **existing** central Gmail workflow (`fd9028ce8403b27a`) with its saved credentials. CLI publishing requires restarting n8n for the scheduled trigger to take effect; see [n8n CLI documentation](https://docs.n8n.io/hosting/cli-commands/). The mock demo and metadata check remain inactive; the signed webhook remains published.

Verify idle due=false and successful scheduled executions without any mailbox lookup; then have the owner press Get code and perform a real Steam login. Never print message bodies/codes in that check. A normal production readiness run no longer opens an account window.

Current VM activation is confirmed: worker policy flags true, two preserved source addresses, Gmail and signed webhook published, all three Gmail credential bindings retained, Spam included and payload persistence disabled. Scheduled successes and idle due=false were checked. After restart warm-up, readiness/HTTPS/accounts returned 200 and invalid-signature probes were rejected. A private pre-change backup is under `automation/data/backups/requested-mode-*/`. The first owner-assisted Hotmail Redirect → Gmail Spam → Field Desk card test succeeded; its request window closed after delivery. Other sources/layouts remain to be tested.

## Updating for the PR #21 lookup contract

Back up the current n8n database, settings, ledger and worker sources privately. The updated worker supports old calls, but newest-message selection also requires updating the existing Gmail workflow: sequential fetch loop → Aggregate All Item Data → `/process-batch` with captured requestIds → sequential mark-read loop. Preserve its workflow ID, project, credentials, mailbox ID and execution privacy settings; import/publish only that workflow, then restart n8n for the schedule change. The signed raw-body webhook definition does not change, and close events use the same URL/secret. Restart the worker after source changes. Do not recreate credentials or rotate settings.

Verify health/readiness, active workflow/credential metadata, idle due=false, and a correctly signed unknown-request close (202, duplicate 200, modified bytes 401). That close probe opens no mail lookup and posts no OTP. Use the mock for synthetic deliveries. Then have the owner test Get code → live code → Logged in → Check for new code, including a newly emailed identical code if Steam sends one. The new flow's real multi-PC UX acceptance remains separate from synthetic tests.

31 October IST deployment: this update is installed and the existing Gmail workflow is published with its credential bindings/privacy settings retained. Private backup and before-import definition were saved first. After startup warm-up, readiness/HTTPS/API and signed close/deduplication/tamper probes passed; no code lookup or OTP submission was generated by the probes. The new UX's real multi-PC acceptance remains owner-assisted.
