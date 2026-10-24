# Automation deployment

This directory prepares the OTP automation. The local stack uses synthetic mock accounts and codes. Nothing here starts or changes the Field Desk service.

## Local phase C

1. Copy `.env.example` to `.env` here and fill `N8N_ENCRYPTION_KEY`, `WORKER_TOKEN`, `FD_API_KEY`, and `FD_WEBHOOK_SECRET` with independent, random values. The included `MAILBOXES` list supplies two synthetic Gmail and Outlook identifiers. Leave `PRIVATE_IP` and `N8N_DOMAIN` blank for local use, and leave `FIELD_DESK_BASE_URL` commented out. `.env` is ignored by Git.
2. From this directory run `docker compose -f compose.local.yaml config --quiet`, then `docker compose -f compose.local.yaml up -d`.
3. Open n8n at `http://127.0.0.1:5678` and the synthetic mock display at `http://127.0.0.1:8790/mock/store`. The worker is reachable only to other containers at `http://otp-worker:8787`.

The `automation` directory is mounted read only at `/app`; the worker saves its state in a separate Docker volume at `/data/state.json`. The mock keeps demo data in memory. The n8n image is pinned to [stable 2.44.6](https://github.com/n8n-io/n8n/releases/tag/n8n%402.44.6), released 22 October 2026. Upgrade by choosing and testing a new explicit version, then changing both Compose files together.

## Oracle Ubuntu 24.04 preparation

Use a host with an assigned `10.0.0.0/16` private IPv4 address. Choose `N8N_DOMAIN=n8n.<public-ip-with-dots-replaced-by-dashes>.sslip.io` and confirm that it resolves to the host's public IPv4. In the Oracle security list or network security group, allow public TCP 80 and 443, retain the existing SSH rule, and allow TCP 5678 only from `10.0.0.0/16`. Restrict SSH to your own source address if that is your existing policy.

After reviewing `setup.sh`, copy the repository to the host and run `sudo PRIVATE_IP=10.0.x.x bash automation/deploy/setup.sh`. The script installs Docker from its official Ubuntu repository, adds 2 GB swap only when total swap is below 2 GB, and installs persistent port rules. It inserts rules without flushing existing firewall rules or altering SSH access. It does **not** start the containers. Check `sudo systemctl status fielddesk-automation-firewall.service`, `sudo iptables -S INPUT`, and `sudo iptables -S DOCKER-USER` after setup and after a reboot. Confirm public 80/443 and private 5678 access from the appropriate networks before starting.

For production, make a separate `.env` containing all four random secrets, the intended `MAILBOXES` identifiers, `PRIVATE_IP`, `N8N_DOMAIN`, and `FIELD_DESK_BASE_URL`. **The owner must authorize use of `https://fieldesk.runs-at.dev/api/v1` before setting it or activating any live workflow.** Check the values with `docker compose -f compose.yaml config --quiet`, then start only after authorization with `docker compose -f compose.yaml up -d`. Caddy obtains HTTPS for the supplied domain. n8n publishes 5678 on the private IP, while the worker has no published port.

Keep `N8N_ENCRYPTION_KEY` stable: n8n credentials cannot be decrypted after a key change. Back up the `.env` securely along with the `n8n_data` and `worker_data` Docker volumes before upgrades. Stop the stack or use a consistent snapshot when backing up the volumes; test restoration separately. Execution payload persistence is disabled in both Compose files to avoid retaining OTP values, but workflow definitions and credentials remain in n8n's persistent volume. Keep n8n's owner login secured and review workflows before activation.
