import { createMaterialPreview } from "./pa-material-preview.js";
import { confirmationDisplayState } from "./pa-confirmation-display.mjs";

let activeCaseId = null;
let refreshEpoch = 0;
let activeCommercialDraftContext = null;
let activeEstimateEntry = null;
let activeEstimateActionStatus = null;
let estimateEntryOpening = false;
let activeWorkspaceContext = null;
let confirmationPreviewOpening = false;

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
const estimateDeliveryFor = (outbox, estimateId) => (outbox || [])
    .filter((item) => item.job_kind === "estimate" && item.aggregate_id === estimateId)
    .sort((left, right) => Date.parse(right.finished_at || right.created_at || 0) - Date.parse(left.finished_at || left.created_at || 0))[0];
const appendEstimateDates = (root, estimate, delivery) => {
    const sentAt = estimate.source_sent_at
        || (delivery?.state === "sent" ? delivery.finished_at : null);
    if (sentAt) appendLine(root, "送信", dateTime(sentAt));
    if (estimate.source_kind === "sent_recovery") appendLine(root, "V5登録", dateTime(estimate.issued_at));
    else if (!sentAt) appendLine(root, "V5発行", dateTime(estimate.issued_at));
};
const STATE_LABELS = Object.freeze({
    fulfillment: { not_confirmed: "実施確認前", confirmed: "実施確認済み", postponed: "延期", cancelled: "中止" },
    settlement: { unsettled: "精算確認前", confirmed: "精算確認済み", difference_review: "差額確認中" },
    estimate_change: { ready: "見積確定", reconfirming: "条件再確認中", post_contract_change: "受注後変更" },
    invoice: { not_required: "別途発行なし", registered: "発行準備済み", queued: "送信待ち", sent: "送信済み", failed: "送信失敗", unknown: "送信結果要確認" },
    outbox: { queued: "送信待ち", processing: "送信処理中", sent: "送信済み", failed: "送信失敗", unknown: "送信結果要確認", cancelled: "送信取消" },
    delivery: { queued: "送信待ち", processing: "送信処理中", failed_before_provider: "Gmail送信前に失敗", failed_after_provider_response: "Gmailが送信を受理せず失敗", unknown_after_provider_start: "Gmail呼出後の結果要照合", sent: "送信済み", cancelled: "送信取消" },
    invoice: { not_required: "別途発行なし", registered: "請求書登録済み", queued: "送信待ち", sent: "送信済み", failed: "送信失敗", unknown: "送信結果要確認" }
});
const stateLabel = (group, value) => {
    const label = STATE_LABELS[group]?.[value];
    if (label) return label;
    console.warn("PA commercial unknown state", { group, value: String(value || "") });
    return "状態未定義";
};

const formDialog = (title, fields, confirmLabel = "確認して実行") => new Promise((resolve) => {
    const dialog = element("dialog", "pa-commercial-dialog");
    const form = document.createElement("form");
    form.method = "dialog";
    form.append(element("h3", "", title));
    const controls = {};
    fields.forEach((field) => {
        const wrap = element("label", "field");
        wrap.append(element("span", "", field.label));
        const control = document.createElement(field.type === "select" ? "select" : field.type === "textarea" ? "textarea" : "input");
        if (field.type !== "select" && field.type !== "textarea") control.type = field.type || "text";
        control.name = field.name;
        if (field.required) control.required = true;
        if (field.value != null) control.value = field.value;
        if (field.min != null) control.min = field.min;
        if (field.type === "select") field.options.forEach(([value, label]) => control.append(new Option(label, value)));
        controls[field.name] = control;
        wrap.append(control);
        form.append(wrap);
    });
    const actions = element("div", "actions actions--compact");
    const cancel = button("キャンセル", () => dialog.close("cancel"));
    const submit = button(confirmLabel, () => {}, "button button--small");
    submit.type = "submit";
    actions.append(cancel, submit);
    form.append(actions);
    dialog.append(form);
    document.body.append(dialog);
    dialog.addEventListener("close", () => {
        const value = dialog.returnValue === "cancel" ? null : Object.fromEntries(Object.entries(controls).map(([name, control]) => [name, control.type === "file" ? control.files?.[0] : control.value]));
        dialog.remove(); resolve(value);
    }, { once: true });
    dialog.showModal();
});

const filePayload = async (file) => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    const sha = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))).map((value) => value.toString(16).padStart(2, "0")).join("");
    return { content_base64: btoa(binary), sha256: sha };
};

