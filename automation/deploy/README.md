# Automation deployment

This directory prepares the OTP automation. The local stack uses synthetic mock accounts and codes. Nothing here starts or changes the Field Desk service.

## Local phase C

1. Copy `.env.example` to `.env` here and fill `N8N_ENCRYPTION_KEY`, `WORKER_TOKEN`, `FD_API_KEY`, and `FD_WEBHOOK_SECRET` with independent, random values. The included `MAILBOXES` entry represents one central Gmail inbox; its `trustedForwarders` list remains empty until the owner supplies four exact source addresses. Leave `PRIVATE_IP` and `N8N_DOMAIN` blank for local use, and leave `FIELD_DESK_BASE_URL` commented out. `.env` is ignored by Git.
2. From this directory run `docker compose -f compose.local.yaml config --quiet`, then `docker compose -f compose.local.yaml up -d`.
3. Open n8n at `http://127.0.0.1:5678` and the synthetic mock display at `http://127.0.0.1:8790/mock/store`. The worker is reachable only to other containers at `http://otp-worker:8787`.

The `automation` directory is mounted read only at `/app`; the worker saves its state in a separate Docker volume at `/data/state.json`. The mock keeps demo data in memory. The n8n image is pinned to [stable 2.44.6](https://github.com/n8n-io/n8n/releases/tag/n8n%402.44.6), released 22 October 2026. Upgrade by choosing and testing a new explicit version, then changing both Compose files together.

## Oracle Ubuntu 24.04 preparation

For initial acceptance testing, use `-f compose.yaml -f compose.mock.yaml -f compose.bootstrap.yaml` and start only `n8n otp-worker mock`. The bootstrap override binds n8n to loopback, uses temporary HTTP cookies, and runs without Caddy. Connect through an SSH tunnel forwarding local 5678 to remote 127.0.0.1:5678, and let the owner complete account setup directly. The mock has no host port; forward local 8790 to its container IP if a synthetic card preview is needed. Remove the bootstrap override before HTTPS operation; remove the mock override only after the real API is approved. Never launch Caddy with the bootstrap override. All stages share the same persistent volumes. The owner has not yet completed n8n setup or central Gmail OAuth.

Use a host with an assigned `10.0.0.0/16` private IPv4 address. Choose `N8N_DOMAIN=n8n.<public-ip-with-dots-replaced-by-dashes>.sslip.io` and confirm that it resolves to the host's public IPv4. In the Oracle security list or network security group, allow public TCP 80 and 443, retain the existing SSH rule, and allow TCP 5678 only from `10.0.0.0/16`. Restrict SSH to your own source address if that is your existing policy.

The Oracle Always Free VM `field-desk-automation` is already created at public IPv4 `129.225.72.140` and private IPv4 `10.0.0.230`. Docker 29.9.2, Compose 5.6.1 and 2 GB swap were confirmed active on 29 October 2026; no containers had started at that checkpoint. `setup.sh` remains the reproducible Ubuntu 24.04 preparation script. It installs Docker from its official repository, adds swap only when needed, and inserts persistent port rules without flushing existing firewall or SSH rules. Before first startup, check `sudo systemctl status fielddesk-automation-firewall.service`, `sudo iptables -S INPUT`, and `sudo iptables -S DOCKER-USER`. Confirm Oracle ingress and host firewall allow public 80/443 and private 5678 only as intended.

For production, make a separate `.env` containing all four random secrets, the one central Gmail `MAILBOXES` entry with the owner's four exact `trustedForwarders` addresses, `PRIVATE_IP`, `N8N_DOMAIN`, and `FIELD_DESK_BASE_URL`. **The owner must authorize use of `https://fieldesk.runs-at.dev/api/v1` before setting it or activating any live workflow.** Do not configure the source accounts to forward until the owner confirms them. Check the values with `docker compose -f compose.yaml config --quiet`, then start only after authorization with `docker compose -f compose.yaml up -d`. Caddy obtains HTTPS for the supplied domain. n8n publishes 5678 on the private IP, while the worker has no published port.

Keep `N8N_ENCRYPTION_KEY` stable: n8n credentials cannot be decrypted after a key change. Back up the `.env` securely along with the `n8n_data` and `worker_data` Docker volumes before upgrades. Stop the stack or use a consistent snapshot when backing up the volumes; test restoration separately. Execution payload persistence is disabled in both Compose files to avoid retaining OTP values, but workflow definitions and credentials remain in n8n's persistent volume. Keep n8n's owner login secured and review workflows before activation.
