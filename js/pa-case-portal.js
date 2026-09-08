import { SUPABASE_ANON_KEY, SUPABASE_URL, isSupabaseConfigured } from "./supabase-config.js";

let createClient;
let pdfjsLib;
const loadBrowserDependencies = async (withAdminClient) => {
    const testDependencies = globalThis.__PA_PORTAL_TEST_DEPS__;
    if (testDependencies) {
        pdfjsLib = testDependencies.pdfjsLib;
        createClient = testDependencies.createClient;
    } else {
        pdfjsLib = await import("https://cdn.jsdelivr.net/npm/pdfjs-dist@6.3.289/build/pdf.min.mjs");
        if (withAdminClient) ({ createClient } = await import("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm"));
    }
    // Keep the PDF.js worker same-origin. PDF.js otherwise wraps the CDN module
    // worker in a Blob URL, which can fail before rendering in iOS Safari.
    pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.min.mjs?v=6.3.289";
};

const $ = (selector) => document.querySelector(selector);
const attachmentRecords = new Map();
const pdfDocuments = new Map();
let supabase;
let accessToken = "";
let caseId = "";
let previewRequest = 0;
let portalModel = null;
let editMode = false;
let sourceCandidates = [];
let candidateInbox = { pending_count: 0, candidates: [], cards: [] };
let manageSubmit = null;
let issuedShareUrl = "";
const organizerMode = /^\/event-portal\/?$/u.test(location.pathname);
if (organizerMode) { document.body.classList.add("organizer-portal"); document.querySelector("#candidate-inbox")?.remove(); }

const text = (value, fallback = "未設定") => String(value || "").trim() || fallback;
const dateText = (value) => value ? new Intl.DateTimeFormat("ja-JP", { year: "numeric", month: "long", day: "numeric" }).format(new Date(`${value}T00:00:00`)) : "未設定";
const timeText = (value) => text(value);
const documentTime = (item) => (item.source_created_at || item.occurred_at || item.created_at) ? new Intl.DateTimeFormat("ja-JP", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(item.source_created_at || item.occurred_at || item.created_at)) : "日時未登録";
const isImage = (item) => /^image\//iu.test(item.mime_type || "");
const isPdf = (item) => String(item.mime_type || "").toLowerCase() === "application/pdf" || /\.pdf$/iu.test(item.filename || "");
const canPreview = (item) => isImage(item) || isPdf(item);
const isCommercialDocument = (item) => /(見積|estimate|契約|contract|請求|invoice|領収|receipt)/iu.test(`${item.filename} ${item.subject}`);
const categoryFor = (item) => {
    const source = `${item.filename} ${item.subject}`.toLowerCase();
    if (/(タイムテーブル|time\s*table|timetable|進行表|香盤)/iu.test(source)) return "timetable";
    if (/(台本|script|進行台本)/iu.test(source)) return "script";
    if (/(出演者|出演順|performer|artist|アーティスト)/iu.test(source)) return "performer";
    if (isImage(item) || /(写真|photo|stage.*(jpg|jpeg|png)|会場.*(jpg|jpeg|png))/iu.test(source)) return "photo";
    if (/(会場図|配置図|平面図|電源|搬入|導線|layout|stage\s*plot|ステージ図|音響)/iu.test(source)) return "layout";
    return "other";
};
const groupKey = (item) => item.logical_key || String(item.filename || "資料")
    .replace(/\.[A-Za-z0-9]{1,8}$/u, "")
    .replace(/[＿_\s-]*(最新版|最終|final|ver(?:sion)?|v)?[＿_\s-]*\d+(?:\.\d+)?$/iu, "")
    .trim() || "資料";
const sourceLabel = (item) => ({ organizer: "主催者・関係者提出", ara_tech: "ARA-TECH共有", shared: "共同資料", performer: "出演者提出" }[item.contributor_kind] || (item.direction === "inbound" ? "主催者・関係者提出" : "ARA-TECH共有"));
const sourceTypeLabel = (item) => ({ gmail_attachment: "メール添付", pa_attachment: "PA案件添付", portal_upload: "ポータル登録" }[item.source_type] || "既存資料");
const candidateCategoryLabel = (value) => ({ timetable: "タイムテーブル", script: "台本", layout: "会場図・配置図", photo: "会場・ステージ写真", performer: "出演者資料", other: "その他" }[value] || "その他");
const attachmentKey = (item) => `${item.asset_kind}:${item.asset_id}`;

const portalCaseId = () => {
    const match = decodeURIComponent(location.pathname).match(/^\/pa\/cases\/([0-9a-f-]{36})\/portal\/?$/iu);
    return match?.[1] || new URLSearchParams(location.search).get("case") || "";
};
const revealError = (message) => { $("#portal-loading").hidden = true; $("#portal-error").hidden = false; $("#portal-error").textContent = message; };

const getAttachmentRecord = async (item) => {
    const key = attachmentKey(item);
    if (attachmentRecords.has(key)) return attachmentRecords.get(key);
    const endpoint = organizerMode ? "/api/event-portal" : "/api/pa-portal";
    const requestBody = organizerMode
        ? { action: "download", asset_ref: item.asset_id, asset_kind: item.asset_kind }
        : item.asset_kind === "candidate"
            ? { action: "candidate_download", inquiry_id: caseId, candidate_id: item.asset_id }
            : { action: "download", inquiry_id: caseId, asset_id: item.asset_id, asset_kind: item.asset_kind };
    const response = await fetch(endpoint, { method: "POST", headers: { ...(organizerMode ? {} : { Authorization: `Bearer ${accessToken}` }), "Content-Type": "application/json" }, body: JSON.stringify(requestBody), cache: "no-store", credentials: "same-origin" });
    if (!response.ok) throw new Error("attachment_unavailable");
    const blob = await response.blob();
    const record = { blob, url: URL.createObjectURL(blob) };
    attachmentRecords.set(key, record);
    return record;
};
const getBlobUrl = async (item) => (await getAttachmentRecord(item)).url;
const getPdfDocument = async (item) => {
    const key = attachmentKey(item);
    if (pdfDocuments.has(key)) return pdfDocuments.get(key);
    const promise = getAttachmentRecord(item)
        .then(({ blob }) => blob.arrayBuffer())
        .then((data) => pdfjsLib.getDocument({ data }).promise)
        .catch((error) => { pdfDocuments.delete(key); throw error; });
    pdfDocuments.set(key, promise);
    return promise;
};
window.addEventListener("pagehide", () => attachmentRecords.forEach(({ url }) => URL.revokeObjectURL(url)));

