const crypto = require("node:crypto");

const DEFAULT_SUPABASE_URL = "https://kogbnremsouajxxsgxro.supabase.co";
const ADMIN_URL = "https://ara-tech.cc/pa-admin.html";
const SITE_URL = "https://ara-tech.cc";
const OFFICIAL_EMAIL = "aratechsound@gmail.com";
const LINE_ADD_URL = "https://lin.ee/TF64AB6";
const LINE_QR_TARGET_URL = "https://lin.ee/XX7Psxw";
const LINE_QR_IMAGE_URL = `${SITE_URL}/img/ara-tech-line-official-qr.png`;
const LINE_CTA_LABEL = "ARA-TECH公式LINEで連絡する";
const LINE_GUIDE_WITH_REFERENCE = "お急ぎの場合や画像・資料を送りたい場合は、LINEをご利用ください。友だち追加後、このメールに記載の受付番号とお名前をお送りください。";
const LINE_GUIDE_WITHOUT_REFERENCE = "お急ぎの場合や画像・資料を送りたい場合は、LINEをご利用ください。友だち追加後、お名前とお問い合わせ内容をお送りください。";
const LEGACY_CUSTOMER_EMAIL = ["tonokun", "gmail.com"].join("@");
const CUSTOMER_FOOTER_TEXT = [
    "ARA-TECH",
    "",
    `Email：${OFFICIAL_EMAIL}`,
    LINE_GUIDE_WITH_REFERENCE,
    `LINE：${LINE_ADD_URL}`,
    `Web：${SITE_URL}`
].join("\n");
const CUSTOMER_FOOTER_TEXT_WITHOUT_REFERENCE = [
    "ARA-TECH",
    "",
    `Email：${OFFICIAL_EMAIL}`,
    LINE_GUIDE_WITHOUT_REFERENCE,
    `LINE：${LINE_ADD_URL}`,
    `Web：${SITE_URL}`
].join("\n");
const AUTOMATIC_TYPES = new Set(["internal_new_inquiry", "customer_receipt"]);
const SCHEDULE_RESPONSE_TYPES = new Set([
    "schedule_response_agree_customer",
    "schedule_response_agree_internal",
    "schedule_response_question_customer",
    "schedule_response_question_internal",
    "schedule_response_decline_customer",
    "schedule_response_decline_internal"
]);
const SCHEDULE_RESULT_TYPES = new Set([
    "schedule_result_confirmed",
    "schedule_result_unavailable"
]);
const ALLOWED_TYPES = new Set([
    ...AUTOMATIC_TYPES,
    ...SCHEDULE_RESPONSE_TYPES,
    ...SCHEDULE_RESULT_TYPES,
    "schedule_request"
]);
const CUSTOMER_MESSAGE_TYPES = new Set([
    "customer_receipt",
    "schedule_request",
    "schedule_response_agree_customer",
    "schedule_response_question_customer",
    "schedule_response_decline_customer",
    ...SCHEDULE_RESULT_TYPES
]);

const cleanHeader = (value, maxLength = 320) => {
    const text = String(value || "").trim();
    if (!text || text.length > maxLength || /[\r\n]/u.test(text)) throw new Error("invalid_header");
    return text;
};

const cleanBody = (value, maxLength = 20_000) => {
    const text = String(value || "").replace(/\r\n?/gu, "\n").trim();
    if (!text || text.length > maxLength || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u.test(text)) {
        throw new Error("invalid_body");
    }
    return text;
};

const configuredSignature = () => String(
    process.env.GMAIL_SIGNATURE_TEXT || `ARA-TECH\n${SITE_URL}`
).replace(/\r\n?/gu, "\n").trim();

const isCustomerMessageType = (messageType) => CUSTOMER_MESSAGE_TYPES.has(String(messageType || ""));

const stripTrailingBlock = (body, block) => {
    const safeBlock = String(block || "").replace(/\r\n?/gu, "\n").trim();
    if (!safeBlock) return body;
    if (body === safeBlock) return "";
    const suffix = `\n\n${safeBlock}`;
    return body.endsWith(suffix) ? body.slice(0, -suffix.length).trim() : body;
};

const stripPreviousEmergencyFooter = (body) => {
    const marker = `ARA-TECH\n\nEmail：${OFFICIAL_EMAIL}\n緊急連絡先`;
    const markerIndex = String(body || "").lastIndexOf(marker);
    if (markerIndex < 0) return body;
    const blockStart = markerIndex >= 2 && body.slice(markerIndex - 2, markerIndex) === "\n\n"
        ? markerIndex - 2
        : markerIndex;
    return body.slice(0, blockStart).trim();
};

const customerFooterTextForBody = (body) => (
    /\bPA-\d{8}-\d{5}\b/u.test(String(body || ""))
        ? CUSTOMER_FOOTER_TEXT
        : CUSTOMER_FOOTER_TEXT_WITHOUT_REFERENCE
);

