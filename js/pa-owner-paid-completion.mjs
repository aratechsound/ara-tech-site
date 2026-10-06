// A UI-only choice; pa_inquiries.status keeps the existing "closed" contract.
export const ownerPaidCompletionStatus = "owner_payment_completed";

export const caseEditorStatus = (item, progress) =>
    item?.status === "closed" && progress?.close_reason === "payment_received"
        ? ownerPaidCompletionStatus
        : item?.status;

export const recordOwnerPaidCompletion = (client, caseId) =>
    client.rpc("update_pa_case_progress", {
        p_inquiry_id: caseId,
        p_progress: { close_reason: "payment_received" },
        p_note: "Ownerが入金確認済みで完了を選択。金額・入金日・方法の登録なし。"
    });
