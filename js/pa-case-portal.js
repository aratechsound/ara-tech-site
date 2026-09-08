import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { SUPABASE_ANON_KEY, SUPABASE_URL, isSupabaseConfigured } from "./supabase-config.js";

const $ = (selector) => document.querySelector(selector);
const statusLabels = Object.freeze({ new: "新規問い合わせ", new_inquiry: "新規問い合わせ", follow_up_pending: "担当者フォロー待ち", waiting_customer_reply: "お客様回答待ち", hearing: "ヒアリング中", rough_estimate: "概算見積中", customer_intent_confirmed: "依頼意思確認済み", schedule_coordination: "日程・人員調整中", reviewing: "内容確認中", second_form_not_issued: "日程確保フォーム未発行", second_form_issued: "日程確保フォーム発行済み", customer_responded: "お客様回答済み", schedule_unconfirmed: "日程確保未確定", schedule_adjusting: "日程調整中", needs_confirmation: "確認事項あり", schedule_confirmed: "日程確保完了", schedule_unavailable: "日程確保不可", on_hold: "保留", cancelled: "取消", closed: "対応終了" });
const blobs = new Map();
let supabase;
let accessToken = "";
let caseId = "";

const text = (value, fallback = "未設定") => String(value || "").trim() || fallback;
const dateText = (value) => value ? new Intl.DateTimeFormat("ja-JP", { year: "numeric", month: "long", day: "numeric" }).format(new Date(`${value}T00:00:00`)) : "未設定";
const timeText = (value) => text(value);
const documentTime = (document) => document.occurred_at ? new Intl.DateTimeFormat("ja-JP", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(document.occurred_at)) : "日時未登録";
const isImage = (document) => /^image\//iu.test(document.mime_type || "");
const isPdf = (document) => String(document.mime_type || "").toLowerCase() === "application/pdf" || /\.pdf$/iu.test(document.filename || "");
const canPreview = (document) => isImage(document) || isPdf(document);
const isCommercialDocument = (document) => /(見積|estimate|契約|contract|請求|invoice|領収|receipt)/iu.test(`${document.filename} ${document.subject}`);
const categoryFor = (document) => {
    const source = `${document.filename} ${document.subject}`.toLowerCase();
    if (/(タイムテーブル|time\s*table|timetable|進行表|香盤)/iu.test(source)) return "timetable";
    if (/(台本|script|進行台本)/iu.test(source)) return "script";
    if (/(出演者|出演順|performer|artist|アーティスト)/iu.test(source)) return "performer";
    if (isImage(document) || /(写真|photo|stage.*(jpg|jpeg|png)|会場.*(jpg|jpeg|png))/iu.test(source)) return "photo";
    if (/(会場図|配置図|平面図|電源|搬入|導線|layout|stage\s*plot|ステージ図|音響)/iu.test(source)) return "layout";
    return "other";
};
const groupKey = (document) => String(document.filename || "資料")
    .replace(/\.[A-Za-z0-9]{1,8}$/u, "")
    .replace(/[＿_\s-]*(最新版|最終|final|ver(?:sion)?|v)?[＿_\s-]*\d+(?:\.\d+)?$/iu, "")
    .trim() || "資料";
const sourceLabel = (document) => document.direction === "inbound" ? "主催者・関係者提出" : "ARA-TECH共有";
const attachmentKey = (document) => `${document.message_id}:${document.attachment_id}`;

const portalCaseId = () => {
    const match = decodeURIComponent(location.pathname).match(/^\/pa\/cases\/([0-9a-f-]{36})\/portal\/?$/iu);
    return match?.[1] || new URLSearchParams(location.search).get("case") || "";
};
const empty = (message) => { const node = document.createElement("div"); node.className = "empty-state"; node.textContent = message; return node; };
const revealError = (message) => { $("#portal-loading").hidden = true; $("#portal-error").hidden = false; $("#portal-error").textContent = message; };

const getBlob = async (document) => {
    const key = attachmentKey(document);
    if (blobs.has(key)) return blobs.get(key);
    const response = await fetch("/api/pa-gmail", { method: "POST", headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ action: "attachment_download", inquiry_id: caseId, gmail_message_id: document.message_id, gmail_attachment_id: document.attachment_id }), cache: "no-store" });
    if (!response.ok) throw new Error("attachment_unavailable");
    const url = URL.createObjectURL(await response.blob());
    blobs.set(key, url);
    return url;
};
window.addEventListener("pagehide", () => blobs.forEach((url) => URL.revokeObjectURL(url)));

