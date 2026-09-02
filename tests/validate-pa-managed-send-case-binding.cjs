const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const client = fs.readFileSync(path.join(__dirname, "..", "js", "pa-admin.js"), "utf8");
const start = client.indexOf("const isGmailReplySnapshotSelected");
const end = client.indexOf("const callBrandMailTestApi");
assert(start >= 0 && end > start, "managed-send binding implementation is present");
const managedSendCode = client.slice(start, end);

const clone = (value) => structuredClone(value);
const deferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
    return { promise, resolve, reject };
};
const caseA = Object.freeze({ id: "case-A", status: "rough_estimate", updated_at: "case-A-v1" });
const caseB = Object.freeze({ id: "case-B", status: "rough_estimate", updated_at: "case-B-v1" });
const progressA = Object.freeze({ inquiry_id: "case-A", estimate_created_on: "2026-09-01", updated_at: "progress-A-v1" });
const progressB = Object.freeze({ inquiry_id: "case-B", estimate_created_on: "2026-09-01", updated_at: "progress-B-v1" });
const attachment = (name) => ({ file: { name, type: "application/pdf", size: 1 } });
const preview = (id, threadId, mode, body) => ({
    inquiry_id: id, gmail_thread_id: threadId, recipient: `${id}@example.invalid`, subject: `${id} subject`, body, mode,
    confirmation_token: `${id}-${threadId}-${mode}-confirmation`
});

function createUi({ mode = "estimate_submission", attachments = [attachment("A.pdf")], attachmentPayload, sendReply }) {
    const elements = new Map();
    const $ = (key) => {
        if (!elements.has(key)) {
            elements.set(key, {
                value: key === "#gmail-reply-body" ? "A body" : "", disabled: false, textContent: "", className: "",
                classList: { add() {}, remove() {}, toggle() {} }
            });
        }
        return elements.get(key);
    };
    const backend = {
        A: { progress: clone(progressA), history: 0 },
        B: { progress: clone(progressB), history: 0 }
    };
    const writes = [];
    const renders = [];
    const messages = [];
    const ui = {
        $, currentCase: caseA, currentProgress: progressA,
        gmailReplyPreview: preview("case-A", "thread-A", mode, "A body"), gmailReplyAttachments: attachments, gmailReplyMode: mode,
        window: { confirm: () => true },
        gmailReplyAttachmentPayload: attachmentPayload,
        callGmailApi: async (args) => sendReply(args, backend),
        supabase: { rpc: async (name, args) => {
            assert.equal(name, "update_pa_case_progress");
            writes.push(clone(args));
            const key = args.p_inquiry_id === "case-A" ? "A" : args.p_inquiry_id === "case-B" ? "B" : null;
            assert(key, "progress write has a known immutable case target");
            backend[key].progress = {
                ...backend[key].progress, ...args.p_progress, inquiry_id: args.p_inquiry_id,
                updated_at: `${key}-progress-after-send`
            };
            return { data: clone(backend[key].progress), error: null };
        } },
        applyGmailSyncResult: (result) => renders.push({ type: "sync", result: clone(result) }),
        renderGmailReplyAttachments: () => renders.push({ type: "attachments" }),
        renderOverview: () => renders.push({ type: "overview" }),
        setGmailReplyMode: (next) => { ui.gmailReplyMode = next; },
        setMessage: (_element, message, type) => messages.push({ message, type }),
        gmailErrorMessage: (code) => code
    };
    vm.createContext(ui);
    vm.runInContext(`${managedSendCode}\nthis.runManagedSend = sendGmailReply;`, ui);
    return { ui, $, backend, writes, renders, messages };
}

