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
    schedule_adjusting: "日程調整中",
    needs_confirmation: "確認事項あり",
    declined: "見送り",
    schedule_confirmed: "日程確保完了",
    schedule_unavailable: "日程確保不可",
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
    schedule_adjusting: "reviewing",
    needs_confirmation: "hold",
    declined: "cancelled",
    schedule_confirmed: "confirmed",
    schedule_unavailable: "cancelled",
    on_hold: "hold",
    cancelled: "cancelled",
    closed: "closed"
};

const completedStatuses = new Set([
    "schedule_unavailable",
    "declined",
    "cancelled",
    "closed"
]);

const workflowSteps = [
    "PA予約・お問い合わせ内容確認",
    "日程調整が必要か判断",
    "日程確保フォーム専用URL発行",
    "お客様回答確認",
    "日程確保結果の確定・連絡",
    "見積作成",
    "見積送付・内容調整",
    "見積承認",
    "正式予約",
    "イベント準備",
    "イベント実施",
    "請求",
    "入金確認",
    "ケースクローズ"
];

const progressGroups = [
    { id: "schedule", label: "日程確認・調整中", steps: [1, 2, 3, 4, 5] },
    { id: "estimate", label: "見積対応中", steps: [6, 7, 8] },
    { id: "booking", label: "正式予約・準備中", steps: [9, 10] },
    { id: "event", label: "イベント実施待ち", steps: [11] },
    { id: "payment", label: "請求・入金待ち", steps: [12, 13] },
    { id: "hold", label: "保留中", steps: [] }
];

const closeReasonLabels = {
    payment_received: "入金完了",
    schedule_unavailable: "日程確保不可",
    declined: "見送り",
    cancelled: "取消",
    other_closed: "その他対応終了"
};

const paymentMethodLabels = {
    bank_transfer: "銀行振込",
    cash: "現金",
    other: "その他"
};

const initialWorkflowStep = (status) => ({
    new: 1,
    reviewing: 2,
    second_form_not_issued: 3,
    schedule_unconfirmed: 3,
    second_form_issued: 4,
    customer_responded: 5,
    schedule_adjusting: 5,
    needs_confirmation: 5,
    schedule_confirmed: 6,
    schedule_unavailable: 14,
    declined: 14,
    cancelled: 14,
    closed: 14,
    on_hold: 2
}[status] || 1);

const progressForCase = (item) => item?.progress || {
    current_step: initialWorkflowStep(item?.status),
    is_on_hold: item?.status === "on_hold",
    close_reason: completedStatuses.has(item?.status)
        ? ({
            schedule_unavailable: "schedule_unavailable",
            declined: "declined",
            cancelled: "cancelled",
            closed: "other_closed"
        }[item.status])
        : null,
    closed_from_step: completedStatuses.has(item?.status) ? 1 : null,
    closed_at: completedStatuses.has(item?.status) ? item?.updated_at : null
};

const isCompletedStatus = (status, progress = null) =>
    Boolean(progress?.closed_at) || completedStatuses.has(status);

const isClosedCase = (item) =>
    isCompletedStatus(item?.status, progressForCase(item));

const inquirySequenceNumber = (inquiryNumber) => {
    const match = String(inquiryNumber || "").match(/(\d+)$/);
    return match ? Number.parseInt(match[1], 10) : -1;
};

const receivedTimestamp = (value) => {
    const timestamp = new Date(value).getTime();
    return Number.isFinite(timestamp) ? timestamp : 0;
};

const newestTimestampValue = (...values) => {
    const valid = values
        .filter(Boolean)
        .map((value) => ({ value, timestamp: receivedTimestamp(value) }))
        .filter((item) => item.timestamp > 0)
        .sort((a, b) => b.timestamp - a.timestamp);
    return valid[0]?.value || null;
};

