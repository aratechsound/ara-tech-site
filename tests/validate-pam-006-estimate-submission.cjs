const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const gmail = require(path.join(root, "api", "_pa-gmail.cjs"));
const mail = require(path.join(root, "api", "_pa-mail.cjs"));
const client = fs.readFileSync(path.join(root, "js", "pa-admin.js"), "utf8");
const page = fs.readFileSync(path.join(root, "pa-admin.html"), "utf8");
const projection = fs.readFileSync(path.join(root, "supabase", "migrations", "20260902170000_pam003_estimate_submission_projection.sql"), "utf8");

Object.assign(process.env, {
    GMAIL_CLIENT_ID: "test-client",
    GMAIL_CLIENT_SECRET: "test-secret",
    GMAIL_REFRESH_TOKEN: "test-refresh",
    GMAIL_SENDER_ADDRESS: "sender@example.com",
    GMAIL_REPLY_TO: "sender@example.com",
    SUPABASE_SERVICE_ROLE_KEY: "test-service-key"
});

const inquiryId = "123e4567-e89b-42d3-a456-426614174000";
const actorId = "123e4567-e89b-42d3-a456-426614174001";
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
const attachment = (filename, text) => ({ filename, mime_type: "application/pdf", data: Buffer.from(text, "utf8").toString("base64url") });
const auditWrites = [];
let sentCount = 0;
const inquiry = { id: inquiryId, inquiry_number: "PA-TEST-001", case_type: "PA_EVENT", email: "customer@example.com" };
let indexMode = "known";
const rawFixture = (attachments = []) => Buffer.from(mail.buildRawMessage({
    to: "customer@example.com", subject: "Re: thread subject", body: "Estimate body",
    messageType: "customer_receipt", replyHeaders: { inReplyTo: "<customer@example.com>", references: "<customer@example.com>" },
    attachments, config: { senderAddress: "aratechsound@gmail.com", senderName: "ARA-TECH", replyTo: "aratechsound@gmail.com", signature: "ARA-TECH" }
}), "base64url").toString("utf8");
const normalNoAttachment = rawFixture();
const estimateNoAttachment = rawFixture();
assert.match(normalNoAttachment, /ARA-TECH/u, "normal reply MIME includes the app-generated brand block");
assert.match(estimateNoAttachment, /ARA-TECH/u, "estimate reply MIME preserves the same app-generated brand block");
assert.match(normalNoAttachment, /Content-Type: multipart\/alternative/u);
assert.match(estimateNoAttachment, /Content-Type: multipart\/alternative/u);
const normalWithAttachment = rawFixture([attachment("estimate.pdf", "brand fixture")]);
const estimateWithAttachment = rawFixture([attachment("estimate.pdf", "brand fixture")]);
assert.match(normalWithAttachment, /ARA-TECH/u);
assert.match(estimateWithAttachment, /ARA-TECH/u);
assert.match(normalWithAttachment, /Content-Type: multipart\/mixed/u);
assert.match(estimateWithAttachment, /Content-Type: multipart\/mixed/u);
const fixtureFetch = async (url, options = {}) => {
    if (url === "https://oauth2.googleapis.com/token") return json({ access_token: "fixture-token" });
    if (url === "https://gmail.googleapis.com/gmail/v1/users/me/profile") return json({ emailAddress: "aratechsound@gmail.com" });
    if (url === "https://gmail.googleapis.com/gmail/v1/users/me/messages/send") {
        sentCount += 1;
        const payload = JSON.parse(options.body);
        assert.equal(payload.threadId, "thread_123", "estimate submission must retain its existing Gmail thread");
        return json({ id: `sent_${sentCount}`, threadId: "thread_123" });
    }
    if (url.includes("/threads/thread_123?format=full")) return json(thread);
    if (url.includes("/rest/v1/pa_inquiries?")) return json([inquiry]);
    if (url.includes("/rest/v1/pa_gmail_thread_links?")) return json([{ inquiry_id: inquiryId, gmail_thread_id: "thread_123", conversation_role: "primary_conversation" }]);
    if (url.includes("/rest/v1/pa_gmail_message_index?") && (options.method || "GET") === "GET") {
        const ids = (new URL(url).searchParams.get("gmail_message_id") || "").slice(4, -1).split(",");
        return json(indexMode === "unknown" ? [] : ids.map(id => ({ gmail_message_id: id, gmail_thread_id: "thread_123",
            inquiry_id: indexMode === "conflict" ? actorId : inquiryId })));
    }
    if (url.includes("/rest/v1/pa_inquiry_audit") && options.method === "POST") {
        auditWrites.push(JSON.parse(options.body));
        return json([]);
    }
    if (url.includes("/rest/v1/")) return json([]);
    throw new Error(`unexpected fixture URL: ${url}`);
};

