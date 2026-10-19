# PAUI-063: integrate existing CASE DESK functionality

Base: PAUI-062 Production `b3f144ac9e46cb6db66a4f19021dd2162f7dd670`.
This is a selected dependency integration, without main merge or SQL execution.

- Existing `/api/pa-case-trash` provides recoverable trash with four reasons.
  New UI requires exact case confirmation; one attempt, no automatic retry.
- Estimate/order adds an entry to the existing optional-attachment mail composer.
- PAUI-056 attachment classification is integrated into the PAUI-062 composer
  and immutable send binding. Normal remains the default regardless of filename.
- PAUI-057/058 sent-quote registration and history reuse the approved existing
  RPCs. Old PAUI-057 SQL A is historical isolation-test input only, never applied.
- PAUI-060 original actions reuse the existing commercial API without changing
  Origin policy. Unavailable originals remain unavailable; no lazy generation.
- PAUI-061 Owner GET download and post-fetch binding checks are preserved.

No real send, business adoption/agreement, invoice/payment, UNKNOWN state change,
legacy UI access, DB migration, auth/ACL/Origin change, or automatic rollback.
The one Owner-approved OTHER test case may be moved to trash through the normal
API after strict identity verification; all records remain stored.

The PAUI-061 release boundary validator is updated for this explicitly authorized
integration. Frozen legacy/security/sync files, all prior tests (apart from that
scope validator), and existing SQL remain pinned. Imported regression expectations
are retained. The previous limited-release exclusion is not a perpetual ban on
the separately authorized PAUI-063 integration.

Final Return transport and active-branch visibility are separate evidence. Without
Owner confirmation of the active branch, delivery is DELIVERY_UNVERIFIED.
