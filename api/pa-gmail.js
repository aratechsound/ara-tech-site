const { getAttachment, manualLink, replyPreview, sendReply, syncCase, validGmailId } = require("./_pa-gmail.cjs");
const { verifyAdmin } = require("./_pa-mail.cjs");
const { applyOriginPolicy, checkRateLimit, isRateLimitUnavailable } = require("./_request-security.cjs");

const MAX_BODY_BYTES = 64_000;
const ACTION_POLICY = Object.freeze({
    sync: "PA_GMAIL_SYNC",
    manual_link: "PA_GMAIL_MANUAL_LINK",
    attachment_get: "PA_GMAIL_ATTACHMENT_GET",
    reply_preview: "PA_GMAIL_REPLY_PREVIEW",
    send_reply: "PA_GMAIL_SEND_REPLY"
});

const parseBody = (request) => {
    let value;
    try { value = request.body && typeof request.body === "object" && !Buffer.isBuffer(request.body) ? request.body : JSON.parse(String(request.body || "")); } catch { throw new Error("invalid_input"); }
    if (!value || Array.isArray(value) || Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_BODY_BYTES) throw new Error("invalid_input");
    return value;
};
const bearer = (request) => {
    const match = String(request.headers?.authorization || "").match(/^Bearer ([^\s]+)$/u);
    if (!match) throw new Error("not_authorized");
    return match[1];
};
const sendJson = (response, status, payload) => {
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Cache-Control", "private, no-store, max-age=0");
    response.setHeader("X-Content-Type-Options", "nosniff");
    return response.status(status).json(payload);
};

module.exports = async (request, response) => {
    if (request.method !== "POST") {
        response.setHeader("Allow", "POST");
        return sendJson(response, 405, { ok: false, code: "method_not_allowed" });
    }
    if (!applyOriginPolicy(request, response)) return sendJson(response, 403, { ok: false, code: "invalid_origin" });
    try {
        const user = await verifyAdmin(bearer(request));
        const input = parseBody(request);
        if (!ACTION_POLICY[input.action]) throw new Error("invalid_action");
        const rate = await checkRateLimit({ request, policyName: ACTION_POLICY[input.action], scope: user.id });
        if (!rate.allowed) {
            response.setHeader("Retry-After", String(Math.max(1, rate.retryAfter)));
            return sendJson(response, 429, { ok: false, code: "rate_limited" });
        }
        if (input.action === "sync") {
            const result = await syncCase({ inquiryId: input.inquiry_id, actorId: user.id });
            return sendJson(response, 200, { ok: true, result });
        }
        if (input.action === "manual_link") {
            if (!validGmailId(input.gmail_thread_id)) throw new Error("invalid_gmail_thread");
            const result = await manualLink({ inquiryId: input.inquiry_id, gmailThreadId: input.gmail_thread_id, actorId: user.id });
            return sendJson(response, 200, { ok: true, result });
        }
        if (input.action === "attachment_get") {
            const attachment = await getAttachment({
                inquiryId: input.inquiry_id,
                gmailMessageId: input.gmail_message_id,
                gmailAttachmentId: input.gmail_attachment_id
            });
            return sendJson(response, 200, { ok: true, attachment });
        }
        if (input.action === "reply_preview") {
            const preview = await replyPreview({ inquiryId: input.inquiry_id, actorId: user.id, body: input.body });
            return sendJson(response, 200, { ok: true, preview });
        }
        const result = await sendReply({ inquiryId: input.inquiry_id, actorId: user.id, body: input.body, confirmationToken: input.confirmation_token });
        return sendJson(response, 200, { ok: true, result });
    } catch (error) {
        const code = String(error?.message || "");
        if (code === "not_authorized") return sendJson(response, 401, { ok: false, code });
        if (["invalid_input", "invalid_action", "invalid_gmail_thread", "invalid_gmail_attachment", "gmail_attachment_not_indexed", "gmail_attachment_not_found", "gmail_attachment_unavailable", "gmail_thread_not_linked", "reply_target_unavailable", "invalid_confirmation", "ambiguous_thread_link", "inquiry_not_found"].includes(code)) return sendJson(response, 400, { ok: false, code });
        if (isRateLimitUnavailable(error)) return sendJson(response, 503, { ok: false, code: "service_unavailable" });
        const safe = /^(gmail_(?:read|send|oauth)_\d{3}|gmail_send_invalid|gmail_not_configured)$/u.test(code) ? code : "service_unavailable";
        console.error("pa-gmail operation failed", safe);
        return sendJson(response, 503, { ok: false, code: safe });
    }
};

module.exports.MAX_BODY_BYTES = MAX_BODY_BYTES;
