const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const mail = require("../api/_pa-mail.cjs");

const root = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const count = (value, needle) => String(value).split(needle).length - 1;
const decodeRaw = (raw) => Buffer.from(
    raw.replace(/-/gu, "+").replace(/_/gu, "/"),
    "base64"
).toString("utf8");
const forbiddenAddress = ["tonokun", "gmail.com"].join("@");
const legacySignature = [
    "ARA-TECH SOUND",
    `Email：${forbiddenAddress}`,
    "Web：https://ara-tech.cc/"
].join("\n");

const walkTextFiles = (directory) => fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if ([".git", "node_modules", "img"].includes(entry.name)) return [];
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return walkTextFiles(target);
    return /\.(?:cjs|js|json|html|css|md|sql|txt)$/iu.test(entry.name) ? [target] : [];
});

walkTextFiles(root).forEach((file) => {
    assert.doesNotMatch(
        fs.readFileSync(file, "utf8"),
        new RegExp(forbiddenAddress.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "iu"),
        `legacy customer address must not remain in ${path.relative(root, file)}`
    );
});

const previousSignature = process.env.GMAIL_SIGNATURE_TEXT;
process.env.GMAIL_SIGNATURE_TEXT = legacySignature;

const inquiry = {
    id: "00000000-0000-4000-8000-000000000701",
    inquiry_number: "PA-20260724-00701",
    received_at: "2026-07-24T01:23:45Z",
    contact_name: "表示検証 担当者",
    customer_name: "表示検証",
    email: "customer-preview@example.com",
    event_date: "2026-08-31",
    venue: "表示検証会場",
    request_summary: "連絡先フッター表示検証"
};
const response = {
    id: "00000000-0000-4000-8000-000000000702",
    inquiry_id: inquiry.id,
    submission_key: "00000000-0000-4000-8000-000000000703",
    submitted_at: "2026-07-24T02:34:56Z",
    decision: "agree",
    question_details: null
};
const scheduleUrl = `https://ara-tech.cc/pa-schedule-confirm.html?token=${"a".repeat(43)}`;

const customerTemplates = [
    {
        label: "新規問い合わせ・予約受付確認",
        messageType: "customer_receipt",
        ...mail.customerReceiptTemplate(inquiry)
    },
    ...["agree", "question", "decline"].map((decision) => {
        const template = mail.scheduleResponseTemplates(
            inquiry,
            {
                ...response,
                decision,
                question_details: decision === "question" ? "確認したい内容です。" : null
            },
            legacySignature
        )[0];
        return {
            label: `日程確保フォーム回答受付（${decision}）`,
            messageType: template.message_type,
            ...template
        };
    }),
    {
        label: "日程確保フォーム案内・管理画面送信",
        messageType: "schedule_request",
        subject: `【ARA-TECH】開催日程についてのご確認／受付番号${inquiry.inquiry_number}`,
        body: mail.normalizeCustomerBody([
            "表示検証 担当者 様",
            "",
            "日程確保フォームをご確認ください。",
            scheduleUrl
        ].join("\n"), legacySignature)
    },
    {
        label: "日程確保完了",
        messageType: "schedule_result_confirmed",
        subject: `【ARA-TECH】ご希望日の対応日程を確保しました／受付番号${inquiry.inquiry_number}`,
        body: mail.normalizeCustomerBody([
            "表示検証 担当者 様",
            "",
            "ご希望日の対応日程を確保しました。",
            `受付番号：${inquiry.inquiry_number}`,
            "今後、お見積り、契約、正式予約について改めてご連絡します。"
        ].join("\n"), legacySignature)
    },
    {
        label: "日程確保不可",
        messageType: "schedule_result_unavailable",
        subject: `【ARA-TECH】ご希望日の対応日程について／受付番号${inquiry.inquiry_number}`,
        body: mail.normalizeCustomerBody([
            "表示検証 担当者 様",
            "",
            "ご希望日の対応日程を確保できませんでした。",
            `受付番号：${inquiry.inquiry_number}`
        ].join("\n"), legacySignature)
    },
    {
        label: "再送",
        messageType: "schedule_request",
        subject: `【ARA-TECH】再送／受付番号${inquiry.inquiry_number}`,
        body: mail.normalizeCustomerBody([
            "表示検証 担当者 様",
            "",
            "再送経路の本文です。",
            scheduleUrl,
            "",
            legacySignature
        ].join("\n"), legacySignature)
    }
];

