import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    DELIVERY_SCOPE,
    classifyDeliveryScope,
    selectCurrentDeliveryIssues,
    selectHistoricalConfirmationIssues
} from "../js/pa-confirmation-display.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const active = { id: "offer-7", version: 7, state: "active" };
const revoked = { id: "offer-6", version: 6, state: "revoked" };
const uncertainLifecycle = { id: "offer-8", version: 8, state: "unknown" };
const offers = [active, revoked, uncertainLifecycle];
const activeJob = { id: "current-7", aggregate_id: active.id, job_kind: "confirmation", state: "unknown" };
const revokedJob = { id: "history-6", aggregate_id: revoked.id, job_kind: "confirmation", state: "unknown" };

assert.equal(classifyDeliveryScope({ item: activeJob, offers, active }), DELIVERY_SCOPE.CURRENT);
assert.equal(classifyDeliveryScope({ item: revokedJob, offers, active }), DELIVERY_SCOPE.HISTORICAL);

const unclassified = [
    { id: "orphan-confirmation", aggregate_id: "missing-offer", job_kind: "confirmation", state: "unknown" },
    { id: "future-current", aggregate_id: active.id, job_kind: "future_delivery", state: "unknown" },
    { id: "orphan-invoice", aggregate_id: "missing-billing", job_kind: "invoice", state: "unknown" },
    { id: "unknown-lifecycle", aggregate_id: uncertainLifecycle.id, job_kind: "confirmation", state: "unknown" }
];
unclassified.forEach((item) => assert.equal(
    classifyDeliveryScope({ item, offers, active }),
    DELIVERY_SCOPE.UNCLASSIFIED,
    `${item.id} must fail closed as unclassified`
));

const selected = selectCurrentDeliveryIssues({ outbox: [revokedJob, ...unclassified], offers, active });
assert.deepEqual(selected.map((item) => item.id).sort(), unclassified.map((item) => item.id).sort());
assert.ok(selected.every((item) => item.delivery_scope === DELIVERY_SCOPE.UNCLASSIFIED));
assert.deepEqual(
    selectHistoricalConfirmationIssues({ outbox: [revokedJob, ...unclassified], offers, active }).map((item) => item.id),
    [revokedJob.id]
);

const currentEstimate = { id: "estimate-2" };
const oldEstimate = { id: "estimate-1" };
assert.equal(classifyDeliveryScope({
    item: { aggregate_id: oldEstimate.id, job_kind: "estimate" },
    estimates: [oldEstimate, currentEstimate],
    currentEstimate
}), DELIVERY_SCOPE.HISTORICAL);

const accepted = { ...active, state: "accepted" };
assert.equal(classifyDeliveryScope({
    item: { aggregate_id: accepted.id, job_kind: "accept_receipt" },
    offers: [accepted, revoked],
    accepted
}), DELIVERY_SCOPE.CURRENT);

const renderer = fs.readFileSync(path.join(root, "js", "pa-commercial-admin.js"), "utf8");
assert.match(renderer, /関連先を確認できない配送（種別：/u);
assert.match(renderer, /pendingJob\.delivery_scope === DELIVERY_SCOPE\.CURRENT/u);
assert.doesNotMatch(renderer, /aggregate_id[^\n]*関連先を確認できない配送/u, "unclassified warning must not expose aggregate IDs");

console.log(JSON.stringify({
    pass: true,
    scopes: ["current", "historical", "unclassified"],
    unclassified_cases: unclassified.length,
    unclassified_action_policy: "NO_SEND_ACTION"
}));
