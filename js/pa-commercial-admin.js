let activeCaseId = null;
let refreshEpoch = 0;
let activeCommercialDraftContext = null;
const previewUrls = new Map();

const byId = (id) => document.getElementById(id);
const element = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (typeof text === "string") node.textContent = text;
    return node;
};
const money = (value, currency = "JPY") => value == null
    ? "未確定"
    : new Intl.NumberFormat("ja-JP", { style: "currency", currency, maximumFractionDigits: currency === "JPY" ? 0 : 2 }).format(Number(value));
const dateTime = (value) => value ? new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "未取得";
const button = (label, action, className = "button button--secondary button--small") => {
    const node = element("button", className, label);
    node.type = "button";
    node.addEventListener("click", action);
    return node;
};
const appendLine = (root, label, value, className = "") => {
    const row = element("p", className);
    const name = element("span", "pa-commercial__label", `${label}：`);
    row.append(name, document.createTextNode(value));
    root.append(row);
};

const api = async (context, action, input = {}, binary = false) => {
    const token = await context.getAccessToken();
    if (!token || context.getCurrentCase()?.id !== activeCaseId) throw Error("case_changed");
    const response = await fetch("/api/pa-mail?surface=commercial", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ action, case_id: activeCaseId, ...input }),
        cache: "no-store"
    });
    if (binary && response.ok) return response.blob();
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw Error(payload.code || "commercial_request_failed");
    return payload.result;
};

const renderDocument = async (context, item, root, currentEpoch) => {
    const card = element("button", "pa-commercial-file");
    card.type = "button";
    card.title = `${item.original_filename}を開く`;
    const preview = element("span", "pa-commercial-file__preview");
    preview.append(element("span", "pa-commercial-file__fallback", item.mime_type === "application/pdf" ? "PDFを読込中" : "資料"));
    const meta = element("span", "pa-commercial-file__meta");
    meta.append(element("strong", "", item.original_filename), element("span", "", `${item.document_kind} / ${item.source_kind}`));
    card.append(preview, meta);
    root.append(card);
    try {
        const blob = await api(context, "document", { document_id: item.id }, true);
        if (currentEpoch !== refreshEpoch || activeCaseId !== item.inquiry_id) return;
        const prior = previewUrls.get(item.id);
        if (prior) URL.revokeObjectURL(prior);
        const url = URL.createObjectURL(blob);
        previewUrls.set(item.id, url);
        preview.replaceChildren();
        if (item.mime_type.startsWith("image/")) {
            const image = document.createElement("img");
            image.src = url;
            image.alt = "";
            preview.append(image);
        } else if (item.mime_type === "application/pdf") {
            const frame = document.createElement("iframe");
            frame.src = `${url}#page=1&view=FitH&toolbar=0&navpanes=0`;
            frame.title = `${item.original_filename}の先頭ページ`;
            frame.setAttribute("sandbox", "");
            preview.append(frame);
        } else preview.append(element("span", "pa-commercial-file__fallback", "ダウンロードして確認"));
        card.addEventListener("click", () => window.open(url, "_blank", "noopener,noreferrer"));
    } catch {
        preview.replaceChildren(element("span", "pa-commercial-file__fallback", "プレビュー未取得"));
    }
};

