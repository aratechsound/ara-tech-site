const SENT_STATES = new Set(["sent", "reconciled_sent"]);
const DEFINITELY_NOT_SENT_STATES = new Set([
    "definitely_not_sent",
    "failed_before_provider",
    "failed_after_provider_response",
    "queued",
    "processing"
]);

export const confirmationDisplayState = ({ accepted, active, delivery } = {}) => {
    if (accepted) return { key: "accepted", label: "正式受注済み", tone: "ok" };
    if (!active) return { key: "not_issued", label: "未発行", tone: "wait" };

    const deliveryState = String(delivery?.delivery_state || delivery?.state || "unknown");
    if (SENT_STATES.has(deliveryState)) {
        return { key: "waiting_for_customer", label: "回答待ち", tone: "wait" };
    }
    if (DEFINITELY_NOT_SENT_STATES.has(deliveryState)) {
        return { key: "not_sent", label: "送信未完了", tone: "wait" };
    }
    return { key: "delivery_ambiguous", label: "送信結果確認中", tone: "wait" };
};
