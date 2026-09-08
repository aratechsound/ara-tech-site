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
const timetableCard = "40000000-0000-4000-8000-000000000001";
const candidatePdf = "50000000-0000-4000-8000-000000000001";
const candidatePhoto = "50000000-0000-4000-8000-000000000002";
const candidateOther = "50000000-0000-4000-8000-000000000003";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lq8QYQAAAABJRU5ErkJggg==", "base64");
const client = `const SUPABASE_ANON_KEY="fixture"; const SUPABASE_URL="https://fixture.invalid"; const isSupabaseConfigured=true;
globalThis.__PA_PORTAL_TEST_DEPS__={createClient:()=>({auth:{getSession:async()=>({data:{session:{access_token:"fixture-token"}}})},from:(table)=>{const builder={select(){return builder},eq(){return builder},is(){return builder},maybeSingle:async()=>({data:table==="pa_inquiries"?{id:"${caseId}",event_name:"候補UI検証",event_date:"2026-10-18",event_time:"10:00〜15:30",venue:"検証会場"}:{confirmed_event_date:"2026-10-18"},error:null})};return builder}}),pdfjsLib:{GlobalWorkerOptions:{},getDocument(){return {promise:Promise.resolve({numPages:1,getPage:async()=>({getViewport:({scale})=>({width:600*scale,height:840*scale}),render:()=>({promise:Promise.resolve()})})})}}}};
${source.replace(/^import .*$/gmu, "")}`;
const portal = { portal: { id: "30000000-0000-4000-8000-000000000001", case_id: caseId }, cards: [
  { id: timetableCard, category: "timetable", title: "タイムテーブル", card_kind: "fixed", owner_kind: "shared", current_version_id: null, versions: [] },
  { id: "40000000-0000-4000-8000-000000000002", category: "script", title: "台本", card_kind: "fixed", owner_kind: "shared", current_version_id: null, versions: [] }
], photos: [] };
const candidateRows = [
  { id: candidatePdf, source_type: "gmail_attachment", source_direction: "inbound", display_filename: "タイムテーブル確定版.pdf", mime_type: "application/pdf", source_created_at: "2026-09-09T00:00:00Z", source_subject: "タイムテーブル送付", source_sender: "organizer@example.test", suggested_category: "timetable", suggested_card_id: timetableCard, suggested_action: "add_new_version", suggested_title: "タイムテーブル", confidence: "high", suggestion_basis: "ファイル名にタイムテーブル系の語句" },
  { id: candidatePhoto, source_type: "gmail_attachment", source_direction: "inbound", display_filename: "stage_02.jpg", mime_type: "image/jpeg", source_created_at: "2026-09-09T01:00:00Z", source_subject: "現場写真", source_sender: "organizer@example.test", suggested_category: "photo", suggested_card_id: null, suggested_action: "add_photo", suggested_title: "stage_02", confidence: "medium", suggestion_basis: "画像MIME" },
  { id: candidateOther, source_type: "pa_attachment", source_direction: "outbound", display_filename: "運営連絡.pdf", mime_type: "application/pdf", source_created_at: "2026-09-09T02:00:00Z", source_subject: "共有", source_sender: "aratechsound@gmail.com", suggested_category: "other", suggested_card_id: null, suggested_action: "create_new_card", suggested_title: "運営連絡", confidence: "low", suggestion_basis: "分類語がないため要確認" }
];
const send = (response, status, type, body) => { response.writeHead(status, { "content-type": type, "cache-control": "no-store" }); response.end(body); };