let recoveryOpening = false;
const openRecovery = async (context, state, trigger) => {
    if (recoveryOpening) return;
    recoveryOpening = true;
    const triggerLabel = trigger?.textContent || "送信済みメールから登録";
    if (trigger) { trigger.disabled = true; trigger.textContent = "検索中…"; }

    const dialog = element("dialog", "pa-commercial-dialog pa-recovery-dialog");
    const form = document.createElement("form");
    form.append(element("h3", "", "送信済みメールから見積を登録"));
    const status = element("div", "pa-recovery-dialog__status", "検索中…\n送信済みメールと添付を確認しています");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    form.append(status);
    const content = element("div", "pa-recovery-dialog__content");
    form.append(content);
    const actions = element("div", "actions actions--compact");
    const cancel = button("キャンセル", () => dialog.close("cancel"));
    const submit = element("button", "button button--small", "再送せず登録");
    submit.type = "submit";
    submit.disabled = true;
    actions.append(cancel, submit);
    form.append(actions);
    dialog.append(form);
    document.body.append(dialog);
    dialog.addEventListener("close", () => {
        recoveryOpening = false;
        if (trigger?.isConnected) { trigger.disabled = false; trigger.textContent = triggerLabel; }
        dialog.remove();
    }, { once: true });
    dialog.showModal();

    try {
        const candidates = await api(context, "recovery_candidates");
        if (!candidates.length) {
            status.textContent = "この案件に復旧可能な送信済みPDFはありません。";
            cancel.textContent = "閉じる";
            return;
        }

        status.classList.add("hidden");
        const candidateLabel = element("label", "field");
        candidateLabel.append(element("span", "", "送信済みPDF"));
        const candidateSelect = document.createElement("select");
        candidateSelect.name = "candidate";
        candidates.forEach((item, index) => candidateSelect.append(new Option(
            `${item.source_sent_at || "送信日時不明"} / ${item.filename}${item.existing ? "（登録済み）" : ""}`,
            String(index)
        )));
        candidateLabel.append(candidateSelect);

        const summary = element("section", "pa-recovery-dialog__summary");
        summary.setAttribute("aria-label", "登録内容の確認");
        const filename = element("strong", "pa-recovery-dialog__filename", "");
        const amount = element("strong", "pa-recovery-dialog__amount", "");
        const sourceBadge = element("span", "pa-recovery-dialog__badge", "PDFから自動取得");
        const amountRow = element("div", "pa-recovery-dialog__amount-row");
        amountRow.append(amount, sourceBadge);
        const fileRow = element("p", "");
        fileRow.append(element("span", "pa-commercial__label", "ファイル："), filename);
        const moneyRow = element("p", "");
        moneyRow.append(element("span", "pa-commercial__label", "見積金額："), amountRow);
        summary.append(fileRow, moneyRow);

        const manualLabel = element("label", "field hidden");
        manualLabel.append(element("span", "", "見積金額（円）"));
        const manualAmount = document.createElement("input");
        manualAmount.type = "number";
        manualAmount.name = "amount";
        manualAmount.min = "1";
        manualAmount.max = "9999999999";
        manualAmount.required = true;
        manualAmount.disabled = true;
        manualLabel.append(manualAmount, element("small", "pa-recovery-dialog__manual-note", "PDFから金額を特定できませんでした。原本を確認して入力してください。"));

        const mode = document.createElement("fieldset");
        mode.className = "pa-recovery-dialog__mode";
        mode.append(element("legend", "", "登録方法"));
        [["current", "現在の見積として登録"], ["historical", "過去の見積として取り込む"]].forEach(([value, label], index) => {
            const option = element("label", "pa-recovery-dialog__radio");
            const radio = document.createElement("input");
            radio.type = "radio";
            radio.name = "mode";
            radio.value = value;
            radio.checked = index === 0;
            option.append(radio, document.createTextNode(label));
            mode.append(option);
        });
        const resend = element("p", "pa-recovery-dialog__resend", "");
        resend.append(element("span", "pa-commercial__label", "メール再送："), document.createTextNode("しない"));
        content.append(candidateLabel, summary, manualLabel, mode, resend);

        let previewEpoch = 0;
        let preview = null;
        const loadPreview = async () => {
            const epoch = ++previewEpoch;
            const selected = candidates[Number(candidateSelect.value)];
            preview = null;
            submit.disabled = true;
            manualLabel.classList.add("hidden");
            manualAmount.disabled = true;
            sourceBadge.classList.add("hidden");
            filename.textContent = selected.filename || "ファイル名を確認中";
            amount.textContent = "PDFから金額を確認しています…";
            amountRow.setAttribute("aria-busy", "true");
            try {
                const loaded = await api(context, "recovery_preview", {
                    gmail_message_id: selected.gmail_message_id,
                    gmail_attachment_id: selected.gmail_attachment_id
                });
                if (epoch !== previewEpoch || !dialog.open) return;
                preview = loaded;
                selected.filename = loaded.original_filename;
                filename.textContent = loaded.original_filename;
                candidateSelect.options[Number(candidateSelect.value)].textContent = `${selected.source_sent_at || "送信日時不明"} / ${loaded.original_filename}${selected.existing ? "（登録済み）" : ""}`;
                if (loaded.amount_extraction?.status === "HIGH_CONFIDENCE") {
                    amount.textContent = money(loaded.amount_extraction.amount_minor, "JPY");
                    sourceBadge.classList.remove("hidden");
                } else {
                    amount.textContent = "自動取得できませんでした";
                    manualLabel.classList.remove("hidden");
                    manualAmount.disabled = false;
                    manualAmount.focus();
                }
                submit.disabled = Boolean(selected.existing) || (loaded.amount_extraction?.status !== "HIGH_CONFIDENCE" && !manualAmount.value);
                if (selected.existing) amount.textContent += " / 登録済み";
            } catch {
                if (epoch !== previewEpoch || !dialog.open) return;
                amount.textContent = "PDFの確認に失敗しました";
                submit.disabled = true;
            } finally {
                if (epoch === previewEpoch) amountRow.removeAttribute("aria-busy");
            }
        };
        candidateSelect.addEventListener("change", loadPreview);
        manualAmount.addEventListener("input", () => { if (!preview || preview.amount_extraction?.status !== "HIGH_CONFIDENCE") submit.disabled = !manualAmount.value; });
        form.addEventListener("submit", async (event) => {
            event.preventDefault();
            const selected = candidates[Number(candidateSelect.value)];
            if (selected.existing || !preview) return;
            const extracted = preview.amount_extraction?.status === "HIGH_CONFIDENCE";
            const amountMinor = extracted ? Number(preview.amount_extraction.amount_minor) : Number(manualAmount.value);
            if (!Number.isSafeInteger(amountMinor) || amountMinor < 1) { manualAmount.focus(); return; }
            submit.disabled = true;
            cancel.disabled = true;
            submit.textContent = "登録しています…";
            try {
                await api(context, "recover_estimate", {
                    expected_revision: state.revision, expected_current: state.current_estimate_revision_id,
                    operation_id: crypto.randomUUID(), document_id: crypto.randomUUID(),
                    mode: new FormData(form).get("mode"), amount_minor: amountMinor,
                    currency: "JPY", tax_basis: "tax_included", conditions: {},
                    gmail_message_id: selected.gmail_message_id, gmail_attachment_id: selected.gmail_attachment_id
                });
                dialog.close("registered");
                await context.refreshCommercial();
            } catch (error) {
                status.textContent = error.message === "amount_extraction_mismatch"
                    ? "PDFから再確認した金額と一致しません。もう一度選択してください。"
                    : "登録できませんでした。状態を更新して再確認してください。";
                status.classList.remove("hidden");
                submit.disabled = false;
                cancel.disabled = false;
                submit.textContent = "再送せず登録";
            }
        });
        await loadPreview();
    } catch {
        status.textContent = "送信済みメールと添付を確認できませんでした。";
        cancel.textContent = "閉じる";
    }
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
const contractApi = async (context, action, input = {}, binary = false) => {
    const token = await context.getAccessToken();
    if (!token || context.getCurrentCase()?.id !== activeCaseId) throw Error("case_changed");
    const response = await fetch("/api/pa-contract", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ action, case_id: activeCaseId, ...input }), cache: "no-store" });
    if (binary && response.ok) return response.blob();
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw Error(payload.code || "contract_request_failed");
    return payload.result;
};
const saveBlob = (blob, filename) => new Promise((resolve, reject) => { const reader = new FileReader(); reader.onerror = () => reject(reader.error); reader.onload = () => { const link = document.createElement("a"); link.href = String(reader.result); link.download = filename; link.click(); resolve(); }; reader.readAsDataURL(blob); });

