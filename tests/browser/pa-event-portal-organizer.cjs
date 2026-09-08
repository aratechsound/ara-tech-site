const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require("playwright");

const root = path.resolve(__dirname, "../..");
const html = fs.readFileSync(path.join(root, "pa-case-portal.html"), "utf8");
const css = fs.readFileSync(path.join(root, "pa-case-portal.css"), "utf8");
const source = fs.readFileSync(path.join(root, "js", "pa-case-portal.js"), "utf8");
const client = `const SUPABASE_ANON_KEY="fixture"; const SUPABASE_URL="https://fixture.invalid"; const isSupabaseConfigured=false;
const testDependencies={createClient:()=>{throw new Error("organizer must not create Supabase client")},pdfjsLib:{GlobalWorkerOptions:{},getDocument(){return {promise:Promise.resolve({numPages:1,getPage:async()=>({getViewport:({scale})=>({width:600*scale,height:800*scale}),render:()=>({promise:Promise.resolve()})})})}}}};
Object.defineProperty(globalThis,"__PA_PORTAL_TEST_DEPS__",{get(){globalThis.__PORTAL_DEPENDENCY_HASH__=location.hash;return testDependencies}});
${source.replace(/^import .*$/gmu, "")}`;
const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2ZtQAAAAASUVORK5CYII=", "base64");
const ref = (character) => character.repeat(36);
const portal = { event: { event_name: "共同ポータル検証", event_date: "2026-10-18", event_time: "10:00〜15:30", venue: "検証会場" }, cards: [
  { ref: ref("a"), category: "timetable", title: "タイムテーブル", card_kind: "fixed", owner_kind: "shared", can_edit: true, current_version_ref: null, versions: [] },
  { ref: ref("b"), category: "script", title: "台本", card_kind: "fixed", owner_kind: "shared", can_edit: true, current_version_ref: null, versions: [] },
  { ref: ref("c"), category: "layout", title: "ARA音響図", card_kind: "collection", owner_kind: "ara_tech", can_edit: false, current_version_ref: ref("d"), versions: [{ ref: ref("d"), display_filename: "ARA音響図.pdf", mime_type: "application/pdf", contributor_kind: "ara_tech", created_at: "2026-09-08T00:00:00Z" }] },
  { ref: ref("e"), category: "layout", title: "主催者会場図", card_kind: "collection", owner_kind: "organizer", can_edit: true, current_version_ref: ref("f"), versions: [{ ref: ref("f"), display_filename: "主催者会場図.pdf", mime_type: "application/pdf", contributor_kind: "organizer", created_at: "2026-09-08T01:00:00Z" }, { ref: ref("1"), display_filename: "主催者会場図旧版.pdf", mime_type: "application/pdf", contributor_kind: "organizer", created_at: "2026-09-07T01:00:00Z" }] }
], photos: [{ ref: ref("2"), display_filename: "主催者写真.jpg", mime_type: "image/jpeg", owner_kind: "organizer", can_edit: true, contributor_kind: "organizer" }, { ref: ref("3"), display_filename: "ARA写真.jpg", mime_type: "image/jpeg", owner_kind: "ara_tech", can_edit: false, contributor_kind: "ara_tech" }] };
const send = (response, status, type, body) => { response.writeHead(status, { "content-type": type, "cache-control": "no-store" }); response.end(body); };

(async () => {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/pa-case-portal.css") return send(response, 200, "text/css", css);
    if (url.pathname === "/js/pa-case-portal.js") return send(response, 200, "text/javascript", client);
    if (url.pathname.startsWith("/img/")) return send(response, 204, "image/png", "");
    if (url.pathname === "/api/event-portal") {
      let raw = ""; for await (const chunk of request) raw += chunk; const input = JSON.parse(raw); requests.push(input);
      if (input.action === "download") return send(response, 200, input.asset_kind === "photo" ? "image/png" : "application/pdf", input.asset_kind === "photo" ? pixel : Buffer.from("%PDF-1.7\n%%EOF"));
      return send(response, 200, "application/json", JSON.stringify({ ok: true, result: input.action === "read" ? portal : input.action === "exchange" ? { expires_at: "2026-09-09T00:00:00Z" } : {} }));
    }
    return send(response, 200, "text/html", html);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PA_CHROME_EXECUTABLE || "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe", args: ["--disable-extensions", "--no-first-run"] });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.goto(`http://127.0.0.1:${server.address().port}/event-portal#${"9".repeat(64)}`, { waitUntil: "networkidle" });
    await page.waitForSelector("#portal:not([hidden])");
    assert.equal(new URL(page.url()).hash, ""); assert.equal(new URL(page.url()).pathname, "/event-portal");
    assert.equal(await page.evaluate(() => globalThis.__PORTAL_DEPENDENCY_HASH__), "");
    assert.equal(await page.locator("body").getAttribute("class").then((v) => v.includes("organizer-portal")), true);
    assert.equal(await page.locator("#portal").textContent().then((v) => /PA案件|案件状態|Gmail|見積|契約|請求|UUID/u.test(v)), false);
    await page.locator('button[aria-label="ARA音響図.pdfを拡大表示"]').click();
    await page.waitForSelector("#preview-dialog .pdf-pages canvas");
    await page.click("#preview-close");
    await page.locator('button[aria-label="主催者写真.jpgを拡大表示"]').click();
    await page.waitForFunction(() => document.querySelector("#preview-dialog-body img")?.naturalWidth > 0);
    await page.click("#preview-close");
    await page.click("#edit-mode-toggle");
    assert.equal(await page.locator("#share-link-manage").evaluate((node) => getComputedStyle(node).display), "none");
    assert.equal(await page.locator('[data-owner-editable="false"] .card-management').evaluate((node) => getComputedStyle(node).display), "none");
    assert.notEqual(await page.locator('[data-owner-editable="true"] .card-management').evaluate((node) => getComputedStyle(node).display), "none");
    await page.locator('[data-manage="create-card"][data-category="layout"]').click();
    const dialogText = await page.locator("#manage-dialog").textContent();
    assert.doesNotMatch(dialogText, /既存PA案件|メール添付|ARA-TECH|出演者/u);
    assert.deepEqual(await page.locator('select[name="owner_kind"] option').allTextContents(), ["主催者", "共同"]);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const box = await page.locator(".manage-dialog__inner").boundingBox(); assert(box.x >= 0 && box.x + box.width <= 390);
    await page.click("#manage-close");
    await page.locator('button[aria-label="ARA音響図.pdfを拡大表示"]').click();
    const pdfBox = await page.locator(".preview-dialog__inner").boundingBox(); assert(pdfBox.x >= 0 && pdfBox.x + pdfBox.width <= 390);
    await page.click("#preview-close");
    await page.locator('button[aria-label="主催者写真.jpgを拡大表示"]').click();
    const imageBox = await page.locator(".preview-dialog__inner").boundingBox(); assert(imageBox.x >= 0 && imageBox.x + imageBox.width <= 390);
    await page.click("#preview-close");
    assert.equal(requests.some((item) => item.action === "candidates" || Object.hasOwn(item, "inquiry_id")), false);
    assert.deepEqual(requests.map((item) => item.action).slice(0, 2), ["exchange", "read"]);
    console.log("PA organizer V8 browser validation: PASS (clean fragment, PDF/image previews, edit permissions, picker isolation, history, 390px modals)");
  } finally { await browser.close(); await new Promise((resolve) => server.close(resolve)); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
