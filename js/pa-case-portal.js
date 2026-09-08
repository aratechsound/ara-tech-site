import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import * as pdfjsLib from "https://cdn.jsdelivr.net/npm/pdfjs-dist@6.3.289/build/pdf.min.mjs";
import { SUPABASE_ANON_KEY, SUPABASE_URL, isSupabaseConfigured } from "./supabase-config.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdn.jsdelivr.net/npm/pdfjs-dist@6.3.289/build/pdf.worker.min.mjs";

const $ = (selector) => document.querySelector(selector);
const attachmentRecords = new Map();
const pdfDocuments = new Map();
let supabase;
let accessToken = "";
let caseId = "";
let previewRequest = 0;

const text = (value, fallback = "未設定") => String(value || "").trim() || fallback;
const dateText = (value) => value ? new Intl.DateTimeFormat("ja-JP", { year: "numeric", month: "long", day: "numeric" }).format(new Date(`${value}T00:00:00`)) : "未設定";
const timeText = (value) => text(value);
const documentTime = (item) => item.occurred_at ? new Intl.DateTimeFormat("ja-JP", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(item.occurred_at)) : "日時未登録";
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
const groupKey = (item) => String(item.filename || "資料")
    .replace(/\.[A-Za-z0-9]{1,8}$/u, "")
    .replace(/[＿_\s-]*(最新版|最終|final|ver(?:sion)?|v)?[＿_\s-]*\d+(?:\.\d+)?$/iu, "")
    .trim() || "資料";
const sourceLabel = (item) => item.direction === "inbound" ? "主催者・関係者提出" : "ARA-TECH共有";
const attachmentKey = (item) => `${item.message_id}:${item.attachment_id}`;

const portalCaseId = () => {
    const match = decodeURIComponent(location.pathname).match(/^\/pa\/cases\/([0-9a-f-]{36})\/portal\/?$/iu);
    return match?.[1] || new URLSearchParams(location.search).get("case") || "";
};
const revealError = (message) => { $("#portal-loading").hidden = true; $("#portal-error").hidden = false; $("#portal-error").textContent = message; };

const getAttachmentRecord = async (item) => {
    const key = attachmentKey(item);
    if (attachmentRecords.has(key)) return attachmentRecords.get(key);
    const response = await fetch("/api/pa-gmail", { method: "POST", headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ action: "attachment_download", inquiry_id: caseId, gmail_message_id: item.message_id, gmail_attachment_id: item.attachment_id }), cache: "no-store" });
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
        label.textContent = groupKey(item);
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
        timestamp.textContent = documentTime(item);
        meta.append(name, timestamp);
        const open = document.createElement("button");
        open.type = "button";
        open.className = "history-open";
        open.textContent = "開く";
        open.addEventListener("click", () => showPreview(item));
        entry.append(makeHistoryThumbnail(item), meta, open);
        list.append(entry);
    });
    details.append(summary, list);
    return details;
};
const makeDocumentCard = (latest, history = [], { fixed = false, collection = false } = {}) => {
    const card = document.createElement("article");
    card.className = `document-card${collection ? " collection-card" : ""}`;
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
    return card;
};
const emptyCard = ({ title, message, icon, fixed = false, collection = false }) => {
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
    return card;
};

const grouped = (documents) => [...documents.reduce((map, item) => { const key = groupKey(item); map.set(key, [...(map.get(key) || []), item]); return map; }, new Map()).values()].map((items) => items.sort((a, b) => String(b.occurred_at || "").localeCompare(String(a.occurred_at || ""))));
const renderVersioned = (target, documents, options) => {
    target.replaceChildren();
    if (!documents.length) { target.append(emptyCard(options.empty)); return; }
    const groups = grouped(documents);
    if (!options.multiple) {
        const versions = groups.flat().sort((a, b) => String(b.occurred_at || "").localeCompare(String(a.occurred_at || "")));
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
        target.append(tile);
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
const readDocuments = async () => {
    const response = await fetch("/api/pa-gmail", { method: "POST", headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ action: "portal_documents", inquiry_id: caseId }), cache: "no-store" });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !Array.isArray(payload?.result)) throw new Error("portal_documents_unavailable");
    return payload.result.flatMap((message) => (Array.isArray(message.attachment_metadata) ? message.attachment_metadata : []).filter((attachment) => attachment?.id && attachment?.filename).map((attachment) => ({ message_id: message.gmail_message_id, attachment_id: String(attachment.id), filename: String(attachment.filename), mime_type: String(attachment.mime_type || ""), subject: String(message.subject || ""), direction: message.direction, occurred_at: message.received_at || message.sent_at || "" })).filter((attachment) => !isCommercialDocument(attachment)));
};
const populate = async (item, progress) => {
    $("#portal-event-name").textContent = text(item.event_name, "イベント資料ポータル");
    $("#portal-date").textContent = dateText(progress?.confirmed_event_date || item.event_date);
    $("#portal-time").textContent = timeText(item.event_time);
    $("#portal-venue").textContent = text(item.venue);
    const documents = await readDocuments();
    const byCategory = documents.reduce((map, document) => { const category = categoryFor(document); (map[category] ||= []).push(document); return map; }, {});
    renderVersioned($("#timetable-content"), byCategory.timetable || [], { fixed: true, multiple: false, empty: { title: "タイムテーブル", message: "進行表が登録されると、ここに最新版が表示されます。", icon: "🗓️", fixed: true } });
    renderVersioned($("#script-content"), byCategory.script || [], { fixed: true, multiple: false, empty: { title: "台本", message: "進行台本が登録されると、ここに最新版が表示されます。", icon: "📘", fixed: true } });
    renderVersioned($("#layout-content"), byCategory.layout || [], { collection: true, multiple: true, empty: { title: "会場図・配置図", message: "資料カードが追加されると、ここにプレビューと履歴が表示されます。", icon: "📐", collection: true } });
    renderPhotos(byCategory.photo || []);
    renderPerformers(byCategory.performer || []);
    renderVersioned($("#other-content"), byCategory.other || [], { collection: true, multiple: true, empty: { title: "その他の共通資料", message: "運営資料や注意事項などが登録されると、ここに表示されます。", icon: "📄", collection: true } });
};
const start = async () => {
    if (!isSupabaseConfigured) { revealError("管理画面の接続設定がありません。"); return; }
    caseId = portalCaseId();
    if (!/^[0-9a-f-]{36}$/iu.test(caseId)) { revealError("ポータルURLが正しくありません。"); return; }
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
start();