const render = async (context, data, epoch) => {
    if (epoch !== refreshEpoch || context.getCurrentCase()?.id !== activeCaseId) return;
    const state = data.state;
    const estimates = data.estimates || [];
    const current = estimates.find((item) => item.id === state.current_estimate_revision_id);
    const billing = (data.billings || []).find((item) => item.state === "open") || data.billings?.[0];
    const accepted = (data.offers || []).find((item) => item.state === "accepted");
    const active = (data.offers || []).find((item) => item.state === "active");
    const pendingJob = (data.outbox || []).find((item) => ["queued", "failed", "unknown", "processing"].includes(item.state));
    const paid = (data.payments || []).reduce((sum, item) => sum + Number(item.amount || 0), 0)
        + (data.adjustments || []).reduce((sum, item) => sum + Number(item.delta_minor || 0), 0);
    activeCommercialDraftContext = Object.freeze({
        caseId: activeCaseId,
        state: Object.freeze({ ...state }),
        currentEstimate: current ? Object.freeze({ ...current }) : null,
        acceptedContract: accepted ? Object.freeze({ ...accepted }) : null,
        activeConfirmation: active ? Object.freeze({ ...active }) : null,
        billing: billing ? Object.freeze({ ...billing }) : null
    });

    const estimateRoot = byId("pa-estimate-summary");
    estimateRoot.replaceChildren();
    if (!current) {
        estimateRoot.append(element("span", "pa-commercial__status pa-commercial__status--wait", "見積未発行"));
        appendLine(estimateRoot, "原本", "未登録");
    } else {
        estimateRoot.append(element("span", "pa-commercial__status pa-commercial__status--ok", `見積 第${current.revision_number}版・現在`));
        estimateRoot.append(element("p", "pa-commercial__amount", money(current.amount_minor, current.currency)));
        appendLine(estimateRoot, "発行", dateTime(current.issued_at));
        appendLine(estimateRoot, "送信状態", data.outbox.find((item) => item.job_kind === "estimate" && item.aggregate_id === current.id)?.state || "送信済みメールから復旧");
    }
    const estimateActions = element("div", "pa-commercial__compact-actions");
    estimateActions.append(button(current ? "改訂見積を準備" : "見積を添付して送る", () => context.openComposer("estimate_submission"), "button button--small"));
    if (active && !accepted) estimateActions.append(button("旧確認を無効にして改訂開始", async () => {
        const reason = window.prompt("改訂理由を入力してください。旧確認URLは復活できません。", "条件変更のため");
        if (!reason || !window.confirm("対象の未承認確認を無効にして改訂を開始しますか？")) return;
        await api(context, "begin_revision", { expected_revision: state.revision, operation_id: crypto.randomUUID(), reason });
        await context.refreshCommercial();
    }));
    estimateActions.append(button("送信済みメールから登録", () => context.openRecovery()));
    estimateRoot.append(estimateActions);

    const billingRoot = byId("pa-billing-summary");
    billingRoot.replaceChildren();
    if (!billing) {
        billingRoot.append(element("span", "pa-commercial__status pa-commercial__status--wait", "請求未準備"));
        appendLine(billingRoot, "最終精算額", money(state.final_settlement_minor, state.settlement_currency));
        appendLine(billingRoot, "請求書", "別途発行／既存書類を使用を選択");
    } else {
        billingRoot.append(element("span", "pa-commercial__status pa-commercial__status--ok", `請求 #${billing.billing_number}`));
        billingRoot.append(element("p", "pa-commercial__amount", money(billing.amount_minor, billing.currency)));
        appendLine(billingRoot, "書類", billing.invoice_policy === "separate_pdf" ? `請求書PDF・${billing.invoice_delivery_state}` : "既存書類を使用／別途発行なし");
        appendLine(billingRoot, "支払期限", billing.due_date || "期日未確定");
        appendLine(billingRoot, "先方予定日", billing.customer_planned_payment_on || "連絡なし");
        appendLine(billingRoot, "確認済み入金", money(paid, billing.currency));
    }
    const billingActions = element("div", "pa-commercial__compact-actions");
    if (!billing && accepted && current && state.fulfillment_state === "confirmed" && state.settlement_state === "confirmed") {
        billingActions.append(button("請求書を添付して送る", () => context.openComposer("invoice"), "button button--small"));
        billingActions.append(button("既存書類で請求管理", async () => {
            const due = window.prompt("合意した支払期限（YYYY-MM-DD）。未確定なら空欄", "");
            if (due === null || !window.confirm("請求書を別途発行せず、現在の精算額と期限根拠を登録しますか？")) return;
            await api(context, "create_billing", {
                expected_revision: state.revision,
                operation_id: crypto.randomUUID(),
                contract_id: accepted.id,
                estimate_revision_id: current.id,
                amount_minor: Number(state.final_settlement_minor),
                invoice_policy: "no_separate_invoice",
                due_date: due || null,
                due_basis: due ? { status: "agreed", source: "owner_input" } : { status: "unconfirmed", source: "owner_input" },
                customer_planned_payment_on: null,
                agreement_evidence: { source: "owner_confirmed_existing_document" }
            });
            await context.refreshCommercial();
        }));
    }
    billingActions.append(button("請求・精算の詳細へ", () => context.focusBilling()));
    billingRoot.append(billingActions);

    const contractRoot = byId("pa-contract-v5-summary");
    contractRoot.replaceChildren();
    const status = accepted ? "成立" : active ? "回答待ち" : "未発行";
    contractRoot.append(element("span", `pa-commercial__status pa-commercial__status--${accepted ? "ok" : "wait"}`, status));
    appendLine(contractRoot, "対象", accepted ? `見積 第${accepted.snapshot?.estimate_revision_number || "?"}版／正式受注確認 #${accepted.version}` : active ? `見積 第${active.snapshot?.estimate_revision_number || "?"}版／正式受注確認 #${active.version}` : current ? `見積 第${current.revision_number}版` : "見積なし");
    if (active) {
        appendLine(contractRoot, "期限", dateTime(active.expires_at));
        const actions = element("div", "pa-commercial__compact-actions");
        actions.append(button("この確認だけを失効", async () => {
            const reason = window.prompt("失効理由を入力してください。新しい確認は発行しません。");
            if (!reason || !window.confirm("この未承認確認だけを失効しますか？")) return;
            await api(context, "revoke_confirmation", { offer_id: active.id, operation_id: crypto.randomUUID(), reason });
            await context.refreshCommercial();
        }));
        contractRoot.append(actions);
    }
    if (!active && !accepted && current) {
        contractRoot.append(element("p", "pa-commercial__label", "案内作成中はtokenを作らず、最終の発行・送信操作でだけ固定します。"));
        contractRoot.append(button("正式受注確認を送る", () => context.openComposer("confirmation"), "button button--small"));
    }

    const nextRoot = byId("pa-next-action-summary");
    nextRoot.replaceChildren();
    byId("pa-data-freshness").textContent = `取得 ${dateTime(new Date().toISOString())}`;
    const next = pendingJob?.state === "unknown" ? "送信結果を照合してください。盲目的な再送・再発行はできません。"
        : state.estimate_change_state === "reconfirming" ? "条件再確認中です。新しい見積を作成してください。"
            : !current ? "最初の見積PDF・金額・条件を確認してください。"
                : !accepted ? active ? "お客様の正式回答を待っています。" : "顧客了承の根拠を確認し、正式受注確認を準備してください。"
                    : state.fulfillment_state !== "confirmed" ? "開催終了後、実施・追加費用を人が確認してください。"
                        : state.settlement_state !== "confirmed" ? "最終精算額と未処理変更を確認してください。"
                            : !billing ? "請求書を別途発行するか、既存書類を使用するか選択してください。"
                                : paid !== Number(billing.amount_minor) ? "銀行等で実入金を確認し、入金のみ記録または完了確認へ進んでください。"
                                    : "実施・精算・請求・全額入金を再確認して案件完了へ進めます。";
    nextRoot.append(element("p", "pa-commercial__next", next));
    appendLine(nextRoot, "業務", state.fulfillment_state);
    appendLine(nextRoot, "精算", state.settlement_state);
    appendLine(nextRoot, "同期", `V5取得 ${dateTime(new Date().toISOString())}`);
    if (pendingJob) {
        const kind = { estimate: "見積", confirmation: "正式受注確認", invoice: "請求書", confirmation_reminder: "再案内" }[pendingJob.job_kind] || pendingJob.job_kind;
        const alert = element("p", pendingJob.state === "unknown" ? "pa-commercial__error" : "pa-commercial__warning", `${kind}：${pendingJob.state}`);
        nextRoot.append(alert);
        if (["queued", "failed"].includes(pendingJob.state)) nextRoot.append(button("固定済み内容を送信", async () => {
            if (!window.confirm("表示中の固定済み宛先・本文・添付を送信しますか？")) return;
            await api(context, "dispatch_outbox", { job_id: pendingJob.id });
            await context.refreshCommercial();
        }, "button button--small"));
    }
    nextRoot.append(button("実施・精算／入金・完了へ", () => context.focusBilling(), "button button--secondary button--small"));

    const filesRoot = byId("pa-related-files");
    filesRoot.replaceChildren();
    byId("pa-related-files-count").textContent = `${data.documents.length}件／横に続きます`;
    for (const document of data.documents) renderDocument(context, document, filesRoot, epoch);
    if (!data.documents.length) filesRoot.append(element("p", "pa-commercial__label", "関連資料はまだありません。"));
    byId("pa-commercial-workspace").classList.remove("hidden");
};

