const crypto = require("node:crypto");
const { isUuid, supabaseRequest } = require("./_pa-mail.cjs");

const MIME = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp"]);
const CATEGORY = new Set(["timetable", "script", "layout", "photo", "performer", "other"]);
const ACTION = new Set(["add_new_version", "create_new_card", "add_photo", "hold_performer"]);
const CONFIDENCE = new Set(["high", "medium", "low"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const GMAIL_ID = /^[A-Za-z0-9_-]{1,200}$/u;
const ATTACHMENT_ID = /^[^\s\u0000-\u001f\\/]{1,1000}$/u;
const CANONICAL_KEY = /^gmail:message-part:v1:[a-f0-9]{64}$/u;
const CATEGORY_RULES = Object.freeze({
    timetable: /(タイムテーブル|time\s*table|timetable|進行表|香盤)/iu,
    script: /(台本|script|進行台本)/iu,
    performer: /(出演者|出演順|performer|artist|アーティスト)/iu,
    layout: /(会場図|配置図|平面図|電源|搬入|導線|layout|stage\s*plot|ステージ図|音響|diagram|map)/iu,
    photo: /(写真|photo|stage[\s_-]*photo|venue[\s_-]*photo|現調)/iu
});
const CATEGORY_ORDER = ["timetable", "script", "performer", "layout", "photo"];

const canonicalAssetKey = (gmailMessageId, gmailPartId) => {
    if (!GMAIL_ID.test(String(gmailMessageId || "")) || !ATTACHMENT_ID.test(String(gmailPartId || ""))) return "";
    const digest = crypto.createHash("sha256").update(`gmail\u001f${gmailMessageId}\u001f${gmailPartId}`, "utf8").digest("hex");
    return `gmail:message-part:v1:${digest}`;
};

const canonicalMime = (value, filename = "") => {
    const mime = String(value || "").toLowerCase().split(";")[0].trim();
    if (MIME.has(mime)) return mime;
    if (/\.pdf$/iu.test(filename)) return "application/pdf";
    if (/\.png$/iu.test(filename)) return "image/png";
    if (/\.webp$/iu.test(filename)) return "image/webp";
    if (/\.jpe?g$/iu.test(filename)) return "image/jpeg";
    return "";
};
const bounded = (value, length) => String(value || "").normalize("NFKC").replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, length);
const titleFromFilename = (value) => bounded(value, 255)
    .replace(/\.[A-Za-z0-9]{1,8}$/u, "")
    .replace(/[＿_\s-]*(?:最新版|最終版?|確定版|修正版|改訂版|final)(?:[＿_\s-]*\d+(?:\.\d+)?)?$/iu, "")
    .replace(/[＿_\s-]*(?:最新版|最終版?|確定版|修正版|改訂版|final|ver(?:sion)?|v)?[＿_\s-]*\d+(?:\.\d+)?$/iu, "")
    .trim().slice(0, 160) || "資料";
const normalizedTitle = (value) => titleFromFilename(value).toLowerCase().replace(/[\s＿_\-・／/]+/gu, "");
const isBusinessDocument = (item) => /(見積|estimate|quotation|契約|contract|請求|invoice|領収|receipt|支払|payment)/iu.test(item.filename || "");
const isSignatureImage = (item) => {
    if (!/^image\//u.test(item.mime_type || "")) return false;
    const size = Number(item.size || 0);
    const inline = item.inline === true || Boolean(item.content_id) || /^inline(?:;|$)/iu.test(String(item.content_disposition || ""));
    const signatureName = /(?:^|[._\-\s])(logo|signature|sig|facebook|instagram|twitter|x-icon|linkedin|youtube|social|icon|pixel|spacer|tracker|tracking|qr)(?:[._\-\s]|$)/iu.test(item.filename || "");
    return (size > 0 && size <= 4096) || (inline && signatureName && (size <= 0 || size <= 200 * 1024));
};
const matchingCard = (category, filename, cards) => {
    const sameCategory = cards.filter((card) => card.category === category && !card.archived_at);
    if (["timetable", "script"].includes(category)) return sameCategory.find((card) => card.card_kind === "fixed") || sameCategory[0] || null;
    const title = normalizedTitle(filename);
    return sameCategory.find((card) => {
        const existing = normalizedTitle(card.title);
        return existing === title || (Math.min(existing.length, title.length) >= 4 && (existing.includes(title) || title.includes(existing)));
    }) || null;
};
const matchingCategories = (value) => CATEGORY_ORDER.filter((category) => CATEGORY_RULES[category].test(value));
const mimeSupportsCategory = (category, mime) => {
    const image = /^image\//u.test(mime || "");
    if (category === "photo") return image;
    if (["timetable", "script"].includes(category)) return mime === "application/pdf";
    return category === "layout" || category === "performer" ? image || mime === "application/pdf" : true;
};
const suggestionFor = (item, cards = []) => {
    const filename = String(item.filename || "").normalize("NFKC").toLowerCase();
    const subject = String(item.subject || "").normalize("NFKC").toLowerCase();
    const filenameSignals = matchingCategories(filename);
    const subjectSignals = matchingCategories(subject);
    const image = /^image\//u.test(item.mime_type || "");
    let category = "other";
    let confidence = "low";
    let basis = "一致する分類語がないためその他資料として要確認";
    if (filenameSignals.length) {
        category = filenameSignals[0];
        const conflict = !mimeSupportsCategory(category, item.mime_type)
            || filenameSignals.some((signal) => signal !== category)
            || subjectSignals.some((signal) => signal !== category);
        confidence = conflict ? "medium" : "high";
        basis = `ファイル名の${category}系語句${image ? "＋画像MIME" : "＋文書MIME"}${conflict ? "／件名・ファイル名・MIMEに競合する分類シグナルがあるため確信度を調整" : ""}`;
    } else if (image) {
        category = "photo";
        const subjectConflict = subjectSignals.some((signal) => signal !== "photo");
        confidence = subjectConflict ? "low" : "medium";
        basis = subjectConflict
            ? "画像MIMEを写真候補として優先／件名だけに別分類シグナルがあるため要確認"
            : "画像MIMEを写真候補として採用／ファイル名に強い分類語がないため確信度は中";
    } else if (subjectSignals.length) {
        category = subjectSignals[0];
        confidence = "low";
        basis = "件名のみの分類signalのため確信度は低";
    }
    const card = matchingCard(category, item.filename, cards);
    let action = "create_new_card";
    if (["timetable", "script"].includes(category)) action = "add_new_version";
    else if (category === "photo") action = "add_photo";
    else if (category === "performer") action = "hold_performer";
    else if (card) action = "add_new_version";
    if (card) basis += `／既存カード「${bounded(card.title, 160)}」と一致`;
    return {
        suggested_category: category,
        suggested_card_id: card?.id || null,
        suggested_action: action,
        suggested_title: category === "timetable" ? "タイムテーブル" : category === "script" ? "台本" : titleFromFilename(item.filename),
        confidence,
        suggestion_basis: basis.slice(0, 500)
    };
};
const normalizedAttachments = (messages) => (Array.isArray(messages) ? messages : []).flatMap((message) => {
    const gmailMessageId = String(message?.gmail_message_id || message?.id || "");
    const direction = String(message?.direction || "");
    const attachments = Array.isArray(message?.attachment_metadata) ? message.attachment_metadata : Array.isArray(message?.attachments) ? message.attachments : [];
    if (!GMAIL_ID.test(gmailMessageId) || !["inbound", "outbound"].includes(direction)) return [];
    return attachments.map((attachment) => {
        const filename = String(attachment?.filename || "").replace(/[\u0000-\u001f\u007f\\/]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 255);
        const gmailPartId = String(attachment?.part_id || "");
        return {
            gmail_message_id: gmailMessageId,
            gmail_attachment_id: String(attachment?.id || ""),
            gmail_part_id: ATTACHMENT_ID.test(gmailPartId) ? gmailPartId : "",
            canonical_attachment_key: canonicalAssetKey(gmailMessageId, gmailPartId),
            filename,
            mime_type: canonicalMime(attachment?.mime_type, filename),
            size: Number(attachment?.size || 0),
            inline: attachment?.inline === true,
            content_id: bounded(attachment?.content_id, 500),
            content_disposition: bounded(attachment?.content_disposition, 500),
            subject: bounded(message?.subject, 500)
        };
    }).filter((item) => ATTACHMENT_ID.test(item.gmail_attachment_id) && item.filename && MIME.has(item.mime_type));
});
const buildProposals = (messages, cards = []) => {
    const proposals = [];
    let businessExcluded = 0;
    let signatureExcluded = 0;
    for (const item of normalizedAttachments(messages)) {
        if (isBusinessDocument(item)) { businessExcluded += 1; continue; }
        if (isSignatureImage(item)) { signatureExcluded += 1; continue; }
        proposals.push({
            gmail_message_id: item.gmail_message_id,
            gmail_attachment_id: item.gmail_attachment_id,
            gmail_part_id: item.gmail_part_id,
            canonical_attachment_key: item.canonical_attachment_key,
            display_filename: item.filename,
            mime_type: item.mime_type,
            size: item.size,
            ...suggestionFor(item, cards)
        });
    }
    return { proposals, businessExcluded, signatureExcluded };
};
const serviceRpc = (name, body, fetchImpl) => supabaseRequest(`/rest/v1/rpc/${name}`, { method: "POST", body: JSON.stringify(body) }, fetchImpl);
const authRpc = (accessToken, name, body, fetchImpl) => supabaseRequest(`/rest/v1/rpc/${name}`, { method: "POST", headers: { authorization: `Bearer ${accessToken}` }, body: JSON.stringify(body) }, fetchImpl);
const contextCards = async (caseId, fetchImpl) => {
    const portals = await supabaseRequest(`/rest/v1/pa_portals?${new URLSearchParams({ case_id: `eq.${caseId}`, select: "id", limit: "1" })}`, {}, fetchImpl);
    if (!Array.isArray(portals) || !portals[0]) return [];
    const rows = await supabaseRequest(`/rest/v1/pa_portal_document_cards?${new URLSearchParams({ portal_id: `eq.${portals[0].id}`, archived_at: "is.null", select: "id,category,title,card_kind,archived_at", limit: "500" })}`, {}, fetchImpl);
    return Array.isArray(rows) ? rows : [];
};
const contentIdentity = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const identityContext = (caseId, fetchImpl) => serviceRpc("pa_portal_candidate_identity_context", { p_case_id: caseId }, fetchImpl);
const buildIdentityMappings = async ({ caseId, proposals, registered, attachmentVariantLoader }, fetchImpl) => {
    if (typeof attachmentVariantLoader !== "function") return { mappings: [], unresolved: [] };
    const mappings = [];
    const unresolved = [];
    const cache = new Map();
    const load = async (messageId, attachmentId) => {
        const key = `${messageId}\u001f${attachmentId}`;
        if (!cache.has(key)) cache.set(key, attachmentVariantLoader({ inquiryId: caseId, gmailMessageId: messageId, gmailAttachmentId: attachmentId }, fetchImpl));
        return cache.get(key);
    };
    for (const asset of Array.isArray(registered) ? registered : []) {
        if (!asset || asset.canonical_attachment_key || !["gmail_attachment", "pa_attachment"].includes(asset.source_type)) continue;
        const messageId = String(asset.source_ref?.gmail_message_id || "");
        const historicalAttachmentId = String(asset.source_ref?.gmail_attachment_id || "");
        const possible = proposals.filter((item) => item.gmail_message_id === messageId
            && item.display_filename === asset.display_filename
            && item.mime_type === asset.mime_type
            && item.gmail_part_id && CANONICAL_KEY.test(item.canonical_attachment_key));
        if (!GMAIL_ID.test(messageId) || !ATTACHMENT_ID.test(historicalAttachmentId) || !possible.length) continue;
        let matched = null;
        let proofType = "";
        let digest = "";
        if (possible.length === 1 && possible[0].gmail_attachment_id === historicalAttachmentId) {
            matched = possible[0];
            proofType = "exact_attachment_identity";
        } else {
            try {
                const historical = await load(messageId, historicalAttachmentId);
                const historicalDigest = contentIdentity(historical.bytes);
                const exact = [];
                for (const current of possible) {
                    const currentBinary = await load(messageId, current.gmail_attachment_id);
                    if (currentBinary.size === historical.size && contentIdentity(currentBinary.bytes) === historicalDigest) exact.push(current);
                }
                if (exact.length === 1) {
                    [matched] = exact;
                    proofType = "same_message_content_sha256";
                    digest = historicalDigest;
                }
            } catch {
                matched = null;
            }
        }
        if (!matched) {
            unresolved.push({ asset_kind: asset.asset_kind, asset_id: asset.asset_id, display_filename: asset.display_filename });
            continue;
        }
        mappings.push({
            asset_kind: asset.asset_kind,
            asset_id: asset.asset_id,
            gmail_message_id: messageId,
            historical_attachment_id: historicalAttachmentId,
            current_attachment_id: matched.gmail_attachment_id,
            gmail_part_id: matched.gmail_part_id,
            canonical_attachment_key: matched.canonical_attachment_key,
            display_filename: asset.display_filename,
            mime_type: asset.mime_type,
            source_byte_size: matched.size,
            content_sha256: digest,
            proof_type: proofType,
            suggested_category: matched.suggested_category,
            suggested_card_id: matched.suggested_card_id,
            suggested_action: matched.suggested_action,
            suggested_title: matched.suggested_title,
            confidence: matched.confidence,
            suggestion_basis: matched.suggestion_basis
        });
    }
    return { mappings, unresolved };
};
const detectCandidates = async ({ caseId, actorId, messages, attachmentVariantLoader }, fetchImpl = fetch) => {
    if (!isUuid(caseId) || !isUuid(actorId)) throw new Error("invalid_candidate_detection");
    const cards = await contextCards(caseId, fetchImpl);
    const built = buildProposals(messages, cards);
    const context = await identityContext(caseId, fetchImpl);
    const prepared = await buildIdentityMappings({ caseId, proposals: built.proposals, registered: context?.registered, attachmentVariantLoader }, fetchImpl);
    const reconciliation = prepared.mappings.length
        ? await serviceRpc("pa_portal_candidate_reconcile", { p_case_id: caseId, p_actor_id: actorId, p_mappings: prepared.mappings }, fetchImpl)
        : { reconciled: 0, suggestions_recalculated: 0 };
    const result = await serviceRpc("pa_portal_candidate_detect", { p_case_id: caseId, p_actor_id: actorId, p_items: built.proposals }, fetchImpl);
    return { ...result, reconciliation, unresolved_identity_count: prepared.unresolved.length, business_excluded: built.businessExcluded, signature_excluded: built.signatureExcluded };
};
const backfillCandidates = async ({ caseId, actorId }, fetchImpl = fetch, attachmentVariantLoader) => {
    if (!isUuid(caseId) || !isUuid(actorId)) throw new Error("invalid_candidate_detection");
    const links = await supabaseRequest(`/rest/v1/pa_gmail_thread_links?${new URLSearchParams({ inquiry_id: `eq.${caseId}`, select: "gmail_thread_id", limit: "500" })}`, {}, fetchImpl);
    const linked = new Set((Array.isArray(links) ? links : []).map((item) => item.gmail_thread_id));
    const rows = await supabaseRequest(`/rest/v1/pa_gmail_message_index?${new URLSearchParams({ inquiry_id: `eq.${caseId}`, select: "gmail_message_id,gmail_thread_id,direction,subject,attachment_metadata", order: "indexed_at.desc", limit: "500" })}`, {}, fetchImpl);
    return detectCandidates({ caseId, actorId, messages: (Array.isArray(rows) ? rows : []).filter((message) => linked.has(message.gmail_thread_id)), attachmentVariantLoader }, fetchImpl);
};
const listCandidates = async ({ caseId, accessToken }, fetchImpl = fetch) => {
    if (!isUuid(caseId)) throw new Error("invalid_inquiry");
    return authRpc(accessToken, "pa_portal_candidate_read", { p_case_id: caseId }, fetchImpl);
};
const candidateAsset = async ({ caseId, candidateId, accessToken }, fetchImpl = fetch) => {
    if (!isUuid(caseId) || !UUID.test(String(candidateId || ""))) throw new Error("invalid_candidate");
    return authRpc(accessToken, "pa_portal_candidate_asset", { p_case_id: caseId, p_candidate_id: candidateId }, fetchImpl);
};
const reviewCandidate = async ({ caseId, candidateId, accessToken, decision, target, idempotencyKey }, fetchImpl = fetch) => {
    if (!isUuid(caseId) || !UUID.test(String(candidateId || "")) || !UUID.test(String(idempotencyKey || "")) || !["accept", "ignore"].includes(decision)) throw new Error("invalid_candidate_review");
    if (!target || Array.isArray(target) || typeof target !== "object") throw new Error("invalid_candidate_target");
    return authRpc(accessToken, "pa_portal_candidate_apply", { p_case_id: caseId, p_candidate_id: candidateId, p_decision: decision, p_target: target, p_idempotency_key: idempotencyKey }, fetchImpl);
};

module.exports = {
    ACTION,
    CATEGORY,
    CONFIDENCE,
    backfillCandidates,
    buildProposals,
    buildIdentityMappings,
    candidateAsset,
    canonicalAssetKey,
    canonicalMime,
    detectCandidates,
    isBusinessDocument,
    isSignatureImage,
    listCandidates,
    normalizedTitle,
    reviewCandidate,
    suggestionFor,
    titleFromFilename
};
