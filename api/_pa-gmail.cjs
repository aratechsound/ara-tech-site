const crypto = require("node:crypto");
const {
    OFFICIAL_EMAIL,
    buildRawMessage,
    cleanBody,
    cleanHeader,
    getGmailAccessToken,
    getInquiry,
    isUuid,
    mailConfig,
    normalizeCustomerBody,
    supabaseRequest
} = require("./_pa-mail.cjs");

const GMAIL_ID = /^[A-Za-z0-9_-]{1,200}$/u;
const EMAIL = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/u;
const PREVIEW_TTL_MS = 10 * 60 * 1000;

const validGmailId = (value) => GMAIL_ID.test(String(value || ""));
const caseReference = (value) => /^PA-\d{8}-\d{5}$/u.test(String(value || ""));
const safeAddress = (value) => String(value || "").trim().match(/<?([^<>\s,;]+@[^<>\s,;]+)>?/u)?.[1] || "";
const addressList = (value) => String(value || "").split(",")
    .map(safeAddress).filter((address) => EMAIL.test(address)).slice(0, 30);

const gmailJson = async (path, options = {}, fetchImpl = fetch) => {
    const token = await getGmailAccessToken(mailConfig(), fetchImpl);
    const response = await fetchImpl(`https://gmail.googleapis.com/gmail/v1/users/me${path}`, {
        ...options,
        headers: {
            authorization: `Bearer ${token}`,
            accept: "application/json",
            ...(options.headers || {})
        }
    });
    if (!response.ok) throw new Error(`gmail_read_${response.status}`);
    return response.json();
};

const gmailMessage = (id, fetchImpl) => gmailJson(
    `/messages/${encodeURIComponent(id)}?format=full`, {}, fetchImpl
);
const gmailThread = (id, fetchImpl) => gmailJson(
    `/threads/${encodeURIComponent(id)}?format=full`, {}, fetchImpl
);

const headerMap = (message) => Object.fromEntries(
    (message?.payload?.headers || []).map((header) => [String(header.name || "").toLowerCase(), String(header.value || "")])
);
const decodeBase64Url = (value) => {
    try {
        return Buffer.from(String(value || "").replace(/-/gu, "+").replace(/_/gu, "/"), "base64").toString("utf8");
    } catch {
        return "";
    }
};
const htmlToText = (value) => String(value || "")
    .replace(/<\/(?:p|div|tr|li|br|h[1-6])\s*>/giu, "\n")
    .replace(/<script[\s\S]*?<\/script\s*>/giu, "")
    .replace(/<style[\s\S]*?<\/style\s*>/giu, "")
    .replace(/<[^>]*>/gu, " ")
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
const collectParts = (part, result = { plain: "", html: "", attachments: [] }) => {
    if (!part || typeof part !== "object") return result;
    const mime = String(part.mimeType || "").toLowerCase();
    if (part.filename && part.body?.attachmentId) {
        result.attachments.push({
            id: String(part.body.attachmentId),
            filename: String(part.filename).replace(/[\u0000-\u001f\\/]/gu, "_").slice(0, 255),
            mime_type: mime || "application/octet-stream",
            size: Number(part.body.size || 0)
        });
    }
    if (part.body?.data) {
        if (mime === "text/plain") result.plain += decodeBase64Url(part.body.data);
        if (mime === "text/html") result.html += decodeBase64Url(part.body.data);
    }
    (part.parts || []).forEach((child) => collectParts(child, result));
    return result;
};

const attachmentPart = (part, attachmentId) => {
    if (!part || typeof part !== "object") return null;
    if (String(part.body?.attachmentId || "") === attachmentId) return part;
    for (const child of part.parts || []) {
        const found = attachmentPart(child, attachmentId);
        if (found) return found;
    }
    return null;
};

const normalizeMessage = (message) => {
    const headers = headerMap(message);
    const parts = collectParts(message?.payload);
    const from = safeAddress(headers.from);
    const sender = from.toLowerCase();
    const official = OFFICIAL_EMAIL.toLowerCase();
    const timestamp = Number(message?.internalDate || 0);
    const occurredAt = Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp).toISOString() : null;
    return {
        id: String(message?.id || ""),
        thread_id: String(message?.threadId || ""),
        direction: sender === official ? "outbound" : "inbound",
        from_address: from || "unknown@invalid.local",
        to_addresses: addressList(headers.to),
        cc_addresses: addressList(headers.cc),
        reply_to: safeAddress(headers["reply-to"]),
        subject: String(headers.subject || "").replace(/[\r\n]/gu, " ").slice(0, 500),
        occurred_at: occurredAt,
        body_text: String(parts.plain || htmlToText(parts.html)).slice(0, 50_000),
        attachments: parts.attachments.slice(0, 100),
        rfc_message_id: String(headers["message-id"] || "").trim()
    };
};

