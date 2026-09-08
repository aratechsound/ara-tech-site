const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require("playwright");

const root = path.resolve(__dirname, "../..");
const client = fs.readFileSync(path.join(root, "js", "pa-admin.js"), "utf8");
const css = fs.readFileSync(path.join(root, "pa-admin.css"), "utf8");
const extract = (name) => {
    const match = client.match(new RegExp(`^const ${name} = [\\s\\S]*?(?=^const |$(?![\\s\\S]))`, "m"));
    assert(match, `missing client function: ${name}`);
    return match[0];
};

const script = `
const $ = (selector) => document.querySelector(selector);
const emailHistory = $("#gmail-timeline");
const gmailReplyPanel = $("#gmail-reply-panel");
let currentCase = { id: "case-synthetic" };
let currentDeliveries = [];
let currentMailAttention = "new_customer_reply";
let gmailReplyPreview = null;
let gmailReplyPreviewBinding = null;
let gmailReplyAttachments = [];
let gmailReplyMode = "normal";
let gmailReplySource = null;
const GMAIL_OFFICIAL_ADDRESS = "aratechsound@gmail.com";
const currentGmailTimeline = [
  { id: "inbound-a", thread_id: "thread-a", direction: "inbound", source: "gmail_received", from_address: "from-a@example.invalid", reply_to: "reply-a@example.invalid", subject: "RE: Target subject", occurred_at: "2026-09-08T01:00:00Z", body_text: "Synthetic inbound A", attachments: [] },
  { id: "outbound", thread_id: "thread-a", direction: "outbound", source: "pa_case_manager", from_address: "aratechsound@gmail.com", subject: "Re: Target subject", occurred_at: "2026-09-08T02:00:00Z", body_text: "Synthetic sent", attachments: [] },
  { id: "inbound-b", thread_id: "thread-a", direction: "inbound", source: "gmail_received", from_address: "from-b@example.invalid", reply_to: "", subject: "ABC", occurred_at: "2026-09-08T03:00:00Z", body_text: "Synthetic inbound B", attachments: [] }
];
const formatDateTime = (value) => value;
const isSafeAttachmentPreviewType = () => false;
const appendSanitizedEmailHtml = () => false;
const renderOverview = () => {};
const setMessage = (element, text, type = "info") => { element.textContent = text; element.dataset.type = type; element.classList.remove("hidden"); };
const gmailErrorMessage = (code) => code;
const gmailReplyAttachmentPayload = async () => [];
const renderGmailReplyPreviewAttachments = () => {};
const callGmailApi = async (request) => {
  window.lastPreviewRequest = request;
  return { preview: {
    inquiry_id: request.inquiry_id,
    gmail_thread_id: request.reply_source_thread_id || "thread-a",
    reply_source_explicit: Boolean(request.reply_source_message_id),
    reply_source_message_id: request.reply_source_message_id || "inbound-b",
    recipient: $("#gmail-reply-recipient").value,
    subject: $("#gmail-reply-subject").value,
    body: request.body + "\\n\\nARA-TECH",
    html: "<p>" + request.body + "</p><p>ARA-TECH</p>",
    mode: request.mode,
    attachments: [],
    confirmation_token: "synthetic-token"
  } };
};
${extract("invalidateGmailReplyPreview")}
${extract("isEstimateSubmissionMode")}
${extract("gmailReplyRecipientForMessage")}
${extract("gmailReplySubjectForMessage")}
${extract("setGmailReplyMode")}
${extract("openGmailReply")}
${extract("renderGmailReplyAttachments")}
${extract("renderEmailHistory")}
${extract("previewGmailReply")}
renderGmailReplyAttachments();
renderEmailHistory();
$("#preview-gmail-reply").addEventListener("click", previewGmailReply);
$("#gmail-reply-body").addEventListener("input", invalidateGmailReplyPreview);
`;