const normalizeCustomerBody = (value, legacySignature = configuredSignature()) => {
    let body = cleanBody(value);
    const normalizedLegacySignature = String(legacySignature || "").replace(/\r\n?/gu, "\n").trim();
    let previous;
    do {
        previous = body;
        body = stripTrailingBlock(body, CUSTOMER_FOOTER_TEXT);
        body = stripTrailingBlock(body, CUSTOMER_FOOTER_TEXT_WITHOUT_REFERENCE);
        body = stripPreviousEmergencyFooter(body);
        body = stripTrailingBlock(body, normalizedLegacySignature);
    } while (body !== previous);

    const legacyCustomerEmailIndex = body.toLowerCase().lastIndexOf(LEGACY_CUSTOMER_EMAIL);
    if (legacyCustomerEmailIndex >= 0) {
        const legacyBlockStart = body.lastIndexOf("\n\n", legacyCustomerEmailIndex);
        if (legacyBlockStart >= 0) body = body.slice(0, legacyBlockStart).trim();
    }
    if (body.toLowerCase().includes(LEGACY_CUSTOMER_EMAIL)) {
        throw new Error("unsafe_customer_message");
    }

    const legacyEmails = normalizedLegacySignature.match(/[^\s<>]+@[^\s<>]+/gu) || [];
    legacyEmails
        .map((email) => email.replace(/[),.;:]+$/u, ""))
        .filter((email) => email.toLowerCase() !== OFFICIAL_EMAIL)
        .forEach((email) => {
            if (body.toLowerCase().includes(email.toLowerCase())) {
                throw new Error("unsafe_customer_message");
            }
        });

    return cleanBody(`${body}\n\n${customerFooterTextForBody(body)}`);
};

const escapeHtml = (value) => String(value || "")
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");

const linkifyHtmlLine = (line) => String(line || "")
    .split(/(https:\/\/[^\s]+)/gu)
    .map((part) => /^https:\/\//u.test(part)
        ? `<a href="${escapeHtml(part)}" style="color:#006fd6;text-decoration:underline;overflow-wrap:anywhere;word-break:break-word;">${escapeHtml(part)}</a>`
        : escapeHtml(part))
    .join("");

