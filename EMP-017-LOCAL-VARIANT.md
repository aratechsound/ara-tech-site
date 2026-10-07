# EMP-017 local variant

This variant supersedes only EMP-014's encrypted URL storage design and migration names. Owner explicitly accepted the risk that a DB or backup disclosure exposes bearer URLs. Token hashes remain the authentication authority. Existing hash-only links retain their ID/hash/expiry and have null token_plaintext: ACTIVE, redisplay unavailable. No real links or sessions were changed.

Integration base is MAIL candidate `53a75c1c3ca17ffc12c48cd8078519b7d2932fc0`, containing CASE `7b12ecc` and `0d5038c`. MAIL remains unreleased and under Owner review. The original accepted EMP `cb8f7a9724591559e765d222ed876a1ec342767b` checkout is unchanged. This variant is LOCAL ONLY; no push, deploy or live DB operation was performed.

New tokens use the existing 32-byte random generator, are stored in one nullable token_plaintext column, and are returned only by admin-guarded or session-bound organizer management RPCs. A column constraint and both issuance RPCs verify the plaintext/hash pair. Staff read, status metadata and audit omit raw tokens. Redisplay rechecks the same ACTIVE identity/hash after retrieval. AES, keyring, active-key settings and external key storage are unnecessary.

The directly relevant CASE close source had no staff revocation. C now adds an after-update trigger that revokes only the closing case's staff links/sessions. It also denies creation/redisplay/exchange/context when status is closed, including cases already closed before migration. The CASE close RPC itself is unchanged; no existing rows are rewritten by migration.

Apply only after a separately approved release and fresh identity/catalog check, in this order:

1. `20261008010000_emp017_staff_link_redisplay.sql` (C: one plaintext column, management RPCs, direct CASE close guards).
2. `20261008020000_emp017_staff_category_projection.sql` (B: accepted category projection, unchanged contents).
3. `20261008030000_emp017_organizer_staff_authorization.sql` (A: accepted organizer binding, plaintext payload and closed-case guard).

These candidate versions are later than the supplied ledger latest `20261007040000`; uniqueness/pending set must be checked at release. The unexecuted EMP-014 AES migrations are absent from this variant. Applied historical migrations are unchanged.

Focused validation: synthetic DB issuance -> stored token -> authorized redisplay -> rotation -> old URL/session DENY; own/cross-case binding, roles, table read/write denial, expiry/revoke, token/hash integrity, staff response/audit omission, CASE close and other-case preservation. Mocked HTTP tests cover key-free issuance/redisplay, tampered identity/hash/grade, race recheck, staff write denial, no-store and raw-token omission from errors/logs. No full suite or new visual audit.

UI/CSS/layout/i18n equal the accepted EMP-014/015 source. Reuse the accepted visual evidence. The primary review surface remains `tests/preview-emp014.cjs` serving local synthetic HTML/assets; EMP-015 small PNGs are auxiliary and full-page PNGs are EVIDENCE_ONLY. No new dependencies, secret settings, QR, Drive, Gmail synchronization, mail or LINE.

Real GENERAL: KEEP. Mutation count 0. Public release still requires Owner GO after MAIL/base resolution, exact migration/commit approval and bounded readback. No key operator is required for this variant. EMP-016's encrypted-secret rollout packet is historical and must not be executed for EMP-017.