customerTemplates.forEach(({ label, messageType, subject, body }) => {
    assert.equal(mail.isCustomerMessageType(messageType), true, `${label}: customer type`);
    assert.equal(count(body, mail.CUSTOMER_FOOTER_TEXT), 1, `${label}: plain footer once`);
    assert.equal(count(body, mail.OFFICIAL_EMAIL), 1, `${label}: official email once`);
    assert.equal(count(body, mail.EMERGENCY_PHONE_DISPLAY), 1, `${label}: emergency phone once`);
    assert.doesNotMatch(body, new RegExp(forbiddenAddress, "iu"), `${label}: no legacy address`);

    const raw = mail.buildRawMessage({
        to: inquiry.email,
        subject,
        body,
        messageType,
        config: {
            senderName: "ARA-TECH",
            senderAddress: mail.OFFICIAL_EMAIL,
            replyTo: forbiddenAddress,
            signature: legacySignature
        }
    });
    const decoded = decodeRaw(raw);
    assert.match(decoded, new RegExp(`From: .+ <${mail.OFFICIAL_EMAIL}>`), `${label}: From`);
    assert.match(decoded, new RegExp(`Reply-To: ${mail.OFFICIAL_EMAIL}`), `${label}: Reply-To`);
    assert.match(decoded, /Content-Type: multipart\/alternative;/u, `${label}: multipart`);
    assert.match(decoded, /Content-Type: text\/plain; charset=UTF-8/u, `${label}: plain part`);
    assert.match(decoded, /Content-Type: text\/html; charset=UTF-8/u, `${label}: html part`);
    assert.doesNotMatch(decoded, new RegExp(forbiddenAddress, "iu"), `${label}: raw has no legacy address`);

    const htmlPartMatch = decoded.match(
        /Content-Type: text\/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n([\s\S]+?)\r\n--ara-tech-/u
    );
    assert.ok(htmlPartMatch, `${label}: HTML MIME part`);
    const html = Buffer.from(htmlPartMatch[1].replace(/\s/gu, ""), "base64").toString("utf8");
    assert.match(html, new RegExp(`mailto:${mail.OFFICIAL_EMAIL}`), `${label}: mailto`);
    assert.match(html, new RegExp(`tel:${mail.EMERGENCY_PHONE_TEL}`), `${label}: tel`);
    assert.equal(count(html, mail.OFFICIAL_EMAIL), 2, `${label}: one displayed email plus mailto`);
    assert.equal(count(html, mail.EMERGENCY_PHONE_DISPLAY), 1, `${label}: one displayed phone`);
    assert.equal(count(html, `tel:${mail.EMERGENCY_PHONE_TEL}`), 1, `${label}: one tel link`);
    assert.match(html, /max-width:640px/u, `${label}: desktop max width`);
    assert.match(html, /width:100%/u, `${label}: fluid mobile width`);
    assert.match(html, /overflow-wrap:anywhere/u, `${label}: long content wrapping`);
    assert.doesNotMatch(html, new RegExp(forbiddenAddress, "iu"), `${label}: HTML has no legacy address`);
});

const retryAfterEnvironmentUpdate = mail.normalizeCustomerBody([
    "環境変数更新後の再送本文です。",
    "",
    legacySignature
].join("\n"), mail.CUSTOMER_FOOTER_TEXT);
assert.doesNotMatch(retryAfterEnvironmentUpdate, new RegExp(forbiddenAddress, "iu"));
assert.equal(count(retryAfterEnvironmentUpdate, mail.CUSTOMER_FOOTER_TEXT), 1);

const internalRaw = decodeRaw(mail.buildRawMessage({
    to: "internal@example.com",
    subject: "内部通知",
    body: "内部通知本文",
    messageType: "internal_new_inquiry",
    config: {
        senderName: "ARA-TECH",
        senderAddress: "internal-sender@example.com",
        replyTo: "internal-reply@example.com",
        signature: legacySignature
    }
}));
assert.match(internalRaw, /From: .+ <internal-sender@example\.com>/u);
assert.match(internalRaw, /Reply-To: internal-reply@example\.com/u);
assert.match(internalRaw, /Content-Type: text\/plain; charset=UTF-8/u);
assert.doesNotMatch(internalRaw, /multipart\/alternative/u);

const mailSource = read("api/_pa-mail.cjs");
assert.match(mailSource, /recipient: notificationAddress/u);
assert.match(mailSource, /process\.env\.GMAIL_NOTIFICATION_ADDRESS/u);
assert.match(mailSource, /messageType: row\.message_type/u);
assert.match(mailSource, /const body = isCustomerMessageType\(delivery\.message_type\)/u);
assert.match(mailSource, /body: previous\.body/u);
assert.match(mailSource, /normalizeCustomerBody\(delivery\.body\)/u);
assert.match(mailSource, /mailto:\$\{OFFICIAL_EMAIL\}/u);
assert.match(mailSource, /tel:\$\{EMERGENCY_PHONE_TEL\}/u);

const adminSource = read("js/pa-admin.js");
assert.match(adminSource, /action: "send_schedule"/u);
assert.match(adminSource, /action: "send_result"/u);
assert.match(adminSource, /action: "retry"/u);
new vm.Script(adminSource.replace(/^import .*$/gmu, ""), { filename: "js/pa-admin.js" });
new vm.Script(read("js/pa-inquiry.js"), { filename: "js/pa-inquiry.js" });

if (previousSignature === undefined) delete process.env.GMAIL_SIGNATURE_TEXT;
else process.env.GMAIL_SIGNATURE_TEXT = previousSignature;

console.log(`ARA-20260724-007 customer email validation passed (${customerTemplates.length} generated paths, no email sent)`);