const openConfirmationPreview = async (context, issuedConfirmation = null) => {
    if (confirmationPreviewOpening || !context?.getCurrentCase()?.id) return false;
    confirmationPreviewOpening = true;
    const issuedMode = Boolean(issuedConfirmation?.offer_id && issuedConfirmation?.outbox_id);
    const caseId = context.getCurrentCase().id;
    const dialog = element("dialog", "pa-confirmation-preview-dialog");
    dialog.setAttribute("aria-labelledby", "pa-confirmation-preview-title");
    const header = element("header", "pa-confirmation-preview__header"), heading = element("div", ""), headerActions = element("div", "actions actions--compact");
    const title = element("h2", "", "顧客へ実際に届く内容"); title.id = "pa-confirmation-preview-title";
    heading.append(
        element("p", "pa-confirmation-preview__eyebrow", "送信前の最終確認"),
        title,
        element("p", "", issuedMode
            ? `正式受注確認 #${issuedConfirmation.version}は発行済みです。案内メールはまだ送信されていません。`
            : "まだ正式受注確認は発行・送信されていません。")
    );
    const refreshButton = button("内容を再取得", () => load(), "button button--secondary button--small"), closeButton = button("閉じる", () => dialog.close(), "button button--secondary button--small");
    headerActions.append(refreshButton, closeButton); header.append(heading, headerActions);
    const body = element("div", "pa-confirmation-preview__body"), status = element("p", "pa-confirmation-preview__loading", "Production authorityを読み込んでいます…");
    status.setAttribute("role", "status"); body.append(status); dialog.append(header, body); document.body.append(dialog); dialog.showModal();
    const objectUrls = new Set(); let preview = null, operationId = null, loadEpoch = 0, busy = false;
    const revokeUrls = () => { for (const url of objectUrls) URL.revokeObjectURL(url); objectUrls.clear(); };
    const blobUrl = (blob) => { const url = URL.createObjectURL(blob); objectUrls.add(url); return url; };
    const pair = (root, label, value) => { root.append(element("dt", "", label), element("dd", "", value || "—")); };
    const section = (titleText) => { const node = element("section", "pa-confirmation-preview__section"); node.append(element("h3", "", titleText)); return node; };
    const honorific = (value) => /様\s*$/u.test(String(value || "")) ? String(value) : `${String(value || "")} 様`;
    const japaneseDate = (value) => {
        const date = new Date(`${value}T00:00:00Z`), parts = Object.fromEntries(new Intl.DateTimeFormat("ja-JP", { timeZone: "UTC", year: "numeric", month: "numeric", day: "numeric", weekday: "short" }).formatToParts(date).map((part) => [part.type, part.value]));
        return `${parts.year}年${parts.month}月${parts.day}日（${parts.weekday}）`;
    };
    const finalDialog = (model) => new Promise((resolve, reject) => {
        const final = element("dialog", "pa-confirmation-final-dialog"), wrap = element("div", "pa-confirmation-final-dialog__body");
        wrap.append(
            element("h2", "", issuedMode ? "正式受注確認メール送信の最終確認" : "正式受注確認発行の最終確認"),
            element("p", "", issuedMode
                ? `${honorific(model.recipient.customer_name)}へ正式受注確認 #${model.confirmation_version}の案内メールを送信します。`
                : "正式受注確認を発行し、専用URLと送信待ちメールを安全に準備します。この操作では案内メールを送信しません。")
        );
        const facts = element("dl", "pa-confirmation-preview__facts"); pair(facts, "案件", model.customer_snapshot.case.event_name); pair(facts, "見積", `第${model.estimate.revision_number}版`); pair(facts, "金額", money(model.estimate.amount_minor, model.estimate.currency)); pair(facts, "送信先", model.recipient.to); wrap.append(facts);
        const actions = element("div", "actions pa-confirmation-final-dialog__actions"), back = button("戻って確認する", () => final.close("back")), confirm = button(issuedMode ? "正式受注確認を送信する" : "正式受注確認を発行する（送信しない）", () => final.close("confirm"), "button button--small");
        actions.append(back, confirm); wrap.append(actions); final.append(wrap); document.body.append(final);
        let settled = false;
        const fail = (error) => { if (settled) return; settled = true; final.remove(); reject(error); };
        final.addEventListener("cancel", (event) => { event.preventDefault(); final.close("back"); });
        final.addEventListener("close", () => { if (settled) return; settled = true; const accepted = final.returnValue === "confirm"; final.remove(); resolve(accepted); }, { once: true });
        try {
            final.showModal();
            requestAnimationFrame(() => {
                try {
                    const bounds = final.getBoundingClientRect(), style = getComputedStyle(final);
                    if (!final.open || !final.matches(":modal") || style.display === "none" || style.visibility === "hidden" || bounds.width < 1 || bounds.height < 1) throw Error("final_dialog_not_visible");
                    back.focus();
                } catch (error) { fail(error); }
            });
        } catch (error) { fail(error); }
    });
    const renderPreview = async (model, epoch) => {
        const [estimateBlob, receiptBlob] = await Promise.all([
            api(context, "document", { document_id: model.estimate.document_id }, true),
            api(context, issuedMode ? "confirmation_send_receipt_preview" : "confirmation_receipt_preview", {
                preview_fingerprint: model.fingerprint,
                ...(issuedMode ? { offer_id: issuedConfirmation.offer_id } : {})
            }, true)
        ]);
        if (epoch !== loadEpoch || !dialog.open) return;
        const estimateUrl = blobUrl(estimateBlob), receiptUrl = blobUrl(receiptBlob); body.replaceChildren();
        const overview = section("送信先・案件・対象見積"), facts = element("dl", "pa-confirmation-preview__facts");
        pair(facts, "顧客", honorific(model.recipient.customer_name)); pair(facts, "組織", model.recipient.organization); pair(facts, "To", model.recipient.to); pair(facts, "Gmail thread", model.recipient.gmail_thread_id); pair(facts, "CC", model.recipient.cc.join(", ") || "なし"); pair(facts, "案件", model.customer_snapshot.case.event_name); pair(facts, "開催日時", `${japaneseDate(model.customer_snapshot.case.event_date)} ${model.customer_snapshot.case.event_time || ""}`.trim()); pair(facts, "会場", model.customer_snapshot.case.venue); pair(facts, "対象業務", model.service_summary); pair(facts, "対象見積", `第${model.estimate.revision_number}版`); pair(facts, "金額", `${money(model.estimate.amount_minor, model.estimate.currency)}（税込）`); pair(facts, "original filename", model.estimate.original_filename); pair(facts, "原本SHA-256", model.estimate.sha256); pair(facts, "支払期限", japaneseDate(model.customer_snapshot.terms.payment_due_date)); overview.append(facts);
        const estimateFrame = element("iframe", "pa-confirmation-preview__pdf"); estimateFrame.title = "Productionにbindされた正規見積PDF"; estimateFrame.src = `${estimateUrl}#toolbar=1&navpanes=0&view=FitH`; overview.append(element("h4", "", "正規見積PDFを確認"), estimateFrame);
        const terms = section("キャンセル条件・支払期限"), termsGrid = element("div", "pa-confirmation-preview__two-column"), cancellation = element("article", ""), payment = element("article", "");
        cancellation.append(element("h4", "", "キャンセル・変更条件"), element("pre", "", model.customer_snapshot.terms.cancellation_terms)); payment.append(element("h4", "", "支払期限"), element("strong", "pa-confirmation-preview__due", japaneseDate(model.customer_snapshot.terms.payment_due_date)), element("p", "", model.customer_snapshot.terms.payment_consult_terms)); termsGrid.append(cancellation, payment); terms.append(termsGrid);
        const customer = section("顧客が開く正式受注確認ページ"); customer.append(element("p", "pa-confirmation-preview__note", `Customer Web UI ${model.versions.customer}を同じrendererで表示しています。${issuedMode ? "専用URLは発行済みですが、この画面には表示しません。" : "secret URLは未生成です。"}`));
        const customerFrame = element("iframe", "pa-confirmation-preview__customer"); customerFrame.title = "顧客向け正式受注確認ページの送信前プレビュー"; customerFrame.src = "/pa-contract.html?mode=admin-pre-issue"; customer.append(customerFrame);
        const onMessage = (event) => { if (event.origin === location.origin && event.source === customerFrame.contentWindow && event.data?.type === "pa-contract-preview-ready") customerFrame.contentWindow.postMessage({ type: "pa-contract-preview-model", snapshot: model.customer_snapshot }, location.origin); };
        window.addEventListener("message", onMessage); dialog.addEventListener("close", () => window.removeEventListener("message", onMessage), { once: true });
        const email = section("発行案内メール"), emailFacts = element("dl", "pa-confirmation-preview__facts"); pair(emailFacts, "件名", model.email.subject); email.append(emailFacts);
        const emailColumns = element("div", "pa-confirmation-preview__two-column"), htmlWrap = element("article", ""), textWrap = element("article", ""), emailFrame = element("iframe", "pa-confirmation-preview__email");
        emailFrame.title = "発行案内メールHTML本文"; emailFrame.srcdoc = model.email.html; htmlWrap.append(element("h4", "", "HTML本文"), emailFrame); textWrap.append(element("h4", "", "plain text本文"), element("pre", "pa-confirmation-preview__mail-text", model.email.body)); emailColumns.append(htmlWrap, textWrap); email.append(emailColumns);
        const receipt = section("承認後に生成される正式受注確認書"); receipt.append(element("p", "pa-confirmation-preview__note", `${model.versions.receipt}／Page 1・2 + Page 3以降は現在の正規見積原本。確認者・成立日時はお客様承認時に自動記録されます。`));
        const receiptFrame = element("iframe", "pa-confirmation-preview__pdf pa-confirmation-preview__pdf--receipt"); receiptFrame.title = "V4.1正式受注確認書の送信前プレビュー"; receiptFrame.src = `${receiptUrl}#toolbar=1&navpanes=0&view=FitH`; receipt.append(receiptFrame);
        const gate = section("Owner最終確認"); gate.classList.add("pa-confirmation-preview__gate");
        const identity = element("p", "pa-confirmation-preview__fingerprint", `内容確認ID：${model.fingerprint_short}`), checkLabel = element("label", "pa-confirmation-preview__check"), checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkLabel.append(checkbox, element("span", "", "上記の内容を確認しました。"));
        const actionLabel = issuedMode ? "正式受注確認を送る" : "この内容で正式受注確認を発行する（送信しない）";
        const dialogError = element("p", "pa-confirmation-preview__error hidden"); dialogError.setAttribute("role", "alert");
        const finalButton = button(actionLabel, async () => {
            if (busy || !checkbox.checked || model !== preview) return;
            busy = true; checkbox.disabled = true; finalButton.disabled = true; finalButton.setAttribute("aria-busy", "true"); finalButton.textContent = "最終確認画面を開いています…"; dialogError.classList.add("hidden"); dialogError.textContent = "";
            let phase = "dialog", retryBlocked = false;
            try {
                if (!await finalDialog(model)) return;
                phase = issuedMode ? "dispatch" : "issue";
                finalButton.textContent = issuedMode ? "正式受注確認を送信しています…" : "正式受注確認を発行しています…";
                if (issuedMode) await api(context, "dispatch_outbox", { job_id: model.outbox_id });
                else {
                    operationId ||= crypto.randomUUID();
                    await api(context, "issue_confirmation", { preview_fingerprint: model.fingerprint, operation_id: operationId });
                }
                dialog.close(); await context.refreshCommercial();
            } catch (error) {
                if (phase === "dialog") { dialogError.textContent = "最終確認画面を開けませんでした。内容を再取得してもう一度お試しください。"; dialogError.classList.remove("hidden"); }
                else { retryBlocked = true; const stale = error.message === "stale_confirmation_preview"; status.textContent = stale ? "プレビュー後に内容が変更されています。もう一度内容をご確認ください。" : "発行または案内の結果を確認できません。状態を更新して履歴をご確認ください。"; status.className = stale ? "pa-confirmation-preview__stale" : "pa-confirmation-preview__error"; body.prepend(status); if (stale) { preview = null; checkbox.checked = false; } }
            } finally {
                busy = false; checkbox.disabled = false; finalButton.removeAttribute("aria-busy"); finalButton.disabled = retryBlocked || !checkbox.checked || model !== preview; finalButton.textContent = actionLabel; if (phase === "dialog" && dialog.open && finalButton.isConnected) finalButton.focus();
            }
        }, "button button--small");
        finalButton.disabled = true; checkbox.addEventListener("change", () => { finalButton.disabled = !checkbox.checked || !preview || busy; }); gate.append(identity, checkLabel, dialogError, finalButton);
        body.append(overview, terms, customer, email, receipt, gate);
    };
    async function load() {
        const epoch = ++loadEpoch; preview = null; operationId = null; revokeUrls(); body.replaceChildren(status); status.className = "pa-confirmation-preview__loading"; status.textContent = "Production authorityを読み込んでいます…"; refreshButton.disabled = true;
        try {
            const model = await api(context, issuedMode ? "confirmation_send_preview" : "confirmation_preview", issuedMode ? { offer_id: issuedConfirmation.offer_id } : {});
            if (epoch !== loadEpoch || !dialog.open || context.getCurrentCase()?.id !== caseId) return;
            preview = model; await renderPreview(model, epoch);
        }
        catch (error) { if (epoch !== loadEpoch || !dialog.open) return; status.className = "pa-confirmation-preview__error"; status.textContent = `送信前プレビューを作成できません：${error.message}`; }
        finally { if (epoch === loadEpoch) refreshButton.disabled = false; }
    }
    dialog.addEventListener("close", () => { loadEpoch += 1; revokeUrls(); confirmationPreviewOpening = false; dialog.remove(); }, { once: true }); await load(); return true;
};

