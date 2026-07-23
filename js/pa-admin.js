import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { SUPABASE_ANON_KEY, SUPABASE_URL, isSupabaseConfigured } from "./supabase-config.js";

const $ = (selector) => document.querySelector(selector);

const statusLabels = {
    new: "新規受付",
    reviewing: "内容確認中",
    second_form_not_issued: "日程確保フォーム未発行",
    second_form_issued: "日程確保フォーム発行済み",
    customer_responded: "お客様回答済み",
    schedule_unconfirmed: "日程確保未確定",
    schedule_confirmed: "日程確保完了",
    on_hold: "保留",
    cancelled: "取消",
    closed: "対応終了"
};

const statusBadgeClasses = {
    new: "new",
    reviewing: "reviewing",
    second_form_not_issued: "unconfirmed",
    second_form_issued: "issued",
    customer_responded: "answered",
    schedule_unconfirmed: "unconfirmed",
    schedule_confirmed: "confirmed",
    on_hold: "hold",
    cancelled: "cancelled",
    closed: "closed"
};

const relationshipLabels = {
    organizer: "主催者本人",
    "organization-representative": "主催団体の代表者",
    "organization-staff": "主催団体の担当者",
    payer: "支払責任者",
    requester: "依頼者",
    "authorized-representative": "正式に権限を与えられた担当者",
    "contact-only": "連絡窓口のみ",
    other: "その他"
};

const decisionLabels = {
    agree: "条件に同意し、日程調整を依頼",
    decline: "条件に同意せず、日程調整を依頼しない",
    question: "ARA-TECHへ確認したい"
};

const authorityLabels = {
    yes: "ある",
    no: "ない",
    unknown: "分からない"
};

const auditLabels = {
    case_created: "案件を登録",
    case_updated: "案件を更新",
    second_form_token_issued: "日程確保フォームURLを発行",
    second_form_token_revoked: "日程確保フォームURLを無効化",
    second_form_answered: "日程確保フォームの回答を受領",
    schedule_confirmed_after_customer_notice: "確定連絡後に日程確保完了"
};

const defaultConditions = [
    "現在は予約・日程確保が完了していません。",
    "この回答後にARA-TECHが既存案件の調整を開始します。回答だけで日程確保は成立しません。",
    "ARA-TECHから「日程確保完了」の連絡を受けた時点で日程確保が成立します。",
    "日程確保後、お客様都合で中止または日程変更となった場合は、日程確保料33,000円が発生します。",
    "通常のキャンセル料が33,000円を超える場合は通常のキャンセル料のみを適用し、重複請求はしません。",
    "日程を確保できなかった場合、または確保完了の連絡前に調整を中止した場合、日程確保料は発生しません。"
].join("\n");

const configMessage = $("#config-message");
const loginPanel = $("#login-panel");
const dashboard = $("#dashboard");
const loginForm = $("#login-form");
const loginStatus = $("#login-status");
const listStatus = $("#list-status");
const caseList = $("#case-list");
const emptyCases = $("#empty-cases");
const detailCard = $("#detail-card");
const caseForm = $("#case-form");
const caseStatusMessage = $("#case-status-message");
const tokenSection = $("#token-section");
const emailSection = $("#email-section");
const responseDetails = $("#response-details");
const auditList = $("#audit-list");
const firstFormSection = $("#first-form-section");
const firstFormDetails = $("#first-form-details");
const automaticMailStatus = $("#automatic-mail-status");
const emailHistory = $("#email-history");
const technicalDetails = $("#technical-details");
const nextActionSection = $("#next-action-section");

let supabase;
let cases = [];
let currentCase = null;
let currentToken = null;
let currentResponse = null;
let currentDeliveries = [];
let issuedRawToken = "";
let emailOperationKey = "";
let mailActionInProgress = false;

const setMessage = (element, text, type = "info") => {
    element.textContent = text;
    element.className = `alert alert--${type}`;
    element.classList.remove("hidden");
};

const clearMessage = (element) => {
    element.textContent = "";
    element.className = "alert hidden";
};

const valueOrNull = (selector) => {
    const value = $(selector).value.trim();
    return value || null;
};

const pad = (value) => String(value).padStart(2, "0");

const toLocalDateTimeInput = (value) => {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

const localInputToIso = (value) => value ? new Date(value).toISOString() : null;

const formatDate = (value) => {
    if (!value) return "未設定";
    const date = new Date(`${value}T00:00:00+09:00`);
    return new Intl.DateTimeFormat("ja-JP", {
        year: "numeric",
        month: "long",
        day: "numeric",
        timeZone: "Asia/Tokyo"
    }).format(date);
};

const formatDateTime = (value) => {
    if (!value) return "未設定";
    return new Intl.DateTimeFormat("ja-JP", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "Asia/Tokyo"
    }).format(new Date(value));
};

const mailTypeLabels = {
    internal_new_inquiry: "ARA-TECH向け新規受付通知",
    customer_receipt: "お客様向け受付確認",
    schedule_request: "日程確保フォーム案内"
};

const mailStatusLabels = {
    sending: "送信処理中",
    sent: "送信済み",
    failed: "送信失敗"
};

const newestDelivery = (type) =>
    currentDeliveries.find((delivery) => delivery.message_type === type) || null;

