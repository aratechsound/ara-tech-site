const SENT_STATES = new Set(["sent", "reconciled_sent"]);
const DEFINITELY_NOT_SENT_STATES = new Set([
    "definitely_not_sent",
    "failed_before_provider",
    "failed_after_provider_response",
    "queued",
    "processing"
]);
const UNRESOLVED_STATES = new Set(["queued", "processing", "failed", "unknown"]);
export const DELIVERY_SCOPE = Object.freeze({
    CURRENT: "current",
    HISTORICAL: "historical",
    UNCLASSIFIED: "unclassified"
});

const timestamp = (item) => Date.parse(item?.finished_at || item?.updated_at || item?.created_at || 0) || 0;
const newest = (items) => [...(items || [])].sort((left, right) => timestamp(right) - timestamp(left))[0] || null;
const newestOffer = (offers, state) => [...(offers || [])]
    .filter((item) => item.state === state)
    .sort((left, right) => Number(right.version || 0) - Number(left.version || 0))[0] || null;

export const effectiveDeliveryState = (delivery) => String(delivery?.delivery_state || delivery?.state || "unknown");

export const selectConfirmationContext = ({ offers = [], outbox = [] } = {}) => {
    const accepted = newestOffer(offers, "accepted");
    const active = newestOffer(offers, "active");
    const current = accepted || active;
    const delivery = current
        ? newest(outbox.filter((item) => item.job_kind === "confirmation" && item.aggregate_id === current.id))
        : null;
    const receiptDelivery = accepted
        ? newest(outbox.filter((item) => item.job_kind === "accept_receipt" && item.aggregate_id === accepted.id))
        : null;
    return { accepted, active, current, delivery, receiptDelivery };
};

export const classifyDeliveryScope = ({ item, offers = [], estimates = [], billings = [], currentEstimate, billing, accepted, active } = {}) => {
    const aggregateId = item?.aggregate_id;
    const offer = offers.find((candidate) => candidate.id === aggregateId);
    const estimate = estimates.find((candidate) => candidate.id === aggregateId);
    const invoiceBilling = billings.find((candidate) => candidate.id === aggregateId);

    if (item?.job_kind === "estimate") {
        if (currentEstimate && aggregateId === currentEstimate.id) return DELIVERY_SCOPE.CURRENT;
        if (currentEstimate && estimate) return DELIVERY_SCOPE.HISTORICAL;
        return DELIVERY_SCOPE.UNCLASSIFIED;
    }
    if (item?.job_kind === "invoice") {
        if (billing && aggregateId === billing.id) return DELIVERY_SCOPE.CURRENT;
        if (billing && invoiceBilling) return DELIVERY_SCOPE.HISTORICAL;
        return DELIVERY_SCOPE.UNCLASSIFIED;
    }
    if (item?.job_kind === "accept_receipt") {
        if (accepted && aggregateId === accepted.id) return DELIVERY_SCOPE.CURRENT;
        if (offer?.state === "revoked" || offer?.state === "accepted") return DELIVERY_SCOPE.HISTORICAL;
        return DELIVERY_SCOPE.UNCLASSIFIED;
    }
    if (["confirmation", "confirmation_reminder"].includes(item?.job_kind)) {
        if (active && aggregateId === active.id) return DELIVERY_SCOPE.CURRENT;
        if (offer?.state === "revoked" || (accepted && aggregateId === accepted.id)) return DELIVERY_SCOPE.HISTORICAL;
        return DELIVERY_SCOPE.UNCLASSIFIED;
    }
    return DELIVERY_SCOPE.UNCLASSIFIED;
};

export const selectCurrentDeliveryIssues = (input = {}) => {
    const { outbox = [] } = input;
    return [...outbox]
        .filter((item) => UNRESOLVED_STATES.has(item.state))
        .map((item) => ({ ...item, delivery_scope: classifyDeliveryScope({ ...input, item }) }))
        .filter((item) => item.delivery_scope !== DELIVERY_SCOPE.HISTORICAL)
        .sort((left, right) => timestamp(right) - timestamp(left));
};

export const selectHistoricalConfirmationIssues = (input = {}) => {
    const { offers = [], outbox = [] } = input;
    const versions = new Map(offers.map((offer) => [offer.id, offer.version]));
    return [...outbox]
        .filter((item) => ["confirmation", "confirmation_reminder"].includes(item.job_kind)
            && UNRESOLVED_STATES.has(item.state))
        .map((item) => ({ ...item, delivery_scope: classifyDeliveryScope({ ...input, item }) }))
        .filter((item) => item.delivery_scope === DELIVERY_SCOPE.HISTORICAL
            && offers.find((offer) => offer.id === item.aggregate_id)?.state === "revoked")
        .sort((left, right) => timestamp(right) - timestamp(left))
        .map((item) => ({ ...item, confirmation_version: versions.get(item.aggregate_id) }));
};

export const confirmationDisplayState = ({ accepted, active, delivery } = {}) => {
    if (accepted) return { key: "accepted", label: "正式受注済み", tone: "ok" };
    if (!active) return { key: "not_issued", label: "未発行", tone: "wait" };

    const deliveryState = effectiveDeliveryState(delivery);
    if (SENT_STATES.has(deliveryState)) {
        return { key: "waiting_for_customer", label: "回答待ち", tone: "wait" };
    }
    if (DEFINITELY_NOT_SENT_STATES.has(deliveryState)) {
        return { key: "not_sent", label: "送信未完了", tone: "wait" };
    }
    return { key: "delivery_ambiguous", label: "送信結果確認中", tone: "wait" };
};

export const confirmationNextAction = ({ accepted, active, delivery } = {}) => {
    const display = confirmationDisplayState({ accepted, active, delivery });
    if (display.key === "accepted") return null;
    if (display.key === "not_issued") return "顧客了承の根拠を確認し、正式受注確認を準備してください。";
    if (display.key === "waiting_for_customer") return "お客様の正式回答を待っています。";
    if (display.key === "delivery_ambiguous") return "現在の正式受注確認の送信結果を照合してください。盲目的な再送・再発行はできません。";
    const deliveryState = effectiveDeliveryState(delivery);
    if (delivery?.state === "queued" || deliveryState === "queued") return "正式受注確認は送信待ちです。内容を確認して送信してください。";
    if (delivery?.state === "processing" || deliveryState === "processing") return "正式受注確認を送信処理中です。完了をお待ちください。";
    return "現在の正式受注確認は送信未完了です。配送状態を確認してください。";
};
