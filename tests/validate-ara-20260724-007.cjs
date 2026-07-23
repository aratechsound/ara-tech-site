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
const previousPhoneDisplay = ["090", "9418", "9360"].join("-");
const previousPhoneTel = ["090", "9418", "9360"].join("");
const legacySignature = [
    "ARA-TECH SOUND",
    `Email：${forbiddenAddress}`,
    "Web：https://ara-tech.cc/"
].join("\n");
const previousCustomerFooter = [
    "ARA-TECH",
    "",
    `Email：${mail.OFFICIAL_EMAIL}`,
    `緊急連絡先（イベント当日・直前）：${previousPhoneDisplay}`,
    `Web：${mail.SITE_URL}`
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
    const expectedFooter = /\bPA-\d{8}-\d{5}\b/u.test(body)
        ? mail.CUSTOMER_FOOTER_TEXT
        : mail.CUSTOMER_FOOTER_TEXT_WITHOUT_REFERENCE;
    const expectedGuide = expectedFooter === mail.CUSTOMER_FOOTER_TEXT
        ? mail.LINE_GUIDE_WITH_REFERENCE
        : mail.LINE_GUIDE_WITHOUT_REFERENCE;
    assert.equal(count(body, expectedFooter), 1, `${label}: plain footer once`);
    assert.equal(count(body, mail.OFFICIAL_EMAIL), 1, `${label}: official email once`);
    assert.equal(count(body, mail.LINE_ADD_URL), 1, `${label}: plain LINE URL once`);
    assert.equal(count(body, expectedGuide), 1, `${label}: plain LINE guide once`);
    assert.doesNotMatch(body, new RegExp(previousPhoneDisplay, "u"), `${label}: no phone display`);
    assert.doesNotMatch(body, new RegExp(previousPhoneTel, "u"), `${label}: no phone tel`);
    assert.doesNotMatch(body, /<img\b/iu, `${label}: plain body has no image`);
    assert.doesNotMatch(body, /\b(?:undefined|null)\b/iu, `${label}: no missing placeholder`);
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
    assert.equal(count(html, mail.LINE_ADD_URL), 3, `${label}: CTA href plus visible LINE href and text`);
    assert.equal(count(html, mail.LINE_CTA_LABEL), 1, `${label}: LINE CTA label once`);
    assert.equal(count(html, mail.LINE_QR_IMAGE_URL), 1, `${label}: QR image once`);
    assert.equal(count(html, expectedGuide), 1, `${label}: HTML LINE guide once`);
    assert.match(html, /background:#06c755/u, `${label}: LINE green CTA`);
    assert.match(html, /alt="ARA-TECH公式LINE QRコード"/u, `${label}: QR alt`);
    assert.match(html, /width="170" height="170"/u, `${label}: QR display size`);
    assert.match(html, /PCでご覧の場合は、スマートフォンでQRコードを読み取ってください/u, `${label}: PC QR guide`);
    assert.equal(count(html, mail.OFFICIAL_EMAIL), 2, `${label}: one displayed email plus mailto`);
    assert.doesNotMatch(html, /href="tel:/iu, `${label}: no tel link`);
    assert.doesNotMatch(html, new RegExp(previousPhoneDisplay, "u"), `${label}: no phone display`);
    assert.doesNotMatch(html, new RegExp(previousPhoneTel, "u"), `${label}: no phone tel`);
    assert.match(html, /max-width:640px/u, `${label}: desktop max width`);
    assert.match(html, /width:100%/u, `${label}: fluid mobile width`);
    assert.match(html, /overflow-wrap:anywhere/u, `${label}: long content wrapping`);
    assert.doesNotMatch(html, /\b(?:undefined|null)\b/iu, `${label}: no missing placeholder`);
    assert.doesNotMatch(html, new RegExp(forbiddenAddress, "iu"), `${label}: HTML has no legacy address`);
});

const retryAfterEnvironmentUpdate = mail.normalizeCustomerBody([
    "環境変数更新後の再送本文です。",
    "",
    previousCustomerFooter
].join("\n"), previousCustomerFooter);
assert.doesNotMatch(retryAfterEnvironmentUpdate, new RegExp(forbiddenAddress, "iu"));
assert.doesNotMatch(retryAfterEnvironmentUpdate, new RegExp(previousPhoneDisplay, "u"));
assert.equal(count(retryAfterEnvironmentUpdate, mail.CUSTOMER_FOOTER_TEXT_WITHOUT_REFERENCE), 1);
assert.equal(count(retryAfterEnvironmentUpdate, mail.LINE_ADD_URL), 1);

const noReferenceBody = mail.normalizeCustomerBody("受付番号を持たないご案内です。");
assert.match(noReferenceBody, new RegExp(mail.LINE_GUIDE_WITHOUT_REFERENCE));
assert.doesNotMatch(noReferenceBody, /このメールに記載の受付番号/u);
assert.doesNotMatch(noReferenceBody, /\b(?:undefined|null)\b/iu);

const qrFile = path.join(root, "img", "ara-tech-line-official-qr.png");
const qrBytes = fs.readFileSync(qrFile);
assert.equal(mail.LINE_QR_TARGET_URL, "https://lin.ee/XX7Psxw", "QR target URL");
assert.equal(qrBytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "QR asset is PNG");
assert.equal(qrBytes.readUInt32BE(16), 540, "QR source width");
assert.equal(qrBytes.readUInt32BE(20), 540, "QR source height");
assert.equal(
    require("node:crypto").createHash("sha256").update(qrBytes).digest("hex"),
    "b01173a7347a926ece548f20c1e30083b38b45420c79e6c7c8c3aeac70a97bf5",
    "QR asset must remain byte-identical to the supplied image"
);

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
assert.match(mailSource, /src="\$\{LINE_QR_IMAGE_URL\}"/u);
assert.match(mailSource, /href="\$\{LINE_ADD_URL\}"/u);
assert.doesNotMatch(mailSource, /href="tel:/iu);

const adminSource = read("js/pa-admin.js");
assert.match(adminSource, /action: "send_schedule"/u);
assert.match(adminSource, /action: "send_result"/u);
assert.match(adminSource, /action: "retry"/u);
new vm.Script(adminSource.replace(/^import .*$/gmu, ""), { filename: "js/pa-admin.js" });
new vm.Script(read("js/pa-inquiry.js"), { filename: "js/pa-inquiry.js" });

if (previousSignature === undefined) delete process.env.GMAIL_SIGNATURE_TEXT;
else process.env.GMAIL_SIGNATURE_TEXT = previousSignature;

console.log(`ARA-20260724-007 customer email validation passed (${customerTemplates.length} generated paths, no email sent)`);