const nextActionText = () => {
    if (!currentCase) return "案件情報を入力";
    if (currentCase.schedule_state === "completed") return "対応履歴を確認";
    if (currentResponse) return "条件確認・同意の回答を確認";
    const scheduleMail = currentDeliveries.find(
        (delivery) => delivery.message_type === "schedule_request" && delivery.status === "sent"
    );
    if (scheduleMail) return "お客様の回答を待つ";
    if (currentToken) return "日程確保フォームの案内メールを送信";
    return "内容を確認し、日程調整の要否を判断";
};

const renderOverview = () => {
    $("#overview-number").textContent = currentCase?.inquiry_number || "保存時に発行";
    $("#overview-date").textContent = formatDate(currentCase?.event_date);
    $("#overview-contact").textContent = currentCase?.contact_name || currentCase?.customer_name || "未設定";
    $("#overview-venue").textContent = currentCase?.venue || "未設定";
    $("#overview-status").textContent = currentCase ? (statusLabels[currentCase.status] || currentCase.status) : "未保存";
    $("#overview-next-action").textContent = nextActionText();
};

const isAdmin = async (user) => {
    const { data, error } = await supabase
        .from("work_admins")
        .select("user_id")
        .eq("user_id", user.id)
        .maybeSingle();
    return Boolean(data && !error);
};

const statusBadge = (status) => {
    const badge = document.createElement("span");
    badge.className = `badge badge--${statusBadgeClasses[status] || "closed"}`;
    badge.textContent = statusLabels[status] || status;
    return badge;
};

const textBlock = (mainText, subText) => {
    const wrapper = document.createElement("div");
    const main = document.createElement("span");
    main.className = "cell-main";
    main.textContent = mainText || "未設定";
    wrapper.append(main);
    if (subText) {
        const sub = document.createElement("span");
        sub.className = "cell-sub";
        sub.textContent = subText;
        wrapper.append(sub);
    }
    return wrapper;
};

const filteredCases = () => {
    const query = $("#case-search").value.trim().toLocaleLowerCase("ja");
    const status = $("#case-status-filter").value;
    const sort = $("#case-sort").value;
    const result = cases.filter((item) => {
        if (status && item.status !== status) return false;
        if (!query) return true;
        return [
            item.inquiry_number,
            item.customer_name,
            item.organization_name,
            item.event_name,
            item.venue
        ].filter(Boolean).join(" ").toLocaleLowerCase("ja").includes(query);
    });

    result.sort((a, b) => {
        if (sort.startsWith("event")) {
            const aDate = a.event_date || (sort === "event-asc" ? "9999-12-31" : "0000-01-01");
            const bDate = b.event_date || (sort === "event-asc" ? "9999-12-31" : "0000-01-01");
            return sort === "event-asc" ? aDate.localeCompare(bDate) : bDate.localeCompare(aDate);
        }
        const aTime = new Date(a.received_at).getTime();
        const bTime = new Date(b.received_at).getTime();
        return sort === "received-asc" ? aTime - bTime : bTime - aTime;
    });

    return result;
};

const renderCases = () => {
    caseList.replaceChildren();
    const visibleCases = filteredCases();
    emptyCases.classList.toggle("hidden", visibleCases.length > 0);

    visibleCases.forEach((item) => {
        const row = document.createElement("tr");

        const numberCell = document.createElement("td");
        const openButton = document.createElement("button");
        openButton.className = "case-link";
        openButton.type = "button";
        openButton.textContent = item.inquiry_number;
        openButton.addEventListener("click", () => openCase(item.id));
        numberCell.append(openButton);

        const receivedCell = document.createElement("td");
        receivedCell.textContent = formatDateTime(item.received_at);

        const customerCell = document.createElement("td");
        customerCell.append(textBlock(
            item.organization_name || item.customer_name,
            item.organization_name ? `${item.customer_name} ／ ${item.event_name || "イベント名未設定"}` : item.event_name
        ));

        const eventCell = document.createElement("td");
        eventCell.append(textBlock(formatDate(item.event_date), item.venue));

        const stateCell = document.createElement("td");
        stateCell.append(statusBadge(item.status));
        const scheduleBadge = document.createElement("span");
        scheduleBadge.className = `badge badge--${item.schedule_state === "completed" ? "confirmed" : "unconfirmed"}`;
        scheduleBadge.textContent = item.schedule_state === "completed" ? "日程確保完了" : "日程未確定";
        stateCell.append(scheduleBadge);

        const formCell = document.createElement("td");
        formCell.append(textBlock(
            item.second_form_issued_at ? "発行済み" : "未発行",
            item.second_form_answered_at ? `回答：${formatDateTime(item.second_form_answered_at)}` : "未回答"
        ));

        const updatedCell = document.createElement("td");
        updatedCell.textContent = formatDateTime(item.updated_at);

        row.append(numberCell, receivedCell, customerCell, eventCell, stateCell, formCell, updatedCell);
        caseList.append(row);
    });
};

const loadCases = async () => {
    clearMessage(listStatus);
    const { data, error } = await supabase
        .from("pa_inquiries")
        .select("*")
        .order("received_at", { ascending: false });

    if (error) {
        setMessage(listStatus, "問い合わせ一覧を読み込めませんでした。データベース設定をご確認ください。", "error");
        return;
    }

    cases = data || [];
    renderCases();
};

