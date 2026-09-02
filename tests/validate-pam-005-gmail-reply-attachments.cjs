const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const mail = require(path.join(root, "api", "_pa-mail.cjs"));
const gmail = require(path.join(root, "api", "_pa-gmail.cjs"));
const client = fs.readFileSync(path.join(root, "js", "pa-admin.js"), "utf8");
const page = fs.readFileSync(path.join(root, "pa-admin.html"), "utf8");

const config = {
    senderAddress: "aratechsound@gmail.com",
    senderName: "ARA-TECH",
    replyTo: "aratechsound@gmail.com",
    signature: "ARA-TECH"
};
const decodeRaw = (raw) => Buffer.from(raw, "base64url").toString("utf8");
const attachment = (filename, mime_type, body) => ({ filename, mime_type, data: Buffer.from(body, "utf8").toString("base64url") });
const base = {
    to: "customer@example.com",
    subject: "Re: thread subject",
    body: "reply body",
    messageType: "customer_receipt",
    replyHeaders: { inReplyTo: "<customer@example.com>", references: "<customer@example.com>" },
    config
};

const noAttachmentRaw = decodeRaw(mail.buildRawMessage(base));
assert.match(noAttachmentRaw, /Content-Type: multipart\/alternative/u, "attachment-less reply keeps the existing alternative body MIME");
assert.doesNotMatch(noAttachmentRaw, /multipart\/mixed/u, "attachment-less reply must not add an empty mixed wrapper");
assert.match(noAttachmentRaw, /In-Reply-To: <customer@example\.com>/u);
assert.match(noAttachmentRaw, /References: <customer@example\.com>/u);

const oneAttachmentRaw = decodeRaw(mail.buildRawMessage({
    ...base,
    attachments: [attachment("estimate.pdf", "application/pdf", "%PDF-safe-fixture")]
}));
assert.match(oneAttachmentRaw, /Content-Type: multipart\/mixed/u, "a reply attachment uses an outer mixed MIME wrapper");
assert.match(oneAttachmentRaw, /Content-Type: multipart\/alternative/u, "plain and HTML reply bodies remain together inside mixed MIME");
assert.match(oneAttachmentRaw, /Content-Type: application\/pdf/u);
assert.match(oneAttachmentRaw, /filename\*=UTF-8''estimate\.pdf/u);
assert.match(oneAttachmentRaw, /JVBERi1zYWZlLWZpeHR1cmU=/u, "PDF bytes must be base64 encoded in the MIME attachment part");

const multipleAttachmentRaw = decodeRaw(mail.buildRawMessage({
    ...base,
    attachments: [
        attachment("photo.png", "image/png", "png-fixture"),
        attachment("schedule.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "office-fixture")
    ]
}));
assert.match(multipleAttachmentRaw, /Content-Type: image\/png/u);
assert.match(multipleAttachmentRaw, /Content-Type: application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet/u);
assert.match(multipleAttachmentRaw, /filename\*=UTF-8''photo\.png/u);
assert.match(multipleAttachmentRaw, /filename\*=UTF-8''schedule\.xlsx/u);

assert.throws(() => mail.normalizeReplyAttachments([{ filename: "bad.pdf", mime_type: "application/pdf" }]), /invalid_reply_attachment/u, "malformed attachment shapes must fail closed");
assert.throws(() => mail.normalizeReplyAttachments([{ filename: "bad.pdf", mime_type: "application/pdf", data: "not+base64" }]), /invalid_reply_attachment/u);
assert.throws(() => mail.normalizeReplyAttachments(Array.from({ length: 11 }, (_, index) => attachment(`file-${index}.pdf`, "application/pdf", "x"))), /invalid_reply_attachment/u);

Object.assign(process.env, {
    GMAIL_CLIENT_ID: "test-client",
    GMAIL_CLIENT_SECRET: "test-secret",
    GMAIL_REFRESH_TOKEN: "test-refresh",
    GMAIL_SENDER_ADDRESS: "sender@example.com",
    GMAIL_REPLY_TO: "sender@example.com",
    SUPABASE_SERVICE_ROLE_KEY: "test-service-key"
});
const json = (payload) => ({ ok: true, status: 200, json: async () => payload });
const thread = {
    messages: [{
        id: "message_123",
        threadId: "thread_123",
        internalDate: "1788278400000",
        payload: {
            headers: [
                { name: "From", value: "customer@example.com" },
                { name: "To", value: "aratechsound@gmail.com" },
                { name: "Subject", value: "Re: thread subject" },
                { name: "Message-ID", value: "<customer@example.com>" }
            ],
            mimeType: "text/plain",
            body: { data: Buffer.from("customer message", "utf8").toString("base64url") }
        }
    }]
};
const previewFetch = async (url) => {
    if (url.includes("/rest/v1/pa_gmail_thread_links?")) return json([{ gmail_thread_id: "thread_123", conversation_role: "primary_conversation" }]);
    if (url === "https://oauth2.googleapis.com/token") return json({ access_token: "mock-access-token" });
    if (url.includes("/threads/thread_123?format=full")) return json(thread);
    throw new Error(`unexpected preview URL: ${url}`);
};

(async () => {
    const selected = [attachment("reply.pdf", "application/pdf", "reply fixture")];
    const preview = await gmail.replyPreview({
        inquiryId: "123e4567-e89b-42d3-a456-426614174000",
        actorId: "123e4567-e89b-42d3-a456-426614174001",
        body: "Thank you.",
        attachments: selected
    }, previewFetch);
    assert.deepEqual(preview.attachments, [{ filename: "reply.pdf", mime_type: "application/pdf", size: 13 }], "preview returns only safe attachment metadata, never file data");

    await assert.rejects(
        gmail.sendReply({
            inquiryId: "123e4567-e89b-42d3-a456-426614174000",
            actorId: "123e4567-e89b-42d3-a456-426614174001",
            body: "Thank you.",
            attachments: [attachment("changed.pdf", "application/pdf", "reply fixture")],
            confirmationToken: preview.confirmation_token
        }, previewFetch),
        /invalid_confirmation/u,
        "changing a selected attachment after preview must invalidate the confirmation token before any send"
    );

    assert.match(page, /id="gmail-reply-attachments-input"[^>]*multiple/u, "reply UI must allow multiple local files");
    assert.match(page, /id="gmail-reply-attachments"/u, "reply UI must expose selected attachments before send");
    assert.match(page, /id="gmail-reply-preview-attachments"/u, "preview must show attachment metadata");
    assert.match(client, /remove\.textContent = "削除"/u, "each selected attachment must be removable");
    assert.match(client, /MAX_GMAIL_REPLY_ATTACHMENT_BYTES/u);
    assert.match(client, /action: "reply_preview"[\s\S]{0,180}attachments/u, "preview must bind the selected bytes");
    assert.match(client, /action: "send_reply"[\s\S]{0,220}attachments/u, "send must carry the same selected bytes");
    assert.match(fs.readFileSync(path.join(root, "api", "_pa-gmail.cjs"), "utf8"), /threadId: preview\.gmail_thread_id/u, "reply attachments must retain Gmail threadId semantics");
    const sendSection = client.slice(client.indexOf("const sendGmailReply = async"));
    assert.ok(sendSection.indexOf("const response = await callGmailApi({ action: \"send_reply\"") < sendSection.indexOf("gmailReplyAttachments = [];"), "attachments are cleared only after a successful send response");
    console.log("PAM-005 Gmail reply attachment validation: PASS");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
