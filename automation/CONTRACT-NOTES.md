# Contract notes for Claude — Steam OTP milestone

Only automation/ is changed. No application changes are made by this branch.

As of 30 October 2026, the Oracle n8n/worker/Caddy stack targets the authorized live API at `https://fieldesk.runs-at.dev/api/v1`; the mock container is removed. HTTPS health and the private webhook signature probes pass. The owner/Claude privately merged the VM-generated `FD_STEAM_*` variables into Field Desk; the authenticated account API returned 200 and a wrong key returned 401. Host and container reachability and an actual Request code event have been verified. No live OTP was submitted. Central Gmail OAuth, exact forwarding addresses and real Steam samples remain pending; Gmail polling is disabled.

## Contract reviewed: PR #16

The source of truth is [docs/steam-otp-api.md](../docs/steam-otp-api.md). The requested scope, idempotency, expiry, ordering, assignment, error and privacy details are now documented. No further app contract change is required for the current hookup.

- The dedicated `FD_STEAM_API_KEY` has fixed scopes `steam-accounts:read` and `steam-otp:write`. The worker sends bearer auth without session cookies. Account aliases `username` and `email` match the worker's existing input shape; `active` describes an unexpired OTP, not assignment.
- The worker's `steam-email-<sha256(mailbox ID + provider message ID)>` idempotency header fits the documented ASCII limit. Successful retries are durable for 48 hours and do not extend expiry. Expiry is original `receivedAt + 10 minutes`, with at most 30 seconds future skew.
- Older/conflicting results and unassigned accounts are rejected by Field Desk. Worker non-2xx handling remains a bounded retry until mail expiry with a sanitized `fielddesk_unavailable` issue. More specific error reporting is a later worker improvement; `not_assigned` can clear when HQ assigns the account.
- No OTP bodies or authorization material are logged by the automation. The app contract documents equivalent API/proxy behavior. No real-code integration test is claimed yet.

Private handoff file on the automation VM: `/home/ubuntu/field-desk/automation/data/private/fielddesk-otp-production.env` (600). It holds app variable names `FD_STEAM_API_KEY`, `FD_STEAM_WEBHOOK_SECRET`, `FD_STEAM_WEBHOOK_URL`. Owner/Claude has transferred and merged these privately into the existing app environment and restarted its service. Do not send values through chat. Automation `FD_API_KEY` and `FD_WEBHOOK_SECRET` already match those generated values; existing n8n encryption and worker keys are preserved.

## Request webhook

The published private destination is `http://10.0.0.230:5678/webhook/steam-request`. The VM listener and persistent host firewall are active. Under the owner's explicit 30 October authorization, Oracle's associated subnet security list now permits stateful TCP 5678 from `10.0.0.0/16` only; prior ingress and egress were preserved. No Field Desk VM configuration was changed. Public 5678 is blocked. The owner tested host and container reachability from Field Desk (`10.0.0.242`). A real Request code press on 30 October at `05:40:57.338Z` for store `n8lhdhtyh77k` was accepted at `05:40:58.249Z`. Its inferred polling boost began at `05:40:57.321Z` and expired at `05:50:57.321Z`.

Documented app payload: `{id,type:"steam.otp.requested",at,storeId,storeName,accountUsername,accountEmail?}`. UTF-8 JSON is signed byte-for-byte with `X-FieldDesk-Signature: sha256=<hex HMAC-SHA256>`.

Oracle destination: `http://<n8n-private-ip>:5678/webhook/steam-request`. The n8n workflow forwards raw bytes to the worker, which verifies HMAC before parsing. Acknowledge only after persisting the event ID and polling window. 202 means accepted; 200 duplicate; 401 bad signature; 400 malformed/stale event. Retry timeouts/5xx with backoff using the same event ID. Requests older than 10 minutes cannot restart the window. This is a polling hint, not a Steam login request: automation never logs in to Steam.

Field Desk's documented five-second attempt timeout and retry schedule are compatible with duplicate event IDs; worker account-directory reads currently allow ten seconds. A slow account read may therefore outlast the first app attempt, which will retry. If its key is unconfigured, well-formed signed account requests receive 503 rather than a false success. Verified production probes: private health 200, unsigned 401, signed malformed 400 and tampered body 401. The earlier mock integration verified valid 202 and duplicate 200; production authentication and an actual request event are now verified. Central Gmail configuration, real forwarding samples and actual OTP delivery remain pending.

There is one central Gmail inbox. A request opens a separate 10-minute account-name query window for the named Steam account, scanned at most every 15 seconds. The broad inbox scan remains at most once per 60 seconds on its own clock. A burst cannot suppress or reset the broad scan. Multiple requests share the scheduler and do not create a thread per request.

## Central Gmail forwarding evidence

Four source mailboxes will forward Steam mail to one central Gmail account. Their exact addresses are not yet supplied; owner confirmation is required before adding them to `trustedForwarders` or enabling forwarding. The worker reads only the central Gmail account. A direct/automatic forwarded message retaining Steam `From` needs Gmail-authenticated Steam sender evidence and the original provider `Date` header. A wrapped forward needs an exact trusted outer sender authenticated by Gmail plus unambiguous original Steam `From` and `Date` markers in the body. The original date, not central arrival, determines the 10-minute expiry. Real Gmail headers and both forwarded layouts must be checked with owner-provided samples before activating live delivery. Missing or contradictory evidence is rejected.

## Deferred tournament work

Workflow A/B are not implemented. Before those phases agree result source/origin IDs, revisions/conflict rules, participant ID mappings, structured scores, complete undo payloads, final/completion detection, and reopening after an undo. Toornament browser automation is a separate future feasibility test, not part of this release.