const resetForm = () => {
    caseForm.reset();
    $("#case-id").value = "";
    $("#case-received-at").value = toLocalDateTimeInput(new Date().toISOString());
    $("#case-status").value = "new";
    $("#public-conditions").value = defaultConditions;
    $("#detail-title").textContent = "問い合わせを手入力";
    $("#detail-number").textContent = "保存時に問い合わせ番号を発行します。";
    firstFormSection.classList.add("hidden");
    firstFormDetails.replaceChildren();
    currentCase = null;
    currentToken = null;
    currentResponse = null;
    currentDeliveries = [];
    issuedRawToken = "";
    emailOperationKey = "";
    tokenSection.classList.add("hidden");
    emailSection.classList.add("hidden");
    nextActionSection.classList.add("hidden");
    automaticMailStatus.replaceChildren();
    emailHistory.replaceChildren();
    technicalDetails.replaceChildren();
    $("#response-state").textContent = "回答はまだありません。";
    responseDetails.replaceChildren();
    $("#schedule-state").textContent = "日程確保未確定";
    $("#confirm-schedule").disabled = true;
    auditList.replaceChildren();
    clearMessage(caseStatusMessage);
    clearMessage($("#email-message"));
    renderOverview();
    detailCard.classList.remove("hidden");
    detailCard.scrollIntoView({ behavior: "smooth", block: "start" });
    $("#customer-name").focus({ preventScroll: true });
};

const populateCaseForm = (item) => {
    $("#case-id").value = item.id;
    $("#case-received-at").value = toLocalDateTimeInput(item.received_at);
    $("#case-status").value = item.status;
    $("#customer-name").value = item.customer_name || "";
    $("#organization-name").value = item.organization_name || "";
    $("#contact-name").value = item.contact_name || "";
    $("#customer-email").value = item.email || "";
    $("#customer-phone").value = item.phone || "";
    $("#event-name").value = item.event_name || "";
    $("#event-date").value = item.event_date || "";
    $("#event-time").value = item.event_time || "";
    $("#venue").value = item.venue || "";
    $("#request-summary").value = item.request_summary || "";
    $("#internal-memo").value = item.internal_memo || "";
    $("#public-addressee").value = item.public_addressee || item.customer_name || "";
    $("#public-event-name").value = item.public_event_name || item.event_name || "";
    $("#public-event-date").value = item.public_event_date || item.event_date || "";
    $("#public-event-time").value = item.public_event_time || item.event_time || "";
    $("#public-venue").value = item.public_venue || item.venue || "";
    $("#public-request-summary").value = item.public_request_summary || "";
    $("#public-guidance").value = item.public_guidance || "";
    $("#public-conditions").value = item.public_conditions || defaultConditions;
    $("#detail-title").textContent = item.event_name || "問い合わせ案件";
    const sourceLabel = item.submission_source === "public_form" ? "Webフォーム" : "手入力";
    $("#detail-number").textContent = `${item.inquiry_number} ／ 受付 ${formatDateTime(item.received_at)} ／ ${sourceLabel}`;
    renderFirstFormData(item);
    renderOverview();
};

const firstFormLabels = {
    form_source: "参照元",
    form_service: "サービス種別",
    event_name: "イベント名・案件名",
    event_date: "開催希望日",
    event_time: "開催時間",
    venue_name: "会場名",
    venue_address: "会場住所",
    venue_type: "会場種別",
    expected_attendance: "想定来場者数",
    event_overview: "イベント内容・開催概要",
    event_status: "開催状況",
    requested_services: "希望する業務",
    organizer_type: "主催者区分",
    organizer_name: "主催者・主催団体名",
    organizer_representative: "主催団体代表者",
    organizer_email: "主催者メール",
    organizer_phone: "主催者電話番号",
    requester_relation: "依頼者と主催者の関係",
    requester_name: "依頼者名",
    requester_organization: "依頼者の会社・団体名",
    requester_authority: "発注・条件同意の権限",
    contact_source: "連絡窓口の選択",
    contact_name: "連絡担当者名",
    contact_email: "連絡先メール",
    contact_phone: "連絡先電話番号",
    preferred_contact_method: "希望連絡方法",
    payer_source: "支払責任者の選択",
    invoice_name: "請求先名義",
    payer_name: "支払責任者名",
    payer_organization: "支払責任者の会社・団体名",
    payer_email: "支払責任者メール",
    payer_phone: "支払責任者電話番号",
    estimate_notes: "見積り・準備に必要な情報",
    questions: "質問・連絡事項",
    confirmation_consent: "確認事項への同意"
};

const appendFirstFormDetail = (term, description) => {
    const dt = document.createElement("dt");
    const dd = document.createElement("dd");
    dt.textContent = term;
    dd.textContent = description || "未入力";
    firstFormDetails.append(dt, dd);
};

