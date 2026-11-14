# WORKS capability and existing-session runtime

## Capability evidence and handoff

Record each probe as `{status, evidence}`, with `status: "verified"` only after an observed result. Run `assessWorksRuntime(probes)` from `scripts/runtime-routing.mjs`. Supported keys are `github`, `productionRead`, `localArtifacts`, `pcBrowser`, `adminSession`, `authenticatedApi`, `adminPanel` and `browserReturn`. For the authenticated API and Return, verify availability separately from actually writing or sending. A surface that only reads the browser does not grant API execution.

When route is `handoff`, finish source verification, deduplication, candidate generation and feasible tests. Use `prepareWorksHandoff({taskId, parentTask, event, localHash, workId, databaseHash, lastRpc})`. Save its JSON, the actual candidate and review, approval scope, image-rights decision, test evidence and the missing capability in the permitted artifact channel. Do not include credentials. Null WORK_ID/DB hash means registration is still pending. The local artifact hash identifies the review and must never be sent to the production RPC as a substitute for the DB candidate hash. If an RPC is UNKNOWN, re-read the recorded ID and hash before any further action.

On the receiving host, use the original task ID, locate the bundle or reconstruct the confirmed details from authorized channels, re-check all matching Production rows including drafts, compare the latest hash and resume only the next uncompleted step. A successful artifact handoff establishes resumability. Direct PC startup requires its own verified capability. Assess Browser Return independently even if the publication route is `handoff`.

## Standard route

1. Check the existing ARA-TECH site Supabase Auth administrator session first. Wait for normal asynchronous session restoration before deciding that login is missing. An initially visible login panel is not proof of a logged-out session.
2. If the session is valid, skip login. Verify the actual user through the existing client's getUser and work_admins membership under RLS when the supported API surface is available. A populated admin dashboard is UI evidence of session restoration; do not invent an independent getUser result from it.
3. Only if the site session is absent or expired, open https://ara-tech.cc/admin.html and wait for the Owner to complete the official site login. Recheck identity and administrator authority, then continue the same task. Supabase Dashboard GitHub OAuth is separate and does not authenticate the WORKS publication API.
4. Execute the existing publish_work_candidate RPC from an officially supported execution surface using that same authenticated client. Use scripts/publish-reviewed.mjs for reviewed IDs and pinned hashes when its client is accessible. Maintain actor/time, scope, latest candidate hash and audit gates. Verify approved image bytes only when the pinned candidate uses a public image. Never extract tokens/cookies/localStorage, impersonate identity, use service_role/postgres, or directly update is_published.
5. If the site session is present but the current tool only offers read-only DOM evaluation and UI interaction, and exposes no authenticated API invocation, report SITE_SESSION_PRESENT_API_EXECUTION_UNAVAILABLE. Do not mislabel this as missing authentication or ask for repeated login. Do not manufacture an execution surface or automate the publish/OK dialog as a substitute.
6. Independently read Production and verify actual public PC/mobile rendering after a successful RPC. Reuse a matching row and any verified image already in Storage. Continue authorized browser Return even if publication is HOLD.

## Password CLI is not the standard

The original verified runtime kit proposed a direct PowerShell hidden-password login with a separate CurrentUser DPAPI refresh-token store. The Owner superseded that default during WKS-004. Do not launch that password prompt, ask the Owner to create a second session, or store a new credential as part of normal WORKS work. An empty CLI token store does not prove the site is unauthenticated.

works-publish-cli.mjs and its tests are retained for provenance and explicitly requested optional use, not automatically selected authentication. Its password-login command refuses execution without --explicit-local-login. That opt-in must never be added by an agent merely to get past the refusal. No such optional authorization is present in the corrected standard. Existing stored credentials, if any, are not deleted implicitly.

Run skill/CLI safety checks without credentials:

    node --test .agents/skills/ara-works-publish/scripts/publish-reviewed.test.mjs .agents/skills/ara-works-publish/scripts/works-publish-cli.test.mjs

Mocks, DPAPI roundtrip and skill discovery do not establish Production publication PASS.

## In-session shared publication panel

The existing admin.html now mounts #reviewed-api-publication after authenticated data loading. The five steps start from 公開手順を開く on the pending row or editor. They display the ID and event details, require an explicit image choice, then show final public content and the current hash. この公演を正式公開 calls the shared publishReviewed helper with the current Supabase client. If administrator input is required, this is the final action. getUser, work_admins/RLS, fresh row/hash, image approval and byte validation run before the existing RPC. No token leaves the session. Image preparation may select a permitted image through the existing Storage flow or persist explicit omission with a hash-scoped update. The final step uses the RPC. Already published results open the result step with the public URL. On UNKNOWN, read the row before any new instruction; do not automatically resubmit. This is a common candidate implementation, not a widened WKS001_IDS list. Code deployment and test PASS do not establish operational success; record the real publication/readback/display outcome separately.
