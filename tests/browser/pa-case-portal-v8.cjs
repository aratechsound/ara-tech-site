const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require("playwright");

const root = path.resolve(__dirname, "../..");
const css = fs.readFileSync(path.join(root, "pa-case-portal.css"), "utf8");
const output = process.env.PA_PORTAL_SCREENSHOT_DIR || path.join(root, "test-results", "pa-case-portal-v8");
const styleSource = process.env.PA_PORTAL_CSS_URL
    ? `<link rel="stylesheet" href="${process.env.PA_PORTAL_CSS_URL}">`
    : `<style>${css}</style>`;
fs.mkdirSync(output, { recursive: true });

const pdfCard = (title, collection = false) => `<article class="document-card${collection ? " collection-card" : ""}"><button type="button" class="document-card__preview preview-trigger" data-title="${title}"><canvas width="560" height="790"></canvas>${collection ? `<span class="collection-label">${title.replace(/\.pdf$/, "")}</span>` : ""}<span class="zoom-label">クリックで拡大</span></button><div class="document-card__body"><div class="title-row"><h3 class="document-title">${title}</h3>${collection ? "" : '<span class="badge badge--fixed">固定枠</span>'}</div><p class="document-card__meta">主催者・関係者提出 ／ 2026年9月2日 18:22</p><div class="badges"><span class="badge badge--latest">最新版</span></div><button type="button" class="view-button preview-trigger" data-title="${title}">大きく見る</button></div></article>`;