const selectRows = (table, query, fetchImpl) => supabaseRequest(`/rest/v1/${table}?${query}`, {}, fetchImpl);
const getLink = async (inquiryId, fetchImpl) => {
    const query = new URLSearchParams({ inquiry_id: `eq.${inquiryId}`, select: "*", limit: "1" });
    const rows = await selectRows("pa_gmail_thread_links", query, fetchImpl);
    return Array.isArray(rows) ? rows[0] || null : null;
};
const getGlobalThreadLink = async (threadId, fetchImpl) => {
    const query = new URLSearchParams({ gmail_thread_id: `eq.${threadId}`, select: "*", limit: "1" });
    const rows = await selectRows("pa_gmail_thread_links", query, fetchImpl);
    return Array.isArray(rows) ? rows[0] || null : null;
};
const writeRow = (table, values, conflict, fetchImpl) => {
    const query = new URLSearchParams({ on_conflict: conflict, select: "*" });
    return supabaseRequest(`/rest/v1/${table}?${query}`, {
        method: "POST",
        prefer: "return=representation,resolution=merge-duplicates",
        body: JSON.stringify(values)
    }, fetchImpl);
};
const audit = (inquiryId, actorId, action, details, fetchImpl) => supabaseRequest("/rest/v1/pa_inquiry_audit", {
    method: "POST",
    prefer: "return=minimal",
    body: JSON.stringify({ inquiry_id: inquiryId, actor_user_id: actorId, action, details })
}, fetchImpl);

const linkThread = async ({ inquiryId, threadId, source, actorId }, fetchImpl) => {
    if (!isUuid(inquiryId) || !validGmailId(threadId)) throw new Error("invalid_gmail_thread");
    const existing = await getGlobalThreadLink(threadId, fetchImpl);
    if (existing && existing.inquiry_id !== inquiryId) throw new Error("ambiguous_thread_link");
    const rows = await writeRow("pa_gmail_thread_links", {
        inquiry_id: inquiryId,
        gmail_thread_id: threadId,
        link_source: source,
        linked_by: actorId
    }, "gmail_thread_id", fetchImpl);
    return Array.isArray(rows) ? rows[0] : null;
};

const deliveryThreadCandidates = async (inquiryId, fetchImpl) => {
    const query = new URLSearchParams({
        inquiry_id: `eq.${inquiryId}`,
        status: "eq.sent",
        select: "gmail_thread_id,gmail_message_id",
        limit: "100"
    });
    const rows = await selectRows("pa_email_deliveries", query, fetchImpl);
    return Array.isArray(rows) ? rows : [];
};
const resolveThread = async (inquiry, fetchImpl) => {
    const existing = await getLink(inquiry.id, fetchImpl);
    if (existing) return { link: existing, candidates: [] };

    const deliveries = await deliveryThreadCandidates(inquiry.id, fetchImpl);
    const directThreads = new Set(deliveries.map((row) => row.gmail_thread_id).filter(validGmailId));
    if (directThreads.size === 1) {
        const link = await linkThread({ inquiryId: inquiry.id, threadId: [...directThreads][0], source: "delivery_history" }, fetchImpl);
        return { link, candidates: [] };
    }
    const resolved = new Set();
    for (const delivery of deliveries) {
        if (!validGmailId(delivery.gmail_message_id)) continue;
        const message = await gmailMessage(delivery.gmail_message_id, fetchImpl);
        if (validGmailId(message.threadId)) resolved.add(message.threadId);
    }
    if (resolved.size === 1) {
        const link = await linkThread({ inquiryId: inquiry.id, threadId: [...resolved][0], source: "gmail_message_id" }, fetchImpl);
        return { link, candidates: [] };
    }
    if (!caseReference(inquiry.inquiry_number)) return { link: null, candidates: [] };
    const search = new URLSearchParams({ q: `"${inquiry.inquiry_number}"`, maxResults: "20" });
    const result = await gmailJson(`/messages?${search}`, {}, fetchImpl);
    const candidates = [...new Set((result.messages || []).map((row) => String(row.threadId || "")).filter(validGmailId))];
    if (candidates.length === 1) {
        const link = await linkThread({ inquiryId: inquiry.id, threadId: candidates[0], source: "case_reference" }, fetchImpl);
        return { link, candidates: [] };
    }
    return { link: null, candidates };
};