(async () => {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/pa-case-portal.css") return send(response, 200, "text/css", css);
    if (url.pathname === "/js/pa-case-portal.js") return send(response, 200, "text/javascript", client);
    if (url.pathname === "/api/pa-portal") {
      let raw = ""; for await (const chunk of request) raw += chunk;
      const input = JSON.parse(raw); requests.push({ input, authorization: request.headers.authorization }); assert.equal(input.inquiry_id, caseId); assert.equal(request.headers.authorization, "Bearer fixture-token");
      if (input.action === "read") return send(response, 200, "application/json", JSON.stringify({ ok: true, result: portal }));
      if (input.action === "candidates") return send(response, 200, "application/json", JSON.stringify({ ok: true, result: [] }));
      if (input.action === "candidate_list") return send(response, 200, "application/json", JSON.stringify({ ok: true, result: { pending_count: candidateRows.length, candidates: candidateRows, cards: portal.cards } }));
      if (input.action === "candidate_download") return send(response, 200, input.candidate_id === candidatePhoto ? "image/png" : "application/pdf", input.candidate_id === candidatePhoto ? png : Buffer.from("%PDF-1.7\nfixture\n%%EOF"));
      if (input.action === "candidate_accept" || input.action === "candidate_ignore") {
        const index = candidateRows.findIndex((item) => item.id === input.candidate_id); assert(index >= 0); candidateRows.splice(index, 1);
        return send(response, 200, "application/json", JSON.stringify({ ok: true, result: { candidate_id: input.candidate_id, status: input.action === "candidate_ignore" ? "ignored" : "accepted" } }));
      }
      if (input.action === "candidate_backfill") return send(response, 200, "application/json", JSON.stringify({ ok: true, result: { detected: 0, pending: candidateRows.length } }));
      return send(response, 200, "application/json", JSON.stringify({ ok: true, result: [] }));
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
    assert.equal(await page.locator("#candidate-inbox").isVisible(), false, "normal V8 reading mode must not be obstructed by the inbox");
    await page.click("#edit-mode-toggle");
    await page.waitForSelector("#candidate-inbox .candidate-card");
    assert.equal(await page.locator("#candidate-count").textContent(), "3");
    assert.equal(await page.locator("#candidate-content canvas").count(), 2, "PDF candidates render their first page through the shared PDF.js path");
    await page.locator("#candidate-content img").waitFor();
    const visibleText = await page.locator("#candidate-inbox").textContent();
    assert.match(visibleText, /受信メール/u); assert.match(visibleText, /送信メール/u); assert.match(visibleText, /確信度 高/u); assert.match(visibleText, /件名：タイムテーブル送付/u);
    assert.equal(/50000000-0000-4000-8000/u.test(visibleText), false, "internal candidate UUIDs must not be surface text");

    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const candidateBox = await page.locator(".candidate-card").first().boundingBox(); assert(candidateBox.x >= 0 && candidateBox.x + candidateBox.width <= 390);
    await page.locator(".candidate-card__preview").first().click(); await page.waitForSelector("#preview-dialog[open]");
    const previewBox = await page.locator(".preview-dialog__inner").boundingBox(); assert(previewBox.x >= 0 && previewBox.x + previewBox.width <= 390); await page.click("#preview-close");
    await page.setViewportSize({ width: 1440, height: 1000 });

    await page.getByRole("button", { name: "提案どおり登録" }).first().click();
    await page.getByRole("button", { name: "承認して登録" }).waitFor();
    assert.equal(await page.locator('input[name="make_current"]').isChecked(), false, "current promotion must require an explicit checkbox");
    await page.getByRole("button", { name: "承認して登録" }).click();
    await page.waitForFunction(() => document.querySelector("#candidate-count")?.textContent === "2");
    const pdfAccept = requests.find((item) => item.input.action === "candidate_accept" && item.input.candidate_id === candidatePdf).input;
    assert.equal(pdfAccept.payload.make_current, false); assert.equal(pdfAccept.payload.action, "add_new_version"); assert.equal(pdfAccept.payload.card_id, timetableCard);

    await page.getByRole("button", { name: "登録先を変更" }).first().click();
    await page.getByRole("button", { name: "承認して登録" }).waitFor();
    assert.equal(await page.locator('select[name="target_action"]').inputValue(), "add_photo"); assert.equal(await page.locator('input[name="make_current"]').isDisabled(), true);
    await page.getByRole("button", { name: "承認して登録" }).click();
    await page.waitForFunction(() => document.querySelector("#candidate-count")?.textContent === "1");
    const photoAccept = requests.find((item) => item.input.action === "candidate_accept" && item.input.candidate_id === candidatePhoto).input;
    assert.equal(photoAccept.payload.action, "add_photo"); assert.equal(photoAccept.payload.make_current, false);

    await page.getByRole("button", { name: "無視" }).click();
    await page.waitForFunction(() => document.querySelector("#candidate-count")?.textContent === "0");
    assert.equal(await page.locator(".candidate-empty").isVisible(), true);
    await page.click("#candidate-backfill"); await page.waitForFunction(() => !document.querySelector("#candidate-backfill").disabled);
    assert(requests.some((item) => item.input.action === "candidate_backfill"));
    assert(requests.filter((item) => item.input.action === "candidate_download").every((item) => [candidatePdf, candidatePhoto, candidateOther].includes(item.input.candidate_id)));
    console.log("PA portal candidate browser validation: PASS (admin-only edit inbox, badge, real PDF/image previews, explicit review/current choice, ignore, 390px)");
  } finally {
    await browser.close();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