const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${styleSource}</head><body>
<header class="portal-header"><div class="header-inner"><a class="brand"><img src="/img/ARA-TECH%20ロゴ横%20白.png" alt="ARA-TECH"></a><span class="back-link">PA案件管理へ戻る</span></div></header>
<main class="portal-shell"><section id="portal">
<section class="hero"><div class="hero-copy"><span class="kicker">EVENT DOCUMENT PORTAL</span><h1>2026龍姫湖まつり</h1><div class="case-line"><span class="case-number">PA-20260901-00013</span><span class="status-badge">お客様回答待ち</span></div><p>案件に紐づくイベント資料の最新版と履歴を確認できます。</p></div><dl class="event-meta"><div><dt>開催日</dt><dd>2026年10月18日</dd></div><div><dt>本番時間</dt><dd>10:00〜15:30</dd></div><div><dt>会場</dt><dd>温井ダム堤体横駐車場</dd></div><div><dt>案件状態</dt><dd>お客様回答待ち</dd></div></dl></section>
<div class="admin-note"><strong>管理者専用</strong><span>Gmail・案件管理の正本資料を参照しています。</span></div>
<section class="section"><div class="section-head"><div><h2>タイムテーブル・台本</h2><p>固定枠には常に最新版を表示します。</p></div></div><div class="grid2"><div>${pdfCard("タイムテーブル（予定）.pdf")}</div><div><article class="empty-document-card document-card--placeholder"><div class="empty-card"><div class="empty-card__inner"><div class="empty-icon">📘</div><h3>台本はまだ登録されていません</h3><p>進行台本が登録されると、ここに最新版が表示されます。</p></div></div><div class="empty-card__footer"><div class="title-row"><h3 class="document-title">台本</h3><span class="badge badge--fixed">固定枠</span></div><p class="document-card__meta">未登録</p></div></article></div></div></section>
<section class="section"><div class="section-head"><div><h2>会場図・配置図</h2><p>図面ごとに最新版と履歴をまとめています。</p></div></div><div class="grid3">${pdfCard("龍姫湖まつりメイン会場図.pdf", true)}${pdfCard("龍姫湖まつり 2026 音響／電源配置図.pdf", true)}${pdfCard("搬入導線図.pdf", true)}</div></section>
<section class="section"><div class="section-head"><div><h2>会場・ステージ写真</h2><p>クリックで拡大できます。</p></div></div><div class="photo-album"><div class="photo-grid"><button class="photo-tile preview-trigger" data-title="ステージ写真（参考）.JPG"><svg viewBox="0 0 400 300" role="img" aria-label="ステージ写真"><rect width="400" height="300" fill="#9bc8e8"/><rect x="45" y="85" width="310" height="145" fill="#263746"/><rect x="70" y="110" width="260" height="95" fill="#f8f9fa"/><path d="M0 245L400 215V300H0Z" fill="#78a65c"/></svg><span>ステージ写真（参考）.JPG</span></button></div></div></section>
<section class="section"><div class="section-head"><div><h2>出演者資料</h2><p>出演順に資料が並びます。</p></div></div><div class="performer-wrap"><div class="sample-note">資料登録後は下のように並びます。<span class="sample-tag">表示例</span></div><div class="performer-list">${["○○BAND", "△△ Dance Team", "□□神楽団"].map((name, index) => `<article class="performer-item performer-item--sample"><span class="performer-order">${index + 1}</span><div class="performer-thumb"><div class="performer-stage"><span class="stage-box stage-box--left">Vo</span><span class="stage-box stage-box--right">Key</span><span class="stage-box stage-box--center">Dr</span></div></div><div class="performer-info"><h3>${name}</h3><p>ステージ資料 / 電源・音源情報</p></div></article>`).join("")}</div><p class="coming-soon">ステージ配置図作成機能：準備中</p></div></section>
<section class="section"><div class="section-head"><div><h2>その他の共通資料</h2><p>共通資料をカード単位で確認できます。</p></div></div><div class="grid3"><article class="empty-document-card document-card--placeholder collection-empty"><div class="empty-card"><div class="empty-card__inner"><div class="empty-icon">📄</div><h3>その他の共通資料はまだ登録されていません</h3><p>運営資料や注意事項などが登録されると、ここに表示されます。</p></div></div></article></div></section>
</section></main>
<dialog id="preview-dialog" class="preview-dialog"><div class="preview-dialog__inner"><div class="preview-dialog__head"><strong id="preview-dialog-title"></strong><button id="preview-close" class="icon-button">閉じる ×</button></div><div class="preview-dialog__body"><div class="pdf-pages"><canvas width="760" height="1074"></canvas></div></div></div></dialog>
<script>
for (const canvas of document.querySelectorAll('canvas')) { const context = canvas.getContext('2d'); context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height); context.fillStyle = '#007bff'; context.fillRect(35, 34, canvas.width - 70, 64); context.fillStyle = '#17212b'; context.font = 'bold 24px sans-serif'; context.fillText('2026 龍姫湖まつり', 52, 76); context.strokeStyle = '#9fb8cb'; for (let y = 130; y < canvas.height - 40; y += 48) { context.strokeRect(35, y, canvas.width - 70, 40); } }
const dialog = document.getElementById('preview-dialog');
document.querySelectorAll('.preview-trigger').forEach((button) => button.addEventListener('click', () => { document.getElementById('preview-dialog-title').textContent = button.dataset.title; dialog.showModal(); }));
document.getElementById('preview-close').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
</script></body></html>`;

const columns = (value) => value.split(" ").filter(Boolean).length;

(async () => {
    const server = http.createServer((request, response) => {
        if (decodeURIComponent(request.url).includes("ARA-TECH ロゴ横 白.png")) {
            response.writeHead(204, { "Cache-Control": "no-store" });
            response.end();
            return;
        }
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        response.end(html);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const browser = await chromium.launch({ headless: true, executablePath: process.env.PA_CHROME_EXECUTABLE || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", args: ["--disable-extensions", "--no-first-run"] });
    try {
        const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
        await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: process.env.PA_PORTAL_CSS_URL ? "networkidle" : "load" });
        const desktop = await page.evaluate(() => ({
            shell: document.querySelector(".portal-shell").getBoundingClientRect().width,
            heroRadius: getComputedStyle(document.querySelector(".hero")).borderRadius,
            fixedColumns: getComputedStyle(document.querySelector(".grid2")).gridTemplateColumns,
            collectionColumns: getComputedStyle(document.querySelector(".grid3")).gridTemplateColumns,
            photoColumns: getComputedStyle(document.querySelector(".photo-grid")).gridTemplateColumns,
            previewHeight: document.querySelector(".document-card__preview").getBoundingClientRect().height,
            collectionHeight: document.querySelector(".collection-card .document-card__preview").getBoundingClientRect().height,
            scrollWidth: document.documentElement.scrollWidth
        }));
        assert(desktop.shell >= 1179 && desktop.shell <= 1181, `desktop shell width: ${desktop.shell}`);
        assert.equal(desktop.heroRadius, "24px");
        assert.equal(columns(desktop.fixedColumns), 2);
        assert.equal(columns(desktop.collectionColumns), 3);
        assert.equal(columns(desktop.photoColumns), 4);
        assert.equal(desktop.previewHeight, 315);
        assert.equal(desktop.collectionHeight, 250);
        assert(desktop.scrollWidth <= 1440, `desktop horizontal overflow: ${desktop.scrollWidth}`);
        await page.locator(".document-card__preview").first().click();
        assert.equal(await page.locator("#preview-dialog").evaluate((node) => node.open), true);
        assert.equal(await page.locator("#preview-dialog-title").textContent(), "タイムテーブル（予定）.pdf");
        assert.equal(await page.locator("#preview-dialog iframe, #preview-dialog object").count(), 0);
        await page.keyboard.press("Escape");
        assert.equal(await page.locator("#preview-dialog").evaluate((node) => node.open), false);
        await page.screenshot({ path: path.join(output, "portal-v8-desktop.png"), fullPage: true });

        await page.setViewportSize({ width: 390, height: 844 });
        const mobile = await page.evaluate(() => ({
            width: innerWidth,
            scrollWidth: document.documentElement.scrollWidth,
            heroDirection: getComputedStyle(document.querySelector(".hero")).flexDirection,
            fixedColumns: getComputedStyle(document.querySelector(".grid2")).gridTemplateColumns,
            collectionColumns: getComputedStyle(document.querySelector(".grid3")).gridTemplateColumns,
            photoColumns: getComputedStyle(document.querySelector(".photo-grid")).gridTemplateColumns
        }));
        assert.equal(mobile.width, 390);
        assert(mobile.scrollWidth <= 390, `390px horizontal overflow: ${mobile.scrollWidth}`);
        assert.equal(mobile.heroDirection, "column");
        assert.equal(columns(mobile.fixedColumns), 1);
        assert.equal(columns(mobile.collectionColumns), 1);
        assert.equal(columns(mobile.photoColumns), 2);
        await page.locator(".photo-tile").click();
        const modalBox = await page.locator(".preview-dialog__inner").boundingBox();
        assert(modalBox.x >= 0 && modalBox.x + modalBox.width <= 390, `mobile modal overflow: ${JSON.stringify(modalBox)}`);
        await page.locator("#preview-close").click();
        await page.screenshot({ path: path.join(output, "portal-v8-390.png"), fullPage: true });
        console.log(`PA case portal V8 browser validation: PASS; screenshots=${output}`);
    } finally {
        await browser.close();
        await new Promise((resolve) => server.close(resolve));
    }
})().catch((error) => { console.error(error.stack); process.exitCode = 1; });
