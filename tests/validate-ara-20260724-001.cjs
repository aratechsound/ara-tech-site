const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

const adminHtml = read("pa-admin.html");
const adminCss = read("pa-admin.css");
const adminJs = read("js/pa-admin.js");
const scheduleJs = read("js/pa-schedule-confirm.js");
const adminApi = read("api/pa-mail.js");
const responseApi = read("api/pa-schedule-response.js");
const mailSource = read("api/_pa-mail.cjs");
const migration = read("supabase/migrations/2026-07-24-pa-schedule-response-workflow.sql");
const vercelConfig = read("vercel.json");
const mail = require(path.join(root, "api", "_pa-mail.cjs"));

assert.match(scheduleJs, /\/api\/pa-schedule-response/);
assert.doesNotMatch(scheduleJs, /callRpc\("submit_pa_schedule_response"/);
assert.match(vercelConfig, /connect-src 'self' https:\/\/kogbnremsouajxxsgxro\.supabase\.co/);
assert.match(responseApi, /submitScheduleResponseAndNotify/);
assert.doesNotMatch(responseApi, /input\.(?:to\b|recipient\b|notification_address\b)/);

assert.match(adminHtml, /日程を確保できました/);
assert.match(adminHtml, /日程を確保できませんでした/);
assert.match(adminHtml, /id="result-email-subject"/);
assert.match(adminHtml, /id="result-email-body"/);
assert.match(adminHtml, /Gmailから正常に送信された場合だけ/);
assert.match(adminJs, /schedule_adjusting: "日程調整中"/);
assert.match(adminJs, /needs_confirmation: "確認事項あり"/);
assert.match(adminJs, /declined: "見送り"/);
assert.match(adminJs, /schedule_unavailable: "日程確保不可"/);
assert.match(adminJs, /currentResponse\?\.decision === "agree"/);
assert.match(adminJs, /currentResponse\?\.decision === "question"/);
assert.match(adminJs, /currentResponse\?\.decision === "decline"/);
assert.match(adminJs, /searchParams\.get\("case"\)/);
assert.doesNotMatch(adminJs, /searchParams\.get\("inquiry_number"\)/);
assert.doesNotMatch(adminJs, /confirm_pa_schedule/);
assert.match(adminCss, /@media \(max-width: 700px\)/);
assert.match(adminCss, /\.result-actions \.button \{ width: 100%; \}/);

assert.match(adminApi, /action === "send_result"/);
assert.match(adminApi, /delivery\.status === "sent"/);
assert.match(mailSource, /recipient: inquiry\.email/);
assert.match(mailSource, /process\.env\.GMAIL_NOTIFICATION_ADDRESS/);
assert.match(mailSource, /schedule_response_agree_customer/);
assert.match(mailSource, /schedule_response_question_internal/);
assert.match(mailSource, /schedule_response_decline_internal/);
assert.match(mailSource, /schedule_result_confirmed/);
assert.match(mailSource, /schedule_result_unavailable/);
assert.match(mailSource, /ADMIN_URL\}\?case=/);
assert.doesNotMatch(mailSource, /ADMIN_URL\}\?inquiry_number=/);

assert.match(migration, /schedule_adjusting/);
assert.match(migration, /needs_confirmation/);
assert.match(migration, /declined/);
assert.match(migration, /schedule_unavailable/);
assert.match(migration, /derive_pa_schedule_response_status/);
assert.match(migration, /finalize_pa_schedule_result/);
assert.match(migration, /v_delivery\.status <> 'sent'/);
assert.match(migration, /v_delivery\.gmail_message_id is null/);
assert.match(migration, /pa_email_deliveries_one_initial_result_per_case/);
assert.match(migration, /enforce_pa_schedule_result_transition/);
assert.match(migration, /result state requires a sent Gmail delivery/);
assert.match(migration, /revoke all on function public\.confirm_pa_schedule/);
assert.match(migration, /grant execute on function public\.finalize_pa_schedule_result\(uuid, uuid, text\) to service_role/);

