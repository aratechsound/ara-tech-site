const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const filename = require(path.join(root, "api", "_pa-filename.cjs"));
const mail = require(path.join(root, "api", "_pa-mail.cjs"));
const gmail = require(path.join(root, "api", "_pa-gmail.cjs"));
const portal = require(path.join(root, "api", "_pa-portal.cjs"));

const filenames = [
    "見積書 2026.10.18 龍姫湖まつり.pdf",
    "音響・電源配置図.pdf",
    "タイムテーブル（改訂版）.pdf",
    "spaces and (parentheses).pdf",
    "日本語、句読点。と spaces.pdf"
];
const attachments = filenames.map((name, index) => ({
    filename: name,
    mime_type: "application/pdf",
    data: Buffer.from(`%PDF-r10-${index}`, "utf8").toString("base64url")
}));
assert.deepEqual(mail.normalizeReplyAttachments(attachments).map((item) => item.filename), filenames);
assert.equal(portal.safeFilename("タイムテーブル（改訂版）.pdf"), "タイムテーブル（改訂版）.pdf");
assert.equal(portal.safeFilename("見積書  2026.pdf"), "見積書  2026.pdf", "original spacing is not normalized away");
assert.equal(filename.safeOriginalFilename("../見積\0書\\原本.pdf"), ".._見積_書_原本.pdf", "path separators and controls cannot form storage paths");

const raw = Buffer.from(mail.buildRawMessage({
    to: "recipient@example.test",
    subject: "R10 Unicode filenames",
    body: "Local fixture",
    messageType: "customer_receipt",
    attachments,
    config: { senderAddress: "sender@example.test", senderName: "ARA-TECH", replyTo: "sender@example.test", signature: "ARA-TECH" }
}), "base64url").toString("utf8");
const dispositionHeaders = raw.match(/^Content-Disposition: attachment;[\s\S]*?(?=\r\n\r\n)/gmu) || [];
assert.equal(dispositionHeaders.length, filenames.length);
assert.deepEqual(dispositionHeaders.map((header) => filename.decodedParameter(header, "filename")), filenames, "RFC 2231 MIME names round-trip");
assert.equal(dispositionHeaders.every((header) => /^[\x00-\x7f]*$/u.test(header)), true, "MIME filename headers remain 7-bit clean");
assert.equal(raw.split("\r\n").filter((line) => /(?:filename|name)\*/iu.test(line)).every((line) => line.length <= 78), true, "long parameters are folded");

const data = Buffer.from("%PDF-filename-variants", "utf8").toString("base64url");
const encodedWord = `=?UTF-8?B?${Buffer.from("音響・電源配置図.pdf").toString("base64")}?=`;
const message = {
    id: "filename_message",
    threadId: "filename_thread",
    internalDate: String(Date.parse("2026-09-13T00:00:00Z")),
    payload: {
        mimeType: "multipart/mixed",
        headers: [{ name: "From", value: "aratechsound@gmail.com" }, { name: "To", value: "customer@example.test" }],
        parts: [
            { partId: "1", filename: "Gmail API 日本語優先.pdf", mimeType: "application/pdf", headers: [{ name: "Content-Disposition", value: "attachment; filename*=UTF-8''%E5%88%A5%E5%90%8D.pdf" }], body: { data } },
            { partId: "2", filename: "____.pdf", mimeType: "application/pdf", headers: [{ name: "Content-Disposition", value: "attachment; filename*=UTF-8''%E8%A6%8B%E7%A9%8D%E6%9B%B8%202026.10.18%20%E9%BE%8D%E5%A7%AB%E6%B9%96%E3%81%BE%E3%81%A4%E3%82%8A.pdf" }], body: { data } },
            { partId: "3", filename: "", mimeType: "application/pdf", headers: [{ name: "Content-Disposition", value: `attachment; filename="${encodedWord}"` }], body: { data } },
            { partId: "4", filename: "ascii-estimate.pdf", mimeType: "application/pdf", body: { data } },
            { partId: "5", filename: "", mimeType: "application/pdf", headers: [{ name: "Content-Disposition", value: "attachment; filename*=UTF-8''%E3%ZZbroken.pdf" }], body: { data } },
            { partId: "6", filename: "compatibility-name.pdf", mimeType: "application/pdf", headers: [{ name: "Content-Disposition", value: "attachment; filename*=UTF-8''%E6%AD%A3%E5%BC%8F%E8%A6%8B%E7%A9%8D%E6%9B%B8.pdf" }], body: { data } }
        ]
    }
};
const parsed = gmail.normalizeMessage(message).attachments.map((item) => item.filename);
assert.equal(parsed[0], "Gmail API 日本語優先.pdf", "decoded Gmail API Unicode filename has priority");
assert.equal(parsed[1], "見積書 2026.10.18 龍姫湖まつり.pdf", "filename* restores a mangled ASCII fallback");
assert.equal(parsed[2], "音響・電源配置図.pdf", "RFC 2047 encoded-word is decoded");
assert.equal(parsed[3], "ascii-estimate.pdf");
assert.ok(parsed[4], "malformed encoding falls back without aborting message ingestion");
assert.equal(parsed[5], "正式見積書.pdf", "decoded Unicode MIME filename replaces an ASCII compatibility name");

const disposition = gmail.attachmentContentDisposition("タイムテーブル（改訂版）.pdf");
assert.match(disposition, /^attachment; filename(?:\*|\*0\*)=UTF-8''/u);
assert.equal(filename.decodedParameter(disposition, "filename"), "タイムテーブル（改訂版）.pdf");
assert.equal(disposition.includes("____"), false, "download header never exposes an underscore-only Unicode substitute");

const restored = gmail.restoreManagedOriginalFilenames({ attachments: [
    { id: "one", filename: "____.pdf" }, { id: "two", filename: "____.pdf" }
] }, ["見積書.pdf", "タイムテーブル（改訂版）.pdf"]);
assert.deepEqual(restored.attachments.map((item) => item.original_filename), ["見積書.pdf", "タイムテーブル（改訂版）.pdf"]);

const portalSource = fs.readFileSync(path.join(root, "api", "_pa-portal.cjs"), "utf8");
const organizerSource = fs.readFileSync(path.join(root, "api", "_pa-portal-organizer.cjs"), "utf8");
assert.doesNotMatch(portalSource, /storagePath\s*=.*upload\.filename/u);
assert.doesNotMatch(organizerSource, /storagePath\s*=.*upload\.filename/u);
console.log("PASS PA-EST-004R10 filenames: Unicode model/display/download/Gmail MIME, MIME variants, safe fallback, storage-key separation");
