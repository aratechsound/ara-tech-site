// Read-only document presentation shared by admin, organizer and staff portals.
// All asset access is supplied by the caller's existing authorized API adapter.
export function createPortalDocumentView({getAttachmentRecord, getPdfjs, orgText,
    orgUi = (node,value) => {node.textContent=String(value ?? '');}, sourceLabel,
    documentTime, groupKey = item => item.logical_title || item.filename,
    showToast, dialogSelector='#preview-dialog', bodySelector='#preview-dialog-body',
    titleSelector='#preview-dialog-title', nextPreview: next, isCurrentPreview: current}) {
const $ = selector => document.querySelector(selector === '#preview-dialog' ? dialogSelector : selector === '#preview-dialog-body' ? bodySelector : selector === '#preview-dialog-title' ? titleSelector : selector);
const pdfDocuments = new Map();
let generation=0;
const nextPreview = next || (() => ++generation);
const isCurrentPreview = current || (id => id === generation);
const attachmentKey = item => `${item.asset_kind}:${item.asset_id}`;
const isImage = (item) => /^image\//iu.test(item.mime_type || "");
const isPdf = (item) => String(item.mime_type || "").toLowerCase() === "application/pdf" || /\.pdf$/iu.test(item.filename || "");
const canPreview = (item) => isImage(item) || isPdf(item);
const getBlobUrl = async (item) => (await getAttachmentRecord(item)).url;
const getPdfDocument = async (item) => {
    const key = attachmentKey(item);
    if (pdfDocuments.has(key)) return pdfDocuments.get(key);
    const promise = getAttachmentRecord(item)
        .then(({ blob }) => blob.arrayBuffer())
        .then(async (data) => (await getPdfjs()).getDocument({ data }).promise)
        .catch((error) => { pdfDocuments.delete(key); throw error; });
    pdfDocuments.set(key, promise);
    return promise;
};


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
    nextPreview();
    const dialog = $("#preview-dialog");
    if (dialog.open) dialog.close();
    $("#preview-dialog-body").classList.remove("stage-plot-large-preview");
    $("#preview-dialog-body").replaceChildren();
};
const showPreview = async (item) => {
    if (!canPreview(item)) return;
    const requestId = nextPreview();
    const dialog = $("#preview-dialog");
    const body = $("#preview-dialog-body");
    orgUi($("#preview-dialog-title"), item.filename || orgText("orgPreview"));
    const loading = document.createElement("span");
    loading.className = "modal-loading";
    orgUi(loading, orgText("orgLoading"));
    body.replaceChildren(loading);
    if (!dialog.open) dialog.showModal();
    try {
        if (isImage(item)) {
            const image = document.createElement("img");
            image.src = await getBlobUrl(item);
            image.alt = item.filename;
            if (isCurrentPreview(requestId)) body.replaceChildren(image);
            return;
        }
        const pdf = await getPdfDocument(item);
        if (!isCurrentPreview(requestId)) return;
        const pages = document.createElement("div");
        pages.className = "pdf-pages";
        body.replaceChildren(pages);
        const availableWidth = Math.max(280, body.clientWidth - 28);
        for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
            if (!isCurrentPreview(requestId)) return;
            const canvas = document.createElement("canvas");
            canvas.setAttribute("aria-label", String(orgText("orgPage",{filename:item.filename,page:pageNumber})));
            pages.append(canvas);
            await renderPdfPage(item, pageNumber, canvas, Math.min(availableWidth, 1050));
        }
    } catch {
        if (isCurrentPreview(requestId)) {
            body.replaceChildren();
            const error = document.createElement("span");
            error.className = "modal-loading";
            orgUi(error, orgText("orgOriginalError"));
            body.append(error);
        }
    }
};