const compareCasesForList = (a, b) => {
    const receivedDifference = receivedTimestamp(b.received_at) - receivedTimestamp(a.received_at);
    if (receivedDifference !== 0) return receivedDifference;

    const sequenceDifference = inquirySequenceNumber(b.inquiry_number) - inquirySequenceNumber(a.inquiry_number);
    if (sequenceDifference !== 0) return sequenceDifference;

    return String(b.inquiry_number || "").localeCompare(
        String(a.inquiry_number || ""),
        "ja",
        { numeric: true }
    );
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
    schedule_confirmed_after_customer_notice: "確定連絡後に日程確保完了",
    schedule_result_confirmed_after_mail: "結果メール送信後に日程確保済み",
    schedule_result_unavailable_after_mail: "結果メール送信後に日程確保不可",
    case_progress_updated: "案件進捗を更新",
    payment_confirmed_and_closed: "入金確認後にケースクローズ"
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
const workflowStatePanel = $("#workflow-state-panel");
const resultActionPanel = $("#result-action-panel");
const resultEmailSection = $("#result-email-section");
const progressManagementSection = $("#progress-management-section");
const progressForm = $("#progress-form");
const paymentSection = $("#payment-section");
const paymentForm = $("#payment-form");

let supabase;
let cases = [];
let currentCase = null;
let currentProgress = null;
let currentPayments = [];
let currentToken = null;
let currentResponse = null;
let currentDeliveries = [];
let currentSessionUser = null;
let activeCaseTab = "active";
let activeProgressFilter = "";
let pendingPaymentConfirmation = null;
let issuedRawToken = "";
let emailOperationKey = "";
let mailActionInProgress = false;
let requestedCaseHandled = false;

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

const formatAmount = (value) => {
    if (value === null || value === undefined || value === "") return "未設定";
    const amount = Number(value);
    if (!Number.isFinite(amount)) return "未設定";
    return `${new Intl.NumberFormat("ja-JP", {
        minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
        maximumFractionDigits: 2
    }).format(amount)}円`;
};

const amountOrNull = (selector) => {
    const value = $(selector).value.trim();
    if (!value) return null;
    const amount = Number(value);
    return Number.isFinite(amount) ? amount : null;
};

const workflowStepForCase = (item) => {
    const step = Number(progressForCase(item).current_step);
    return Number.isInteger(step) && step >= 1 && step <= 14
        ? step
        : initialWorkflowStep(item?.status);
};

const eventYearForCase = (item) => {
    const progress = progressForCase(item);
    const candidate = progress.confirmed_event_date || item?.event_date || item?.received_at;
    const match = String(candidate || "").match(/^(\d{4})/);
    return match ? Number(match[1]) : new Date(item?.received_at || Date.now()).getFullYear();
};

const progressGroupForCase = (item) => {
    if (item?.status === "on_hold" || progressForCase(item).is_on_hold) return "hold";
    const step = workflowStepForCase(item);
    return progressGroups.find((group) => group.steps.includes(step))?.id || "";
};

const workflowStepLabel = (item) => {
    if (isClosedCase(item)) {
        const reason = closeReasonLabels[progressForCase(item).close_reason] || "対応終了";
        return `ケースクローズ（${reason}）`;
    }
    const step = workflowStepForCase(item);
    if (item?.status === "on_hold" || progressForCase(item).is_on_hold) {
        return `${workflowSteps[step - 1]}（保留中）`;
    }
    if (step === 4) return `${workflowSteps[3]}（回答待ち）`;
    return workflowSteps[step - 1] || "案件内容を確認";
};

const mailTypeLabels = {
    internal_new_inquiry: "ARA-TECH向け新規受付通知",
    customer_receipt: "お客様向け受付確認",
    schedule_request: "日程確保フォーム案内",
    schedule_response_agree_customer: "お客様向け日程調整依頼受付",
    schedule_response_agree_internal: "ARA-TECH向け日程調整依頼通知",
    schedule_response_question_customer: "お客様向け質問受付",
    schedule_response_question_internal: "ARA-TECH向け質問通知",
    schedule_response_decline_customer: "お客様向け見送り受付",
    schedule_response_decline_internal: "ARA-TECH向け見送り通知",
    schedule_result_confirmed: "日程確保済み結果",
    schedule_result_unavailable: "日程確保不可結果"
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
    const caseWithProgress = { ...currentCase, progress: currentProgress };
    if (isClosedCase(caseWithProgress)) return workflowStepLabel(caseWithProgress);
    if (workflowStepForCase(caseWithProgress) >= 6) return workflowStepLabel(caseWithProgress);
    if (currentResponse?.decision === "agree") return "日程確保の可否を判断して結果メールを送信";
    if (currentResponse?.decision === "question") return "質問内容を確認してお客様へ回答";
    if (currentResponse?.decision === "decline") return "見送り回答を確認";
    const scheduleMail = currentDeliveries.find(
        (delivery) => delivery.message_type === "schedule_request" && delivery.status === "sent"
    );
    if (scheduleMail) return "お客様の回答を待つ";
    if (currentToken) return "日程確保フォームの案内メールを送信";
    return "内容を確認し、日程調整の要否を判断";
};

const renderOverview = () => {
    const caseWithProgress = currentCase ? { ...currentCase, progress: currentProgress } : null;
    $("#overview-number").textContent = currentCase?.inquiry_number || "保存時に発行";
    $("#overview-date").textContent = formatDate(currentProgress?.confirmed_event_date || currentCase?.event_date);
    $("#overview-contact").textContent = currentCase?.contact_name || currentCase?.customer_name || "未設定";
    $("#overview-venue").textContent = currentCase?.venue || "未設定";
    $("#overview-status").textContent = currentCase
        ? `${statusLabels[currentCase.status] || currentCase.status} ／ 工程${workflowStepForCase(caseWithProgress)}`
        : "未保存";
    $("#overview-next-action").textContent = nextActionText();
    if (currentCase) {
        renderProgressSteps();
        renderNextActions();
    }
};

const renderProgressSteps = () => {
    const list = $("#case-progress-steps");
    list.replaceChildren();
    if (!currentCase) return;

    const item = { ...currentCase, progress: currentProgress };
    const progress = progressForCase(item);
    const currentStep = workflowStepForCase(item);
    const closed = isClosedCase(item);
    const closedFromStep = Number(progress.closed_from_step) || Math.min(currentStep, 13);

    workflowSteps.forEach((label, index) => {
        const step = index + 1;
        let state = "future";
        let stateLabel = "今後の工程";

        if (closed) {
            if (step <= closedFromStep || step === 14) {
                state = "completed";
                stateLabel = step === 14
                    ? `完了：${closeReasonLabels[progress.close_reason] || "対応終了"}`
                    : "完了";
            } else {
                state = "skipped";
                stateLabel = "未実施（途中終了）";
            }
        } else if (step < currentStep) {
            state = "completed";
            stateLabel = "完了";
        } else if (step === currentStep) {
            state = "current";
            stateLabel = progress.is_on_hold || currentCase.status === "on_hold"
                ? "保留中"
                : step === 4 ? "回答待ち" : "次に対応";
        }

        const listItem = document.createElement("li");
        listItem.className = `workflow-step workflow-step--${state}`;
        listItem.setAttribute("aria-label", `工程${step} ${label}：${stateLabel}`);

        const number = document.createElement("span");
        number.className = "workflow-step__number";
        number.textContent = state === "completed" ? "✓" : String(step);
        number.setAttribute("aria-hidden", "true");

        const content = document.createElement("span");
        content.className = "workflow-step__content";
        const title = document.createElement("strong");
        title.textContent = label;
        const status = document.createElement("span");
        status.className = "workflow-step__status";
        status.textContent = stateLabel;
        content.append(title, status);
        listItem.append(number, content);
        list.append(listItem);
    });
};

const setWorkflowState = (title, description, question = "") => {
    $("#workflow-state-title").textContent = title;
    $("#workflow-state-description").textContent = description;
    const questionElement = $("#workflow-question");
    questionElement.textContent = question;
    questionElement.classList.toggle("hidden", !question);
};

const renderNextActions = () => {
    if (!currentCase) return;
    nextActionSection.classList.remove("hidden");
    workflowStatePanel.classList.remove("hidden");
    resultActionPanel.classList.add("hidden");
    resultEmailSection.classList.add("hidden");
    tokenSection.classList.add("hidden");
    emailSection.classList.toggle("hidden", !issuedRawToken);
    $("#issue-token").hidden = false;
    $("#revoke-token").hidden = false;

    const caseWithProgress = { ...currentCase, progress: currentProgress };
    if (isClosedCase(caseWithProgress)) {
        setWorkflowState(
            workflowStepLabel(caseWithProgress),
            "この案件はケースクローズ済みです。進捗、入金記録、メール、回答、URL発行、操作の各履歴を確認できます。"
        );
        emailSection.classList.add("hidden");
        return;
    }

    if (currentCase.status === "schedule_confirmed") {
        setWorkflowState(
            workflowStepLabel({ ...currentCase, progress: currentProgress }),
            "日程確保済みです。同じ案件で見積り以降の進捗を更新してください。"
        );
        emailSection.classList.add("hidden");
        return;
    }

    if (currentResponse?.decision === "agree") {
        setWorkflowState(
            "日程調整中",
            "回答内容を確認し、日程を確保できるか判断してください。結果メールの送信成功後にだけ案件状態が更新されます。"
        );
        resultActionPanel.classList.remove("hidden");
        if ($("#result-email-kind").value) resultEmailSection.classList.remove("hidden");
        emailSection.classList.add("hidden");
        return;
    }

    if (currentResponse?.decision === "question") {
        setWorkflowState(
            "確認事項あり",
            "お客様からの質問を確認し、メール返信などで回答してください。",
            currentResponse.question_details || "質問内容が入力されていません。"
        );
        emailSection.classList.add("hidden");
        return;
    }

    if (currentResponse?.decision === "decline") {
        setWorkflowState(
            "見送り",
            "お客様は日程調整を依頼しないと回答しました。URL発行や日程確保結果の操作は不要です。"
        );
        emailSection.classList.add("hidden");
        return;
    }

    const activeToken = currentToken
        && !currentToken.answered_at
        && !currentToken.revoked_at
        && new Date(currentToken.expires_at).getTime() > Date.now();
    if (activeToken) {
        const scheduleMail = currentDeliveries.find(
            (delivery) => delivery.message_type === "schedule_request" && delivery.status === "sent"
        );
        setWorkflowState(
            scheduleMail ? "お客様の回答待ち" : "日程確保フォームの案内メールを送信",
            scheduleMail
                ? "URLの再送・無効化・再発行は、下の補助操作から必要な場合だけ実行してください。"
                : "発行した専用URLを含む案内メールを確認し、お客様へ送信してください。"
        );
        tokenSection.classList.remove("hidden");
        $("#issue-token").textContent = "日程確保フォームURLを再発行";
        return;
    }

    setWorkflowState(
        "日程確保フォーム専用URLを発行",
        "日程調整が必要な場合は、公開情報と条件を確認して専用URLを発行し、お客様へ案内メールを送信してください。"
    );
    tokenSection.classList.remove("hidden");
    $("#issue-token").textContent = "日程確保フォームURLを発行";
    $("#revoke-token").hidden = true;
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

const renderCaseTabs = () => {
    const tabList = $("#case-tabs");
    tabList.replaceChildren();

    const activeCount = cases.filter((item) => !isClosedCase(item)).length;
    const years = [...new Set(
        cases
            .filter(isClosedCase)
            .map(eventYearForCase)
            .filter(Number.isFinite)
    )].sort((a, b) => b - a);
    const availableTabs = new Set(["active", ...years.map((year) => `year-${year}`)]);
    if (!availableTabs.has(activeCaseTab)) activeCaseTab = "active";

    const tabs = [
        { id: "active", label: "進行中", count: activeCount },
        ...years.map((year) => ({
            id: `year-${year}`,
            label: `${year}年`,
            count: cases.filter((item) => isClosedCase(item) && eventYearForCase(item) === year).length
        }))
    ];

    tabs.forEach((tab) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "case-tab";
        button.role = "tab";
        button.dataset.caseTab = tab.id;
        button.setAttribute("aria-selected", String(activeCaseTab === tab.id));
        button.textContent = `${tab.label}（${tab.count}件）`;
        button.addEventListener("click", () => {
            activeCaseTab = tab.id;
            activeProgressFilter = "";
            renderCaseTabs();
            renderProgressSummary();
            renderCases();
        });
        tabList.append(button);
    });
};

const renderProgressSummary = () => {
    const section = $("#progress-summary-section");
    const summary = $("#progress-summary");
    const clearButton = $("#clear-progress-filter");
    const activeCases = cases.filter((item) => !isClosedCase(item));
    const show = activeCaseTab === "active";
    section.classList.toggle("hidden", !show);
    summary.replaceChildren();
    clearButton.classList.toggle("hidden", !activeProgressFilter);
    if (!show) return;

    progressGroups.forEach((group) => {
        const count = activeCases.filter((item) => progressGroupForCase(item) === group.id).length;
        const button = document.createElement("button");
        button.type = "button";
        button.className = "progress-summary__item";
        button.dataset.progressGroup = group.id;
        button.setAttribute("aria-pressed", String(activeProgressFilter === group.id));
        const label = document.createElement("span");
        label.textContent = group.label;
        const value = document.createElement("strong");
        value.textContent = `${count}件`;
        button.append(label, value);
        button.addEventListener("click", () => {
            activeProgressFilter = activeProgressFilter === group.id ? "" : group.id;
            renderProgressSummary();
            renderCases();
        });
        summary.append(button);
    });
};

const filteredCases = () => {
    const query = $("#case-search").value.trim().toLocaleLowerCase("ja");
    const status = $("#case-status-filter").value;
    const result = cases.filter((item) => {
        if (activeCaseTab === "active" && isClosedCase(item)) return false;
        if (activeCaseTab.startsWith("year-")) {
            const year = Number(activeCaseTab.replace("year-", ""));
            if (!isClosedCase(item) || eventYearForCase(item) !== year) return false;
        }
        if (activeProgressFilter && progressGroupForCase(item) !== activeProgressFilter) return false;
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

    result.sort(compareCasesForList);

    return result;
};

const renderCases = () => {
    caseList.replaceChildren();
    const visibleCases = filteredCases();
    emptyCases.classList.toggle("hidden", visibleCases.length > 0);

    visibleCases.forEach((item) => {
        const row = document.createElement("tr");
        const progress = progressForCase(item);
        const isCompleted = isCompletedStatus(item.status, progress);
        row.classList.toggle("case-row--completed", isCompleted);
        row.dataset.completionState = isCompleted ? "completed" : "active";
        row.dataset.workflowStep = String(workflowStepForCase(item));

        const numberCell = document.createElement("td");
        const caseReference = document.createElement("div");
        caseReference.className = "case-reference";
        const openButton = document.createElement("button");
        openButton.className = "case-link";
        openButton.type = "button";
        openButton.textContent = item.inquiry_number;
        openButton.addEventListener("click", () => openCase(item.id));
        caseReference.append(openButton);
        if (isCompleted) {
            const completedStamp = document.createElement("span");
            completedStamp.className = "completed-stamp";
            completedStamp.textContent = "済";
            completedStamp.setAttribute("aria-label", "ケースクローズ済み");
            completedStamp.title = `ケースクローズ済み：${closeReasonLabels[progress.close_reason] || "対応終了"}`;
            caseReference.append(completedStamp);
        }
        numberCell.append(caseReference);

        const receivedCell = document.createElement("td");
        receivedCell.textContent = formatDateTime(item.received_at);

        const customerCell = document.createElement("td");
        customerCell.append(textBlock(
            item.organization_name || item.customer_name,
            item.organization_name ? `${item.customer_name} ／ ${item.event_name || "イベント名未設定"}` : item.event_name
        ));

        const eventCell = document.createElement("td");
        eventCell.append(textBlock(
            formatDate(progress.confirmed_event_date || item.event_date),
            item.venue
        ));

        const stateCell = document.createElement("td");
        const stepBadge = document.createElement("span");
        stepBadge.className = `badge badge--stage${isCompleted ? " badge--closed" : ""}`;
        stepBadge.textContent = `工程${workflowStepForCase(item)} ${workflowStepLabel(item)}`;
        stateCell.append(stepBadge);
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
        updatedCell.textContent = formatDateTime(
            newestTimestampValue(item.updated_at, progress.updated_at, progress.closed_at)
        );

        row.append(numberCell, receivedCell, customerCell, eventCell, stateCell, formCell, updatedCell);
        caseList.append(row);
    });
};

const loadCases = async () => {
    clearMessage(listStatus);
    const [caseResult, progressResult] = await Promise.all([
        supabase
            .from("pa_inquiries")
            .select("*")
            .order("received_at", { ascending: false }),
        supabase
            .from("pa_case_progress")
            .select("*")
    ]);

    if (caseResult.error || progressResult.error) {
        setMessage(
            listStatus,
            "PA案件一覧を読み込めませんでした。進捗DBマイグレーションと権限設定をご確認ください。",
            "error"
        );
        return;
    }

    const progressByInquiry = new Map(
        (progressResult.data || []).map((progress) => [progress.inquiry_id, progress])
    );
    cases = (caseResult.data || []).map((item) => ({
        ...item,
        progress: progressByInquiry.get(item.id) || progressForCase(item)
    }));
    renderCaseTabs();
    renderProgressSummary();
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
    currentProgress = null;
    currentPayments = [];
    currentToken = null;
    currentResponse = null;
    currentDeliveries = [];
    issuedRawToken = "";
    emailOperationKey = "";
    $("#result-email-kind").value = "";
    tokenSection.classList.add("hidden");
    emailSection.classList.add("hidden");
    resultActionPanel.classList.add("hidden");
    resultEmailSection.classList.add("hidden");
    nextActionSection.classList.add("hidden");
    progressManagementSection.classList.add("hidden");
    paymentSection.classList.add("hidden");
    progressForm.reset();
    paymentForm.reset();
    $("#payment-history").replaceChildren();
    $("#payment-confirmation-panel").classList.add("hidden");
    $("#payment-mismatch-warning").classList.add("hidden");
    pendingPaymentConfirmation = null;
    automaticMailStatus.replaceChildren();
    emailHistory.replaceChildren();
    technicalDetails.replaceChildren();
    $("#response-state").textContent = "回答はまだありません。";
    responseDetails.replaceChildren();
    $("#schedule-state").textContent = "日程確保未確定";
    auditList.replaceChildren();
    clearMessage(caseStatusMessage);
    clearMessage($("#email-message"));
    clearMessage($("#result-email-message"));
    clearMessage($("#progress-message"));
    clearMessage($("#payment-message"));
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

const progressPayload = () => ({
    estimate_amount: amountOrNull("#estimate-amount"),
    estimate_created_on: $("#estimate-created-on").value || null,
    estimate_sent_on: $("#estimate-sent-on").value || null,
    estimate_adjusting: $("#estimate-adjusting").checked,
    estimate_approved_on: $("#estimate-approved-on").value || null,
    estimate_memo: valueOrNull("#estimate-memo"),
    booking_confirmed_on: $("#booking-confirmed-on").value || null,
    confirmed_event_date: $("#confirmed-event-date").value || null,
    event_preparing: $("#event-preparing").checked,
    event_preparation_completed_on: $("#event-preparation-completed-on").value || null,
    event_completed_on: $("#event-completed-on").value || null,
    event_memo: valueOrNull("#event-memo"),
    invoice_amount: amountOrNull("#invoice-amount"),
    invoice_issued_on: $("#invoice-issued-on").value || null,
    payment_due_on: $("#payment-due-on").value || null,
    invoice_sent: $("#invoice-sent").checked,
    invoice_memo: valueOrNull("#invoice-memo")
});

const progressValidationMessage = (payload) => {
    if (payload.estimate_sent_on && !payload.estimate_created_on) {
        return "見積作成日を入力してから見積送付日を登録してください。";
    }
    if (payload.estimate_approved_on && !payload.estimate_sent_on) {
        return "見積送付日を入力してから見積承認日を登録してください。";
    }
    if (payload.estimate_approved_on && payload.estimate_adjusting) {
        return "見積承認済みにする場合は「見積内容を調整中」のチェックを外してください。";
    }
    if (payload.booking_confirmed_on && !payload.estimate_approved_on) {
        return "見積承認日を入力してから正式予約確定日を登録してください。";
    }
    if (payload.booking_confirmed_on && !payload.confirmed_event_date) {
        return "正式予約確定日とイベント開催日を入力してください。";
    }
    if (payload.event_preparing && !payload.booking_confirmed_on) {
        return "正式予約確定日を入力してからイベント準備中へ進めてください。";
    }
    if (payload.event_preparation_completed_on && !payload.booking_confirmed_on) {
        return "正式予約確定日を入力してからイベント準備完了日を登録してください。";
    }
    if (payload.event_completed_on && !payload.event_preparation_completed_on) {
        return "イベント準備完了日を入力してからイベント実施日を登録してください。";
    }
    if (payload.invoice_sent && (
        !payload.event_completed_on
        || payload.invoice_amount === null
        || !payload.invoice_issued_on
        || !payload.payment_due_on
    )) {
        return "請求済みにするには、イベント実施日、請求金額、請求日、支払期限が必要です。";
    }
    return "";
};

const setFormDisabled = (form, disabled) => {
    form.querySelectorAll("input, select, textarea, button").forEach((control) => {
        control.disabled = disabled;
    });
};

const renderPaymentHistory = () => {
    const history = $("#payment-history");
    history.replaceChildren();
    if (!currentPayments.length) {
        const note = document.createElement("p");
        note.className = "small-note";
        note.textContent = "入金確認記録はありません。";
        history.append(note);
        return;
    }

    currentPayments.forEach((payment) => {
        const card = document.createElement("div");
        card.className = "payment-history__item";
        const title = document.createElement("strong");
        title.textContent = `入金確認済み：${formatAmount(payment.amount)}`;
        const meta = document.createElement("span");
        meta.textContent = `${formatDate(payment.payment_date)} ／ ${paymentMethodLabels[payment.payment_method] || payment.payment_method}`;
        const actor = document.createElement("span");
        actor.textContent = `確認者：${payment.confirmed_by_label} ／ 操作日時：${formatDateTime(payment.confirmed_at)}`;
        const source = document.createElement("span");
        source.textContent = payment.confirmation_source === "manual"
            ? "確認方法：手動確認"
            : "確認方法：自動照合";
        card.append(title, meta, actor, source);
        if (payment.confirmation_memo) {
            const memo = document.createElement("span");
            memo.textContent = `確認メモ：${payment.confirmation_memo}`;
            card.append(memo);
        }
        history.append(card);
    });
};

const resetPaymentConfirmation = () => {
    pendingPaymentConfirmation = null;
    $("#payment-confirmation-panel").classList.add("hidden");
    $("#payment-confirmation-details").replaceChildren();
    $("#confirm-payment-close").disabled = false;
};

const populateProgressManagement = () => {
    if (!currentCase || !currentProgress) {
        progressManagementSection.classList.add("hidden");
        paymentSection.classList.add("hidden");
        return;
    }

    const item = { ...currentCase, progress: currentProgress };
    const closed = isClosedCase(item);
    const canManageProgress = currentCase.status === "schedule_confirmed"
        || currentProgress.close_reason === "payment_received";
    progressManagementSection.classList.toggle("hidden", !canManageProgress);

    $("#estimate-amount").value = currentProgress.estimate_amount ?? "";
    $("#estimate-created-on").value = currentProgress.estimate_created_on || "";
    $("#estimate-sent-on").value = currentProgress.estimate_sent_on || "";
    $("#estimate-adjusting").checked = Boolean(currentProgress.estimate_adjusting);
    $("#estimate-approved-on").value = currentProgress.estimate_approved_on || "";
    $("#estimate-memo").value = currentProgress.estimate_memo || "";
    $("#booking-confirmed-on").value = currentProgress.booking_confirmed_on || "";
    $("#confirmed-event-date").value = currentProgress.confirmed_event_date || currentCase.event_date || "";
    $("#event-preparing").checked = Boolean(currentProgress.event_preparing);
    $("#event-preparation-completed-on").value = currentProgress.event_preparation_completed_on || "";
    $("#event-completed-on").value = currentProgress.event_completed_on || "";
    $("#event-memo").value = currentProgress.event_memo || "";
    $("#invoice-amount").value = currentProgress.invoice_amount ?? "";
    $("#invoice-issued-on").value = currentProgress.invoice_issued_on || "";
    $("#payment-due-on").value = currentProgress.payment_due_on || "";
    $("#invoice-sent").checked = Boolean(currentProgress.invoice_sent);
    $("#invoice-memo").value = currentProgress.invoice_memo || "";
    $("#progress-note").value = "";
    setFormDisabled(progressForm, closed);
    $("#save-progress").classList.toggle("hidden", closed);

    const paymentClosed = currentProgress.close_reason === "payment_received";
    const showPayment = currentPayments.length > 0
        || paymentClosed
        || (!closed && workflowStepForCase(item) === 13);
    paymentSection.classList.toggle("hidden", !showPayment);
    renderPaymentHistory();
    paymentForm.classList.toggle("hidden", currentPayments.length > 0 || paymentClosed);
    if (!showPayment || currentPayments.length > 0 || paymentClosed) return;

    paymentForm.reset();
    $("#payment-date").value = new Date().toISOString().slice(0, 10);
    $("#payment-amount").value = currentProgress.invoice_amount ?? "";
    $("#payment-method").value = "bank_transfer";
    $("#payment-confirmed-by").value = currentSessionUser?.email || "ログイン中の管理者";
    $("#payment-mismatch-warning").classList.add("hidden");
    clearMessage($("#payment-message"));
    resetPaymentConfirmation();
};

const saveProgress = async () => {
    if (!currentCase || !currentProgress) return;
    clearMessage($("#progress-message"));
    const payload = progressPayload();
    const validationMessage = progressValidationMessage(payload);
    if (validationMessage) {
        setMessage($("#progress-message"), validationMessage, "error");
        return;
    }

    $("#save-progress").disabled = true;
    const caseId = currentCase.id;
    const { error } = await supabase.rpc("update_pa_case_progress", {
        p_inquiry_id: caseId,
        p_progress: payload,
        p_note: valueOrNull("#progress-note")
    });
    $("#save-progress").disabled = false;

    if (error) {
        setMessage(
            $("#progress-message"),
            `案件進捗を保存できませんでした。案件状態は変更されていません。${error.message || ""}`,
            "error"
        );
        return;
    }

    await loadCases();
    await openCase(caseId);
    setMessage($("#progress-message"), "案件進捗を保存し、現在工程を更新しました。", "success");
};

const appendPaymentConfirmationDetail = (term, value) => {
    const dt = document.createElement("dt");
    const dd = document.createElement("dd");
    dt.textContent = term;
    dd.textContent = value || "未入力";
    $("#payment-confirmation-details").append(dt, dd);
};

const paymentInput = () => ({
    paymentDate: $("#payment-date").value,
    amount: amountOrNull("#payment-amount"),
    method: $("#payment-method").value,
    memo: valueOrNull("#payment-memo")
});

const amountsDiffer = (left, right) =>
    Math.round(Number(left || 0) * 100) !== Math.round(Number(right || 0) * 100);

const preparePaymentConfirmation = () => {
    clearMessage($("#payment-message"));
    resetPaymentConfirmation();
    if (!paymentForm.checkValidity()) {
        paymentForm.reportValidity();
        return;
    }

    const input = paymentInput();
    const mismatch = amountsDiffer(currentProgress?.invoice_amount, input.amount);
    $("#payment-mismatch-warning").classList.toggle("hidden", !mismatch);
    if (mismatch && !$("#payment-mismatch-confirmed").checked) {
        setMessage(
            $("#payment-message"),
            "請求額と入金額が異なります。差額確認のチェックを付けてから最終確認へ進んでください。",
            "warning"
        );
        return;
    }

    pendingPaymentConfirmation = {
        ...input,
        mismatchConfirmed: mismatch && $("#payment-mismatch-confirmed").checked
    };
    appendPaymentConfirmationDetail("受付番号", currentCase.inquiry_number);
    appendPaymentConfirmationDetail("請求額", formatAmount(currentProgress.invoice_amount));
    appendPaymentConfirmationDetail("入金日", formatDate(input.paymentDate));
    appendPaymentConfirmationDetail("入金額", formatAmount(input.amount));
    appendPaymentConfirmationDetail("支払方法", paymentMethodLabels[input.method] || input.method);
    appendPaymentConfirmationDetail("確認者", currentSessionUser?.email || "ログイン中の管理者");
    appendPaymentConfirmationDetail("確認メモ", input.memo);
    $("#payment-confirmation-panel").classList.remove("hidden");
    $("#payment-confirmation-panel").scrollIntoView({ behavior: "smooth", block: "nearest" });
};

const confirmPaymentClose = async () => {
    if (!pendingPaymentConfirmation || !currentCase || !currentProgress) return;
    clearMessage($("#payment-message"));
    const caseId = currentCase.id;
    const year = eventYearForCase({ ...currentCase, progress: currentProgress });
    $("#confirm-payment-close").disabled = true;

    const { error } = await supabase.rpc("confirm_pa_payment_and_close", {
        p_inquiry_id: caseId,
        p_payment_date: pendingPaymentConfirmation.paymentDate,
        p_amount: pendingPaymentConfirmation.amount,
        p_payment_method: pendingPaymentConfirmation.method,
        p_confirmation_memo: pendingPaymentConfirmation.memo,
        p_mismatch_confirmed: pendingPaymentConfirmation.mismatchConfirmed
    });

    if (error) {
        $("#confirm-payment-close").disabled = false;
        setMessage(
            $("#payment-message"),
            `入金確認を保存できませんでした。案件はクローズされていません。${error.message || ""}`,
            "error"
        );
        return;
    }

    activeCaseTab = `year-${year}`;
    activeProgressFilter = "";
    pendingPaymentConfirmation = null;
    await loadCases();
    await openCase(caseId);
    setMessage(
        $("#payment-message"),
        "入金確認を保存し、案件をケースクローズしました。開催年のタブへ移動しました。",
        "success"
    );
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
    const types = [
        ["customer_receipt", "お客様向け受付確認"],
        ["internal_new_inquiry", "ARA-TECH向け新規受付通知"]
    ];
    if (currentResponse?.decision) {
        types.push(
            [`schedule_response_${currentResponse.decision}_customer`, "お客様向け回答受付通知"],
            [`schedule_response_${currentResponse.decision}_internal`, "ARA-TECH向け回答通知"]
        );
    }
    types.forEach(([type, label]) => {
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
        ["日程確保フォーム回答日時", formatDateTime(currentCase.second_form_answered_at)],
        ["日程確保結果", currentCase.schedule_result_kind || "未確定"],
        ["日程確保結果メール送信日時", formatDateTime(currentCase.schedule_result_sent_at)],
        ["現在工程", currentProgress
            ? `工程${currentProgress.current_step} ${workflowStepLabel({ ...currentCase, progress: currentProgress })}`
            : "未設定"],
        ["保留", currentProgress?.is_on_hold ? "保留中" : "いいえ"],
        ["ケースクローズ理由", currentProgress?.close_reason
            ? closeReasonLabels[currentProgress.close_reason] || currentProgress.close_reason
            : "未クローズ"],
        ["ケースクローズ日時", formatDateTime(currentProgress?.closed_at)],
        ["案件進捗更新日時", formatDateTime(currentProgress?.updated_at)]
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
        ...entries.map((entry) => {
            const details = entry.details && typeof entry.details === "object" ? entry.details : {};
            const supplements = [];
            if (Number.isInteger(details.step_before) && Number.isInteger(details.step_after)) {
                supplements.push(`工程${details.step_before}→${details.step_after}`);
            }
            if (details.note || details.memo) supplements.push(`メモ：${details.note || details.memo}`);
            if (details.operator_label) supplements.push(`操作者：${details.operator_label}`);
            else if (entry.actor_user_id) supplements.push(`操作者ID：${entry.actor_user_id}`);
            return {
                occurred_at: entry.occurred_at,
                label: `${auditLabels[entry.action] || entry.action}${supplements.length ? ` ／ ${supplements.join(" ／ ")}` : ""}`
            };
        }),
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
    if (currentCase?.schedule_state === "completed") {
        $("#schedule-state").textContent = `日程確保済み（結果メール送信：${formatDateTime(currentCase.schedule_result_sent_at || currentCase.customer_confirmation_sent_at)}）`;
        return;
    }
    if (currentCase?.schedule_state === "unavailable") {
        $("#schedule-state").textContent = `日程確保不可（結果メール送信：${formatDateTime(currentCase.schedule_result_sent_at)}）`;
        return;
    }
    $("#schedule-state").textContent = currentCase?.status === "schedule_adjusting"
        ? "日程調整中"
        : "日程未確定";
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

    const [
        tokenResult,
        responseResult,
        auditResult,
        deliveryResult,
        progressResult,
        paymentResult
    ] = await Promise.all([
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
            .select("occurred_at, actor_user_id, action, details")
            .eq("inquiry_id", id)
            .order("occurred_at", { ascending: false })
            .limit(50),
        supabase
            .from("pa_email_deliveries")
            .select("id, message_type, recipient, subject, status, requested_at, sent_at, failed_at, gmail_message_id, error_summary, is_retry, attempt_number")
            .eq("inquiry_id", id)
            .order("requested_at", { ascending: false })
            .limit(100),
        supabase
            .from("pa_case_progress")
            .select("*")
            .eq("inquiry_id", id)
            .single(),
        supabase
            .from("pa_payment_records")
            .select("*")
            .eq("inquiry_id", id)
            .order("confirmed_at", { ascending: false })
    ]);

    const relatedError = [
        tokenResult.error,
        responseResult.error,
        auditResult.error,
        deliveryResult.error,
        progressResult.error,
        paymentResult.error
    ].find(Boolean);
    if (relatedError) {
        setMessage(
            listStatus,
            `案件の関連情報を読み込めませんでした。DBマイグレーションと権限設定をご確認ください。${relatedError.message || ""}`,
            "error"
        );
        return;
    }

    currentCase = item;
    currentProgress = progressResult.data;
    currentPayments = paymentResult.data || [];
    currentToken = tokenResult.data || null;
    currentResponse = responseResult.data || null;
    currentDeliveries = deliveryResult.data || [];
    issuedRawToken = "";
    emailOperationKey = "";
    $("#result-email-kind").value = "";
    resultEmailSection.classList.add("hidden");
    clearMessage($("#result-email-message"));
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
    const pageUrl = new URL(window.location.href);
    pageUrl.searchParams.set("case", currentCase.id);
    history.replaceState(null, "", pageUrl);
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
    if (completedStatuses.has(currentCase.status)) {
        activeCaseTab = `year-${eventYearForCase({ ...currentCase, progress: currentProgress })}`;
        activeProgressFilter = "";
    }
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
    $("#send-result-email").disabled = disabled;
    $("#prepare-result-confirmed").disabled = disabled;
    $("#prepare-result-unavailable").disabled = disabled;
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
            if (result.case_state) {
                applyCaseState(result.case_state);
                setMessage(
                    $("#schedule-message"),
                    result.case_state.result_status === "schedule_confirmed"
                        ? "結果メールの再送に成功し、案件状態を「日程確保済み」へ更新しました。"
                        : "結果メールの再送に成功し、案件状態を「日程確保不可」へ更新しました。",
                    "success"
                );
            }
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

const resultEmailTemplate = (result) => {
    const addressee = currentCase.public_addressee || currentCase.contact_name || currentCase.customer_name;
    const summary = [
        `受付番号：${currentCase.inquiry_number}`,
        `開催希望日：${formatDate(currentCase.public_event_date || currentCase.event_date)}`,
        `会場・開催場所：${currentCase.public_venue || currentCase.venue || "未設定"}`
    ];
    if (result === "confirmed") {
        return {
            title: "日程を確保できました",
            subject: `【ARA-TECH】ご希望日の対応日程を確保しました／受付番号${currentCase.inquiry_number}`,
            body: [
                `${addressee} 様`,
                "",
                "ご希望日の対応日程を確保しました。",
                ...summary,
                "",
                "今後、イベント詳細やお見積りについて、ARA-TECHから改めてご連絡いたします。",
                "現段階では、見積承認、契約成立、正式予約完了ではありません。",
                "",
                "ご不明点がございましたら、このメールへご返信ください。",
                ""
            ].join("\n")
        };
    }
    return {
        title: "日程を確保できませんでした",
        subject: `【ARA-TECH】ご希望日の対応日程について／受付番号${currentCase.inquiry_number}`,
        body: [
            `${addressee} 様`,
            "",
            "既存予定の日程調整を行いましたが、ご希望日の対応日程を確保できませんでした。",
            ...summary,
            "",
            "恐れ入りますが、上記の開催希望日では受付できません。",
            "必要に応じて、別日程についてご相談いただけます。",
            "",
            "ご希望がございましたら、このメールへご返信ください。",
            ""
        ].join("\n")
    };
};

const resetResultEmailConfirmation = () => {
    const button = $("#send-result-email");
    delete button.dataset.confirmationKey;
    button.textContent = "この内容でGmail送信";
};

const prepareResultEmail = (result) => {
    if (!currentCase || currentResponse?.decision !== "agree" || currentCase.status !== "schedule_adjusting") return;
    const template = resultEmailTemplate(result);
    $("#result-email-title").textContent = template.title;
    $("#result-email-kind").value = result;
    $("#result-email-recipient").value = currentCase.email || "";
    $("#result-email-subject").value = template.subject;
    $("#result-email-body").value = template.body;
    clearMessage($("#result-email-message"));
    resetResultEmailConfirmation();
    resultEmailSection.classList.remove("hidden");
    resultEmailSection.scrollIntoView({ behavior: "smooth", block: "start" });
    $("#result-email-subject").focus({ preventScroll: true });
};

const applyCaseState = (caseState) => {
    if (!caseState || !currentCase) return;
    currentCase.status = caseState.result_status;
    currentCase.schedule_state = caseState.result_schedule_state;
    currentCase.schedule_result_sent_at = caseState.result_at;
    currentCase.schedule_result_kind = caseState.result_status === "schedule_confirmed"
        ? "confirmed"
        : "unavailable";
    if (currentCase.schedule_state === "completed") {
        currentCase.schedule_confirmed_at = caseState.result_at;
        currentCase.customer_confirmation_sent_at = caseState.result_at;
    }
    if (currentProgress) {
        currentProgress.current_step = currentCase.status === "schedule_confirmed" ? 6 : 14;
        currentProgress.close_reason = currentCase.status === "schedule_unavailable"
            ? "schedule_unavailable"
            : null;
        currentProgress.closed_from_step = currentCase.status === "schedule_unavailable" ? 5 : null;
        currentProgress.closed_at = currentCase.status === "schedule_unavailable"
            ? caseState.result_at
            : null;
    }
    $("#case-status").value = currentCase.status;
    $("#result-email-kind").value = "";
    resultEmailSection.classList.add("hidden");
    renderScheduleState();
    renderOverview();
    populateProgressManagement();
};

const sendResultEmail = async () => {
    if (!currentCase || mailActionInProgress) return;
    const result = $("#result-email-kind").value;
    const subject = $("#result-email-subject").value.trim();
    const body = $("#result-email-body").value.trim();
    if (!["confirmed", "unavailable"].includes(result) || !subject || !body) {
        setMessage($("#result-email-message"), "件名と本文を確認してください。", "error");
        return;
    }

    const confirmationKey = JSON.stringify([currentCase.id, currentCase.email, result, subject, body]);
    const sendButton = $("#send-result-email");
    if (sendButton.dataset.confirmationKey !== confirmationKey) {
        sendButton.dataset.confirmationKey = confirmationKey;
        sendButton.textContent = "この宛先へ結果メール送信を確定";
        setMessage(
            $("#result-email-message"),
            `${currentCase.email} へ結果メールを送信します。宛先と内容を再確認し、もう一度ボタンを押してください。`,
            "warning"
        );
        return;
    }
    resetResultEmailConfirmation();

    mailActionInProgress = true;
    setMailButtonsDisabled(true);
    clearMessage($("#result-email-message"));
    clearMessage($("#schedule-message"));
    try {
        const apiResult = await callMailApi({
            action: "send_result",
            inquiry_id: currentCase.id,
            result,
            subject,
            body
        });
        recordDeliveryResult(apiResult.delivery);
        if (apiResult.delivery.status === "sent" && apiResult.case_state) {
            applyCaseState(apiResult.case_state);
            setMessage(
                $("#schedule-message"),
                result === "confirmed"
                    ? "結果メールをGmailから送信し、案件状態を「日程確保済み」へ更新しました。"
                    : "結果メールをGmailから送信し、案件状態を「日程確保不可」へ更新しました。",
                "success"
            );
            if (result === "unavailable") {
                activeCaseTab = `year-${eventYearForCase({ ...currentCase, progress: currentProgress })}`;
                activeProgressFilter = "";
            }
            await loadCases();
            await openCase(currentCase.id);
        } else {
            setMessage($("#result-email-message"), mailErrorMessage(apiResult.delivery.error_summary), "error");
        }
    } catch (error) {
        setMessage($("#result-email-message"), mailErrorMessage(error.message), "error");
    } finally {
        mailActionInProgress = false;
        resetResultEmailConfirmation();
        setMailButtonsDisabled(false);
    }
};

const openRequestedCase = async () => {
    if (requestedCaseHandled) return;
    requestedCaseHandled = true;
    const inquiryId = new URL(window.location.href).searchParams.get("case") || "";
    if (!inquiryId) return;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(inquiryId)) {
        setMessage(listStatus, "指定された案件リンクは無効です。案件一覧から選択してください。", "error");
        return;
    }
    await openCase(inquiryId);
};

const showDashboard = async (user) => {
    currentSessionUser = user;
    loginPanel.classList.add("hidden");
    dashboard.classList.remove("hidden");
    $("#session-email").textContent = user.email || "";
    await loadCases();
    await openRequestedCase();
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
    $("#clear-progress-filter").addEventListener("click", () => {
        activeProgressFilter = "";
        renderProgressSummary();
        renderCases();
    });
    $("#close-detail").addEventListener("click", () => detailCard.classList.add("hidden"));
    $("#cancel-case-edit").addEventListener("click", () => detailCard.classList.add("hidden"));

    caseForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        await saveCase();
    });
    progressForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        await saveProgress();
    });
    paymentForm.addEventListener("submit", (event) => {
        event.preventDefault();
        preparePaymentConfirmation();
    });
    $("#confirm-payment-close").addEventListener("click", confirmPaymentClose);
    $("#cancel-payment-close").addEventListener("click", resetPaymentConfirmation);
    paymentForm.querySelectorAll("input, select, textarea").forEach((control) => {
        control.addEventListener("input", resetPaymentConfirmation);
        control.addEventListener("change", resetPaymentConfirmation);
    });

    $("#issue-token").addEventListener("click", issueToken);
    $("#revoke-token").addEventListener("click", revokeToken);
    $("#send-email").addEventListener("click", sendEmail);
    $("#prepare-result-confirmed").addEventListener("click", () => prepareResultEmail("confirmed"));
    $("#prepare-result-unavailable").addEventListener("click", () => prepareResultEmail("unavailable"));
    $("#send-result-email").addEventListener("click", sendResultEmail);
    $("#cancel-result-email").addEventListener("click", () => {
        $("#result-email-kind").value = "";
        resultEmailSection.classList.add("hidden");
        clearMessage($("#result-email-message"));
        resetResultEmailConfirmation();
    });
    $("#sign-out").addEventListener("click", async () => {
        await supabase.auth.signOut();
        location.reload();
    });
}
