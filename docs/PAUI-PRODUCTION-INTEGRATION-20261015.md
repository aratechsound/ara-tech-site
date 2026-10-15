# Completed PAUI production integration

The fixed Production baseline is PAUI-041 `21fa957b1b5fc086e363156ceb677abd9fed412c`, tree `ead9ed7bbf83bb9c1ecec1ba3472d8191c1ac500`, deployment `dpl_8pqcG57cgq3EM7V1RXwwPqG6zDKy`. Preserve its old UI, Gmail discovery, chronological order, authentication, ACL and business-action boundaries.

| Work | Adoption |
| --- | --- |
| PAUI-026 / PR 6 | Card sizing, full filenames/source evidence, case status basis, recorded workflow semantics, case-specific UNKNOWN display and conservative introduction handling. |
| PAUI-027 / PR 7 | Inquiry-first overview, original inquiry attachments, all-source document warehouse, formal/estimate/history distinctions and font weights. Depends on 026. |
| PAUI-028 / PR 8 | GET-only original retrieval using authorized case/message/thread, stable MIME part or canonical identity and unique content proof. No filename-only fallback or backfill. Depends on 027. |
| PAUI-029 / PR 9 | Scoped target reads, session/case memory cache, lazy bounded previews/shared PDF worker and strict duplicate projection handling. Original enlargement revalidates through ordinary GET. Depends on 028. |
| PAUI-030 / PR 10 | Recover the missing pending-body button label. Chronological sorting is already superseded by PAUI-040/041. Do not add another latest-mail button/read-through subsystem alongside 041 discovery. |
| PAUI-036 / PR 13 | UNKNOWN helper is already supplied by 026. Reuse its static identifier/import/export regression with three negative controls. Do not import unrelated earlier mail-link UI. |
| PAUI-038 / PR 15 | Deterministic source-faithful useful passages, inert HTML before snippet, explicit partial-body label and original/quote preservation. Retain 026 introduction cases. No PAUI-037 paid AI/provider/cache code. |

The original PRs are dependencies/references, not a batch merge. Resolve only overlapping excerpts and gallery render hooks; keep PAUI-040 mail dates and PAUI-041 discovery mount/check/cancel. The 038 browser's exact response wait follows the selected 041 discovery endpoint rather than an unadopted mail-candidate endpoint. Existing expectations and security tests remain.

The 038 isolation guard now compares all fixed Production test blobs, using the exact approved 026 superset for its added excerpt cases. It preserves old UI/write/discovery blobs and the exact 036 UNKNOWN predicate; the read adapter/model are intentional 026–029 integration targets and remain covered by their unchanged behavioral/ACL suites. No assertion values, cases or security expectations are relaxed. Ambiguous leading purpose lines before an addressee remain verbatim, while recognized organization/department headers may be removed.

The 040 fixture's authentication mock supplies the existing `current()` method required for 029 thumbnail-session revalidation. Its assertions remain byte-identical; the 038 preservation guard permits only that exact mock-interface addition. The real authentication/session checks have no fallback or bypass.

No migration or commercial/customer-state change belongs to this integration. Runtime acceptance must use normal Owner authentication and GET-only original paths. Fixture/CI, Preview, published Source/tree/assets, real Owner display and final Production acceptance are separate evidence. Features lacking actual Owner evidence remain unverified. Automatic discovery must not create index/link data during this task's read-only acceptance.

Rollback uses the preserved PAUI-041 deployment through the official Vercel route; retain all baseline evidence and never rewrite customer records. Report adopted capabilities separately from uncertain source documents, missing originals, denied ACL and unmatched candidates.