function switchToB(subject) {
    subject.ui.currentCase = caseB;
    subject.ui.currentProgress = progressB;
    subject.ui.gmailReplyPreview = preview("case-B", "thread-B", "estimate_submission", "B body");
    subject.ui.gmailReplyAttachments = [attachment("B.pdf")];
    subject.ui.gmailReplyMode = "estimate_submission";
    subject.$("#gmail-reply-body").value = "B body";
    subject.$("#send-gmail-reply").disabled = false;
    return clone({
        case: subject.ui.currentCase, progress: subject.ui.currentProgress, preview: subject.ui.gmailReplyPreview,
        attachments: subject.ui.gmailReplyAttachments, mode: subject.ui.gmailReplyMode,
        body: subject.$("#gmail-reply-body").value, disabled: subject.$("#send-gmail-reply").disabled
    });
}

function assertBUnchanged(subject, before) {
    assert.deepEqual(subject.backend.B, { progress: clone(progressB), history: 0 }, "B backend progress/history is unchanged");
    assert.equal(subject.writes.filter((write) => write.p_inquiry_id === "case-B").length, 0, "B has zero progress RPC writes");
    assert.equal(subject.renders.length, 0, "A sync result is never rendered into B");
    assert.deepEqual({
        case: subject.ui.currentCase, progress: subject.ui.currentProgress, preview: subject.ui.gmailReplyPreview,
        attachments: subject.ui.gmailReplyAttachments, mode: subject.ui.gmailReplyMode,
        body: subject.$("#gmail-reply-body").value, disabled: subject.$("#send-gmail-reply").disabled
    }, before, "B view and reply draft remain exactly selected");
}

const successfulSend = (expectedAttachments) => async (args, backend) => {
    assert.equal(args.action, "send_reply");
    assert.equal(args.inquiry_id, "case-A");
    assert.equal(args.mode, "estimate_submission");
    assert.equal(args.confirmation_token, "case-A-thread-A-estimate_submission-confirmation");
    assert.deepEqual(Array.from(args.attachments, (item) => item.filename), expectedAttachments);
    backend.A.history += 1;
    return { result: { linked: true, primary_link: { inquiry_id: "case-A", gmail_thread_id: "thread-A" }, messages: [] } };
};

async function test(name, run) {
    await run();
    console.log(`PASS ${name}`);
}

