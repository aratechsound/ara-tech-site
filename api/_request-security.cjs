const crypto = require("node:crypto");

const DEFAULT_SITE_ORIGIN = "https://ara-tech.cc";
const DEFAULT_SUPABASE_URL = "https://kogbnremsouajxxsgxro.supabase.co";
const RATE_LIMIT_RPC_NAME = "consume_rate_limit";

const RATE_LIMIT_POLICIES = Object.freeze({
    PUBLIC_INQUIRY: Object.freeze({
        bucket: "pa-inquiry",
        windowMs: 10 * 60 * 1000,
        maxRequests: 8,
        identity: "client"
    }),
    PA_MAIL_SEND_SCHEDULE: Object.freeze({
        bucket: "pa-mail-send-schedule",
        windowMs: 10 * 60 * 1000,
        maxRequests: 30,
        identity: "scope"
    }),
    PA_MAIL_SEND_RESULT: Object.freeze({
        bucket: "pa-mail-send-result",
        windowMs: 10 * 60 * 1000,
        maxRequests: 20,
        identity: "scope"
    }),
    PA_MAIL_RETRY: Object.freeze({
        bucket: "pa-mail-retry",
        windowMs: 10 * 60 * 1000,
        maxRequests: 20,
        identity: "scope"
    }),
    SCHEDULE_RESPONSE: Object.freeze({
        bucket: "pa-schedule-response",
        windowMs: 10 * 60 * 1000,
        maxRequests: 12,
        identity: "client"
    }),
    CASE_TRASH_INSPECT: Object.freeze({
        bucket: "pa-case-trash-inspect",
        windowMs: 60 * 1000,
        maxRequests: 60,
        identity: "scope"
    }),
    CASE_TRASH_TRASH: Object.freeze({
        bucket: "pa-case-trash-trash",
        windowMs: 60 * 1000,
        maxRequests: 20,
        identity: "scope"
    }),
    CASE_TRASH_RESTORE: Object.freeze({
        bucket: "pa-case-trash-restore",
        windowMs: 60 * 1000,
        maxRequests: 20,
        identity: "scope"
    }),
    CASE_TRASH_PURGE: Object.freeze({
        bucket: "pa-case-trash-purge",
        windowMs: 60 * 1000,
        maxRequests: 5,
        identity: "scope"
    })
});

class RateLimitUnavailableError extends Error {
    constructor() {
        super("rate_limit_unavailable");
        this.name = "RateLimitUnavailableError";
    }
}

const isProduction = (environment = process.env) => {
    const nodeEnvironment = String(environment.NODE_ENV || "").toLowerCase();
    const vercelEnvironment = String(environment.VERCEL_ENV || "").toLowerCase();
    return nodeEnvironment === "production" || vercelEnvironment === "production";
};

const toNormalizedOrigin = (value) => {
    const raw = String(value || "").trim();
    if (!raw) throw new Error("invalid_origin");
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("invalid_origin");
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
        throw new Error("invalid_origin");
    }
    return url.origin;
};

const parseAllowedOrigins = (environment = process.env) => {
    const configured = String(environment.ALLOWED_ORIGINS || "").trim();
    if (!configured) {
        return isProduction(environment) ? [] : [DEFAULT_SITE_ORIGIN];
    }
    return [...new Set(
        configured
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean)
            .map(toNormalizedOrigin)
    )];
};

const requestOrigin = (request) => String(request?.headers?.origin || "").trim();

const isOriginAllowed = (request, environment = process.env) => {
    const origin = requestOrigin(request);
    // Preserve the existing server-to-server/same-site behavior explicitly:
    // requests without Origin are accepted, but never receive a CORS allow header.
    if (!origin) return true;
    try {
        return parseAllowedOrigins(environment).includes(toNormalizedOrigin(origin));
    } catch {
        return false;
    }
};

const appendVary = (response, value) => {
    const current = String(response.getHeader?.("Vary") || "").trim();
    const values = current
        ? current.split(",").map((item) => item.trim()).filter(Boolean)
        : [];
    if (!values.some((item) => item.toLowerCase() === value.toLowerCase())) values.push(value);
    response.setHeader("Vary", values.join(", "));
};

const applyOriginPolicy = (request, response, environment = process.env) => {
    if (!isOriginAllowed(request, environment)) return false;
    const origin = requestOrigin(request);
    if (origin) {
        const normalizedOrigin = toNormalizedOrigin(origin);
        response.setHeader("Access-Control-Allow-Origin", normalizedOrigin);
        appendVary(response, "Origin");
    }
    return true;
};

