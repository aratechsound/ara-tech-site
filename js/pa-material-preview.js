let pdfjsPromise;
let previewRequest = 0;

const PDF_MIME = "application/pdf";
const isPdf = (item) => String(item?.mime_type || "").toLowerCase().split(";")[0] === PDF_MIME || /\.pdf$/iu.test(item?.original_filename || "");
const isImage = (item) => /^image\/(?:jpeg|png|webp)$/iu.test(String(item?.mime_type || "").toLowerCase().split(";")[0]);
const element = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (typeof text === "string") node.textContent = text;
    return node;
};

const loadPdfJs = async () => {
    if (!pdfjsPromise) {
        pdfjsPromise = import("/pdfjs/pdf.min.mjs?v=6.3.289").then((pdfjs) => {
            pdfjs.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.min.mjs?v=6.3.289";
            return pdfjs;
        }).catch((error) => {
            pdfjsPromise = null;
            throw error;
        });
    }
    return pdfjsPromise;
};

const renderPdfPage = async (pdf, pageNumber, canvas, maxCssWidth, maxCssHeight = Number.POSITIVE_INFINITY) => {
    const page = await pdf.getPage(pageNumber);
    const base = page.getViewport({ scale: 1 });
    const cssScale = Math.min(maxCssWidth / base.width, maxCssHeight / base.height, 1.75);
    const outputScale = Math.min(window.devicePixelRatio || 1, 2);
    const viewport = page.getViewport({ scale: cssScale * outputScale });
    canvas.width = Math.max(1, Math.ceil(viewport.width));
    canvas.height = Math.max(1, Math.ceil(viewport.height));
    canvas.style.width = `${Math.round(base.width * cssScale)}px`;
    canvas.style.height = `${Math.round(base.height * cssScale)}px`;
    await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
};

const decodeImage = async (blob) => {
    if (typeof createImageBitmap === "function") {
        try { return await createImageBitmap(blob); } catch { /* Fall through to the data URL decoder for browser-specific formats. */ }
    }
    const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = reject;
        image.src = dataUrl;
    });
};

const drawImage = async (blob, canvas, maxCssWidth, maxCssHeight) => {
    const image = await decodeImage(blob);
    const naturalWidth = image.width || image.naturalWidth;
    const naturalHeight = image.height || image.naturalHeight;
    const cssScale = Math.min(maxCssWidth / naturalWidth, maxCssHeight / naturalHeight, 1);
    const cssWidth = Math.max(1, Math.round(naturalWidth * cssScale));
    const cssHeight = Math.max(1, Math.round(naturalHeight * cssScale));
    const outputScale = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.round(cssWidth * outputScale));
    canvas.height = Math.max(1, Math.round(cssHeight * outputScale));
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;
    canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
    image.close?.();
};

const fallback = (root, message = "プレビューを表示できません") => {
    const icon = element("span", "pa-commercial-file__file-icon", "資料");
    root.replaceChildren(icon, element("span", "pa-commercial-file__fallback", message));
};

const dialogFor = () => {
    let dialog = document.getElementById("pa-material-preview-dialog");
    if (dialog) return dialog;
    dialog = element("dialog", "pa-material-preview-dialog");
    dialog.id = "pa-material-preview-dialog";
    const head = element("div", "pa-material-preview-dialog__head");
    const title = element("h3");
    title.id = "pa-material-preview-title";
    const close = element("button", "button button--secondary button--small", "閉じる");
    close.type = "button";
    close.addEventListener("click", () => { previewRequest += 1; dialog.close(); });
    head.append(title, close);
    const body = element("div", "pa-material-preview-dialog__body");
    body.id = "pa-material-preview-body";
    dialog.append(head, body);
    dialog.addEventListener("click", (event) => {
        if (event.target === dialog) { previewRequest += 1; dialog.close(); }
    });
    dialog.addEventListener("cancel", () => { previewRequest += 1; });
    document.body.append(dialog);
    return dialog;
};

const downloadBlob = (blob, filename) => {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.rel = "noopener";
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
};

const showPreview = async ({ item, filename, getBlob }) => {
    const requestId = ++previewRequest;
    const dialog = dialogFor();
    const body = document.getElementById("pa-material-preview-body");
    document.getElementById("pa-material-preview-title").textContent = filename;
    body.replaceChildren(element("p", "pa-material-preview-dialog__loading", "資料を読み込んでいます…"));
    if (!dialog.open) dialog.showModal();
    try {
        const blob = await getBlob();
        if (requestId !== previewRequest) return;
        if (isPdf(item)) {
            const pdfjs = await loadPdfJs();
            const pdf = await pdfjs.getDocument({ data: await blob.arrayBuffer() }).promise;
            if (requestId !== previewRequest) return;
            const pages = element("div", "pa-material-preview-dialog__pages");
            body.replaceChildren(pages);
            const width = Math.min(Math.max(280, body.clientWidth - 32), 1050);
            for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
                if (requestId !== previewRequest) return;
                const canvas = document.createElement("canvas");
                canvas.setAttribute("aria-label", `${filename} ${pageNumber}ページ目`);
                pages.append(canvas);
                await renderPdfPage(pdf, pageNumber, canvas, width);
            }
        } else if (isImage(item)) {
            const canvas = document.createElement("canvas");
            canvas.setAttribute("aria-label", filename);
            await drawImage(blob, canvas, Math.min(Math.max(280, body.clientWidth - 32), 1400), Math.max(320, window.innerHeight - 180));
            if (requestId === previewRequest) body.replaceChildren(canvas);
        } else {
            downloadBlob(blob, filename);
            body.replaceChildren(element("p", "pa-material-preview-dialog__loading", "この資料はダウンロードして対応アプリで確認してください。"));
        }
    } catch {
        if (requestId === previewRequest) body.replaceChildren(element("p", "pa-material-preview-dialog__error", "プレビューを表示できません。資料の紐付けまたは取得状態を確認してください。"));
    }
};

export const createMaterialPreview = ({ item, filename, previewRoot, card, strip, getBlob, isCurrent }) => {
    let blobPromise;
    let started = false;
    const blob = () => blobPromise ||= getBlob();
    const renderThumbnail = async () => {
        if (started || !isCurrent()) return;
        started = true;
        try {
            const bytes = await blob();
            if (!isCurrent()) return;
            if (isPdf(item)) {
                const pdfjs = await loadPdfJs();
                const pdf = await pdfjs.getDocument({ data: await bytes.arrayBuffer() }).promise;
                if (!isCurrent()) return;
                const canvas = document.createElement("canvas");
                canvas.setAttribute("aria-hidden", "true");
                await renderPdfPage(pdf, 1, canvas, 156, 86);
                if (isCurrent()) previewRoot.replaceChildren(canvas);
            } else if (isImage(item)) {
                const canvas = document.createElement("canvas");
                canvas.setAttribute("aria-hidden", "true");
                await drawImage(bytes, canvas, 156, 86);
                if (isCurrent()) previewRoot.replaceChildren(canvas);
            } else fallback(previewRoot, "ダウンロードして確認");
        } catch {
            if (isCurrent()) fallback(previewRoot);
        }
    };
    if ("IntersectionObserver" in window) {
        const observer = new IntersectionObserver((entries) => {
            if (entries.some((entry) => entry.isIntersecting)) {
                observer.disconnect();
                renderThumbnail();
            }
        }, { root: strip, rootMargin: "40px 180px" });
        observer.observe(card);
    } else renderThumbnail();
    card.addEventListener("click", () => showPreview({ item, filename, getBlob: blob }));
};
