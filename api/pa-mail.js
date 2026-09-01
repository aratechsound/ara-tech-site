const {
    CONTENT_HEARING_TYPE,
    createScheduleDelivery,
    finalizeContentHearingDelivery,
    finalizeScheduleResult,
    getInquiry,
    resultForMessageType,
    retryDelivery,
    safeErrorCode,
    sendScheduleResultAndFinalize,
    sendContentHearingAndFinalize,
    verifyAdmin
} = require("./_pa-mail.cjs");
const {
    applyOriginPolicy,
    checkRateLimit,
    isOriginAllowed,
    isRateLimitUnavailable
} = require("./_request-security.cjs");

const MAX_BODY_BYTES = 32_000;
const RATE_LIMIT_POLICY_BY_ACTION = Object.freeze({
    send_content_hearing: "PA_MAIL_SEND_CONTENT_HEARING",
    send_schedule: "PA_MAIL_SEND_SCHEDULE",
    send_result: "PA_MAIL_SEND_RESULT",
    retry: "PA_MAIL_RETRY"
});

const requestOriginMatchesHost = (request, response) => (
    response ? applyOriginPolicy(request, response) : isOriginAllowed(request)
);

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
    if (!requestOriginMatchesHost(request, response)) {
        return sendJson(response, 403, { ok: false, code: "invalid_origin" });
    }

    try {
        const user = await verifyAdmin(bearerToken(request));
        const input = parseBody(request);
        const rateLimitPolicy = RATE_LIMIT_POLICY_BY_ACTION[input.action];
        if (!rateLimitPolicy) throw new Error("invalid_action");
        const rate = await checkRateLimit({
            request,
            policyName: rateLimitPolicy,
            scope: user.id
        });
        if (!rate.allowed) {
            response.setHeader("Retry-After", String(Math.max(1, rate.retryAfter)));
            return sendJson(response, 429, { ok: false, code: "rate_limited" });
        }
        const inquiry = await getInquiry(input.inquiry_id);
        let delivery;
        let caseState = null;
        if (input.action === "send_content_hearing") {
            const outcome = await sendContentHearingAndFinalize({
                inquiry,
                subject: input.subject,
                body: input.body,
                actorUserId: user.id
            });
            delivery = outcome.delivery;
            caseState = outcome.caseState;
        } else if (input.action === "send_schedule") {
            delivery = await createScheduleDelivery({
                inquiry,
                subject: input.subject,
                body: input.body,
                scheduleUrl: input.schedule_url,
                operationKey: input.operation_key,
                actorUserId: user.id
            });
        } else if (input.action === "send_result") {
            const outcome = await sendScheduleResultAndFinalize({
                inquiry,
                result: input.result,
                subject: input.subject,
                body: input.body,
                actorUserId: user.id
            });
            delivery = outcome.delivery;
            caseState = outcome.caseState;
        } else if (input.action === "retry") {
            delivery = await retryDelivery({
                deliveryId: input.delivery_id,
                inquiry,
                actorUserId: user.id
            });
            const result = resultForMessageType(delivery.message_type);
            if (result && delivery.status === "sent") {
                caseState = await finalizeScheduleResult({
                    inquiryId: inquiry.id,
                    delivery,
                    result
                });
            } else if (delivery.message_type === CONTENT_HEARING_TYPE && delivery.status === "sent") {
                caseState = await finalizeContentHearingDelivery({
                    inquiryId: inquiry.id,
                    delivery
                });
            }
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
            },
            case_state: caseState
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
            "content_hearing_not_allowed",
            "content_hearing_delivery_not_sent",
            "content_hearing_transition_failed",
            "invalid_content_hearing_message",
            "invalid_schedule_url",
            "invalid_schedule_message",
            "invalid_schedule_result",
            "invalid_result_message",
            "unsafe_customer_message",
            "result_not_allowed",
            "result_delivery_not_sent",
            "result_transition_failed",
            "schedule_response_not_found",
            "schedule_not_allowed",
            "retry_not_allowed",
            "inquiry_not_found",
            "delivery_not_found"
        ].includes(code)) {
            return sendJson(response, 400, { ok: false, code });
        }
        if (isRateLimitUnavailable(error)) {
            console.error("pa-mail delivery failed", "service_unavailable");
            return sendJson(response, 503, { ok: false, code: "service_unavailable" });
        }
        const safeCode = safeErrorCode(error);
        console.error("pa-mail delivery failed", safeCode);
        return sendJson(response, 503, { ok: false, code: "service_unavailable" });
    }
};

module.exports.MAX_BODY_BYTES = MAX_BODY_BYTES;
module.exports.bearerToken = bearerToken;
module.exports.parseBody = parseBody;
module.exports.requestOriginMatchesHost = requestOriginMatchesHost;