new vm.Script(adminJs.replace(/^import .*$/gm, ""), { filename: "js/pa-admin.js" });
new vm.Script(scheduleJs.replace(/^import .*$/gm, ""), { filename: "js/pa-schedule-confirm.js" });

const inquiry = {
    id: "00000000-0000-4000-8000-000000000101",
    inquiry_number: "PA-20260724-90001",
    status: "schedule_adjusting",
    schedule_state: "unconfirmed",
    contact_name: "検証 担当者",
    customer_name: "検証 担当者",
    email: "owner-test@example.com",
    event_date: "2026-09-01",
    venue: "検証会場",
    request_summary: "検証案件"
};
const scheduleResponse = {
    id: "00000000-0000-4000-8000-000000000102",
    inquiry_id: inquiry.id,
    submission_key: "00000000-0000-4000-8000-000000000103",
    submitted_at: "2026-07-24T01:23:45Z",
    decision: "agree",
    question_details: null
};

const agreeTemplates = mail.scheduleResponseTemplates(inquiry, scheduleResponse, "ARA-TECH");
assert.equal(agreeTemplates.length, 2);
assert.equal(agreeTemplates[0].recipient, "owner-test@example.com");
assert.match(agreeTemplates[0].body, /「日程確保完了」の連絡が届くまでは/);
assert.doesNotMatch(agreeTemplates[0].body, /pa-admin|内部ID|token=/i);
assert.match(agreeTemplates[1].body, new RegExp(`pa-admin\\.html\\?case=${inquiry.id}`));

const questionTemplates = mail.scheduleResponseTemplates(
    inquiry,
    { ...scheduleResponse, decision: "question", question_details: "確認したい内容です。" },
    "ARA-TECH"
);
assert.match(questionTemplates[0].body, /ご質問を受け付けました/);
assert.match(questionTemplates[1].body, /確認したい内容です/);

const declineTemplates = mail.scheduleResponseTemplates(
    inquiry,
    { ...scheduleResponse, decision: "decline" },
    "ARA-TECH"
);
assert.match(declineTemplates[0].body, /予約や日程確保が行われることはありません/);

const envKeys = [
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "GMAIL_CLIENT_ID",
    "GMAIL_CLIENT_SECRET",
    "GMAIL_REFRESH_TOKEN",
    "GMAIL_SENDER_ADDRESS",
    "GMAIL_REPLY_TO",
    "GMAIL_SIGNATURE_TEXT"
];
const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
Object.assign(process.env, {
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-test",
    GMAIL_CLIENT_ID: "client-test",
    GMAIL_CLIENT_SECRET: "secret-test",
    GMAIL_REFRESH_TOKEN: "refresh-test",
    GMAIL_SENDER_ADDRESS: "sender@example.com",
    GMAIL_REPLY_TO: "reply@example.com",
    GMAIL_SIGNATURE_TEXT: "ARA-TECH"
});

const resultBody = [
    "検証 担当者 様",
    "",
    "ご希望日の対応日程を確保しました。",
    `受付番号：${inquiry.inquiry_number}`,
    "今後、お見積りについて改めて連絡します。",
    "現段階では、見積承認、契約成立、正式予約完了ではありません。"
].join("\n");

const failureCalls = [];
const failedDelivery = {
    id: "00000000-0000-4000-8000-000000000104",
    inquiry_id: inquiry.id,
    message_type: "schedule_result_confirmed",
    dedupe_key: `schedule-result:${inquiry.id}:confirmed`,
    attempt_number: 1,
    is_retry: false,
    recipient: inquiry.email,
    subject: `【ARA-TECH】日程確保／受付番号${inquiry.inquiry_number}`,
    body: resultBody,
    status: "failed",
    requested_at: "2026-07-24T02:00:00Z",
    sent_at: null,
    failed_at: "2026-07-24T02:00:01Z",
    gmail_message_id: null,
    error_summary: "gmail_oauth_500"
};