const renderFirstFormData = (item) => {
    firstFormDetails.replaceChildren();
    const isPublicForm = item.submission_source === "public_form";
    firstFormSection.classList.toggle("hidden", !isPublicForm);
    if (!isPublicForm) return;

    const data = item.first_form_data && typeof item.first_form_data === "object"
        ? item.first_form_data
        : {};
    for (const [key, label] of Object.entries(firstFormLabels)) {
        const value = data[key];
        const displayValue = Array.isArray(value)
            ? value.join("、")
            : value === true ? "同意済み"
                : value === false ? "未同意"
                    : String(value || "");
        appendFirstFormDetail(label, displayValue);
    }
};

const renderTokenState = () => {
    issuedRawToken = "";
    $("#issued-url").value = "";
    emailSection.classList.add("hidden");
    clearMessage($("#token-message"));

    if (!currentToken) {
        $("#token-state").textContent = "日程確保フォームURLは未発行です。";
        $("#revoke-token").disabled = true;
        return;
    }

    if (currentToken.answered_at) {
        $("#token-state").textContent = `回答済み：${formatDateTime(currentToken.answered_at)}`;
        $("#revoke-token").disabled = true;
        return;
    }

    if (currentToken.revoked_at) {
        $("#token-state").textContent = `無効化済み：${formatDateTime(currentToken.revoked_at)}`;
        $("#revoke-token").disabled = true;
        return;
    }

    if (new Date(currentToken.expires_at).getTime() <= Date.now()) {
        $("#token-state").textContent = `期限切れ：${formatDateTime(currentToken.expires_at)}`;
        $("#revoke-token").disabled = true;
        return;
    }

    $("#token-state").textContent = `有効期限：${formatDateTime(currentToken.expires_at)}。URLの生トークンはDBから再表示できません。`;
    $("#revoke-token").disabled = false;
};

const appendDetail = (term, description) => {
    const dt = document.createElement("dt");
    const dd = document.createElement("dd");
    dt.textContent = term;
    dd.textContent = description || "未入力";
    responseDetails.append(dt, dd);
};

const renderResponse = () => {
    responseDetails.replaceChildren();
    if (!currentResponse) {
        $("#response-state").textContent = "回答はまだありません。";
        return;
    }

    $("#response-state").textContent = `回答済み：${formatDateTime(currentResponse.submitted_at)}`;
    appendDetail("最終回答", decisionLabels[currentResponse.decision] || currentResponse.decision);
    appendDetail("回答者", currentResponse.organization
        ? `${currentResponse.respondent_name}（${currentResponse.organization}）`
        : currentResponse.respondent_name);
    appendDetail("メールアドレス", currentResponse.email);
    appendDetail("電話番号", currentResponse.phone);
    appendDetail("案件との関係", currentResponse.relationship === "other"
        ? `その他（${currentResponse.relationship_other || "未入力"}）`
        : relationshipLabels[currentResponse.relationship] || currentResponse.relationship);
    appendDetail("条件同意の権限", authorityLabels[currentResponse.authority] || currentResponse.authority);
    appendDetail("確認者氏名", currentResponse.confirmation_name);
    appendDetail("確認事項", currentResponse.question_details);
    appendDetail("規約バージョン", currentResponse.terms_version);
};

const retryButton = (delivery) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "button button--secondary button--small";
    button.textContent = "このメールを再送";
    button.addEventListener("click", () => retryEmail(delivery.id));
    return button;
};

const renderAutomaticMailStatus = () => {
    automaticMailStatus.replaceChildren();
    [
        ["customer_receipt", "お客様向け受付確認"],
        ["internal_new_inquiry", "ARA-TECH向け新規受付通知"]
    ].forEach(([type, label]) => {
        const delivery = newestDelivery(type);
        const card = document.createElement("div");
        card.className = `mail-status-card${delivery ? ` mail-status-card--${delivery.status}` : ""}`;
        const title = document.createElement("strong");
        title.textContent = label;
        const status = document.createElement("p");
        status.textContent = delivery
            ? `${mailStatusLabels[delivery.status] || delivery.status}${delivery.sent_at ? ` ／ ${formatDateTime(delivery.sent_at)}` : ""}`
            : "送信記録なし（既存案件）";
        card.append(title, status);
        if (delivery?.status === "failed") card.append(retryButton(delivery));
        automaticMailStatus.append(card);
    });
};

const renderEmailHistory = () => {
    emailHistory.replaceChildren();
    if (!currentDeliveries.length) {
        const note = document.createElement("p");
        note.className = "small-note";
        note.textContent = "メール送信履歴はありません。";
        emailHistory.append(note);
        $("#email-send-state").textContent = "未送信";
        return;
    }

    currentDeliveries.forEach((delivery) => {
        const item = document.createElement("div");
        item.className = `mail-history__item mail-history__item--${delivery.status}`;
        const title = document.createElement("strong");
        title.textContent = `${mailTypeLabels[delivery.message_type] || delivery.message_type} ／ ${mailStatusLabels[delivery.status] || delivery.status}`;
        const subject = document.createElement("span");
        subject.textContent = delivery.subject;
        const meta = document.createElement("span");
        const when = delivery.sent_at || delivery.failed_at || delivery.requested_at;
        meta.textContent = `${formatDateTime(when)} ／ 試行${delivery.attempt_number}回目${delivery.is_retry ? "（再送）" : ""}${delivery.gmail_message_id ? ` ／ Gmail ID: ${delivery.gmail_message_id}` : ""}`;
        item.append(title, subject, meta);
        if (delivery.status === "failed") item.append(retryButton(delivery));
        emailHistory.append(item);
    });

    const latestSchedule = newestDelivery("schedule_request");
    $("#email-send-state").textContent = latestSchedule
        ? `${mailStatusLabels[latestSchedule.status] || latestSchedule.status}${latestSchedule.sent_at ? `：${formatDateTime(latestSchedule.sent_at)}` : ""}`
        : "未送信";
};

