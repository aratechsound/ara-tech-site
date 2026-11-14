# WORKS capability and existing-session runtime

## Capability evidence and handoff

Record each probe as `{status, evidence}`, with `status: "verified"` only after an observed result. Run `assessWorksRuntime(probes)` from `scripts/runtime-routing.mjs`. Supported keys are `github`, `productionRead`, `localArtifacts`, `pcBrowser`, `adminSession`, `authenticatedApi`, `adminPanel` and `browserReturn`. Verify browser input with a non-mutating control. Verify API and Return availability separately from writing or sending.

When route is `handoff`, finish source verification, deduplication, candidate generation and feasible tests. Use `prepareWorksHandoff({taskId, parentTask, event, localHash, workId, databaseHash, lastRpc})`. Save its JSON, the actual candidate and review, approval scope, image-rights decision, test evidence and the missing capability in the permitted artifact channel. Do not include credentials. Null WORK_ID/DB hash means registration is still pending. The local artifact hash identifies the review and must never be sent to the production RPC as a substitute for the DB candidate hash. If an RPC is UNKNOWN, re-read the recorded ID and hash before any further action.

On the receiving host, use the original task ID, locate the bundle or reconstruct the confirmed details from authorized channels, re-check all matching Production rows including drafts, compare the latest hash and resume only the next uncompleted step. A successful artifact handoff establishes resumability. Direct PC startup requires its own verified capability. Assess Browser Return independently even if the publication route is `handoff`.

## Standard route

1. Check the existing ARA-TECH site Supabase Auth administrator session first. Wait for normal asynchronous session restoration before deciding that login is missing. An initially visible login panel is not proof of a logged-out session.
2. If the session is valid, skip login. Verify the actual user through the existing client's getUser and work_admins membership under RLS when the supported API surface is available. A populated admin dashboard is UI evidence of session restoration; do not invent an independent getUser result from it.
3. Only if the site session is absent or expired, open https://ara-tech.cc/admin.html and wait for the Owner to complete the official site login. Recheck identity and administrator authority, then continue the same task. Supabase Dashboard GitHub OAuth is separate and does not authenticate the WORKS publication API.
4. Prefer the authenticated admin panel through verified official PC browser controls. Confirm the Owner instruction, exact work, latest hash and image decision, then proceed through the five steps and publish once. If the panel cannot be operated, use scripts/publish-reviewed.mjs through a supported app surface in the same authenticated session. Maintain actor/time, scope, latest candidate hash and audit gates. Verify approved image bytes when the pinned candidate uses a public image. Never extract tokens/cookies/localStorage, impersonate identity, use service_role/postgres, or directly update is_published.
5. If the site session is present but neither route is available, record the missing browser controls or same-session API capability. Preserve the existing session. If the current Cloud runtime cannot execute, hand off the reviewed candidate to PC.
6. Independently read Production and verify actual public PC/mobile rendering after a successful RPC. Reuse a matching row and any verified image already in Storage. Continue authorized browser Return even if publication is HOLD.

## Password CLI is not the standard

The original verified runtime kit proposed a direct PowerShell hidden-password login with a separate CurrentUser DPAPI refresh-token store. The Owner superseded that default during WKS-004. Do not launch that password prompt, ask the Owner to create a second session, or store a new credential as part of normal WORKS work. An empty CLI token store does not prove the site is unauthenticated.

works-publish-cli.mjs and its tests are retained for provenance and explicitly requested optional use, not automatically selected authentication. Its password-login command refuses execution without --explicit-local-login. That opt-in must never be added by an agent merely to get past the refusal. No such optional authorization is present in the corrected standard. Existing stored credentials, if any, are not deleted implicitly.

Run skill/CLI safety checks without credentials:

    node --test .agents/skills/ara-works-publish/scripts/publish-reviewed.test.mjs .agents/skills/ara-works-publish/scripts/works-publish-cli.test.mjs

Mocks, DPAPI roundtrip and skill discovery do not establish Production publication PASS.

## In-session shared publication panel

The existing admin.html mounts #reviewed-api-publication after authenticated data loading. Open 公開手順を開く on the pending row or editor. The five steps display the ID and event details, require an explicit image choice, then show public content and the current hash. The この公演を正式公開 button calls the shared publishReviewed helper with the current Supabase client. Normal administrators can activate it manually. With prior explicit Owner approval for the candidate, Codex can use the same action. getUser, work_admins/RLS, fresh row/hash, and image approval and byte validation when applicable run before the RPC. Image preparation uses the existing Storage flow or persists explicit omission with a hash-scoped update. On UNKNOWN, read the same row and stop automatic resubmission. Verify Production DB and public rendering after execution.

For a published work, use the same-session 画像だけ追加 control when present. Enter the existing instruction reference, selected SHA-256, provenance and actual rights status. Preserve the formal approval and work ID. Stop for a recorded explicit usage/access restriction and continue the authorized Browser Return independently. The same Owner selection can drive the verified steps without another GO.
