const {
    createScheduleDelivery,
    getInquiry,
    retryDelivery,
    safeErrorCode,
    verifyAdmin
} = require("./_pa-mail.cjs");

const MAX_BODY_BYTES = 32_000;

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
        throw new Error("invalid_input");
    }
    if (!input || Array.isArray(input) || Buffer.byteLength(JSON.stringify(input), "utf8") > MAX_BODY_BYTES) {
        throw new Error("invalid_input");
    }
    return input;
};

const bearerToken = (request) => {
    const authorization = String(request.headers?.authorization || "");
    const match = authorization.match(/^Bearer ([^\s]+)$/u);
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
    if (!requestOriginMatchesHost(request)) {
        return sendJson(response, 403, { ok: false, code: "invalid_origin" });
    }

    try {
        const user = await verifyAdmin(bearerToken(request));
        const input = parseBody(request);
        const inquiry = await getInquiry(input.inquiry_id);
        let delivery;
        if (input.action === "send_schedule") {
            delivery = await createScheduleDelivery({
                inquiry,
                subject: input.subject,
                body: input.body,
                scheduleUrl: input.schedule_url,
                operationKey: input.operation_key,
                actorUserId: user.id
            });
        } else if (input.action === "retry") {
            delivery = await retryDelivery({
                deliveryId: input.delivery_id,
                inquiry,
                actorUserId: user.id
            });
        } else {
            throw new Error("invalid_action");
        }

        return sendJson(response, 200, {
            ok: delivery.status === "sent",
            delivery: {
                id: delivery.id,
                message_type: delivery.message_type,
                recipient: delivery.recipient,
                subject: delivery.subject,
                status: delivery.status,
                requested_at: delivery.requested_at,
                sent_at: delivery.sent_at,
                failed_at: delivery.failed_at,
                gmail_message_id: delivery.gmail_message_id,
                error_summary: delivery.error_summary,
                is_retry: delivery.is_retry,
                attempt_number: delivery.attempt_number
            }
        });
    } catch (error) {
        const code = String(error?.message || "");
        if (code === "not_authorized") return sendJson(response, 401, { ok: false, code });
        if ([
            "invalid_input",
            "invalid_action",
            "invalid_inquiry",
            "invalid_delivery",
            "invalid_operation",
            "invalid_schedule_url",
            "invalid_schedule_message",
            "retry_not_allowed",
            "inquiry_not_found",
            "delivery_not_found"
        ].includes(code)) {
            return sendJson(response, 400, { ok: false, code });
        }
        const safeCode = safeErrorCode(error);
        console.error("pa-mail delivery failed", safeCode);
        return sendJson(response, 503, { ok: false, code: safeCode });
    }
};

module.exports.MAX_BODY_BYTES = MAX_BODY_BYTES;
module.exports.bearerToken = bearerToken;
module.exports.parseBody = parseBody;
module.exports.requestOriginMatchesHost = requestOriginMatchesHost;