const renderTechnicalDetails = () => {
    technicalDetails.replaceChildren();
    if (!currentCase) return;
    [
        ["内部ID", currentCase.id],
        ["データ版", String(currentCase.revision || "")],
        ["受付経路", currentCase.submission_source],
        ["作成日時", formatDateTime(currentCase.created_at)],
        ["最終更新日時", formatDateTime(currentCase.updated_at)],
        ["日程確保フォームURL発行日時", formatDateTime(currentCase.second_form_issued_at)],
        ["日程確保フォーム回答日時", formatDateTime(currentCase.second_form_answered_at)]
    ].forEach(([term, description]) => {
        const dt = document.createElement("dt");
        const dd = document.createElement("dd");
        dt.textContent = term;
        dd.textContent = description || "未設定";
        technicalDetails.append(dt, dd);
    });
};

const renderAudit = (entries) => {
    auditList.replaceChildren();
    const mailEntries = currentDeliveries.map((delivery) => ({
        occurred_at: delivery.sent_at || delivery.failed_at || delivery.requested_at,
        label: `${mailTypeLabels[delivery.message_type] || delivery.message_type}：${mailStatusLabels[delivery.status] || delivery.status}${delivery.is_retry ? "（再送）" : ""}`
    }));
    const combined = [
        ...entries.map((entry) => ({
            occurred_at: entry.occurred_at,
            label: auditLabels[entry.action] || entry.action
        })),
        ...mailEntries
    ].sort((a, b) => new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime());

    if (!combined.length) {
        const item = document.createElement("li");
        item.textContent = "操作履歴はありません。";
        auditList.append(item);
        return;
    }

    combined.forEach((entry) => {
        const item = document.createElement("li");
        item.textContent = `${formatDateTime(entry.occurred_at)}　${entry.label}`;
        auditList.append(item);
    });
};

const renderScheduleState = () => {
    const completed = currentCase?.schedule_state === "completed";
    $("#schedule-state").textContent = completed
        ? `日程確保完了（お客様への確定連絡：${formatDateTime(currentCase.customer_confirmation_sent_at)}）`
        : "日程確保未確定";
    $("#confirm-schedule").disabled = completed;
};

const openCase = async (id) => {
    clearMessage(caseStatusMessage);
    const { data: item, error } = await supabase
        .from("pa_inquiries")
        .select("*")
        .eq("id", id)
        .single();

    if (error || !item) {
        setMessage(listStatus, "案件を読み込めませんでした。", "error");
        return;
    }

    const [tokenResult, responseResult, auditResult, deliveryResult] = await Promise.all([
        supabase
            .from("pa_schedule_tokens")
            .select("id, issued_at, expires_at, revoked_at, answered_at")
            .eq("inquiry_id", id)
            .order("issued_at", { ascending: false })
            .limit(1)
            .maybeSingle(),
        supabase
            .from("pa_schedule_responses")
            .select("*")
            .eq("inquiry_id", id)
            .maybeSingle(),
        supabase
            .from("pa_inquiry_audit")
            .select("occurred_at, action, details")
            .eq("inquiry_id", id)
            .order("occurred_at", { ascending: false })
            .limit(50),
        supabase
            .from("pa_email_deliveries")
            .select("id, message_type, recipient, subject, status, requested_at, sent_at, failed_at, gmail_message_id, error_summary, is_retry, attempt_number")
            .eq("inquiry_id", id)
            .order("requested_at", { ascending: false })
            .limit(100)
    ]);

    currentCase = item;
    currentToken = tokenResult.data || null;
    currentResponse = responseResult.data || null;
    currentDeliveries = deliveryResult.data || [];
    issuedRawToken = "";
    emailOperationKey = "";
    populateCaseForm(item);
    nextActionSection.classList.remove("hidden");
    tokenSection.classList.remove("hidden");
    renderTokenState();
    renderResponse();
    renderAudit(auditResult.data || []);
    renderAutomaticMailStatus();
    renderEmailHistory();
    renderTechnicalDetails();
    renderScheduleState();
    renderOverview();
    $("#token-expiry").value = toLocalDateTimeInput(
        currentToken?.expires_at || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
    );
    detailCard.classList.remove("hidden");
    detailCard.scrollIntoView({ behavior: "smooth", block: "start" });
};