const appendZoomLabel = (button) => {
    const zoom = document.createElement("span");
    zoom.className = "zoom-label";
    orgUi(zoom, orgText("orgZoom"));
    button.append(zoom);
};
const makePreview = (item, { collection = false } = {}) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "document-card__preview";
    button.setAttribute("aria-label", String(orgText("orgEnlarge",{filename:item.filename})));
    const loading = document.createElement("span");
    loading.className = "preview-loading";
    orgUi(loading, isPdf(item) ? orgText("orgPdfLoading") : orgText("orgImageLoading"));
    button.append(loading);
    if (collection) {
        const label = document.createElement("span");
        label.className = "collection-label";
        orgUi(label, item.logical_title || groupKey(item));
        button.append(label);
    }
    appendZoomLabel(button);
    if (isImage(item)) {
        getBlobUrl(item).then((url) => {
            const image = document.createElement("img");
            image.src = url;
            image.alt = item.filename;
            loading.replaceWith(image);
        }).catch(() => { orgUi(loading, orgText("orgUnavailable")); });
    } else if (isPdf(item)) {
        const canvas = document.createElement("canvas");
        canvas.setAttribute("aria-hidden", "true");
        requestAnimationFrame(() => renderPdfPage(item, 1, canvas, Math.max(button.clientWidth, collection ? 360 : 560), button.clientHeight || (collection ? 250 : 315))
            .then(() => loading.replaceWith(canvas))
            .catch(() => { loading.className = "document-icon"; orgUi(loading, "PDF"); }));
    } else {
        loading.className = "document-icon";
        orgUi(loading, orgText("orgDocument"));
    }
    button.addEventListener("click", () => showPreview(item));
    return button;
};
const makeHistoryThumbnail = (item) => {
    const thumb = document.createElement("div");
    thumb.className = "history-thumb";
    if (isImage(item)) {
        getBlobUrl(item).then((url) => { const image = document.createElement("img"); image.src = url; image.alt = ""; thumb.replaceChildren(image); }).catch(() => { orgUi(thumb, orgText("orgImage")); });
    } else if (isPdf(item)) {
        const canvas = document.createElement("canvas");
        renderPdfPage(item, 1, canvas, 64, 50).then(() => thumb.replaceChildren(canvas)).catch(() => { orgUi(thumb, "PDF"); });
    } else { orgUi(thumb, orgText("orgDocument")); }
    return thumb;
};
const makeDocumentCard = (latest, { fixed = false, collection = false } = {}) => {
    const card = document.createElement("article");
    card.className = `document-card${collection ? " collection-card" : ""}`;

    card.append(makePreview(latest, { collection }));
    const body = document.createElement("div");
    body.className = "document-card__body";
    const titleRow = document.createElement("div");
    titleRow.className = "title-row";
    const title = document.createElement("h3");
    title.className = "document-title";
    orgUi(title, latest.filename || orgText("orgDocument"));
    titleRow.append(title);
    if (fixed) {
        const fixedBadge = document.createElement("span");
        fixedBadge.className = "badge badge--fixed";
        orgUi(fixedBadge, orgText("orgFixed"));
        titleRow.append(fixedBadge);
    }
    const meta = document.createElement("p");
    meta.className = "document-card__meta";
    orgUi(meta, `${sourceLabel(latest)} ／ ${documentTime(latest)}`);
    const badges = document.createElement("div");
    badges.className = "badges";
    const current = document.createElement("span");
    current.className = "badge badge--latest";
    orgUi(current, orgText("orgCurrent"));
    badges.append(current);
    const view = document.createElement("button");
    view.type = "button";
    view.className = "view-button";
    orgUi(view, orgText("orgLargePreview"));
    view.addEventListener("click", () => showPreview(latest));
    const download = document.createElement("button");download.type="button";download.className="view-button document-download";orgUi(download,orgText("download"));download.addEventListener("click",async()=>{download.disabled=true;let record;try{record=await getAttachmentRecord(latest,{fresh:true});const anchor=document.createElement("a");anchor.href=record.url;anchor.download=latest.filename;anchor.click();}catch{showToast(orgText("orgOriginalError"));}finally{download.disabled=false;if(record)setTimeout(()=>URL.revokeObjectURL(record.url),1000);}});
    const type = document.createElement("span");type.className="badge document-type";orgUi(type,isPdf(latest)?"PDF":isImage(latest)?orgText("orgImage"):orgText("orgDocument"));badges.append(type);
    body.append(titleRow, meta, badges, view, download);
    card.append(body);
    return card;
};
const makeEmptyCard = ({ title, message, icon, fixed = false, collection = false, cardId = null, canEdit = true }) => {
    const card = document.createElement("article");
    card.className = `empty-document-card document-card--placeholder${collection ? " collection-empty" : ""}`;
    const visual = document.createElement("div");
    visual.className = "empty-card";
    const inner = document.createElement("div");
    inner.className = "empty-card__inner";
    const iconNode = document.createElement("div");
    iconNode.className = "empty-icon";
    iconNode.setAttribute("aria-hidden", "true");
    orgUi(iconNode, icon);
    const heading = document.createElement("h3");
    orgUi(heading, orgText("orgEmptyTitle",{title}));
    const copy = document.createElement("p");
    orgUi(copy, message);
    inner.append(iconNode, heading, copy);
    visual.append(inner);
    const footer = document.createElement("div");
    footer.className = "empty-card__footer";
    const titleRow = document.createElement("div");
    titleRow.className = "title-row";
    const label = document.createElement("h3");
    label.className = "document-title";
    orgUi(label, title);
    titleRow.append(label);
    if (fixed) {
        const badge = document.createElement("span");
        badge.className = "badge badge--fixed";
        orgUi(badge, orgText("orgFixed"));
        titleRow.append(badge);
    }
    const meta = document.createElement("p");
    meta.className = "document-card__meta";
    orgUi(meta, orgText("orgNotUploaded"));
    footer.append(titleRow, meta);
    card.append(visual, footer);
    return card;
};
const makePhotoTile = item => {
    const tile=document.createElement('button');tile.type='button';tile.className='photo-tile photo-tile__preview';
    tile.setAttribute('aria-label',String(orgText('orgEnlarge',{filename:item.filename})));
    const label=document.createElement('span');orgUi(label,item.filename);tile.append(label);
    getBlobUrl(item).then(url=>{const image=document.createElement('img');image.src=url;image.alt=item.filename;tile.prepend(image);}).catch(()=>orgUi(label,orgText('orgPhotoUnavailable',{filename:item.filename})));
    tile.addEventListener('click',()=>showPreview(item));
    const wrap=document.createElement('div');wrap.className='photo-tile';wrap.append(tile);
    return wrap;
};
const makePerformerDocument = item => {
    const button=document.createElement('button');button.type='button';button.className='performer-document';
    const thumb=document.createElement('span');thumb.className='performer-thumb';thumb.append(makeHistoryThumbnail(item));
    const label=document.createElement('span');label.className='performer-document__label';orgUi(label,item.filename);
    button.append(thumb,label);button.addEventListener('click',()=>showPreview(item));return button;
};
const clear = () => {closePreview();for(const pending of pdfDocuments.values())pending.then(pdf=>pdf.destroy()).catch(()=>{});pdfDocuments.clear();};
return {makeEmptyCard,makeDocumentCard,makePhotoTile,makePerformerDocument,makePreview,makeHistoryThumbnail,
    showPreview,closePreview,getBlobUrl,getPdfDocument,renderPdfPage,clear};
}
