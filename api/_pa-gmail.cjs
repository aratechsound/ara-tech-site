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
// Gmail attachment IDs are opaque values.  Their URL-safe-looking examples are
// not an API guarantee, so do not discard otherwise valid MIME metadata merely
// because an ID contains encoding characters such as + or =.  Path separators,
// controls and whitespace remain forbidden; every outbound Gmail path segment is
// still encoded and the ID is rechecked against indexed metadata server-side.
const GMAIL_ATTACHMENT_REFERENCE = /^[^\s\u0000-\u001f\\/]{1,1000}$/u;
const EMAIL = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/u;
const PREVIEW_TTL_MS = 10 * 60 * 1000;

const validGmailId = (value) => GMAIL_ID.test(String(value || ""));
const validGmailAttachmentReference = (value) => GMAIL_ATTACHMENT_REFERENCE.test(String(value || ""));
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
const safeAttachmentFilename = (value) => {
    const filename = String(value || "attachment").replace(/[\u0000-\u001f\\\\/]/gu, "_").trim().slice(0, 255);
    return filename || "attachment";
};
const safeAttachmentMimeType = (value) => {
    const mime = String(value || "").trim().toLowerCase();
    return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(mime) ? mime : "application/octet-stream";
};
const attachmentContentDisposition = (value) => {
    const filename = safeAttachmentFilename(value);
    const fallback = filename.normalize("NFKD").replace(/[^\x20-\x7e]/gu, "_").replace(/["\\]/gu, "_").trim() || "attachment";
    const encoded = encodeURIComponent(filename).replace(/[!'()]/gu, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
    return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
};
const decodeAttachmentData = (value) => {
    const data = String(value || "");
    if (!/^[A-Za-z0-9_-]+={0,2}$/u.test(data)) return null;
    const bytes = Buffer.from(data.replace(/-/gu, "+").replace(/_/gu, "/"), "base64");
    return bytes.length ? bytes : null;
};
const attachmentReference = (part) => String(part?.body?.attachmentId || part?.partId || "");
const collectParts = (part, result = { plain: "", html: "", attachments: [] }) => {
    if (!part || typeof part !== "object") return result;
    const mime = String(part.mimeType || "").toLowerCase();
    const reference = attachmentReference(part);
    if (part.filename && part.body && validGmailAttachmentReference(reference)
        && (part.body.attachmentId || part.body.data) && !result.attachments.some((attachment) => attachment.id === reference)) {
        result.attachments.push({
            id: reference,
            filename: safeAttachmentFilename(part.filename),
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
    if (attachmentReference(part) === attachmentId) return part;
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
        // Gmail remains the message authority.  The client receives the HTML only
        // for its allowlist-based renderer; it must never insert this value directly.
        body_html: String(parts.html || "").slice(0, 50_000),
        attachments: parts.attachments.slice(0, 100),
        rfc_message_id: String(headers["message-id"] || "").trim()
    };
};

const CONVERSATION_ROLES = new Set(["primary_conversation", "secondary_conversation", "system_acknowledgement"]);
const selectRows = (table, query, fetchImpl) => supabaseRequest(`/rest/v1/${table}?${query}`, {}, fetchImpl);
const getLinks = async (inquiryId, fetchImpl) => {
    const query = new URLSearchParams({ inquiry_id: `eq.${inquiryId}`, select: "*", order: "linked_at.asc", limit: "100" });
    const rows = await selectRows("pa_gmail_thread_links", query, fetchImpl);
    return Array.isArray(rows) ? rows : [];
};
const getPrimaryLink = async (inquiryId, fetchImpl) => {
    const links = await getLinks(inquiryId, fetchImpl);
    return links.find((link) => link.conversation_role === "primary_conversation") || null;
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
    // A minimal PostgREST insert can return 201 with no body. The shared
    // request helper parses successful responses as JSON, so retain a body
    // for this audit-only write instead of converting success to SyntaxError.
    prefer: "return=representation",
    body: JSON.stringify({ inquiry_id: inquiryId, actor_user_id: actorId, action, details })
}, fetchImpl);

const linkThread = async ({ inquiryId, threadId, source, role = "secondary_conversation", actorId }, fetchImpl) => {
    if (!isUuid(inquiryId) || !validGmailId(threadId) || !CONVERSATION_ROLES.has(role)) throw new Error("invalid_gmail_thread");
    const existing = await getGlobalThreadLink(threadId, fetchImpl);
    if (existing && existing.inquiry_id !== inquiryId) throw new Error("ambiguous_thread_link");
    if (role === "primary_conversation") {
        const primary = await getPrimaryLink(inquiryId, fetchImpl);
        if (primary && primary.gmail_thread_id !== threadId) throw new Error("primary_conversation_exists");
    }
    const rows = await writeRow("pa_gmail_thread_links", {
        inquiry_id: inquiryId,
        gmail_thread_id: threadId,
        link_source: source,
        conversation_role: role,
        linked_by: actorId
    }, "inquiry_id,gmail_thread_id", fetchImpl);
    return Array.isArray(rows) ? rows[0] : null;
};

const deliveryThreadCandidates = async (inquiryId, fetchImpl) => {
    const query = new URLSearchParams({
        inquiry_id: `eq.${inquiryId}`,
        status: "eq.sent",
        select: "gmail_thread_id,gmail_message_id,message_type,sent_at,recipient,subject",
        limit: "100"
    });
    const rows = await selectRows("pa_email_deliveries", query, fetchImpl);
    return Array.isArray(rows) ? rows : [];
};
const equalText = (left, right) => String(left || "").replace(/\s+/gu, " ").trim() === String(right || "").replace(/\s+/gu, " ").trim();
const sameAddress = (left, right) => safeAddress(left).toLowerCase() === safeAddress(right).toLowerCase();
const deliveryMatchesMessage = (delivery, message) => {
    const normalized = normalizeMessage(message);
    const deliveryTime = Date.parse(String(delivery.sent_at || ""));
    const messageTime = Date.parse(String(normalized.occurred_at || ""));
    const closeInTime = !Number.isFinite(deliveryTime) || !Number.isFinite(messageTime)
        || Math.abs(deliveryTime - messageTime) <= 10 * 60 * 1000;
    return normalized.id === String(delivery.gmail_message_id || "")
        && validGmailId(normalized.thread_id)
        && normalized.direction === "outbound"
        && sameAddress(normalized.from_address, OFFICIAL_EMAIL)
        && normalized.to_addresses.some((address) => sameAddress(address, delivery.recipient))
        && equalText(normalized.subject, delivery.subject)
        && closeInTime;
};
const resolveExactDelivery = async (delivery, fetchImpl) => {
    if (!validGmailId(delivery?.gmail_message_id)) return null;
    const message = await gmailMessage(delivery.gmail_message_id, fetchImpl);
    return deliveryMatchesMessage(delivery, message) ? { message, threadId: String(message.threadId) } : null;
};
const exactDelivery = (deliveries, messageType) => {
    const matches = deliveries.filter((delivery) => delivery.message_type === messageType);
    return matches.length === 1 ? matches[0] : null;
};
const fallbackCandidates = async (inquiry, delivery, fetchImpl) => {
    if (!delivery || !caseReference(inquiry.inquiry_number)) return [];
    const search = new URLSearchParams({ q: `"${inquiry.inquiry_number}"`, maxResults: "20" });
    const result = await gmailJson(`/messages?${search}`, {}, fetchImpl);
    const candidates = [];
    for (const row of result.messages || []) {
        if (!validGmailId(row.id)) continue;
        const message = await gmailMessage(row.id, fetchImpl);
        if (deliveryMatchesMessage({ ...delivery, gmail_message_id: row.id }, message)) candidates.push(String(message.threadId));
    }
    return [...new Set(candidates)].filter(validGmailId);
};
const resolveThread = async (inquiry, fetchImpl) => {
    const deliveries = await deliveryThreadCandidates(inquiry.id, fetchImpl);
    let links = await getLinks(inquiry.id, fetchImpl);
    let primary = links.find((link) => link.conversation_role === "primary_conversation") || null;
    const hearing = exactDelivery(deliveries, "content_hearing_follow_up");
    if (!primary && hearing) {
        const exact = await resolveExactDelivery(hearing, fetchImpl);
        if (exact) {
            primary = await linkThread({
                inquiryId: inquiry.id,
                threadId: exact.threadId,
                source: "gmail_message_id",
                role: "primary_conversation"
            }, fetchImpl);
        }
    }
    const receipt = exactDelivery(deliveries, "customer_receipt");
    if (receipt) {
        const exact = await resolveExactDelivery(receipt, fetchImpl);
        if (exact) await linkThread({
            inquiryId: inquiry.id,
            threadId: exact.threadId,
            source: "gmail_message_id",
            role: "system_acknowledgement"
        }, fetchImpl);
    }
    links = await getLinks(inquiry.id, fetchImpl);
    primary = links.find((link) => link.conversation_role === "primary_conversation") || primary;
    if (primary) return { links, primary, candidates: [] };
    const candidates = await fallbackCandidates(inquiry, hearing, fetchImpl);
    if (candidates.length === 1) {
        primary = await linkThread({
            inquiryId: inquiry.id,
            threadId: candidates[0],
            source: "case_reference",
            role: "primary_conversation"
        }, fetchImpl);
        return { links: await getLinks(inquiry.id, fetchImpl), primary, candidates: [] };
    }
    return { links, primary: null, candidates };
};

const indexThread = async ({ inquiryId, threadId }, fetchImpl) => {
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
    return { messages };
};
const recordSync = async ({ inquiryId, actorId, links, messages }, fetchImpl) => {
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
    await audit(inquiryId, actorId, "gmail_threads_synced", {
        gmail_thread_ids: links.map((link) => link.gmail_thread_id),
        message_count: messages.length,
        attention_state: attention
    }, fetchImpl);
    return { attention, synced_at: new Date().toISOString() };
};

const syncCase = async ({ inquiryId, actorId }, fetchImpl = fetch) => {
    const inquiry = await getInquiry(inquiryId, fetchImpl);
    const resolved = await resolveThread(inquiry, fetchImpl);
    if (!resolved.links.length) return { linked: false, ambiguous: resolved.candidates.length > 1, candidates: resolved.candidates, messages: [] };
    const indexed = await Promise.all(resolved.links.map((link) => indexThread({ inquiryId, threadId: link.gmail_thread_id }, fetchImpl)));
    const messages = [...new Map(indexed.flatMap((result) => result.messages).map((message) => [message.id, message])).values()];
    const summary = await recordSync({ inquiryId, actorId, links: resolved.links, messages }, fetchImpl);
    return {
        linked: Boolean(resolved.primary),
        primary_link: resolved.primary || null,
        links: resolved.links,
        ambiguous: false,
        candidates: [],
        messages,
        ...summary
    };
};

const getAttachment = async ({ inquiryId, gmailMessageId, gmailAttachmentId }, fetchImpl = fetch) => {
    if (!isUuid(inquiryId) || !validGmailId(gmailMessageId) || !validGmailAttachmentReference(gmailAttachmentId)) throw new Error("invalid_gmail_attachment");
    const query = new URLSearchParams({ inquiry_id: `eq.${inquiryId}`, gmail_message_id: `eq.${gmailMessageId}`, select: "gmail_message_id,attachment_metadata", limit: "1" });
    const indexed = await selectRows("pa_gmail_message_index", query, fetchImpl);
    if (!Array.isArray(indexed) || !indexed[0]) throw new Error("gmail_attachment_not_indexed");
    const indexedAttachments = Array.isArray(indexed[0].attachment_metadata) ? indexed[0].attachment_metadata : [];
    if (!indexedAttachments.some((attachment) => String(attachment?.id || "") === gmailAttachmentId)) throw new Error("gmail_attachment_not_indexed");
    const message = await gmailMessage(gmailMessageId, fetchImpl);
    const part = attachmentPart(message.payload, gmailAttachmentId);
    if (!part?.filename || !part.body || attachmentReference(part) !== gmailAttachmentId) throw new Error("gmail_attachment_not_found");
    const payload = part.body.attachmentId
        ? await gmailJson(`/messages/${encodeURIComponent(gmailMessageId)}/attachments/${encodeURIComponent(part.body.attachmentId)}`, {}, fetchImpl)
        : part.body;
    const data = String(payload?.data || "");
    const bytes = decodeAttachmentData(data);
    const byteLength = bytes?.length || 0;
    if (!bytes || byteLength > 10 * 1024 * 1024) throw new Error("gmail_attachment_unavailable");
    return {
        filename: safeAttachmentFilename(part.filename),
        mime_type: safeAttachmentMimeType(part.mimeType),
        size: byteLength,
        data
    };
};
const getAttachmentBinary = async (input, fetchImpl = fetch) => {
    const attachment = await getAttachment(input, fetchImpl);
    return {
        filename: attachment.filename,
        mime_type: attachment.mime_type,
        size: attachment.size,
        bytes: decodeAttachmentData(attachment.data)
    };
};
const streamAttachmentResponse = async (response, attachment) => {
    const bytes = Buffer.isBuffer(attachment?.bytes) ? attachment.bytes : Buffer.from(attachment?.bytes || "");
    if (!bytes.length) throw new Error("gmail_attachment_unavailable");
    response.statusCode = 200;
    response.setHeader("Content-Type", safeAttachmentMimeType(attachment.mime_type));
    response.setHeader("Content-Disposition", attachmentContentDisposition(attachment.filename));
    response.setHeader("Cache-Control", "private, no-store, max-age=0");
    response.setHeader("X-Content-Type-Options", "nosniff");
    for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
        if (!response.write(bytes.subarray(offset, Math.min(offset + 64 * 1024, bytes.length)))) {
            await new Promise((resolve) => response.once("drain", resolve));
        }
    }
    response.end();
};

const manualLink = async ({ inquiryId, gmailThreadId, conversationRole = "secondary_conversation", actorId }, fetchImpl = fetch) => {
    if (!validGmailId(gmailThreadId)) throw new Error("invalid_gmail_thread");
    await gmailThread(gmailThreadId, fetchImpl);
    const link = await linkThread({ inquiryId, threadId: gmailThreadId, source: "manual", role: conversationRole, actorId }, fetchImpl);
    await audit(inquiryId, actorId, "gmail_thread_linked_manual", { gmail_thread_id: gmailThreadId, link_source: "manual", conversation_role: conversationRole }, fetchImpl);
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
    const link = await getPrimaryLink(inquiryId, fetchImpl);
    if (!link) throw new Error("gmail_thread_not_linked");
    const thread = await gmailThread(link.gmail_thread_id, fetchImpl);
    const messages = (thread.messages || []).map(normalizeMessage);
    const latest = [...messages].sort((a, b) => String(a.occurred_at || "").localeCompare(String(b.occurred_at || ""))).at(-1);
    // A thread may initially contain only our delivery.  In that case reply to
    // its original recipient, still in the same Gmail thread; a customer reply
    // takes precedence once one exists.
    const recipient = latest?.direction === "inbound"
        ? safeAddress(latest.reply_to || latest.from_address)
        : safeAddress(Array.isArray(latest?.to_addresses) ? latest.to_addresses.find((address) => EMAIL.test(safeAddress(address))) : "");
    if (!EMAIL.test(recipient)) throw new Error("reply_target_unavailable");
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

module.exports = { attachmentContentDisposition, caseReference, getAttachment, getAttachmentBinary, manualLink, normalizeMessage, replyPreview, safeAttachmentFilename, sendReply, streamAttachmentResponse, syncCase, validGmailAttachmentReference, validGmailId };
