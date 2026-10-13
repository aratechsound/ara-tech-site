# PAUI-030 mail index candidate

The conversation list previously read only `pa_gmail_message_index`, ordered by `indexed_at`. Reindexing an old message could therefore put it above newer mail. Sorting now uses `received_at` / `sent_at` with a stable message-ID tie break; unknown dates sort last.

An explicit “Gmail最新を読取確認” button GETs only existing approved `pa_gmail_thread_links`. It validates normal Owner JWT, work_admins, readable case, exclusive thread ownership and message-index conflicts before projecting fresh Provider metadata. Missing index rows display as not saved, without creating index rows or changing attention. Full body and attachments recheck the exact case/thread/message, and stable MIME part, using fresh Provider message reads. Original MIME, size and magic guards remain. No sender/subject matching or unknown-thread discovery runs here.

Saved rows remain available after partial Provider failure, with explicit UNKNOWN. No linked threads is distinct from an empty successful linked-thread check. Every result limits freshness to approved links and states that unlinked threads were not checked. Selecting a case or opening the conversation does not trigger this check or any sync.

NEW requires saved per-message attention evidence. Unindexed rows cannot infer NEW; saved customer-waiting attention is not updated by GET. `indexed_at` is persistence time, never mail time.

## Owner gate for a separate thread

Case attribution needs canonical evidence and a fresh exclusive ownership check. Similar sender/subject is insufficient. No candidate can be called approved without actual DB readback. The existing authenticated POST `/api/pa-gmail`, `action=manual_link`, is an approval-gated business operation: it also calls `syncCase`, writes the index/attention/audit and can run candidate detection. A future Owner approval must explicitly cover both the exact link and those indexing/sync effects. This candidate never invokes it or opens the old UI. Do not add a “read-only” wrapper around that action.

## Verification scope

Two reported October 13 messages were found and read through the ARA-TECH Gmail connector in the same October 10 thread. No existing Owner session was available in the browser, so Production DB linkage, indexed_at and actual candidate UI display remain HOLD. A (ordering) is confirmed in source; B/C/D for the specific live incident remain unconfirmed. Fixture PASS does not resolve these gates.

Production deploy, DB/ACL migration, Gmail sync/send/mark-read, commercial changes and existing PR changes are outside this task. Base: cffc3a631e69af9cd3a9873a2b9595efa7139f13, dependency Draft PR #9.
