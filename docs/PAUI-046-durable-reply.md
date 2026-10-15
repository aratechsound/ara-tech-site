# PAUI-046 ordinary reply durability

This task adds a separate ledger for **normal Gmail replies**. The commercial
outbox permits only estimate/confirmation/reminder/invoice jobs and is tied to
business aggregates and recovery leases. Reusing it would couple ordinary replies
to business state. The existing delivery/audit rows record outcomes after sending;
they do not provide an atomic pre-send fence. No existing table/function or
customer/business row is updated by the new ledger.

## Authority and persistence

`pa_reply_operations_v1` contains immutable operation identity, Owner, inquiry,
verified mailbox, source thread/message/RFC identity, normalized recipients/CC,
subject, body digest and original attachment digests. It does **not** store draft
body/attachment bytes or confirmation tokens. Events are append-only. The sole
`pa_reply_operation_v1` RPC is service-role-only, validates the admin, active case,
and same-case indexed source and link, and exposes no anonymous/authenticated table
access. Existing ACL, authentication, Origin, and rate policies still run first.

Preparation serializes identical Owner/case/content bindings with a transaction
advisory lock. A unique operation primary key, a row lock and a unique SENDING
event allow exactly one claim across HTTP requests and independent sessions.
The Provider call is made only after the claim commits. There is no background
retry, lease takeover, timeout-to-unsent conversion, or automatic resend.

The signed existing preview token carries the server-generated operation ID.
The send endpoint checks both token/content and the stored normalized binding.
The old UI can continue using the token without an extra request field. An old,
still-valid pre-deployment normal-reply token is mapped into the same content
fence before Provider send. Commercial modes keep their existing outbox paths.

## States and intentional new replies

- PREPARED: no Provider call. Confirmation and stored expiry must both be valid.
- SENDING: claim committed; no second caller may send. A stale read projects
  UNKNOWN without rewriting any record or granting retry permission.
- SENT: positive Provider acknowledgement persisted, or strict Gmail evidence.
- UNKNOWN: any uncertain Provider outcome; absence from search cannot clear it.
- FAILED_BEFORE_SEND: validated operation failed before the Provider call.

Successful Provider delivery is recorded before audit/index work. Those later
failures return SENT with history_sync=INCOMPLETE, never an invitation to resend.
If the persistence acknowledgement itself is lost, the claim remains a fence and
the API reports uncertainty; best-effort UNKNOWN cannot downgrade a stored SENT.

The same draft/content reuses its persisted operation. To deliberately send the
same content again after SENT, the new UI offers an explicit separate-operation
preview tied to the previous operation ID. A fresh confirmation on a later
Japan calendar day also allows a separate operation for old clients. Existing operation
IDs always remain single-use. UNKNOWN/SENDING are never reset or bypassed by this
option, expiry, a new day, browser closure, logout or login.

## Read-only Gmail reconciliation

The normal Gmail reader verifies the connected mailbox. `rfc822msgid:` discovers
at most two candidates using a server-generated `<pa-reply-UUID@ara-tech.cc>`.
Only exactly one untruncated full result can confirm SENT: SENT label, exact RFC
Message-ID, original In-Reply-To, account, recipients/CC, source thread, subject,
normalized body digest, attachment metadata and original attachment byte digests.
Duplicate/ambiguous headers, mismatches, errors, missing results and multiple
results remain UNKNOWN. No Gmail labels/read state, old audit or mail index is
changed by reconciliation; only the new technical ledger receives evidence.

References: [Gmail message search](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list),
[Gmail messages and thread requirements](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages).
Gmail preserving the generated RFC header and actual Provider delivery remain
unverified until a separately authorized real send; synthetic results do not
establish Production sending acceptance.

## Release gates and rollback

Baseline source 727b7be3c1bf5c0bd12de1452cba469aa3673813 / tree
88404ca2ff44ba6a3892995a267a35c9799885a2 / deployment
dpl_FiDPSk6ECQLh3J9yDbmitQdmnx9J must be rechecked Current before external changes.
Retain all 310 previous checks, adapt only fixture transports/changed expected
durable behavior, add independent PostgreSQL/Browser and Provider fault coverage,
then normal Owner Preview, Production publish, source/assets and Owner readback.
No real customer send. Production publication is not accepted from CI alone.

An application rollback to the baseline does not require deleting this additive
ledger; preserve its evidence. The baseline application itself lacks durable
duplicate protection, so rolling back restores that known limitation. No automatic
rollback or ledger deletion is provided.

Task ID PAUI-046 is Owner-assigned; no collision found in this task's checked
scope. The formal global Task ledger remains unidentified and global collision
verification is UNKNOWN. No replacement authoritative ledger was created.
