const crypto = require("node:crypto");
const { getAttachmentBinary } = require("./_pa-gmail.cjs");
const portal = require("./_pa-portal.cjs");

const SECRET = /^[a-f0-9]{64}$/u;
const SESSION_SECONDS = 12 * 60 * 60;
const sha256 = (value) => crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
const randomSecret = () => crypto.randomBytes(32).toString("hex");
const requireSecret = (value) => { const token = String(value || "").toLowerCase(); if (!SECRET.test(token)) throw new Error("link_unavailable"); return token; };
const serviceRpc = (name, body, fetchImpl = fetch) => portal.rpc(portal.bearerConfig().key, name, body, fetchImpl);
const publicLink = (token) => `/event-portal#${token}`;

const manageLink = async ({ accessToken, caseId, action, expiresAt }, fetchImpl = fetch) => {
    if (!["status", "create", "revoke", "rotate"].includes(action)) throw new Error("invalid_link_action");
    let token = null;
    if (["create", "rotate"].includes(action)) token = randomSecret();
    const result = await portal.rpc(accessToken, "pa_portal_manage_link", {
        p_case_id: caseId,
        p_action: action,
        p_token_hash: token ? sha256(token) : null,
        p_expires_at: expiresAt || null
    }, fetchImpl);
    return token ? { ...result, share_url: publicLink(token) } : result;
};

const exchange = async (rawToken, fetchImpl = fetch) => {
    const token = requireSecret(rawToken);
    const session = randomSecret();
    const result = await serviceRpc("pa_portal_exchange", {
        p_token_hash: sha256(token),
        p_session_hash: sha256(session),
        p_session_expires_at: new Date(Date.now() + SESSION_SECONDS * 1000).toISOString()
    }, fetchImpl);
    if (!result?.ok) throw new Error("link_unavailable");
    return { session, expiresAt: result.expires_at };
};

const sessionHash = (rawSession) => sha256(requireSecret(rawSession));
const read = async (rawSession, fetchImpl = fetch) => {
    const result = await serviceRpc("pa_portal_organizer_read", { p_session_hash: sessionHash(rawSession) }, fetchImpl);
    if (!result?.ok) throw new Error("link_unavailable");
    return result.portal;
};
const authorize = async (rawSession, operation, payload, fetchImpl = fetch) => {
    const result = await serviceRpc("pa_portal_organizer_authorize", { p_session_hash: sessionHash(rawSession), p_operation: operation, p_payload: payload }, fetchImpl);
    if (!result?.ok) throw new Error(result?.code || "not_permitted");
    return result;
};
const apply = async (rawSession, operation, payload, idempotencyKey, fetchImpl = fetch) => {
    const result = await serviceRpc("pa_portal_organizer_apply", { p_session_hash: sessionHash(rawSession), p_operation: operation, p_payload: payload, p_idempotency_key: idempotencyKey }, fetchImpl);
    if (!result?.ok) throw new Error(result?.code || "not_permitted");
    return result.result;
};

const mutate = async ({ session, operation, payload, idempotencyKey }, fetchImpl = fetch) => {
    if (!/^[0-9a-f-]{36}$/iu.test(String(idempotencyKey || "")) || !payload || Array.isArray(payload) || typeof payload !== "object") throw new Error("invalid_input");
    if (!["add_version", "add_photo", "switch_current", "archive_card", "archive_photo", "archive_version", "update_photo_caption"].includes(operation)) throw new Error("invalid_operation");
    if (!payload.upload) return apply(session, operation, payload, idempotencyKey, fetchImpl);
    if (!["add_version", "add_photo"].includes(operation)) throw new Error("invalid_upload");
    const upload = portal.decodeUpload(payload.upload);
    const permission = await authorize(session, operation, { ...payload, upload: undefined }, fetchImpl);
    const storagePath = `organizer/${permission.portal_ref}/${idempotencyKey}/${upload.sha256.slice(0, 16)}-${upload.filename}`;
    let uploaded = false;
    try {
        try {
            await portal.storageRequest(storagePath, { method: "POST", headers: { "content-type": upload.mime, "x-upsert": "false" }, body: upload.bytes }, fetchImpl);
            uploaded = true;
        } catch (error) { if (error.status !== 409) throw error; }
        return await apply(session, operation, { ...payload, upload: undefined, source_type: "portal_upload", source_key: `storage:${storagePath}:${upload.sha256}`, source_ref: { storage_path: storagePath, sha256: upload.sha256, size: upload.bytes.length }, display_filename: upload.filename, mime_type: upload.mime }, idempotencyKey, fetchImpl);
    } catch (error) {
        if (uploaded) await portal.storageRequest(storagePath, { method: "DELETE" }, fetchImpl).catch(() => {});
        throw error;
    }
};

const download = async ({ session, assetRef, kind }, fetchImpl = fetch) => {
    if (!/^[a-f0-9]{36}$/u.test(String(assetRef || "")) || !["version", "photo"].includes(kind)) throw new Error("invalid_asset");
    const asset = await serviceRpc("pa_portal_organizer_asset", { p_session_hash: sessionHash(session), p_asset_ref: assetRef, p_asset_kind: kind }, fetchImpl);
    if (!asset?.ok) throw new Error("asset_unavailable");
    if (["gmail_attachment", "pa_attachment"].includes(asset.source_type)) return getAttachmentBinary({ inquiryId: asset.case_id, gmailMessageId: asset.source_ref.gmail_message_id, gmailAttachmentId: asset.source_ref.gmail_attachment_id, gmailPartId: asset.gmail_part_id || "" }, fetchImpl);
    const response = await portal.storageRequest(asset.source_ref.storage_path, { method: "GET" }, fetchImpl);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (crypto.createHash("sha256").update(bytes).digest("hex") !== asset.source_ref.sha256) throw new Error("asset_identity_mismatch");
    return { bytes, filename: asset.display_filename, mime_type: asset.mime_type };
};

module.exports = { SECRET, SESSION_SECONDS, download, exchange, manageLink, mutate, randomSecret, read, sha256 };