const failureFetch = async (url, options = {}) => {
    const target = String(url);
    failureCalls.push({ target, options });
    if (target.includes("/pa_schedule_responses?")) {
        return { ok: true, status: 200, json: async () => [scheduleResponse] };
    }
    if (target.includes("/pa_email_deliveries?") && options.method === "POST") {
        return {
            ok: true,
            status: 201,
            json: async () => [{ ...failedDelivery, status: "sending", failed_at: null, error_summary: null }]
        };
    }
    if (target === "https://oauth2.googleapis.com/token") {
        return { ok: false, status: 500, json: async () => ({}) };
    }
    if (target.includes("/pa_email_deliveries?") && options.method === "PATCH") {
        return { ok: true, status: 200, json: async () => [failedDelivery] };
    }
    throw new Error(`unexpected mock request: ${target}`);
};

const validateFailureAndSuccessPaths = async () => {
    const failed = await mail.sendScheduleResultAndFinalize({
        inquiry,
        result: "confirmed",
        subject: failedDelivery.subject,
        body: resultBody,
        actorUserId: "00000000-0000-4000-8000-000000000105"
    }, failureFetch);
    assert.equal(failed.delivery.status, "failed");
    assert.equal(failed.caseState, null);
    assert.ok(!failureCalls.some(({ target }) => target.includes("/rpc/finalize_pa_schedule_result")));

    const successCalls = [];
    const sentDelivery = {
        ...failedDelivery,
        status: "sent",
        sent_at: "2026-07-24T02:10:00Z",
        failed_at: null,
        gmail_message_id: "gmail-result-message",
        error_summary: null
    };
    const successFetch = async (url, options = {}) => {
        const target = String(url);
        successCalls.push({ target, options });
        if (target.includes("/pa_schedule_responses?")) {
            return { ok: true, status: 200, json: async () => [scheduleResponse] };
        }
        if (target.includes("/pa_email_deliveries?") && options.method === "POST") {
            return {
                ok: true,
                status: 201,
                json: async () => [{ ...sentDelivery, status: "sending", sent_at: null, gmail_message_id: null }]
            };
        }
        if (target === "https://oauth2.googleapis.com/token") {
            return { ok: true, status: 200, json: async () => ({ access_token: "access-test" }) };
        }
        if (target === "https://gmail.googleapis.com/gmail/v1/users/me/messages/send") {
            const raw = JSON.parse(options.body).raw;
            const decoded = Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
            assert.match(decoded, /To: owner-test@example\.com/);
            assert.doesNotMatch(decoded, /third-party@example\.com/);
            return { ok: true, status: 200, json: async () => ({ id: "gmail-result-message" }) };
        }
        if (target.includes("/pa_email_deliveries?") && options.method === "PATCH") {
            return { ok: true, status: 200, json: async () => [sentDelivery] };
        }
        if (target.endsWith("/rest/v1/rpc/finalize_pa_schedule_result")) {
            return {
                ok: true,
                status: 200,
                json: async () => [{
                    result_status: "schedule_confirmed",
                    result_schedule_state: "completed",
                    result_at: sentDelivery.sent_at
                }]
            };
        }
        throw new Error(`unexpected mock request: ${target}`);
    };

    const sent = await mail.sendScheduleResultAndFinalize({
        inquiry,
        result: "confirmed",
        subject: sentDelivery.subject,
        body: resultBody,
        actorUserId: "00000000-0000-4000-8000-000000000105"
    }, successFetch);
    assert.equal(sent.delivery.status, "sent");
    assert.equal(sent.caseState.result_status, "schedule_confirmed");
    assert.equal(
        successCalls.filter(({ target }) => target === "https://gmail.googleapis.com/gmail/v1/users/me/messages/send").length,
        1
    );
    assert.equal(
        successCalls.filter(({ target }) => target.includes("/rpc/finalize_pa_schedule_result")).length,
        1
    );
};

validateFailureAndSuccessPaths()
    .then(() => console.log("ARA-20260724-001 workflow, Gmail and failure-path validation passed"))
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(() => {
        envKeys.forEach((key) => {
            if (previousEnv[key] === undefined) delete process.env[key];
            else process.env[key] = previousEnv[key];
        });
    });