const renderPdfPage = async (item, pageNumber, canvas, requestedCssWidth, requestedCssHeight = Number.POSITIVE_INFINITY) => {
    const pdf = await getPdfDocument(item);
    const page = await pdf.getPage(pageNumber);
    const base = page.getViewport({ scale: 1 });
    const cssScale = Math.min(requestedCssWidth / base.width, requestedCssHeight / base.height, 1.65);
    const cssWidth = Math.max(1, base.width * cssScale);
    const cssHeight = Math.max(1, base.height * cssScale);
    const outputScale = Math.min(window.devicePixelRatio || 1, 2);
    const viewport = page.getViewport({ scale: (cssWidth / base.width) * outputScale });
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    canvas.style.width = `${Math.round(cssWidth)}px`;
    canvas.style.height = `${Math.round(cssHeight)}px`;
    await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
    return pdf.numPages;
};

const closePreview = () => {
    previewRequest += 1;
    const dialog = $("#preview-dialog");
    if (dialog.open) dialog.close();
    $("#preview-dialog-body").replaceChildren();
};
const showPreview = async (item) => {
    if (!canPreview(item)) return;
    const requestId = ++previewRequest;
    const dialog = $("#preview-dialog");
    const body = $("#preview-dialog-body");
    $("#preview-dialog-title").textContent = item.filename || "資料プレビュー";
    const loading = document.createElement("span");
    loading.className = "modal-loading";
    loading.textContent = "資料を読み込んでいます…";
    body.replaceChildren(loading);
    if (!dialog.open) dialog.showModal();
    try {
        if (isImage(item)) {
            const image = document.createElement("img");
            image.src = await getBlobUrl(item);
            image.alt = item.filename;
            if (requestId === previewRequest) body.replaceChildren(image);
            return;
        }
        const pdf = await getPdfDocument(item);
        if (requestId !== previewRequest) return;
        const pages = document.createElement("div");
        pages.className = "pdf-pages";
        body.replaceChildren(pages);
        const availableWidth = Math.max(280, body.clientWidth - 28);
        for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
            if (requestId !== previewRequest) return;
            const canvas = document.createElement("canvas");
            canvas.setAttribute("aria-label", `${item.filename} ${pageNumber}ページ目`);
            pages.append(canvas);
            await renderPdfPage(item, pageNumber, canvas, Math.min(availableWidth, 1050));
        }
    } catch {
        if (requestId === previewRequest) {
            body.replaceChildren();
            const error = document.createElement("span");
            error.className = "modal-loading";
            error.textContent = "正本の添付資料を読み込めませんでした。";
            body.append(error);
        }
    }
};

