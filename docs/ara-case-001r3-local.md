# ARA-CASE-001R3 local handoff

BASE_HEAD: cac44214dba8f273377ab66fc95b2aad7e4fc38d
Design authority: ChatGPT Commander. Implementation/verification: Codex GPT-6.1 Sol / High.

Production changes are limited to js/ara-general-inquiry.js and the general_config GET branch in api/pa-inquiry.js. R1/R2 intake transactions, fingerprint, notification ledger, Gmail synchronization, classification/guards, Owner reply approval, archive and PA commercial processing are unchanged. No new migration or Function route.

The browser stores one business submission key until confirmed acceptance. Each dispatched attempt consumes its local proof readiness. Success, rejection, DB failure and unknown response all reset the identified Turnstile widget before another attempt. Expiry/error/timeout invalidate readiness, retain form input, explain the state and allow a fresh proof. A lost success response returns the existing ID/number using the same key and a new proof. UNKNOWN notification jobs remain UNKNOWN and are not resent.

Config is explicit LEGACY (gate string false), COMMON (true plus validated policy) or UNAVAILABLE. Missing, empty and invalid gate values also fail closed. There is no default-OFF inference in this GET path. Only explicit false loads the existing Formspree AJAX integration. GET failures, non-2xx, invalid JSON and missing fields retain input and offer config re-read. Capture-phase submit guarding also covers Enter/requestSubmit and the form's native submit method before route/proof is ready. Initialization and retries do not add a second submit handler/widget/notification route.

## Evidence and reproduction

Use tests/prepare-ara-case-r3.py to create a byte-identical production-source copy under work/r3-regression, with test-only changes for R3 output location, fresh DB names/ports and localhost preview port. Assertions are unchanged. The isolated fixture uses actual PostgreSQL 17.11, PostgREST 16.4, platform-role/auth prelude and 32 actual PA migrations. Legacy schema tests use the preserved real old-schema fixture. No Production data participates. New acceptance tests use actual browser/client/API/REST/PG; Turnstile and Gmail are fake, with proofs genuinely single-use. Browser external asset requests are blocked; screenshots prove functional state, not complete Production styling. Formspree submissions in the OFF test are intercepted fakes.

Run startup --final and --guards only on fresh R3 fixtures. Successful fixture writes/evidence are retained. Classification tests must precede Owner classification; do not treat rerunning them against a previously classified fixture as a fresh migration proof. Execute the R2 preview in a separate terminal for browser regressions. Execute tests/ara-case-r3-server.cjs separately for tests/validate-ara-case-r3.cjs and tests/validate-ara-case-r3-config.cjs. Existing local Git history at BASE_HEAD is used for unchanged before-client/handler reconstruction. The ZIP also supplies those before sources and the unchanged R2 audit.

Results: before 4 defects reproduced; after 18 browser/API/PG checks and 9 config API checks PASS. R2 independent PG races 9, browser 15, compatibility 4, PA public intake 4 and PA regression 11 scripts rerun PASS. Supporting intake, adapter, auth, classification and indirect guards were also rerun. Details in the current R3 audit evidence, rather than earlier PASS records.

## External read-only and release/rollback plan

Formspree mojqjwnr: notification to aratechsound@gmail.com enabled. Formshield ON, CAPTCHA Disabled, submission archive ON. Only the internal notification action was shown in Workflow. Rules/global auto-reply and attachment plan eligibility remain UNKNOWN. Turnstile is a candidate replacement, not confirmed equivalent to the current spam setup. No save/test submit.

Vercel ara-tech-site / ara-tech.cc: current Production 999ec1b3077f4e3ac1a72188a4e94ed1f719b757, deployment HhPQCbu9FgMtoDc6FbcexVg7ocsG, Hobby, 12 Functions / Node.js 24.x. Only environment names were read; values were not revealed. Shared settings were not inspected.

Supabase project kogbnremsouajxxsgxro matches public site config. SELECT export shows 31 migration ledger entries, ending at existing 20260915093000 reissue. case_type, ara_* RPC and unlinked/coverage tables are absent. This is NOT equivalent to local R1/R2 schema. The ledger contains works migrations and is not comparable by count to the 32-file local PA chain. Classification evidence overlaps: 11 root cases, 11 event-name-present, 6 public-form, 2 with contract offers. No Production classification/writes. Existing migration versions must not be blindly replayed. The dashboard also displayed a quota-restriction notice; no billing action was taken.

Gmail connector is personal tonokun@gmail.com; business messages were not read via it. Chrome's targeted Gmail opening was blocked by another extension UI; logout is UNKNOWN. Site server OAuth profile is separately UNKNOWN because no available deployed read-only profile action exposes it and environment secret values were not accessed.

Future Commander-approved release requires: finish business OAuth/message readback and Formspree Rules/auto-reply/attachment verification; compare actual schema definitions/ledger with required migration deltas (including delivery-recovery dependency absent from observed ledger); snapshot/backup and approve a forward-only plan; keep already-applied 20260915093000 intact; validate additive prerequisites and root/child/FK/RLS/trigger changes in staging; explicitly set false for LEGACY during candidate introduction; agree verified notification/receipt/spam policy before true; deploy compatible R3 code and separately approve activation. No such operations are performed by this Task.

Compatible rollback keeps R3 guards/readers and all accepted roots/originals/jobs, sets the general gate explicitly false only with future authority, and restores confirmed legacy intake behavior. Do not rewind to the defective R2 form script, down-migrate schema, discard accepted cases, or change UNKNOWN jobs to unsent.

Local implementation is READY_FOR_COMMANDER_ACCEPTANCE. Overall result remains PARTIAL because external preflight remains incomplete. main integration/push/deploy, Production mutation and real send are zero.
