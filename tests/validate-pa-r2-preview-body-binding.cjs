const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const gmail = require("../api/_pa-gmail.cjs");

Object.assign(process.env, {
    GMAIL_CLIENT_ID: "fixture-client", GMAIL_CLIENT_SECRET: "fixture-secret",
    GMAIL_REFRESH_TOKEN: "fixture-refresh", GMAIL_SENDER_ADDRESS: "sender@example.invalid",
    GMAIL_REPLY_TO: "sender@example.invalid", SUPABASE_SERVICE_ROLE_KEY: "fixture-service-key"
});

const client = fs.readFileSync(path.join(__dirname, "..", "js", "pa-admin.js"), "utf8");
const extract = (name) => {
    const match = client.match(new RegExp(`^const ${name} = [\\s\\S]*?(?=^const |$(?![\\s\\S]))`, "m"));
    assert(match, `missing client function: ${name}`);
    return match[0];
};
const implementation = [
    "base64UrlForFile", "gmailReplyAttachmentPayload", "previewGmailReply",
    "isGmailReplySnapshotSelected", "sameGmailReplyAttachments",
    "createGmailReplySendSnapshot", "recordEstimateSubmissionProgress", "sendGmailReply"
].map(extract).join("\n");
const inquiryId = "123e4567-e89b-42d3-a456-426614174000";
const otherId = "123e4567-e89b-42d3-a456-426614174002";
const actorId = "123e4567-e89b-42d3-a456-426614174001";
const json = (payload, status = 200) => ({ ok: status < 300, status, json: async () => payload });
const makeThread = (subject = "Re: R2 binding") => ({ messages: [{
    id: "message_123", threadId: "thread_123", internalDate: "1788278400000",
    payload: { headers: [
        { name: "From", value: "customer@example.invalid" }, { name: "To", value: "sender@example.invalid" },
        { name: "Subject", value: subject }, { name: "Message-ID", value: "<r2@example.invalid>" }
    ], mimeType: "text/plain", body: { data: Buffer.from("customer message").toString("base64url") } }
}] });

function createUi({ mode = "estimate_submission", body = "見積書をお送りします。", attachmentCount = 0, subjectRef } = {}) {
    const elements = new Map();
    const $ = (key) => {
        if (!elements.has(key)) elements.set(key, {
            value: key === "#gmail-reply-body" ? body : "", textContent: "", disabled: false,
            classList: { add() {}, remove() {} }
        });
        return elements.get(key);
    };
    const events = { requests: [], sent: [], progressWrites: 0, rendered: 0, messages: [] };
    const fetchFixture = async (url, options = {}) => {
        const target = new URL(url);
        if (target.hostname === "oauth2.googleapis.com") return json({ access_token: "fixture-token" });
        if (target.hostname === "gmail.googleapis.com" && target.pathname.endsWith("/messages/send")) {
            const payload = JSON.parse(options.body);
            events.sent.push({ threadId: payload.threadId, raw: Buffer.from(payload.raw, "base64url").toString("utf8") });
            return json({ id: `sent_${events.sent.length}`, threadId: "thread_123" });
        }
        if (target.hostname === "gmail.googleapis.com" && target.pathname.includes("/threads/")) return json(makeThread(subjectRef?.value));
        assert(target.pathname.startsWith("/rest/v1/"), `unexpected endpoint ${url}`);
        if (target.pathname.endsWith("/pa_gmail_thread_links")) return json([{ inquiry_id: inquiryId, gmail_thread_id: "thread_123", conversation_role: "primary_conversation" }]);
        if (target.pathname.endsWith("/pa_inquiries")) return json([{ id: inquiryId, inquiry_number: "PA-R2-001" }]);
        return json([]);
    };
    const attachments = Array.from({ length: attachmentCount }, (_, index) => ({
        file: new File([`attachment-${index}`], `attachment-${index}.pdf`, { type: "application/pdf" })
    }));
    const box = {
        $, currentCase: { id: inquiryId, status: "rough_estimate", updated_at: "case-v1" },
        currentProgress: { inquiry_id: inquiryId, estimate_created_on: "2026-09-01", updated_at: "progress-v1" },
        gmailReplyPreview: null, gmailReplyPreviewBinding: null, gmailReplyAttachments: attachments, gmailReplyMode: mode,
        window: { confirm: () => true }, Uint8Array, btoa, Date,
        callGmailApi: async (args) => {
            events.requests.push(structuredClone(args));
            if (args.action === "reply_preview") return { preview: await gmail.replyPreview({
                inquiryId: args.inquiry_id, actorId, body: args.body, attachments: args.attachments, mode: args.mode
            }, fetchFixture) };
            return { result: await gmail.sendReply({
                inquiryId: args.inquiry_id, actorId, body: args.body, attachments: args.attachments,
                mode: args.mode, confirmationToken: args.confirmation_token
            }, fetchFixture) };
        },
        supabase: { rpc: async (_name, args) => {
            events.progressWrites++;
            return { data: { ...box.currentProgress, inquiry_id: args.p_inquiry_id, updated_at: "progress-v2" }, error: null };
        } },
        applyGmailSyncResult: () => { events.rendered++; }, renderGmailReplyAttachments() {}, renderGmailReplyPreviewAttachments() {},
        renderOverview() {}, setGmailReplyMode: (next) => { box.gmailReplyMode = next; },
        setMessage: (_element, message, type) => { events.messages.push({ message, type }); }, gmailErrorMessage: (code) => code
    };
    vm.createContext(box);
    vm.runInContext(`${implementation}\nthis.preview = previewGmailReply; this.send = sendGmailReply;`, box);
    return { box, $, events };
}