const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head>
<body><main class="admin-shell"><section class="subsection"><div class="action-panel"><h4>最近のやり取り</h4><div id="gmail-timeline" class="mail-history"></div></div>
<div id="gmail-reply-panel" class="action-panel hidden"><h4 id="gmail-reply-title">Gmailで返信</h4><p id="gmail-reply-mode-note" class="small-note"></p>
<div class="field"><label for="gmail-reply-recipient">To</label><input id="gmail-reply-recipient" type="email" readonly></div>
<div class="field"><label for="gmail-reply-subject">件名</label><input id="gmail-reply-subject" readonly></div>
<div class="field"><label for="gmail-reply-body">本文</label><textarea id="gmail-reply-body" class="email-body"></textarea></div>
<input id="gmail-reply-attachments-input" type="file" multiple><ul id="gmail-reply-attachments"></ul>
<button id="preview-gmail-reply" class="button button--secondary" type="button">プレビュー</button><button id="send-gmail-reply" class="button" type="button" disabled>最終確認後にGmail送信</button>
<div id="gmail-reply-preview" class="mail-preview hidden"><span id="gmail-reply-preview-recipient"></span><span id="gmail-reply-preview-subject"></span><div id="gmail-reply-preview-body"></div><iframe id="gmail-reply-preview-frame" hidden></iframe></div>
<p id="gmail-reply-message" class="alert hidden"></p></div></section></main><script>${script}</script></body></html>`;

(async () => {
    const server = http.createServer((request, response) => {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        response.end(html);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const launchOptions = { headless: true, args: ["--disable-extensions", "--no-first-run"] };
    if (process.env.PA_CHROME_EXECUTABLE) launchOptions.executablePath = process.env.PA_CHROME_EXECUTABLE;
    const browser = await chromium.launch(launchOptions);
    try {
        const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
        await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: "load" });
        const articles = page.locator("#gmail-timeline article");
        assert.equal(await articles.count(), 3);
        assert.equal(await articles.nth(0).getByRole("button", { name: "このメールに返信", exact: true }).count(), 1);
        assert.equal(await articles.nth(1).getByRole("button", { name: "このメールに返信", exact: true }).count(), 0);
        assert.equal(await articles.nth(2).getByRole("button", { name: "このメールに返信", exact: true }).count(), 1);

        await articles.nth(0).getByRole("button", { name: "このメールに返信", exact: true }).click();
        assert.equal(await page.locator("#gmail-reply-recipient").inputValue(), "reply-a@example.invalid");
        assert.equal(await page.locator("#gmail-reply-subject").inputValue(), "RE: Target subject");
        assert.equal(await page.locator("#gmail-reply-body").inputValue(), "");
        assert.equal(await page.locator("#gmail-reply-title").innerText(), "このメールに返信");

        await page.locator("#gmail-reply-body").fill("Synthetic reply body");
        await page.locator("#preview-gmail-reply").click();
        await page.locator("#gmail-reply-preview").waitFor({ state: "visible" });
        assert.equal(await page.locator("#send-gmail-reply").isEnabled(), true);
        assert.deepEqual(await page.evaluate(() => ({
            message: window.lastPreviewRequest.reply_source_message_id,
            thread: window.lastPreviewRequest.reply_source_thread_id,
            caseId: window.lastPreviewRequest.inquiry_id
        })), { message: "inbound-a", thread: "thread-a", caseId: "case-synthetic" });

        page.once("dialog", (dialog) => dialog.dismiss());
        await articles.nth(2).getByRole("button", { name: "このメールに返信", exact: true }).click();
        assert.equal(await page.locator("#gmail-reply-body").inputValue(), "Synthetic reply body");
        assert.equal(await page.locator("#gmail-reply-recipient").inputValue(), "reply-a@example.invalid");

        await page.setViewportSize({ width: 390, height: 844 });
        const metrics = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
        assert.equal(metrics.width, 390);
        assert(metrics.scrollWidth <= 390, `horizontal overflow: ${metrics.scrollWidth}`);
        assert.equal(await page.locator("#gmail-timeline").textContent().then((text) => text.includes("Synthetic inbound A")), true);
        assert.equal(await page.locator("#send-gmail-reply").isEnabled(), true);
        console.log("PA inbound direct reply browser validation: PASS; desktop + 390px; preview only; send not pressed");
    } finally {
        await browser.close();
        await new Promise((resolve) => server.close(resolve));
    }
})().catch((error) => { console.error(error.stack); process.exitCode = 1; });
