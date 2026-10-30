# Steam OTP review — 30 October 2026

Scope: automation only, reviewed by three Sol sub-agents and the parent agent. No Field Desk application files, secrets, production workflows or server settings were changed during this audit.

## Verified production foundation

- The owner/Claude privately installed the matching production settings in Field Desk. Authenticated account read returned 200; the owner checked that a wrong key returns 401.
- The real Request code press was accepted and persisted at `2026-10-30T05:40:58.249Z`. Its account window matched the reported store assignment, with an inferred signed event time of `05:40:57.321Z` and expiry `05:50:57.321Z`. No OTP was submitted by the readiness checks.
- A fresh read-only VM check found n8n, Caddy and the worker running; public HTTPS health returned 200 with certificate verification, and the persistent firewall service was active. The signed webhook workflow is active; Gmail and the synthetic demo are inactive.
- At the resource snapshot, n8n used about 299 MiB, the worker 11 MiB and Caddy 17 MiB. The host reported 297 MiB available RAM, 482 MiB of 2 GiB swap used, and 37 GiB free disk. This is a health snapshot, not a mailbox load test.

## Fixes prepared in this review

| Finding | Change and verification |
|---|---|
| Quoted forwarded lines passed header checks but a quoted standalone code was missed. | Use the same quotation-normalized text for forwarded header, username and code extraction. Synthetic quoted forwards now pass; ambiguous codes still fail. |
| Capitalized `Code` labels were rejected. | Match labels without case sensitivity, while requiring the extracted code itself to remain exactly five uppercase alphanumeric characters. Lowercase and mixed-case code regressions fail closed. |
| n8n allowed ten seconds for a worker operation whose two API requests could each take ten seconds. Multiple messages could accumulate concurrently in the worker queue. | Allow thirty seconds for `/process` and wrap each message fetch/process/mark sequence in Loop Over Items, batch size one. Both accepted and rejected paths advance the loop. Gmail provider calls retain ten-second timeouts. |
| The production readiness command exited successfully for failed authentication or an unconfigured API. | Fail by default on 401/503. An explicit bootstrap-only `--allow-pending` tolerates 503, returns `ready: false`, and never hides 401. Stub tests check both failures and correctly signed acceptance/deduplication. |
| Copying JSON files did not update workflows already stored in n8n. | Document editing the existing workflows while preserving workflow IDs, credential bindings and activation, plus rollback. |
| A real forwarded Steam email landed in Spam, which the Gmail listing did not explicitly include. | Set Gmail API `includeSpamTrash=true` and add `-in:trash` to the worker query. This includes Spam without collecting deleted mail; authentication and all delivery checks still apply. The owner's screenshot shows an unauthenticated-sender warning, so its actual headers still need local validation before delivery. |

Additional recovery test: the mock commits a result, its reply is deliberately lost, and the worker restarts. Retrying uses the identical idempotency key, preserves original expiry, and persists no OTP body or key in its ledger.

Validation: **38 Node tests and 2 Python setup tests pass**; deterministic exports and whitespace checks pass. Loop parameter names and output ordering were checked against the pinned n8n source. A separate, read-only manual diagnostic now runs against the saved Gmail credential, fetching authentication metadata only and showing booleans/counts. The delivery loop still has structural tests; it has **not** yet processed multiple real Gmail pages or a production mailbox batch.

These audit fixes from PR #17 are **now deployed to the running VM**, including the later Spam-scanning change. Before deployment, a consistent online n8n database backup, previous workflow export and source snapshot were saved privately on the VM. The existing inactive Gmail workflow was updated with the installed n8n CLI, preserving its ID, project and every existing credential binding; its imported nodes and inactive state were checked directly. Only the worker was recreated. The webhook stayed active; a new production check passed health/signature probes, account API 200, and accepted/deduplicated polling hints without submitting an OTP. Copying workflow JSON and restarting Compose alone would not update n8n's database.

## Before enabling delivery

Connection setup is complete: the owner privately created the Google client, approved access, and n8n displayed Account connected with no pending changes. Saved credential metadata and all three Gmail node bindings were verified. The header-only test found four Steam messages: three had a unique receiving Gmail header without Steam-aligned DMARC pass, plus a separate earlier forwarding result; one had a single Google header with Steam-aligned pass. Diagnostic pass flags now require exactly one Google receiving header and cannot combine different servers' results. The delivery worker's fail-closed policy is unchanged. The four original source addresses and current Hotmail forwarding mode are awaiting owner confirmation.

The editor's in-app-browser WebSocket failed before manual execution began; supported SSE transport resolved it without disabling authentication or origin validation. A concurrent one-off n8n CLI execution timed out and was stopped. The main service briefly reported database readiness failures; a fresh private backup and successful SQLite quick-check preceded recovery. Health and database readiness returned 200. Future manual checks on this small VM should use the existing editor rather than a second n8n execution process.

1. Supply the four exact source addresses and confirm them in the forwarder allowlist. Do not paste credentials or email contents into chat. The one central Gmail is already connected; complete its long-term Google app/token setup before unattended use.
2. Configure forwarding from the two Gmail and two Hotmail accounts. Check arrival from all four; record sanitized fixtures for each distinct automatic/wrapped layout. Current fixtures are synthetic and cannot establish real provider compatibility.
3. Validate original sender authentication, original timestamps, explicit Steam username and the login/new-device formats. Keep strict validation; fix supported layouts from evidence rather than weakening it.
4. With the owner performing a real Steam login, verify the code reaches the assigned store card. Then verify duplicate handling, expiry, a delayed/retried delivery, and a multi-message batch. Use the mock for synthetic failure scenarios.
5. Choose the HQ alert destination and authorize it before enabling messages to people. Current issues are local, sanitized records only.

## Follow-up improvements

- Narrow worker bind mounts to required sources. Currently the whole automation directory is mounted read-only into the worker, which also makes unrelated deployment secrets and backups readable from that container. No exploit was demonstrated, but the boundary can be improved.
- Perform a private backup-and-restore drill for n8n credentials, the unchanged encryption key and worker ledger; add sanitized health alerts after the owner chooses a destination.
- Classify permanent Field Desk errors separately from temporary outages, while preserving retries for a temporarily unassigned account. Current retries stop at mail expiry and never mark failed mail as delivered.
- Test slow API responses and overlapping workflow executions. The new loop sequences messages within one execution; separate executions still share the worker's queue. A slow operation can delay a webhook beyond Field Desk's five-second attempt timeout, so its documented retries remain necessary.
- Direct Outlook polling is outside this design. An unused Outlook normalization branch does not satisfy the Gmail-specific authentication/date checks; all four sources must forward into the one supported Gmail inbox.

Tournament workflows A/B remain deferred. This review does not establish Toornament write access or implement tournament synchronization.
