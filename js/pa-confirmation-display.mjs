const SENT_STATES = new Set(["sent", "reconciled_sent"]);
const DEFINITELY_NOT_SENT_STATES = new Set([
    "definitely_not_sent",
    "failed_before_provider",
    "failed_after_provider_response",
    "queued",
    "processing"
]);
const UNRESOLVED_STATES = new Set(["queued", "processing", "failed", "unknown"]);

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

export const selectCurrentDeliveryIssues = ({ outbox = [], offers = [], estimates = [], billings = [], currentEstimate, billing, accepted, active } = {}) => {
    const knownAggregates = new Set([
        ...offers.map((item) => item.id),
        ...estimates.map((item) => item.id),
        ...billings.map((item) => item.id)
    ]);
    const belongsToCurrent = (item) => {
        if (item.job_kind === "estimate") return Boolean(currentEstimate && item.aggregate_id === currentEstimate.id);
        if (item.job_kind === "invoice") return Boolean(billing && item.aggregate_id === billing.id);
        if (item.job_kind === "accept_receipt") return Boolean(accepted && item.aggregate_id === accepted.id);
        if (["confirmation", "confirmation_reminder"].includes(item.job_kind)) {
            return Boolean(active && item.aggregate_id === active.id);
        }
        return !knownAggregates.has(item.aggregate_id);
    };
    return [...outbox]
        .filter((item) => UNRESOLVED_STATES.has(item.state) && belongsToCurrent(item))
        .sort((left, right) => timestamp(right) - timestamp(left));
};

export const selectHistoricalConfirmationIssues = ({ offers = [], outbox = [], accepted, active } = {}) => {
    const currentId = (accepted || active)?.id;
    const versions = new Map(offers.map((offer) => [offer.id, offer.version]));
    return [...outbox]
        .filter((item) => ["confirmation", "confirmation_reminder"].includes(item.job_kind)
            && UNRESOLVED_STATES.has(item.state)
            && item.aggregate_id !== currentId
            && versions.has(item.aggregate_id))
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
