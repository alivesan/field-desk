# Automation deployment

This directory prepares the OTP automation. The local stack uses synthetic mock accounts and codes. Nothing here starts or changes the Field Desk service.

## Local phase C

1. Copy `.env.example` to `.env` here and fill `N8N_ENCRYPTION_KEY`, `WORKER_TOKEN`, `FD_API_KEY`, and `FD_WEBHOOK_SECRET` with independent, random values. The included `MAILBOXES` entry represents one central Gmail inbox; its `trustedForwarders` list remains empty until the owner supplies four exact source addresses. Leave `PRIVATE_IP` and `N8N_DOMAIN` blank for local use, and leave `FIELD_DESK_BASE_URL` commented out. `.env` is ignored by Git.
2. From this directory run `docker compose -f compose.local.yaml config --quiet`, then `docker compose -f compose.local.yaml up -d`.
3. Open n8n at `http://127.0.0.1:5678` and the synthetic mock display at `http://127.0.0.1:8790/mock/store`. The worker is reachable only to other containers at `http://otp-worker:8787`.

The `automation` directory is mounted read only at `/app`; the worker saves its state in a separate Docker volume at `/data/state.json`. The mock keeps demo data in memory. The n8n image is pinned to [stable 2.44.6](https://github.com/n8n-io/n8n/releases/tag/n8n%402.44.6), released 22 October 2026. Upgrade by choosing and testing a new explicit version, then changing both Compose files together.

## Oracle Ubuntu 24.04 preparation

For initial acceptance testing, use `-f compose.yaml -f compose.mock.yaml -f compose.bootstrap.yaml` and start only `n8n otp-worker mock`. The VM has completed this stage and now runs compose.yaml plus compose.mock.yaml, without the bootstrap override. Owner setup is complete and https://n8n.129-225-72-140.sslip.io/healthz returns 200 with verified TLS. A private pre-HTTPS n8n volume backup and environment snapshot are in ignored automation/data/backups/. The bootstrap override binds n8n to loopback, uses temporary HTTP cookies, and runs without Caddy. Connect through an SSH tunnel forwarding local 5678 to remote `127.0.0.1:5678`; n8n `/healthz` was verified on VM loopback and through the tunnel. For a fresh installation, let the owner complete the profile before starting Caddy. The mock override publishes its preview only at VM localhost port 8790; the private demo tunnel forwards PC localhost port 8791 to that port. Open http://localhost:8791/mock/store for synthetic cards. Remove the bootstrap override before HTTPS operation; remove the mock override only after the real API is approved. Never launch Caddy with the bootstrap override. All stages share the same persistent volumes. Central Gmail OAuth has not been configured, and its workflow remains disabled.

Use a host with an assigned `10.0.0.0/16` private IPv4 address. Choose `N8N_DOMAIN=n8n.<public-ip-with-dots-replaced-by-dashes>.sslip.io` and confirm that it resolves to the host's public IPv4. In the Oracle security list or network security group, allow public TCP 80 and 443, retain the existing SSH rule, and allow TCP 5678 only from `10.0.0.0/16`. Restrict SSH to your own source address if that is your existing policy.

The Oracle Always Free VM `field-desk-automation` is already created at public IPv4 `129.225.72.140` and private IPv4 `10.0.0.230`. Docker 29.9.2, Compose 5.6.1 and 2 GB swap were confirmed active on 29 October 2026. `setup.sh` remains the reproducible Ubuntu 24.04 preparation script. It installs Docker from its official repository, adds swap only when needed, and inserts persistent port rules without flushing existing firewall or SSH rules. Its persistent rule now allows loopback TCP 5678 for the SSH tunnel before dropping non-private sources. The machine firewall was updated; Oracle's shared ingress rules were not changed. Check `sudo systemctl status fielddesk-automation-firewall.service`, `sudo iptables -S INPUT`, and `sudo iptables -S DOCKER-USER` after Docker restarts. Confirm Oracle ingress and host firewall allow public 80/443 and private 5678 only as intended.

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

The optional `--n8n` mode passed through the actual published n8n webhook: valid signed request 202, duplicate 200, modified body 401. It verifies raw-body HMAC and response status forwarding through n8n. It can be repeated from `automation/deploy` with `sudo docker compose -f compose.yaml -f compose.mock.yaml -f compose.bootstrap.yaml exec -T otp-worker node /app/scripts/check-runtime.mjs --n8n`. The synthetic demo also returned `status: delivered` and `SUCCESS` through n8n CLI. Keep the mock endpoint in place. n8n currently uses `N8N_WEBHOOK_URL` rather than the deprecated `WEBHOOK_URL` setting, and production execution concurrency is capped at two.

For a fresh production installation, create a private `.env` containing all four random secrets, the one central Gmail `MAILBOXES` entry with the owner's four exact `trustedForwarders` addresses, `PRIVATE_IP`, `N8N_DOMAIN`, and `FIELD_DESK_BASE_URL`. **The owner must authorize use of `https://fieldesk.runs-at.dev/api/v1` before setting it or activating any live workflow.** Do not configure the source accounts to forward until the owner confirms them. Check the values with `docker compose -f compose.yaml config --quiet`, then start only after authorization with `docker compose -f compose.yaml up -d`. Caddy obtains HTTPS for the supplied domain. n8n publishes 5678 on the private IP, while the worker has no published port.

Keep `N8N_ENCRYPTION_KEY` stable: n8n credentials cannot be decrypted after a key change. Back up the `.env` securely along with the `n8n_data` and `worker_data` Docker volumes before upgrades. Stop the stack or use a consistent snapshot when backing up the volumes; test restoration separately. Execution payload persistence is disabled in both Compose files to avoid retaining OTP values, but workflow definitions and credentials remain in n8n's persistent volume. Keep n8n's owner login secured and review workflows before activation.

On the existing VM, retain the current .env and N8N_ENCRYPTION_KEY when moving from mock to live. Change only the approved Field Desk configuration and account allowlist; do not generate a new encryption key. The current HTTPS stage uses docker compose -f compose.yaml -f compose.mock.yaml up -d. The Gmail workflow remains disabled and both private tunnels remain available.
