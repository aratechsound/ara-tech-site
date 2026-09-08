/*
 * Exercises the production PDF.js worker configuration in a real browser at
 * desktop and narrow, high-DPR viewports. The document is deliberately local:
 * this is regression coverage for the renderer, not Production asset evidence.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { PDFDocument, rgb, StandardFonts } = require("pdf-lib");
const { chromium } = require("playwright");

const root = path.resolve(__dirname, "..", "..");
const css = fs.readFileSync(path.join(root, "pa-case-portal.css"), "utf8");
const pdfModule = fs.readFileSync(require.resolve("pdfjs-dist/build/pdf.mjs"));
const workerModule = fs.readFileSync(require.resolve("pdfjs-dist/build/pdf.worker.min.mjs"));

async function makePdf() {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595, 842]);
  const font = await pdf.embedFont(StandardFonts.HelveticaBold);
  page.drawRectangle({ x: 34, y: 720, width: 527, height: 74, color: rgb(0.05, 0.53, 0.27) });
  page.drawText("RYUKIKO TIMETABLE", { x: 56, y: 750, size: 25, font, color: rgb(1, 1, 1) });
  for (let i = 0; i < 7; i += 1) {
    page.drawRectangle({ x: 54, y: 655 - i * 62, width: 488, height: 42, borderWidth: 1, borderColor: rgb(0.65, 0.7, 0.68) });
  }
  return Buffer.from(await pdf.save());
}

function send(res, content, type) {
  res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
  res.end(content);
}

async function main() {
  const pdf = await makePdf();
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, "http://127.0.0.1").pathname;
    if (pathname === "/pdf.mjs") return send(res, pdfModule, "text/javascript; charset=utf-8");
    if (pathname === "/pdfjs/pdf.worker.min.mjs") return send(res, workerModule, "text/javascript; charset=utf-8");
    if (pathname === "/timetable.pdf") return send(res, pdf, "application/pdf");
    if (pathname !== "/") return res.writeHead(404).end();
    return send(res, `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style>
      <main class="document-card"><button id="preview" class="document-card__preview" aria-label="PDFを開く"><span class="preview-loading">読み込み中…</span></button></main>
      <dialog id="dialog" class="preview-dialog"><button id="close">閉じる</button><canvas id="modal-canvas"></canvas></dialog>
      <script type="module">
        import * as pdfjsLib from "/pdf.mjs";
        pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.min.mjs?v=6.3.289";
        const preview = document.querySelector("#preview");
        const dialog = document.querySelector("#dialog");
        async function render(canvas, width, height) {
          const data = await (await fetch("/timetable.pdf")).arrayBuffer();
          const documentPdf = await pdfjsLib.getDocument({ data }).promise;
          const page = await documentPdf.getPage(1);
          const base = page.getViewport({ scale: 1 });
          const cssScale = Math.min(width / base.width, height / base.height, 1.65);
          const outputScale = Math.min(window.devicePixelRatio || 1, 2);
          const viewport = page.getViewport({ scale: cssScale * outputScale });
          canvas.width = Math.max(1, Math.ceil(viewport.width));
          canvas.height = Math.max(1, Math.ceil(viewport.height));
          canvas.style.width = Math.max(1, Math.round(base.width * cssScale)) + "px";
          canvas.style.height = Math.max(1, Math.round(base.height * cssScale)) + "px";
          await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
          return documentPdf;
        }
        requestAnimationFrame(async () => {
          try {
            const canvas = document.createElement("canvas");
            await render(canvas, Math.max(preview.clientWidth, 560), preview.clientHeight || 315);
            preview.replaceChildren(canvas);
            preview.addEventListener("click", async () => {
              await render(document.querySelector("#modal-canvas"), Math.min(window.innerWidth - 44, 760), window.innerHeight - 86);
              dialog.showModal();
            });
            document.querySelector("#close").addEventListener("click", () => dialog.close());
            document.body.dataset.ready = "true";
          } catch (error) {
            document.body.dataset.error = String(error && error.stack || error);
          }
        });
      </script>`, "text/html; charset=utf-8");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PA_CHROME_EXECUTABLE || "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    args: ["--disable-extensions", "--no-first-run"],
  });
  try {
    for (const viewport of [
      { name: "desktop", width: 1440, height: 900, deviceScaleFactor: 1 },
      { name: "mobile-390", width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
      { name: "mobile-375", width: 375, height: 812, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
    ]) {
      const context = await browser.newContext({ viewport, deviceScaleFactor: viewport.deviceScaleFactor, isMobile: viewport.isMobile, hasTouch: viewport.hasTouch });
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      await page.goto(url, { waitUntil: "load" });
      await page.waitForFunction(() => document.body.dataset.ready === "true" || Boolean(document.body.dataset.error), undefined, { timeout: 10000 });
      const state = await page.evaluate(() => {
        const preview = document.querySelector("#preview");
        const canvas = preview.querySelector("canvas");
        const context = canvas && canvas.getContext("2d");
        const pixels = context && context.getImageData(0, 0, canvas.width, Math.min(canvas.height, 140)).data;
        let coloured = 0;
        if (pixels) for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 1] > pixels[i] + 25 && pixels[i + 1] > pixels[i + 2] + 15) coloured += 1;
        return {
          error: document.body.dataset.error || null,
          genericFallback: preview.textContent.trim() === "PDF",
          hasCanvas: Boolean(canvas),
          previewHeight: Math.round(preview.getBoundingClientRect().height),
          canvasWidth: canvas && canvas.width,
          canvasHeight: canvas && canvas.height,
          coloured,
          horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
        };
      });
      assert.equal(state.error, null, `${viewport.name}: PDF.js worker/render error: ${state.error}`);
      assert.equal(state.hasCanvas, true, `${viewport.name}: first page must replace the loading state`);
      assert.equal(state.genericFallback, false, `${viewport.name}: generic PDF fallback must not appear`);
      assert.equal(state.horizontalOverflow, false, `${viewport.name}: must not introduce horizontal overflow`);
      assert.ok(state.coloured > 100, `${viewport.name}: rendered canvas must contain the PDF's first-page content`);
      assert.ok(state.canvasWidth <= 1120 && state.canvasHeight <= 1264, `${viewport.name}: DPR cap must bound canvas pixels`);
      assert.equal(state.previewHeight, viewport.width <= 390 ? 265 : 315, `${viewport.name}: V8 card height must remain unchanged`);
      await page.click("#preview");
      await page.waitForSelector("#dialog[open]");
      await page.click("#close");
      await page.waitForFunction(() => !document.querySelector("#dialog").open);
      await context.close();
    }
  } finally {
    await browser.close();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
  console.log("PA case portal same-origin PDF worker browser regression: PASS");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
