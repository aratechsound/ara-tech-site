const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const mail = require(path.join(root, "api", "_pa-mail.cjs"));
const brandTestApi = require(path.join(root, "api", "pa-mail-brand-test.js"));
const endpointSource = fs.readFileSync(path.join(root, "api", "pa-mail-brand-test.js"), "utf8");
const adminHtml = fs.readFileSync(path.join(root, "pa-admin.html"), "utf8");
const adminJs = fs.readFileSync(path.join(root, "js", "pa-admin.js"), "utf8");

const testRecipient = ["tonokun", "gmail.com"].join("@");
const testUser = { id: "00000000-0000-4000-8000-000000000902", email: "admin@example.com" };
const testTime = Date.parse("2026-09-01T12:00:00.000Z");
const environment = {
    ALLOWED_ORIGINS: "https://ara-tech.cc",
    SUPABASE_SERVICE_ROLE_KEY: "brand-test-hmac-secret"
};

const responseRecorder = () => ({
    headers: {},
    statusCode: null,
    payload: null,
    setHeader(key, value) { this.headers[String(key).toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; }
});

const requestFor = (body, headers = {}) => ({
    method: "POST",
    body,
    headers: {
        origin: "https://ara-tech.cc",
        authorization: "Bearer test-admin-token",
        ...headers
    }
});

const template = mail.brandEmailTestTemplate();
assert.equal(template.recipient, testRecipient, "server-side allowlisted recipient");
assert.equal(template.subject, "【ARA-TECH】顧客向けメール共通テンプレート表示テスト");
assert.equal(template.messageType, mail.BRAND_EMAIL_TEST_TYPE);
assert.equal(mail.isCustomerMessageType(template.messageType), true, "shared customer renderer type");
const html = mail.buildCustomerHtml(template.body);
assert.match(html, new RegExp(mail.CUSTOMER_HEADER_LOGO_URL.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
assert.match(html, new RegExp(mail.CUSTOMER_FOOTER_LOGO_URL.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
assert.match(html, new RegExp(`background:${mail.CUSTOMER_HEADER_BLUE}`));
assert.match(html, new RegExp(mail.LINE_ADD_URL.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
assert.match(html, new RegExp(mail.LINE_QR_IMAGE_URL.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));

assert.match(adminHtml, /id="brand-mail-test"/u);
assert.match(adminHtml, /id="preview-brand-mail-test"/u);
assert.match(adminHtml, /id="send-brand-mail-test"/u);
assert.match(adminHtml, /id="brand-mail-test-frame"/u);
assert.match(adminJs, /\/api\/pa-mail-brand-test/u);
assert.match(adminJs, /window\.confirm\(/u);
assert.match(adminJs, /confirmation_token/u);
assert.doesNotMatch(endpointSource, /pa_inquiries|pa_case_progress|pa_email_deliveries|createAndDeliver|createScheduleDelivery/iu);
assert.doesNotMatch(endpointSource, /input\.(?:to|recipient|subject|body)/u);

const gmailCalls = [];
const handler = brandTestApi.createHandler({
    verifyAdminImpl: async (token) => {
        assert.equal(token, "test-admin-token");
        return testUser;
    },
    sendGmailImpl: async (input) => {
        gmailCalls.push(input);
        return { id: "gmail-brand-test-001", threadId: "thread-brand-test-001" };
    },
    now: () => testTime,
    environment
});

const run = async () => {
    const previewResponse = responseRecorder();
    await handler(requestFor({ action: "preview" }), previewResponse);
    assert.equal(previewResponse.statusCode, 200);
    assert.equal(previewResponse.payload.ok, true);
    assert.equal(previewResponse.payload.pa_database_mutations, 0);
    assert.equal(previewResponse.payload.preview.recipient, testRecipient);
    assert.equal(previewResponse.payload.preview.subject, template.subject);
    assert.equal(previewResponse.payload.preview.html, html, "preview reuses the shared renderer output");
    assert.match(previewResponse.payload.preview.confirmation_token, /\./u);
    assert.equal(gmailCalls.length, 0, "preview never sends");

    const invalidSendResponse = responseRecorder();
    await handler(requestFor({ action: "send", confirmation_token: "not-a-valid-token" }), invalidSendResponse);
    assert.equal(invalidSendResponse.statusCode, 400);
    assert.equal(invalidSendResponse.payload.code, "invalid_confirmation");
    assert.equal(gmailCalls.length, 0, "invalid confirmation never sends");

    const sendResponse = responseRecorder();
    await handler(requestFor({ action: "send", confirmation_token: previewResponse.payload.preview.confirmation_token }), sendResponse);
    assert.equal(sendResponse.statusCode, 200);
    assert.equal(sendResponse.payload.ok, true);
    assert.equal(sendResponse.payload.pa_database_mutations, 0);
    assert.equal(sendResponse.payload.delivery.from, mail.OFFICIAL_EMAIL);
    assert.equal(sendResponse.payload.delivery.to, testRecipient);
    assert.equal(sendResponse.payload.delivery.subject, template.subject);
    assert.equal(sendResponse.payload.delivery.gmail_message_id, "gmail-brand-test-001");
    assert.equal(gmailCalls.length, 1, "exactly one mocked Gmail send");
    assert.deepEqual(gmailCalls[0], {
        to: testRecipient,
        subject: template.subject,
        body: template.body,
        messageType: mail.BRAND_EMAIL_TEST_TYPE
    });

    const methodResponse = responseRecorder();
    await handler({ method: "GET", headers: {} }, methodResponse);
    assert.equal(methodResponse.statusCode, 405);
    assert.equal(methodResponse.headers.allow, "POST");

    const forbiddenOriginResponse = responseRecorder();
    await handler(requestFor({ action: "preview" }, { origin: "https://attacker.example" }), forbiddenOriginResponse);
    assert.equal(forbiddenOriginResponse.statusCode, 403);
    assert.equal(gmailCalls.length, 1, "forbidden origin never sends");
};

run()
    .then(() => console.log("ARA-20260901-002 admin-only brand email E2E endpoint validation passed (mocked Gmail only; no email sent)"))
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
