const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

const adminHtml = read("pa-admin.html");
const adminCss = read("pa-admin.css");
const adminJs = read("js/pa-admin.js");
const inquiryHtml = read("pa-inquiry.html");
const inquiryJs = read("js/pa-inquiry.js");
const scheduleHtml = read("pa-schedule-confirm.html");
const thanksHtml = read("thanks.html");
const vercel = JSON.parse(read("vercel.json"));
const migration = read("supabase/migrations/2026-07-23-pa-gmail-delivery.sql");
const publicApi = read("api/pa-inquiry.js");
const adminApi = read("api/pa-mail.js");
const mailSource = read("api/_pa-mail.cjs");
const mail = require(path.join(root, "api", "_pa-mail.cjs"));

assert.match(inquiryHtml, /PA予約・お問い合わせフォーム（初回受付）/);
assert.match(inquiryHtml, /予約や日程確保は成立しません/);
assert.match(scheduleHtml, /日程確保フォーム/);
assert.match(scheduleHtml, /条件確認・同意/);
assert.match(scheduleHtml, /専用URLをご案内したお客様だけが使用します/);
assert.match(adminHtml, /PA予約・お問い合わせ内容を確認/);
assert.match(adminHtml, /日程確保フォームURLを発行/);
assert.match(adminHtml, /この内容でGmail送信/);
assert.match(adminHtml, /正式署名は送信時にサーバー側で自動付与/);
assert.doesNotMatch(
    [adminHtml, inquiryHtml, scheduleHtml, thanksHtml, adminJs].join("\n"),
    /第[１２12]フォーム|CASE DETAILS|mailto:|メールアプリで開く|件名をコピー|本文をコピー/
);

assert.match(adminHtml, /id="case-overview"/);
assert.match(adminHtml, /id="next-action-section"/);
assert.match(adminHtml, /id="automatic-mail-status"/);
assert.match(adminHtml, /id="email-history"/);
assert.match(adminHtml, /<details class="detail-section detail-section--technical">/);
assert.match(adminCss, /\.case-overview/);
assert.match(adminCss, /\.workflow-list/);
assert.match(adminCss, /@media \(max-width: 700px\)/);

assert.match(publicApi, /sendAutomaticInquiryEmails/);
assert.match(publicApi, /customer_receipt_status/);
assert.match(adminApi, /verifyAdmin\(bearerToken\(request\)\)/);
assert.match(adminApi, /createScheduleDelivery/);
assert.match(adminJs, /dataset\.confirmationKey/);
assert.match(adminJs, /この宛先へGmail送信を確定/);
assert.doesNotMatch(adminJs, /currentCase\.email\}\s*へ、表示中の内容をARA-TECHのGmailから送信しますか/);
assert.match(mailSource, /process\.env\.GMAIL_CLIENT_ID/);
assert.match(mailSource, /process\.env\.GMAIL_REFRESH_TOKEN/);
assert.match(mailSource, /gmail\.googleapis\.com\/gmail\/v1\/users\/me\/messages\/send/);
assert.match(mailSource, /inquiry\.email/);
assert.doesNotMatch(adminApi, /input\.(?:to|recipient)/);
assert.doesNotMatch(mailSource, /client_secret\s*[:=]\s*["'][^"']+["']/i);
assert.doesNotMatch(mailSource, /refresh_token\s*[:=]\s*["'][^"']+["']/i);

assert.match(migration, /create table if not exists public\.pa_email_deliveries/);
assert.match(migration, /internal_new_inquiry/);
assert.match(migration, /customer_receipt/);
assert.match(migration, /schedule_request/);
assert.match(migration, /unique \(dedupe_key, attempt_number\)/);
assert.match(migration, /pa_email_deliveries_one_success_per_operation/);
assert.match(migration, /enable row level security/);
assert.match(migration, /grant select on public\.pa_email_deliveries to authenticated/);
assert.doesNotMatch(migration, /grant (?:insert|update|delete).*authenticated/i);

assert.match(thanksHtml, /入力されたメールアドレスへ受付確認メールを送信しました/);
assert.match(thanksHtml, /これは予約確定通知ではありません/);
assert.match(inquiryJs, /customer_receipt_status === "sent"/);
assert.match(inquiryJs, /mail=\$\{mailState\}/);

const adminHeaders = vercel.headers.find((entry) => entry.source === "/pa-admin.html");
assert.ok(adminHeaders);
const adminHeaderMap = Object.fromEntries(adminHeaders.headers.map((entry) => [entry.key.toLowerCase(), entry.value]));
assert.match(adminHeaderMap["content-security-policy"], /connect-src 'self' https:\/\/kogbnremsouajxxsgxro\.supabase\.co/);