export const openConfirmationPreviewForCurrentCase = () => openConfirmationPreview(activeWorkspaceContext);

let deliveryRecoveryOpening = false;
const openProductionE2eDeliveryRecovery = async (context, active, current, job, trigger) => {
    if (deliveryRecoveryOpening || !active || !current || !job) return false;
    deliveryRecoveryOpening = true;
    const idleLabel = trigger?.textContent || "同じ確認を送信する";
    if (trigger) { trigger.disabled = true; trigger.setAttribute("aria-busy", "true"); }
    const dialog = element("dialog", "pa-commercial-dialog");
    dialog.setAttribute("aria-labelledby", "pa-delivery-recovery-title");
    const wrap = element("div", "pa-confirmation-final-dialog__body");
    const title = element("h2", "", "正式受注確認の配送復旧"); title.id = "pa-delivery-recovery-title";
    const status = element("p", "pa-confirmation-preview__loading", "Gmail Sentを固定Message-IDで照合しています…");
    status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
    const facts = element("dl", "pa-confirmation-preview__facts");
    const actions = element("div", "actions pa-confirmation-final-dialog__actions");
    const back = button("戻って確認する", () => dialog.close("back"));
    const confirm = button("照合中…", () => {}, "button button--small"); confirm.disabled = true;
    actions.append(back, confirm); wrap.append(title, status, facts, actions); dialog.append(wrap); document.body.append(dialog);
    const addFact = (label, value) => facts.append(element("dt", "", label), element("dd", "", value));
    let preview = null; let busy = false;
    const cleanup = () => {
        deliveryRecoveryOpening = false;
        if (trigger?.isConnected) { trigger.disabled = false; trigger.removeAttribute("aria-busy"); trigger.textContent = idleLabel; }
        dialog.remove();
    };
    dialog.addEventListener("close", cleanup, { once: true });
    confirm.addEventListener("click", async () => {
        if (busy || !preview || (!preview.can_send_same_confirmation && preview.provider_match_count !== 1)) return;
        busy = true; confirm.disabled = true; back.disabled = true; confirm.setAttribute("aria-busy", "true");
        confirm.textContent = preview.provider_match_count === 1 ? "送信済み状態を照合中…" : "同じ確認を送信中…";
        try {
            const result = await api(context, "recover_production_e2e_delivery", { job_id: job.id });
            status.className = "pa-commercial__status pa-commercial__status--ok";
            status.textContent = result.send_performed ? "同じ正式受注確認 #1を送信しました。新しい確認やURLは作成していません。" : "Gmail Sentの既存メールと照合しました。再送はしていません。";
            confirm.textContent = "完了"; dialog.close("done"); await context.refreshCommercial();
        } catch (error) {
            status.className = "pa-confirmation-preview__error";
            status.textContent = `配送復旧を完了できません：${error.message}`;
            busy = false; back.disabled = false; confirm.removeAttribute("aria-busy"); confirm.disabled = false;
            confirm.textContent = preview.provider_match_count === 1 ? "送信済み状態を照合する" : "同じ確認を送信する";
        }
    });
    dialog.showModal();
    try {
        preview = await api(context, "production_e2e_recovery_preview", { job_id: job.id });
        status.className = preview.provider_match_count === 1 ? "pa-commercial__status pa-commercial__status--ok" : preview.can_send_same_confirmation ? "pa-commercial__warning" : "pa-confirmation-preview__error";
        status.textContent = preview.provider_match_count === 1 ? "Gmail Sentに同一配送が1件あります。再送せず状態だけ照合します。" : preview.can_send_same_confirmation ? "Gmail API呼出前の失敗で、Sent照合は0件です。同じ確認だけを安全に送信できます。" : "Gmail呼出後の結果が未確定です。自動再送はできません。";
        addFact("確認", `#${preview.confirmation_version}`); addFact("宛先", preview.recipient); addFact("案件", preview.event_name);
        addFact("見積", `第${preview.estimate_revision_number}版 / ${money(preview.amount_minor, preview.currency)}`);
        addFact("配送状態", stateLabel("delivery", preview.delivery_state)); addFact("Gmail Sent照合", `${preview.provider_match_count}件`);
        addFact("不変条件", "新しい正式受注確認やURLは作成されません。");
        confirm.textContent = preview.provider_match_count === 1 ? "送信済み状態を照合する" : "同じ確認を送信する";
        confirm.disabled = !preview.can_send_same_confirmation && preview.provider_match_count !== 1;
    } catch (error) {
        status.className = "pa-confirmation-preview__error"; status.textContent = `配送状態を確認できません：${error.message}`;
    }
    return true;
};

