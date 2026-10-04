# ARA-CASE-001R2 local implementation

Continue R1 commit `7249264bc36550bdaccf516caef3d55edf7c382a` on `ara-case-001r1-local`. Design authority remains ChatGPT Commander. No Production mutation, real Gmail send, push, main integration or deploy is authorized.

General and installation intake now extend the existing `api/pa-inquiry.js` router, store the canonical input in the existing `pa_inquiries` root, and atomically enqueue existing `pa_email_deliveries` jobs. Same key/same canonical input returns the existing root; different input is rejected. Captcha proof is excluded from the business fingerprint. Queued jobs are claimed atomically; sent/sending/unknown jobs never auto-resend. A provider timeout leaves intake committed and delivery UNKNOWN. Receipt behavior is configurable only from a verified server policy; no public client controls notification recipients.

The default gate is OFF. Enabling requires `ARA_GENERAL_INQUIRY_ENABLED=true` plus verified `ARA_GENERAL_NOTIFICATION_POLICY` with the existing official notification recipient, explicit receipt setting/content, and a verified spam adapter. Fixture spam is accepted only with `ARA_GENERAL_FIXTURE=true`. Production Turnstile requires secret, site key, hostname and action verification. The existing Formspree action/old inputs remain the OFF path. The new path uses one submit listener and does not load Formspree. Formspree production settings are UNKNOWN; this implementation does not claim those settings are preserved/verified.

Sync separates attempt time, successful page time and completed coverage. Each request fetches at most 50 messages within a 30-day window; page tokens retain their original query. Lag returns continuation. The list uses stable timestamp/message-id cursors with an indexed-at snapshot and independent total; new arrivals appear on a fresh first page. Full text and safe attachments are available before Owner creation/link; a new case type starts blank.

PA classification uses public PA provenance, actual commercial history, saved stage plots/documents, non-empty business progress, or dated manual event provenance. Automatic empty progress alone does not establish PA. Unknown rows require Owner classification. PA history cannot be changed to another type. Indirect guards follow stage_plot_id, offer_id, contract_id, portal_id and card_id to their actual root. The prerequisite archive guard permits only migration classification metadata while preserving trash fields.

## Migration and rollback boundary

Apply the current PA dependency chain (32 files recorded in FINAL_MIGRATION_APPLICATION.json) in the documented order. The new prerequisite `20261005145900` precedes R1 common-case migration; the only R1 SQL edit adds/reset the transaction-local classification backfill mode. R2 adds `20261005160000`. These are local-tested candidates, not executed Production migrations.

This R2 code is the compatible rollback target: set the general gate OFF while retaining the common-case reader and additive schema. An old R1-only reader is not a safe rollback after non-PA intake. Do not drop the new columns, reinterpret unknown/non-PA as PA, or delete received roots. Four tested states mean old-schema compatibility, new-schema gate OFF, fixture gate ON, and this compatible reader with gate OFF. They do not mean a Production source rewind or downmigration occurred.

## Local reproduction

Windows/Node 24.19.0/Python bundled runtimes. Runtime binaries come from the official PostgreSQL EDB 17.11-3 and PostgREST 16.4 URLs/hashes in RUNTIME_DOWNLOADS.json, under sibling `work/r2-runtime` only. No system service/global PATH/firewall changes. PostgreSQL localhost port 55437, fixture service ports 55439 (legacy), 55442 (verify), 55443 (indirect guards). The earlier ports 55438/55441 are retained failed/initial fixture history, not Production.

From this worktree, create audit output `../../outputs/ARA-CASE-001R2-audit`, then run:

```powershell
python tests/start-ara-case-postgres.py --legacy
python tests/start-ara-case-postgres.py --final
node tests/validate-ara-case-001r2.cjs
node tests/validate-ara-case-classification.cjs
node tests/validate-ara-case-intake-policy.cjs
node tests/validate-ara-case-captcha-adapter.cjs
python tests/validate-ara-case-pg-races.py
python tests/start-ara-case-postgres.py --guards
node tests/validate-ara-case-indirect-guards.cjs
python tests/validate-ara-case-regressions.py
node tests/ara-case-r2-local-preview.cjs
```

Run the preview in its own terminal after service/race tests; it resets only its fake-mailbox coverage and fixture rate window. In another terminal run `tests/browser/ara-case-001r2.cjs`, `tests/browser/ara-case-schema-compatibility.cjs`, `tests/validate-ara-case-pa-intake-states.cjs`, `tests/validate-ara-case-api-auth.cjs`, and `tests/browser/ara-case-owner-classification.cjs` with Node and bundled Playwright in NODE_PATH. Edge executable is the existing installed Microsoft Edge. Browser external network is blocked. Credentials on the preview are `owner@example.invalid` / `fixture-only`, exclusively fake. Each browser race case expires the isolated rate window between cases; policy logic, RLS, roles, FK and triggers remain active. The original 30 sync requests/10 minutes is unchanged.

Classification and indirect-guard scripts are intended for fresh fixture databases: they preserve successful writes and adverse-state evidence rather than resetting rows. Owner classification intentionally changes the unknown fixture once. On existing populated fixtures use fresh isolated database names/configuration instead of erasing prior evidence. API service, browser and independent-session results are different evidence classes. Only Gmail/OAuth and platform login endpoints are fake; the actual new API, SQL, PostgREST and PostgreSQL are exercised. Existing PA PDF regressions additionally require the baseline repository font assets and pinned dependencies; fonts and node_modules are not redistributed in the audit.

## Release gate

Commander acceptance first. Then an independently authorized read-only Production identity/schema preflight, actual business Gmail profile/selected inquiry, and Formspree notification/receipt/spam/attachment settings. Only afterward may a separate authorization consider migrations, server policy, publish or send. No external setting is inferred from fixture PASS. Do not submit a live Formspree test or load a Production admin page that writes during inspection.
