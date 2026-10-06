# EMP-014 local integration candidate

A organizer event binding, B canonical staff category projection and C encrypted ACTIVE URL redisplay are implemented. Commander EMP-013 UI is integrated. This commit is a LOCAL candidate; the Production-ready decision remains HOLD because the official browser did not apply the requested 1440/390 widths (actual width remained 1920). No deployment, migration application, secret configuration, production DB write or real link mutation was performed.

Base: `9a82e12dc8fc796c3bfa1e26a571a01b3caf7352`, matching the freshly observed Production source and deployment `dpl_CTshP5xpsziCApBRAJbsXnqbL3CN`. Supabase `kogbnremsouajxxsgxro`: migration ledger 35, latest `20261006010000`. Fresh catalog evidence is in the sibling `outputs` folder.

Organizer management uses the existing organizer cookie and the existing session → access link → portal → PA_EVENT binding. The new RPC is executable only by service_role. Request case/portal IDs are optional mismatch guards, never authority. The originating organizer-link issuer remains the required created_by FK; the actual organizer/session is recorded in the existing collaboration audit. No work_admin membership or admin JWT is assigned to organizers.

Category migration is based on the fresh Production staff_read definition. It adds only category from the canonical card category, or photo for photo rows. Existing response keys and server filtering remain unchanged. It has no table, column or grant changes.

Redisplay reuses the AES-256-GCM envelope implementation from `cd5e11e63e721d83b4673389d416bcc1249cf812`, including key-id and AAD binding to link/event/grade/hash/version. Token hash remains authentication authority. Four nullable envelope columns belong exclusively to the C migration. Plaintext tokens are neither stored in the DB nor logged. Decryption is followed by an authorization/ACTIVE/expiry/revoke check against the same link ID and hash. Legacy hash-only ACTIVE links remain ACTIVE / 再表示不可, with copying disabled; no automatic rotation or revocation occurs.

Three independent migration candidates, in order:

1. `20261007010000_emp014_staff_link_redisplay.sql`
2. `20261007020000_emp014_staff_category_projection.sql`
3. `20261007030000_emp014_organizer_staff_authorization.sql`

Future deployment would require `PA_STAFF_LINK_KEYRING_JSON` and `PA_STAFF_LINK_ACTIVE_KEY_ID`. Production configuration was not inspected or changed. Tests use in-memory synthetic keys. Missing or malformed key configuration prevents issuance mutations.

Focused checks passed:

```
node tests/validate-emp014-boundaries.cjs
node tests/validate-emp014-http.cjs
```

The PGlite checks cover canonical projection/backward compatibility, own-event management, cross-event/case and tampered binding denial, expired/revoked organizer authority, crypto tampering, admin SQL v2, legacy preservation, GENERAL performer denial/TECHNICAL viewing, staff write denial, rotation/revocation/expiry and old sessions. HTTP tests use mocked RPCs, including the post-decrypt race check and missing-key mutation denial. No live production requests are used by these tests.

The official CUA browser rendered actual localhost pixels using `node tests/preview-emp014.cjs`. The fixture binds only 127.0.0.1:4175 and uses synthetic content; its CSP prevents external connections. It uses existing local dependencies and the existing EMP PDF assets. No new dependency installation is required on this PC. Actual-width 1920 screenshots show the logo, specified order, admin-only candidates, bottom staff panel, unavailable legacy URL, long filenames/URLs and no observed horizontal overflow/button overlap. GENERAL has no performer or write controls; TECHNICAL has performer materials and no write controls.

Required remaining verification: actual Admin Desktop 1440, Admin Mobile 390, GENERAL Mobile and TECHNICAL Mobile. Organizer Desktop was reviewed at actual width 1920. `viewport.set({width:1440,height:1000})` and `viewport.set({width:390,height:844})`, including reload/new-tab checks, left innerWidth at 1920. Temporary viewport settings were reset. No alternate automation or CSS/iframe substitute was used. Do not represent this commit as visually complete or Production-ready until those exact-size checks pass.

Stop here and return to ChatGPT Commander. Production and all real staff links remain unchanged.
