# PAUI-066 — thread identity collision guard (isolated implementation)

**Baseline:** `ca98c415de508cc0914e0e2fcb2000cbda30f970` / Git tree `547f186ff7aa99121cfe13c4062518a4fab9642b`.

**Status:** isolated code + SQL migration *candidate*. **Not deployed, not adopted into any live database.** The existing Gmail index, email artifacts and customer-case associations are untouched. This is not a completed historical repair, not a new per-message read model, and not a Production E2E pass.

## Root cause and safety boundaries

An inbound automated Formspree notice has a fixed generic subject and a notifier mailbox rather than a trustworthy customer identity. Gmail can place independent submissions into one provider thread. The previous `threadRows()` admitted all messages in a previously linked thread to the same case, and `ara_decide_mail()` could link all pending messages in that thread. One old thread may therefore contain multiple unrelated customers. Thread ID and generic notifier From **must not** authorize another message.

`pa_gmail_thread_links.gmail_thread_id` is unique. `pa_gmail_message_index.gmail_message_id` is primary-keyed, and workspace read/download paths verify the thread↔case relationship. Simply changing the stored `inquiry_id` of one message is not a safe repair.

## Implemented in this isolated branch

- `api/_pa-mail-discovery.cjs`: fixed generic Formspree notice class is never automatically marked `INDEXED`; new messages in a linked thread need an independently verifiable case email/participant; already-indexed messages are not reattributed. Thread-wide Owner action refuses generic notifications and multi-sender collisions.
- `api/_ara-unlinked-mail.cjs`: generic notifications can be considered candidates even if Gmail grouped them into a linked thread; generic notices under a linked thread can be *reviewed*, but notifier From is not shown as a confirmed customer recipient. Legacy create/link action for generic notices is explicitly blocked pending message-level adoption.
- `api/pa-gmail.js`: returns a clear `409 mail_identity_review_required` instead of a generic 503.
- `ops/PAUI-066-thread-identity-guard-CANDIDATE.sql`: four versioned SQL function replacements are prepared as a **candidate only**. They preserve signatures and privilege restrictions and reject stale clients that try to index generic notices, while retaining them as review candidates. The migration is **not applied**, pending a disposable-PostgreSQL test and fresh live-definition comparisons. It does not establish per-message adoption or change historical records.
- `tests/validate-ara-paui066-collision.cjs`: dependency-stubbed, synthetic-only regression test. It uses no real Gmail, Supabase or Vercel operations.
- `tests/validate-ara-paui041-discovery.cjs`: strengthen the pre-existing acknowledgement-thread regression. A previously expected *unrecognized sender* is now required to stay a candidate while an otherwise identical legitimate customer sender is indexed; this is a security expectation change, not skipped testing.

## Verification completed in ChatGPT local isolated runtime

`node tests/validate-ara-paui066-collision.cjs` — **14/14 PASS**.

`node --check` on all changed JavaScript and test sources — PASS (including strengthened PAUI-041 fixture).

Cross-cutting Production/DB integration cannot be marked PASS without the project's controlled PostgreSQL+PostgREST fixtures and the official Docker CI runtime. The absence of those tools in this ChatGPT runtime is **HOLD**, not a reason to loosen the guard or to claim a release.

## Unresolved work, not approved for deployment

1. Compare **live** definitions of `ara_commit_mail_page_v2`, `ara_list_mail`, `ara_decide_mail`, `paui041_commit` to the baseline captured for the migration. Any drift → HOLD.
2. Execute the candidate migration only in an isolated disposable DB; run PAUI-041 and ARA-CASE regression suites, including old-client attempts, conflicting senders, correct sender, concurrent duplicate messages, exclusion and cursor replay.
3. Add a proper message-level Owner adoption and read/download model compatible with the unique thread link, or explicitly retain generic notifications as pending with an operational manual response path. This patch deliberately **fails closed**, so it must not be promoted as a complete general-inquiry workflow.
4. Independently plan any historical reattribution of previously indexed messages, including immutable original, audit preservation, multi-case reads, owner approval and rollback. **Never auto-migrate old customer rows from this patch.**
5. After independent acceptance, request separate Owner approval for any live SQL, Production deployment, real Provider tests, or customer data corrections.

**All GitHub work should remain isolated from main/Production.** Do not merge an earlier Draft PR to shortcut these steps. No Gmail sync, send, retry, legacy UI visit or Production DB writes are authorized by this work.