const getClientAddress = (request) => {
    const forwarded = String(request?.headers?.["x-forwarded-for"] || "")
        .split(",")[0]
        .trim();
    return forwarded
        || String(request?.headers?.["x-real-ip"] || "").trim()
        || String(request?.socket?.remoteAddress || "unknown");
};

const getRateLimitPolicy = (policyName) => {
    if (!Object.hasOwn(RATE_LIMIT_POLICIES, policyName)) {
        throw new Error("unknown_rate_limit_policy");
    }
    return RATE_LIMIT_POLICIES[policyName];
};

const rateLimitSecret = (environment) => {
    const secret = String(
        environment.RATE_LIMIT_HASH_SECRET
        || environment.SUPABASE_SERVICE_ROLE_KEY
        || ""
    ).trim();
    if (!secret) throw new RateLimitUnavailableError();
    return secret;
};

const buildRateLimitBucket = ({
    request,
    policyName,
    scope = "",
    environment = process.env
}) => {
    const policy = getRateLimitPolicy(policyName);
    const normalizedScope = String(scope || "").trim();
    if (policy.identity === "scope" && !normalizedScope) {
        throw new Error("missing_rate_limit_scope");
    }
    const identity = policy.identity === "scope"
        ? `scope:${normalizedScope}`
        : `client:${getClientAddress(request)}`;
    const digest = crypto
        .createHmac("sha256", rateLimitSecret(environment))
        .update(`v1|${policy.bucket}|${identity}`)
        .digest("hex");
    return `pa-api:v1:${policy.bucket}:${digest}`;
};

const rateLimitHeaders = (serviceRoleKey) => ({
    apikey: serviceRoleKey,
    authorization: `Bearer ${serviceRoleKey}`,
    "content-type": "application/json",
    accept: "application/json"
});

const checkRateLimit = async ({
    request,
    policyName,
    scope = "",
    fetchImpl = fetch,
    environment = process.env
}) => {
    const policy = getRateLimitPolicy(policyName);
    const serviceRoleKey = String(environment.SUPABASE_SERVICE_ROLE_KEY || "").trim();
    if (!serviceRoleKey) throw new RateLimitUnavailableError();

    let response;
    try {
        const supabaseUrl = String(environment.SUPABASE_URL || DEFAULT_SUPABASE_URL)
            .replace(/\/+$/u, "");
        const bucket = buildRateLimitBucket({
            request,
            policyName,
            scope,
            environment
        });
        response = await fetchImpl(`${supabaseUrl}/rest/v1/rpc/${RATE_LIMIT_RPC_NAME}`, {
            method: "POST",
            headers: rateLimitHeaders(serviceRoleKey),
            body: JSON.stringify({
                p_bucket_key: bucket,
                p_window_ms: policy.windowMs,
                p_limit: policy.maxRequests
            })
        });
    } catch {
        throw new RateLimitUnavailableError();
    }

    if (!response?.ok) throw new RateLimitUnavailableError();

    let payload;
    try {
        payload = await response.json();
    } catch {
        throw new RateLimitUnavailableError();
    }
    const state = Array.isArray(payload) ? payload[0] : payload;
    if (
        !state
        || typeof state.allowed !== "boolean"
        || !Number.isInteger(Number(state.remaining))
        || !Number.isInteger(Number(state.retry_after_seconds))
        || Number(state.remaining) < 0
        || Number(state.retry_after_seconds) < 0
        || Number(state.limit) !== policy.maxRequests
    ) {
        throw new RateLimitUnavailableError();
    }

    return {
        allowed: state.allowed,
        remaining: Number(state.remaining),
        retryAfter: Number(state.retry_after_seconds),
        resetAt: String(state.reset_at || ""),
        limit: policy.maxRequests
    };
};

const isRateLimitUnavailable = (error) => (
    error instanceof RateLimitUnavailableError
    || String(error?.message || "") === "rate_limit_unavailable"
);

module.exports = {
    DEFAULT_SITE_ORIGIN,
    RATE_LIMIT_POLICIES,
    RateLimitUnavailableError,
    applyOriginPolicy,
    buildRateLimitBucket,
    checkRateLimit,
    getRateLimitPolicy,
    isOriginAllowed,
    isProduction,
    isRateLimitUnavailable,
    parseAllowedOrigins,
    toNormalizedOrigin
};