export function renderCommercialWorkspace(context) {
    if (!context.case) {
        activeCaseId = null;
        activeCommercialDraftContext = null;
        refreshEpoch += 1;
        byId("pa-commercial-workspace")?.classList.add("hidden");
        return;
    }
    activeCaseId = context.case.id;
    const refresh = async () => {
        const epoch = ++refreshEpoch;
        try {
            const data = await api(context, "snapshot");
            await render(context, data, epoch);
        } catch (error) {
            if (epoch !== refreshEpoch) return;
            const root = byId("pa-next-action-summary");
            root.replaceChildren(element("p", "pa-commercial__error", `V5状態を取得できません：${error.message}`));
            byId("pa-commercial-workspace").classList.remove("hidden");
        }
    };
    context.refreshCommercial = refresh;
    byId("pa-commercial-refresh").onclick = refresh;
    byId("pa-v5-reply").onclick = () => context.openComposer("normal");
    byId("pa-v5-estimate").onclick = () => context.openComposer("estimate_submission");
    byId("pa-v5-add-file").onclick = () => context.openComposer("normal", { focusAttachments: true });
    byId("pa-v5-note").onclick = context.focusNote;
    byId("pa-estimate-tab").onclick = () => {
        byId("pa-estimate-tab").setAttribute("aria-selected", "true");
        byId("pa-billing-tab").setAttribute("aria-selected", "false");
        byId("pa-estimate-summary").classList.remove("hidden");
        byId("pa-billing-summary").classList.add("hidden");
    };
    byId("pa-billing-tab").onclick = () => {
        byId("pa-estimate-tab").setAttribute("aria-selected", "false");
        byId("pa-billing-tab").setAttribute("aria-selected", "true");
        byId("pa-estimate-summary").classList.add("hidden");
        byId("pa-billing-summary").classList.remove("hidden");
    };
    byId("pa-related-left").onclick = () => byId("pa-related-files").scrollBy({ left: -340, behavior: "smooth" });
    byId("pa-related-right").onclick = () => byId("pa-related-files").scrollBy({ left: 340, behavior: "smooth" });
    byId("pa-related-all").onclick = () => context.openFileSearch();
    refresh();
}

export const getCommercialDraftContext = () => activeCommercialDraftContext;