(async () => {
    const guarded = { inquiryId, actorId, body: "guard fixture", mode: "estimate_submission" };
    delete inquiry.email;
    await assert.rejects(() => gmail.replyPreview(guarded, fixtureFetch), /reply_target_unavailable/);
    inquiry.email = "customer@example.com";
    indexMode = "unknown";
    await assert.rejects(() => gmail.replyPreview(guarded, fixtureFetch), /reply_attribution_unknown/);
    indexMode = "conflict";
    await assert.rejects(() => gmail.replyPreview(guarded, fixtureFetch), /reply_attribution_conflict/);
    indexMode = "known";
    inquiry.case_type = "OTHER";
    await assert.rejects(() => gmail.replyPreview({ ...guarded, mode: "normal" }, fixtureFetch), /invalid_reply_source/);
    inquiry.case_type = "PA_EVENT";
    assert.equal(sentCount, 0);
    assert.equal(auditWrites.length, 0, "invalid source evidence never sends or records success");
    const first = await gmail.replyPreview({
        inquiryId,
        actorId,
        body: "見積書をお送りします。",
        attachments: [attachment("estimate-v1.pdf", "estimate v1")],
        mode: "estimate_submission"
    }, fixtureFetch);
    assert.equal(first.mode, "estimate_submission");
    assert.deepEqual(first.attachments, [{ filename: "estimate-v1.pdf", mime_type: "application/pdf", size: 11 }]);

    await assert.rejects(
        gmail.sendReply({
            inquiryId, actorId, body: "見積書をお送りします。", attachments: [attachment("estimate-v1.pdf", "estimate v1")],
            mode: "normal", confirmationToken: first.confirmation_token
        }, fixtureFetch),
        /invalid_confirmation/u,
        "a normal-reply preview token must not authorize estimate-submission mode"
    );

    await gmail.sendReply({
        inquiryId, actorId, body: "見積書をお送りします。", attachments: [attachment("estimate-v1.pdf", "estimate v1")],
        mode: "estimate_submission", confirmationToken: first.confirmation_token
    }, fixtureFetch);
    const second = await gmail.replyPreview({
        inquiryId, actorId, body: "改訂版をお送りします。", attachments: [attachment("estimate-v2.pdf", "estimate v2"), attachment("layout.pdf", "layout")],
        mode: "estimate_submission"
    }, fixtureFetch);
    await gmail.sendReply({
        inquiryId, actorId, body: "改訂版をお送りします。", attachments: [attachment("estimate-v2.pdf", "estimate v2"), attachment("layout.pdf", "layout")],
        mode: "estimate_submission", confirmationToken: second.confirmation_token
    }, fixtureFetch);

    const submissionAudits = auditWrites.filter((entry) => entry.action === "gmail_case_reply_sent" && entry.details.communication_kind === "estimate_submission");
    assert.equal(submissionAudits.length, 2, "resubmission must append a second estimate-submission history record");
    assert.deepEqual(submissionAudits.map((entry) => entry.details.attachment_filenames), [["estimate-v1.pdf"], ["estimate-v2.pdf", "layout.pdf"]]);
    assert.equal(sentCount, 2);

    assert.match(page, /id="open-estimate-submission"/u, "the communication panel must expose a dedicated estimate action");
    assert.match(client, /const openEstimateSubmission/u);
    assert.match(client, /currentProgress\?\.estimate_created_on/u, "estimate sending must require a saved creation date");
    assert.match(client, /const createGmailReplySendSnapshot[\s\S]{0,1800}mode: gmailReplyMode,[\s\S]{0,400}attachments: Object\.freeze/u, "the dedicated UX must freeze its mode and attachment authority before any await");
    assert.match(client, /action: "send_reply"[\s\S]{0,240}mode: snapshot\.mode/u, "the dedicated UX must send only the captured reply mode");
    assert.match(client, /estimate_sent_on: new Date\(\)\.toISOString\(\)\.slice\(0, 10\)/u, "the stage must change only after send_reply resolves");
    assert.match(client, /!\["rough_estimate", "schedule_confirmed"\]\.includes\(status\)/u, "the client projection must match the canonical estimate-status projection");
    const sendSection = client.slice(client.indexOf("const sendGmailReply = async"));
    assert.ok(sendSection.indexOf('const response = await callGmailApi({') < sendSection.indexOf("await recordEstimateSubmissionProgress(snapshot)"), "a failed Gmail send cannot advance the estimate stage");
    assert.match(projection, /when p_status not in \('rough_estimate', 'schedule_confirmed'\)/u, "existing statuses must remain canonical");
    assert.match(projection, /when p_estimate_sent_on is null or coalesce\(p_estimate_adjusting, false\) then 7/u, "estimate submission/customer-response must remain distinct from creation");
    console.log("PAM-006 estimate submission validation: PASS");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
