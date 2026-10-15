# CASE DESK portal candidates and ordinary Gmail replies

Continuation of PR18. Production baseline: Source `05e365b93c0fef61b722f9d81d13886d73b4c08a`, tree `8d55f205dc314d678e6df4ab6d5559b66805f5c7`, deployment `dpl_6Mqksxq3c1JudagnCHBmUQdbL9hq`. Current/Ready and 24 public Git-blob bytes were freshly verified and the baseline source bundle preserved before implementation.

## Portal candidates

The existing `candidate_backfill` route now accepts an optional indexed Gmail message ID. The server validates its syntax and requires exactly one same-case indexed message in a linked thread before any candidate RPC. The legacy whole-case operation remains available. Classification recognizes scenarios as scripts and position maps as layouts; a production-use prefix alone supplies no layout signal. Parking passes stay separate, unclassified documents even when the subject mentions scripts/maps.

CASE DESK exposes a per-message candidate-link action. After PAUI041 commits newly indexed messages, its existing `onIndexed` callback also links newly seen messages with attachments through the same route. Concurrent requests for one case/message share a promise; existing canonical identity/RPC uniqueness supplies persisted idempotency. Initial case reads do not create candidates. Failed candidate integration remains visible and does not invalidate the mail discovery commit. Identity ambiguity is reported separately. No new DB migration, adoption, current-version switch or publication is introduced.

## Ordinary replies

Each indexed inbound message opens a memory-only composer bound to the case, message and thread. To and subject are derived and read-only, as in the legacy composer. CC remains editable within the existing server-authorized source participants. Text and up to ten attachments totaling 3MiB use the existing `reply_preview` and `send_reply` actions with normal mode and explicit source IDs. The Gmail API, backend reply policy, Origin/ACL/rate gates, branded template, signed source/attachment confirmation, final source revalidation and successful-send synchronization remain unchanged.

The preview must match the selected case/message/thread, recipient, subject, CC, attachment metadata and normal mode. It renders original branded HTML in an empty-sandbox iframe plus plain text. Any edit invalidates the confirmation; expired previews cannot send. A separate final-review button and an explicit checkbox are required before the final send button. A send request is issued at most once per composer; an unknown result locks resending and instructs Owner to inspect Gmail/history. Post-send history/attention refresh uses GET only because the existing send route already synchronizes. No commercial mode is exposed.

Dirty drafts require an inline discard decision before case changes, refresh or manual logout. Cancelling preserves the draft. Rendering async read surfaces does not recreate the composer. Auth loss/page exit clears memory; stale preview responses cannot attach to another case or edited draft. The modal fits a 390px viewport.

## Evidence boundaries

All baseline tests and exact protected legacy/Gmail/discovery blobs are retained. New synthetic tests exercise scoped candidate selection, classification, distinct MIME identities, unknown attribution denial, request coalescing, preview binding, wrong-message refusal, edit/stale response guards, draft cancellation/discard, final confirmation, simulated success/history refresh and ambiguous send/no retry. Existing DB candidate/reconciliation and Gmail reply/attachment tests remain required.

Actual acceptance must use normal Owner sessions on Preview and Production. Only candidate generation for the specified mail and preview requests are authorized live; customer sending, candidate adoption, version/current/publication changes and commercial operations are not acceptance steps. Real sending remains explicitly UNVERIFIED. Do not bypass a Preview Origin refusal or transfer browser credentials. Save source/tree/asset identities, candidate/raw-original acceptance and prior 298-check preservation separately from fixtures. Browser Return is reserved for one final result after evidence is complete; a temporary gate does not consume it.

Rollback target is the baseline deployment above. No automatic rollback or data restoration: preserve generated pending candidates and existing document versions, and use the regular Vercel route if a release requires rollback.