const indexThread = async ({ inquiryId, threadId, actorId }, fetchImpl) => {
    const thread = await gmailThread(threadId, fetchImpl);
    const messages = (thread.messages || []).map(normalizeMessage).filter((message) => validGmailId(message.id));
    for (const message of messages) {
        await writeRow("pa_gmail_message_index", {
            gmail_message_id: message.id,
            gmail_thread_id: threadId,
            inquiry_id: inquiryId,
            direction: message.direction,
            from_address: message.from_address,
            to_addresses: message.to_addresses,
            cc_addresses: message.cc_addresses,
            subject: message.subject,
            sent_at: message.direction === "outbound" ? message.occurred_at : null,
            received_at: message.direction === "inbound" ? message.occurred_at : null,
            attachment_metadata: message.attachments,
            indexed_at: new Date().toISOString()
        }, "gmail_message_id", fetchImpl);
    }
    const latest = [...messages].sort((a, b) => String(a.occurred_at || "").localeCompare(String(b.occurred_at || ""))).at(-1);
    const latestInbound = [...messages].filter((message) => message.direction === "inbound")
        .sort((a, b) => String(a.occurred_at || "").localeCompare(String(b.occurred_at || ""))).at(-1);
    const attention = latest?.direction === "inbound" ? "new_customer_reply" : messages.length ? "waiting_customer" : "none";
    await writeRow("pa_case_mail_attention", {
        inquiry_id: inquiryId,
        attention_state: attention,
        last_seen_inbound_at: latestInbound?.occurred_at || null,
        last_synced_at: new Date().toISOString(),
        last_sync_error: null,
        updated_at: new Date().toISOString()
    }, "inquiry_id", fetchImpl);
    await audit(inquiryId, actorId, "gmail_thread_synced", { gmail_thread_id: threadId, message_count: messages.length, attention_state: attention }, fetchImpl);
    return { messages, attention, synced_at: new Date().toISOString() };
};

const syncCase = async ({ inquiryId, actorId }, fetchImpl = fetch) => {
    const inquiry = await getInquiry(inquiryId, fetchImpl);
    const resolved = await resolveThread(inquiry, fetchImpl);
    if (!resolved.link) return { linked: false, ambiguous: resolved.candidates.length > 1, candidates: resolved.candidates, messages: [] };
    const indexed = await indexThread({ inquiryId, threadId: resolved.link.gmail_thread_id, actorId }, fetchImpl);
    return { linked: true, link: resolved.link, ...indexed };
};

const getAttachment = async ({ inquiryId, gmailMessageId, gmailAttachmentId }, fetchImpl = fetch) => {
    if (!isUuid(inquiryId) || !validGmailId(gmailMessageId) || !validGmailId(gmailAttachmentId)) throw new Error("invalid_gmail_attachment");
    const query = new URLSearchParams({ inquiry_id: `eq.${inquiryId}`, gmail_message_id: `eq.${gmailMessageId}`, select: "gmail_message_id", limit: "1" });
    const indexed = await selectRows("pa_gmail_message_index", query, fetchImpl);
    if (!Array.isArray(indexed) || !indexed[0]) throw new Error("gmail_attachment_not_indexed");
    const message = await gmailMessage(gmailMessageId, fetchImpl);
    const part = attachmentPart(message.payload, gmailAttachmentId);
    if (!part?.body?.attachmentId) throw new Error("gmail_attachment_not_found");
    const payload = await gmailJson(`/messages/${encodeURIComponent(gmailMessageId)}/attachments/${encodeURIComponent(gmailAttachmentId)}`, {}, fetchImpl);
    const data = String(payload?.data || "");
    const byteLength = Buffer.from(data.replace(/-/gu, "+").replace(/_/gu, "/"), "base64").length;
    if (!data || byteLength > 10 * 1024 * 1024) throw new Error("gmail_attachment_unavailable");
    return {
        filename: String(part.filename || "attachment").replace(/[\u0000-\u001f\\/]/gu, "_").slice(0, 255),
        mime_type: String(part.mimeType || "application/octet-stream").slice(0, 200),
        data
    };
};

const manualLink = async ({ inquiryId, gmailThreadId, actorId }, fetchImpl = fetch) => {
    if (!validGmailId(gmailThreadId)) throw new Error("invalid_gmail_thread");
    await gmailThread(gmailThreadId, fetchImpl);
    const link = await linkThread({ inquiryId, threadId: gmailThreadId, source: "manual", actorId }, fetchImpl);
    await audit(inquiryId, actorId, "gmail_thread_linked_manual", { gmail_thread_id: gmailThreadId, link_source: "manual" }, fetchImpl);
    return syncCase({ inquiryId, actorId }, fetchImpl);
};

