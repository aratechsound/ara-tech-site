import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { SUPABASE_ANON_KEY, SUPABASE_URL, isSupabaseConfigured } from "./supabase-config.js";

const $ = (selector) => document.querySelector(selector);

const statusLabels = {
    new: "新規問い合わせ（既存）",
    new_inquiry: "新規問い合わせ",
    follow_up_pending: "担当者フォロー待ち",
    waiting_customer_reply: "内容確認・ヒアリングメール送信済み／お客様回答待ち",
    hearing: "ヒアリング中",
    rough_estimate: "概算見積中",
    customer_intent_confirmed: "お客様の依頼意思確認済み",
    schedule_coordination: "日程・人員調整中",
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
    new_inquiry: "new",
    follow_up_pending: "reviewing",
    waiting_customer_reply: "answered",
    hearing: "reviewing",
    rough_estimate: "reviewing",
    customer_intent_confirmed: "reviewing",
    schedule_coordination: "reviewing",
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
    "問い合わせ受付",
    "ヒアリング",
    "概算提示",
    "依頼意思確認",
    "日程・人員調整",
    "正式見積",
    "発注確認",
    "予約確定",
    "事前準備・打合せ",
    "最終確認",
    "本番実施",
    "請求",
    "入金確認",
    "完了"
];

const workflowPhases = [
    { id: "sales", label: "商談", steps: [1, 2, 3, 4] },
    { id: "order", label: "受注", steps: [5, 6, 7, 8] },
    { id: "preparation", label: "準備", steps: [9, 10] },
    { id: "delivery", label: "実施", steps: [11] },
    { id: "settlement", label: "精算", steps: [12, 13, 14] }
];

const contentHearingPendingStatuses = new Set(["new", "new_inquiry", "follow_up_pending"]);
const scheduleEligibleStatuses = new Set([
    "schedule_coordination",
    "second_form_not_issued",
    "second_form_issued",
    "schedule_unconfirmed",
    "customer_responded",
    "schedule_adjusting",
    "needs_confirmation"
]);

const progressGroups = [
    { id: "sales", label: "商談中", steps: [1, 2, 3, 4] },
    { id: "order", label: "受注対応中", steps: [5, 6, 7, 8] },
    { id: "preparation", label: "準備中", steps: [9, 10] },
    { id: "delivery", label: "本番実施待ち", steps: [11] },
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
    new_inquiry: 1,
    follow_up_pending: 1,
    waiting_customer_reply: 2,
    hearing: 2,
    rough_estimate: 3,
    customer_intent_confirmed: 4,
    schedule_coordination: 5,
    reviewing: 2,
    second_form_not_issued: 5,
    schedule_unconfirmed: 5,
    second_form_issued: 5,
    customer_responded: 5,
    schedule_adjusting: 5,
    needs_confirmation: 5,
    schedule_confirmed: 5,
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
    content_hearing_follow_up_sent: "内容確認・ヒアリングメール送信後にお客様回答待ちへ更新",
    second_form_answered: "日程確保フォームの回答を受領",
    schedule_confirmed_after_customer_notice: "確定連絡後に日程確保完了",
    schedule_result_confirmed_after_mail: "結果メール送信後に日程確保済み",
    schedule_result_unavailable_after_mail: "結果メール送信後に日程確保不可",
    case_progress_updated: "案件進捗を更新",
    payment_confirmed_and_closed: "入金確認後にケースクローズ",
    case_moved_to_trash: "案件をゴミ箱へ移動",
    case_restored_from_trash: "案件をゴミ箱から復元"
};

