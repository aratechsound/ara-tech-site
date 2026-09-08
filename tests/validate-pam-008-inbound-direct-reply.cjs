const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const gmail = require("../api/_pa-gmail.cjs");

Object.assign(process.env, {
    GMAIL_CLIENT_ID: "fixture-client",
    GMAIL_CLIENT_SECRET: "fixture-secret",
    GMAIL_REFRESH_TOKEN: "fixture-refresh",
    GMAIL_SENDER_ADDRESS: "aratechsound@gmail.com",
    GMAIL_REPLY_TO: "aratechsound@gmail.com",
    SUPABASE_URL: "https://fixture.invalid",
    SUPABASE_SERVICE_ROLE_KEY: "fixture-service-key"
});

const inquiryId = "123e4567-e89b-42d3-a456-426614174000";
const actorId = "123e4567-e89b-42d3-a456-426614174001";
const threadId = "thread_123";
const json = (payload, status = 200) => ({ ok: status < 300, status, json: async () => payload });
const message = ({ id, from, to = "aratechsound@gmail.com", replyTo, subject, messageId, references, timestamp }) => ({
    id, threadId, internalDate: String(timestamp),
    payload: {
        mimeType: "text/plain",
        headers: [
            { name: "From", value: from },
            { name: "To", value: to },
            ...(replyTo ? [{ name: "Reply-To", value: replyTo }] : []),
            { name: "Subject", value: subject },
            { name: "Message-ID", value: messageId },
            ...(references ? [{ name: "References", value: references }] : [])
        ],
        body: { data: Buffer.from("fixture body").toString("base64url") }
    }
});

const selected = message({
    id: "selected_message", from: "Sender <from@example.invalid>", replyTo: "Reply Desk <reply@example.invalid>", subject: "ABC",
    messageId: "<selected@example.invalid>", references: "<root@example.invalid> <selected@example.invalid>", timestamp: 1000
});
const newest = message({
    id: "newest_message", from: "latest@example.invalid", subject: "Re: Latest", messageId: "<latest@example.invalid>", timestamp: 2000
});
const outbound = message({
    id: "outbound_message", from: "aratechsound@gmail.com", to: "customer@example.invalid", subject: "Sent", messageId: "<sent@example.invalid>", timestamp: 500
});
const thread = { messages: [outbound, selected, newest] };

const events = { sends: [], providerCalls: 0 };
const fetchFixture = async (url, options = {}) => {
    const target = new URL(url);
    if (target.hostname === "oauth2.googleapis.com") return json({ access_token: "fixture-token" });
    if (target.hostname === "gmail.googleapis.com") {
        events.providerCalls++;
        if (target.pathname.endsWith("/messages/send")) {
            const payload = JSON.parse(options.body);
            events.sends.push({ threadId: payload.threadId, raw: Buffer.from(payload.raw, "base64url").toString("utf8") });
            return json({ id: "sent_reply_1", threadId });
        }
        if (target.pathname.includes("/threads/")) return json(thread);
    }
    assert.equal(target.hostname, "fixture.invalid");
    if (target.pathname.endsWith("/pa_gmail_thread_links")) {
        return json([{ inquiry_id: inquiryId, gmail_thread_id: threadId, conversation_role: "primary_conversation" }]);
    }
    if (target.pathname.endsWith("/pa_inquiries")) return json([{ id: inquiryId, inquiry_number: "PA-20260908-00001" }]);
    return json([]);
};

const client = fs.readFileSync(path.join(__dirname, "..", "js", "pa-admin.js"), "utf8");
const extract = (name) => {
    const match = client.match(new RegExp(`^const ${name} = [\\s\\S]*?(?=^const |$(?![\\s\\S]))`, "m"));
    assert(match, `missing client function: ${name}`);
    return match[0];
};

const createElement = (tag) => ({
    tag, children: [], textContent: "", className: "", value: "", disabled: false,
    classList: { add() {}, remove() {} },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    addEventListener(type, listener) { this.listener = { type, listener }; },
    focus() { this.focused = true; },
    scrollIntoView() { this.scrolled = true; }
});
const descendants = (node) => [node, ...(node.children || []).flatMap(descendants)];

let count = 0;
async function test(name, run) {
    await run();
    count++;
    console.log(`PASS ${name}`);
}