const showPreview = async (item) => {
    const dialog = $("#preview-dialog");
    const body = $("#preview-dialog-body");
    $("#preview-dialog-title").textContent = item.filename;
    body.replaceChildren();
    try {
        const url = await getBlob(item);
        const node = document.createElement(isImage(item) ? "img" : "iframe");
        node.src = url;
        node.alt = item.filename;
        if (!isImage(item)) node.title = item.filename;
        body.append(node);
        dialog.showModal();
    } catch { revealError("正本の添付資料を読み込めませんでした。案件管理でGmail同期状態をご確認ください。"); }
};
const makePreview = (item) => {
    const button = document.createElement("button");
    button.type = "button"; button.className = "document-card__preview"; button.setAttribute("aria-label", `${item.filename}を拡大表示`);
    if (canPreview(item)) {
        const placeholder = document.createElement("span"); placeholder.className = "document-icon"; placeholder.textContent = isPdf(item) ? "PDF" : "画像"; button.append(placeholder);
        getBlob(item).then((url) => {
            const media = document.createElement(isImage(item) ? "img" : "object"); media.data = isPdf(item) ? url : ""; media.src = isImage(item) ? url : ""; media.type = item.mime_type || (isPdf(item) ? "application/pdf" : ""); media.alt = item.filename; media.setAttribute("aria-hidden", "true"); button.replaceChildren(media);
        }).catch(() => { placeholder.textContent = "表示不可"; });
    } else { const icon = document.createElement("span"); icon.className = "document-icon"; icon.textContent = "資料"; button.append(icon); }
    button.addEventListener("click", () => canPreview(item) && showPreview(item));
    return button;
};
const makeDocumentCard = (latest, history = []) => {
    const card = document.createElement("article"); card.className = "document-card"; card.append(makePreview(latest));
    const body = document.createElement("div"); body.className = "document-card__body";
    const title = document.createElement("h3"); title.textContent = latest.filename || "資料";
    const meta = document.createElement("p"); meta.className = "document-card__meta"; meta.textContent = `${sourceLabel(latest)} ／ ${documentTime(latest)}`;
    body.append(title, meta);
    if (history.length) { const details = document.createElement("details"); const summary = document.createElement("summary"); summary.textContent = `過去版 ${history.length}件`; const list = document.createElement("ul"); list.className = "history-list"; history.forEach((item) => { const entry = document.createElement("li"); const button = document.createElement("button"); button.type = "button"; button.textContent = `${item.filename}（${documentTime(item)}）`; button.addEventListener("click", () => showPreview(item)); entry.append(button); list.append(entry); }); details.append(summary, list); body.append(details); }
    card.append(body); return card;
};
const grouped = (documents) => [...documents.reduce((map, document) => { const key = groupKey(document); map.set(key, [...(map.get(key) || []), document]); return map; }, new Map()).values()].map((items) => items.sort((a, b) => String(b.occurred_at || "").localeCompare(String(a.occurred_at || ""))));
const renderVersioned = (target, documents, message, multiple = false) => {
    target.replaceChildren(); if (!documents.length) { target.append(empty(message)); return; }
    const groups = grouped(documents);
    if (!multiple) { const versions = groups.flat().sort((a, b) => String(b.occurred_at || "").localeCompare(String(a.occurred_at || ""))); target.append(makeDocumentCard(versions[0], versions.slice(1))); return; }
    groups.forEach((versions) => target.append(makeDocumentCard(versions[0], versions.slice(1))));
};
const renderPhotos = (documents) => {
    const target = $("#photo-content"); target.replaceChildren(); if (!documents.length) { target.append(empty("まだ登録されていません")); return; }
    documents.sort((a, b) => String(b.occurred_at || "").localeCompare(String(a.occurred_at || ""))).forEach((item) => { const card = document.createElement("button"); card.type = "button"; card.className = "photo-card"; const label = document.createElement("span"); label.textContent = item.filename; getBlob(item).then((url) => { const image = document.createElement("img"); image.src = url; image.alt = item.filename; card.prepend(image); }).catch(() => { label.textContent = `${item.filename}（表示不可）`; }); card.append(label); card.addEventListener("click", () => showPreview(item)); target.append(card); });
};
const renderPerformers = (documents) => {
    const target = $("#performer-content"); target.replaceChildren();
    if (documents.length) { documents.sort((a, b) => String(a.occurred_at || "").localeCompare(String(b.occurred_at || ""))).forEach((item, index) => { const card = document.createElement("article"); card.className = "performer-card"; const order = document.createElement("span"); order.className = "performer-order"; order.textContent = index + 1; const info = document.createElement("div"); const name = document.createElement("h3"); name.textContent = item.filename; const meta = document.createElement("p"); meta.textContent = `${sourceLabel(item)} ／ クリックで資料を確認`; info.append(name, meta); card.append(order, info); card.addEventListener("click", () => showPreview(item)); target.append(card); }); return; }
    ["出演者 01｜資料登録待ち", "出演者 02｜資料登録待ち", "出演者 03｜資料登録待ち"].forEach((name, index) => { const card = document.createElement("article"); card.className = "performer-card performer-card--sample"; card.innerHTML = `<span class="performer-order">${index + 1}</span><div><h3>${name}</h3><p>実際の出演者資料が登録されると、この位置に置き換わります。</p></div>`; target.append(card); });
};
const readDocuments = async () => {
    const response = await fetch("/api/pa-gmail", { method: "POST", headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ action: "portal_documents", inquiry_id: caseId }), cache: "no-store" });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !Array.isArray(payload?.result)) throw new Error("portal_documents_unavailable");
    return payload.result.flatMap((message) => (Array.isArray(message.attachment_metadata) ? message.attachment_metadata : []).filter((attachment) => attachment?.id && attachment?.filename).map((attachment) => ({ message_id: message.gmail_message_id, attachment_id: String(attachment.id), filename: String(attachment.filename), mime_type: String(attachment.mime_type || ""), subject: String(message.subject || ""), direction: message.direction, occurred_at: message.received_at || message.sent_at || "" })).filter((attachment) => !isCommercialDocument(attachment)));
};
const populate = async (item, progress) => {
    $("#portal-event-name").textContent = text(item.event_name, "イベント資料ポータル"); $("#portal-case-number").textContent = item.inquiry_number || ""; const status = statusLabels[item.status] || item.status || "未設定"; $("#portal-status").textContent = status; $("#portal-date").textContent = dateText(progress?.confirmed_event_date || item.event_date); $("#portal-time").textContent = timeText(item.event_time); $("#portal-venue").textContent = text(item.venue); $("#portal-state").textContent = status;
    const documents = await readDocuments(); const byCategory = Object.groupBy(documents, categoryFor);
    renderVersioned($("#timetable-content"), byCategory.timetable || [], "まだ登録されていません"); renderVersioned($("#script-content"), byCategory.script || [], "まだ登録されていません"); renderVersioned($("#layout-content"), byCategory.layout || [], "資料カードが追加されるとここに表示されます", true); renderPhotos(byCategory.photo || []); renderPerformers(byCategory.performer || []); renderVersioned($("#other-content"), byCategory.other || [], "資料カードが追加されるとここに表示されます", true);
};
const start = async () => {
    if (!isSupabaseConfigured) { revealError("管理画面の接続設定がありません。"); return; }
    caseId = portalCaseId(); if (!/^[0-9a-f-]{36}$/iu.test(caseId)) { revealError("案件IDが指定されていません。"); return; }
    supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY); const { data: { session } } = await supabase.auth.getSession(); if (!session) { $("#portal-loading").hidden = true; $("#portal-login").hidden = false; return; }
    accessToken = session.access_token; const [{ data: item, error }, { data: progress }] = await Promise.all([supabase.from("pa_inquiries").select("*").eq("id", caseId).is("deleted_at", null).maybeSingle(), supabase.from("pa_case_progress").select("confirmed_event_date").eq("inquiry_id", caseId).maybeSingle()]); if (error || !item) { revealError("この案件を読み込めませんでした。"); return; }
    try { await populate(item, progress); $("#portal-loading").hidden = true; $("#portal").hidden = false; } catch (error) { console.error("portal_documents_failed", String(error?.message || "unknown")); revealError("資料一覧を読み込めませんでした。案件管理でGmailの紐付けと同期状態をご確認ください。"); }
};
$("#preview-close").addEventListener("click", () => $("#preview-dialog").close()); $("#preview-dialog").addEventListener("click", (event) => { if (event.target === $("#preview-dialog")) $("#preview-dialog").close(); }); start();