let count = 0;
async function test(name, run) { await run(); count++; console.log(`PASS ${name}`); }

(async () => {
    await test("R2-1 raw estimate draft sends through canonical preview token and keeps footer", async () => {
        const { box, $, events } = createUi();
        await box.preview();
        assert(box.gmailReplyPreview, JSON.stringify(events.messages));
        assert.notEqual(box.gmailReplyPreview.body, $("#gmail-reply-body").value, "preview body is canonical, not the raw draft");
        assert.match(box.gmailReplyPreview.body, /ARA-TECH/u);
        assert.equal($("#gmail-reply-body").value, "見積書をお送りします。");
        await box.send();
        assert.equal(events.sent.length, 1);
        assert.equal(events.progressWrites, 1);
        assert.match(events.sent[0].raw, /ARA-TECH/u, "real MIME generation retains the canonical brand footer");
    });
    await test("R2-2 raw ordinary reply sends and never writes estimate progress", async () => {
        const { box, events } = createUi({ mode: "normal", body: "通常返信です。" });
        await box.preview();
        await box.send();
        assert.equal(events.sent.length, 1);
        assert.equal(events.progressWrites, 0);
    });
    await test("R2-3 one-character raw draft edit rejects before send", async () => {
        const { box, $, events } = createUi();
        await box.preview();
        $("#gmail-reply-body").value += "追";
        await box.send();
        assert.equal(events.requests.filter((request) => request.action === "send_reply").length, 0);
        assert.equal(events.sent.length, 0);
    });
    await test("R2-4 stale canonical subject rejects through the real token contract", async () => {
        const subjectRef = { value: "Re: before preview" };
        const { box, events } = createUi({ subjectRef });
        await box.preview();
        subjectRef.value = "Re: changed after preview";
        await box.send();
        assert.equal(events.sent.length, 0);
        assert.equal(events.progressWrites, 0);
    });
    await test("R2-5 preview thread or case mismatch rejects before send", async () => {
        const threadCase = createUi();
        await threadCase.box.preview();
        threadCase.box.gmailReplyPreview.gmail_thread_id = "other-thread";
        await threadCase.box.send();
        assert.equal(threadCase.events.sent.length, 0);
        const caseCase = createUi();
        await caseCase.box.preview();
        caseCase.box.currentCase = { id: otherId, status: "rough_estimate", updated_at: "other-v1" };
        caseCase.box.currentProgress = { inquiry_id: otherId, estimate_created_on: "2026-09-01", updated_at: "other-progress-v1" };
        await caseCase.box.send();
        assert.equal(caseCase.events.sent.length, 0);
    });
    await test("R2-6 stale attachment set rejects before send", async () => {
        const { box, events } = createUi({ attachmentCount: 1 });
        await box.preview();
        box.gmailReplyAttachments = [...box.gmailReplyAttachments, { file: new File(["new"], "new.pdf", { type: "application/pdf" }) }];
        await box.send();
        assert.equal(events.sent.length, 0);
    });
    await test("R2-7 three attachments retain raw and canonical identities through real MIME generation", async () => {
        const { box, events } = createUi({ attachmentCount: 3 });
        await box.preview();
        assert.match(box.gmailReplyPreview.body, /ARA-TECH/u);
        await box.send();
        assert.equal(events.sent.length, 1);
        assert.match(events.sent[0].raw, /attachment-0\.pdf/u);
        assert.match(events.sent[0].raw, /attachment-2\.pdf/u);
    });
    assert.equal(count, 7);
    console.log("PA R2 preview raw/normalized body-binding integration: 7/7 PASS; real UI functions + replyPreview/sendReply/token/MIME; transport synthetic; no email sent");
})().catch((error) => { console.error(error.stack); process.exitCode = 1; });