const templateInquiry = {
    id: "00000000-0000-4000-8000-000000000001",
    inquiry_number: "PA-20260723-99999",
    received_at: "2026-07-23T12:34:00Z",
    contact_name: "検証 太郎",
    customer_name: "検証 太郎",
    email: "owner-test@example.com",
    event_date: "2026-08-31",
    venue: "検証会場",
    request_summary: "検証用の問い合わせ"
};
const receipt = mail.customerReceiptTemplate(templateInquiry, "ARA-TECH\nhttps://ara-tech.cc/");
assert.match(receipt.subject, /PA-20260723-99999/);
assert.match(receipt.body, /2026年8月31日/);
assert.match(receipt.body, /検証会場/);
assert.match(receipt.body, /予約の確定や開催日の確保を保証するものではありません/);
assert.doesNotMatch(receipt.body, /pa-admin|内部ID|token|トークン/);

const internal = mail.internalNotificationTemplate(templateInquiry, "ARA-TECH");
assert.match(internal.body, /owner-test@example\.com/);
assert.match(internal.body, /https:\/\/ara-tech\.cc\/pa-admin\.html/);

const raw = mail.buildRawMessage({
    to: "owner-test@example.com",
    subject: "日本語件名",
    body: "日本語本文",
    config: {
        senderName: "ARA-TECH",
        senderAddress: "sender@example.com",
        replyTo: "reply@example.com"
    }
});
const decoded = Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
assert.match(decoded, /Reply-To: reply@example\.com/);
assert.match(decoded, /日本語本文/);

new vm.Script(adminJs.replace(/^import .*$/gm, ""), { filename: "js/pa-admin.js" });
new vm.Script(inquiryJs, { filename: "js/pa-inquiry.js" });

assert.throws(
    () => mail.buildRawMessage({
        to: "victim@example.com\r\nBcc: third-party@example.com",
        subject: "検証",
        body: "本文",
        config: {
            senderName: "ARA-TECH",
            senderAddress: "sender@example.com",
            replyTo: "reply@example.com"
        }
    }),
    /invalid_header/
);

const validateGmailRequest = async () => {
    const keys = [
        "GMAIL_CLIENT_ID",
        "GMAIL_CLIENT_SECRET",
        "GMAIL_REFRESH_TOKEN",
        "GMAIL_SENDER_ADDRESS",
        "GMAIL_REPLY_TO"
    ];
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    Object.assign(process.env, {
        GMAIL_CLIENT_ID: "test-client",
        GMAIL_CLIENT_SECRET: "test-secret",
        GMAIL_REFRESH_TOKEN: "test-refresh",
        GMAIL_SENDER_ADDRESS: "sender@example.com",
        GMAIL_REPLY_TO: "reply@example.com"
    });
    const calls = [];
    const mockFetch = async (url, options = {}) => {
        calls.push({ url: String(url), options });
        if (calls.length === 1) {
            return { ok: true, json: async () => ({ access_token: "test-access" }) };
        }
        return { ok: true, json: async () => ({ id: "gmail-message-1", threadId: "gmail-thread-1" }) };
    };

    try {
        const result = await mail.sendGmail({
            to: "owner-test@example.com",
            subject: "日本語の検証件名",
            body: "日本語の検証本文"
        }, mockFetch);
        assert.equal(result.id, "gmail-message-1");
        assert.equal(calls.length, 2);
        assert.equal(calls[0].url, "https://oauth2.googleapis.com/token");
        assert.match(String(calls[0].options.body), /grant_type=refresh_token/);
        assert.equal(calls[1].url, "https://gmail.googleapis.com/gmail/v1/users/me/messages/send");
        assert.equal(calls[1].options.headers.authorization, "Bearer test-access");
        const rawPayload = JSON.parse(calls[1].options.body).raw;
        const sentMessage = Buffer.from(rawPayload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
        assert.match(sentMessage, /To: owner-test@example\.com/);
        assert.match(sentMessage, /Reply-To: reply@example\.com/);
        assert.match(sentMessage, /日本語の検証本文/);
        assert.doesNotMatch(sentMessage, /third-party@example\.com/);
    } finally {
        keys.forEach((key) => {
            if (previous[key] === undefined) delete process.env[key];
            else process.env[key] = previous[key];
        });
    }
};

validateGmailRequest()
    .then(() => console.log("ARA-20260723-010 static and Gmail request validation passed"))
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
