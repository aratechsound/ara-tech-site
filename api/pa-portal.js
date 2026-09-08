const portal = require("./_pa-portal.cjs");
const organizer = require("./_pa-portal-organizer.cjs");
const { streamAttachmentResponse } = require("./_pa-gmail.cjs");
const { verifyAdmin } = require("./_pa-mail.cjs");
const { applyOriginPolicy, checkRateLimit, isRateLimitUnavailable } = require("./_request-security.cjs");

const MAX_BODY_BYTES = 4_400_000;
const bearer = (request) => { const match = String(request.headers?.authorization || "").match(/^Bearer ([^\s]+)$/u); if (!match) throw new Error("not_authorized"); return match[1]; };
const body = (request) => {
    let value; try { value = request.body && typeof request.body === "object" && !Buffer.isBuffer(request.body) ? request.body : JSON.parse(String(request.body || "")); } catch { throw new Error("invalid_input"); }
    if (!value || Array.isArray(value) || Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_BODY_BYTES) throw new Error("invalid_input"); return value;
};
const json = (response, status, payload) => { response.setHeader("Content-Type", "application/json; charset=utf-8"); response.setHeader("Cache-Control", "private, no-store, max-age=0"); response.setHeader("X-Content-Type-Options", "nosniff"); return response.status(status).json(payload); };

module.exports = async (request, response) => {
    if (request.method !== "POST") { response.setHeader("Allow", "POST"); return json(response, 405, { ok: false, code: "method_not_allowed" }); }
    if (!applyOriginPolicy(request, response)) return json(response, 403, { ok: false, code: "invalid_origin" });
    try {
        const token = bearer(request); const user = await verifyAdmin(token); const input = body(request);
        const mutation = !["read", "candidates", "download"].includes(input.action);
        const rate = await checkRateLimit({ request, policyName: mutation ? "PA_PORTAL_MUTATE" : "PA_PORTAL_READ", scope: user.id });
        if (!rate.allowed) { response.setHeader("Retry-After", String(Math.max(1, rate.retryAfter))); return json(response, 429, { ok: false, code: "rate_limited" }); }
        if (input.action === "read") return json(response, 200, { ok: true, result: await portal.readPortal({ caseId: input.inquiry_id, accessToken: token }) });
        if (input.action === "candidates") return json(response, 200, { ok: true, result: await portal.candidates({ caseId: input.inquiry_id }) });
        if (input.action === "download") return streamAttachmentResponse(response, await portal.download({ caseId: input.inquiry_id, accessToken: token, assetId: input.asset_id, kind: input.asset_kind }));
        if (["link_status", "link_create", "link_revoke", "link_rotate"].includes(input.action)) return json(response, 200, { ok: true, result: await organizer.manageLink({ accessToken: token, caseId: input.inquiry_id, action: input.action.slice(5), expiresAt: input.expires_at }) });
        return json(response, 200, { ok: true, result: await portal.mutate({ caseId: input.inquiry_id, accessToken: token, operation: input.action, payload: input.payload, idempotencyKey: input.idempotency_key }) });
    } catch (error) {
        const code = String(error?.message || "service_unavailable");
        if (code === "not_authorized") return json(response, 401, { ok: false, code });
        if (/^(invalid_|active_link_exists|portal_not_found|inquiry_not_found|attachment_case_mismatch|upload_case_mismatch|asset_case_mismatch|version_case_mismatch|card_case_mismatch|photo_case_mismatch|cannot_archive_current|portal_source_already_used|storage_409)/u.test(code)) return json(response, 400, { ok: false, code });
        if (isRateLimitUnavailable(error)) return json(response, 503, { ok: false, code: "service_unavailable" });
        console.error("pa-portal operation failed", { diagnostic: /^storage_\d{3}$/u.test(code) ? code : "unclassified", error_type: String(error?.name || "Error").replace(/[^A-Za-z0-9_]/gu, "").slice(0, 80) });
        return json(response, 503, { ok: false, code: "service_unavailable" });
    }
};

module.exports.MAX_BODY_BYTES = MAX_BODY_BYTES;
