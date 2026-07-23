const {
    safeErrorCode,
    submitScheduleResponseAndNotify
} = require("./_pa-mail.cjs");

const MAX_BODY_BYTES = 40_000;

const requestOriginMatchesHost = (request) => {
    const origin = request.headers?.origin;
    if (!origin) return true;
    try {
        const originUrl = new URL(origin);
        const forwardedHost = String(request.headers?.["x-forwarded-host"] || request.headers?.host || "")
            .split(",")[0]
            .trim()
            .toLowerCase();
        return originUrl.host.toLowerCase() === forwardedHost
            && (originUrl.protocol === "https:" || process.env.NODE_ENV !== "production");
    } catch {
        return false;
    }
};

const parseBody = (request) => {
    let input;
    try {
        input = request.body && typeof request.body === "object" && !Buffer.isBuffer(request.body)
            ? request.body
            : JSON.parse(String(request.body || ""));
    } catch {
        throw new Error("invalid_submission");
    }
    if (!input || Array.isArray(input) || Buffer.byteLength(JSON.stringify(input), "utf8") > MAX_BODY_BYTES) {
        throw new Error("invalid_submission");
    }
    return input;
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
    if (!requestOriginMatchesHost(request)) {
        return sendJson(response, 403, { ok: false, code: "invalid_origin" });
    }

    try {
        const input = parseBody(request);
        const result = await submitScheduleResponseAndNotify({
            token: input.token,
            response: input.response,
            submissionKey: input.submission_key
        });
        return sendJson(response, 200, {
            ok: result.result === "accepted",
            result: result.result,
            submitted_at: result.submitted_at,
            inquiry_number: result.inquiry_number || null,
            notifications: result.deliveries.map((delivery) => ({
                message_type: delivery.message_type,
                status: delivery.status,
                sent_at: delivery.sent_at || null,
                error_summary: delivery.error_summary || null
            }))
        });
    } catch (error) {
        const code = String(error?.message || "");
        if (code === "invalid_submission") {
            return sendJson(response, 400, { ok: false, code });
        }
        const safeCode = safeErrorCode(error);
        console.error("pa schedule response failed", safeCode);
        return sendJson(response, 503, { ok: false, code: safeCode });
    }
};

module.exports.MAX_BODY_BYTES = MAX_BODY_BYTES;
module.exports.parseBody = parseBody;
module.exports.requestOriginMatchesHost = requestOriginMatchesHost;
