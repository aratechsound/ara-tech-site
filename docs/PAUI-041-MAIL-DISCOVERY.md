# PAUI-041 mail discovery

Baseline: PAUI-040 c453e46b465cd256c322fd29cd8ed0859ac89960.

The former case sync resolves only linked threads. The separate unlinked-mail
scanner excludes SENT and does not populate the case index. The workspace
conversation view reads the saved index without invoking either mechanism.
This combination explains why sorting the saved index cannot discover a new
conversation.

The new route is enabled only when `PAUI041_DISCOVERY_ENABLED=true`. It retains
the existing admin verification, Origin policy and rate limits on pa-gmail.
The workspace GET adapter remains read only with Owner JWT, public key and RLS.
Entering a conversation reads its status and automatically invokes the guarded
sync route. Opening an overview has no mail write. Each visit continues up to
25 bounded invocations; a rate limit or unfinished scan stays incomplete and
the next visit resumes from the durable position.

Discovery covers normal received, sent and archived messages matching registered
participants or identifying case names/references. Gmail list pages are followed
until exhausted. Approved conversation threads are reread in batches of five;
new search results are processed in pages of twenty. A window has a fixed UTC
cutoff, saved page token and version. Later windows overlap seven days. A full
search is performed initially, after search-basis changes, and at least every
seven days of use. Expired list tokens restart the same window. This is a
pull/reconciliation design, without Gmail history cursors, Push or a new cron.
Mail arriving while the application is closed is collected on a later visit.
Completeness applies to the recorded search scope and cutoff, never the whole
mailbox or a failed/partial request. Unknown remaining counts remain UNKNOWN.

Approved thread attribution is authoritative. A new thread needs a registered
counterparty and a unique identifying case title/reference, mailbox involvement
and a compatible case work period. Every regular message in the thread must
agree. Another case with a matching identity, forwarding markers, changed-only
subjects or an address-only match requires Owner review. Deleted/archived cases
remain competitors. Generic messages are shown as candidates rather than lost.
Owner decisions bind a fresh thread fingerprint; existing links cannot move to
another case. Exclusions persist for later messages in the same thread.

The additive migration introduces two admin-readable tables and service-only
functions. A complete case/link/participant authority snapshot is checked again
under a transaction lock at commit. Stale versions, changed authority and index
conflicts abort the transaction. The index and thread-link writes are INSERT ON
CONFLICT DO NOTHING. Existing row values, bodies, timestamps, direction and
attachment metadata are never updated. The mailbox is pinned to the official
account, so the existing global message-ID uniqueness is stronger than the
requested account/message-ID pair. Classification records include that mailbox
explicitly. No OAuth permission changes, Gmail mutations, external AI, portal
registration, commercial changes or workflow advancement are involved.

Before Production migration, preserve the relevant full link/index rows and
schema/ACL definitions locally outside Drive, and verify the fresh deployment
and source. Run the additive migration through the existing authenticated DB
administration route. Publish the exact CI-verified candidate through the
official deployment route without merging main. Enable only after schema and
release gates pass. Validate the existing-delivery render before triggering a
live scan. Compare all original rows after live acceptance and a repeated scan.

Rollback: disable the flag and use official Vercel Instant Rollback to the
freshly verified PAUI-040 deployment. The additive tables can remain inert. Do
not drop legacy objects or restore/overwrite the original mail rows. If removal
of newly inserted links/index entries is necessary, use the before/after ID
manifest under a separate exact-scope restoration decision; preserve Owner
decisions and unrelated concurrent inserts. No Gmail rollback is necessary.