(async () => {
    await test("R1-A attachment wait A -> B keeps authority, write and render on A only", async () => {
        const wait = deferred();
        const attachmentInputs = [];
        const subject = createUi({
            attachmentPayload: async (attachments) => { attachmentInputs.push(attachments); await wait.promise; return attachments.map(({ file }) => ({ filename: file.name })); },
            sendReply: successfulSend(["A.pdf"])
        });
        const run = subject.ui.runManagedSend();
        const bBefore = switchToB(subject);
        wait.resolve();
        await run;
        assert.equal(attachmentInputs.length, 1);
        assert.equal(attachmentInputs[0][0].file.name, "A.pdf", "attachment read is bound before the switch");
        assert.equal(subject.backend.A.history, 1);
        assert.equal(subject.backend.A.progress.estimate_sent_on !== undefined, true);
        assert.equal(subject.writes.length, 1);
        assert.equal(subject.writes[0].p_inquiry_id, "case-A");
        assertBUnchanged(subject, bBefore);
    });

    await test("R1-B Gmail response wait A -> B updates A only and never renders B", async () => {
        const response = deferred();
        const subject = createUi({
            attachmentPayload: async (attachments) => attachments.map(({ file }) => ({ filename: file.name })),
            sendReply: async (args, backend) => { await response.promise; return successfulSend(["A.pdf"])(args, backend); }
        });
        const run = subject.ui.runManagedSend();
        const bBefore = switchToB(subject);
        response.resolve();
        await run;
        assert.equal(subject.backend.A.history, 1);
        assert.equal(subject.writes.length, 1);
        assertBUnchanged(subject, bBefore);
    });

    await test("R1-C Gmail send failure after A -> B leaves A and B stage/progress unchanged", async () => {
        const response = deferred();
        const subject = createUi({
            attachmentPayload: async (attachments) => attachments.map(({ file }) => ({ filename: file.name })),
            sendReply: async () => response.promise
        });
        const aBefore = clone(subject.backend.A);
        const run = subject.ui.runManagedSend();
        const bBefore = switchToB(subject);
        response.reject(new Error("gmail_send_503"));
        await run;
        assert.deepEqual(subject.backend.A, aBefore, "failed send does not change A stage/progress/history");
        assert.equal(subject.writes.length, 0);
        assertBUnchanged(subject, bBefore);
    });

    await test("R1-D no switch retains normal estimate-send behavior for A", async () => {
        const subject = createUi({
            attachmentPayload: async (attachments) => attachments.map(({ file }) => ({ filename: file.name })),
            sendReply: successfulSend(["A.pdf"])
        });
        await subject.ui.runManagedSend();
        assert.equal(subject.backend.A.history, 1);
        assert.equal(subject.writes.length, 1);
        assert.equal(subject.writes[0].p_inquiry_id, "case-A");
        assert.equal(subject.ui.currentProgress.inquiry_id, "case-A");
        assert.equal(subject.ui.currentProgress.estimate_sent_on !== undefined, true);
        assert.equal(subject.renders.filter((entry) => entry.type === "sync").length, 1);
        assert.equal(subject.ui.gmailReplyPreview, null);
        assert.equal(subject.ui.gmailReplyAttachments.length, 0);
        assert.equal(subject.$("#gmail-reply-body").value, "");
        assert.equal(subject.ui.gmailReplyMode, "normal");
    });

    await test("R1-E multiple attachments remain bound to A through attachment wait and B switch", async () => {
        const wait = deferred();
        const subject = createUi({
            attachments: [attachment("A-1.pdf"), attachment("A-2.pdf")],
            attachmentPayload: async (attachments) => { await wait.promise; return attachments.map(({ file }) => ({ filename: file.name })); },
            sendReply: successfulSend(["A-1.pdf", "A-2.pdf"])
        });
        const run = subject.ui.runManagedSend();
        const bBefore = switchToB(subject);
        wait.resolve();
        await run;
        assert.equal(subject.backend.A.history, 1);
        assert.equal(subject.writes.length, 1);
        assertBUnchanged(subject, bBefore);
    });

    await test("R1 identity-mismatched sync response fails closed without a B fallback", async () => {
        const response = deferred();
        const subject = createUi({
            attachmentPayload: async (attachments) => attachments.map(({ file }) => ({ filename: file.name })),
            sendReply: async (args, backend) => {
                assert.equal(args.inquiry_id, "case-A");
                await response.promise;
                backend.A.history += 1;
                return { result: { linked: true, primary_link: { inquiry_id: "case-A", gmail_thread_id: "thread-mismatch" }, messages: [] } };
            }
        });
        const run = subject.ui.runManagedSend();
        const bBefore = switchToB(subject);
        response.resolve();
        await run;
        assert.equal(subject.backend.A.history, 1, "the already-successful A send is never reassigned");
        assert.equal(subject.writes.length, 0, "mismatched sync identity blocks every progress write");
        assertBUnchanged(subject, bBefore);
    });

    await test("R1-F normal Gmail reply keeps normal behavior and does not write estimate progress", async () => {
        const subject = createUi({
            mode: "normal",
            attachmentPayload: async (attachments) => attachments.map(({ file }) => ({ filename: file.name })),
            sendReply: async (args, backend) => {
                assert.equal(args.mode, "normal");
                assert.equal(args.inquiry_id, "case-A");
                backend.A.history += 1;
                return { result: { linked: true, primary_link: { inquiry_id: "case-A", gmail_thread_id: "thread-A" }, messages: [] } };
            }
        });
        await subject.ui.runManagedSend();
        assert.equal(subject.backend.A.history, 1);
        assert.equal(subject.writes.length, 0, "normal reply does not change estimate progress");
        assert.equal(subject.renders.filter((entry) => entry.type === "sync").length, 1);
        assert.equal(subject.ui.gmailReplyMode, "normal");
    });

    console.log("PA managed estimate-send case-binding fixture: 7/7 PASS; synthetic transport only; no email sent");
})().catch((error) => {
    console.error(error.stack);
    process.exitCode = 1;
});
