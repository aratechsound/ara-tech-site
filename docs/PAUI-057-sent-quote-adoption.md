# PAUI-057 — already-delivered quote adoption candidate

Based on PAUI-056 `42a569bd3fd8bab46efcff5f985cf9f58e5fbf93`, preserving PR #29 and its accepted attachment design. This Task authorizes Source, isolated DB/browser validation, CI and Preview only. Production, main merge, Production DB changes, real sends and real-case commercial decisions are forbidden. PAUI-056 records are unchanged.

## Entry and identity

The typed estimate PDF viewer keeps the existing action and adds registration review when the formal registration is missing. Estimate history also offers explicit original selection for older sent PDFs; this does not bulk-classify attachments or rewrite metadata. Normal attachments and invoice actions keep their existing behavior.

The new commercial actions reuse the existing Owner authentication, case guards, Origin policy and rate limit. Every review independently uses PAUI-051/054's Gmail/index/part binary reader and PDF amount extractor. Typed attachments additionally require the PAUI-046 SENT operation and verified ACK/original binding. Manual original selection cannot bypass a SENDING/UNKNOWN operation on the same case/thread. No Gmail mutations or transport are used.

Automatic approval selection is bounded and requires the customer account, same case, indexed message/thread, chronology, original RFC reply reference and affirmative unquoted text. Incomplete/ambiguous scans do not complete. The Owner can select another same-case received original, including another thread. An unmatched RFC reference is explicitly `owner_reviewed`, never automatically `verified`: a separate relation checkbox and a reason of 10–2000 characters are required. Clearly negative replies are rejected. Changing the selected approval clears the manual confirmation.

## Before and after a contract

Before a contract, the proposed atomic RPC calls the existing `pa_v5_import_sent_estimate(...,'current',...)` and appends immutable Owner/approval registration evidence. This registers a current estimate, not an accepted contract. Existing recovery protections and stale-state checks remain in force.

After a contract, the proposed RPC imports the exact already-delivered PDF into a new `change_order` revision, records genuine delivery evidence using the existing immutable delivery reader, creates an agreed change under the new already-delivered-original contract, and appends or reuses PAUI-054's Owner evidence within one transaction. It creates **no outbox, send ACK, confirmation, contract or receipt**. The existing create-change-proposal and record-change-agreement contracts are unchanged and still require their managed send.

The PDF stores its stated revised **total**. The change ledger stores the separately entered **additional amount**. The Owner must explicitly confirm both, the tax basis and that this PDF contains a revised total. The RPC verifies `prior agreed total + additional amount = revised total = PDF amount`. It does not infer an additional charge from the revised total. Original contract snapshots/current contract pointers are not overwritten. Existing PAUI-054 evidence is reused only on exact contract hash, message/thread/part/SHA, approval identities, amount and tax basis; its original JSON is not rewritten.

The bounded post-contract path supports a positive increase, a total-bearing PDF, one contract, JPY, the same tax-inclusive or tax-exempt basis, no existing billing/settlement, and no unresolved change/send. Delta-only PDFs, decreases/zero changes, post-contract tax-exclusive/foreign-currency cases, already-imported ambiguous originals and multiple contracts fail closed for individual review. They are not silently converted. Pre-contract registration retains existing tax-exclusive support.

## Proposed database contract

`ops/PAUI-057-sent-quote-adoption.sql` adds one immutable RLS table and one service-role-only RPC with an empty search path and the existing administrator check. No existing function, constraint, grant or row is altered by installation. PUBLIC/anon/authenticated cannot execute it or access the table. Its use after a future approval will append a document/revision/delivery proof/change/registration/audit and advance the commercial revision; pre-contract use retains the existing current-import behavior. Installation permission and permission to operate on a real case are separate.

The existing PAUI-056 reader proposal remains a separate dependency for discovering attachment classification from persisted send operations. Neither SQL file has been applied to Production. Missing tables/RPCs disable completion explicitly. Preview Origin/auth/ACL/rate settings are unchanged; adding Origin alone can enable existing technical DB writes and is not treated as a read-only change.

## Atomicity and result uncertainty

The case row and commercial revision are locked/rechecked. Unique operation and original-identity constraints prevent duplicate registration. The entire new registration, legacy recovery/change evidence and audit are one database transaction. Injected failures after commercial inserts roll everything back.

Source fingerprints bind the Owner, original, approval, amounts, current commercial revision and prior evidence. The browser invalidates the prepared model on edits and permits one final Yes. After an uncertain response it only offers status reading. Reloaded clients find the immutable registration and read its result; they do not resend or repeat the business mutation. Both the formal revision/delivery proof and the Owner/change evidence must read back before completion is shown.

## Evidence boundaries

Tests use isolated PostgreSQL/PGlite fixtures and the actual CASE DESK modules with mocked APIs. They verify pre/post-contract paths, preserved PAUI-054 evidence, amount semantics, original/approval rejection, manual separate-thread confirmation, immutable/atomic/replay behavior, existing invoice SHA matching without billing writes, authentication/Origin/rate guards, response loss, reload, responsive layout and logout clearing. Production business acceptance, SQL application and real Provider sends are not implied by these tests.

Owner reported PAUI-056's attachment design accepted. New PAUI-057 workflow acceptance is separate and pending. Production remains protected; the SQL proposals and their exact hashes must be reviewed before any installation.