const estimateEntryFor = ({ current, accepted, active, change, billing }) => accepted
    ? { kind: "change_order", label: "変更見積を作成", available: (!change || change.state === "agreed") && !billing }
    : current
        ? { kind: "revision_estimate", label: "改訂見積を準備", available: !active, blockedReason: active ? "active_confirmation" : null }
        : { kind: "new_estimate", label: "見積を作成", available: true };

const openChangeProposal = async (context, state, accepted) => {
    const values = await formDialog("受注後の変更提案", [
        { name: "amount", label: "追加変更額（円）", type: "number", min: 1, required: true },
        { name: "conditions", label: "変更条件", type: "textarea", required: true },
        { name: "file", label: "変更提案PDF", type: "file", required: true }
    ], "提案を固定して送信");
    if (!values?.file) return true;
    const bytes = await filePayload(values.file);
    const result = await api(context, "create_change_proposal", {
        expected_revision: state.revision, operation_id: crypto.randomUUID(), contract_id: accepted.id,
        estimate_revision_id: crypto.randomUUID(), document_id: crypto.randomUUID(), filename: values.file.name,
        ...bytes, amount_minor: Number(values.amount), currency: "JPY", tax_basis: "tax_included",
        conditions: { source: "owner_change_proposal", summary: values.conditions }, body: "受注後の変更提案を添付します。内容をご確認ください。", cc_addresses: []
    });
    if (result.outbox_id) await api(context, "dispatch_outbox", { job_id: result.outbox_id });
    await context.refreshCommercial();
    return true;
};

const setEstimateEntryBusy = (busy) => {
    document.querySelectorAll("[data-pa-estimate-entry]").forEach((node) => {
        if (!node.dataset.paEstimateIdleLabel) node.dataset.paEstimateIdleLabel = node.textContent;
        node.disabled = busy;
        node.toggleAttribute("aria-busy", busy);
        node.textContent = busy ? "準備しています…" : node.dataset.paEstimateIdleLabel;
    });
};

const launchEstimateEntry = async (context, entry) => {
    if (estimateEntryOpening) return false;
    estimateEntryOpening = true;
    const caseId = activeCaseId;
    const status = activeEstimateActionStatus?.isConnected ? activeEstimateActionStatus : null;
    setEstimateEntryBusy(true);
    if (status) {
        status.className = "pa-commercial__action-status pa-commercial__label";
        status.textContent = "準備しています…";
    }
    try {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        if (caseId !== activeCaseId || context.getCurrentCase()?.id !== caseId) throw Error("case_changed");
        if (!entry.available) throw Error(entry.blockedReason || "change_order_unavailable");
        const result = entry.kind === "change_order"
            ? openChangeProposal(context, entry.state, entry.accepted)
            : context.openComposer("estimate_submission", { estimateIntent: entry.kind, source: "v5" });
        if (result === false) throw Error("composer_unavailable");
        if (status) status.textContent = entry.kind === "change_order" ? "変更見積の入力画面を開きました。" : "見積作成画面を開きました。";
        await result;
        return true;
    } catch (error) {
        if (caseId === activeCaseId && status) {
            status.className = "pa-commercial__action-status pa-commercial__error";
            status.textContent = error.message === "active_confirmation"
                ? "旧確認が受付中です。先に「旧確認を無効にして改訂開始」を実行してください。画面を開いただけでは失効しません。"
                : error.message === "change_order_unavailable"
                    ? "進行中の変更または請求があるため、新しい変更見積は開始できません。"
                    : "見積作成画面を開けませんでした。もう一度お試しください。";
        }
        return false;
    } finally {
        window.setTimeout(() => {
            if (caseId === activeCaseId) setEstimateEntryBusy(false);
            estimateEntryOpening = false;
        }, 350);
    }
};

const materialBlob = async (context, item) => {
    const capability = item.open_capability || { kind: "commercial_document", document_id: item.id };
    if (capability.kind === "commercial_document") return api(context, "document", { document_id: capability.document_id }, true);
    const token = await context.getAccessToken();
    if (!token || context.getCurrentCase()?.id !== activeCaseId || item.case_id !== activeCaseId) throw Error("case_changed");
    const portal = capability.kind === "portal_asset";
    const response = await fetch(portal ? "/api/pa-portal" : "/api/pa-gmail", {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, cache: "no-store",
        body: JSON.stringify(portal
            ? { action: "download", inquiry_id: activeCaseId, asset_id: capability.asset_id, asset_kind: capability.asset_kind }
            : { action: "attachment_download", inquiry_id: activeCaseId, gmail_message_id: capability.gmail_message_id, gmail_attachment_id: capability.gmail_attachment_id })
    });
    if (!response.ok) throw Error("material_unavailable");
    return response.blob();
};
const renderDocument = (context, item, root, currentEpoch) => {
    const card = element("button", "pa-commercial-file");
    card.type = "button";
    const filename = item.original_filename || item.display_title || "関連資料";
    card.title = `${filename}を開く`;
    const preview = element("span", "pa-commercial-file__preview");
    preview.append(element("span", "pa-commercial-file__fallback", item.mime_type === "application/pdf" ? "PDFを準備中" : "資料を準備中"));
    const meta = element("span", "pa-commercial-file__meta");
    const category = { estimate: "見積", invoice: "請求", timetable: "タイムテーブル", layout: "配置図", photo: "写真", performer: "出演資料", supporting: "参考資料", other: "関連資料" }[item.category || item.document_kind] || "関連資料";
    const source = { commercial: "案件原本", portal: "PAポータル", gmail: "顧客コミュニケーション" }[item.source_type] || "案件原本";
    const state = item.is_current ? "現在" : item.portal_publication_state === "history" ? "旧版" : item.direction === "inbound" ? "受信" : item.direction === "outbound" ? "送信" : "保管";
    meta.append(element("strong", "", item.display_title || filename), element("span", "", `${category}・${source}・${state}`));
    card.append(preview, meta);
    root.append(card);
    createMaterialPreview({
        item, filename, previewRoot: preview, card, strip: root,
        getBlob: () => materialBlob(context, item),
        isCurrent: () => currentEpoch === refreshEpoch && activeCaseId === (item.case_id || item.inquiry_id) && card.isConnected
    });
};

