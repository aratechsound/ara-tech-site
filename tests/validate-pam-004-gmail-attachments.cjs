const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const gmail = require(path.join(root, "api", "_pa-gmail.cjs"));
const client = fs.readFileSync(path.join(root, "js", "pa-admin.js"), "utf8");
const service = fs.readFileSync(path.join(root, "api", "_pa-gmail.cjs"), "utf8");
const css = fs.readFileSync(path.join(root, "pa-admin.css"), "utf8");
const base64Url = (value) => Buffer.from(value, "utf8").toString("base64url");

const nestedMessage = gmail.normalizeMessage({
    id: "mail_123",
    threadId: "thread_123",
    internalDate: "1788278400000",
    payload: {
        headers: [{ name: "From", value: "customer@example.com" }],
        mimeType: "multipart/mixed",
        parts: [
            {
                mimeType: "multipart/alternative",
                parts: [{ mimeType: "text/plain", body: { data: base64Url("本文") } }]
            },
            {
                partId: "0.1",
                filename: "日本語資料.pdf",
                mimeType: "application/pdf",
                body: { data: base64Url("inline pdf"), size: 10 }
            },
            {
                mimeType: "multipart/mixed",
                parts: [{
                    partId: "0.2",
                    filename: "../../evil.svg",
                    mimeType: "image/svg+xml",
                    body: { attachmentId: "attachment_456", size: 20 }
                }]
            }
        ]
    }
});

assert.equal(nestedMessage.attachments.length, 2, "nested MIME and inline body.data attachments must both be indexed");
assert.deepEqual(nestedMessage.attachments.map((attachment) => attachment.id), ["0.1", "attachment_456"]);
assert.equal(nestedMessage.attachments[0].filename, "日本語資料.pdf");
assert.equal(nestedMessage.attachments[1].filename, ".._.._evil.svg", "untrusted path separators must never survive the filename");
assert.match(nestedMessage.body_text, /本文/u, "multipart/alternative text must still be parsed");
assert.equal(gmail.validGmailAttachmentReference("0.1"), true);
assert.equal(gmail.validGmailAttachmentReference("../../evil"), false);
assert.equal(gmail.safeAttachmentFilename("..\\..\\evil.exe"), ".._.._evil.exe");