const appendZoomLabel = (button) => {
    const zoom = document.createElement("span");
    zoom.className = "zoom-label";
    zoom.textContent = "クリックで拡大";
    button.append(zoom);
};
const makePreview = (item, { collection = false } = {}) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "document-card__preview";
    button.setAttribute("aria-label", `${item.filename}を拡大表示`);
    const loading = document.createElement("span");
    loading.className = "preview-loading";
    loading.textContent = isPdf(item) ? "PDFを描画しています…" : "画像を読み込んでいます…";
    button.append(loading);
    if (collection) {
        const label = document.createElement("span");
        label.className = "collection-label";
        label.textContent = item.logical_title || groupKey(item);
        button.append(label);
    }
    appendZoomLabel(button);
    if (isImage(item)) {
        getBlobUrl(item).then((url) => {
            const image = document.createElement("img");
            image.src = url;
            image.alt = item.filename;
            loading.replaceWith(image);
        }).catch(() => { loading.textContent = "表示不可"; });
    } else if (isPdf(item)) {
        const canvas = document.createElement("canvas");
        canvas.setAttribute("aria-hidden", "true");
        requestAnimationFrame(() => renderPdfPage(item, 1, canvas, Math.max(button.clientWidth, collection ? 360 : 560), button.clientHeight || (collection ? 250 : 315))
            .then(() => loading.replaceWith(canvas))
            .catch(() => { loading.className = "document-icon"; loading.textContent = "PDF"; }));
    } else {
        loading.className = "document-icon";
        loading.textContent = "資料";
    }
    button.addEventListener("click", () => showPreview(item));
    return button;
};
const makeHistoryThumbnail = (item) => {
    const thumb = document.createElement("div");
    thumb.className = "history-thumb";
    if (isImage(item)) {
        getBlobUrl(item).then((url) => { const image = document.createElement("img"); image.src = url; image.alt = ""; thumb.replaceChildren(image); }).catch(() => { thumb.textContent = "画像"; });
    } else if (isPdf(item)) {
        const canvas = document.createElement("canvas");
        renderPdfPage(item, 1, canvas, 64, 50).then(() => thumb.replaceChildren(canvas)).catch(() => { thumb.textContent = "PDF"; });
    } else { thumb.textContent = "資料"; }
    return thumb;
};
const makeHistory = (history) => {
    const details = document.createElement("details");
    details.className = "card-history";
    const summary = document.createElement("summary");
    summary.textContent = `過去版 ${history.length}件`;
    const list = document.createElement("ul");
    list.className = "history-list";
    history.forEach((item) => {
        const entry = document.createElement("li");
        entry.className = "history-row";
        const meta = document.createElement("div");
        meta.className = "history-meta";
        const name = document.createElement("strong");
        name.textContent = item.filename;
        const timestamp = document.createElement("span");
        timestamp.textContent = [text(item.version_label, "版ラベルなし"), sourceLabel(item), organizerMode ? "" : sourceTypeLabel(item), documentTime(item)].filter(Boolean).join(" ／ ");
        meta.append(name, timestamp);
        const actions = document.createElement("div");
        actions.className = "history-actions";
        const open = document.createElement("button");
        open.type = "button";
        open.className = "history-open";
        open.textContent = "開く";
        open.addEventListener("click", () => showPreview(item));
        actions.append(open);
        const restore = document.createElement("button");
        restore.type = "button";
        restore.className = "history-manage manage-only";
        restore.textContent = "最新版に戻す";
        restore.addEventListener("click", () => runMutation("switch_current", organizerMode ? { card_ref: item.card_id, version_ref: item.asset_id } : { card_id: item.card_id, version_id: item.asset_id }, "最新版を切り替えました"));
        const archive = document.createElement("button");
        archive.type = "button";
        archive.className = "history-manage manage-only";
        archive.textContent = "archive";
        archive.addEventListener("click", () => runMutation("archive_version", organizerMode ? { version_ref: item.asset_id } : { version_id: item.asset_id }, "過去版をarchiveしました"));
        if (!organizerMode || item.can_edit) actions.append(restore, archive);
        entry.append(makeHistoryThumbnail(item), meta, actions);
        list.append(entry);
    });
    details.append(summary, list);
    return details;
};
const makeDocumentCard = (latest, history = [], { fixed = false, collection = false } = {}) => {
    const card = document.createElement("article");
    card.className = `document-card${collection ? " collection-card" : ""}`;
    card.dataset.ownerEditable = String(!organizerMode || latest.can_edit);
    card.append(makePreview(latest, { collection }));
    const body = document.createElement("div");
    body.className = "document-card__body";
    const titleRow = document.createElement("div");
    titleRow.className = "title-row";
    const title = document.createElement("h3");
    title.className = "document-title";
    title.textContent = latest.filename || "資料";
    titleRow.append(title);
    if (fixed) {
        const fixedBadge = document.createElement("span");
        fixedBadge.className = "badge badge--fixed";
        fixedBadge.textContent = "固定枠";
        titleRow.append(fixedBadge);
    }
    const meta = document.createElement("p");
    meta.className = "document-card__meta";
    meta.textContent = `${sourceLabel(latest)} ／ ${documentTime(latest)}`;
    const badges = document.createElement("div");
    badges.className = "badges";
    const current = document.createElement("span");
    current.className = "badge badge--latest";
    current.textContent = "最新版";
    badges.append(current);
    const view = document.createElement("button");
    view.type = "button";
    view.className = "view-button";
    view.textContent = "大きく見る";
    view.addEventListener("click", () => showPreview(latest));
    body.append(titleRow, meta, badges, view);
    card.append(body);
    if (history.length) card.append(makeHistory(history));
    const management = document.createElement("div");
    management.className = "card-management";
    const add = document.createElement("button");
    add.type = "button";
    add.className = "card-manage";
    add.textContent = "新版を追加";
    add.addEventListener("click", () => openVersionDialog(latest.card_id, latest.logical_title));
    if (!organizerMode || latest.can_edit) management.append(add);
    if (!fixed && (!organizerMode || latest.can_edit)) {
        const archive = document.createElement("button");
        archive.type = "button";
        archive.className = "card-manage";
        archive.textContent = "カードをarchive";
        archive.addEventListener("click", () => runMutation("archive_card", organizerMode ? { card_ref: latest.card_id } : { card_id: latest.card_id }, "資料カードをarchiveしました"));
        management.append(archive);
    }
    card.append(management);
    return card;
};
const emptyCard = ({ title, message, icon, fixed = false, collection = false, cardId = null, canEdit = true }) => {
    const card = document.createElement("article");
    card.className = `empty-document-card document-card--placeholder${collection ? " collection-empty" : ""}`;
    const visual = document.createElement("div");
    visual.className = "empty-card";
    const inner = document.createElement("div");
    inner.className = "empty-card__inner";
    const iconNode = document.createElement("div");
    iconNode.className = "empty-icon";
    iconNode.setAttribute("aria-hidden", "true");
    iconNode.textContent = icon;
    const heading = document.createElement("h3");
    heading.textContent = `${title}はまだ登録されていません`;
    const copy = document.createElement("p");
    copy.textContent = message;
    inner.append(iconNode, heading, copy);
    visual.append(inner);
    const footer = document.createElement("div");
    footer.className = "empty-card__footer";
    const titleRow = document.createElement("div");
    titleRow.className = "title-row";
    const label = document.createElement("h3");
    label.className = "document-title";
    label.textContent = title;
    titleRow.append(label);
    if (fixed) {
        const badge = document.createElement("span");
        badge.className = "badge badge--fixed";
        badge.textContent = "固定枠";
        titleRow.append(badge);
    }
    const meta = document.createElement("p");
    meta.className = "document-card__meta";
    meta.textContent = "未登録";
    footer.append(titleRow, meta);
    card.append(visual, footer);
    if (fixed && cardId && (!organizerMode || canEdit)) {
        const management = document.createElement("div");
        management.className = "card-management";
        const register = document.createElement("button");
        register.type = "button";
        register.className = "card-manage";
        register.textContent = `${title}を登録`;
        register.addEventListener("click", () => openVersionDialog(cardId, title));
        management.append(register);
        card.append(management);
    }
    return card;
};

