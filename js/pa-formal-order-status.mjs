// Display projection of the existing accepted contract/booking authority.
// This value must never be persisted in pa_inquiries.status.
export const formalOrderStatus = "formal_order_confirmed";
const terminal = new Set(["closed", "cancelled", "declined", "schedule_unavailable"]);
export const hasFormalOrder = (item, progress = item?.progress) =>
    item?.case_type === "PA_EVENT" && !item.deleted_at
    && !terminal.has(item.status) && !progress?.closed_at
    && Boolean(progress?.formal_contract_id || (progress?.booking_confirmed_on && progress?.estimate_approved_on));
export const formalOrderDisplayStatus = (item, progress = item?.progress) =>
    hasFormalOrder(item, progress) && item.status !== "on_hold" && !progress?.is_on_hold
        ? formalOrderStatus : item?.status;
export const verifyExistingFormalOrder = async (client, caseId) => {
    const [inquiry, progress] = await Promise.all([
        client.from("pa_inquiries").select("id,status,case_type,deleted_at").eq("id", caseId).single(),
        client.from("pa_case_progress").select("formal_contract_id,booking_confirmed_on,estimate_approved_on,is_on_hold,closed_at").eq("inquiry_id", caseId).single()
    ]);
    if (inquiry.error || progress.error) throw new Error("正式受注の記録を確認できませんでした。再読み込みしてください。");
    if (formalOrderDisplayStatus(inquiry.data, progress.data) !== formalOrderStatus)
        throw new Error("保存済みの正式契約・予約確定の記録が必要です。正式受注確認から記録を確認してください。");
    return progress.data;
};
