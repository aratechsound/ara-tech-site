# Linked Gmail reply synchronization

The global mailbox page previously skipped existing thread links in both the application and `ara_commit_mail_page_v2`. Its coverage timestamp therefore proved unlinked inbox discovery, not reconciliation of case mail. A reply could remain absent from the case index even after a successful global page.

The main branch's legacy `syncCase` already fetched all approved linked threads and refreshed attention. The new CASE DESK's saved-mail view did not invoke that write path. PAUI-041 discovery exists in older branches and in the production database, but is not called by current main. Its historical completion timestamp must not be interpreted as recent linked-thread synchronization. Reintroducing unrelated held branch changes is outside this fix.

Global sync now calls the existing case sync once per linked active case represented on its bounded page and requires the discovered message to appear in that result before committing coverage. Provider failures preserve the cursor. Deleted cases remain suppressed. A thread linked between lookup and commit now causes a database conflict instead of silent omission. Retries remain duplicate free.

Case sync checks global message attribution before upserting, excludes draft/spam/trash messages, and records fresh `state.linked_sync` telemetry in the existing PAUI-041 state table. Historical discovery coverage remains unchanged. The telemetry RPC is invoker-only, executable only by the existing backend role, validates the administrator and exact linked/indexed identities, and receives the actor from the existing authenticated handler. No browser JWT, RLS or administrator impersonation flow is introduced.

Opening the legacy dashboard now loads the saved unlinked inbox only. Mailbox-wide synchronization requires its explicit button. A selected case still uses its existing automatic case sync.

Deploy the migration before the application. Verify case synchronization with the selected case only; do not use global inbox sync as a production test when broader data changes are excluded. Compare case/business/link and non-target index/attention snapshots independently. The global path is exercised using isolated PGlite and fake Gmail transport.

Regression: `node tests/validate-ara-paui088-linked-sync.cjs` covers linked ingestion, attention, replay, provider failure, concurrent links, attribution conflict, RPC privileges, business preservation, draft exclusion and dashboard scope. Existing case, attachment, reply, reconciliation and read-only display tests also apply.