const deleteReasonLabels = {
    test_case: "テスト案件",
    duplicate: "重複登録",
    input_error: "入力ミス",
    other: "その他"
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
const contentHearingSection = $("#content-hearing-section");
const responseDetails = $("#response-details");
const auditList = $("#audit-list");
const firstFormSection = $("#first-form-section");
const firstFormDetails = $("#first-form-details");
const automaticMailStatus = $("#automatic-mail-status");
const emailHistory = $("#gmail-timeline");
const gmailCandidates = $("#gmail-candidates");
const gmailSyncState = $("#gmail-sync-state");
const gmailReplyPanel = $("#gmail-reply-panel");
const technicalDetails = $("#technical-details");
const currentSituationSection = $("#current-situation-section");
const nextActionSection = $("#next-action-section");
const workflowStatePanel = $("#workflow-state-panel");
const resultActionPanel = $("#result-action-panel");
const resultEmailSection = $("#result-email-section");
const progressManagementSection = $("#progress-management-section");
const progressForm = $("#progress-form");
const paymentSection = $("#payment-section");
const paymentForm = $("#payment-form");
const normalCasePanel = $("#normal-case-panel");
const trashPanel = $("#trash-panel");
const trashList = $("#trash-list");
const emptyTrash = $("#empty-trash");
const trashStatus = $("#trash-status");
const caseTrashSection = $("#case-trash-section");
const brandMailTestPreview = $("#brand-mail-test-preview");
const brandMailTestFrame = $("#brand-mail-test-frame");
const brandMailTestMessage = $("#brand-mail-test-message");

let supabase;
let cases = [];
let trashedCases = [];
let currentCase = null;
let currentProgress = null;
let currentPayments = [];
let currentToken = null;
let currentResponse = null;
let currentDeliveries = [];
let currentGmailTimeline = [];
let currentMailAttention = "none";
let currentGmailLink = null;
const gmailAttachmentFetches = new Map();
const gmailAttachmentBlobs = new Map();
const gmailAttachmentPreviewUrls = new Map();
let gmailReplyPreview = null;
let currentSessionUser = null;
let activeCaseTab = "active";
let activeProgressFilter = "";
let pendingPaymentConfirmation = null;
let issuedRawToken = "";
let emailOperationKey = "";
let mailActionInProgress = false;
let requestedCaseHandled = false;
let selectedTrashCase = null;
let trashActionInProgress = false;
let purgeImpactLoaded = false;
let brandMailTestConfirmationToken = "";
let brandMailTestInProgress = false;

const setMessage = (element, text, type = "info") => {
    element.textContent = text;
    element.className = `alert alert--${type}`;
    element.classList.remove("hidden");
};

const clearMessage = (element) => {
    element.textContent = "";
    element.className = "alert hidden";
};

const attachmentCacheKey = (messageId, attachmentId, inquiryId = currentCase?.id) => `${inquiryId || ""}:${String(messageId || "")}:${String(attachmentId || "")}`;
const formatAttachmentSize = (value) => {
    const bytes = Number(value || 0);
    if (!Number.isFinite(bytes) || bytes < 1) return "サイズ不明";
    if (bytes < 1024) return `${bytes.toLocaleString("ja-JP")} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};
const clearGmailAttachmentCache = () => {
    gmailAttachmentFetches.clear();
    gmailAttachmentBlobs.clear();
    gmailAttachmentPreviewUrls.forEach((url) => URL.revokeObjectURL(url));
    gmailAttachmentPreviewUrls.clear();
};

const isSafeAttachmentPreviewType = (value) => /^(?:application\/pdf|image\/(?:avif|gif|jpe?g|png|webp)|text\/plain)$/iu.test(String(value || "").split(";", 1)[0].trim());

// This is deliberately an allowlist renderer, not a string filter.  It tokenizes
// mail HTML and creates only allowed DOM nodes, so scripts, event handlers, CSS,
// images and every unsupported element are left behind.
const EMAIL_HTML_ALLOWED_TAGS = new Set([
    "a", "b", "blockquote", "br", "code", "del", "div", "em", "h1", "h2", "h3", "h4", "h5", "h6",
    "hr", "i", "li", "ol", "p", "pre", "s", "span", "strong", "strike", "table", "tbody", "td", "tfoot",
    "th", "thead", "tr", "u", "ul"
]);
const EMAIL_HTML_DROPPED_TAGS = new Set([
    "applet", "audio", "base", "button", "canvas", "embed", "form", "frame", "frameset", "iframe", "img", "input",
    "link", "meta", "object", "script", "source", "style", "svg", "textarea", "track", "video"
]);
const EMAIL_HTML_CONTENT_DROPPED_TAGS = new Set(["applet", "audio", "canvas", "embed", "form", "frame", "frameset", "iframe", "object", "script", "style", "svg", "video"]);
const EMAIL_HTML_VOID_TAGS = new Set(["br", "hr"]);
const EMAIL_HTML_TOKEN = /<!--[\s\S]*?-->|<\/?[A-Za-z][A-Za-z0-9:-]*(?:\s+[^<>]*?)?\/?>/gu;
const EMAIL_HTML_SAFE_STYLE_PROPERTIES = new Set(["background-color", "color", "font-style", "font-weight", "text-align", "text-decoration"]);

const safeEmailHref = (value) => {
    try {
        const url = new URL(String(value || ""), window.location.origin);
        return ["http:", "https:"].includes(url.protocol) ? url.href : "";
    } catch {
        return "";
    }
};

const decodeEmailHtmlText = (value) => String(value || "").replace(/&(nbsp|amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/giu, (entity, code) => {
    const named = { nbsp: "\u00a0", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
    if (named[String(code).toLowerCase()]) return named[String(code).toLowerCase()];
    const point = String(code).toLowerCase().startsWith("#x") ? Number.parseInt(String(code).slice(2), 16) : Number.parseInt(String(code).slice(1), 10);
    try { return Number.isInteger(point) && point >= 0 && point <= 0x10ffff ? String.fromCodePoint(point) : entity; } catch { return entity; }
});
const emailHtmlAttribute = (token, name) => {
    const match = String(token || "").match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\`]+))`, "iu"));
    return match ? (match[1] || match[2] || match[3] || "") : "";
};
const safeEmailStyle = (value) => String(value || "").split(";").flatMap((declaration) => {
    const [property, ...valueParts] = declaration.split(":");
    const safeProperty = String(property || "").trim().toLowerCase();
    const safeValue = valueParts.join(":").trim();
    if (!EMAIL_HTML_SAFE_STYLE_PROPERTIES.has(safeProperty) || !safeValue || /(?:url|expression|behavior|@import)/iu.test(safeValue)) return [];
    const valid = (safeProperty === "font-weight" && /^(?:normal|bold|bolder|lighter|[1-9]00)$/iu.test(safeValue))
        || (safeProperty === "font-style" && /^(?:normal|italic|oblique)$/iu.test(safeValue))
        || (safeProperty === "text-align" && /^(?:start|end|left|right|center|justify)$/iu.test(safeValue))
        || (safeProperty === "text-decoration" && /^(?:none|underline|line-through|overline)(?:\s+(?:underline|line-through|overline))?$/iu.test(safeValue))
        || ((safeProperty === "color" || safeProperty === "background-color") && /^(?:#[\da-f]{3,8}|[a-z]{1,20}|(?:rgb|hsl)a?\([\d.%\s,/-]+\))$/iu.test(safeValue));
    return valid ? [[safeProperty, safeValue]] : [];
});

const appendSanitizedEmailHtml = (container, value) => {
    const stack = [{ tag: "#root", element: container }];
    const sourceHtml = String(value || "");
    let blockedTag = "";
    let lastIndex = 0;
    const appendText = (text) => {
        if (!blockedTag && text) stack.at(-1).element.append(document.createTextNode(decodeEmailHtmlText(text)));
    };
    for (const tokenMatch of sourceHtml.matchAll(EMAIL_HTML_TOKEN)) {
        appendText(sourceHtml.slice(lastIndex, tokenMatch.index));
        lastIndex = tokenMatch.index + tokenMatch[0].length;
        const token = tokenMatch[0];
        if (token.startsWith("<!--")) continue;
        const closing = /^<\//u.test(token);
        const tag = (token.match(/^<\/?\s*([A-Za-z0-9:-]+)/u)?.[1] || "").toLowerCase();
        if (!tag) continue;
        if (blockedTag) {
            if (closing && tag === blockedTag) blockedTag = "";
            continue;
        }
        if (closing) {
            const index = stack.map((entry) => entry.tag).lastIndexOf(tag);
            if (index > 0) stack.splice(index);
            continue;
        }
        if (EMAIL_HTML_DROPPED_TAGS.has(tag)) {
            if (EMAIL_HTML_CONTENT_DROPPED_TAGS.has(tag)) blockedTag = tag;
            continue;
        }
        if (!EMAIL_HTML_ALLOWED_TAGS.has(tag)) continue;
        const target = document.createElement(tag);
        safeEmailStyle(emailHtmlAttribute(token, "style")).forEach(([property, styleValue]) => target.style.setProperty(property, styleValue));
        if (tag === "a") {
            const href = safeEmailHref(emailHtmlAttribute(token, "href"));
            if (href) {
                target.href = href;
                target.target = "_blank";
                target.rel = "noopener noreferrer";
            }
        }
        stack.at(-1).element.append(target);
        if (!EMAIL_HTML_VOID_TAGS.has(tag)) stack.push({ tag, element: target });
    }
    appendText(sourceHtml.slice(lastIndex));
    return container.childNodes.length > 0;
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

// The persisted `current_step` used the former 14-step vocabulary.  This read-only
// projection keeps that history intact while rendering only the PAM-001 authority.
const workflowStepForCase = (item) => {
    const progress = progressForCase(item);
    const status = item?.status;
    if (isCompletedStatus(status, progress)) return 14;
    if (status !== "schedule_confirmed") return initialWorkflowStep(status);
    if (!progress.estimate_created_on) return 6;
    if (!progress.estimate_sent_on || progress.estimate_adjusting) return 7;
    if (!progress.estimate_approved_on) return 8;
    if (!progress.booking_confirmed_on) return 9;
    if (!progress.event_preparation_completed_on) return 10;
    if (!progress.event_completed_on) return 11;
    return progress.invoice_sent ? 13 : 12;
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
        return `完了（${reason}）`;
    }
    const step = workflowStepForCase(item);
    if (item?.status === "on_hold" || progressForCase(item).is_on_hold) {
        return `${workflowSteps[step - 1]}（保留中）`;
    }
    return workflowSteps[step - 1] || "案件内容を確認";
};

const mailTypeLabels = {
    internal_new_inquiry: "ARA-TECH向け新規受付通知",
    customer_receipt: "お客様向け受付確認",
    content_hearing_follow_up: "内容確認・ヒアリングメール",
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

const isInternalDelivery = (delivery) =>
    delivery?.message_type === "internal_new_inquiry"
    || String(delivery?.message_type || "").endsWith("_internal");

const nextActionText = () => {
    if (!currentCase) return "案件情報を入力";
    if (contentHearingPendingStatuses.has(currentCase.status)) {
        const delivery = newestDelivery("content_hearing_follow_up");
        return delivery?.status === "failed"
            ? "内容確認・ヒアリングメールを必要な場合のみ再送"
            : "お客様へ内容確認メールを送る";
    }
    if (currentCase.status === "waiting_customer_reply") return "お客様の回答を待つ";
    if (currentCase.status === "hearing") return "資料・開催時間・ご予算をヒアリング";
    if (currentCase.status === "rough_estimate") return "概算見積を作成・案内";
    if (currentCase.status === "customer_intent_confirmed") return "日程・人員調整へ進める";
    if (currentCase.status === "schedule_coordination") return "日程確保が必要な場合のみフォームを発行";
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

const phaseForStep = (step) => workflowPhases.find((phase) => phase.steps.includes(step)) || workflowPhases[0];

const waitingOnForCase = () => {
    if (!currentCase) return "NONE";
    if (currentCase.status === "waiting_customer_reply") return "CUSTOMER";
    if (currentCase.status === "on_hold") return "THIRD_PARTY";
    if (currentCase.status === "schedule_adjusting") return "THIRD_PARTY";
    if (currentCase.status === "schedule_confirmed" && currentProgress?.confirmed_event_date) return "SCHEDULED_TIME";
    return "ARA_TECH";
};

const waitingOnLabel = (waitingOn) => ({
    ARA_TECH: "ARA-TECH対応待ち",
    CUSTOMER: "お客様回答待ち",
    THIRD_PARTY: "第三者確認待ち",
    SCHEDULED_TIME: "予定日時待ち",
    NONE: "待機なし"
}[waitingOn] || "未設定");

const situationForCase = () => {
    if (!currentCase) return null;
    const item = { ...currentCase, progress: currentProgress };
    const step = workflowStepForCase(item);
    const phase = phaseForStep(step);
    const waitingOn = waitingOnForCase();
    if (currentMailAttention === "new_customer_reply") {
        return {
            phase: phase.label,
            stage: workflowSteps[step - 1],
            waitingOn: "ARA_TECH",
            title: "新着返信あり",
            description: "お客様からの返信をGmailで受信しています。メール受信だけでは案件工程は進行しません。",
            nextAction: "お客様の返信内容・添付資料を確認してください。"
        };
    }
    if (currentCase.status === "waiting_customer_reply") {
        return {
            phase: phase.label,
            stage: workflowSteps[step - 1],
            waitingOn,
            title: "お客様回答待ち",
            description: "内容確認・ヒアリングメール送信済み。開催時間、タイムテーブル、会場資料、ご予算等の回答待ち。",
            nextAction: "現在はありません。お客様からの返信を待ってください。"
        };
    }
    if (currentCase.status === "customer_responded") {
        return {
            phase: phase.label,
            stage: workflowSteps[step - 1],
            waitingOn: "ARA_TECH",
            title: "新着返信あり",
            description: "お客様からの回答を受領しています。案件工程はメール受信だけでは進行しません。",
            nextAction: "お客様の返信内容・添付資料を確認してください。"
        };
    }
    return {
        phase: phase.label,
        stage: workflowSteps[step - 1],
        waitingOn,
        title: waitingOnLabel(waitingOn),
        description: `${phase.label} ＞ ${workflowSteps[step - 1]} の工程です。`,
        nextAction: waitingOn === "CUSTOMER" ? "現在はありません。お客様からの返信を待ってください。" : nextActionText()
    };
};

const renderCurrentSituation = () => {
    const situation = situationForCase();
    if (!situation) return;
    $("#current-situation-stage").textContent = `${situation.phase} ＞ ${situation.stage}`;
    $("#current-situation-waiting").textContent = waitingOnLabel(situation.waitingOn);
    $("#workflow-state-title").textContent = situation.title;
    $("#workflow-state-description").textContent = situation.description;
    $("#current-situation-next-action").textContent = `次の対応：${situation.nextAction}`;
};

const renderOverview = () => {
    $("#overview-number").textContent = currentCase?.inquiry_number || "保存時に発行";
    $("#overview-date").textContent = formatDate(currentProgress?.confirmed_event_date || currentCase?.event_date);
    $("#overview-contact").textContent = currentCase?.contact_name || currentCase?.customer_name || "未設定";
    $("#overview-venue").textContent = currentCase?.venue || "未設定";
    if (currentCase) {
        renderCurrentSituation();
        renderWorkflowPhaseNav();
        renderProgressSteps();
        renderNextActions();
    }
};

const renderWorkflowPhaseNav = () => {
    const container = $("#workflow-phase-nav");
    container.replaceChildren();
    if (!currentCase) return;
    const currentPhase = phaseForStep(workflowStepForCase({ ...currentCase, progress: currentProgress }));
    workflowPhases.forEach((phase) => {
        const item = document.createElement("span");
        item.className = `workflow-phase${phase.id === currentPhase.id ? " workflow-phase--current" : ""}`;
        item.textContent = phase.label;
        container.append(item);
    });
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

    const currentPhase = phaseForStep(currentStep);
    currentPhase.steps.forEach((step) => {
        const label = workflowSteps[step - 1];
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

const setWorkflowState = (_title, _description, question = "") => {
    // State and next action have one authority: `situationForCase()`.
    // Operational panels below never replace the top-level case situation.
    renderCurrentSituation();
    const questionElement = $("#workflow-question");
    questionElement.textContent = question;
    questionElement.classList.toggle("hidden", !question);
};

const renderNextActions = () => {
    if (!currentCase) return;
    currentSituationSection.classList.remove("hidden");
    nextActionSection.classList.remove("hidden");
    workflowStatePanel.classList.remove("hidden");
    resultActionPanel.classList.add("hidden");
    resultEmailSection.classList.add("hidden");
    contentHearingSection.classList.add("hidden");
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

    if (contentHearingPendingStatuses.has(currentCase.status)) {
        const contentHearingDelivery = newestDelivery("content_hearing_follow_up");
        if (contentHearingDelivery?.status === "failed") {
            setWorkflowState(
                "担当者フォロー待ち",
                "内容確認・ヒアリングメールの送信に失敗しています。送信履歴の「このメールを再送」を必要な場合だけ実行してください。"
            );
            emailSection.classList.add("hidden");
            return;
        }
        setWorkflowState(
            "内容確認・ヒアリングメールを作成",
            "受付確認メールとは別に、担当者が案件内容を確認してから送るメールです。自動送信は行いません。文面を確認・編集し、プレビュー後に送信してください。"
        );
        contentHearingSection.classList.remove("hidden");
        prepareContentHearingEmail();
        emailSection.classList.add("hidden");
        return;
    }

    if (currentCase.status === "waiting_customer_reply") {
        setWorkflowState(
            "お客様回答待ち",
            "内容確認・ヒアリングメールは送信済みです。お客様からの資料・開催時間・ご予算等の回答をお待ちください。"
        );
        emailSection.classList.add("hidden");
        return;
    }

    if (currentCase.status === "hearing") {
        setWorkflowState(
            "ヒアリング中",
            "開催時間、資料、会場レイアウト、出演内容、ご予算を確認し、概算見積の準備へ進めてください。"
        );
        emailSection.classList.add("hidden");
        return;
    }

    if (currentCase.status === "rough_estimate") {
        setWorkflowState(
            "概算見積中",
            "ヒアリング結果を基に概算見積を案内し、お客様の依頼意思を確認してください。"
        );
        emailSection.classList.add("hidden");
        return;
    }

    if (currentCase.status === "customer_intent_confirmed") {
        setWorkflowState(
            "依頼意思確認済み",
            "日程・人員調整の準備段階です。日程確保フォームは、調整が必要と判断した後にのみ発行してください。"
        );
        emailSection.classList.add("hidden");
        return;
    }

    if (currentCase.status === "schedule_coordination") {
        setWorkflowState(
            "日程・人員調整中",
            "日程確保が必要な場合のみ、公開情報と条件を確認して専用URLを発行してください。"
        );
        tokenSection.classList.remove("hidden");
        $("#issue-token").textContent = "日程確保フォームURLを発行";
        $("#revoke-token").hidden = true;
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

    const activeToken = scheduleEligibleStatuses.has(currentCase.status) && currentToken
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

    if (!scheduleEligibleStatuses.has(currentCase.status)) {
        setWorkflowState(
            "営業工程を確認",
            "お客様の依頼意思確認後、日程・人員調整の工程に進めてから日程確保フォームを発行してください。"
        );
        emailSection.classList.add("hidden");
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
    const availableTabs = new Set(["active", ...years.map((year) => `year-${year}`), "trash"]);
    if (!availableTabs.has(activeCaseTab)) activeCaseTab = "active";

    const tabs = [
        { id: "active", label: "進行中", count: activeCount },
        ...years.map((year) => ({
            id: `year-${year}`,
            label: `${year}年`,
            count: cases.filter((item) => isClosedCase(item) && eventYearForCase(item) === year).length
        })),
        { id: "trash", label: "ゴミ箱", count: trashedCases.length }
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
            if (tab.id === "trash") detailCard.classList.add("hidden");
            renderCaseTabs();
            renderProgressSummary();
            renderCases();
        });
        tabList.append(button);
    });

    const trashSelected = activeCaseTab === "trash";
    normalCasePanel.classList.toggle("hidden", trashSelected);
    trashPanel.classList.toggle("hidden", !trashSelected);
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
    if (activeCaseTab === "trash") return [];
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

const trashCaseSummary = (item, prefix) => {
    $(`#${prefix}-number`).textContent = item?.inquiry_number || "未発行";
    $(`#${prefix}-customer`).textContent = item?.contact_name || item?.customer_name || "未設定";
    $(`#${prefix}-event`).textContent = item?.event_name || "未設定";
    $(`#${prefix}-date`).textContent = formatDate(item?.event_date);
};

const trashErrorMessage = (code) => ({
    invalid_reason: "削除理由を選択してください。",
    invalid_confirmation: "受付番号を正確に入力してください。",
    confirmation_mismatch: "入力した受付番号が一致しません。",
    not_trashed: "この案件はゴミ箱にないため、完全削除できません。",
    not_found: "案件が見つかりません。再読み込みしてください。",
    not_authorized: "管理者認証を確認できませんでした。再ログインしてください。",
    rate_limited: "操作が続いたため一時的に制限しました。少し待ってから再試行してください。",
    service_unavailable: "削除サービスを利用できません。DBマイグレーションと環境設定を確認してください。"
}[code] || "処理を完了できませんでした。再読み込みしてから再試行してください。");

const setTrashControlsDisabled = (disabled) => {
    trashActionInProgress = disabled;
    $("#confirm-trash-case").disabled = disabled;
    $("#confirm-restore-case").disabled = disabled;
    $("#confirm-purge-case").disabled = disabled
        || !purgeImpactLoaded
        || $("#purge-confirmation").value !== selectedTrashCase?.inquiry_number;
    trashList.querySelectorAll("button").forEach((button) => {
        button.disabled = disabled;
    });
    document.querySelectorAll("[data-close-dialog]").forEach((button) => {
        button.disabled = disabled;
    });
};

const callTrashApi = async (payload) => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) throw new Error("not_authorized");
    const response = await fetch("/api/pa-case-trash", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${session.access_token}`
        },
        body: JSON.stringify(payload)
    });
    const result = await response.json().catch(() => ({ ok: false, code: "service_unavailable" }));
    if (!response.ok || !result.ok) throw new Error(result.code || "service_unavailable");
    return result;
};

const closeCaseDialog = (dialogId) => {
    const dialog = $(`#${dialogId}`);
    if (dialog.open) dialog.close();
};

const renderTrashCases = () => {
    trashList.replaceChildren();
    emptyTrash.classList.toggle("hidden", trashedCases.length > 0);

    trashedCases.forEach((item) => {
        const row = document.createElement("tr");

        const numberCell = document.createElement("td");
        numberCell.textContent = item.inquiry_number || "未発行";

        const customerCell = document.createElement("td");
        customerCell.textContent = item.contact_name || item.customer_name || "未設定";

        const eventCell = document.createElement("td");
        eventCell.textContent = item.event_name || "未設定";

        const eventDateCell = document.createElement("td");
        eventDateCell.textContent = formatDate(item.event_date);

        const deletedAtCell = document.createElement("td");
        deletedAtCell.textContent = formatDateTime(item.deleted_at);

        const reasonCell = document.createElement("td");
        reasonCell.textContent = deleteReasonLabels[item.delete_reason] || item.delete_reason || "未設定";

        const actionCell = document.createElement("td");
        const actions = document.createElement("div");
        actions.className = "actions actions--compact";

        const restoreButton = document.createElement("button");
        restoreButton.type = "button";
        restoreButton.className = "button button--confirm button--small";
        restoreButton.textContent = "復元";
        restoreButton.addEventListener("click", () => openRestoreDialog(item));

        const purgeButton = document.createElement("button");
        purgeButton.type = "button";
        purgeButton.className = "button button--danger button--small";
        purgeButton.textContent = "完全削除";
        purgeButton.addEventListener("click", () => openPurgeDialog(item));

        actions.append(restoreButton, purgeButton);
        actionCell.append(actions);
        row.append(
            numberCell,
            customerCell,
            eventCell,
            eventDateCell,
            deletedAtCell,
            reasonCell,
            actionCell
        );
        trashList.append(row);
    });
};

const openTrashDialog = () => {
    if (!currentCase || currentCase.deleted_at) return;
    selectedTrashCase = currentCase;
    trashCaseSummary(currentCase, "trash-confirm");
    $("#trash-reason").value = "";
    clearMessage($("#trash-dialog-message"));
    $("#trash-case-dialog").showModal();
    $("#trash-reason").focus();
};

const confirmTrashCase = async () => {
    if (trashActionInProgress || !selectedTrashCase) return;
    const reason = $("#trash-reason").value;
    if (!deleteReasonLabels[reason]) {
        setMessage($("#trash-dialog-message"), "削除理由を選択してください。", "error");
        return;
    }

    clearMessage($("#trash-dialog-message"));
    setTrashControlsDisabled(true);
    try {
        await callTrashApi({
            action: "trash",
            inquiry_id: selectedTrashCase.id,
            reason
        });
        const number = selectedTrashCase.inquiry_number;
        closeCaseDialog("trash-case-dialog");
        detailCard.classList.add("hidden");
        currentCase = null;
        selectedTrashCase = null;
        activeCaseTab = "trash";
        await loadCases();
        setMessage(trashStatus, `${number} をゴミ箱へ移動しました。メールは送信していません。`, "success");
    } catch (error) {
        setMessage($("#trash-dialog-message"), trashErrorMessage(error.message), "error");
    } finally {
        setTrashControlsDisabled(false);
    }
};

const openRestoreDialog = (item) => {
    if (trashActionInProgress) return;
    selectedTrashCase = item;
    trashCaseSummary(item, "restore-confirm");
    clearMessage($("#restore-dialog-message"));
    $("#restore-case-dialog").showModal();
    $("#confirm-restore-case").focus();
};

const confirmRestoreCase = async () => {
    if (trashActionInProgress || !selectedTrashCase) return;
    clearMessage($("#restore-dialog-message"));
    setTrashControlsDisabled(true);
    const restoredId = selectedTrashCase.id;
    const restoredNumber = selectedTrashCase.inquiry_number;
    try {
        const result = await callTrashApi({
            action: "restore",
            inquiry_id: restoredId
        });
        closeCaseDialog("restore-case-dialog");
        selectedTrashCase = null;
        activeCaseTab = "active";
        await loadCases();
        const restoredCase = cases.find((item) => item.id === restoredId);
        if (restoredCase && isClosedCase(restoredCase)) {
            activeCaseTab = `year-${eventYearForCase(restoredCase)}`;
            renderCaseTabs();
            renderProgressSummary();
            renderCases();
        }
        const tokenMessage = result.case.active_token_restored
            ? "削除前に有効だった顧客用URLも、期限内のため再び利用できます。"
            : "期限切れ・無効化済み・回答済みの顧客用URLは再有効化していません。";
        setMessage(listStatus, `${restoredNumber} を復元しました。${tokenMessage}`, "success");
    } catch (error) {
        setMessage($("#restore-dialog-message"), trashErrorMessage(error.message), "error");
    } finally {
        setTrashControlsDisabled(false);
    }
};

const renderPurgeImpact = (impact) => {
    const list = $("#purge-impact-list");
    list.replaceChildren();
    [
        ["案件進捗", impact.progress_count],
        ["入金記録", impact.payment_count],
        ["専用URL／トークン", impact.token_count],
        ["顧客回答", impact.response_count],
        ["Gmail送信履歴", impact.email_count],
        ["案件監査履歴", impact.audit_count]
    ].forEach(([label, count]) => {
        const item = document.createElement("li");
        item.textContent = `${label}：${Number(count || 0)}件`;
        list.append(item);
    });
};

const updatePurgeConfirmationState = () => {
    $("#confirm-purge-case").disabled = trashActionInProgress
        || !purgeImpactLoaded
        || $("#purge-confirmation").value !== selectedTrashCase?.inquiry_number;
};

const openPurgeDialog = async (item) => {
    if (trashActionInProgress) return;
    selectedTrashCase = item;
    purgeImpactLoaded = false;
    $("#purge-confirm-number").textContent = item.inquiry_number;
    $("#purge-confirmation").value = "";
    $("#purge-impact-list").replaceChildren();
    setMessage($("#purge-dialog-message"), "関連記録を確認しています。", "info");
    updatePurgeConfirmationState();
    $("#purge-case-dialog").showModal();

    try {
        const result = await callTrashApi({
            action: "inspect",
            inquiry_id: item.id
        });
        if (selectedTrashCase?.id !== item.id) return;
        renderPurgeImpact(result.case);
        purgeImpactLoaded = true;
        clearMessage($("#purge-dialog-message"));
        updatePurgeConfirmationState();
        $("#purge-confirmation").focus();
    } catch (error) {
        setMessage($("#purge-dialog-message"), trashErrorMessage(error.message), "error");
    }
};

const confirmPurgeCase = async () => {
    if (
        trashActionInProgress
        || !purgeImpactLoaded
        || !selectedTrashCase
        || $("#purge-confirmation").value !== selectedTrashCase.inquiry_number
    ) return;

    clearMessage($("#purge-dialog-message"));
    setTrashControlsDisabled(true);
    const deletedNumber = selectedTrashCase.inquiry_number;
    try {
        await callTrashApi({
            action: "purge",
            inquiry_id: selectedTrashCase.id,
            confirmation: $("#purge-confirmation").value
        });
        closeCaseDialog("purge-case-dialog");
        selectedTrashCase = null;
        purgeImpactLoaded = false;
        activeCaseTab = "trash";
        await loadCases();
        setMessage(trashStatus, `${deletedNumber} を完全削除しました。この操作は元に戻せません。`, "success");
    } catch (error) {
        setMessage($("#purge-dialog-message"), trashErrorMessage(error.message), "error");
    } finally {
        setTrashControlsDisabled(false);
    }
};

const loadCases = async () => {
    clearMessage(listStatus);
    const [caseResult, trashResult, progressResult] = await Promise.all([
        supabase
            .from("pa_inquiries")
            .select("*")
            .is("deleted_at", null)
            .order("received_at", { ascending: false }),
        supabase
            .from("pa_inquiries")
            .select("*")
            .not("deleted_at", "is", null)
            .order("deleted_at", { ascending: false }),
        supabase
            .from("pa_case_progress")
            .select("*")
    ]);

    if (caseResult.error || trashResult.error || progressResult.error) {
        setMessage(
            listStatus,
            "PA案件一覧を読み込めませんでした。ゴミ箱・進捗DBマイグレーションと権限設定をご確認ください。",
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
    trashedCases = trashResult.data || [];
    renderCaseTabs();
    renderProgressSummary();
    renderCases();
    renderTrashCases();
};

const resetForm = () => {
    caseForm.reset();
    $("#case-id").value = "";
    $("#case-received-at").value = toLocalDateTimeInput(new Date().toISOString());
    $("#case-status").value = "new_inquiry";
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
    contentHearingSection.classList.add("hidden");
    resultActionPanel.classList.add("hidden");
    resultEmailSection.classList.add("hidden");
    currentSituationSection.classList.add("hidden");
    nextActionSection.classList.add("hidden");
    progressManagementSection.classList.add("hidden");
    paymentSection.classList.add("hidden");
    caseTrashSection.classList.add("hidden");
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
    clearMessage($("#content-hearing-message"));
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
        ["internal_new_inquiry", "ARA-TECH向け新規受付通知"],
        ["content_hearing_follow_up", "内容確認・ヒアリングメール"]
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
    if (currentGmailTimeline.length) {
        [...currentGmailTimeline]
            .sort((a, b) => new Date(a.occurred_at || 0).getTime() - new Date(b.occurred_at || 0).getTime())
            .forEach((message) => {
                const item = document.createElement("article");
                item.className = `mail-history__item mail-history__item--${message.direction === "inbound" ? "inbound" : "sent"}`;
                const title = document.createElement("strong");
                title.textContent = message.direction === "inbound" ? "お客様 → ARA-TECH" : "ARA-TECH → お客様";
                const subject = document.createElement("span");
                subject.className = "gmail-message-subject";
                subject.textContent = message.subject || "（件名なし）";
                const meta = document.createElement("span");
                meta.textContent = `${formatDateTime(message.occurred_at)}${message.direction === "inbound" && currentMailAttention === "new_customer_reply" ? " ／ 新着" : ""}`;
                item.append(title, subject, meta);
                if (message.body_html || message.body_text) {
                    const details = document.createElement("details");
                    const summary = document.createElement("summary");
                    summary.textContent = "本文を表示";
                    const body = document.createElement(message.body_html ? "div" : "p");
                    body.className = `mail-preview__body${message.body_html ? " mail-preview__body--html" : ""}`;
                    const renderedHtml = message.body_html && appendSanitizedEmailHtml(body, message.body_html);
                    if (!renderedHtml) body.textContent = message.body_text || "（本文を表示できません）";
                    details.append(summary, body);
                    item.append(details);
                }
                const messageAttachments = Array.isArray(message.attachments) ? message.attachments : [];
                if (messageAttachments.length) {
                    const attachmentHeading = document.createElement("p");
                    attachmentHeading.className = "gmail-attachment-heading";
                    attachmentHeading.textContent = `添付ファイル（${messageAttachments.length}件）`;
                    const attachments = document.createElement("ul");
                    attachments.className = "gmail-attachments";
                    messageAttachments.forEach((attachment) => {
                        const entry = document.createElement("li");
                        entry.className = "gmail-attachment";
                        const metadata = document.createElement("div");
                        metadata.className = "gmail-attachment__metadata";
                        const filename = document.createElement("strong");
                        filename.className = "gmail-attachment__filename";
                        filename.textContent = attachment.filename || "添付ファイル";
                        const detail = document.createElement("span");
                        detail.textContent = `${attachment.mime_type || "application/octet-stream"} ／ ${formatAttachmentSize(attachment.size)}`;
                        metadata.append(filename, detail);
                        const actions = document.createElement("div");
                        actions.className = "gmail-attachment__actions";
                        const mimeType = attachment.mime_type || "application/octet-stream";
                        const downloadButton = document.createElement("button");
                        downloadButton.type = "button";
                        downloadButton.className = "button button--secondary button--small";
                        downloadButton.textContent = "ダウンロード";
                        downloadButton.addEventListener("click", () => downloadGmailAttachment(message.id, attachment.id, downloadButton, actions));
                        if (isSafeAttachmentPreviewType(mimeType)) {
                            const previewButton = document.createElement("button");
                            previewButton.type = "button";
                            previewButton.className = "button button--secondary button--small";
                            previewButton.textContent = "表示";
                            previewButton.addEventListener("click", () => previewGmailAttachment(message.id, attachment.id, previewButton, actions));
                            actions.append(previewButton);
                        }
                        actions.append(downloadButton);
                        entry.append(metadata, actions);
                        attachments.append(entry);
                    });
                    item.append(attachmentHeading, attachments);
                } else {
                    const noAttachments = document.createElement("p");
                    noAttachments.className = "gmail-attachment-heading";
                    noAttachments.textContent = "このメールには添付ファイルがありません";
                    item.append(noAttachments);
                }
                emailHistory.append(item);
            });
        return;
    }
    const customerDeliveries = currentDeliveries.filter((delivery) => !isInternalDelivery(delivery));
    if (!customerDeliveries.length) {
        const note = document.createElement("p");
        note.className = "small-note";
        note.textContent = "お客様とのやり取りはまだありません。";
        emailHistory.append(note);
        $("#email-send-state").textContent = "未送信";
        return;
    }

    customerDeliveries.forEach((delivery) => {
        const item = document.createElement("div");
        item.className = `mail-history__item mail-history__item--${delivery.status}`;
        const title = document.createElement("strong");
        title.textContent = `${mailTypeLabels[delivery.message_type] || delivery.message_type} ／ ${mailStatusLabels[delivery.status] || delivery.status}`;
        const subject = document.createElement("span");
        subject.textContent = delivery.subject;
        const meta = document.createElement("span");
        const when = delivery.sent_at || delivery.failed_at || delivery.requested_at;
        meta.textContent = `${formatDateTime(when)} ／ Gmail送信履歴${delivery.gmail_message_id ? "（Gmail同期でthreadを取得できます）" : ""}`;
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
    const mailEntries = currentDeliveries.filter(isInternalDelivery).map((delivery) => ({
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
        .is("deleted_at", null)
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
    clearGmailAttachmentCache();
    currentGmailTimeline = [];
    currentMailAttention = "none";
    currentGmailLink = null;
    gmailReplyPreview = null;
    gmailReplyPanel.classList.add("hidden");
    gmailCandidates.classList.add("hidden");
    gmailCandidates.replaceChildren();
    gmailSyncState.textContent = "Gmailは未同期です。";
    caseTrashSection.classList.remove("hidden");
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
    populateProgressManagement();
    $("#token-expiry").value = toLocalDateTimeInput(
        currentToken?.expires_at || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
    );
    const pageUrl = new URL(window.location.href);
    pageUrl.searchParams.set("case", currentCase.id);
    history.replaceState(null, "", pageUrl);
    detailCard.classList.remove("hidden");
    detailCard.scrollIntoView({ behavior: "smooth", block: "start" });
    await syncGmail({ automatic: true });
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

const shortEventDate = (value) => {
    const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/u);
    return match ? `${Number(match[2])}月${Number(match[3])}日` : "開催予定日";
};

const firstFormText = (key) => {
    const firstForm = currentCase?.first_form_data;
    const value = firstForm && typeof firstForm === "object" && !Array.isArray(firstForm)
        ? firstForm[key]
        : "";
    return typeof value === "string" ? value.trim() : "";
};

const contentHearingServices = () => {
    const source = Array.isArray(currentCase?.requested_services)
        ? currentCase.requested_services
        : Array.isArray(currentCase?.first_form_data?.requested_services)
            ? currentCase.first_form_data.requested_services
            : [];
    const services = source.map((value) => String(value || "").trim()).filter(Boolean);
    return services.length ? services.join("・") : "PA・音響";
};

const contentHearingTemplate = () => {
    const addressee = currentCase?.contact_name || currentCase?.customer_name || "ご担当者";
    const eventDate = shortEventDate(currentCase?.event_date);
    const venue = currentCase?.venue || "会場";
    const services = contentHearingServices();
    const overview = firstFormText("event_overview");
    const overviewLine = overview
        ? `開催概要：${overview}`
        : "出演内容や会場規模に合わせて必要な機材構成を検討いたします。";
    return {
        subject: `${eventDate} ${venue}での${services}について【ARA-TECH】`,
        body: [
            `${addressee} 様`,
            "",
            "お世話になります。",
            "ARA-TECHの荒殿です。",
            "",
            "この度は弊社ホームページよりお問い合わせいただき、ありがとうございます。",
            "",
            `${eventDate}、${venue}で開催予定のイベントについて、${services}のご相談内容を確認いたしました。`,
            "",
            overviewLine,
            "",
            `${services}について、出演内容や会場規模に合わせて必要な機材構成を検討し、お見積りをご案内できればと思っております。`,
            "",
            "お見積りにあたり、差し支えない範囲で下記についてお知らせいただけますでしょうか。",
            "",
            "・イベントの開催予定時間、およびPAが必要となる時間",
            "・当日のタイムテーブル、出演内容が分かる資料",
            "・会場レイアウトやステージ配置等が分かる資料",
            "・音響、電源関係について想定されているご予算の目安",
            "",
            "過去開催時の資料等でも構いませんので、参考になるものがございましたら併せてお送りいただけますと、より具体的なご提案が可能です。",
            "",
            "また、開催時間帯によって照明が必要となる場合には、音響とあわせて対応することも可能ですので、必要であればお知らせください。",
            "",
            "まだ確定していない部分については、現時点で分かる範囲で構いません。",
            "",
            "いただいた内容を確認のうえ、イベント内容とご予算に合わせた構成を検討し、まずは概算のお見積りをご案内いたします。",
            "",
            "よろしくお願いいたします。",
            "",
            "ARA-TECH",
            "荒殿"
        ].join("\n")
    };
};

const resetContentHearingConfirmation = () => {
    const button = $("#send-content-hearing");
    delete button.dataset.confirmationKey;
    button.textContent = "この内容で送信";
};

const prepareContentHearingEmail = () => {
    if (!currentCase || !contentHearingPendingStatuses.has(currentCase.status)) return;
    const template = contentHearingTemplate();
    $("#content-hearing-recipient").value = currentCase.email || "";
    $("#content-hearing-subject").value = template.subject;
    $("#content-hearing-body").value = template.body;
    $("#content-hearing-preview").classList.add("hidden");
    clearMessage($("#content-hearing-message"));
    resetContentHearingConfirmation();
};

const previewContentHearingEmail = () => {
    if (!currentCase) return;
    const subject = $("#content-hearing-subject").value.trim();
    const body = $("#content-hearing-body").value.trim();
    if (!subject || !body) {
        setMessage($("#content-hearing-message"), "件名と本文を入力してからプレビューしてください。", "error");
        return;
    }
    $("#content-hearing-preview-recipient").textContent = $("#content-hearing-recipient").value || "未設定";
    $("#content-hearing-preview-subject").textContent = subject;
    $("#content-hearing-preview-body").textContent = body;
    $("#content-hearing-preview").classList.remove("hidden");
    clearMessage($("#content-hearing-message"));
};

const applyContentHearingCaseState = (caseState) => {
    if (!caseState || !currentCase) return;
    currentCase.status = caseState.result_status;
    if (currentProgress) {
        currentProgress.current_step = initialWorkflowStep(currentCase.status);
    }
    $("#case-status").value = currentCase.status;
    renderOverview();
};

const sendContentHearingEmail = async () => {
    if (!currentCase || mailActionInProgress) return;
    const subject = $("#content-hearing-subject").value.trim();
    const body = $("#content-hearing-body").value.trim();
    if (!subject || !body) {
        setMessage($("#content-hearing-message"), "宛先、件名、本文を確認してください。", "error");
        return;
    }
    const confirmationKey = JSON.stringify([currentCase.id, currentCase.email, subject, body]);
    const sendButton = $("#send-content-hearing");
    if (sendButton.dataset.confirmationKey !== confirmationKey) {
        sendButton.dataset.confirmationKey = confirmationKey;
        sendButton.textContent = "この宛先へ送信を確定";
        setMessage(
            $("#content-hearing-message"),
            `${currentCase.email} へ内容確認・ヒアリングメールを送信します。宛先と内容を再確認し、もう一度ボタンを押してください。`,
            "warning"
        );
        return;
    }
    resetContentHearingConfirmation();

    mailActionInProgress = true;
    setMailButtonsDisabled(true);
    clearMessage($("#content-hearing-message"));
    try {
        const result = await callMailApi({
            action: "send_content_hearing",
            inquiry_id: currentCase.id,
            subject,
            body
        });
        recordDeliveryResult(result.delivery);
        if (result.delivery.status === "sent" && result.case_state) {
            applyContentHearingCaseState(result.case_state);
            setMessage(
                $("#content-hearing-message"),
                "Gmailから送信しました。送信日時とGmailメッセージIDを案件へ記録し、状態を「お客様回答待ち」へ更新しました。",
                "success"
            );
            await loadCases();
            await openCase(currentCase.id);
        } else {
            setMessage($("#content-hearing-message"), mailErrorMessage(result.delivery.error_summary), "error");
        }
    } catch (error) {
        setMessage($("#content-hearing-message"), mailErrorMessage(error.message), "error");
    } finally {
        mailActionInProgress = false;
        resetContentHearingConfirmation();
        setMailButtonsDisabled(false);
    }
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
    $("#send-content-hearing").disabled = disabled;
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

const callGmailApi = async (payload) => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) throw new Error("not_authorized");
    const response = await fetch("/api/pa-gmail", {
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
    if (!response.ok || !result.ok) throw new Error(result.code || "gmail_sync_failed");
    return result;
};

const filenameFromContentDisposition = (value) => {
    const encoded = String(value || "").match(/filename\*=UTF-8''([^;]+)/iu)?.[1];
    if (encoded) {
        try { return decodeURIComponent(encoded); } catch { /* fall through */ }
    }
    return String(value || "").match(/filename="?([^";]+)"?/iu)?.[1] || "attachment";
};

const downloadGmailAttachmentStream = async (payload) => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) throw new Error("not_authorized");
    const response = await fetch("/api/pa-gmail", {
        method: "POST",
        headers: {
            Accept: "application/octet-stream",
            "Content-Type": "application/json",
            Authorization: `Bearer ${session.access_token}`
        },
        credentials: "same-origin",
        body: JSON.stringify(payload)
    });
    if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(result.code || "gmail_attachment_download_failed");
    }
    const blob = await response.blob();
    if (!blob.size) throw new Error("gmail_attachment_unavailable");
    return {
        blob,
        filename: filenameFromContentDisposition(response.headers.get("Content-Disposition")),
        mimeType: response.headers.get("Content-Type") || blob.type || "application/octet-stream"
    };
};

const setAttachmentActionLoading = (actions, loading) => {
    actions?.querySelectorAll("button").forEach((button) => { button.disabled = loading; });
};

const acquireGmailAttachment = (messageId, attachmentId, inquiryId) => {
    const cacheKey = attachmentCacheKey(messageId, attachmentId, inquiryId);
    const cached = gmailAttachmentBlobs.get(cacheKey);
    if (cached) return Promise.resolve(cached);
    const pending = gmailAttachmentFetches.get(cacheKey);
    if (pending) return pending;
    const request = downloadGmailAttachmentStream({ action: "attachment_download", inquiry_id: inquiryId, gmail_message_id: messageId, gmail_attachment_id: attachmentId })
        .then((attachment) => { gmailAttachmentBlobs.set(cacheKey, attachment); return attachment; })
        .finally(() => gmailAttachmentFetches.delete(cacheKey));
    gmailAttachmentFetches.set(cacheKey, request);
    return request;
};

const downloadGmailAttachment = async (messageId, attachmentId, button, actions) => {
    if (!currentCase) return;
    const inquiryId = currentCase.id;
    if (gmailAttachmentFetches.has(attachmentCacheKey(messageId, attachmentId, inquiryId))) return;
    setAttachmentActionLoading(actions, true);
    button.textContent = "取得中…";
    setMessage(gmailSyncState, "添付ファイルを取得中です。", "info");
    try {
            const attachment = await acquireGmailAttachment(messageId, attachmentId, inquiryId);
            const url = URL.createObjectURL(attachment.blob);
            if (currentCase?.id !== inquiryId) {
                URL.revokeObjectURL(url);
                return;
            }
            const link = document.createElement("a");
            link.href = url;
            link.download = attachment.filename;
            link.hidden = true;
            document.body.append(link);
            link.click();
            link.remove();
            setTimeout(() => URL.revokeObjectURL(url), 60_000);
            setMessage(gmailSyncState, `添付ファイル「${attachment.filename}」のダウンロードを開始しました。`, "success");
    } catch (error) {
            if (currentCase?.id === inquiryId) {
                setMessage(gmailSyncState, gmailAttachmentErrorMessage(error.message), "error");
            }
    } finally {
        if (currentCase?.id === inquiryId) {
            setAttachmentActionLoading(actions, false);
            button.textContent = "ダウンロード";
        }
    }
};

const previewGmailAttachment = async (messageId, attachmentId, button, actions) => {
    if (!currentCase) return;
    const inquiryId = currentCase.id;
    if (gmailAttachmentFetches.has(attachmentCacheKey(messageId, attachmentId, inquiryId))) return;
    setAttachmentActionLoading(actions, true);
    button.textContent = "取得中…";
    setMessage(gmailSyncState, "添付ファイルを取得中です。", "info");
    const preview = window.open("", "_blank");
    if (!preview) {
        setAttachmentActionLoading(actions, false);
        button.textContent = "表示";
        setMessage(gmailSyncState, "表示用のタブを開けませんでした。ブラウザのポップアップ設定を確認してください。", "error");
        return;
    }
    preview.opener = null;
    try {
        const attachment = await acquireGmailAttachment(messageId, attachmentId, inquiryId);
        if (!isSafeAttachmentPreviewType(attachment.mimeType) || currentCase?.id !== inquiryId) throw new Error("gmail_attachment_preview_not_allowed");
        const cacheKey = attachmentCacheKey(messageId, attachmentId, inquiryId);
        const priorUrl = gmailAttachmentPreviewUrls.get(cacheKey);
        if (priorUrl) URL.revokeObjectURL(priorUrl);
        const url = URL.createObjectURL(attachment.blob);
        gmailAttachmentPreviewUrls.set(cacheKey, url);
        preview.location.replace(url);
        setMessage(gmailSyncState, `添付ファイル「${attachment.filename}」を別タブで表示しました。`, "success");
    } catch (error) {
        preview.close();
        if (currentCase?.id === inquiryId) {
            setMessage(gmailSyncState, error.message === "gmail_attachment_preview_not_allowed" ? "この形式は表示できません。ダウンロードして確認してください。" : gmailAttachmentErrorMessage(error.message), "error");
        }
    } finally {
        if (currentCase?.id === inquiryId) {
            setAttachmentActionLoading(actions, false);
            button.textContent = "表示";
        }
    }
};

const gmailAttachmentErrorMessage = (code) => {
    if (code === "not_authorized") return "管理者セッションを確認し、再ログインしてください。";
    if (code === "gmail_attachment_not_indexed") return "添付情報を確認できません。Gmail同期を行ってから、もう一度お試しください。";
    if (code === "gmail_attachment_not_found") return "メール上で添付ファイルが見つかりません。Gmail同期を行って最新情報を確認してください。";
    if (code === "gmail_attachment_unavailable") return "添付ファイルを取得できませんでした。サイズまたはデータを確認してください。";
    if (String(code).startsWith("gmail_read_") || String(code).startsWith("gmail_oauth_")) return "Gmailの読取権限または接続状態を確認してください。";
    return "添付ファイルの取得に失敗しました。時間をおいて再試行してください。";
};

const gmailErrorMessage = (code) => {
    if (code === "ambiguous_thread_link") return "候補のGmail threadが複数あります。確認してからこの案件に紐付けてください。";
    if (code === "gmail_thread_not_linked") return "返信にはGmail threadの紐付けが必要です。まず同期または手動紐付けを行ってください。";
    if (code === "reply_target_unavailable") return "お客様からの返信を確認してから、このthreadへ返信してください。";
    if (code === "invalid_confirmation") return "送信前プレビューの有効期限が切れたか、内容が変更されました。もう一度プレビューしてください。";
    if (String(code).startsWith("gmail_read_") || String(code).startsWith("gmail_oauth_")) return "Gmailの読取権限または接続状態を確認してください。古い表示を最新とは扱っていません。";
    if (String(code).startsWith("gmail_send_")) return "Gmailから送信できませんでした。案件工程は変更されていません。";
    return "Gmail同期を完了できませんでした。古い表示を最新とは扱っていません。";
};

const renderGmailCandidates = (candidates = []) => {
    gmailCandidates.replaceChildren();
    if (!candidates.length) {
        gmailCandidates.classList.add("hidden");
        return;
    }
    gmailCandidates.classList.remove("hidden");
    const heading = document.createElement("p");
    heading.className = "small-note";
    heading.textContent = "候補メール（自動紐付けしていません）";
    gmailCandidates.append(heading);
    candidates.forEach((threadId) => {
        const row = document.createElement("div");
        row.className = "gmail-candidate";
        const label = document.createElement("code");
        label.textContent = threadId;
        const button = document.createElement("button");
        button.type = "button";
        button.className = "button button--secondary";
        const primaryTarget = !currentGmailLink;
        button.textContent = primaryTarget ? "主たる会話として紐付ける" : "追加の会話として紐付ける";
        button.addEventListener("click", async () => {
            if (!currentCase || !window.confirm(primaryTarget
                ? "このGmail threadを、この案件のお客様返信用の主たる会話として明示的に紐付けますか？"
                : "このGmail threadを、この案件の追加会話として明示的に紐付けますか？")) return;
            button.disabled = true;
            try {
                const response = await callGmailApi({
                    action: "manual_link",
                    inquiry_id: currentCase.id,
                    gmail_thread_id: threadId,
                    conversation_role: primaryTarget ? "primary_conversation" : "secondary_conversation"
                });
                applyGmailSyncResult(response.result);
                setMessage(gmailSyncState, "Gmail threadを手動で紐付け、同期しました。", "success");
            } catch (error) {
                setMessage(gmailSyncState, gmailErrorMessage(error.message), "error");
            } finally {
                button.disabled = false;
            }
        });
        row.append(label, button);
        gmailCandidates.append(row);
    });
};

const applyGmailSyncResult = (result) => {
    currentGmailTimeline = Array.isArray(result?.messages) ? result.messages : [];
    currentMailAttention = result?.attention || "none";
    currentGmailLink = result?.primary_link || null;
    gmailSyncState.textContent = result?.linked
        ? `Gmail同期：${formatDateTime(result.synced_at)}${currentMailAttention === "new_customer_reply" ? " ／ 新着返信あり" : ""} ／ 返信先は主たる会話です`
        : result?.ambiguous ? "Gmail thread候補が複数あります。自動紐付けは行っていません。" : "Gmail threadは未紐付けです。";
    renderGmailCandidates(result?.candidates || []);
    renderEmailHistory();
    renderOverview();
    gmailReplyPanel.classList.toggle("hidden", !currentGmailLink);
};

const syncGmail = async ({ automatic = false } = {}) => {
    if (!currentCase) return;
    const button = $("#sync-gmail");
    button.disabled = true;
    gmailSyncState.textContent = automatic ? "Gmailを同期中です…" : "Gmailを同期中です…";
    try {
        const response = await callGmailApi({ action: "sync", inquiry_id: currentCase.id });
        applyGmailSyncResult(response.result);
    } catch (error) {
        currentGmailTimeline = [];
        currentMailAttention = "none";
        gmailReplyPanel.classList.add("hidden");
        setMessage(gmailSyncState, gmailErrorMessage(error.message), "error");
        renderEmailHistory();
        renderOverview();
    } finally {
        button.disabled = false;
    }
};

const previewGmailReply = async () => {
    if (!currentCase) return;
    const body = $("#gmail-reply-body").value.trim();
    if (!body) return setMessage($("#gmail-reply-message"), "本文を入力してください。", "error");
    try {
        const response = await callGmailApi({ action: "reply_preview", inquiry_id: currentCase.id, body });
        gmailReplyPreview = response.preview;
        $("#gmail-reply-recipient").value = response.preview.recipient;
        $("#gmail-reply-subject").value = response.preview.subject;
        $("#gmail-reply-preview-recipient").textContent = response.preview.recipient;
        $("#gmail-reply-preview-subject").textContent = response.preview.subject;
        $("#gmail-reply-preview-body").textContent = response.preview.body;
        $("#gmail-reply-preview").classList.remove("hidden");
        $("#send-gmail-reply").disabled = false;
        setMessage($("#gmail-reply-message"), "内容を確認し、最終確認ボタンを押すまで送信されません。", "warning");
    } catch (error) {
        gmailReplyPreview = null;
        $("#send-gmail-reply").disabled = true;
        setMessage($("#gmail-reply-message"), gmailErrorMessage(error.message), "error");
    }
};

const sendGmailReply = async () => {
    if (!currentCase || !gmailReplyPreview) return;
    if (!window.confirm(`${gmailReplyPreview.recipient} へGmailで返信します。送信しますか？`)) return;
    $("#send-gmail-reply").disabled = true;
    try {
        const response = await callGmailApi({ action: "send_reply", inquiry_id: currentCase.id, body: $("#gmail-reply-body").value.trim(), confirmation_token: gmailReplyPreview.confirmation_token });
        gmailReplyPreview = null;
        $("#gmail-reply-body").value = "";
        $("#gmail-reply-preview").classList.add("hidden");
        applyGmailSyncResult(response.result);
        setMessage($("#gmail-reply-message"), "Gmail送信成功を確認し、threadを同期しました。案件工程は変更していません。", "success");
    } catch (error) {
        setMessage($("#gmail-reply-message"), gmailErrorMessage(error.message), "error");
    } finally {
        $("#send-gmail-reply").disabled = !gmailReplyPreview;
    }
};

const callBrandMailTestApi = async (payload) => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) throw new Error("not_authorized");
    const response = await fetch("/api/pa-mail-brand-test", {
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
    if (!response.ok || !result.ok) throw new Error(result.code || "mail_delivery_failed");
    return result;
};

const resetBrandMailTestConfirmation = () => {
    const button = $("#send-brand-mail-test");
    delete button.dataset.confirmationToken;
    button.textContent = "テストメールを送信";
};

const brandMailTestRecipient = () => $("#brand-mail-test-recipient").textContent.trim();

const brandMailTestErrorMessage = (code) => {
    if (code === "not_authorized") return "管理者セッションを確認し、再ログインしてください。";
    if (code === "invalid_confirmation") return "プレビューの有効期限が切れました。内容を確認してから、もう一度プレビューしてください。";
    if (code === "gmail_not_configured" || String(code).startsWith("gmail_oauth_") || String(code).startsWith("gmail_send_")) {
        return "Gmailから送信できませんでした。PA案件・進捗・送信履歴は変更されていません。";
    }
    return "テストメールを送信できませんでした。PA案件・進捗・送信履歴は変更されていません。";
};

const previewBrandMailTest = async () => {
    if (brandMailTestInProgress) return;
    brandMailTestInProgress = true;
    $("#preview-brand-mail-test").disabled = true;
    $("#send-brand-mail-test").disabled = true;
    brandMailTestConfirmationToken = "";
    resetBrandMailTestConfirmation();
    clearMessage(brandMailTestMessage);
    try {
        const result = await callBrandMailTestApi({ action: "preview" });
        const preview = result.preview;
        if (!preview?.confirmation_token || !preview?.html) throw new Error("mail_delivery_failed");
        brandMailTestConfirmationToken = preview.confirmation_token;
        brandMailTestFrame.srcdoc = preview.html;
        brandMailTestPreview.classList.remove("hidden");
        $("#send-brand-mail-test").disabled = false;
        setMessage(brandMailTestMessage, "プレビューを生成しました。送信先と内容を確認し、送信ボタンをもう一度押してください。", "info");
    } catch (error) {
        setMessage(brandMailTestMessage, brandMailTestErrorMessage(error.message), "error");
    } finally {
        brandMailTestInProgress = false;
        $("#preview-brand-mail-test").disabled = false;
    }
};

const sendBrandMailTest = async () => {
    if (brandMailTestInProgress || !brandMailTestConfirmationToken) {
        setMessage(brandMailTestMessage, "先にプレビューを生成してください。", "error");
        return;
    }
    const button = $("#send-brand-mail-test");
    if (button.dataset.confirmationToken !== brandMailTestConfirmationToken) {
        button.dataset.confirmationToken = brandMailTestConfirmationToken;
        button.textContent = "この内容でテストメール送信を確定";
        setMessage(brandMailTestMessage, `${brandMailTestRecipient()} へ1通だけ送信します。内容を再確認し、もう一度ボタンを押してください。`, "warning");
        return;
    }
    if (!window.confirm(`${brandMailTestRecipient()} へブランドメール表示テストを1通送信します。PA案件・進捗・顧客送信履歴は変更しません。送信しますか？`)) return;

    brandMailTestInProgress = true;
    $("#preview-brand-mail-test").disabled = true;
    button.disabled = true;
    clearMessage(brandMailTestMessage);
    try {
        const result = await callBrandMailTestApi({
            action: "send",
            confirmation_token: brandMailTestConfirmationToken
        });
        brandMailTestConfirmationToken = "";
        resetBrandMailTestConfirmation();
        setMessage(
            brandMailTestMessage,
            `Gmailから送信しました。送信日時：${formatDateTime(result.delivery.sent_at)}／GmailメッセージID：${result.delivery.gmail_message_id}`,
            "success"
        );
    } catch (error) {
        resetBrandMailTestConfirmation();
        setMessage(brandMailTestMessage, brandMailTestErrorMessage(error.message), "error");
    } finally {
        brandMailTestInProgress = false;
        $("#preview-brand-mail-test").disabled = false;
        button.disabled = !brandMailTestConfirmationToken;
    }
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
                if (result.case_state.result_status === "waiting_customer_reply") {
                    applyContentHearingCaseState(result.case_state);
                    setMessage(
                        $("#email-message"),
                        "内容確認・ヒアリングメールの再送に成功し、状態を「お客様回答待ち」へ更新しました。",
                        "success"
                    );
                } else {
                    applyCaseState(result.case_state);
                    setMessage(
                        $("#schedule-message"),
                        result.case_state.result_status === "schedule_confirmed"
                            ? "結果メールの再送に成功し、案件状態を「日程確保済み」へ更新しました。"
                            : "結果メールの再送に成功し、案件状態を「日程確保不可」へ更新しました。",
                        "success"
                    );
                }
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
    $("#move-case-to-trash").addEventListener("click", openTrashDialog);
    $("#confirm-trash-case").addEventListener("click", confirmTrashCase);
    $("#confirm-restore-case").addEventListener("click", confirmRestoreCase);
    $("#confirm-purge-case").addEventListener("click", confirmPurgeCase);
    $("#purge-confirmation").addEventListener("input", updatePurgeConfirmationState);
    document.querySelectorAll("[data-close-dialog]").forEach((button) => {
        button.addEventListener("click", () => {
            if (trashActionInProgress) return;
            closeCaseDialog(button.dataset.closeDialog);
            selectedTrashCase = null;
            purgeImpactLoaded = false;
        });
    });
    document.querySelectorAll(".case-dialog").forEach((dialog) => {
        dialog.addEventListener("cancel", (event) => {
            if (trashActionInProgress) {
                event.preventDefault();
                return;
            }
            selectedTrashCase = null;
            purgeImpactLoaded = false;
        });
    });
    $("#send-email").addEventListener("click", sendEmail);
    $("#sync-gmail").addEventListener("click", () => syncGmail());
    $("#preview-gmail-reply").addEventListener("click", previewGmailReply);
    $("#send-gmail-reply").addEventListener("click", sendGmailReply);
    $("#gmail-reply-body").addEventListener("input", () => {
        gmailReplyPreview = null;
        $("#send-gmail-reply").disabled = true;
        $("#gmail-reply-preview").classList.add("hidden");
    });
    $("#preview-brand-mail-test").addEventListener("click", previewBrandMailTest);
    $("#send-brand-mail-test").addEventListener("click", sendBrandMailTest);
    $("#preview-content-hearing").addEventListener("click", previewContentHearingEmail);
    $("#send-content-hearing").addEventListener("click", sendContentHearingEmail);
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