const grouped = (documents) => [...documents.reduce((map, item) => { const key = groupKey(item); map.set(key, [...(map.get(key) || []), item]); return map; }, new Map()).values()].map((items) => items.sort((a, b) => Number(b.is_current) - Number(a.is_current) || String(b.source_created_at || b.created_at || "").localeCompare(String(a.source_created_at || a.created_at || ""))));
const renderVersioned = (target, documents, options) => {
    target.replaceChildren();
    if (!documents.length) { target.append(emptyCard(options.empty)); return; }
    const groups = grouped(documents);
    if (!options.multiple) {
        const versions = groups.flat().sort((a, b) => Number(b.is_current) - Number(a.is_current) || String(b.source_created_at || b.created_at || "").localeCompare(String(a.source_created_at || a.created_at || "")));
        target.append(makeDocumentCard(versions[0], versions.slice(1), options));
        return;
    }
    groups.forEach((versions) => target.append(makeDocumentCard(versions[0], versions.slice(1), options)));
};
const renderPhotos = (documents) => {
    const target = $("#photo-content");
    target.replaceChildren();
    if (!documents.length) {
        const state = document.createElement("div");
        state.className = "photo-empty";
        const inner = document.createElement("div");
        inner.className = "empty-card__inner";
        inner.innerHTML = '<div class="empty-icon" aria-hidden="true">📷</div><h3>会場・ステージ写真はまだ登録されていません</h3><p>現調写真や会場写真が登録されると、ここにギャラリー表示されます。</p>';
        state.append(inner);
        target.append(state);
        return;
    }
    documents.sort((a, b) => String(b.occurred_at || "").localeCompare(String(a.occurred_at || ""))).forEach((item) => {
        const tile = document.createElement("button");
        tile.type = "button";
        tile.className = "photo-tile";
        tile.setAttribute("aria-label", `${item.filename}を拡大表示`);
        const label = document.createElement("span");
        label.textContent = item.filename;
        getBlobUrl(item).then((url) => { const image = document.createElement("img"); image.src = url; image.alt = item.filename; tile.prepend(image); }).catch(() => { label.textContent = `${item.filename}（表示不可）`; });
        tile.append(label);
        tile.addEventListener("click", () => showPreview(item));
        const wrap = document.createElement("div");
        wrap.className = "photo-tile";
        wrap.dataset.ownerEditable = String(!organizerMode || item.can_edit);
        tile.className = "photo-tile photo-tile__preview";
        wrap.append(tile);
        const archive = document.createElement("button");
        archive.type = "button";
        archive.className = "photo-archive";
        archive.textContent = "archive";
        archive.addEventListener("click", (event) => { event.stopPropagation(); runMutation("archive_photo", organizerMode ? { photo_ref: item.asset_id } : { photo_id: item.asset_id }, "写真をarchiveしました"); });
        if (!organizerMode || item.can_edit) {
            wrap.append(archive);
            if (organizerMode) {
                const caption = document.createElement("button"); caption.type = "button"; caption.className = "photo-caption-edit"; caption.textContent = "説明編集";
                caption.addEventListener("click", (event) => { event.stopPropagation(); const value = prompt("写真の説明", item.caption || ""); if (value !== null) runMutation("update_photo_caption", { photo_ref: item.asset_id, caption: value }, "写真の説明を更新しました"); });
                wrap.append(caption);
            }
        }
        target.append(wrap);
    });
};
const samplePerformer = (index, name, description) => {
    const card = document.createElement("article");
    card.className = "performer-item performer-item--sample";
    const order = document.createElement("span");
    order.className = "performer-order";
    order.textContent = index;
    const thumb = document.createElement("div");
    thumb.className = "performer-thumb";
    thumb.innerHTML = '<div class="performer-stage"><span class="stage-box stage-box--left">Vo</span><span class="stage-box stage-box--right">Key</span><span class="stage-box stage-box--center">Dr</span></div>';
    const info = document.createElement("div");
    info.className = "performer-info";
    const heading = document.createElement("h3");
    heading.textContent = name;
    const copy = document.createElement("p");
    copy.textContent = description;
    info.append(heading, copy);
    card.append(order, thumb, info);
    return card;
};
const renderPerformers = (documents) => {
    const target = $("#performer-content");
    target.replaceChildren();
    if (documents.length) {
        $("#performer-note").textContent = "登録済みの出演者資料を出演順に表示しています。";
        documents.sort((a, b) => String(a.occurred_at || "").localeCompare(String(b.occurred_at || ""))).forEach((item, index) => {
            const card = document.createElement("button");
            card.type = "button";
            card.className = "performer-item";
            const order = document.createElement("span");
            order.className = "performer-order";
            order.textContent = index + 1;
            const thumb = document.createElement("div");
            thumb.className = "performer-thumb";
            thumb.append(makeHistoryThumbnail(item));
            const info = document.createElement("div");
            info.className = "performer-info";
            const heading = document.createElement("h3");
            heading.textContent = item.filename;
            const copy = document.createElement("p");
            copy.textContent = `${sourceLabel(item)} ／ クリックで資料を確認`;
            info.append(heading, copy);
            card.append(order, thumb, info);
            card.addEventListener("click", () => showPreview(item));
            target.append(card);
        });
        return;
    }
    target.append(
        samplePerformer(1, "○○BAND", "ステージプロット / AC100V ×1 / 音源なし"),
        samplePerformer(2, "△△ Dance Team", "再生音源あり / 16名 / 電源不要"),
        samplePerformer(3, "□□神楽団", "マイク希望あり / 12名 / 電源要確認")
    );
};
const portalRequest = async (action, extra = {}) => {
    const endpoint = organizerMode ? "/api/event-portal" : "/api/pa-portal";
    const response = await fetch(endpoint, { method: "POST", headers: { ...(organizerMode ? {} : { Authorization: `Bearer ${accessToken}` }), "Content-Type": "application/json" }, body: JSON.stringify({ action, ...(organizerMode ? {} : { inquiry_id: caseId }), ...extra }), cache: "no-store", credentials: "same-origin" });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(payload?.code || "portal_request_failed");
    return payload.result;
};
const asDocument = (version, card) => ({ ...version, asset_id: version.id || version.ref, asset_kind: "version", card_id: card.id || card.ref, logical_key: card.id || card.ref, logical_title: card.title, filename: version.display_filename, mime_type: version.mime_type, is_current: (version.id || version.ref) === (card.current_version_id || card.current_version_ref), can_edit: card.can_edit !== false });
const asPhoto = (photo) => ({ ...photo, asset_id: photo.id || photo.ref, asset_kind: "photo", filename: photo.display_filename, occurred_at: photo.source_created_at || photo.created_at, can_edit: photo.can_edit !== false });
const asCandidate = (candidate) => ({ ...candidate, asset_id: candidate.id, asset_kind: "candidate", filename: candidate.display_filename, occurred_at: candidate.source_created_at || candidate.detected_at });
const candidateActionLabel = (value) => ({ add_new_version: "既存カードへ新版追加", create_new_card: "新しい資料カードを作成", add_photo: "写真ギャラリーへ追加", hold_performer: "出演者連携まで候補保持" }[value] || "登録先を確認");
const candidateConfidenceLabel = (value) => ({ high: "高", medium: "中", low: "低" }[value] || "低");
const showToast = (message) => { const toast = $("#portal-toast"); toast.textContent = message; toast.classList.add("is-visible"); setTimeout(() => toast.classList.remove("is-visible"), 2400); };
const refreshPortal = async () => { portalModel = await portalRequest("read"); renderPortalDocuments(); };
const renderCandidateInbox = () => {
    if (organizerMode || !$("#candidate-content")) return;
    const target = $("#candidate-content");
    const candidates = (candidateInbox?.candidates || []).map(asCandidate);
    $("#candidate-count").textContent = String(candidateInbox?.pending_count || candidates.length);
    target.replaceChildren();
    if (!candidates.length) {
        const empty = document.createElement("div"); empty.className = "candidate-empty"; empty.textContent = "未処理の新着資料候補はありません。メール同期または過去メール確認後に候補が表示されます。"; target.append(empty); return;
    }
    candidates.forEach((item) => {
        const card = document.createElement("article"); card.className = "candidate-card";
        const preview = makePreview(item, { collection: true }); preview.classList.add("candidate-card__preview");
        const body = document.createElement("div"); body.className = "candidate-card__body";
        const heading = document.createElement("h3"); heading.textContent = item.filename;
        const source = document.createElement("p"); source.className = "candidate-meta"; source.textContent = `${item.source_direction === "inbound" ? "受信" : "送信"}メール ／ ${documentTime(item)} ／ ${text(item.source_sender, "送信元不明")}`;
        const subject = document.createElement("p"); subject.className = "candidate-meta"; subject.textContent = `件名：${text(item.source_subject, "件名なし")}`;
        const proposal = document.createElement("div"); proposal.className = "candidate-proposal";
        const proposalTitle = document.createElement("strong");
        const cardTitle = (candidateInbox.cards || []).find((candidateCard) => candidateCard.id === item.suggested_card_id)?.title;
        proposalTitle.textContent = `分類候補：${candidateCategoryLabel(item.suggested_category)}（確信度 ${candidateConfidenceLabel(item.confidence)}）`;
        const destination = document.createElement("p"); destination.textContent = `${candidateActionLabel(item.suggested_action)}${cardTitle ? `「${cardTitle}」` : item.suggested_title ? `「${item.suggested_title}」` : ""}`;
        const basis = document.createElement("p"); basis.textContent = item.suggestion_basis;
        proposal.append(proposalTitle, destination, basis);
        const actions = document.createElement("div"); actions.className = "candidate-actions";
        const accept = document.createElement("button"); accept.type = "button"; accept.className = "candidate-accept"; accept.textContent = "提案どおり登録";
        if (item.suggested_action === "hold_performer") { accept.disabled = true; accept.title = "出演者資料の自動登録は今回の対象外です"; }
        else accept.addEventListener("click", () => openCandidateReview(item, false));
        const change = document.createElement("button"); change.type = "button"; change.textContent = "登録先を変更"; change.addEventListener("click", () => openCandidateReview(item, true));
        const ignore = document.createElement("button"); ignore.type = "button"; ignore.className = "candidate-ignore"; ignore.textContent = "無視"; ignore.addEventListener("click", async () => {
            try { await portalRequest("candidate_ignore", { candidate_id: item.id, payload: {}, idempotency_key: crypto.randomUUID() }); await refreshCandidateInbox(); showToast("候補を無視しました"); }
            catch (error) { showToast(`候補を更新できませんでした（${error.message}）`); }
        });
        actions.append(accept, change, ignore); body.append(heading, source, subject, proposal, actions); card.append(preview, body); target.append(card);
    });
};
const refreshCandidateInbox = async () => { candidateInbox = await portalRequest("candidate_list"); renderCandidateInbox(); };
const runMutation = async (action, payload, success) => {
    try { await portalRequest(action, { payload, idempotency_key: crypto.randomUUID() }); await refreshPortal(); showToast(success); }
    catch (error) { showToast(`保存できませんでした（${error.message}）`); }
};
const filePayload = async (file) => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
    return { filename: file.name, mime_type: file.type, data_base64: btoa(binary) };
};
const field = (label, control) => { const wrap = document.createElement("label"); wrap.className = "manage-field"; const name = document.createElement("span"); name.textContent = label; wrap.append(name, control); return wrap; };
const input = (name, options = {}) => { const node = document.createElement(options.multiline ? "textarea" : "input"); node.name = name; if (options.type) node.type = options.type; if (options.required) node.required = true; if (options.multiple) node.multiple = true; if (options.accept) node.accept = options.accept; node.value = options.value || ""; return node; };
const select = (name, values) => { const node = document.createElement("select"); node.name = name; values.forEach(([value, label]) => { const option = document.createElement("option"); option.value = value; option.textContent = label; node.append(option); }); return node; };
const closeManage = () => { manageSubmit = null; $("#manage-submit").hidden = false; $("#manage-submit").textContent = "保存"; if ($("#manage-dialog").open) $("#manage-dialog").close(); };
const openManage = (title, content, submit) => { $("#manage-dialog-title").textContent = title; $("#manage-dialog-body").replaceChildren(...content); manageSubmit = submit; $("#manage-dialog").showModal(); };
const openCandidateReview = (candidate, changingTarget) => {
    const initialCategory = candidate.suggested_action === "hold_performer" ? "other" : candidate.suggested_category;
    const initialAction = candidate.suggested_action === "hold_performer" ? "create_new_card" : candidate.suggested_action;
    const category = select("category", [["timetable", "タイムテーブル"], ["script", "台本"], ["layout", "会場図・配置図"], ["photo", "会場・ステージ写真"], ["other", "その他"]]); category.value = initialCategory;
    const action = select("target_action", [["add_new_version", "既存カードへ版を追加"], ["create_new_card", "新しい資料カードを作成"], ["add_photo", "写真ギャラリーへ追加"]]); action.value = initialAction;
    const cards = (candidateInbox.cards || []).filter((card) => card.category !== "performer");
    const card = select("card_id", [["", "登録先を選択"], ...cards.map((item) => [item.id, `${candidateCategoryLabel(item.category)}：${item.title}`])]); card.value = candidate.suggested_card_id || "";
    const title = input("title", { value: candidate.suggested_title || candidate.filename, required: true });
    const owner = select("owner_kind", [["shared", "共同"], ["ara_tech", "ARA-TECH"], ["organizer", "主催者"], ["performer", "出演者"]]);
    const version = input("version_label"); const note = input("note", { multiline: true });
    const makeCurrent = input("make_current", { type: "checkbox" }); makeCurrent.value = "true";
    const currentChoice = document.createElement("label"); currentChoice.className = "current-choice"; const currentText = document.createElement("span"); currentText.textContent = "この資料を最新版として登録する（未選択なら履歴版として追加し、現在版は変更しません。新規カード作成時は選択が必要です）"; currentChoice.append(makeCurrent, currentText);
    const syncTargetFields = () => {
        if (category.value === "photo") action.value = "add_photo";
        if (["timetable", "script"].includes(category.value)) action.value = "add_new_version";
        [...card.options].slice(1).forEach((option) => { const sameCategory = cards.find((item) => item.id === option.value)?.category === category.value; option.hidden = !sameCategory; option.disabled = !sameCategory; });
        if (card.value && cards.find((item) => item.id === card.value)?.category !== category.value) card.value = "";
        if (action.value === "add_new_version" && !card.value) card.value = cards.find((item) => item.category === category.value)?.id || "";
        card.disabled = action.value !== "add_new_version";
        card.required = action.value === "add_new_version";
        title.disabled = action.value !== "create_new_card";
        title.required = action.value === "create_new_card";
        owner.disabled = action.value !== "create_new_card";
        makeCurrent.disabled = action.value === "add_photo";
        if (action.value === "add_photo") makeCurrent.checked = false;
    };
    category.addEventListener("change", syncTargetFields); action.addEventListener("change", syncTargetFields); syncTargetFields();
    const hint = document.createElement("p"); hint.className = "manage-hint"; hint.textContent = "メール添付の正本を参照したまま登録します。添付ファイルの複製や自動最新版化は行いません。";
    openManage(changingTarget ? "新着資料候補：登録先を変更" : "新着資料候補：提案を確認", [hint, field("分類", category), field("登録方法", action), field("既存カード", card), field("新規カードタイトル", title), field("所有区分", owner), field("版ラベル", version), field("メモ", note), currentChoice], async (form) => {
        await portalRequest("candidate_accept", { candidate_id: candidate.id, payload: { action: form.elements.target_action.value, category: form.elements.category.value, card_id: form.elements.card_id.value || null, title: form.elements.title.value, owner_kind: form.elements.owner_kind.value, version_label: form.elements.version_label.value, note: form.elements.note.value, make_current: form.elements.make_current.checked }, idempotency_key: crypto.randomUUID() });
        closeManage(); await Promise.all([refreshPortal(), refreshCandidateInbox()]); showToast("候補をポータル資料へ登録しました");
    });
    $("#manage-submit").textContent = "承認して登録";
};
const sourceFields = ({ photos = false } = {}) => {
    if (organizerMode) {
        const files = input("files", { type: "file", required: true, multiple: photos, accept: photos ? "image/jpeg,image/png,image/webp" : "application/pdf,image/jpeg,image/png,image/webp" });
        return { controls: [field(photos ? "画像（複数選択可）" : "ファイル", files)], mode: { value: "upload" }, files, existing: null, available: [] };
    }
    const available = photos ? sourceCandidates.filter((candidate) => /^image\//u.test(candidate.mime_type)) : sourceCandidates;
    const mode = select("source_mode", [["upload", "PCからアップロード"], ["existing", "既存PA案件／メール添付から選択"]]);
    const files = input("files", { type: "file", required: true, multiple: photos, accept: photos ? "image/jpeg,image/png,image/webp" : "application/pdf,image/jpeg,image/png,image/webp" });
    const existing = select("candidate", [["", "選択してください"], ...available.map((candidate, index) => [String(index), `${candidate.display_filename}（${sourceTypeLabel(candidate)}）`])]);
    existing.disabled = true;
    mode.addEventListener("change", () => { const uploadMode = mode.value === "upload"; files.disabled = !uploadMode; files.required = uploadMode; existing.disabled = uploadMode; existing.required = !uploadMode; });
    return { controls: [field("登録方法", mode), field(photos ? "画像（複数選択可）" : "ファイル", files), field("既存資料", existing)], mode, files, existing, available };
};
const commonVersionPayload = async (form, source, extra = {}) => {
    const contributor = organizerMode ? "organizer" : form.elements.contributor_kind.value;
    const base = { ...extra, ...(organizerMode ? {} : { contributor_kind: contributor }), version_label: form.elements.version_label?.value || "", note: form.elements.note?.value || "" };
    if (source.mode.value === "existing") return { ...base, source: source.available[Number(source.existing.value)] };
    return { ...base, upload: await filePayload(source.files.files[0]) };
};
const openVersionDialog = (cardId, title, newCard = null) => {
    const source = sourceFields(); const version = input("version_label", { value: "" }); const note = input("note", { multiline: true });
    const contributor = select("contributor_kind", [["ara_tech", "ARA-TECH"], ["organizer", "主催者"], ["shared", "共同"], ["performer", "出演者"]]);
    const controls = [...source.controls, field("版ラベル", version), ...(organizerMode ? [] : [field("提供者", contributor)]), field("メモ", note)];
    openManage(`${title}：${cardId ? "新版を追加" : "資料カードを追加"}`, controls, async (form) => {
        const payload = await commonVersionPayload(form, source, cardId ? { [organizerMode ? "card_ref" : "card_id"]: cardId } : { new_card: newCard });
        await portalRequest("add_version", { payload, idempotency_key: crypto.randomUUID() }); closeManage(); await refreshPortal(); showToast(cardId ? "新版を登録しました" : "資料カードを作成しました");
    });
};
const openNewCardDialog = (category) => {
    const title = input("title", { required: true }); const owner = select("owner_kind", organizerMode ? [["organizer", "主催者"], ["shared", "共同"]] : [["shared", "共同"], ["ara_tech", "ARA-TECH"], ["organizer", "主催者"], ["performer", "出演者"]]);
    const source = sourceFields(); const version = input("version_label"); const note = input("note", { multiline: true });
    const contributor = select("contributor_kind", [["ara_tech", "ARA-TECH"], ["organizer", "主催者"], ["shared", "共同"], ["performer", "出演者"]]);
    openManage(category === "layout" ? "資料カードを追加" : "共通資料を追加", [field("カードタイトル", title), field("所有区分", owner), ...source.controls, field("版ラベル", version), ...(organizerMode ? [] : [field("提供者", contributor)]), field("メモ", note)], async (form) => {
        const newCard = { category, title: form.elements.title.value, owner_kind: form.elements.owner_kind.value, sort_order: category === "layout" ? 30 : 50 };
        const payload = await commonVersionPayload(form, source, { new_card: newCard });
        await portalRequest("add_version", { payload, idempotency_key: crypto.randomUUID() }); closeManage(); await refreshPortal(); showToast("資料カードを作成しました");
    });
};
const openPhotoDialog = () => {
    const source = sourceFields({ photos: true }); const contributor = select("contributor_kind", [["ara_tech", "ARA-TECH"], ["organizer", "主催者"], ["shared", "共同"]]); const caption = input("caption");
    openManage("写真を追加", [...source.controls, ...(organizerMode ? [] : [field("提供者", contributor)]), field("キャプション", caption)], async (form) => {
        const basics = { ...(organizerMode ? {} : { contributor_kind: form.elements.contributor_kind.value }), caption: form.elements.caption.value };
        if (source.mode.value === "existing") await portalRequest("add_photo", { payload: { ...basics, source: source.available[Number(source.existing.value)] }, idempotency_key: crypto.randomUUID() });
        else for (const file of source.files.files) await portalRequest("add_photo", { payload: { ...basics, upload: await filePayload(file) }, idempotency_key: crypto.randomUUID() });
        closeManage(); await refreshPortal(); showToast("写真を追加しました");
    });
};
const renderPortalDocuments = () => {
    const cards = Array.isArray(portalModel?.cards) ? portalModel.cards : [];
    const versions = (category) => cards.filter((card) => card.category === category).flatMap((card) => (card.versions || []).map((version) => asDocument(version, card)));
    const fixed = (category) => cards.find((card) => card.category === category && card.card_kind === "fixed");
    renderVersioned($("#timetable-content"), versions("timetable"), { fixed: true, multiple: false, empty: { title: "タイムテーブル", message: "進行表が登録されると、ここに最新版が表示されます。", icon: "🗓️", fixed: true, cardId: fixed("timetable")?.id || fixed("timetable")?.ref, canEdit: fixed("timetable")?.can_edit !== false } });
    renderVersioned($("#script-content"), versions("script"), { fixed: true, multiple: false, empty: { title: "台本", message: "進行台本が登録されると、ここに最新版が表示されます。", icon: "📘", fixed: true, cardId: fixed("script")?.id || fixed("script")?.ref, canEdit: fixed("script")?.can_edit !== false } });
    renderVersioned($("#layout-content"), versions("layout"), { collection: true, multiple: true, empty: { title: "会場図・配置図", message: "資料カードが追加されると、ここにプレビューと履歴が表示されます。", icon: "📐", collection: true } });
    renderPhotos((portalModel?.photos || []).map(asPhoto));
    renderPerformers(versions("performer"));
    renderVersioned($("#other-content"), versions("other"), { collection: true, multiple: true, empty: { title: "その他の共通資料", message: "運営資料や注意事項などが登録されると、ここに表示されます。", icon: "📄", collection: true } });
};
const populate = async (item, progress) => {
    $("#portal-event-name").textContent = text(item.event_name, "イベント資料ポータル");
    $("#portal-date").textContent = dateText(progress?.confirmed_event_date || item.event_date);
    $("#portal-time").textContent = timeText(item.event_time);
    $("#portal-venue").textContent = text(item.venue);
    portalModel = await portalRequest("read");
    if (!portalModel) throw new Error("portal_not_initialized");
    renderPortalDocuments();
};
const populateOrganizer = async () => {
    portalModel = await portalRequest("read");
    if (!portalModel) throw new Error("link_unavailable");
    const item = portalModel.event || {};
    $("#portal-event-name").textContent = text(item.event_name, "イベント資料ポータル");
    $("#portal-date").textContent = dateText(item.event_date);
    $("#portal-time").textContent = timeText(item.event_time);
    $("#portal-venue").textContent = text(item.venue);
    renderPortalDocuments();
};
const start = async () => {
    if (organizerMode) {
        try {
            const token = location.hash.slice(1);
            if (token) { history.replaceState(null, "", "/event-portal"); await portalRequest("exchange", { token }); }
            await loadBrowserDependencies(false);
            await populateOrganizer(); $("#portal-loading").hidden = true; $("#portal").hidden = false;
        } catch { revealError("この共有リンクは現在利用できません。イベント主催者またはARA-TECHへご確認ください。"); }
        return;
    }
    if (!isSupabaseConfigured) { revealError("管理画面の接続設定がありません。"); return; }
    caseId = portalCaseId();
    if (!/^[0-9a-f-]{36}$/iu.test(caseId)) { revealError("ポータルURLが正しくありません。"); return; }
    await loadBrowserDependencies(true);
    supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) { $("#portal-loading").hidden = true; $("#portal-login").hidden = false; return; }
    accessToken = session.access_token;
    const [{ data: item, error }, { data: progress }] = await Promise.all([supabase.from("pa_inquiries").select("*").eq("id", caseId).is("deleted_at", null).maybeSingle(), supabase.from("pa_case_progress").select("confirmed_event_date").eq("inquiry_id", caseId).maybeSingle()]);
    if (error || !item) { revealError("イベント情報を読み込めませんでした。"); return; }
    try { await populate(item, progress); $("#portal-loading").hidden = true; $("#portal").hidden = false; }
    catch (error) { console.error("portal_documents_failed", String(error?.message || "unknown")); revealError("資料一覧を読み込めませんでした。時間をおいて再度お試しください。"); }
};