assert.match(service, /attachment_metadata/u, "the exact indexed attachment identity must be required before retrieval");
assert.match(service, /part\.body\.attachmentId\s*\?/u, "attachmentId data must use the Gmail attachment endpoint");
assert.match(service, /:\s*part\.body;/u, "inline body.data attachments must not require a second Gmail fetch");
assert.match(service, /safeAttachmentFilename/u);
assert.match(service, /streamAttachmentResponse/u);
assert.match(service, /response\.write\(bytes\.subarray/u, "binary data must be written in response chunks");
assert.doesNotMatch(service, /writeRow\("pa_gmail_attachments"/u, "retrieval must not create duplicate attachment rows");

assert.match(client, /gmailAttachmentFetches/u);
assert.match(client, /取得中…/u);
assert.match(client, /このメールには添付ファイルがありません/u);
assert.match(client, /添付ファイルの取得に失敗しました/u);
assert.match(client, /attachment_download/u);
assert.match(client, /downloadGmailAttachmentStream/u);
assert.match(client, /URL\.createObjectURL/u);
assert.match(client, /URL\.revokeObjectURL\(url\), 60_000/u);
assert.match(client, /isSafeAttachmentPreviewType/u, "only explicitly allowlisted MIME types may be previewed");
assert.doesNotMatch(client.match(/const isSafeAttachmentPreviewType[^;]+;/u)[0], /svg/u, "SVG must not be previewable");
assert.match(client, /gmailAttachmentPreviewUrls\.forEach\(\(url\) => URL\.revokeObjectURL\(url\)\)/u, "case changes must revoke preview Blob URLs");
assert.match(client, /preview\.opener = null/u, "safe previews must not retain an opener");
assert.match(css, /\.gmail-attachment__filename \{[^}]*overflow-wrap: anywhere;/u);
assert.match(css, /\.gmail-attachment \{ align-items: flex-start; flex-direction: column;/u);

(async () => {
    Object.assign(process.env, {
        GMAIL_CLIENT_ID: "test-client",
        GMAIL_CLIENT_SECRET: "test-secret",
        GMAIL_REFRESH_TOKEN: "test-refresh",
        GMAIL_SENDER_ADDRESS: "sender@example.com",
        GMAIL_REPLY_TO: "sender@example.com",
        SUPABASE_SERVICE_ROLE_KEY: "test-service-key"
    });
    const calls = [];
    const jsonResponse = (payload) => ({ ok: true, status: 200, json: async () => payload });
    const inlineAttachment = await gmail.getAttachment({
        inquiryId: "123e4567-e89b-42d3-a456-426614174000",
        gmailMessageId: "mail_123",
        gmailAttachmentId: "0.1"
    }, async (url) => {
        calls.push(url);
        if (url.includes("/rest/v1/pa_gmail_message_index?")) {
            return jsonResponse([{ gmail_message_id: "mail_123", attachment_metadata: [{ id: "0.1" }] }]);
        }
        if (url === "https://oauth2.googleapis.com/token") return jsonResponse({ access_token: "test-access-token" });
        if (url.includes("/messages/mail_123?format=full")) {
            return jsonResponse({ payload: { parts: [{
                partId: "0.1", filename: "日本語資料.pdf", mimeType: "application/pdf", body: { data: base64Url("inline pdf") }
            }] } });
        }
        throw new Error(`unexpected URL: ${url}`);
    });
    assert.equal(inlineAttachment.filename, "日本語資料.pdf");
    assert.equal(inlineAttachment.mime_type, "application/pdf");
    assert.equal(inlineAttachment.size, 10);
    assert.equal(Buffer.from(inlineAttachment.data, "base64url").toString("utf8"), "inline pdf");
    assert.match(calls[0], /inquiry_id=eq\.123e4567-e89b-42d3-a456-426614174000/u, "the index lookup must stay scoped to the current inquiry");
    assert.equal(calls.some((url) => url.includes("/attachments/")), false, "inline data must not cause an unnecessary Gmail attachment fetch");

    const attachmentCalls = [];
    const fetchedAttachment = await gmail.getAttachment({
        inquiryId: "123e4567-e89b-42d3-a456-426614174000",
        gmailMessageId: "mail_123",
        gmailAttachmentId: "attachment_456"
    }, async (url) => {
        attachmentCalls.push(url);
        if (url.includes("/rest/v1/pa_gmail_message_index?")) {
            return jsonResponse([{ gmail_message_id: "mail_123", attachment_metadata: [{ id: "attachment_456" }] }]);
        }
        if (url === "https://oauth2.googleapis.com/token") return jsonResponse({ access_token: "test-access-token" });
        if (url.includes("/messages/mail_123?format=full")) {
            return jsonResponse({ payload: { parts: [{
                filename: "photo.jpg", mimeType: "image/jpeg", body: { attachmentId: "attachment_456" }
            }] } });
        }
        if (url.includes("/messages/mail_123/attachments/attachment_456")) return jsonResponse({ data: base64Url("fetched image") });
        throw new Error(`unexpected URL: ${url}`);
    });
    assert.equal(fetchedAttachment.filename, "photo.jpg");
    assert.equal(Buffer.from(fetchedAttachment.data, "base64url").toString("utf8"), "fetched image");
    assert.equal(attachmentCalls.some((url) => url.includes("/attachments/attachment_456")), true, "attachmentId data must use Gmail's attachment endpoint");

    const largeBytes = Buffer.alloc(5_682_037, 0x61);
    const largeAttachment = await gmail.getAttachmentBinary({
        inquiryId: "123e4567-e89b-42d3-a456-426614174000",
        gmailMessageId: "mail_123",
        gmailAttachmentId: "attachment_large"
    }, async (url) => {
        if (url.includes("/rest/v1/pa_gmail_message_index?")) return jsonResponse([{ gmail_message_id: "mail_123", attachment_metadata: [{ id: "attachment_large" }] }]);
        if (url === "https://oauth2.googleapis.com/token") return jsonResponse({ access_token: "test-access-token" });
        if (url.includes("/messages/mail_123?format=full")) return jsonResponse({ payload: { parts: [{ filename: "ステージ写真（参考）.JPG", mimeType: "image/jpeg", body: { attachmentId: "attachment_large" } }] } });
        if (url.includes("/messages/mail_123/attachments/attachment_large")) return jsonResponse({ data: largeBytes.toString("base64url") });
        throw new Error(`unexpected URL: ${url}`);
    });
    assert.equal(largeAttachment.bytes.length, 5_682_037, "the large JPEG must remain binary on the server");
    const headers = new Map();
    const chunks = [];
    const streamed = { statusCode: 0, setHeader: (name, value) => headers.set(name, value), write: (chunk) => { chunks.push(Buffer.from(chunk)); return true; }, end: () => undefined };
    await gmail.streamAttachmentResponse(streamed, largeAttachment);
    assert.equal(streamed.statusCode, 200);
    assert.equal(Buffer.concat(chunks).length, 5_682_037, "the complete JPEG must be chunked, not JSON encoded");
    assert.ok(chunks.length > 1, "large attachments must use more than one response chunk");
    assert.equal(headers.get("Content-Type"), "image/jpeg");
    assert.match(headers.get("Content-Disposition"), /filename\*=UTF-8''/u);
    assert.match(headers.get("Content-Disposition"), /%E3%82%B9/u, "the Japanese filename must be RFC 5987 encoded");

    await assert.rejects(
        gmail.getAttachmentBinary({
            inquiryId: "123e4567-e89b-42d3-a456-426614174000",
            gmailMessageId: "mail_123",
            gmailAttachmentId: "attachment_bad_data"
        }, async (url) => {
            if (url.includes("/rest/v1/pa_gmail_message_index?")) return jsonResponse([{ gmail_message_id: "mail_123", attachment_metadata: [{ id: "attachment_bad_data" }] }]);
            if (url === "https://oauth2.googleapis.com/token") return jsonResponse({ access_token: "test-access-token" });
            if (url.includes("/messages/mail_123?format=full")) return jsonResponse({ payload: { parts: [{ filename: "broken.pdf", mimeType: "application/pdf", body: { attachmentId: "attachment_bad_data" } }] } });
            if (url.includes("/messages/mail_123/attachments/attachment_bad_data")) return jsonResponse({ data: "not+base64" });
            throw new Error(`unexpected URL: ${url}`);
        }),
        /gmail_attachment_unavailable/u,
        "malformed Gmail base64url data must fail before streaming"
    );

    await assert.rejects(
        gmail.getAttachment({
            inquiryId: "123e4567-e89b-42d3-a456-426614174000",
            gmailMessageId: "mail_123",
            gmailAttachmentId: "missing_attachment"
        }, async () => jsonResponse([{ gmail_message_id: "mail_123", attachment_metadata: [{ id: "attachment_456" }] }])),
        /gmail_attachment_not_indexed/u,
        "an attachment outside the indexed message metadata must not be retrieved"
    );
    console.log("PAM-004 Gmail attachment validation: PASS");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
