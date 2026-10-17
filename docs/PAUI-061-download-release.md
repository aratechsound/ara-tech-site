# PAUI-061 limited original downloads

Base: current Production `d541006c81f70a1c4ee093b41ad140b20cc486f2`.
Reuse the PAUI-060 download implementation without merging its PAUI-056–058
commercial features or changing PAUI-060's branch and records.

Scope: received/sent indexed mail attachments, registered warehouse versions,
private portal-upload originals, and persisted inquiry attachment references.
PDF/image preview remains separate from explicit original saving. MP3, WAV,
ZIP, Office, CSV and other opaque bytes can be saved without executing them.
Owner JWT, current case ACL, thread/message/MIME identity, source hashes and
20 MiB bound remain mandatory. A download rechecks session/case/binding after
retrieval. Filenames use the existing RFC 6266 encoder; save verifies SHA-256.
Missing persisted original hashes are not reported as independent hash proof.

Commercial registered originals and receipt downloads are excluded/HOLD.
Their existing display, preview and actions remain unchanged. New generic
download buttons on such cards are disabled with an explanation. No new
commercial inventory API, adoption flow, attachment classification, invoice
integration, SQL, grants, Origin settings or shared send transport is included.
The existing accepted PAUI-054/055 behavior and all baseline tests are retained.

The original retrieval adapter performs only authenticated reads. File saving
does not synchronize mail, classify, send, adopt or change business state.
Existing screen-entry sync behavior is unchanged. An unsupported preview never
automatically downloads or executes the original. Errors remain visible.

Release requires official CI, exact candidate/source/tree evidence and explicit
Owner Production authorization. No main merge, production deployment, database
mutation, customer send or business operation is authorized by this candidate.
