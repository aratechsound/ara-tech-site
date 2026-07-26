const crypto = require("node:crypto");
const {
    isUuid,
    supabaseRequest,
    verifyAdmin
} = require("./_pa-mail.cjs");

const MAX_BODY_BYTES = 4_096;
const RATE_WINDOW_MS = 60_000;
const DELETE_REASONS = new Set(["test_case", "duplicate", "input_error", "other"]);
const ACTION_LIMITS = Object.freeze({
    inspect: 60,
    trash: 20,
    restore: 20,
    purge: 5
});
const rateWindows = new Map();

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

const bearerToken = (request) => {
    const authorization = String(request.headers?.authorization || "");
    const match = authorization.match(/^Bearer ([^\s]+)$/u);
    if (!match || match[1].length > 4_096) throw new Error("not_authorized");
    return match[1];
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
    if (
        !input
        || Array.isArray(input)
        || Buffer.byteLength(JSON.stringify(input), "utf8") > MAX_BODY_BYTES
    ) {
        throw new Error("invalid_input");
    }
    return input;
};

const clientHash = (request) => {
    const forwarded = String(request.headers?.["x-forwarded-for"] || "").split(",")[0].trim();
    const source = forwarded || String(request.socket?.remoteAddress || "unknown");
    return crypto.createHash("sha256").update(source).digest("hex");
};

const rateLimit = (request, userId, action) => {
    const now = Date.now();
    const key = `${clientHash(request)}:${userId}:${action}`;
    const limit = ACTION_LIMITS[action] || 10;
    let window = rateWindows.get(key);
    if (!window || window.expiresAt <= now) {
        window = { count: 0, expiresAt: now + RATE_WINDOW_MS };
        rateWindows.set(key, window);
    }
    window.count += 1;

    if (rateWindows.size > 1_000) {
        for (const [bucketKey, bucket] of rateWindows) {
            if (bucket.expiresAt <= now) rateWindows.delete(bucketKey);
        }
    }

    return {
        limited: window.count > limit,
        retryAfter: Math.max(1, Math.ceil((window.expiresAt - now) / 1_000))
    };
};

const validateInput = (input) => {
    const action = String(input.action || "");
    if (!Object.hasOwn(ACTION_LIMITS, action)) throw new Error("invalid_action");
    if (!isUuid(input.inquiry_id)) throw new Error("invalid_inquiry");
    if (action === "trash" && !DELETE_REASONS.has(input.reason)) throw new Error("invalid_reason");
    if (action === "purge") {
        const confirmation = String(input.confirmation || "");
        if (!confirmation || confirmation.length > 80) throw new Error("invalid_confirmation");
    }
    return action;
};

const rpcForAction = (action, input, userId) => {
    if (action === "trash") {
        return {
            name: "trash_pa_case",
            parameters: {
                p_inquiry_id: input.inquiry_id,
                p_reason: input.reason,
                p_actor_user_id: userId
            }
        };
    }
    if (action === "restore") {
        return {
            name: "restore_pa_case",
            parameters: {
                p_inquiry_id: input.inquiry_id,
                p_actor_user_id: userId
            }
        };
    }
    if (action === "inspect") {
        return {
            name: "get_pa_case_delete_impact",
            parameters: {
                p_inquiry_id: input.inquiry_id,
                p_actor_user_id: userId
            }
        };
    }
    return {
        name: "purge_pa_case",
        parameters: {
            p_inquiry_id: input.inquiry_id,
            p_confirmation: String(input.confirmation),
            p_actor_user_id: userId
        }
    };
};

const callRpc = async (action, input, userId, fetchImpl = fetch) => {
    const rpc = rpcForAction(action, input, userId);
    const rows = await supabaseRequest(`/rest/v1/rpc/${rpc.name}`, {
        method: "POST",
        body: JSON.stringify(rpc.parameters)
    }, fetchImpl);
    if (!Array.isArray(rows) || !rows[0] || typeof rows[0].result !== "string") {
        throw new Error("invalid_rpc_result");
    }
    return rows[0];
};

const sendJson = (response, status, payload) => {
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Cache-Control", "private, no-store, max-age=0");
    response.setHeader("X-Content-Type-Options", "nosniff");
    return response.status(status).json(payload);
};

const statusForResult = (result) => {
    if (result === "not_authorized") return 401;
    if (result === "not_found") return 404;
    if (result === "not_trashed") return 409;
    if (["invalid_reason", "confirmation_mismatch"].includes(result)) return 400;
    return 200;
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
        const action = validateInput(input);
        const user = await verifyAdmin(bearerToken(request));
        const rate = rateLimit(request, user.id, action);
        if (rate.limited) {
            response.setHeader("Retry-After", String(rate.retryAfter));
            return sendJson(response, 429, { ok: false, code: "rate_limited" });
        }

        const result = await callRpc(action, input, user.id);
        const status = statusForResult(result.result);
        if (status !== 200) {
            return sendJson(response, status, { ok: false, code: result.result });
        }

        const changed = ["trashed", "restored", "purged"].includes(result.result);
        return sendJson(response, 200, {
            ok: true,
            action,
            changed,
            case: result
        });
    } catch (error) {
        const code = String(error?.message || "");
        if (code === "not_authorized") {
            return sendJson(response, 401, { ok: false, code });
        }
        if ([
            "invalid_input",
            "invalid_action",
            "invalid_inquiry",
            "invalid_reason",
            "invalid_confirmation"
        ].includes(code)) {
            return sendJson(response, 400, { ok: false, code });
        }
        console.error("pa-case-trash failed", /^supabase_\d{3}$/u.test(code) ? code : "internal_error");
        return sendJson(response, 503, { ok: false, code: "service_unavailable" });
    }
};

module.exports.ACTION_LIMITS = ACTION_LIMITS;
module.exports.DELETE_REASONS = DELETE_REASONS;
module.exports.MAX_BODY_BYTES = MAX_BODY_BYTES;
module.exports.bearerToken = bearerToken;
module.exports.callRpc = callRpc;
module.exports.parseBody = parseBody;
module.exports.rateLimit = rateLimit;
module.exports.requestOriginMatchesHost = requestOriginMatchesHost;
module.exports.rpcForAction = rpcForAction;
module.exports.validateInput = validateInput;
