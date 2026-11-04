# WORKS existing-session API runtime (WKS-004 corrected standard)

## Standard route

1. Check the existing ARA-TECH site Supabase Auth administrator session first. Wait for normal asynchronous session restoration before deciding that login is missing. An initially visible login panel is not proof of a logged-out session.
2. If the session is valid, skip login. Verify the actual user through the existing client's getUser and work_admins membership under RLS when the supported API surface is available. A populated admin dashboard is UI evidence of session restoration; do not invent an independent getUser result from it.
3. Only if the site session is absent or expired, open https://ara-tech.cc/admin.html and wait for the Owner to complete the official site login. Recheck identity and administrator authority, then continue the same task. Supabase Dashboard GitHub OAuth is separate and does not authenticate the WORKS publication API.
4. Execute the existing publish_work_candidate RPC from an officially supported execution surface using that same authenticated client. Use scripts/publish-reviewed.mjs for reviewed IDs and pinned hashes when its client is accessible. Maintain image verification, actor/time, candidate hash and audit gates. Never extract tokens/cookies/localStorage, impersonate identity, use service_role/postgres, or directly update is_published.
5. If the site session is present but the current tool only offers read-only DOM evaluation and UI interaction, and exposes no authenticated API invocation, report SITE_SESSION_PRESENT_API_EXECUTION_UNAVAILABLE. Do not mislabel this as missing authentication or ask for repeated login. Do not manufacture an execution surface or automate the publish/OK dialog as a substitute.
6. Independently read Production and verify actual public PC/mobile rendering after a successful RPC. Reuse ID99 and its stored image; no duplicate insertion or image upload. Continue authorized browser Return even if publication is HOLD.

## Password CLI is not the standard

The original verified runtime kit proposed a direct PowerShell hidden-password login with a separate CurrentUser DPAPI refresh-token store. The Owner superseded that default during WKS-004. Do not launch that password prompt, ask the Owner to create a second session, or store a new credential as part of normal WORKS work. An empty CLI token store does not prove the site is unauthenticated.

works-publish-cli.mjs and its tests are retained for provenance and explicitly requested optional use, not automatically selected authentication. Its password-login command refuses execution without --explicit-local-login. That opt-in must never be added by an agent merely to get past the refusal. No such optional authorization is present in the corrected standard. Existing stored credentials, if any, are not deleted implicitly.

Run skill/CLI safety checks without credentials:

    node --test .agents/skills/ara-works-publish/scripts/publish-reviewed.test.mjs .agents/skills/ara-works-publish/scripts/works-publish-cli.test.mjs

Mocks, DPAPI roundtrip and skill discovery do not establish Production publication PASS.
