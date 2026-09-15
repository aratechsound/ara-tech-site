import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    confirmationDisplayState,
    confirmationNextAction,
    selectConfirmationContext,
    selectCurrentDeliveryIssues,
    selectHistoricalConfirmationIssues
} from "../js/pa-confirmation-display.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const oldOffer = { id: "offer-6", version: 6, state: "revoked" };
const activeOffer = { id: "offer-7", version: 7, state: "active" };
const oldUnknown = { id: "job-6", aggregate_id: oldOffer.id, job_kind: "confirmation", state: "unknown", created_at: "2026-09-15T01:00:00Z" };
const activeSent = { id: "job-7", aggregate_id: activeOffer.id, job_kind: "confirmation", state: "sent", delivery_state: "sent", created_at: "2026-09-15T02:00:00Z" };

const mixed = { offers: [activeOffer, oldOffer], outbox: [oldUnknown, activeSent] };
const context = selectConfirmationContext(mixed);
assert.equal(context.active.id, activeOffer.id);
assert.equal(context.delivery.id, activeSent.id);
assert.equal(confirmationDisplayState(context).label, "回答待ち");
assert.equal(confirmationNextAction(context), "お客様の正式回答を待っています。");
assert.deepEqual(selectCurrentDeliveryIssues({ outbox: mixed.outbox, offers: mixed.offers, active: context.active }), []);
assert.deepEqual(selectHistoricalConfirmationIssues({ ...mixed, active: context.active }).map((item) => item.confirmation_version), [6]);

for (const state of ["queued", "processing", "failed", "unknown"]) {
    const delivery = { ...activeSent, state, delivery_state: state };
    const scenario = { offers: mixed.offers, outbox: [oldUnknown, delivery] };
    const selected = selectConfirmationContext(scenario);
    assert.equal(selected.delivery.id, activeSent.id, `#7 ${state} remains the selected current delivery`);
    assert.equal(selectCurrentDeliveryIssues({ outbox: scenario.outbox, offers: scenario.offers, active: selected.active }).length, 1);
    assert.equal(selectHistoricalConfirmationIssues({ ...scenario, active: selected.active }).length, 1);
    assert.doesNotMatch(confirmationNextAction(selected), /^お客様の正式回答を待っています。$/, `#7 ${state} must not look sent`);
}

const acceptedOffer = { ...activeOffer, state: "accepted" };
const receiptUnknown = { id: "receipt-7", aggregate_id: acceptedOffer.id, job_kind: "accept_receipt", state: "unknown" };
const acceptedContext = selectConfirmationContext({ offers: [acceptedOffer, oldOffer], outbox: [oldUnknown, activeSent, receiptUnknown] });
assert.equal(confirmationDisplayState(acceptedContext).label, "正式受注済み");
assert.equal(acceptedContext.receiptDelivery.id, receiptUnknown.id);
assert.deepEqual(selectCurrentDeliveryIssues({ outbox: [oldUnknown, activeSent, receiptUnknown], offers: [acceptedOffer, oldOffer], accepted: acceptedOffer }).map((item) => item.id), [receiptUnknown.id]);

const estimate = { id: "estimate-2" };
const oldEstimateUnknown = { id: "estimate-1-job", aggregate_id: "estimate-1", job_kind: "estimate", state: "unknown" };
const currentEstimateFailed = { id: "estimate-2-job", aggregate_id: estimate.id, job_kind: "estimate", state: "failed" };
assert.deepEqual(selectCurrentDeliveryIssues({ outbox: [oldEstimateUnknown, currentEstimateFailed], estimates: [{ id: "estimate-1" }, estimate], currentEstimate: estimate }).map((item) => item.id), [currentEstimateFailed.id]);

const currentBilling = { id: "billing-current" };
const currentInvoiceUnknown = { id: "invoice-current-job", aggregate_id: currentBilling.id, job_kind: "invoice", state: "unknown" };
assert.deepEqual(selectCurrentDeliveryIssues({ outbox: [oldUnknown, currentInvoiceUnknown], offers: mixed.offers, billings: [currentBilling], billing: currentBilling, active: activeOffer }).map((item) => item.id), [currentInvoiceUnknown.id]);
const unmappedUnknown = { id: "unmapped-job", aggregate_id: "unknown-aggregate", job_kind: "future_delivery", state: "unknown" };
assert.deepEqual(selectCurrentDeliveryIssues({ outbox: [unmappedUnknown], offers: mixed.offers, active: activeOffer }).map((item) => item.id), [unmappedUnknown.id]);

const olderOffer = { id: "offer-5", version: 5, state: "expired" };
const olderUnknown = { id: "job-5", aggregate_id: olderOffer.id, job_kind: "confirmation", state: "unknown", created_at: "2026-09-13T01:00:00Z" };
const reordered = { offers: [olderOffer, oldOffer, activeOffer], outbox: [activeSent, olderUnknown, oldUnknown] };
assert.equal(selectConfirmationContext(reordered).delivery.id, activeSent.id);
assert.deepEqual(selectHistoricalConfirmationIssues({ ...reordered, active: activeOffer }).map((item) => item.confirmation_version), [6, 5]);

const source = fs.readFileSync(path.join(root, "js", "pa-commercial-admin.js"), "utf8");
assert.doesNotMatch(source, /const pendingJob = \(data\.outbox/u);
assert.match(source, /過去の配送要確認/u);
assert.match(source, /履歴：正式受注確認 #/u);
assert.match(source, /selectCurrentDeliveryIssues/u);
assert.match(source, /selectHistoricalConfirmationIssues/u);

console.log(JSON.stringify({
    pass: true,
    active_sent_old_unknown: "CURRENT_7_WAITING_FOR_CUSTOMER",
    historical_unknown: "HISTORY_6_NO_ACTION",
    active_unresolved_variants: 4,
    accepted_receipt_scope: "PRESERVED",
    stale_global_pending_selector: "REMOVED"
}));
