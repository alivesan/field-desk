# Contract notes for Claude — Steam OTP milestone

Only automation/ is changed. No application changes are made by this branch.

## Required before live delivery

1. **Scope:** define the exact scope for GET /steam/accounts. The supplied scope list includes `read`, `results:write`, `brackets:write`, `steam-otp:write`, but refers to an unspecified HQ scope. Return a bare array per spec. Use a separate HQ credential with only account-read + steam-otp:write access.
2. **Idempotency:** POST /steam/otp should accept `Idempotency-Key` and return a successful response for repeated identical submissions. The worker sends `steam-email-<sha256(mailbox ID + provider message ID)>`. A crash or lost response between the POST and local acknowledgement can otherwise cause a repeated POST. Email marking alone cannot close this gap. Retain keys at least 24 hours; reject key reuse for another payload.
3. **Expiry:** calculate card expiry from receivedAt + 10 minutes, not POST arrival. Reject stale timestamps and excessive future clock skew. Repeated requests must not extend expiry. Mock allows 30 seconds future skew.
4. **Ordering:** an older code must not replace a newer one; conflicting codes with identical receivedAt must fail safely. Worker serializes its processing but provider delivery order is not guaranteed.
5. **Assignments:** confirm assignedStoreId means the currently active weekend assignment. Return one unambiguous username record, and reject unassigned accounts at POST time too. The worker requires a Steam username in every accepted email and never uses the forwarded recipient or central Gmail address to select an account. Shared addresses therefore do not authorize a guessed assignment.
6. **Errors:** document response bodies/status for delivered, duplicate, older-than-current, no assignment, permission failure and temporary outage. Current worker treats non-2xx as retryable until the email expires and records a sanitized issue.
7. **Privacy:** API/reverse proxy/application logging must redact OTP bodies and Authorization. Response must not echo the code. The automation disables execution payload retention; it cannot control Field Desk's logs.

## Request webhook

Expected payload: `{id,type:"steam.otp.requested",at,storeId,storeName,accountUsername?,accountEmail?}`. At least one account identifier is required. UTF-8 JSON is signed byte-for-byte with `X-FieldDesk-Signature: sha256=<hex HMAC-SHA256>`.

Oracle destination: `http://<n8n-private-ip>:5678/webhook/steam-request`. The n8n workflow forwards raw bytes to the worker, which verifies HMAC before parsing. Acknowledge only after persisting the event ID and polling window. 202 means accepted; 200 duplicate; 401 bad signature; 400 malformed/stale event. Retry timeouts/5xx with backoff using the same event ID. Requests older than 10 minutes cannot restart the window. This is a polling hint, not a Steam login request: automation never logs in to Steam.

There is one central Gmail inbox. A request opens a separate 10-minute account-name query window for the named Steam account, scanned at most every 15 seconds. The broad inbox scan remains at most once per 60 seconds on its own clock. A burst cannot suppress or reset the broad scan. Multiple requests share the scheduler and do not create a thread per request.

## Central Gmail forwarding evidence

Four source mailboxes will forward Steam mail to one central Gmail account. Their exact addresses are not yet supplied; owner confirmation is required before adding them to `trustedForwarders` or enabling forwarding. The worker reads only the central Gmail account. A direct/automatic forwarded message retaining Steam `From` needs Gmail-authenticated Steam sender evidence and the original provider `Date` header. A wrapped forward needs an exact trusted outer sender authenticated by Gmail plus unambiguous original Steam `From` and `Date` markers in the body. The original date, not central arrival, determines the 10-minute expiry. Real Gmail headers and both forwarded layouts must be checked with owner-provided samples before activating live delivery. Missing or contradictory evidence is rejected.

## Deferred tournament work

Workflow A/B are not implemented. Before those phases agree result source/origin IDs, revisions/conflict rules, participant ID mappings, structured scores, complete undo payloads, final/completion detection, and reopening after an undo. Toornament browser automation is a separate future feasibility test, not part of this release.
