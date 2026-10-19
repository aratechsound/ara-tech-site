# PAUI-058 preproduction audit candidate

The PAUI-057 Source `87c945fa5f99030236f8f5854b09e60748773293`,
PR #30 and its 366 checks remain the protected baseline. This branch changes
only the already-delivered quote registration gate and adds isolated audits.
No Production application, Origin change, send, delivery reconciliation,
contract replacement or real-case adoption is authorized here.

## Independent SQL decisions

Original A, `ops/PAUI-057-sent-quote-adoption.sql`, SHA256
`e36ab87ad98dd867e694178976f2fbe3409f9e4212799be58687236ecc795779`,
is unchanged. Its installation is additive/transactional with appropriate
service-role-only RPC/RLS, but its case-wide UNKNOWN condition blocks even
an explicitly replaced, revoked confirmation after a later accepted contract.
Recommendation: **HOLD the exact original A** for this workflow. Do not
install it and then silently replace its function.

Original B, `ops/PAUI-056-document-read.sql`, SHA256
`913cf91d88b404f641f5825752f110e864a1a4e8f566655a83b4710cb29f475b`,
is unchanged and independent. It is a STABLE read-only Owner/case/account
reader restricted to service_role. It returns the latest operation state,
including UNKNOWN, and does not infer original verification or send success.
It limits results to 21 so the existing client can detect truncation.
Recommendation: **GO for separately approved installation only**, subject
to fresh absence/schema/hash checks. This is not authority to deploy Source
or use business actions. Neither SQL has been applied by PAUI-058.

Both installation scripts use explicit BEGIN/COMMIT and CREATE (not replace).
A repeated installation refuses and rolls back without changing the previous
definition; an operator must read back after an ambiguous result, never retry
blindly. Fault injection verifies no partially created callable/RLS object.

## Alternative to original A

`ops/PAUI-058-sent-quote-adoption.sql` is a **complete alternative**, generated
from the unchanged A plus the bounded read-only gate in
`ops/PAUI-058-delivery-gate.sql`. Install the complete alternative only if its
new exact hash and expanded function inventory are separately approved.
Do not install A and the alternative together; do not apply the helper file
as an implied partial approval. New inventory: the same immutable registration
table/RPC plus one STABLE, service-role-only, Owner-checked read-only gate.
No existing function/constraint/role grant is replaced or relaxed.

Only an UNKNOWN `confirmation` for an earlier offer can be classified as
`REVOKED_EXPLICIT_REPLACEMENT_ACCEPTED`. All conditions are required:

- Exactly one accepted contract for this case; earlier offer has no contract.
- Earlier token revoked; accepted replacement token accepted; no active token.
- Immutable replacement snapshot explicitly names the old offer, has the
  existing replacement-preview source/fingerprint, and corresponding normal
  `formal_contract_replaced` audit links old/new/estimate identities.
- Same estimate revision, document bytes/SHA, attachments, recipient, reply
  source and thread. Old/new offer snapshots and accepted contract hash verify.
- Commercial snapshot fields and acknowledgement amounts/estimate identity
  match. Only issuance/version/contract IDs, the replacement proof and final
  acceptance/signatory fields are compared separately rather than as business
  changes. Accepted snapshot has `agreed=true` and matching confirmed time.
- Replacement confirmation is SENT with complete Provider ACK identity,
  matching thread, normal diagnostics and chronology before acceptance.
  Accepted receipt bytes/hash also verify.
- At most 200 case outbox records; missing evidence/NULL/cross-case/ambiguity
  blocks. No name, subject, age cutoff or same-thread-only heuristic is used.

Processing, current-contract UNKNOWN, reminders, estimate/invoice/receipt
jobs, a second unrelated UNKNOWN, changed terms/original/recipient, incomplete
ACK, missing replacement proof/audit, unaccepted contract and read failure
all remain HOLD. UNKNOWN stays UNKNOWN; there is no reconciliation, resend,
cancellation or history rewrite. This classifies its relevance to this new
registration only, not the transport's actual result or recipient delivery.
Direct replacement is required; arbitrary older versions/chains are HOLD.

The backend binds the gate result into its preview fingerprint and fails
closed if the reader is unavailable. The mutation RPC re-evaluates inside
the existing case lock and shares locks on existing outbox rows. Thus a stale
preview cannot suppress a newly unresolved job, and an outbox claim cannot
silently change a locked row during registration. Existing managed-send and
reissue state machines are unchanged. The original current-after-contract
restriction remains intact.

## Evidence boundaries and future impact

Isolated tests cover original A's broad HOLD, the bounded historical exception,
negative identity/state cases, new UNKNOWN after preview, existing Owner proof
reuse, atomic rollback, amount total versus delta, no-send registration and
public-role denials. Fault/corruption fixture changes occur only in rolled-back
isolated DB transactions; no protection is disabled in shipped functions.
The existing immutable-contract fixtures also reject impossible diagnostics.

Current Production definitions of the five referenced V5/Owner/evidence
dependencies are read-only exported and overlaid only in isolation. Referenced
column types are compared separately. This proves bounded compatibility, not
that all Production rows or every future business variant has been exercised.

Future explicit Owner invocation still appends document/revision/delivery/
agreement/registration/audit history and advances commercial revision, reusing
exact PAUI-054 proof when available. Before-contract current recovery retains
existing offer/token invalidation semantics. Installation is not permission
for those operations. Positive same-tax-basis JPY revised-total cases remain
bounded as in PAUI-057; delta-only PDFs, decreases/zero, unsupported tax/currency
or ambiguous existing imports stay HOLD.