const render = async (context, data, epoch) => {
    if (epoch !== refreshEpoch || context.getCurrentCase()?.id !== activeCaseId) return;
    const state = data.state;
    const estimates = data.estimates || [];
    const current = estimates.find((item) => item.id === state.current_estimate_revision_id);
    const billing = (data.billings || []).find((item) => item.state === "open") || data.billings?.[0];
    const accepted = (data.offers || []).find((item) => item.state === "accepted");
    const active = (data.offers || []).find((item) => item.state === "active");
    const change = data.change_orders?.[0];
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
        const estimateDelivery = estimateDeliveryFor(data.outbox, current.id);
        appendEstimateDates(estimateRoot, current, estimateDelivery);
        appendLine(estimateRoot, "送信状態", estimateDelivery ? stateLabel("outbox", estimateDelivery.state) : current.source_kind === "sent_recovery" ? "送信済みメールから復旧" : "送信履歴なし");
        const historical = estimates.filter((item) => item.id !== current.id).sort((left, right) => right.revision_number - left.revision_number);
        if (historical.length) {
            const history = element("details", "pa-estimate-history");
            history.append(element("summary", "", `過去の見積 ${historical.length}件`));
            historical.forEach((item) => {
                const row = element("div", "pa-estimate-history__item");
                row.append(element("strong", "", `第${item.revision_number}版・${money(item.amount_minor, item.currency)}`));
                appendEstimateDates(row, item, estimateDeliveryFor(data.outbox, item.id));
                history.append(row);
            });
            estimateRoot.append(history);
        }
    }
    const entry = { ...estimateEntryFor({ current, accepted, active, change, billing }), state, accepted };
    const openEntry = () => launchEstimateEntry(context, entry);
    activeEstimateEntry = Object.freeze({ caseId: activeCaseId, open: openEntry, kind: entry.kind });
    const topEstimateButton = byId("pa-v5-estimate");
    topEstimateButton.disabled = false;
    topEstimateButton.dataset.paEstimateEntry = entry.kind;
    topEstimateButton.dataset.paEstimateIdleLabel = "見積";
    const estimateActions = element("div", "pa-commercial__compact-actions");
    const estimateEntryButton = button(entry.label, openEntry, "button button--small");
    estimateEntryButton.dataset.paEstimateEntry = entry.kind;
    estimateEntryButton.dataset.paEstimateIdleLabel = entry.label;
    estimateActions.append(estimateEntryButton);
    if (active && !accepted) estimateActions.append(button("旧確認を無効にして改訂開始", async () => {
        const reason = window.prompt("改訂理由を入力してください。旧確認URLは復活できません。", "条件変更のため");
        if (!reason || !window.confirm("対象の未承認確認を無効にして改訂を開始しますか？")) return;
        await api(context, "begin_revision", { expected_revision: state.revision, operation_id: crypto.randomUUID(), reason });
        await context.refreshCommercial();
    }));
    estimateActions.append(button("送信済みメールから登録", (event) => openRecovery(context, state, event.currentTarget)));
    estimateRoot.append(estimateActions);
    const estimateActionStatus = element("p", "pa-commercial__action-status pa-commercial__label", "");
    estimateActionStatus.setAttribute("role", "status");
    estimateActionStatus.setAttribute("aria-live", "polite");
    estimateRoot.append(estimateActionStatus);
    activeEstimateActionStatus = estimateActionStatus;

    const billingRoot = byId("pa-billing-summary");
    billingRoot.replaceChildren();
    if (!billing) {
        billingRoot.append(element("span", "pa-commercial__status pa-commercial__status--wait", "請求未準備"));
        appendLine(billingRoot, "最終精算額", money(state.final_settlement_minor, state.settlement_currency));
        appendLine(billingRoot, "前払い確認済み", money(paid, current?.currency || "JPY"));
        appendLine(billingRoot, "請求書", "別途発行／既存書類を使用を選択");
    } else {
        billingRoot.append(element("span", "pa-commercial__status pa-commercial__status--ok", `請求 #${billing.billing_number}`));
        billingRoot.append(element("p", "pa-commercial__amount", money(billing.amount_minor, billing.currency)));
        appendLine(billingRoot, "書類", billing.invoice_policy === "separate_pdf" ? `請求書PDF・${stateLabel("invoice", billing.invoice_delivery_state)}` : "既存書類を使用／別途発行なし");
        appendLine(billingRoot, "支払期限", billing.due_date || "期日未確定");
        appendLine(billingRoot, "先方予定日", billing.customer_planned_payment_on || "連絡なし");
        appendLine(billingRoot, "確認済み入金", money(paid, billing.currency));
    }
    const billingActions = element("div", "pa-commercial__compact-actions");
    if (!billing && accepted && data.case_status !== "closed") {
        billingActions.append(button("前払いを記録", async () => {
            const values = await formDialog("前払いの手動確認", [
                { name: "date", label: "入金確認日", type: "date", required: true },
                { name: "amount", label: "確認した前払い額（円）", type: "number", min: 1, required: true },
                { name: "memo", label: "確認メモ", type: "textarea", required: true }
            ], "前払いとして記録");
            if (!values) return;
            await api(context, "record_prepayment", { operation_id: crypto.randomUUID(), payment_date: values.date, amount_minor: Number(values.amount), payment_method: "bank_transfer", memo: values.memo });
            await context.refreshCommercial();
        }));
        if (data.payments?.length) billingActions.append(button("前払いを訂正", async () => {
            const values = await formDialog("前払い記録の訂正", [
                { name: "payment", label: "対象記録", type: "select", options: data.payments.filter((item) => !item.billing_id).map((item) => [item.id, `${item.payment_date} / ${money(item.amount_minor, current?.currency || "JPY")}`]) },
                { name: "delta", label: "訂正差額（減額はマイナス）", type: "number", required: true },
                { name: "reason", label: "訂正理由", type: "textarea", required: true }
            ], "追記で訂正");
            if (!values) return;
            await api(context, "adjust_payment", { billing_id: null, payment_id: values.payment, operation_id: crypto.randomUUID(), delta_minor: Number(values.delta), reason: values.reason });
            await context.refreshCommercial();
        }));
    }
    if (accepted && state.fulfillment_state !== "confirmed") billingActions.append(button("実施・精算を確認", async () => {
        const values = await formDialog("実施・精算確認", [
            { name: "amount", label: "最終精算額（円）", type: "number", min: 0, required: true, value: current?.amount_minor || "" },
            { name: "evidence", label: "確認根拠", type: "textarea", required: true }
        ], "実施・精算を確定");
        if (!values) return;
        await api(context, "confirm_settlement", { expected_revision: state.revision, operation_id: crypto.randomUUID(), amount_minor: Number(values.amount), unresolved_changes: false, evidence: { source: "owner_review", note: values.evidence } });
        await context.refreshCommercial();
    }, "button button--small"));
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
    if (billing?.state === "open") {
        billingActions.append(button("入金を記録", async () => {
            const values = await formDialog("手動入金確認", [
                { name: "date", label: "入金確認日", type: "date", required: true },
                { name: "amount", label: "確認した金額（円）", type: "number", min: 1, required: true },
                { name: "memo", label: "確認メモ", type: "textarea" }
            ], "入金のみ記録");
            if (!values) return;
            await api(context, "record_payment", { billing_id: billing.id, operation_id: crypto.randomUUID(), payment_date: values.date, amount_minor: Number(values.amount), payment_method: "bank_transfer", memo: values.memo });
            await context.refreshCommercial();
        }));
        if (data.payments?.length) billingActions.append(button("誤登録を訂正", async () => {
            const values = await formDialog("入金記録の訂正", [
                { name: "payment", label: "対象記録", type: "select", options: data.payments.map((item) => [item.id, `${item.payment_date} / ${money(item.amount_minor, billing.currency)}`]) },
                { name: "delta", label: "訂正差額（減額はマイナス）", type: "number", required: true },
                { name: "reason", label: "訂正理由", type: "textarea", required: true }
            ], "追記で訂正");
            if (!values) return;
            await api(context, "adjust_payment", { billing_id: billing.id, payment_id: values.payment, operation_id: crypto.randomUUID(), delta_minor: Number(values.delta), reason: values.reason });
            await context.refreshCommercial();
        }));
        billingActions.append(button("案件完了を確認", async () => {
            const balance = Number(billing.amount_minor) - paid;
            const values = await formDialog("入金確認と案件完了", [
                { name: "date", label: "追加入金確認日", type: "date", required: balance > 0 },
                { name: "amount", label: "今回確認した金額（円）", type: "number", min: 0, required: true, value: Math.max(0, balance) },
                { name: "memo", label: "確認メモ", type: "textarea", required: true }
            ], "全条件を確認して完了");
            if (!values) return;
            await api(context, "close_case", { billing_id: billing.id, expected_revision: state.revision, operation_id: crypto.randomUUID(), payment_date: values.date || null, new_payment_minor: Number(values.amount), payment_method: Number(values.amount) ? "bank_transfer" : null, memo: values.memo });
            await context.refreshCommercial();
        }, "button button--small"));
    } else if (billing) {
        billingActions.append(button("入金記録を見る", () => context.focusBilling()));
        billingActions.append(button("案件を再開", async () => {
            const values = await formDialog("案件を再開", [{ name: "reason", label: "再開理由", type: "textarea", required: true }], "再開する");
            if (!values) return;
            await api(context, "reopen_case", { operation_id: crypto.randomUUID(), reason: values.reason });
            await context.refreshCommercial();
        }));
    } else billingActions.append(button("請求・精算の詳細へ", () => context.focusBilling()));
    billingRoot.append(billingActions);

    const contractRoot = byId("pa-contract-v5-summary");
    contractRoot.replaceChildren();
    const activeDelivery = active
        ? data.outbox.find((item) => item.aggregate_id === active.id && item.job_kind === "confirmation")
        : null;
    const confirmationStatus = confirmationDisplayState({ accepted, active, delivery: activeDelivery });
    contractRoot.append(element("span", `pa-commercial__status pa-commercial__status--${confirmationStatus.tone}`, `現在：${confirmationStatus.label}`));
    appendLine(contractRoot, "対象", accepted ? `見積 第${accepted.snapshot?.estimate_revision_number || "?"}版／正式受注確認 #${accepted.version}` : active ? `見積 第${active.snapshot?.estimate_revision_number || "?"}版／正式受注確認 #${active.version}` : current ? `見積 第${current.revision_number}版` : "見積なし");
    if (accepted) appendLine(contractRoot, "成立", dateTime(accepted.confirmed_at));
    if (!accepted && !active && current && data.confirmation_preflight) {
        const preflight = data.confirmation_preflight;
        appendLine(contractRoot, "案件", preflight.event_name || "未設定");
        appendLine(contractRoot, "顧客", [preflight.organization, preflight.contact_name].filter(Boolean).join(" ／ ") || "未設定");
        appendLine(contractRoot, "開催日時", `${preflight.event_date || "未設定"}${preflight.event_time ? ` ${preflight.event_time}` : ""}`);
        appendLine(contractRoot, "金額", money(current.amount_minor, current.currency));
        appendLine(contractRoot, "PDF", data.documents.find((item) => item.id === current.document_id)?.original_filename || "未取得");
        appendLine(contractRoot, "支払期限", preflight.payment_due_date || "未取得");
        appendLine(contractRoot, "宛先", preflight.recipient || "未取得");
        appendLine(contractRoot, "Gmail thread", preflight.gmail_thread_id || "未結線");
    }
    if (active) {
        appendLine(contractRoot, "期限", dateTime(active.expires_at));
        const actions = element("div", "pa-commercial__compact-actions");
        actions.append(button("案内内容を確認", () => context.openFileSearch()));
        if (activeDelivery?.state === "queued") {
            actions.append(button("正式受注確認を送る", () => openConfirmationPreview(context, {
                offer_id: active.id,
                outbox_id: activeDelivery.id,
                version: active.version
            }), "button button--small"));
        }
        if (data.production_e2e_test && activeDelivery) {
            if (activeDelivery.state !== "sent") {
                const error = element("p", "pa-commercial__error", "案内メールを送信できませんでした。");
                error.setAttribute("role", "alert"); contractRoot.append(error);
                appendLine(contractRoot, "配送状態", stateLabel("delivery", activeDelivery.delivery_state || activeDelivery.state));
                if (activeDelivery.safe_error_message) appendLine(contractRoot, "理由", activeDelivery.safe_error_message);
            }
            const recoveryLabel = activeDelivery.state === "sent" ? "同じ確認の配送を再照合" : "同じ確認を送信する";
            actions.append(button(recoveryLabel, (event) => openProductionE2eDeliveryRecovery(context, active, current, activeDelivery, event.currentTarget), "button button--small"));
        } else if (activeDelivery?.state === "sent") actions.append(button("同じ確認を再案内", async () => {
            const result = await api(context, "remind_confirmation", { offer_id: active.id, expected_revision: state.revision, operation_id: crypto.randomUUID(), body_template: "正式受注確認の再案内です。内容は前回発行時から変更していません。\n\n{{CONFIRMATION_URL}}", cc_addresses: [] });
            if (result.outbox_id) await api(context, "dispatch_outbox", { job_id: result.outbox_id });
            await context.refreshCommercial();
        }));
        actions.append(button("この確認だけを失効", async () => {
            const reason = window.prompt("失効理由を入力してください。新しい確認は発行しません。");
            if (!reason || !window.confirm("この未承認確認だけを失効しますか？")) return;
            await api(context, "revoke_confirmation", { offer_id: active.id, operation_id: crypto.randomUUID(), reason });
            await context.refreshCommercial();
        }));
        contractRoot.append(actions);
    }
    if (!active && !accepted && current) {
        contractRoot.append(button("正式受注確認を発行準備", () => openConfirmationPreview(context), "button button--small"));
    }
    if (accepted) {
        const actions = element("div", "pa-commercial__compact-actions");
        const receiptJob = data.outbox.find((item) => item.aggregate_id === accepted.id && item.job_kind === "accept_receipt");
        const acceptedEstimate = data.estimates.find((item) => item.id === accepted.estimate_revision_id);
        appendLine(contractRoot, "契約金額", money(accepted.snapshot?.amount_minor ?? accepted.snapshot?.estimate?.amount_minor, accepted.snapshot?.currency || accepted.snapshot?.estimate?.currency || "JPY"));
        appendLine(contractRoot, "確認メール", receiptJob ? stateLabel("outbox", receiptJob.state) : "対象外");
        actions.append(button("契約内容を見る", () => context.openFileSearch()));
        actions.append(button("正式受注確認書PDF", async () => saveBlob(await contractApi(context, "receipt", { contract_id: accepted.id }, true), `正式受注確認書_v${accepted.version}.pdf`)));
        if (acceptedEstimate) actions.append(button("見積PDF", async () => saveBlob(await api(context, "document", { document_id: acceptedEstimate.document_id }, true), data.documents.find((item) => item.id === acceptedEstimate.document_id)?.original_filename || "見積書.pdf")));
        actions.append(button("実施準備へ", () => context.focusBilling()));
        if (receiptJob?.state === "failed") actions.append(button("確認メールを再送", async () => { await api(context, "dispatch_outbox", { job_id: receiptJob.id }); await context.refreshCommercial(); }));
        if ((!change || change.state === "agreed") && !billing) actions.append(button("受注後の変更提案", () => openChangeProposal(context, state, accepted)));
        if (change && change.state !== "agreed") actions.append(button("変更合意を記録", async () => {
            const values = await formDialog("変更合意を記録", [
                { name: "source", label: "合意根拠", type: "select", options: [["customer_email", "顧客メール"], ["phone_record", "通話記録"], ["signed_document", "署名済み書類"]] },
                { name: "reference", label: "メールID・記録番号", required: true }
            ], "合意を記録");
            if (!values) return;
            await api(context, "record_change_agreement", { change_order_id: change.id, expected_revision: state.revision, operation_id: crypto.randomUUID(), evidence: { source: values.source, reference: values.reference } });
            await context.refreshCommercial();
        }));
        contractRoot.append(actions);
    }

    const nextRoot = byId("pa-next-action-summary");
    nextRoot.replaceChildren();
    byId("pa-data-freshness").textContent = `取得 ${dateTime(new Date().toISOString())}`;
    const next = data.case_status === "closed" ? "案件は完了済みです。必要な場合だけ、理由を記録して再開してください。"
        : pendingJob?.state === "unknown" ? "送信結果を照合してください。盲目的な再送・再発行はできません。"
        : state.estimate_change_state === "reconfirming" ? "条件再確認中です。新しい見積を作成してください。"
            : !current ? "最初の見積PDF・金額・条件を確認してください。"
                : !accepted ? active ? "お客様の正式回答を待っています。" : "顧客了承の根拠を確認し、正式受注確認を準備してください。"
                    : state.fulfillment_state !== "confirmed" ? "開催終了後、実施・追加費用を人が確認してください。"
                        : state.settlement_state !== "confirmed" ? "最終精算額と未処理変更を確認してください。"
                            : !billing ? "請求書を別途発行するか、既存書類を使用するか選択してください。"
                                : paid !== Number(billing.amount_minor) ? "銀行等で実入金を確認し、入金のみ記録または完了確認へ進んでください。"
                                    : "実施・精算・請求・全額入金を再確認して案件完了へ進めます。";
    nextRoot.append(element("p", "pa-commercial__next", next));
    appendLine(nextRoot, "業務", stateLabel("fulfillment", state.fulfillment_state));
    appendLine(nextRoot, "精算", stateLabel("settlement", state.settlement_state));
    appendLine(nextRoot, "最終更新", dateTime(state.updated_at));
    if (pendingJob) {
        const kind = { estimate: "見積", confirmation: "正式受注確認", invoice: "請求書", confirmation_reminder: "再案内" }[pendingJob.job_kind] || pendingJob.job_kind;
        const alert = element("p", pendingJob.state === "unknown" ? "pa-commercial__error" : "pa-commercial__warning", `${kind}：${stateLabel("outbox", pendingJob.state)}`);
        nextRoot.append(alert);
        if (["queued", "failed"].includes(pendingJob.state) && !(data.production_e2e_test && pendingJob.job_kind === "confirmation")) nextRoot.append(button("固定済み内容を送信", async () => {
            if (!window.confirm("表示中の固定済み宛先・本文・添付を送信しますか？")) return;
            await api(context, "dispatch_outbox", { job_id: pendingJob.id });
            await context.refreshCommercial();
        }, "button button--small"));
    }
    nextRoot.append(button("実施・精算／入金・完了へ", () => context.focusBilling(), "button button--secondary button--small"));

    const filesRoot = byId("pa-related-files");
    filesRoot.replaceChildren();
    const materials = data.related_materials || data.documents || [];
    byId("pa-related-files-count").textContent = `${materials.length}件／横に続きます`;
    for (const document of materials) renderDocument(context, document, filesRoot, epoch);
    if (!materials.length) filesRoot.append(element("p", "pa-commercial__label", "関連資料はまだありません。"));
    byId("pa-commercial-workspace").classList.remove("hidden");
};

