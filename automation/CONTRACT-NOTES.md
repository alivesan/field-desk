# Contract notes for Claude — Steam OTP milestone

Only automation/ is changed. No application changes are made by this branch.

## Required before live delivery

1. **Scope:** define the exact scope for GET /steam/accounts. The supplied scope list includes `read`, `results:write`, `brackets:write`, `steam-otp:write`, but refers to an unspecified HQ scope. Return a bare array per spec. Use a separate HQ credential with only account-read + steam-otp:write access.
2. **Idempotency:** POST /steam/otp should accept `Idempotency-Key` and return a successful response for repeated identical submissions. The worker sends `steam-email-<sha256(mailbox ID + provider message ID)>`. A crash or lost response between the POST and local acknowledgement can otherwise cause a repeated POST. Email marking alone cannot close this gap. Retain keys at least 24 hours; reject key reuse for another payload.
3. **Expiry:** calculate card expiry from receivedAt + 10 minutes, not POST arrival. Reject stale timestamps and excessive future clock skew. Repeated requests must not extend expiry. Mock allows 30 seconds future skew.
4. **Ordering:** an older code must not replace a newer one; conflicting codes with identical receivedAt must fail safely. Worker serializes its processing but provider delivery order is not guaranteed.
5. **Assignments:** confirm assignedStoreId means the currently active weekend assignment. Return one unambiguous username record, and reject unassigned accounts at POST time too. Shared email addresses are allowed; fallback matching cannot disambiguate them without an account name.
6. **Errors:** document response bodies/status for delivered, duplicate, older-than-current, no assignment, permission failure and temporary outage. Current worker treats non-2xx as retryable until the email expires and records a sanitized issue.
7. **Privacy:** API/reverse proxy/application logging must redact OTP bodies and Authorization. Response must not echo the code. The automation disables execution payload retention; it cannot control Field Desk's logs.

## Request webhook

Expected payload: `{id,type:"steam.otp.requested",at,storeId,storeName,accountUsername?,accountEmail?}`. At least one account identifier is required. UTF-8 JSON is signed byte-for-byte with `X-FieldDesk-Signature: sha256=<hex HMAC-SHA256>`.

Oracle destination: `http://<n8n-private-ip>:5678/webhook/steam-request`. The n8n workflow forwards raw bytes to the worker, which verifies HMAC before parsing. Acknowledge only after persisting the event ID and polling window. 202 means accepted; 200 duplicate; 401 bad signature; 400 malformed/stale event. Retry timeouts/5xx with backoff using the same event ID. Requests older than 10 minutes cannot restart the window. This is a polling hint, not a Steam login request: automation never logs in to Steam.

For this small deployment a request accelerates all configured mailboxes to 15-second scans for the window. This covers accounts sharing mailboxes without guessing; ordinary scans are once per minute. Multiple requests share the scheduler and do not create a thread per request.

## Deferred tournament work

Workflow A/B are not implemented. Before those phases agree result source/origin IDs, revisions/conflict rules, participant ID mappings, structured scores, complete undo payloads, final/completion detection, and reopening after an undo. Toornament browser automation is a separate future feasibility test, not part of this release.
