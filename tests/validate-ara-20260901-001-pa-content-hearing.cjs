const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const mail = require("../api/_pa-mail.cjs");

const root = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const previousEnvironment = Object.fromEntries([
    "GMAIL_CLIENT_ID",
    "GMAIL_CLIENT_SECRET",
    "GMAIL_REFRESH_TOKEN",
    "GMAIL_SENDER_ADDRESS",
    "GMAIL_REPLY_TO",
    "SUPABASE_SERVICE_ROLE_KEY"
].map((key) => [key, process.env[key]]));

Object.assign(process.env, {
    GMAIL_CLIENT_ID: "test-client",
    GMAIL_CLIENT_SECRET: "test-secret",
    GMAIL_REFRESH_TOKEN: "test-refresh",
    GMAIL_SENDER_ADDRESS: mail.OFFICIAL_EMAIL,
    GMAIL_REPLY_TO: mail.OFFICIAL_EMAIL,
    SUPABASE_SERVICE_ROLE_KEY: "test-service-role"
});

const inquiry = {
    id: "00000000-0000-4000-8000-000000000901",
    inquiry_number: "PA-20260901-00901",
    status: "follow_up_pending",
    contact_name: "竹林",
    customer_name: "竹林",
    email: "customer-follow-up@example.com",
    event_date: "2026-10-18",
    venue: "温井ダム堤体横駐車場",
    requested_services: ["PA・音響", "電源・発電機"],
    first_form_data: {
        event_overview: "ダンス、神楽等のステージ音響",
        requested_services: ["PA・音響", "電源・発電機"]
    }
};

const template = mail.contentHearingTemplate(inquiry);
assert.equal(template.subject, "10月18日 温井ダム堤体横駐車場でのPA・音響・電源・発電機について【ARA-TECH】");
assert.match(template.body, /^竹林 様/mu);
assert.match(template.body, /10月18日、温井ダム堤体横駐車場/u);
assert.match(template.body, /PA・音響・電源・発電機/u);
assert.match(template.body, /開催概要：ダンス、神楽等のステージ音響/u);
assert.match(template.body, /開催予定時間/u);
assert.match(template.body, /タイムテーブル/u);
assert.match(template.body, /会場レイアウト/u);
assert.match(template.body, /ご予算/u);
assert.equal(mail.isCustomerMessageType(mail.CONTENT_HEARING_TYPE), true);
assert.throws(
    () => mail.assertContentHearingMessage("件名", "日程確保フォームのURLをご案内します。"),
    /invalid_content_hearing_message/u
);

const sendingDelivery = {
    id: "00000000-0000-4000-8000-000000000902",
    inquiry_id: inquiry.id,
    message_type: mail.CONTENT_HEARING_TYPE,
    dedupe_key: `content-hearing:${inquiry.id}`,
    attempt_number: 1,
    is_retry: false,
    recipient: inquiry.email,
    subject: template.subject,
    body: mail.normalizeCustomerBody(template.body),
    status: "sending",
    requested_at: "2026-09-01T07:00:00.000Z",
    sent_at: null,
    failed_at: null,
    gmail_message_id: null,
    gmail_thread_id: null,
    error_summary: null
};
const sentDelivery = {
    ...sendingDelivery,
    status: "sent",
    sent_at: "2026-09-01T07:01:00.000Z",
    gmail_message_id: "gmail-content-hearing-1",
    gmail_thread_id: "gmail-thread-content-hearing-1"
};
const calls = [];
const fetchMock = async (target, options = {}) => {
    const url = String(target);
    calls.push({ url, method: options.method || "GET", body: options.body || "" });
    if (url.includes("/rest/v1/pa_email_deliveries?") && options.method === "POST") {
        return { ok: true, status: 201, json: async () => [sendingDelivery] };
    }
    if (url === "https://oauth2.googleapis.com/token") {
        return { ok: true, status: 200, json: async () => ({ access_token: "mock-token" }) };
    }
    if (url === "https://gmail.googleapis.com/gmail/v1/users/me/messages/send") {
        return { ok: true, status: 200, json: async () => ({ id: sentDelivery.gmail_message_id, threadId: sentDelivery.gmail_thread_id }) };
    }
    if (url.includes("/rest/v1/pa_email_deliveries?") && options.method === "PATCH") {
        return { ok: true, status: 200, json: async () => [sentDelivery] };
    }
    if (url.endsWith("/rest/v1/rpc/finalize_pa_content_hearing_delivery")) {
        return {
            ok: true,
            status: 200,
            json: async () => [{ result_status: "waiting_customer_reply", result_at: sentDelivery.sent_at }]
        };
    }
    throw new Error(`unexpected request: ${url}`);
};

mail.sendContentHearingAndFinalize({
    inquiry,
    subject: template.subject,
    body: template.body,
    actorUserId: "00000000-0000-4000-8000-000000000903"
}, fetchMock).then((outcome) => {
    assert.equal(outcome.delivery.status, "sent");
    assert.equal(outcome.delivery.gmail_message_id, sentDelivery.gmail_message_id);
    assert.equal(outcome.caseState.result_status, "waiting_customer_reply");
    assert.equal(calls.filter((call) => call.url === "https://gmail.googleapis.com/gmail/v1/users/me/messages/send").length, 1);
    assert.equal(calls.filter((call) => call.url.includes("finalize_pa_content_hearing_delivery")).length, 1);

    const migration = read("supabase/migrations/20260901153000_pa_content_hearing_follow_up.sql");
    assert.match(migration, /'follow_up_pending'/u);
    assert.match(migration, /'waiting_customer_reply'/u);
    assert.match(migration, /'hearing'/u);
    assert.match(migration, /'rough_estimate'/u);
    assert.match(migration, /'customer_intent_confirmed'/u);
    assert.match(migration, /'schedule_coordination'/u);
    assert.match(migration, /content_hearing_follow_up/u);
    assert.match(migration, /v_delivery\.status <> 'sent'/u);
    assert.match(migration, /v_delivery\.gmail_message_id is null/u);
    assert.match(migration, /status = 'waiting_customer_reply'/u);
    assert.match(migration, /schedule form is not allowed before schedule coordination/u);
    assert.doesNotMatch(migration, /PA-20260901-00013/u);

    const inquiryApi = read("api/pa-inquiry.js");
    assert.match(inquiryApi, /status: "follow_up_pending"/u);
    assert.match(inquiryApi, /sendAutomaticInquiryEmails/u);
    assert.doesNotMatch(inquiryApi, /sendContentHearingAndFinalize/u);

    const mailApi = read("api/pa-mail.js");
    assert.match(mailApi, /send_content_hearing: "PA_MAIL_SEND_CONTENT_HEARING"/u);
    assert.match(mailApi, /sendContentHearingAndFinalize/u);
    assert.match(mailApi, /finalizeContentHearingDelivery/u);

    const adminHtml = read("pa-admin.html");
    const adminJs = read("js/pa-admin.js");
    assert.match(adminHtml, /id="content-hearing-section"/u);
    assert.match(adminHtml, /id="preview-content-hearing"/u);
    assert.match(adminHtml, /この内容で送信/u);
    assert.match(adminJs, /お客様へ内容確認メールを送る/u);
    assert.match(adminJs, /action: "send_content_hearing"/u);
    assert.match(adminJs, /日程確保フォームは、調整が必要と判断した後にのみ発行/u);

    console.log("ARA-20260901-001 content-hearing follow-up validation passed (mocked Gmail only; no email sent)");
}).finally(() => {
    Object.entries(previousEnvironment).forEach(([key, value]) => {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    });
}).catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
