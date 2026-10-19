# PAUI-056 attachment documents candidate

Based on the published PAUI-055 source, including the unmerged PAUI-054/055 history. This candidate is for isolated validation and Owner Preview only; Production publication, main merge, Production SQL, real sends and real commercial decisions are not authorized.

Each reply attachment defaults to normal. An explicit estimate/invoice PDF type is included in the existing preview attachment hash and immutable reply-operation binding. Explicit normal and legacy attachment hashes are unchanged. PDF bytes are validated before preparation. Provider ACK/UNKNOWN handling and the once-only claim remain unchanged.

The additional list reader is a proposed service-only, Owner/case/actor scoped SELECT of existing operation bindings. `ops/PAUI-056-document-read.sql` is **not applied to Production**. It adds one read-only RPC, no table or row changes. Without that approved reader, sent-attachment classification is explicitly unconfirmed; no filename heuristic or browser-storage fallback is used. Approval is required before installation.

Sent document actions independently verify the persisted ACK, Gmail original, reply-source attribution, recipient/body/all attachment bytes and the case index MIME parts. UNKNOWN never supplies a verified document. Invoice matching reads an existing billing document SHA; missing or multiple billing records remain distinct and never create an invoice or payment.

Estimate review uses the existing evidence service and mail-row/body renderer. The automatic approval scan is bounded to ten indexed inbound messages; incomplete or multiple results cannot auto-confirm. The Owner may select one of at most twenty same-case inbound messages. Selecting and cancelling only read data.

Formal completion additionally requires exactly one identical registered estimate, the matching parent contract/change series, one agreed change order with matching registered amount, and one sent managed change-proposal job. The existing append-only evidence writer and fingerprint/previous-event guard are reused only after those checks. A saved matching adoption is returned without a second append.

## Deliberate HOLD: importing an already-sent post-contract PDF

The current V5 create-change-proposal RPC inserts a new estimate/document/change order **and a new send job**. Its agreement RPC requires that managed job to be sent. `recoverEstimate(current)` remains prohibited after a contract; `historical` import does not establish a change agreement. This candidate does not fabricate a sent job, resend an old PDF, overwrite a contract, reinterpret a revised total as an additional charge, or change that state machine. A separate bounded Owner decision and a suitable existing/dedicated contract are required to bridge previously sent PDFs safely. The UI reports the missing formal registration/change ledger rather than completing adoption.

Past untyped attachments stay normal/unclassified. No bulk classification or metadata rewrite is included. A separately approved append-only historical classification facility remains a possible follow-up within this Task.

## Validation boundaries

Existing baseline tests and their expected values are preserved. Added isolated SQL/API/CASE DESK tests cover types, original verification, missing registration, invoice distinction, approval selection/cancel, once-only adoption of a fixture with an already valid managed change, responsive layout and case/logout clearing. No real Provider sends or Production business writes are used. Mocked managed-delivery setup is explicitly fixture-only and is not proof that the held historical-import path works.