const casePayload = () => ({
    received_at: localInputToIso($("#case-received-at").value),
    status: $("#case-status").value,
    customer_name: $("#customer-name").value.trim(),
    organization_name: valueOrNull("#organization-name"),
    contact_name: valueOrNull("#contact-name"),
    email: $("#customer-email").value.trim(),
    phone: valueOrNull("#customer-phone"),
    event_name: valueOrNull("#event-name"),
    event_date: $("#event-date").value || null,
    event_time: valueOrNull("#event-time"),
    venue: valueOrNull("#venue"),
    request_summary: valueOrNull("#request-summary"),
    internal_memo: valueOrNull("#internal-memo"),
    public_addressee: valueOrNull("#public-addressee"),
    public_event_name: valueOrNull("#public-event-name"),
    public_event_date: $("#public-event-date").value || null,
    public_event_time: valueOrNull("#public-event-time"),
    public_venue: valueOrNull("#public-venue"),
    public_request_summary: valueOrNull("#public-request-summary"),
    public_guidance: valueOrNull("#public-guidance"),
    public_conditions: valueOrNull("#public-conditions")
});

const validateCase = (payload) => {
    if (!payload.received_at) return "受付日時を入力してください。";
    if (!payload.customer_name) return "お客様名・担当者名を入力してください。";
    if (!payload.email) return "メールアドレスを入力してください。";
    if (payload.status === "schedule_confirmed" && currentCase?.schedule_state !== "completed") {
        return "「日程確保完了」は、お客様へ確定連絡後に専用ボタンから変更してください。";
    }
    return "";
};

const saveCase = async () => {
    clearMessage(caseStatusMessage);
    const payload = casePayload();
    const validationMessage = validateCase(payload);
    if (validationMessage) {
        setMessage(caseStatusMessage, validationMessage, "error");
        return;
    }

    $("#save-case").disabled = true;
    let result;
    if (currentCase) {
        result = await supabase
            .from("pa_inquiries")
            .update(payload)
            .eq("id", currentCase.id)
            .select("*")
            .single();
    } else {
        result = await supabase
            .from("pa_inquiries")
            .insert({ ...payload, submission_source: "manual" })
            .select("*")
            .single();
    }
    $("#save-case").disabled = false;

    if (result.error) {
        setMessage(caseStatusMessage, `保存できませんでした。${result.error.message || ""}`, "error");
        return;
    }

    currentCase = result.data;
    populateCaseForm(currentCase);
    tokenSection.classList.remove("hidden");
    $("#token-expiry").value = toLocalDateTimeInput(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString());
    await loadCases();
    await openCase(currentCase.id);
    setMessage(caseStatusMessage, "案件を保存しました。", "success");
};

const randomToken = () => {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};

const buildEmail = (url) => {
    const addressee = currentCase.public_addressee || currentCase.customer_name;
    const eventName = currentCase.public_event_name || currentCase.event_name || "ご相談の案件";
    const eventDate = currentCase.public_event_date || currentCase.event_date;
    const deadline = currentCase.response_deadline || localInputToIso($("#token-expiry").value);
    const subject = `【ARA-TECH】開催日程についてのご確認／受付番号${currentCase.inquiry_number}`;
    const body = [
        `${addressee} 様`,
        "",
        "ARA-TECHへお問い合わせいただきありがとうございます。",
        "下記案件について、日程確保に必要な条件確認・同意をお願いいたします。",
        "",
        `問い合わせ番号：${currentCase.inquiry_number}`,
        `イベント名：${eventName}`,
        `開催希望日：${formatDate(eventDate)}`,
        `会場・開催場所：${currentCase.public_venue || currentCase.venue || "未設定"}`,
        "",
        "日程確保フォーム専用URL",
        url,
        "",
        `回答期限：${formatDateTime(deadline)}`,
        "",
        "専用URLを開き、表示された案件情報と条件をご確認・同意のうえ、ご回答ください。",
        "日程確保フォームへの回答だけでは、契約・予約または日程確保は確定しません。",
        "ARA-TECHが内容を確認し、日程確保完了の連絡をした時点で確保成立となります。",
        "",
        "ご不明点がございましたら、このメールへご返信ください。",
        ""
    ].join("\n");

    $("#email-recipient").value = currentCase.email || "";
    $("#email-subject").value = subject;
    $("#email-body").value = body;
    $("#email-schedule-url").value = url;
    emailOperationKey = crypto.randomUUID();
    clearMessage($("#email-message"));
    emailSection.classList.remove("hidden");
};

