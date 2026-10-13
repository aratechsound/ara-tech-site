# PAUI-029: materials performance and duplicate projections

Base: PAUI-028 `afee709d6b09651055532859e274a58a90a7cd65`. Preview candidate only; Production, DB, Gmail sync/send, ACL/RLS, and existing PRs #6/#7/#8 are outside mutation scope.

## Findings and change

Code inspection found that every material GET rebuilt all cards/versions/photos, then read all case mail before checking the selected message. Every detail-surface completion, tab switch, and warehouse filter disposed the gallery's blob/PDF cache. IntersectionObserver was lazy but admitted every intersecting card without an application concurrency bound. Provider/SHA candidate reads remain necessary where a registered reference lacks stable part evidence.

Material GET now queries the exact registered version/photo and checks its exact parent/portal/case. Mail GET for an original queries the exact globally Owner-visible message row and all thread ownership rows. Auth/user/admin, Owner JWT, RLS, archived filters, unique attribution, fresh Provider id/thread, MIME/magic/size, part/canonical/SHA and ambiguous-match rejection remain. No server metadata/auth/original cache is introduced. Independent Owner-JWT case/metadata reads overlap; bytes are fetched only after all attribution checks pass.

Metadata mounting stays synchronous and independent of original bytes. A case/exact-session memory store shares pending requests, blob URLs, PDF documents, one PDF.js worker and thumbnails across gallery remounts. Original API concurrency is 2, full preview has queue priority, and offscreen queued jobs are cancelled before a GET starts. Failed reads are not cached. Completed blob retention is limited to 64 entries/64 MiB; no disk, browser storage, shared URL, alternate credential or server-wide private cache. Case switch, refresh, logout, pagehide, expired local Auth, and token changes clear private resources. The local Auth session is checked on cache access. Immediate server-side revocation cannot be inferred from local cached thumbnails; full preview freshly revalidates the normal authenticated original endpoint every time. Existing focus restoration validates user/admin. Per-asset 403 is kept separate from session/admin revocation so one denied asset does not close unrelated allowed previews.

Full previews use freshly fetched bytes and a separate PDF document. Thumbnail canvases/documents cannot serve as original validation. PDF parsing can reuse the case worker without reusing original bytes or the thumbnail PDF document.

## Duplicate display

The indexed mail projection retains attachment resource IDs; sent-estimate projection uses stable MIME parts as IDs. Comparing only `message + id` therefore misses a common duplicate. Both warehouse and estimate/contract screen use the same reconciled collection.

One-to-one matches across these two projections may merge only within the same recorded case, message and thread, with exact attachment ID, MIME part, or correctly shaped canonical identity. Contradictory MIME/part/canonical/SHA prevents merging. Names, size, time and SHA alone do not merge. Every merged card retains both source records, source labels, attachment references, timestamps, subject, direction, recipient projection and original-state history. Indexed normal mail GET remains the primary original route, reducing repeated sent-estimate thread scans. Other mail/resend records, portal versions, commercial revisions and contract evidence stay distinct. Missing or ambiguous strong identity stays unmerged; no speculative byte fetching is used solely to make display duplicates disappear.

## Measured fixture comparison

Linux Docker/Chromium, 1440x760, entirely invented 29 files (15 PDF, 14 JPEG, 2 registered SHA-fallback files). Simulated DB 20ms, Provider message 80ms, original 180ms. Real PDF.js/JPEG decode. Includes one metadata-driven remount while GETs are pending, scroll to all 29, warm remount, then original enlargement. Same fixture and harness against the immutable base and candidate. These are fixture wall times, not real Owner/Provider measurements.

|Metric|PAUI-028|PAUI-029|
|---|---:|---:|
|Metadata|157ms|155ms|
|Initial list including metadata|160ms|160ms|
|DOM mount only|3.1ms|4.4ms|
|First visible thumbnail including metadata|3177ms|806ms|
|Initial visible 16 complete|4101ms|4258ms|
|All29 with scroll|5953ms|7507ms|
|Original enlargement|58ms (cached)|838ms (fresh verified GET)|
|Original API calls over full scenario|61|30 (includes 1 required fresh preview)|
|Warm remount Provider original GETs|24|0|
|Maximum concurrent original API|6 (browser transport)|2 (application bound)|
|DB GETs|739|277|
|Full material scans|62|1 (metadata only)|
|Full mail scans|61|0|
|Provider message/original reads|61/85|30/38|
|Per-file API mean/max|573/1384ms|455/1128ms|
|JPEG decode mean|2.63ms|3.01ms|

PDF getDocument count falls 30 -> 16 (15 cached thumbnails plus one fresh full preview). Candidate parse mean 2.07ms, draw mean 10.55ms. Baseline getDocument includes its own per-document worker startup (mean 416ms); candidate worker startup happens once outside getDocument, so those parse means alone do not describe equivalent boundaries. Cold candidate thumbnail render maximum, including that startup, was 199ms. Provider originals remain ~180ms each in this fixture; SHA fallback API reaches ~1128ms. SHA and part/canonical CPU durations are available via numeric Server-Timing after the change; baseline lacks those internal named timers and is explicitly uninstrumented there. Timers are inclusive/overlapping and must not be summed as disjoint phases. Supabase timer currently measures fetch-to-headers; API/index timers include JSON handling. No customer IDs, body, token, raw bytes or URLs are emitted into performance records.

Initial list <2s and first visible thumbnail <5s meet fixture targets. All29 is slower under the concurrency bound; this tradeoff is reported. The Owner's 30s+ delay has not been remeasured on the new authenticated Preview. Do not claim it eliminated. Dominant residual waits are fresh Provider reads, bounded SHA candidate comparisons, and the queue for all29. Next authorized step: measure numeric Server-Timing and visible milestones in an existing normal Owner Preview session; if Provider dominates, evaluate a separate authenticated thumbnail service or scoped canonical data remediation without skipping original validation. No new Owner login is requested here.

## Checks

PAUI-028 identity 32, Owner read 17, Gmail read 18; new cache/dedupe 14, exact-row attribution 9, two-screen browser fixture, and 29-file benchmark. Existing UI and portal/Gmail regression suites retained. Fixtures were updated only to honor exact PostgREST IDs and supply the thread attribution required by real projections; legacy expected values were not weakened. GitHub CI and Vercel exact-source evidence are recorded in the delivered task report.