(async () => {
    await test("TEST-05/06/07 reply prefix is added once", async () => {
        assert.equal(gmail.replySubject("ABC"), "Re: ABC");
        assert.equal(gmail.replySubject("Re: ABC"), "Re: ABC");
        assert.equal(gmail.replySubject("RE: ABC"), "RE: ABC");
    });

    await test("TEST-03/08/09 selected inbound Reply-To opens the existing empty composer", async () => {
        const elements = new Map();
        const $ = (key) => {
            if (!elements.has(key)) elements.set(key, createElement("control"));
            return elements.get(key);
        };
        const box = {
            $, currentCase: { id: inquiryId }, gmailReplySource: null, gmailReplyAttachments: [], gmailReplyPreview: null,
            gmailReplyPanel: createElement("panel"), GMAIL_OFFICIAL_ADDRESS: "aratechsound@gmail.com", Object,
            window: { confirm: () => true }, setGmailReplyMode() {}, invalidateGmailReplyPreview() {}, renderGmailReplyAttachments() {},
            setMessage() {}
        };
        vm.createContext(box);
        vm.runInContext(`${extract("gmailReplyRecipientForMessage")}\n${extract("gmailReplySubjectForMessage")}\n${extract("openGmailReply")}\nthis.open = openGmailReply;`, box);
        assert.equal(box.open({
            id: "selected_message", thread_id: threadId, direction: "inbound", from_address: "from@example.invalid",
            reply_to: "reply@example.invalid", subject: "ABC"
        }), true);
        assert.equal($("#gmail-reply-recipient").value, "reply@example.invalid");
        assert.equal($("#gmail-reply-subject").value, "Re: ABC");
        assert.equal($("#gmail-reply-body").value, "");
        assert.equal(box.gmailReplySource.inquiryId, inquiryId);
        assert.equal(box.gmailReplySource.messageId, "selected_message");
    });

    await test("TEST-04 From fallback and self-address rejection", async () => {
        assert.equal(gmail.normalizeMessage(selected).reply_to, "reply@example.invalid");
        assert.equal(gmail.normalizeMessage(newest).reply_to, "");
        const fallback = await gmail.replyPreview({
            inquiryId, actorId, body: "本文", replySourceMessageId: "newest_message", replySourceThreadId: threadId
        }, fetchFixture);
        assert.equal(fallback.recipient, "latest@example.invalid");
        const selfReply = message({
            id: "self_reply", from: "external@example.invalid", replyTo: "aratechsound@gmail.com", subject: "ABC",
            messageId: "<self-reply@example.invalid>", timestamp: 3000
        });
        thread.messages.push(selfReply);
        await assert.rejects(() => gmail.replyPreview({
            inquiryId, actorId, body: "本文", replySourceMessageId: "self_reply", replySourceThreadId: threadId
        }, fetchFixture), /reply_target_unavailable/u);
        thread.messages.pop();
    });

    await test("TEST-01/02 button renders only on inbound messages", async () => {
        const timeline = createElement("timeline");
        const box = {
            emailHistory: timeline, currentGmailTimeline: [
                { id: "in", thread_id: threadId, direction: "inbound", subject: "ABC", occurred_at: "2026-09-08T00:00:00Z", source: "gmail_received", attachments: [] },
                { id: "out", thread_id: threadId, direction: "outbound", subject: "Re: ABC", occurred_at: "2026-09-08T00:01:00Z", source: "pa_case_manager", attachments: [] }
            ],
            currentMailAttention: "none", document: { createElement }, formatDateTime: (value) => value,
            openGmailReply() {}, isSafeAttachmentPreviewType: () => false
        };
        vm.createContext(box);
        vm.runInContext(`${extract("renderEmailHistory")}\nthis.render = renderEmailHistory;`, box);
        box.render();
        const inboundButtons = descendants(timeline.children[0]).filter((node) => node.tag === "button" && node.textContent === "このメールに返信");
        const outboundButtons = descendants(timeline.children[1]).filter((node) => node.tag === "button" && node.textContent === "このメールに返信");
        assert.equal(inboundButtons.length, 1);
        assert.equal(outboundButtons.length, 0);
    });

    await test("TEST-07/16 selected message metadata reaches Gmail MIME without duplicates", async () => {
        const preview = await gmail.replyPreview({
            inquiryId, actorId, body: "本文", replySourceMessageId: "selected_message", replySourceThreadId: threadId
        }, fetchFixture);
        assert.equal(preview.recipient, "reply@example.invalid");
        assert.equal(preview.subject, "Re: ABC");
        assert.equal(preview.reply_source_message_id, "selected_message");
        assert.equal(preview.gmail_thread_id, threadId);
        await gmail.sendReply({
            inquiryId, actorId, body: "本文", confirmationToken: preview.confirmation_token,
            replySourceMessageId: "selected_message", replySourceThreadId: threadId
        }, fetchFixture);
        assert.equal(events.sends.length, 1);
        assert.equal(events.sends[0].threadId, threadId);
        assert.match(events.sends[0].raw, /In-Reply-To: <selected@example\.invalid>/u);
        assert.match(events.sends[0].raw, /References: <root@example\.invalid> <selected@example\.invalid>/u);
        assert.doesNotMatch(events.sends[0].raw, /<selected@example\.invalid> <selected@example\.invalid>/u);
    });

    await test("TEST-16 source identity is token-bound and invalid sources fail before send", async () => {
        const preview = await gmail.replyPreview({
            inquiryId, actorId, body: "本文", replySourceMessageId: "selected_message", replySourceThreadId: threadId
        }, fetchFixture);
        const sendsBefore = events.sends.length;
        await assert.rejects(() => gmail.sendReply({
            inquiryId, actorId, body: "本文", confirmationToken: preview.confirmation_token,
            replySourceMessageId: "newest_message", replySourceThreadId: threadId
        }, fetchFixture), /invalid_confirmation/u);
        await assert.rejects(() => gmail.replyPreview({
            inquiryId, actorId, body: "本文", replySourceMessageId: "outbound_message", replySourceThreadId: threadId
        }, fetchFixture), /invalid_reply_source/u);
        assert.equal(events.sends.length, sendsBefore);
    });

    await test("TEST-11/17 ordinary composer preview adds no explicit reply-source request", async () => {
        const elements = new Map();
        const $ = (key) => {
            if (!elements.has(key)) {
                const element = createElement("control");
                if (key === "#gmail-reply-body") element.value = "通常本文";
                if (key === "#gmail-reply-preview-frame") element.srcdoc = "";
                elements.set(key, element);
            }
            return elements.get(key);
        };
        let request;
        const box = {
            $, currentCase: { id: inquiryId }, gmailReplySource: null, gmailReplyAttachments: [], gmailReplyMode: "normal",
            gmailReplyPreview: null, gmailReplyPreviewBinding: null,
            gmailReplyAttachmentPayload: async () => [],
            callGmailApi: async (payload) => {
                request = payload;
                return { preview: { inquiry_id: inquiryId, gmail_thread_id: threadId, recipient: "latest@example.invalid", subject: "Re: Latest", body: "通常本文", html: "<p>通常本文</p>", mode: "normal", attachments: [], confirmation_token: "token" } };
            },
            renderGmailReplyPreviewAttachments() {}, setMessage() {}, gmailErrorMessage: (code) => code, Object
        };
        vm.createContext(box);
        vm.runInContext(`${extract("previewGmailReply")}\nthis.preview = previewGmailReply;`, box);
        await box.preview();
        assert.equal(Object.hasOwn(request, "reply_source_message_id"), false);
        assert.equal(Object.hasOwn(request, "reply_source_thread_id"), false);
    });

    await test("TEST-12 draft protection refuses a silent overwrite", async () => {
        const elements = new Map();
        const $ = (key) => {
            if (!elements.has(key)) elements.set(key, createElement("control"));
            return elements.get(key);
        };
        $("#gmail-reply-body").value = "入力中の本文";
        let confirms = 0;
        const box = {
            $, currentCase: { id: inquiryId }, gmailReplySource: null, gmailReplyAttachments: [], gmailReplyPreview: null,
            gmailReplyPanel: createElement("panel"), GMAIL_OFFICIAL_ADDRESS: "aratechsound@gmail.com", Object,
            window: { confirm: () => { confirms++; return false; } }, setGmailReplyMode() {}, invalidateGmailReplyPreview() {},
            renderGmailReplyAttachments() {}, setMessage() {}
        };
        vm.createContext(box);
        vm.runInContext(`${extract("gmailReplyRecipientForMessage")}\n${extract("gmailReplySubjectForMessage")}\n${extract("openGmailReply")}\nthis.open = openGmailReply;`, box);
        assert.equal(box.open({ id: "selected_message", thread_id: threadId, direction: "inbound", from_address: "from@example.invalid", subject: "ABC" }), false);
        assert.equal(confirms, 1);
        assert.equal($("#gmail-reply-body").value, "入力中の本文");
        assert.equal(box.gmailReplySource, null);
    });

    assert.match(client, /appendSanitizedEmailHtml\(body, message\.body_html\)/u, "HTML body renderer remains unchanged");
    assert.match(fs.readFileSync(path.join(__dirname, "..", "pa-admin.css"), "utf8"), /\.mail-history__reply-actions \{ margin-top: 10px; \}/u);
    const route = fs.readFileSync(path.join(__dirname, "..", "api", "pa-gmail.js"), "utf8");
    assert.match(route, /replySourceMessageId: input\.reply_source_message_id/u);
    assert.match(route, /replySourceThreadId: input\.reply_source_thread_id/u);
    assert.equal(count, 8);
    console.log("PAM-008 inbound direct reply validation: 8/8 PASS; synthetic transport only; no email sent");
})().catch((error) => { console.error(error.stack); process.exitCode = 1; });
