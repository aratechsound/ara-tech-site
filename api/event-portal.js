const organizer = require("./_pa-portal-organizer.cjs");
const { streamAttachmentResponse } = require("./_pa-gmail.cjs");
const { applyOriginPolicy, checkRateLimit, isRateLimitUnavailable } = require("./_request-security.cjs");

const COOKIE = "ara_pa_portal_session";
const MAX_BODY_BYTES = 4_400_000;
const headers = (response) => {
    response.setHeader("Cache-Control", "private, no-store, max-age=0");
    response.setHeader("CDN-Cache-Control", "no-store");
    response.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive, nosnippet");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
};
const json = (response, status, payload) => { headers(response); response.setHeader("Content-Type", "application/json; charset=utf-8"); return response.status(status).json(payload); };
const parseBody = (request) => {
    let value; try { value = request.body && typeof request.body === "object" && !Buffer.isBuffer(request.body) ? request.body : JSON.parse(String(request.body || "")); } catch { throw new Error("invalid_input"); }
    if (!value || Array.isArray(value) || Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_BODY_BYTES) throw new Error("invalid_input");
    return value;
};
const cookie = (request) => String(request.headers?.cookie || "").split(";").map((part) => part.trim().split("=")).find(([name]) => name === COOKIE)?.[1] || "";
const setSession = (response, value) => response.setHeader("Set-Cookie", `${COOKIE}=${value}; Max-Age=${organizer.SESSION_SECONDS}; Path=/api/event-portal; HttpOnly; Secure; SameSite=Strict`);
const clearSession = (response) => response.setHeader("Set-Cookie", `${COOKIE}=; Max-Age=0; Path=/api/event-portal; HttpOnly; Secure; SameSite=Strict`);

module.exports = async (request, response) => {
    headers(response);
    if (request.method !== "POST") { response.setHeader("Allow", "POST"); return json(response, 405, { ok: false, code: "method_not_allowed" }); }
    if (!applyOriginPolicy(request, response)) return json(response, 403, { ok: false, code: "link_unavailable" });
    try {
        const input = parseBody(request);
        const verifying = input.action === "exchange";
        const mutation = !["exchange", "read", "download"].includes(input.action);
        const rate = await checkRateLimit({ request, policyName: verifying ? "PA_PORTAL_PUBLIC_VERIFY" : mutation ? "PA_PORTAL_PUBLIC_MUTATE" : "PA_PORTAL_PUBLIC_READ" });
        if (!rate.allowed) { response.setHeader("Retry-After", String(Math.max(1, rate.retryAfter))); return json(response, 429, { ok: false, code: "link_unavailable" }); }
        if (verifying) { const result = await organizer.exchange(input.token); setSession(response, result.session); return json(response, 200, { ok: true, result: { expires_at: result.expiresAt } }); }
        const session = cookie(request);
        if (!session) throw new Error("link_unavailable");
        if (input.action === "read") return json(response, 200, { ok: true, result: await organizer.read(session) });
        if (input.action === "download") return streamAttachmentResponse(response, await organizer.download({ session, assetRef: input.asset_ref, kind: input.asset_kind }));
        return json(response, 200, { ok: true, result: await organizer.mutate({ session, operation: input.action, payload: input.payload, idempotencyKey: input.idempotency_key }) });
    } catch (error) {
        const code = String(error?.message || "service_unavailable");
        if (/^(link_unavailable|not_permitted|duplicate_submit|invalid_|cannot_archive_current|portal_source_already_used|asset_unavailable)$/u.test(code)) { if (code === "link_unavailable") clearSession(response); return json(response, code === "link_unavailable" ? 401 : 400, { ok: false, code: code === "link_unavailable" ? "link_unavailable" : code }); }
        if (isRateLimitUnavailable(error)) return json(response, 503, { ok: false, code: "service_unavailable" });
        console.error("event portal operation failed", { diagnostic: /^storage_\d{3}$/u.test(code) ? code : "unclassified", error_type: String(error?.name || "Error").replace(/[^A-Za-z0-9_]/gu, "").slice(0, 80) });
        return json(response, 503, { ok: false, code: "service_unavailable" });
    }
};

module.exports.COOKIE = COOKIE;
module.exports.MAX_BODY_BYTES = MAX_BODY_BYTES;