const buildCustomerHtml = (body) => {
    const normalized = normalizeCustomerBody(body);
    const footerText = customerFooterTextForBody(normalized);
    const lineGuide = footerText === CUSTOMER_FOOTER_TEXT
        ? LINE_GUIDE_WITH_REFERENCE
        : LINE_GUIDE_WITHOUT_REFERENCE;
    const content = stripTrailingBlock(normalized, footerText);
    const contentHtml = content
        .split(/\n{2,}/gu)
        .map((paragraph) => `<p style="margin:0 0 18px;line-height:1.8;">${paragraph.split("\n").map(linkifyHtmlLine).join("<br>")}</p>`)
        .join("");

    return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ARA-TECHからのお知らせ</title>
</head>
<body style="margin:0;padding:0;background:#f3f6f9;color:#1f2933;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans JP','Yu Gothic',Meiryo,sans-serif;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;border-collapse:collapse;background:#f3f6f9;">
<tr>
<td align="center" style="padding:20px 12px;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:640px;border-collapse:collapse;background:#ffffff;border:1px solid #dce4ec;border-radius:12px;">
<tr>
<td style="padding:24px 24px 18px;border-bottom:3px solid #007bff;font-size:20px;font-weight:700;letter-spacing:.04em;color:#111827;">ARA-TECH</td>
</tr>
<tr>
<td style="padding:28px 24px 10px;font-size:15px;line-height:1.8;overflow-wrap:anywhere;word-break:break-word;">${contentHtml}</td>
</tr>
<tr>
<td style="padding:22px 24px 26px;border-top:1px solid #dce4ec;background:#f8fafc;font-size:14px;line-height:1.8;overflow-wrap:anywhere;word-break:break-word;">
<p style="margin:0 0 10px;font-size:16px;font-weight:700;color:#111827;">ARA-TECH</p>
<p style="margin:0;">Email：<a href="mailto:${OFFICIAL_EMAIL}" style="color:#006fd6;text-decoration:underline;overflow-wrap:anywhere;word-break:break-word;">${OFFICIAL_EMAIL}</a></p>
<p style="margin:0;">Web：<a href="${SITE_URL}" style="color:#006fd6;text-decoration:underline;overflow-wrap:anywhere;word-break:break-word;">${SITE_URL}</a></p>
<div style="margin:20px 0 0;padding:18px;background:#ffffff;border:1px solid #dce4ec;border-radius:10px;">
<p style="margin:0 0 14px;line-height:1.8;">${escapeHtml(lineGuide)}</p>
<p style="margin:0 0 12px;"><a href="${LINE_ADD_URL}" style="display:inline-block;box-sizing:border-box;max-width:100%;padding:12px 18px;border-radius:8px;background:#06c755;color:#ffffff;font-weight:700;text-decoration:none;text-align:center;">${LINE_CTA_LABEL}</a></p>
<p style="margin:0 0 18px;">LINE：<a href="${LINE_ADD_URL}" style="color:#006fd6;text-decoration:underline;overflow-wrap:anywhere;word-break:break-word;">${LINE_ADD_URL}</a></p>
<p style="margin:0 0 10px;line-height:1.7;">PCでご覧の場合は、スマートフォンでQRコードを読み取ってください</p>
<img src="${LINE_QR_IMAGE_URL}" width="170" height="170" alt="ARA-TECH公式LINE QRコード" style="display:block;width:170px;max-width:100%;height:auto;margin:0;border:0;background:#ffffff;">
</div>
</td>
</tr>
</table>
</td>
</tr>
</table>
</body>
</html>`;
};

const isUuid = (value) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(String(value || ""));

const formatDate = (value) => {
    if (!value) return "未設定";
    const date = new Date(`${String(value).slice(0, 10)}T00:00:00+09:00`);
    if (Number.isNaN(date.getTime())) return "未設定";
    return new Intl.DateTimeFormat("ja-JP", {
        year: "numeric",
        month: "long",
        day: "numeric",
        timeZone: "Asia/Tokyo"
    }).format(date);
};

const formatDateTime = (value) => {
    const date = value ? new Date(value) : new Date();
    if (Number.isNaN(date.getTime())) return "未設定";
    return new Intl.DateTimeFormat("ja-JP", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "Asia/Tokyo"
    }).format(date);
};

const mailConfig = () => {
    const config = {
        clientId: String(process.env.GMAIL_CLIENT_ID || "").trim(),
        clientSecret: String(process.env.GMAIL_CLIENT_SECRET || "").trim(),
        refreshToken: String(process.env.GMAIL_REFRESH_TOKEN || "").trim(),
        senderAddress: String(process.env.GMAIL_SENDER_ADDRESS || "").trim(),
        senderName: String(process.env.GMAIL_SENDER_NAME || "ARA-TECH").trim(),
        notificationAddress: String(process.env.GMAIL_NOTIFICATION_ADDRESS || "").trim(),
        replyTo: String(process.env.GMAIL_REPLY_TO || "").trim(),
        signature: configuredSignature()
    };
    if (!config.clientId || !config.clientSecret || !config.refreshToken || !config.senderAddress || !config.replyTo) {
        throw new Error("gmail_not_configured");
    }
    cleanHeader(config.senderAddress);
    cleanHeader(config.senderName, 120);
    cleanHeader(config.replyTo);
    cleanBody(config.signature, 2_000);
    return config;
};

const supabaseConfig = () => {
    const serviceRoleKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
    if (!serviceRoleKey) throw new Error("supabase_not_configured");
    return {
        url: String(process.env.SUPABASE_URL || DEFAULT_SUPABASE_URL).replace(/\/+$/u, ""),
        serviceRoleKey
    };
};

const supabaseHeaders = (serviceRoleKey, prefer) => ({
    apikey: serviceRoleKey,
    authorization: `Bearer ${serviceRoleKey}`,
    "content-type": "application/json",
    accept: "application/json",
    ...(prefer ? { prefer } : {})
});

const supabaseRequest = async (path, options = {}, fetchImpl = fetch) => {
    const { url, serviceRoleKey } = supabaseConfig();
    const response = await fetchImpl(`${url}${path}`, {
        ...options,
        headers: {
            ...supabaseHeaders(serviceRoleKey, options.prefer),
            ...(options.headers || {})
        }
    });
    if (!response.ok) {
        const error = new Error(`supabase_${response.status}`);
        error.status = response.status;
        throw error;
    }
    if (response.status === 204) return null;
    return response.json();
};

const getInquiry = async (inquiryId, fetchImpl = fetch) => {
    if (!isUuid(inquiryId)) throw new Error("invalid_inquiry");
    const parameters = new URLSearchParams({
        id: `eq.${inquiryId}`,
        select: "*",
        limit: "1"
    });
    const rows = await supabaseRequest(`/rest/v1/pa_inquiries?${parameters}`, {}, fetchImpl);
    if (!Array.isArray(rows) || !rows[0]) throw new Error("inquiry_not_found");
    return rows[0];
};

const getScheduleResponseBySubmissionKey = async (submissionKey, fetchImpl = fetch) => {
    if (!isUuid(submissionKey)) throw new Error("invalid_submission");
    const parameters = new URLSearchParams({
        submission_key: `eq.${submissionKey}`,
        select: "*",
        limit: "1"
    });
    const rows = await supabaseRequest(`/rest/v1/pa_schedule_responses?${parameters}`, {}, fetchImpl);
    if (!Array.isArray(rows) || !rows[0]) throw new Error("schedule_response_not_found");
    return rows[0];
};

const getScheduleResponseByInquiry = async (inquiryId, fetchImpl = fetch) => {
    if (!isUuid(inquiryId)) throw new Error("invalid_inquiry");
    const parameters = new URLSearchParams({
        inquiry_id: `eq.${inquiryId}`,
        select: "*",
        limit: "1"
    });
    const rows = await supabaseRequest(`/rest/v1/pa_schedule_responses?${parameters}`, {}, fetchImpl);
    if (!Array.isArray(rows) || !rows[0]) throw new Error("schedule_response_not_found");
    return rows[0];
};

const adminCaseUrl = (inquiry) => {
    if (!isUuid(inquiry?.id)) throw new Error("invalid_inquiry");
    return `${ADMIN_URL}?case=${encodeURIComponent(inquiry.id)}`;
};

const verifyAdmin = async (accessToken, fetchImpl = fetch) => {
    const token = String(accessToken || "").trim();
    if (!token || token.length > 4_096) throw new Error("not_authorized");
    const { url, serviceRoleKey } = supabaseConfig();
    const userResponse = await fetchImpl(`${url}/auth/v1/user`, {
        headers: {
            apikey: serviceRoleKey,
            authorization: `Bearer ${token}`,
            accept: "application/json"
        }
    });
    if (!userResponse.ok) throw new Error("not_authorized");
    const user = await userResponse.json();
    if (!isUuid(user?.id)) throw new Error("not_authorized");

    const parameters = new URLSearchParams({
        user_id: `eq.${user.id}`,
        select: "user_id",
        limit: "1"
    });
    const rows = await supabaseRequest(`/rest/v1/work_admins?${parameters}`, {}, fetchImpl);
    if (!Array.isArray(rows) || !rows[0]) throw new Error("not_authorized");
    return user;
};

const encodeWord = (value) => `=?UTF-8?B?${Buffer.from(cleanHeader(value, 240), "utf8").toString("base64")}?=`;

const encodeBase64Lines = (value) => {
    const encoded = Buffer.from(String(value || ""), "utf8").toString("base64");
    return encoded.match(/.{1,76}/gu)?.join("\r\n") || "";
};

const buildRawMessage = ({ to, subject, body, messageType, config = mailConfig() }) => {
    const recipient = cleanHeader(to);
    const safeSubject = cleanHeader(subject, 240);
    const customerMessage = isCustomerMessageType(messageType);
    const safeBody = customerMessage
        ? normalizeCustomerBody(body, config.signature)
        : cleanBody(body);
    const senderAddress = customerMessage ? OFFICIAL_EMAIL : cleanHeader(config.senderAddress);
    const replyTo = customerMessage ? OFFICIAL_EMAIL : cleanHeader(config.replyTo);
    const lines = [
        `From: ${encodeWord(config.senderName)} <${senderAddress}>`,
        `To: ${recipient}`,
        `Reply-To: ${replyTo}`,
        `Subject: ${encodeWord(safeSubject)}`,
        "MIME-Version: 1.0"
    ];
    if (customerMessage) {
        const boundary = `ara-tech-${crypto.randomBytes(18).toString("hex")}`;
        lines.push(
            `Content-Type: multipart/alternative; boundary="${boundary}"`,
            "",
            `--${boundary}`,
            "Content-Type: text/plain; charset=UTF-8",
            "Content-Transfer-Encoding: 8bit",
            "",
            safeBody,
            `--${boundary}`,
            "Content-Type: text/html; charset=UTF-8",
            "Content-Transfer-Encoding: base64",
            "",
            encodeBase64Lines(buildCustomerHtml(safeBody)),
            `--${boundary}--`,
            ""
        );
    } else {
        lines.push(
            "Content-Type: text/plain; charset=UTF-8",
            "Content-Transfer-Encoding: 8bit",
            "",
            safeBody
        );
    }
    return Buffer.from(lines.join("\r\n"), "utf8")
        .toString("base64")
        .replace(/\+/gu, "-")
        .replace(/\//gu, "_")
        .replace(/=+$/gu, "");
};

const getGmailAccessToken = async (config = mailConfig(), fetchImpl = fetch) => {
    const response = await fetchImpl("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            client_id: config.clientId,
            client_secret: config.clientSecret,
            refresh_token: config.refreshToken,
            grant_type: "refresh_token"
        }).toString()
    });
    if (!response.ok) throw new Error(`gmail_oauth_${response.status}`);
    const payload = await response.json();
    if (!payload?.access_token) throw new Error("gmail_oauth_invalid");
    return payload.access_token;
};

const sendGmail = async ({ to, subject, body, messageType }, fetchImpl = fetch) => {
    const config = mailConfig();
    const accessToken = await getGmailAccessToken(config, fetchImpl);
    const response = await fetchImpl("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
        method: "POST",
        headers: {
            authorization: `Bearer ${accessToken}`,
            "content-type": "application/json",
            accept: "application/json"
        },
        body: JSON.stringify({ raw: buildRawMessage({ to, subject, body, messageType, config }) })
    });
    if (!response.ok) throw new Error(`gmail_send_${response.status}`);
    const payload = await response.json();
    if (!payload?.id) throw new Error("gmail_send_invalid");
    return { id: String(payload.id), threadId: payload.threadId ? String(payload.threadId) : null };
};

const insertDelivery = async (delivery, fetchImpl = fetch) => {
    if (!ALLOWED_TYPES.has(delivery.message_type)) throw new Error("invalid_message_type");
    const parameters = new URLSearchParams({
        on_conflict: "dedupe_key,attempt_number",
        select: "*"
    });
    const rows = await supabaseRequest(`/rest/v1/pa_email_deliveries?${parameters}`, {
        method: "POST",
        prefer: "return=representation,resolution=ignore-duplicates",
        body: JSON.stringify(delivery)
    }, fetchImpl);
    if (Array.isArray(rows) && rows[0]) return { row: rows[0], created: true };

    const lookup = new URLSearchParams({
        dedupe_key: `eq.${delivery.dedupe_key}`,
        attempt_number: `eq.${delivery.attempt_number}`,
        select: "*",
        limit: "1"
    });
    const existing = await supabaseRequest(`/rest/v1/pa_email_deliveries?${lookup}`, {}, fetchImpl);
    if (!Array.isArray(existing) || !existing[0]) throw new Error("delivery_not_found");
    return { row: existing[0], created: false };
};

const updateDelivery = async (deliveryId, patch, fetchImpl = fetch) => {
    const parameters = new URLSearchParams({ id: `eq.${deliveryId}`, select: "*" });
    const rows = await supabaseRequest(`/rest/v1/pa_email_deliveries?${parameters}`, {
        method: "PATCH",
        prefer: "return=representation",
        body: JSON.stringify(patch)
    }, fetchImpl);
    if (!Array.isArray(rows) || !rows[0]) throw new Error("delivery_update_failed");
    return rows[0];
};

const safeErrorCode = (error) => {
    const message = String(error?.message || "");
    if (/^(gmail_not_configured|gmail_oauth_(?:\d{3}|invalid)|gmail_send_(?:\d{3}|invalid))$/u.test(message)) {
        return message;
    }
    if (/^supabase_\d{3}$/u.test(message)) return message;
    return "mail_delivery_failed";
};

const deliver = async (row, fetchImpl = fetch) => {
    try {
        const gmail = await sendGmail({
            to: row.recipient,
            subject: row.subject,
            body: row.body,
            messageType: row.message_type
        }, fetchImpl);
        return updateDelivery(row.id, {
            status: "sent",
            sent_at: new Date().toISOString(),
            failed_at: null,
            gmail_message_id: gmail.id,
            gmail_thread_id: gmail.threadId,
            error_summary: null
        }, fetchImpl);
    } catch (error) {
        const code = safeErrorCode(error);
        try {
            return await updateDelivery(row.id, {
                status: "failed",
                failed_at: new Date().toISOString(),
                gmail_message_id: null,
                gmail_thread_id: null,
                error_summary: code
            }, fetchImpl);
        } catch {
            const wrapped = new Error(code);
            wrapped.deliveryId = row.id;
            throw wrapped;
        }
    }
};

const createAndDeliver = async (delivery, fetchImpl = fetch) => {
    const body = isCustomerMessageType(delivery.message_type)
        ? normalizeCustomerBody(delivery.body)
        : cleanBody(delivery.body);
    const result = await insertDelivery({
        ...delivery,
        recipient: cleanHeader(delivery.recipient),
        subject: cleanHeader(delivery.subject, 240),
        body,
        status: "sending",
        requested_at: new Date().toISOString()
    }, fetchImpl);
    if (!result.created) return result.row;
    return deliver(result.row, fetchImpl);
};

const customerReceiptTemplate = (inquiry) => ({
    subject: `【ARA-TECH】PA予約のお問い合わせを受け付けました／受付番号${inquiry.inquiry_number}`,
    body: normalizeCustomerBody([
        `${inquiry.contact_name || inquiry.customer_name}様`,
        "",
        "このたびはARA-TECHへお問い合わせいただき、ありがとうございます。",
        "以下の内容でお問い合わせを受け付けました。",
        "",
        `受付番号：${inquiry.inquiry_number}`,
        `開催希望日：${formatDate(inquiry.event_date)}`,
        `会場・開催場所：${inquiry.venue || "未設定"}`,
        "",
        "内容を確認後、ARA-TECHより改めてご連絡いたします。",
        "",
        "このメールはお問い合わせの受付をお知らせするものであり、",
        "予約の確定や開催日の確保を保証するものではありません。",
        "",
        "お問い合わせ内容に心当たりがない場合や、内容の訂正がある場合は、",
        "このメールへご返信ください。",
        ""
    ].join("\n"))
});

const internalNotificationTemplate = (inquiry, signature) => ({
    subject: `【PA予約受付】新規問い合わせ／受付番号${inquiry.inquiry_number}`,
    body: [
        "PA予約・お問い合わせフォーム（初回受付）に新しい問い合わせが登録されました。",
        "",
        `受付番号：${inquiry.inquiry_number}`,
        `受付日時：${formatDateTime(inquiry.received_at)}`,
        `イベント担当者名：${inquiry.contact_name || inquiry.customer_name}`,
        `連絡先メールアドレス：${inquiry.email}`,
        `開催希望日：${formatDate(inquiry.event_date)}`,
        `会場・開催場所：${inquiry.venue || "未設定"}`,
        `問い合わせ概要：${String(inquiry.request_summary || "未入力").slice(0, 1_200)}`,
        "",
        "PA予約受付管理ページ",
        ADMIN_URL,
        "",
        signature
    ].join("\n")
});

const scheduleResponseTemplates = (inquiry, response, signature = configuredSignature()) => {
    const customerName = inquiry.contact_name || inquiry.customer_name;
    const caseSummary = [
        `受付番号：${inquiry.inquiry_number}`,
        `開催希望日：${formatDate(inquiry.event_date)}`,
        `会場・開催場所：${inquiry.venue || "未設定"}`
    ];
    const internalSummary = [
        `受付番号：${inquiry.inquiry_number}`,
        `お客様名：${customerName}`,
        `開催希望日：${formatDate(inquiry.event_date)}`,
        `会場・開催場所：${inquiry.venue || "未設定"}`,
        `回答日時：${formatDateTime(response.submitted_at)}`
    ];
    const caseUrl = adminCaseUrl(inquiry);

    if (response.decision === "agree") {
        return [
            {
                message_type: "schedule_response_agree_customer",
                recipient: inquiry.email,
                subject: `【ARA-TECH】日程調整のご依頼を受け付けました／受付番号${inquiry.inquiry_number}`,
                body: normalizeCustomerBody([
                    `${customerName} 様`,
                    "",
                    "日程確保フォームからの日程調整依頼を受け付けました。",
                    ...caseSummary,
                    "",
                    "ARA-TECHがこれから既存予定の調整を行います。",
                    "ARA-TECHから「日程確保完了」の連絡が届くまでは、予約・日程確保ともに未確定です。",
                    "",
                    "確認事項や追加のご連絡がある場合は、このメールへご返信ください。",
                    ""
                ].join("\n"))
            },
            {
                message_type: "schedule_response_agree_internal",
                recipient: String(process.env.GMAIL_NOTIFICATION_ADDRESS || "").trim(),
                subject: `【PA日程調整依頼】回答を受信／受付番号${inquiry.inquiry_number}`,
                body: [
                    "お客様から日程調整依頼が届きました。",
                    "",
                    ...internalSummary,
                    "",
                    "該当案件を開く",
                    caseUrl,
                    "",
                    signature
                ].join("\n")
            }
        ];
    }

    if (response.decision === "question") {
        return [
            {
                message_type: "schedule_response_question_customer",
                recipient: inquiry.email,
                subject: `【ARA-TECH】ご質問を受け付けました／受付番号${inquiry.inquiry_number}`,
                body: normalizeCustomerBody([
                    `${customerName} 様`,
                    "",
                    "日程確保フォームからのご質問を受け付けました。",
                    ...caseSummary,
                    "",
                    "内容を確認後、ARA-TECHから回答いたします。",
                    "追加のご連絡がある場合は、このメールへご返信ください。",
                    ""
                ].join("\n"))
            },
            {
                message_type: "schedule_response_question_internal",
                recipient: String(process.env.GMAIL_NOTIFICATION_ADDRESS || "").trim(),
                subject: `【PA確認事項】お客様から質問を受信／受付番号${inquiry.inquiry_number}`,
                body: [
                    "お客様から確認事項が届きました。",
                    "",
                    ...internalSummary,
                    "",
                    "質問内容",
                    String(response.question_details || "内容なし").slice(0, 5_000),
                    "",
                    "該当案件を開く",
                    caseUrl,
                    "",
                    signature
                ].join("\n")
            }
        ];
    }

    if (response.decision === "decline") {
        return [
            {
                message_type: "schedule_response_decline_customer",
                recipient: inquiry.email,
                subject: `【ARA-TECH】見送りの回答を受け付けました／受付番号${inquiry.inquiry_number}`,
                body: normalizeCustomerBody([
                    `${customerName} 様`,
                    "",
                    "日程確保フォームから、日程調整を依頼しない旨の回答を受け付けました。",
                    ...caseSummary,
                    "",
                    "この回答によって、予約や日程確保が行われることはありません。",
                    "確認事項がある場合は、このメールへご返信ください。",
                    ""
                ].join("\n"))
            },
            {
                message_type: "schedule_response_decline_internal",
                recipient: String(process.env.GMAIL_NOTIFICATION_ADDRESS || "").trim(),
                subject: `【PA見送り】日程調整を依頼しない回答／受付番号${inquiry.inquiry_number}`,
                body: [
                    "お客様が日程調整を依頼しないと回答しました。",
                    "",
                    ...internalSummary,
                    `案件概要：${String(inquiry.request_summary || "未入力").slice(0, 1_200)}`,
                    "",
                    "該当案件を開く",
                    caseUrl,
                    "",
                    signature
                ].join("\n")
            }
        ];
    }

    throw new Error("invalid_schedule_decision");
};

const sendScheduleResponseEmails = async (inquiry, response, fetchImpl = fetch) => {
    const signature = configuredSignature();
    const templates = scheduleResponseTemplates(inquiry, response, signature);
    return Promise.all(templates.map(async (template) => {
        if (!template.recipient) {
            return {
                message_type: template.message_type,
                status: "failed",
                error_summary: "gmail_not_configured"
            };
        }
        try {
            return await createAndDeliver({
                inquiry_id: inquiry.id,
                message_type: template.message_type,
                dedupe_key: `response:${response.id}:${template.message_type}`,
                attempt_number: 1,
                is_retry: false,
                ...template
            }, fetchImpl);
        } catch (error) {
            return {
                message_type: template.message_type,
                status: "failed",
                error_summary: safeErrorCode(error)
            };
        }
    }));
};

const submitScheduleResponseAndNotify = async ({
    token,
    response,
    submissionKey
}, fetchImpl = fetch) => {
    const safeToken = String(token || "").trim();
    if (!/^[A-Za-z0-9_-]{43,128}$/u.test(safeToken) || !isUuid(submissionKey)) {
        throw new Error("invalid_submission");
    }
    if (!response || Array.isArray(response) || typeof response !== "object") {
        throw new Error("invalid_submission");
    }

    const rows = await supabaseRequest("/rest/v1/rpc/submit_pa_schedule_response", {
        method: "POST",
        body: JSON.stringify({
            p_token: safeToken,
            p_response: response,
            p_submission_key: submissionKey
        })
    }, fetchImpl);
    const result = rows?.[0];
    if (!result || result.result !== "accepted") {
        return {
            result: result?.result || "invalid",
            submitted_at: result?.submitted_at || null,
            deliveries: []
        };
    }

    const storedResponse = await getScheduleResponseBySubmissionKey(submissionKey, fetchImpl);
    const inquiry = await getInquiry(storedResponse.inquiry_id, fetchImpl);
    const deliveries = await sendScheduleResponseEmails(inquiry, storedResponse, fetchImpl);
    return {
        result: "accepted",
        submitted_at: result.submitted_at || storedResponse.submitted_at,
        inquiry_number: inquiry.inquiry_number,
        deliveries
    };
};

const sendAutomaticInquiryEmails = async (inquiry, fetchImpl = fetch) => {
    const signature = configuredSignature();
    const notificationAddress = String(process.env.GMAIL_NOTIFICATION_ADDRESS || "").trim();
    const customer = customerReceiptTemplate(inquiry);
    const internal = internalNotificationTemplate(inquiry, signature);
    const deliveries = [
        {
            inquiry_id: inquiry.id,
            message_type: "customer_receipt",
            dedupe_key: `auto:${inquiry.id}:customer_receipt`,
            attempt_number: 1,
            is_retry: false,
            recipient: inquiry.email,
            ...customer
        },
        {
            inquiry_id: inquiry.id,
            message_type: "internal_new_inquiry",
            dedupe_key: `auto:${inquiry.id}:internal_new_inquiry`,
            attempt_number: 1,
            is_retry: false,
            recipient: notificationAddress,
            ...internal
        }
    ];
    return Promise.all(deliveries.map(async (delivery) => {
        if (!delivery.recipient) {
            return {
                message_type: delivery.message_type,
                status: "failed",
                error_summary: "gmail_not_configured"
            };
        }
        try {
            return await createAndDeliver(delivery, fetchImpl);
        } catch (error) {
            return {
                message_type: delivery.message_type,
                status: "failed",
                error_summary: safeErrorCode(error)
            };
        }
    }));
};

const createScheduleDelivery = async ({
    inquiry,
    subject,
    body,
    scheduleUrl,
    operationKey,
    actorUserId
}, fetchImpl = fetch) => {
    if (!isUuid(operationKey) || !isUuid(actorUserId)) throw new Error("invalid_operation");
    const safeUrl = String(scheduleUrl || "").trim();
    if (!/^https:\/\/ara-tech\.cc\/pa-schedule-confirm\.html\?token=[A-Za-z0-9_-]{43,128}$/u.test(safeUrl)) {
        throw new Error("invalid_schedule_url");
    }
    const safeSubject = cleanHeader(subject, 240);
    const safeBodyInput = cleanBody(body);
    const safeBody = normalizeCustomerBody(safeBodyInput);
    if (!safeSubject.includes(inquiry.inquiry_number) || !safeBody.includes(safeUrl)) {
        throw new Error("invalid_schedule_message");
    }
    return createAndDeliver({
        inquiry_id: inquiry.id,
        message_type: "schedule_request",
        dedupe_key: `schedule:${inquiry.id}:${operationKey.toLowerCase()}`,
        attempt_number: 1,
        is_retry: false,
        recipient: inquiry.email,
        subject: safeSubject,
        body: safeBody,
        created_by: actorUserId
    }, fetchImpl);
};

const assertCustomerMessageSafe = (subject, body) => {
    const text = `${subject}\n${body}`;
    if (
        /pa-admin(?:\.html)?|[?&]token=|内部ID|内部メモ|OAuth|client[_ -]?secret|refresh[_ -]?token/iu.test(text)
        || /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/iu.test(text)
    ) {
        throw new Error("unsafe_customer_message");
    }
};

const createScheduleResultDelivery = async ({
    inquiry,
    result,
    subject,
    body,
    actorUserId
}, fetchImpl = fetch) => {
    if (!isUuid(actorUserId)) throw new Error("invalid_operation");
    if (!["confirmed", "unavailable"].includes(result)) throw new Error("invalid_schedule_result");

    const response = await getScheduleResponseByInquiry(inquiry.id, fetchImpl);
    if (response.decision !== "agree") throw new Error("result_not_allowed");

    const targetStatus = result === "confirmed" ? "schedule_confirmed" : "schedule_unavailable";
    if (![targetStatus, "schedule_adjusting"].includes(inquiry.status)) {
        throw new Error("result_not_allowed");
    }

    const safeSubject = cleanHeader(subject, 240);
    const safeBodyInput = cleanBody(body);
    assertCustomerMessageSafe(safeSubject, safeBodyInput);
    if (!safeSubject.includes(inquiry.inquiry_number) || !safeBodyInput.includes(inquiry.inquiry_number)) {
        throw new Error("invalid_result_message");
    }
    if (result === "confirmed" && !(
        safeBodyInput.includes("見積")
        && safeBodyInput.includes("契約")
        && safeBodyInput.includes("正式予約")
    )) {
        throw new Error("invalid_result_message");
    }
    if (result === "unavailable" && !/日程を確保でき(?:ませんでした|なかった)/u.test(safeBodyInput)) {
        throw new Error("invalid_result_message");
    }

    const safeBody = normalizeCustomerBody(safeBodyInput);
    const messageType = result === "confirmed"
        ? "schedule_result_confirmed"
        : "schedule_result_unavailable";

    return createAndDeliver({
        inquiry_id: inquiry.id,
        message_type: messageType,
        dedupe_key: `schedule-result:${inquiry.id}:${result}`,
        attempt_number: 1,
        is_retry: false,
        recipient: inquiry.email,
        subject: safeSubject,
        body: safeBody,
        created_by: actorUserId
    }, fetchImpl);
};

const finalizeScheduleResult = async ({ inquiryId, delivery, result }, fetchImpl = fetch) => {
    if (!isUuid(inquiryId) || !isUuid(delivery?.id) || delivery.status !== "sent") {
        throw new Error("result_delivery_not_sent");
    }
    const rows = await supabaseRequest("/rest/v1/rpc/finalize_pa_schedule_result", {
        method: "POST",
        body: JSON.stringify({
            p_inquiry_id: inquiryId,
            p_delivery_id: delivery.id,
            p_result: result
        })
    }, fetchImpl);
    if (!Array.isArray(rows) || !rows[0]) throw new Error("result_transition_failed");
    return rows[0];
};

const resultForMessageType = (messageType) => {
    if (messageType === "schedule_result_confirmed") return "confirmed";
    if (messageType === "schedule_result_unavailable") return "unavailable";
    return null;
};

const sendScheduleResultAndFinalize = async ({
    inquiry,
    result,
    subject,
    body,
    actorUserId
}, fetchImpl = fetch) => {
    const delivery = await createScheduleResultDelivery({
        inquiry,
        result,
        subject,
        body,
        actorUserId
    }, fetchImpl);
    const caseState = delivery.status === "sent"
        ? await finalizeScheduleResult({ inquiryId: inquiry.id, delivery, result }, fetchImpl)
        : null;
    return { delivery, caseState };
};

const getDelivery = async (deliveryId, fetchImpl = fetch) => {
    if (!isUuid(deliveryId)) throw new Error("invalid_delivery");
    const parameters = new URLSearchParams({ id: `eq.${deliveryId}`, select: "*", limit: "1" });
    const rows = await supabaseRequest(`/rest/v1/pa_email_deliveries?${parameters}`, {}, fetchImpl);
    if (!Array.isArray(rows) || !rows[0]) throw new Error("delivery_not_found");
    return rows[0];
};

const retryDelivery = async ({ deliveryId, inquiry, actorUserId }, fetchImpl = fetch) => {
    if (!isUuid(actorUserId)) throw new Error("invalid_operation");
    const previous = await getDelivery(deliveryId, fetchImpl);
    if (previous.inquiry_id !== inquiry.id || previous.status !== "failed") throw new Error("retry_not_allowed");

    const successLookup = new URLSearchParams({
        dedupe_key: `eq.${previous.dedupe_key}`,
        status: "eq.sent",
        select: "id",
        limit: "1"
    });
    const successes = await supabaseRequest(`/rest/v1/pa_email_deliveries?${successLookup}`, {}, fetchImpl);
    if (Array.isArray(successes) && successes[0]) throw new Error("retry_not_allowed");

    const parameters = new URLSearchParams({
        dedupe_key: `eq.${previous.dedupe_key}`,
        select: "attempt_number",
        order: "attempt_number.desc",
        limit: "1"
    });
    const attempts = await supabaseRequest(`/rest/v1/pa_email_deliveries?${parameters}`, {}, fetchImpl);
    const attemptNumber = Number(attempts?.[0]?.attempt_number || 0) + 1;
    return createAndDeliver({
        inquiry_id: inquiry.id,
        message_type: previous.message_type,
        dedupe_key: previous.dedupe_key,
        attempt_number: attemptNumber,
        is_retry: true,
        retry_of: previous.id,
        recipient: previous.recipient,
        subject: previous.subject,
        body: previous.body,
        created_by: actorUserId
    }, fetchImpl);
};

module.exports = {
    ADMIN_URL,
    AUTOMATIC_TYPES,
    CUSTOMER_FOOTER_TEXT,
    CUSTOMER_FOOTER_TEXT_WITHOUT_REFERENCE,
    CUSTOMER_MESSAGE_TYPES,
    LINE_ADD_URL,
    LINE_CTA_LABEL,
    LINE_GUIDE_WITH_REFERENCE,
    LINE_GUIDE_WITHOUT_REFERENCE,
    LINE_QR_IMAGE_URL,
    LINE_QR_TARGET_URL,
    OFFICIAL_EMAIL,
    SITE_URL,
    SCHEDULE_RESPONSE_TYPES,
    SCHEDULE_RESULT_TYPES,
    adminCaseUrl,
    assertCustomerMessageSafe,
    buildCustomerHtml,
    buildRawMessage,
    cleanBody,
    cleanHeader,
    createAndDeliver,
    createScheduleDelivery,
    createScheduleResultDelivery,
    customerReceiptTemplate,
    deliver,
    finalizeScheduleResult,
    formatDate,
    formatDateTime,
    getDelivery,
    getGmailAccessToken,
    getInquiry,
    getScheduleResponseByInquiry,
    getScheduleResponseBySubmissionKey,
    insertDelivery,
    internalNotificationTemplate,
    isUuid,
    isCustomerMessageType,
    mailConfig,
    normalizeCustomerBody,
    resultForMessageType,
    retryDelivery,
    safeErrorCode,
    sendAutomaticInquiryEmails,
    sendGmail,
    sendScheduleResponseEmails,
    sendScheduleResultAndFinalize,
    scheduleResponseTemplates,
    submitScheduleResponseAndNotify,
    supabaseRequest,
    updateDelivery,
    verifyAdmin
};
