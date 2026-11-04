# API contract and historical evidence

## WKS-001: proven boundary

Source: PR #39, production source commit `287c636ed7b372c6ab44d5165205bdc364be3fde`, `js/work-batch-publish.mjs`, `js/admin.js`, and `docs/WKS-001-reviewed-scope.json`.

The local WKS-001 RETURN.md, EVIDENCE.json, pre-publication-return.md and finalizer/readback artifacts establish: Owner started the existing authenticated admin-session batch API once; Codex did not automate publish/OK clicks. This is NOT proof of a fully browser-free or unattended Codex execution. The documented missing prerequisite was a supported way to execute within the existing authenticated runtime without exporting browser credentials.

Authentication was existing Supabase user session -> `auth.getUser()` -> `work_admins.user_id` membership under RLS. Exact IDs 89–98 were pinned. Stored image SHA/MIME/size/decode were verified; only `image_usage_status` and `use_image_on_public_page` were CAS-updated when needed. Image approval triggers recorded actor/time/audit. A fresh row supplied `p_work_id` and `p_candidate_hash` to `publish_work_candidate`; published state was read back. Ambiguous RPC responses were never automatically retried. The finalizer only generated reports; it did not publish.

Independent after-work-posts.json and publication-audit.json showed all ten formally approved/published, image actor/time and ten image selection audits. Production/source byte hashes, HTTP/image SHA, sitemap and 20 rendered PC/mobile checks supported publication PASS. Original conversation Return remained HOLD in WKS-001. Current GitHub main and deployed Production may differ: inspect both; do not assume this old module exists in main.

## WKS-004 verified Production continuation (2026-11-05 JST)

The shared admin.html `#reviewed-api-publication` panel reused the automatically restored WORKS site session. The Owner activated `AK-69を正式公開` once for ID99 after its current event, hash and stored image were displayed. The generic `js/work-reviewed-publish.mjs` helper ran through that existing client, user/membership gate, image/hash verification, one existing RPC and row readback. No new credentials, token extraction, OK dialog, INSERT or upload occurred. This is a proven Owner-started in-session API route, not fully unattended Codex publication.

Independent Production readback confirmed ID99 published, pending cleared, approved actor/time present and approved_hash=candidate_hash. The actual public page `https://ara-tech.cc/works/2026-ak-69-live-tour-2026-road-to-toyota-arena-tokyo.html` returned HTTP200 with the existing image SHA, canonical/OGP/Event JSON-LD, official link and sitemap. Actual browser layouts at 1440x1000 and 390x844 showed the correct event/date/venue/PA category and decoded image without horizontal overflow. Existing 84 WORKS rows, Storage metadata, PA inquiry/progress and Gmail index hashes remained equal to the pre-activation baseline. Existing ten public pages and image SHA checks passed. Fixed WKS001_IDS and its module were not widened.

Local evidence for this execution is outputs/WKS-004/final: PUBLICATION_DB.json, HTTP_SEO.json, BROWSER_CHECKS.json, PRESERVATION.json and PC/MOBILE screenshots. Browser Return and formal ACK remain independently recorded in the final task report; publication success is not delivery proof.

## Helper invocation

`scripts/publish-reviewed.mjs` exports `publishReviewed({client, pin, authorization, verifyImage})`. It runs inside an already authorized runtime; it does not obtain credentials, launch browsers or alter auth. `authorization` must contain `workId`, `candidateHash`, `actorId`, `instructionRef`, `publish:true`, and `image:true`. `pin` holds the reviewed DB row. `verifyImage(post)` must verify the exact stored bytes (MIME/signature/size/decode/SHA) and return `{sha256, decoded:true}`. Use the existing Storage validation when the runtime exposes it; do not substitute a fabricated callback on Production. Tests use fakes only.

The helper requires pre-existing image approval/audit timestamps; it does not manufacture approval. If image approval is missing, use the existing authenticated image confirmation contract and then re-read/review the new hash before invoking it. It calls one existing publication RPC at most. No new HTTP endpoint, gateway, deployment, storage bucket or auth mechanism is introduced.

Examples of insufficient access: Supabase management SQL connector only; logged-in browser with no supported execution surface; stale/expired user session; missing `work_admins` membership. Report HOLD and continue authorized Return rather than extract credentials or claim the API was tried.
