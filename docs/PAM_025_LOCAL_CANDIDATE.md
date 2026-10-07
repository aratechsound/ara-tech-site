# PAM-025 local candidate

Baseline: `853848ef01ac51bc1d553b7a0f3a351077a671fa` (fresh origin/main).
The Vercel project overview showed Ready Production deployment
`38WokZyKnAAEFcQvvfNzu5KJjSpU` at this same main commit.
Source: https://vercel.com/ara-techs-projects-3fa7a123/ara-tech-site
See the task return for the final candidate identity.

## Behavior

`LEGACY` remains the default. Only explicit `DIRECT_CONFIRM_WITH_ESTIMATE`
allows a current estimate that has not previously been delivered. Both use the
existing commercial handler, branded Gmail engine, confirmation page and
Receipt V4.1 renderer. There is no separate mail system.

An Owner can register a PDF original without sending it, or use an existing
current estimate. The new “正式受注確認として送信” button opens the existing
full preview. The checkbox, final button, final dialog and final confirm are
retained. Opening or refreshing a preview creates no confirmation, customer
token, outbox or waiting state. Registering an original is a separate explicit
save operation; it creates a document and immutable estimate revision, without
creating a mail outbox or dispatching mail.

The final direct operation freezes the server current case, revision, amount,
filename, source bytes and SHA-256. Its SQL transaction rechecks the current
case timestamp, commercial revision, estimate/document binding, amount, hash,
conditions and primary Gmail thread. The pending/accepted/conditions-changing
guards remain. Unsent queued or definitely failed estimate-only jobs for this
revision are cancelled under the case lock; processing or ambiguous jobs block
issuance. This prevents the same original being separately dispatched from an
old estimate-only job.

The confirmation outbox row is the sole provider authority for this combined
mail. The server estimate projection and the confirmation display use that
same row, state, message and thread. `sent`, `failed` and `unknown` cannot be
independently promoted. No synthetic second estimate-send record is created.
Recovered historical Gmail estimate evidence remains a separate existing flow.
No legacy milestone date is fabricated from estimate issuance.

The first confirmed provider delivery of a revision remains its estimate
presentation evidence when a later confirmation is queued, fails or succeeds.
Each later confirmation still exposes its own outbox delivery state. Reissue
snapshots retain the original presentation date, and revised-estimate history
uses the same server delivery projection. A first failed or unknown attempt
never becomes sent evidence. F1/F2 regressions cover these combinations.

The operation ID is retained on the outbox. Repeating the same final operation
returns its saved state and does not send again, even after failure/unknown.
A separate fresh Owner send approval is required for an explicitly retryable
failure. Unknown states, expired processing leases, post-send failures and
provider 5xx outcomes do not permit automatic resend. Existing revoke,
replacement/reissue and reminder handling is reused; a direct confirmation's
mode is preserved during replacement.

Customer consent includes the bound estimate version/amount, cancellation,
payment and other formal terms. Acceptance appends explicit consent identity
to the accepted snapshot. Receipt V4.1 is unchanged: two cover/terms pages,
then source estimate pages. The PDF renderer receives exactly the stored
original bytes; the source PDF is never regenerated, OCRed or rasterized.
The combined PDF has its own hash. Its appended page content streams and
dimensions, and the separately stored original bytes/hash, are tested.

## Migration candidate

`20261008090000_pam025_direct_confirmation_with_estimate.sql` replaces four
existing functions, preserving their signatures and privileges:

- `pa_v5_issue_estimate`: explicit preparation without an estimate outbox.
- `pa_v5_issue_confirmation`: explicit mode and transaction binding guards.
- `pa_v5_outbox_claim`: direct authority checks and no lease-expiry auto retry.
- `pa_contract_accept`: append explicit consent to the accepted snapshot.

No tables, columns, URLs or token algorithms are redesigned. A migration is
necessary because the unsent-estimate rejection is enforced by the existing
SQL issue function, and must remain enforced for legacy mode. Local PGlite
application and a transaction/rollback dry run pass. Production application
was not attempted. Live Production function definitions/ACLs and migration
ledger still require independent fresh readback before any later promotion;
the Vercel source identity alone does not establish DB migration state.

## Baseline source map

The line numbers in this table refer to the baseline commit, not this candidate.

| Requested surface | Baseline authority |
| --- | --- |
| Production/main | origin/main above; Vercel Ready main source readback |
| Estimate-only send | `js/pa-admin.js:3645`; `api/_pa-commercial.cjs:715` |
| Confirmation preview | `api/_pa-commercial.cjs:508,657`; `js/pa-commercial-admin.js:310` |
| Formal issue | `api/_pa-commercial.cjs:773`; `20260914100000_pa_est_005a_confirmation_snapshot_compat.sql:21` |
| Formal dispatch | `api/_pa-commercial.cjs:1058,1122`; `api/_pa-gmail.cjs:826` |
| Gmail attachments | `api/_pa-mail.cjs:484,506`; `_pa-gmail.cjs:826` |
| Estimate delivery reconciliation | commercial outbox finish above; sent-recovery `20260913130000_pa_case_management_v5_r1.sql:19,234` |
| Confirmation reconciliation | `_pa-commercial.cjs:387,1193`; `20260914213000_pa_est_007r3_delivery_recovery.sql:111` |
| Customer accept | `_pa-contract.cjs:201`; snapshot compatibility SQL:139 |
| Receipt V4.1 | `_pa-contract.cjs:177`; `_pa-contract-pdf.cjs:103,206` |
| Current original authority | `pa_case_commercial_state.current_estimate_revision_id` -> `pa_estimate_revisions.document_id` -> `pa_commercial_documents.content/sha256`; `_pa-commercial.cjs:473,508` |
| Exact legacy rejection | snapshot compatibility SQL:75, `estimate_delivery_not_confirmed` |

PAM-024 was not stacked, integrated or modified. No PAM-024 dependency is
required by this implementation. The baseline is the fresh deployed main, not
a prior candidate or handoff.

## Verification and hold

Run the focused integration suite and browser suite with an optional output
directory argument:

```
node tests/validate-pam-025-direct-confirmation.cjs
node tests/browser/pam-025-direct-confirmation.cjs
```

The tests inject a local PGlite DB and fake Gmail HTTP/provider transport.
The browser allows only its localhost harness and blob resources. No real
customer mail, confirmation, token operation, DB write or deployment is used.
Browser verification covers desktop/390px, checkbox and final dialog gates,
refresh/no-write behavior, double-click and one fake send. The independent
regressions are recorded in the task return. PGlite concurrency checks are
local orchestration/SQL guards, not multi-session Production concurrency proof.

Completion: `LOCAL_CANDIDATE_COMPLETE_WITH_REVIEW_HOLD`.
`REAL_GMAIL_SEND=0`, `PRODUCTION_MUTATION=0`, `PRODUCTION_READY=NO`.
Next is review of the exact candidate diff and function migration, then a
separately authorized release task if the Owner chooses. No push, merge,
Production migration or deployment is included in this task.
