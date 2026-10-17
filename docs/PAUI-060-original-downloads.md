# PAUI-060: original downloads and integrated Preview candidate

This candidate extends PAUI-058 `dd6c991c4049dd961594212ab1e3751986940867`,
which includes the unmerged PAUI-056/057 and published PAUI-054/055 chain.
Production remains `d541006c81f70a1c4ee093b41ad140b20cc486f2`.
The three PAUI-059 installed RPC bodies were freshly verified against their
approved definitions. No SQL migration is run by this task.

## Download contract

An explicit card or viewer save uses `/data/download/` binary GET routes in
the existing Owner-JWT/RLS adapter. Existing preview routes retain their MIME
and magic checks. Download permits other original file types, including MP3,
WAV, ZIP, Office documents and CSV, without conversion, execution, compression,
public URLs or an arbitrary-path reader. The existing 20 MiB bound remains.

Case/message/thread/MIME-part attribution, original MIME/size, persisted SHA
where available, registered portal/version/storage-path relationships and
commercial PDF hashes are verified before responding. Owner and case access
are rechecked before a download response. Downloads use the existing portal
attachment filename encoder and stream, attachment disposition, no-store,
nosniff, a sandbox policy, byte length and SHA256. The client independently
checks returned bytes and expected SHA, retains Japanese names, and discards
results after session/case changes. Save URLs are released after use.

Shared Gallery cards and viewers cover inbound/outbound mail, the warehouse,
all indexed portal versions, commercial originals and linked inquiry files.
Existing quote-history and order-document downloads use the same save helper.
The shared event-portal view exposes saves for cards, photos, performer files
and the existing nested PDF dialog, retaining its existing authorization path.

An unaccepted confirmation has no saved acceptance receipt. Its metadata is
not a PDF original. A read-only receipt download requires the exact accepted
contract and an immutable stored receipt with matching SHA; it never regenerates
or reissues a confirmation. Inquiry records with no canonical original reference
remain explicitly unavailable. No filename inference creates an identity.

## Protected integration

The three attachment types, durable send-operation identity, SENT/UNKNOWN
handling, customer approval selection, atomic formal registration, PAUI-054
adoption evidence, strict historical UNKNOWN classifier and invoice matching
are retained. A download invokes none of their mutation operations. Existing
commercial state machines, SQL files, billing/payment records, Gmail labels,
send routes and the legacy UI source are protected. The shared binary stream
only gains close/backpressure cleanup; it changes no send/claim state.

New isolated checks use the real read adapter, Provider reader and CASE DESK
modules. They exercise format/byte/name/hash matrices, refusals and lifecycle
races on desktop/mobile, plus the actual shared portal component and dialog.
All baseline tests retain their names, expectations and bytes. Full regression,
official CI and Owner Preview evidence are recorded separately from this design.

## Authority and remaining gates

This task authorizes Source, isolated tests, official CI and a Preview candidate.
Production deployment, main merge, DB/Origin changes, customer sends, actual-case
adoption/change agreements and commercial writes remain forbidden. Owner live
acceptance is read-only. If existing Preview Origin guards block commercial
read/review actions, report the exact branch/origin as a limited decision;
do not modify settings or claim acceptance. Production is HOLD pending a separate
Owner release decision even after a successful candidate review.
