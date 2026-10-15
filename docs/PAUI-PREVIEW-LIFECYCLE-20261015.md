# CASE DESK preview lifecycle continuation

Baseline Production: source `5b2436a47da07b2f279681d35e330de6ca492643`, tree `2fc811eca9c72d717f09800bbdcb44d210995922`, deployment `dpl_4yp1e1GWpCt9yTF7AUhbPTK8gmHk`.

Delayed `loadSurface()` completion re-renders CASE DESK and disposes its thumbnail galleries. Previously gallery disposal also closed the full PDF preview, losing its page and zoom. The runtime regression fixture reproduces this on the baseline using actual PDF.js.

A memory-only preview scope now belongs to the selected case, selection epoch, exact Auth session and tab. Thumbnail galleries still dispose/rebuild on index refresh; their open full preview remains in that scope with the same dialog, PDF document, page canvas, page number and zoom. The scope adds no endpoint, cache bypass or authority. Opening a full preview still makes the normal fresh authenticated original request and retains identity refusal behavior.

Case/tab changes, logout, session/token changes, expiry and pagehide dispose the scope. Explicit close immediately releases its object URL and PDF document, even if the gallery has already been replaced. Late original/PDF results are released rather than displayed. PDF destruction and gallery/scope disposal are idempotent. The warehouse gallery is no longer registered twice for disposal.

The new delayed runtime fixture releases three independent index responses, verifies the actual re-render on each response, and asserts identical dialog/canvas, page2 at125%, and no additional original reads. It also covers mail attachments, sent-estimate PDFs, case/tab switch, logout/Auth changes, expiry, identity refusal, close during an original request and exactly-once PDF destruction. All existing test files remain unchanged. Full local/official CI and normal Owner Preview/Production acceptance are separate release gates.

This continuation reuses PR19 and its existing Preview branch. Legacy UI, Gmail discovery/indexing/backend, commercial state, candidate adoption/version/publication, authentication/ACL/Origin/rate policy and main remain unchanged. Owner acceptance uses existing PDF originals through GET only; no customer send or business write is permitted.

Rollback is the baseline deployment above. No automatic rollback is configured.