export function renderCommercialWorkspace(context) {
    if (!context.case) {
        activeCaseId = null;
        activeCommercialDraftContext = null;
        activeEstimateEntry = null;
        activeEstimateActionStatus = null;
        estimateEntryOpening = false;
        activeWorkspaceContext = null;
        refreshEpoch += 1;
        byId("pa-commercial-workspace")?.classList.add("hidden");
        return;
    }
    if (activeCaseId !== context.case.id) estimateEntryOpening = false;
    activeCaseId = context.case.id;
    activeWorkspaceContext = context;
    activeEstimateEntry = null;
    const topEstimateButton = byId("pa-v5-estimate");
    topEstimateButton.disabled = true;
    topEstimateButton.textContent = "見積";
    topEstimateButton.dataset.paEstimateEntry = "loading";
    topEstimateButton.dataset.paEstimateIdleLabel = "見積";
    const refresh = async () => {
        const epoch = ++refreshEpoch;
        activeEstimateEntry = null;
        activeEstimateActionStatus = null;
        topEstimateButton.disabled = true;
        try {
            const data = await api(context, "snapshot");
            await render(context, data, epoch);
        } catch (error) {
            if (epoch !== refreshEpoch) return;
            activeEstimateEntry = null;
            const root = byId("pa-next-action-summary");
            root.replaceChildren(element("p", "pa-commercial__error", `V5状態を取得できません：${error.message}`));
            byId("pa-commercial-workspace").classList.remove("hidden");
        }
    };
    context.refreshCommercial = refresh;
    byId("pa-commercial-refresh").onclick = refresh;
    byId("pa-v5-reply").onclick = () => context.openComposer("normal");
    topEstimateButton.onclick = () => {
        const entry = activeEstimateEntry;
        if (!entry || entry.caseId !== activeCaseId) return false;
        return entry.open();
    };
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
