const crypto = require("node:crypto");
const { getInquiry, isUuid, supabaseRequest } = require("./_pa-mail.cjs");
const { getAttachmentBinary, portalDocuments } = require("./_pa-gmail.cjs");

const BUCKET = "pa-portal-assets";
const MAX_UPLOAD_BYTES = 3 * 1024 * 1024;
const MIME = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp"]);
const OWNER = new Set(["organizer", "ara_tech", "shared", "performer"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const safeFilename = (value) => {
    const name = String(value || "").normalize("NFKC").replace(/[\u0000-\u001f\u007f\\/]/gu, "_").replace(/\s+/gu, " ").trim().slice(0, 180);
    if (!name || name === "." || name === ".." || /\.(?:exe|dll|bat|cmd|com|msi|ps1|js|mjs|html?|svg|jar|scr)$/iu.test(name)) throw new Error("invalid_upload_filename");
    return name;
};
const canonicalMime = (value) => String(value || "").toLowerCase().split(";")[0].trim();
const validateMagic = (bytes, mime) => {
    if (mime === "application/pdf") return bytes.subarray(0, 5).toString("ascii") === "%PDF-";
    if (mime === "image/png") return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    if (mime === "image/jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9;
    if (mime === "image/webp") return bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
    return false;
};
const decodeUpload = ({ filename, mime_type: requestedMime, data_base64: data }) => {
    const mime = canonicalMime(requestedMime);
    if (!MIME.has(mime) || typeof data !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/u.test(data)) throw new Error("invalid_upload");
    const bytes = Buffer.from(data, "base64");
    if (!bytes.length || bytes.length > MAX_UPLOAD_BYTES || !validateMagic(bytes, mime)) throw new Error(bytes.length > MAX_UPLOAD_BYTES ? "upload_too_large" : "invalid_upload");
    return { bytes, mime, filename: safeFilename(filename), sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
};
const bearerConfig = () => {
    const url = String(process.env.SUPABASE_URL || "https://kogbnremsouajxxsgxro.supabase.co").replace(/\/+$/u, "");
    const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
    if (!key) throw new Error("supabase_not_configured");
    return { url, key };
};
const rpc = (token, name, body, fetchImpl = fetch) => supabaseRequest(`/rest/v1/rpc/${name}`, {
    method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body)
}, fetchImpl);
const readPortal = async ({ caseId, accessToken }, fetchImpl = fetch) => {
    if (!isUuid(caseId)) throw new Error("invalid_inquiry");
    await getInquiry(caseId, fetchImpl);
    return rpc(accessToken, "pa_portal_read", { p_case_id: caseId }, fetchImpl);
};
const candidates = async ({ caseId }, fetchImpl = fetch) => {
    const messages = await portalDocuments({ inquiryId: caseId }, fetchImpl);
    return messages.flatMap((message) => (Array.isArray(message.attachment_metadata) ? message.attachment_metadata : []).filter((item) => !/(見積|estimate|契約|contract|請求|invoice|領収|receipt)/iu.test(`${item.filename || ""} ${message.subject || ""}`)).map((item) => ({
        source_type: message.message_source === "pa_case_manager" ? "pa_attachment" : "gmail_attachment",
        source_ref: { gmail_message_id: message.gmail_message_id, gmail_attachment_id: String(item.id || "") },
        source_key: `${message.gmail_message_id}:${String(item.id || "")}`,
        display_filename: String(item.filename || ""), mime_type: canonicalMime(item.mime_type),
        contributor_kind: message.direction === "inbound" ? "organizer" : "ara_tech",
        source_created_at: message.received_at || message.sent_at || null
    })).filter((item) => item.source_ref.gmail_attachment_id && item.display_filename && MIME.has(item.mime_type)));
};
const normalizeExisting = async (caseId, source, fetchImpl) => {
    if (!source || !["gmail_attachment", "pa_attachment"].includes(source.source_type)) throw new Error("invalid_source");
    const ref = source.source_ref || {};
    const allowed = (await candidates({ caseId }, fetchImpl)).find((candidate) => candidate.source_type === source.source_type && candidate.source_ref.gmail_message_id === ref.gmail_message_id && candidate.source_ref.gmail_attachment_id === ref.gmail_attachment_id);
    if (!allowed) throw new Error("attachment_case_mismatch");
    const attachment = await getAttachmentBinary({ inquiryId: caseId, gmailMessageId: ref.gmail_message_id, gmailAttachmentId: ref.gmail_attachment_id }, fetchImpl);
    const mime = canonicalMime(attachment.mime_type);
    if (!MIME.has(mime)) throw new Error("invalid_source");
    return { source_type: source.source_type, source_ref: ref, source_key: `${ref.gmail_message_id}:${ref.gmail_attachment_id}`, display_filename: safeFilename(attachment.filename), mime_type: mime };
};
const storageRequest = async (path, options, fetchImpl) => {
    const { url, key } = bearerConfig();
    const response = await fetchImpl(`${url}/storage/v1/object/${BUCKET}/${path.split("/").map(encodeURIComponent).join("/")}`, { ...options, headers: { apikey: key, authorization: `Bearer ${key}`, ...(options.headers || {}) } });
    if (!response.ok) { const error = new Error(`storage_${response.status}`); error.status = response.status; throw error; }
    return response;
};
const apply = (accessToken, caseId, operation, payload, idempotencyKey, fetchImpl) => {
    if (!UUID.test(String(idempotencyKey || ""))) throw new Error("invalid_idempotency_key");
    return rpc(accessToken, "pa_portal_apply", { p_case_id: caseId, p_operation: operation, p_payload: payload, p_idempotency_key: idempotencyKey }, fetchImpl);
};
const mutate = async ({ caseId, accessToken, operation, payload, idempotencyKey }, fetchImpl = fetch) => {
    if (!isUuid(caseId) || !payload || Array.isArray(payload) || typeof payload !== "object") throw new Error("invalid_input");
    if (["create_card", "switch_current", "archive_card", "archive_photo", "archive_version"].includes(operation)) return apply(accessToken, caseId, operation, payload, idempotencyKey, fetchImpl);
    if (!["add_version", "add_photo"].includes(operation) || !OWNER.has(payload.contributor_kind)) throw new Error("invalid_operation");
    if (payload.upload) {
        const upload = decodeUpload(payload.upload);
        const assetId = String(idempotencyKey);
        const storagePath = `cases/${caseId}/${assetId}/${upload.sha256.slice(0, 16)}-${upload.filename}`;
        let uploaded = false;
        try {
            try {
                await storageRequest(storagePath, { method: "POST", headers: { "content-type": upload.mime, "x-upsert": "false" }, body: upload.bytes }, fetchImpl);
                uploaded = true;
            } catch (error) { if (error.status !== 409) throw error; }
            return await apply(accessToken, caseId, operation, { ...payload, upload: undefined, source_type: "portal_upload", source_key: `storage:${storagePath}:${upload.sha256}`, source_ref: { storage_path: storagePath, sha256: upload.sha256, size: upload.bytes.length }, display_filename: upload.filename, mime_type: upload.mime }, idempotencyKey, fetchImpl);
        } catch (error) {
            if (uploaded) await storageRequest(storagePath, { method: "DELETE" }, fetchImpl).catch(() => {});
            throw error;
        }
    }
    const source = await normalizeExisting(caseId, payload.source, fetchImpl);
    return apply(accessToken, caseId, operation, { ...payload, source: undefined, ...source }, idempotencyKey, fetchImpl);
};
const findAsset = (model, id, kind) => {
    if (kind === "photo") return (model?.photos || []).find((item) => item.id === id);
    for (const card of model?.cards || []) { const version = (card.versions || []).find((item) => item.id === id); if (version) return version; }
    return null;
};
const download = async ({ caseId, accessToken, assetId, kind }, fetchImpl = fetch) => {
    if (!UUID.test(String(assetId || "")) || !["version", "photo"].includes(kind)) throw new Error("invalid_asset");
    const asset = findAsset(await readPortal({ caseId, accessToken }, fetchImpl), assetId, kind);
    if (!asset) throw new Error("asset_case_mismatch");
    if (["gmail_attachment", "pa_attachment"].includes(asset.source_type)) return getAttachmentBinary({ inquiryId: caseId, gmailMessageId: asset.source_ref.gmail_message_id, gmailAttachmentId: asset.source_ref.gmail_attachment_id }, fetchImpl);
    const response = await storageRequest(asset.source_ref.storage_path, { method: "GET" }, fetchImpl);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (crypto.createHash("sha256").update(bytes).digest("hex") !== asset.source_ref.sha256) throw new Error("asset_identity_mismatch");
    return { bytes, filename: asset.display_filename, mime_type: asset.mime_type };
};

module.exports = { BUCKET, MAX_UPLOAD_BYTES, candidates, decodeUpload, download, mutate, readPortal, safeFilename };