const issueToken = async () => {
    clearMessage($("#token-message"));
    if (!currentCase) {
        setMessage($("#token-message"), "先に案件を保存してください。", "error");
        return;
    }

    const visibleEvent = $("#public-event-name").value.trim() || $("#event-name").value.trim();
    const visibleDate = $("#public-event-date").value || $("#event-date").value;
    const visibleVenue = $("#public-venue").value.trim() || $("#venue").value.trim();
    if (!visibleEvent || !visibleDate || !visibleVenue || !$("#public-conditions").value.trim()) {
        setMessage($("#token-message"), "イベント名、開催希望日、会場、公開用条件を設定して案件を保存してください。", "error");
        return;
    }

    const expiry = localInputToIso($("#token-expiry").value);
    if (!expiry || new Date(expiry).getTime() <= Date.now()) {
        setMessage($("#token-message"), "回答期限は現在より後の日時を指定してください。", "error");
        return;
    }

    $("#issue-token").disabled = true;
    const rawToken = randomToken();
    const { data, error } = await supabase.rpc("issue_pa_schedule_token", {
        p_inquiry_id: currentCase.id,
        p_token: rawToken,
        p_expires_at: expiry
    });
    $("#issue-token").disabled = false;

    if (error || !data?.length) {
        setMessage($("#token-message"), `URLを発行できませんでした。${error?.message || ""}`, "error");
        return;
    }

    issuedRawToken = rawToken;
    currentToken = {
        id: data[0].token_id,
        issued_at: data[0].issued_at,
        expires_at: data[0].expires_at,
        revoked_at: null,
        answered_at: null
    };
    currentCase.second_form_issued_at = data[0].issued_at;
    currentCase.response_deadline = data[0].expires_at;
    currentCase.status = "second_form_issued";
    const url = `https://ara-tech.cc/pa-schedule-confirm.html?token=${encodeURIComponent(rawToken)}`;
    $("#issued-url").value = url;
    $("#token-state").textContent = `発行済み。有効期限：${formatDateTime(data[0].expires_at)}`;
    $("#revoke-token").disabled = false;
    buildEmail(url);
    renderOverview();
    setMessage($("#token-message"), "日程確保フォームの専用URLと案内メールを作成しました。内容を確認してGmail送信してください。", "success");
    await loadCases();
};

const revokeToken = async () => {
    if (!currentCase || !window.confirm("現在の日程確保フォームURLを無効にしますか？")) return;
    clearMessage($("#token-message"));
    const { data, error } = await supabase.rpc("revoke_pa_schedule_token", {
        p_inquiry_id: currentCase.id
    });
    if (error || !data) {
        setMessage($("#token-message"), `URLを無効化できませんでした。${error?.message || ""}`, "error");
        return;
    }
    currentToken = currentToken ? { ...currentToken, revoked_at: new Date().toISOString() } : null;
    currentCase.status = "second_form_not_issued";
    issuedRawToken = "";
    emailOperationKey = "";
    $("#issued-url").value = "";
    emailSection.classList.add("hidden");
    renderTokenState();
    renderOverview();
    setMessage($("#token-message"), "現在のURLを無効化しました。", "success");
    await loadCases();
};

const mailErrorMessage = (code) => {
    if (code === "gmail_not_configured" || String(code).startsWith("gmail_oauth_")) {
        return "Gmail接続設定を確認してください。案件データは保持され、送信失敗として記録されます。";
    }
    if (String(code).startsWith("gmail_send_")) {
        return "Gmailから送信できませんでした。案件データは保持されています。接続状態を確認して再送してください。";
    }
    if (code === "not_authorized") return "管理者セッションを確認し、再ログインしてください。";
    return "メールを送信できませんでした。案件データは保持されています。送信履歴を確認して再送してください。";
};

const setMailButtonsDisabled = (disabled) => {
    $("#send-email").disabled = disabled;
    document.querySelectorAll(".mail-status-grid button, .mail-history button").forEach((button) => {
        button.disabled = disabled;
    });
};

const callMailApi = async (payload) => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) throw new Error("not_authorized");
    const response = await fetch("/api/pa-mail", {
        method: "POST",
        headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            Authorization: `Bearer ${session.access_token}`
        },
        credentials: "same-origin",
        body: JSON.stringify(payload)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.delivery) throw new Error(result.code || "mail_delivery_failed");
    return result;
};

const recordDeliveryResult = (delivery) => {
    currentDeliveries = [
        delivery,
        ...currentDeliveries.filter((item) => item.id !== delivery.id)
    ].sort((a, b) => new Date(b.requested_at || b.sent_at || b.failed_at).getTime()
        - new Date(a.requested_at || a.sent_at || a.failed_at).getTime());
    renderAutomaticMailStatus();
    renderEmailHistory();
    renderOverview();
};

const resetSendEmailConfirmation = () => {
    const button = $("#send-email");
    delete button.dataset.confirmationKey;
    button.textContent = "この内容でGmail送信";
};

const sendEmail = async () => {
    if (!currentCase || mailActionInProgress) return;
    const subject = $("#email-subject").value.trim();
    const body = $("#email-body").value.trim();
    const scheduleUrl = $("#email-schedule-url").value.trim();
    if (!subject || !body || !scheduleUrl || !emailOperationKey) {
        setMessage($("#email-message"), "宛先、件名、本文、専用URLを確認してください。", "error");
        return;
    }
    const confirmationKey = JSON.stringify([currentCase.id, currentCase.email, subject, body, scheduleUrl]);
    const sendButton = $("#send-email");
    if (sendButton.dataset.confirmationKey !== confirmationKey) {
        sendButton.dataset.confirmationKey = confirmationKey;
        sendButton.textContent = "この宛先へGmail送信を確定";
        setMessage(
            $("#email-message"),
            `${currentCase.email} へ表示中の件名・本文を送信します。宛先と内容を再確認し、もう一度ボタンを押してください。`,
            "warning"
        );
        return;
    }
    resetSendEmailConfirmation();

    mailActionInProgress = true;
    setMailButtonsDisabled(true);
    clearMessage($("#email-message"));
    $("#email-send-state").textContent = "送信処理中";
    try {
        const result = await callMailApi({
            action: "send_schedule",
            inquiry_id: currentCase.id,
            subject,
            body,
            schedule_url: scheduleUrl,
            operation_key: emailOperationKey
        });
        recordDeliveryResult(result.delivery);
        if (result.delivery.status === "sent") {
            setMessage($("#email-message"), "Gmailから送信しました。送信日時とGmailメッセージIDを案件へ記録しました。", "success");
        } else {
            setMessage($("#email-message"), mailErrorMessage(result.delivery.error_summary), "error");
        }
    } catch (error) {
        setMessage($("#email-message"), mailErrorMessage(error.message), "error");
        $("#email-send-state").textContent = "送信失敗";
    } finally {
        mailActionInProgress = false;
        resetSendEmailConfirmation();
        setMailButtonsDisabled(false);
    }
};

