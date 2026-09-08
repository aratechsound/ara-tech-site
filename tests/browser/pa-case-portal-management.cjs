const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require("playwright");

const root = path.resolve(__dirname, "../..");
const html = fs.readFileSync(path.join(root, "pa-case-portal.html"), "utf8");
const css = fs.readFileSync(path.join(root, "pa-case-portal.css"), "utf8");
const source = fs.readFileSync(path.join(root, "js", "pa-case-portal.js"), "utf8");
const caseId = "20000000-0000-4000-8000-000000000001";
const client = source.replace(/^import .*$/gmu, "").replace(
  /pdfjsLib\.GlobalWorkerOptions/u,
  `const createClient=()=>({auth:{getSession:async()=>({data:{session:{access_token:"fixture-token"}}})},from:(table)=>{const builder={select(){return builder},eq(){return builder},is(){return builder},maybeSingle:async()=>({data:table==="pa_inquiries"?{id:"${caseId}",event_name:"検証イベント",event_date:"2026-10-18",event_time:"10:00〜15:30",venue:"検証会場"}:{confirmed_event_date:"2026-10-18"},error:null})};return builder}}); const pdfjsLib={GlobalWorkerOptions:{},getDocument(){throw new Error("not used")}}; const SUPABASE_ANON_KEY="fixture"; const SUPABASE_URL="https://fixture.invalid"; const isSupabaseConfigured=true;\npdfjsLib.GlobalWorkerOptions`
);
const portal = {
  portal: { id: "30000000-0000-4000-8000-000000000001", case_id: caseId },
  cards: [
    { id: "40000000-0000-4000-8000-000000000001", category: "timetable", title: "タイムテーブル", card_kind: "fixed", owner_kind: "shared", current_version_id: null, versions: [] },
    { id: "40000000-0000-4000-8000-000000000002", category: "script", title: "台本", card_kind: "fixed", owner_kind: "shared", current_version_id: null, versions: [] },
  ], photos: []
};

const send = (response, status, type, body) => { response.writeHead(status, { "content-type": type, "cache-control": "no-store" }); response.end(body); };

(async () => {
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/pa-case-portal.css") return send(response, 200, "text/css", css);
    if (url.pathname === "/js/pa-case-portal.js") return send(response, 200, "text/javascript", client);
    if (url.pathname === "/api/pa-portal") {
      let raw = ""; for await (const chunk of request) raw += chunk;
      const input = JSON.parse(raw); assert.equal(input.inquiry_id, caseId);
      return send(response, 200, "application/json", JSON.stringify({ ok: true, result: input.action === "read" ? portal : [] }));
    }
    if (url.pathname.startsWith("/img/")) return send(response, 204, "image/png", "");
    return send(response, 200, "text/html", html);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PA_CHROME_EXECUTABLE || "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe", args: ["--disable-extensions", "--no-first-run"] });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.goto(`http://127.0.0.1:${server.address().port}/pa/cases/${caseId}/portal`, { waitUntil: "networkidle" });
    await page.waitForSelector("#portal:not([hidden])");
    assert.equal(await page.locator("#edit-mode-toggle").getAttribute("aria-pressed"), "false");
    assert.equal(await page.locator('.manage-only[data-manage="create-card"]').first().evaluate((node) => getComputedStyle(node).display), "none");
    assert.equal(await page.locator(".empty-card").first().evaluate((node) => Math.round(node.getBoundingClientRect().height)), 315);
    await page.click("#edit-mode-toggle");
    await page.waitForFunction(() => document.querySelector("#edit-mode-toggle").getAttribute("aria-pressed") === "true");
    assert.equal(await page.locator("#edit-mode-toggle").getAttribute("aria-pressed"), "true");
    assert.notEqual(await page.locator('.manage-only[data-manage="create-card"]').first().evaluate((node) => getComputedStyle(node).display), "none");
    assert.equal(await page.locator("#portal").textContent().then((text) => /案件状態|見積status|契約status|PA案件番号|PA案件管理へ戻る/u.test(text)), false);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await page.locator(".empty-card").first().evaluate((node) => Math.round(node.getBoundingClientRect().height)), 265);
    await page.locator('[data-manage="create-card"][data-category="layout"]').click();
    const box = await page.locator(".manage-dialog__inner").boundingBox();
    assert(box.x >= 0 && box.x + box.width <= 390, `390px management dialog overflow: ${JSON.stringify(box)}`);
    await page.click("#manage-close");
    await page.click("#edit-mode-toggle");
    assert.equal(await page.locator('.manage-only[data-manage="create-card"]').first().evaluate((node) => getComputedStyle(node).display), "none");
    console.log("PA portal management browser validation: PASS (normal/edit mode, V8 desktop, 390px, dialog containment)");
  } finally {
    await browser.close();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
