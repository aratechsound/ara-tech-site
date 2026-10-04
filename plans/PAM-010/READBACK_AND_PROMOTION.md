# PAM-010 Production promotion candidate

Base: `0c264f87914afacfb29a14a1c49fa9e41be3d72a`. PAM-009 is accepted evidence; no new live Production observation is claimed here. Exact candidate identity is the new local commit in the audit result. This file is a plan, not permission to deploy or activate.

## Authentication boundary requiring Commander disposition

`mailbox_profile` retains mandatory Origin policy and the unchanged `verifyAdmin`. The real helper makes one Supabase Auth GET and one `work_admins` SELECT. After authentication it makes zero DB calls, zero DB mutations, one OAuth refresh POST through the existing server helper, and exactly one Gmail GET `/gmail/v1/users/me/profile`. No messages/thread/sync/send endpoint is used. Total DB calls zero is therefore NOT satisfied. Do not replace admin authentication with browser identity or self-asserted claims. Approve the one existing SELECT exception, or obtain an authorized authentication design before claiming strict compliance.

The output allowlist is only `emailAddress` and `matchesOfficialMailbox`. A mismatch returns false without reauthentication. Missing/malformed profile email or upstream failure returns safe 503. No upstream counters or credential values are stored/returned. Invalid actions, including inherited object names, return 400. Existing twelve action rate policies remain unchanged.

## Boundaries A through E

A: After separate authorization and fresh read-only preflight, apply only the three migrations in `promotion.json`, in order. Abort if schema/ledger/source drift appears. Do not replay older PA SQL, 20260915093000, delivery recovery, or any migration merely because of ledger gaps. The ledger is not the only evidence of an existing object.

B: After separate source deployment authorization, set `ARA_GENERAL_INQUIRY_ENABLED=false` explicitly before exposing compatible source, and keep it false through readback. If separate environment edits and source deployment cannot be sequenced safely, HOLD deployment. The existing form then chooses LEGACY deliberately and posts to `https://formspree.io/f/mojqjwnr`. Absent/invalid gate or incomplete COMMON policy is UNAVAILABLE and cannot silently fall back. Vercel routes remain the existing twelve; there is no new Function route. `.vercelignore` excludes plans/tests/SQL/evidence.

C: Once this exact candidate has been independently promoted, use the existing authenticated admin page's same-origin POST to `/api/pa-gmail` with `{"action":"mailbox_profile"}`. Do not paste/export its Bearer token, cookie, or credentials. Record only the response email and match flag, timestamp, deployed source identity, and status. A business Gmail browser screenshot is separate evidence and cannot substitute for this proof. A missing action, failure, mismatch, or unapproved auth boundary keeps C HOLD.

D: Prove actual Turnstile keys through authorized server configuration without exporting the secret. Hostname must be `ara-tech.cc`, action `general-inquiry`; future policy uses business notification recipient and `receipt_enabled=false`. The policy template deliberately has `verified=false` and null site key and is NOT executable COMMON configuration. Do not invent keys. Key creation, account changes, secret reads, and environment changes are outside this task. No confirmed keys means D HOLD.

E: Only after A/B readback, C/D PASS, accepted auth boundary, and explicit COMMON activation authorization, set the actual verified policy and gate true. Read back COMMON mode; run only separately authorized production acceptance operations. A/B completion alone does not authorize E. No activation performed in PAM-010.

## Exact transition and intended impact

1. `20261005145900_ara_classification_archive_guard.sql`: replace only the existing soft-delete guard to permit metadata-only classification of archived rows. No backfill itself.
2. `20261005150000_ara_case_common_mail.sql`: four root metadata columns, two mailbox tables, controlled inbox functions/RLS/grants/PA guards. Exact provenance predicate predicts 6 root PA_EVENT updates.
3. `20261005160000_ara_case_r2_intake_coverage.sql`: fingerprint column, additional PA evidence/indirect guards, queued/unknown delivery statuses, intake transaction/claim, coverage cursor/pagination/thread guard. Remaining evidence predicate predicts 5 root PA_EVENT updates. New empty sync state predicts 0 coverage backfill rows.

Final PA_EVENT preview is 11 (3 active / 8 archived), 0 unclassified. This is accepted PAM-009 preview, NOT an applied backfill. Existing AFTER UPDATE audit and updated_at triggers predict 11 case_updated audit rows and 11 updated_at changes. Status/schedule-specific progress triggers are not fired by the case_type SET alone. No case insert or mail delivery is caused by these migration backfills. Recompute counts immediately before authorized apply.

PAM-009 exact diff: 5 root + 20 new-table columns; 2 new tables; 19 new constraints / 1 changed delivery-status constraint; 2 new indexes; 26 new triggers / 1 replaced progress trigger; 2 SELECT RLS policies; 11 new functions. The full captured catalog and object definitions remain in audit evidence.

Only `guard_pa_inquiry_soft_delete` is replaced from the existing Production function set. `ara_require_pa_child` is created by migration2 then replaced by migration3. Do not copy the whole isolated function catalog. Formatting/CR differences in other PA functions, fixture `is_work_admin` search_path, and fixture-only `pa_production_e2e_clone_case` representation are not replacement targets. Do not promote fixture_admin ownership or expanded fixture grants; use only explicit GRANT/REVOKE statements in the three SQL files.

The local prerequisite validator checks the accepted actual PA catalog, exact SQL bytes/order, referenced PA tables, root/ledger columns, progress trigger, delivery constraint, helper functions and submission-key uniqueness. The catalog capture excludes public.work_admins and auth.users definitions and role inventory. `PREAPPLY_READ_ONLY.sql` adds those checks for the future authorized read-only promotion review and also checks existing function hashes. It has NOT been run against Production in PAM-010. Catalog PASS refers to the captured scope, not a fresh complete live preflight.

## Rollback

After COMMON activation, the first rollback is explicit gate false and LEGACY API/client readback. Preserve all accepted cases, dedupe keys and ledger data. Do not automatically resend queued/unknown notifications or move/delete Gmail. Restore compatibility through a separately reviewed forward-fix migration. Do not drop common columns/tables or shrink delivery status constraints. If deploying an older source, first prove its compatibility with the expanded schema; the R3 compatibility acceptance is retained and schema files are unchanged here.

## Local acceptance and preservation

Focused new profile/API/auth/Origin/mismatch/upstream/allowlist/count tests plus real client-script gate tests use fake transports only. They expose the actual admin SELECT instead of mocking it away. Existing twelve actions are checked to still consume their original rate RPC before dispatch. Focused PA Gmail communication/attachments/reconciliation/send-binding regressions are selected; full accepted R3 races/browser/PA tests are not needlessly repeated. Every local run, including a corrected VM test-harness failure, is recorded in the audit ledger. Actual Gmail OAuth identity remains unproven until boundary C.

SQL byte provenance: migration2 has CRLF bytes in the accepted PAM-009 file and LF bytes in its unchanged Git blob. promotion.json pins both raw SHA-256 values. The deliverable migration files preserve the accepted raw bytes; normalized SQL text is identical. The other two migration hashes match their Git blobs directly.
