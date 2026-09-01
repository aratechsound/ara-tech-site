const crypto = require("node:crypto");

const {
    brandEmailTestTemplate,
    buildCustomerHtml,
    normalizeCustomerBody,
    safeErrorCode,
    sendGmail,
    verifyAdmin
} = require("./_pa-mail.cjs");
const { applyOriginPolicy, isOriginAllowed } = require("./_request-security.cjs");

const MAX_BODY_BYTES = 4_096;
const CONFIRMATION_TTL_MS = 10 * 60 * 1000;

const sendJson = (response, status, payload) => {
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Cache-Control", "private, no-store, max-age=0");
    response.setHeader("X-Content-Type-Options", "nosniff");
    return response.status(status).json(payload);
};

const requestOriginMatchesHost = (request, response) => (
    response ? applyOriginPolicy(request, response) : isOriginAllowed(request)
);

const bearerToken = (request) => {
    const authorization = String(request.headers?.authorization || "");
    const match = authorization.match(/^Bearer ([^\s]+)$/u);
    if (!match) throw new Error("not_authorized");
    return match[1];
};

const parseInput = (request) => {
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
    const action = String(input.action || "");
    if (!["preview", "send"].includes(action)) throw new Error("invalid_action");
    return {
        action,
        confirmationToken: String(input.confirmation_token || "")
    };
};

const confirmationSecret = (environment = process.env) => {
    const value = String(environment.SUPABASE_SERVICE_ROLE_KEY || "").trim();
    if (!value) throw new Error("service_unavailable");
    return value;
};

const issueConfirmationToken = ({ userId, now = Date.now(), environment = process.env }) => {
    const payload = Buffer.from(JSON.stringify({ v: 1, u: String(userId), e: Number(now) + CONFIRMATION_TTL_MS }))
        .toString("base64url");
    const signature = crypto
        .createHmac("sha256", confirmationSecret(environment))
        .update(`pa-mail-brand-test:v1:${payload}`)
        .digest("base64url");
    return `${payload}.${signature}`;
};

const verifyConfirmationToken = ({ token, userId, now = Date.now(), environment = process.env }) => {
    const [payload, signature, extra] = String(token || "").split(".");
    if (!payload || !signature || extra) throw new Error("invalid_confirmation");
    const expected = crypto
        .createHmac("sha256", confirmationSecret(environment))
        .update(`pa-mail-brand-test:v1:${payload}`)
        .digest("base64url");
    const signatureBytes = Buffer.from(signature);
    const expectedBytes = Buffer.from(expected);
    if (signatureBytes.length !== expectedBytes.length || !crypto.timingSafeEqual(signatureBytes, expectedBytes)) {
        throw new Error("invalid_confirmation");
    }
    let decoded;
    try {
        decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    } catch {
        throw new Error("invalid_confirmation");
    }
    if (
        decoded?.v !== 1
        || String(decoded?.u || "") !== String(userId)
        || !Number.isInteger(decoded?.e)
        || decoded.e < Number(now)
        || decoded.e > Number(now) + CONFIRMATION_TTL_MS
    ) {
        throw new Error("invalid_confirmation");
    }
};

const previewPayload = (user, now, environment) => {
    const template = brandEmailTestTemplate();
    const body = normalizeCustomerBody(template.body);
    return {
        recipient: template.recipient,
        subject: template.subject,
        plain_text: body,
        html: buildCustomerHtml(body),
        confirmation_token: issueConfirmationToken({ userId: user.id, now, environment })
    };
};

const createHandler = ({
    verifyAdminImpl = verifyAdmin,
    sendGmailImpl = sendGmail,
    now = () => Date.now(),
    environment = process.env
} = {}) => async (request, response) => {
    if (request.method !== "POST") {
        response.setHeader("Allow", "POST");
        return sendJson(response, 405, { ok: false, code: "method_not_allowed" });
    }
    if (!requestOriginMatchesHost(request, response)) {
        return sendJson(response, 403, { ok: false, code: "invalid_origin" });
    }

    try {
        const user = await verifyAdminImpl(bearerToken(request));
        const input = parseInput(request);
        const requestTime = now();
        if (input.action === "preview") {
            return sendJson(response, 200, {
                ok: true,
                preview: previewPayload(user, requestTime, environment),
                pa_database_mutations: 0
            });
        }

        verifyConfirmationToken({
            token: input.confirmationToken,
            userId: user.id,
            now: requestTime,
            environment
        });
        const template = brandEmailTestTemplate();
        const gmail = await sendGmailImpl({
            to: template.recipient,
            subject: template.subject,
            body: template.body,
            messageType: template.messageType
        });
        return sendJson(response, 200, {
            ok: true,
            delivery: {
                from: "aratechsound@gmail.com",
                to: template.recipient,
                subject: template.subject,
                status: "sent",
                sent_at: new Date(requestTime).toISOString(),
                gmail_message_id: gmail.id,
                gmail_thread_id: gmail.threadId || null
            },
            pa_database_mutations: 0
        });
    } catch (error) {
        const code = String(error?.message || "");
        if (["not_authorized", "invalid_input", "invalid_action", "invalid_confirmation"].includes(code)) {
            return sendJson(response, code === "not_authorized" ? 401 : 400, { ok: false, code });
        }
        return sendJson(response, 503, { ok: false, code: safeErrorCode(error) });
    }
};

module.exports = createHandler();
module.exports.MAX_BODY_BYTES = MAX_BODY_BYTES;
module.exports.CONFIRMATION_TTL_MS = CONFIRMATION_TTL_MS;
module.exports.bearerToken = bearerToken;
module.exports.createHandler = createHandler;
module.exports.issueConfirmationToken = issueConfirmationToken;
module.exports.parseInput = parseInput;
module.exports.previewPayload = previewPayload;
module.exports.requestOriginMatchesHost = requestOriginMatchesHost;
module.exports.verifyConfirmationToken = verifyConfirmationToken;