$("#preview-close").addEventListener("click", closePreview);
$("#preview-dialog").addEventListener("click", (event) => { if (event.target === $("#preview-dialog")) closePreview(); });
$("#preview-dialog").addEventListener("cancel", () => { previewRequest += 1; });
$("#edit-mode-toggle").addEventListener("click", async () => {
    const button = $("#edit-mode-toggle");
    if (!editMode && !organizerMode) {
        try { [sourceCandidates, candidateInbox] = await Promise.all([portalRequest("candidates"), portalRequest("candidate_list")]); renderCandidateInbox(); }
        catch { showToast("資料候補を読み込めませんでした"); return; }
    }
    editMode = !editMode;
    document.body.classList.toggle("portal-editing", editMode);
    button.setAttribute("aria-pressed", String(editMode));
    button.textContent = editMode ? "編集を終了" : "資料を編集";
});
const openShareDialog = async () => {
    const status = await portalRequest("link_status");
    const box = document.createElement("div"); box.className = "share-status";
    const state = document.createElement("strong"); state.textContent = status.active ? "主催者リンク：有効" : status.exists ? "主催者リンク：期限切れ" : "主催者リンク：未発行／無効"; box.append(state);
    const hint = document.createElement("p"); hint.className = "manage-hint"; hint.textContent = status.exists ? `有効期限：${status.expires_at ? documentTime({ created_at: status.expires_at }) : "無期限"}。URLは安全上、発行時だけ表示されます。` : "リンク発行だけではメール送信されません。"; box.append(hint);
    if (issuedShareUrl) { const url = document.createElement("code"); url.className = "share-url"; url.textContent = issuedShareUrl; box.append(url); }
    const expiry = input("expires_at", { type: "datetime-local" });
    const actions = document.createElement("div"); actions.className = "share-actions";
    const act = (label, action) => { const button = document.createElement("button"); button.type = "button"; button.className = "button"; button.textContent = label; button.addEventListener("click", async () => { const result = await portalRequest(action, { expires_at: expiry.value ? new Date(expiry.value).toISOString() : null }); if (result.share_url) issuedShareUrl = new URL(result.share_url, location.origin).href; closeManage(); await openShareDialog(); }); return button; };
    if (!status.exists) actions.append(act("主催者リンクを発行", "link_create"));
    else { actions.append(act("リンクを再発行", "link_rotate"), act("リンクを失効", "link_revoke")); }
    if (issuedShareUrl) { const copy = document.createElement("button"); copy.type = "button"; copy.className = "button"; copy.textContent = "URLをコピー"; copy.addEventListener("click", async () => { await navigator.clipboard.writeText(issuedShareUrl); showToast("主催者URLをコピーしました"); }); actions.append(copy); }
    openManage("主催者共有リンク", [box, field("有効期限（任意）", expiry), actions], null); $("#manage-submit").hidden = true;
};
$("#share-link-manage").addEventListener("click", () => openShareDialog().catch(() => showToast("共有リンク情報を読み込めませんでした")));
$("#manage-close").addEventListener("click", closeManage);
$("#manage-dialog").addEventListener("cancel", closeManage);
$("#manage-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!manageSubmit) return;
    const submit = $("#manage-submit");
    submit.disabled = true;
    try { await manageSubmit(event.currentTarget); }
    catch (error) { showToast(`保存できませんでした（${error.message}）`); }
    finally { submit.disabled = false; }
});
document.querySelectorAll('[data-manage="create-card"]').forEach((button) => button.addEventListener("click", () => openNewCardDialog(button.dataset.category)));
document.querySelector('[data-manage="add-photo"]').addEventListener("click", openPhotoDialog);
$("#candidate-backfill")?.addEventListener("click", async () => {
    const button = $("#candidate-backfill"); button.disabled = true;
    try { await portalRequest("candidate_backfill", { idempotency_key: crypto.randomUUID() }); await refreshCandidateInbox(); showToast("過去メールの資料候補を確認しました"); }
    catch (error) { showToast(`過去メールを確認できませんでした（${error.message}）`); }
    finally { button.disabled = false; }
});
start();