const retryEmail = async (deliveryId) => {
    if (!currentCase || mailActionInProgress) return;
    const delivery = currentDeliveries.find((item) => item.id === deliveryId);
    if (!delivery || delivery.status !== "failed") return;
    if (!window.confirm(`${mailTypeLabels[delivery.message_type] || "メール"}を同じ宛先・件名・本文で再送しますか？`)) return;

    mailActionInProgress = true;
    setMailButtonsDisabled(true);
    clearMessage($("#email-message"));
    try {
        const result = await callMailApi({
            action: "retry",
            inquiry_id: currentCase.id,
            delivery_id: delivery.id
        });
        recordDeliveryResult(result.delivery);
        if (result.delivery.status === "sent") {
            setMessage($("#email-message"), "Gmailから再送しました。再送履歴を案件へ記録しました。", "success");
        } else {
            setMessage($("#email-message"), mailErrorMessage(result.delivery.error_summary), "error");
        }
    } catch (error) {
        setMessage($("#email-message"), mailErrorMessage(error.message), "error");
    } finally {
        mailActionInProgress = false;
        setMailButtonsDisabled(false);
    }
};

const confirmSchedule = async () => {
    if (!currentCase) return;
    const confirmation = window.confirm(
        `${currentCase.inquiry_number}について、お客様へ日程確保の確定連絡を送信済みですか？\n\n送信済みの場合だけ「OK」を押してください。`
    );
    if (!confirmation) return;

    clearMessage($("#schedule-message"));
    $("#confirm-schedule").disabled = true;
    const { data, error } = await supabase.rpc("confirm_pa_schedule", {
        p_inquiry_id: currentCase.id,
        p_customer_confirmation_sent: true
    });

    if (error || !data) {
        $("#confirm-schedule").disabled = false;
        setMessage($("#schedule-message"), `日程確保完了へ変更できませんでした。${error?.message || ""}`, "error");
        return;
    }

    currentCase.schedule_state = "completed";
    currentCase.status = "schedule_confirmed";
    currentCase.schedule_confirmed_at = data;
    currentCase.customer_confirmation_sent_at = data;
    $("#case-status").value = "schedule_confirmed";
    renderScheduleState();
    renderOverview();
    setMessage($("#schedule-message"), "確定連絡済みとして、日程確保完了へ変更しました。", "success");
    await loadCases();
};

const showDashboard = async (user) => {
    loginPanel.classList.add("hidden");
    dashboard.classList.remove("hidden");
    $("#session-email").textContent = user.email || "";
    await loadCases();
};

const restoreSession = async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.user) return;
    if (await isAdmin(session.user)) {
        await showDashboard(session.user);
    } else {
        await supabase.auth.signOut();
    }
};

if (!isSupabaseConfigured) {
    configMessage.classList.remove("hidden");
    setMessage(configMessage, "Supabaseの接続情報が設定されていません。", "error");
    loginPanel.classList.add("hidden");
} else {
    supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    restoreSession();

    loginForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        clearMessage(loginStatus);
        const submitButton = loginForm.querySelector('button[type="submit"]');
        submitButton.disabled = true;
        const { data, error } = await supabase.auth.signInWithPassword({
            email: $("#login-email").value.trim(),
            password: $("#login-password").value
        });
        submitButton.disabled = false;
        if (error || !data.user) {
            setMessage(loginStatus, "メールアドレスまたはパスワードを確認してください。", "error");
            return;
        }
        if (!await isAdmin(data.user)) {
            await supabase.auth.signOut();
            setMessage(loginStatus, "このアカウントには管理権限がありません。", "error");
            return;
        }
        await showDashboard(data.user);
    });

    $("#new-case").addEventListener("click", resetForm);
    $("#refresh-cases").addEventListener("click", loadCases);
    $("#case-search").addEventListener("input", renderCases);
    $("#case-status-filter").addEventListener("change", renderCases);
    $("#case-sort").addEventListener("change", renderCases);
    $("#close-detail").addEventListener("click", () => detailCard.classList.add("hidden"));
    $("#cancel-case-edit").addEventListener("click", () => detailCard.classList.add("hidden"));

    caseForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        await saveCase();
    });

    $("#issue-token").addEventListener("click", issueToken);
    $("#revoke-token").addEventListener("click", revokeToken);
    $("#confirm-schedule").addEventListener("click", confirmSchedule);
    $("#send-email").addEventListener("click", sendEmail);
    $("#sign-out").addEventListener("click", async () => {
        await supabase.auth.signOut();
        location.reload();
    });
}
