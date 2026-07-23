import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { SUPABASE_ANON_KEY, SUPABASE_URL, isSupabaseConfigured } from "./supabase-config.js";

const $ = (selector) => document.querySelector(selector);

const statusLabels = {
    new: "新規受付",
    reviewing: "内容確認中",
    second_form_not_issued: "第2フォーム未発行",
    second_form_issued: "第2フォーム発行済み",
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
    second_form_token_issued: "第2フォームURLを発行",
    second_form_token_revoked: "第2フォームURLを無効化",
    second_form_answered: "第2フォーム回答を受領",
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

let supabase;
let cases = [];
let currentCase = null;
let currentToken = null;
let currentResponse = null;
let issuedRawToken = "";

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
    issuedRawToken = "";
    tokenSection.classList.add("hidden");
    emailSection.classList.add("hidden");
    $("#response-state").textContent = "回答はまだありません。";
    responseDetails.replaceChildren();
    $("#schedule-state").textContent = "日程確保未確定";
    $("#confirm-schedule").disabled = true;
    auditList.replaceChildren();
    clearMessage(caseStatusMessage);
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
        $("#token-state").textContent = "第2フォームURLは未発行です。";
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

const renderAudit = (entries) => {
    auditList.replaceChildren();
    if (!entries.length) {
        const item = document.createElement("li");
        item.textContent = "操作履歴はありません。";
        auditList.append(item);
        return;
    }

    entries.forEach((entry) => {
        const item = document.createElement("li");
        item.textContent = `${formatDateTime(entry.occurred_at)}　${auditLabels[entry.action] || entry.action}`;
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

    const [tokenResult, responseResult, auditResult] = await Promise.all([
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
            .limit(50)
    ]);

    currentCase = item;
    currentToken = tokenResult.data || null;
    currentResponse = responseResult.data || null;
    issuedRawToken = "";
    populateCaseForm(item);
    tokenSection.classList.remove("hidden");
    renderTokenState();
    renderResponse();
    renderAudit(auditResult.data || []);
    renderScheduleState();
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
    const subject = `【ARA-TECH】日程確保条件のご確認（${currentCase.inquiry_number}）`;
    const body = [
        `${addressee} 様`,
        "",
        "ARA-TECHへお問い合わせいただきありがとうございます。",
        "下記案件について、日程確保条件のご確認をお願いいたします。",
        "",
        `問い合わせ番号：${currentCase.inquiry_number}`,
        `イベント名：${eventName}`,
        `開催希望日：${formatDate(eventDate)}`,
        "",
        "第2フォーム専用URL",
        url,
        "",
        `回答期限：${formatDateTime(deadline)}`,
        "",
        "専用URLを開き、表示された案件情報と条件をご確認のうえ、ご回答ください。",
        "この第2フォームへの回答だけでは、予約または日程確保は確定しません。",
        "ARA-TECHが内容を確認し、日程確保完了の連絡をした時点で確保成立となります。",
        "",
        "ご不明点がございましたら、このメールへご返信ください。",
        "",
        "ARA-TECH",
        "https://ara-tech.cc/"
    ].join("\n");

    $("#email-subject").value = subject;
    $("#email-body").value = body;
    $("#open-mail-app").href = `mailto:${encodeURIComponent(currentCase.email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
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
    setMessage($("#token-message"), "専用URLと返信メール文を作成しました。内容を確認してから送付してください。", "success");
    await loadCases();
};

const revokeToken = async () => {
    if (!currentCase || !window.confirm("現在の第2フォームURLを無効にしますか？")) return;
    clearMessage($("#token-message"));
    const { data, error } = await supabase.rpc("revoke_pa_schedule_token", {
        p_inquiry_id: currentCase.id
    });
    if (error || !data) {
        setMessage($("#token-message"), `URLを無効化できませんでした。${error?.message || ""}`, "error");
        return;
    }
    currentToken = currentToken ? { ...currentToken, revoked_at: new Date().toISOString() } : null;
    issuedRawToken = "";
    $("#issued-url").value = "";
    emailSection.classList.add("hidden");
    renderTokenState();
    setMessage($("#token-message"), "現在のURLを無効化しました。", "success");
    await loadCases();
};

const copyText = async (text, successMessage, element) => {
    if (!text) {
        setMessage(element, "コピーする内容がありません。", "error");
        return;
    }
    try {
        await navigator.clipboard.writeText(text);
        setMessage(element, successMessage, "success");
    } catch {
        const fallback = document.createElement("textarea");
        fallback.value = text;
        fallback.setAttribute("readonly", "");
        fallback.style.position = "fixed";
        fallback.style.opacity = "0";
        document.body.append(fallback);
        fallback.select();
        document.execCommand("copy");
        fallback.remove();
        setMessage(element, successMessage, "success");
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
    $("#copy-url").addEventListener("click", () => copyText(
        $("#issued-url").value,
        "専用URLをコピーしました。",
        $("#token-message")
    ));
    $("#copy-subject").addEventListener("click", () => copyText(
        $("#email-subject").value,
        "件名をコピーしました。",
        $("#token-message")
    ));
    $("#copy-body").addEventListener("click", () => copyText(
        $("#email-body").value,
        "本文をコピーしました。",
        $("#token-message")
    ));
    $("#copy-email").addEventListener("click", () => copyText(
        `件名：${$("#email-subject").value}\n\n${$("#email-body").value}`,
        "件名と本文をコピーしました。",
        $("#token-message")
    ));
    $("#sign-out").addEventListener("click", async () => {
        await supabase.auth.signOut();
        location.reload();
    });
}