const previewSecret = () => String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
const replyPreviewToken = ({ inquiryId, actorId, threadId, recipient, subject, body, expiresAt }) => {
    const payload = JSON.stringify({ inquiryId, actorId, threadId, recipient, subject, bodyHash: crypto.createHash("sha256").update(body).digest("hex"), expiresAt });
    const signature = crypto.createHmac("sha256", previewSecret()).update(payload).digest("base64url");
    return Buffer.from(payload).toString("base64url") + "." + signature;
};
const verifyPreviewToken = (token, fields) => {
    const [encoded, signature] = String(token || "").split(".");
    if (!encoded || !signature) throw new Error("invalid_confirmation");
    const payload = Buffer.from(encoded, "base64url").toString("utf8");
    const expected = crypto.createHmac("sha256", previewSecret()).update(payload).digest("base64url");
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw new Error("invalid_confirmation");
    const values = JSON.parse(payload);
    const bodyHash = crypto.createHash("sha256").update(fields.body).digest("hex");
    if (Date.now() > Number(values.expiresAt) || values.inquiryId !== fields.inquiryId || values.actorId !== fields.actorId
        || values.threadId !== fields.threadId || values.recipient !== fields.recipient || values.subject !== fields.subject || values.bodyHash !== bodyHash) {
        throw new Error("invalid_confirmation");
    }
};

const replyPreview = async ({ inquiryId, actorId, body }, fetchImpl = fetch) => {
    const link = await getLink(inquiryId, fetchImpl);
    if (!link) throw new Error("gmail_thread_not_linked");
    const thread = await gmailThread(link.gmail_thread_id, fetchImpl);
    const messages = (thread.messages || []).map(normalizeMessage);
    const latest = [...messages].sort((a, b) => String(a.occurred_at || "").localeCompare(String(b.occurred_at || ""))).at(-1);
    const recipient = safeAddress(latest?.reply_to || latest?.from_address);
    if (!EMAIL.test(recipient) || latest?.direction !== "inbound") throw new Error("reply_target_unavailable");
    const subject = cleanHeader(latest.subject, 240);
    const normalizedBody = normalizeCustomerBody(cleanBody(body));
    const expiresAt = Date.now() + PREVIEW_TTL_MS;
    return {
        inquiry_id: inquiryId,
        gmail_thread_id: link.gmail_thread_id,
        recipient,
        subject,
        body: normalizedBody,
        confirmation_token: replyPreviewToken({ inquiryId, actorId, threadId: link.gmail_thread_id, recipient, subject, body: normalizedBody, expiresAt }),
        expires_at: new Date(expiresAt).toISOString()
    };
};

const sendReply = async ({ inquiryId, actorId, body, confirmationToken }, fetchImpl = fetch) => {
    const preview = await replyPreview({ inquiryId, actorId, body }, fetchImpl);
    verifyPreviewToken(confirmationToken, { inquiryId, actorId, threadId: preview.gmail_thread_id, recipient: preview.recipient, subject: preview.subject, body: preview.body });
    const thread = await gmailThread(preview.gmail_thread_id, fetchImpl);
    const latest = (thread.messages || []).map(normalizeMessage)
        .sort((a, b) => String(a.occurred_at || "").localeCompare(String(b.occurred_at || ""))).at(-1);
    const config = mailConfig();
    const token = await getGmailAccessToken(config, fetchImpl);
    const response = await fetchImpl("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
            threadId: preview.gmail_thread_id,
            raw: buildRawMessage({
                to: preview.recipient,
                subject: preview.subject,
                body: preview.body,
                messageType: "customer_receipt",
                replyHeaders: { inReplyTo: latest?.rfc_message_id, references: latest?.rfc_message_id },
                config
            })
        })
    });
    if (!response.ok) throw new Error(`gmail_send_${response.status}`);
    const sent = await response.json();
    if (!validGmailId(sent?.id)) throw new Error("gmail_send_invalid");
    await audit(inquiryId, actorId, "gmail_case_reply_sent", { gmail_thread_id: preview.gmail_thread_id, gmail_message_id: sent.id }, fetchImpl);
    const synced = await syncCase({ inquiryId, actorId }, fetchImpl);
    return { gmail_message_id: sent.id, gmail_thread_id: preview.gmail_thread_id, ...synced };
};

module.exports = { caseReference, getAttachment, manualLink, replyPreview, sendReply, syncCase, validGmailId };
