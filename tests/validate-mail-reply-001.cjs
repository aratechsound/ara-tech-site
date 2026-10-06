const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(process.env.MAIL_REPLY_SOURCE || path.join(__dirname, '../js/pa-admin.js'), 'utf8');
const completionGuard = setTimeout(() => { console.error('FAIL unfinished async fixture'); process.exitCode = 1; }, 5000);
const extract = name => {
    const match = source.match(new RegExp(`^const ${name} = [\\s\\S]*?(?=^const |$(?![\\s\\S]))`, 'm'));
    assert(match, name);
    return match[0];
};
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const element = tag => {
    const classes = new Set();
    return { tag, value: '', textContent: '', srcdoc: '', hidden: true, disabled: false, dataset: {}, children: [],
        classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c),
            toggle(c, on) { if (on) classes.add(c); else classes.delete(c); } },
        replaceChildren(...nodes) { this.children = nodes; }, append(...nodes) { this.children.push(...nodes); },
        setAttribute() {}, addEventListener(type, fn) { this[type] = fn; }, focus() {}, scrollIntoView() {}, reset() {} };
};
const A = { id: 'case-A', status: 'rough_estimate', updated_at: 'A1' };
const B = { id: 'case-B', status: 'rough_estimate', updated_at: 'B1' };
const inbound = (inquiry, id, thread, recipient, subject, date = '2026-10-01T00:00:00Z') => ({
    inquiry_id: inquiry.id, id, thread_id: thread, direction: 'inbound', from_address: recipient, reply_to: recipient,
    to_addresses: ['aratechsound@gmail.com'], cc_addresses: [`${inquiry.id.toLowerCase()}-cc@example.invalid`], subject, occurred_at: date,
    attachments: []
});
const a = inbound(A, 'a-msg', 'a-thread', 'a@example.invalid', 'A subject');
const b = inbound(B, 'b-msg', 'b-thread', 'b@example.invalid', 'B subject');
const b2 = inbound(B, 'b-msg2', 'b-other-thread', 'b2@example.invalid', 'B second subject');
const fixtures = {
    [A.id]: { messages: [a], primary_link: { inquiry_id: A.id, gmail_thread_id: a.thread_id }, linked: true },
    [B.id]: { messages: [b, b2], primary_link: { inquiry_id: B.id, gmail_thread_id: b.thread_id }, linked: true }
};
Object.values(fixtures).forEach(f => { f.links = [...new Set(f.messages.map(m => m.thread_id))].map(gmail_thread_id => ({ inquiry_id: f.primary_link.inquiry_id, gmail_thread_id })); });
function harness() {
    const elements = new Map();
    const $ = key => { if (!elements.has(key)) elements.set(key, element(key)); return elements.get(key); };
    const events = { requests: [], sends: 0, fakeProviderSends: 0, resets: 0, prompts: 0 };
    const box = { $, currentCase: null, currentProgress: null, currentPayments: [], currentToken: null, currentResponse: null,
        currentDeliveries: [], currentGmailTimeline: [], currentGmailLink: null, currentMailAttention: 'none',
        gmailReplySource: null, gmailReplyContext: null, gmailReplyRevision: 0, gmailSyncSerial: 0,
        gmailReplyPreview: null, gmailReplyPreviewBinding: null, gmailReplyAttachments: [], gmailReplyMode: 'normal',
        commercialComposerOperation: null, caseSelectionSerial: 0, GMAIL_OFFICIAL_ADDRESS: 'aratechsound@gmail.com',
        document: { createElement: element, querySelectorAll: () => [] },
        window: { location: { href: 'http://fixture.invalid/pa-admin.html' }, confirm: () => { events.prompts++; return true; } },
        history: { replaceState(_a, _b, url) { box.window.location.href = String(url); } }, URL, Date,
        clearGmailAttachmentCache: () => { events.resets++; },
        getCommercialDraftContext: () => ({ caseId: box.currentCase?.id, state: {}, currentEstimate: { amount_minor: 12000 } }),
        openConfirmationPreviewForCurrentCase: () => { events.confirmation = true; },
        formatDateTime: x => x, toLocalDateTimeInput: x => x,
        gmailErrorMessage: x => x, gmailReplyAttachmentPayload: async () => [],
        renderGmailReplyPreviewAttachments: attachments => $('#gmail-reply-preview-attachments').replaceChildren(...attachments),
        fetch: () => { throw Error('NETWORK_FORBIDDEN'); },
        callGmailApi: async request => {
            events.requests.push(request);
            if (request.action === 'sync') return { result: { ...fixtures[request.inquiry_id], messages: [...fixtures[request.inquiry_id].messages] } };
            if (request.action !== 'reply_preview') { events.sends++; throw Error('SEND_FORBIDDEN'); }
            const data = fixtures[request.inquiry_id];
            const message = request.reply_source_message_id ? data.messages.find(m => m.id === request.reply_source_message_id)
                : data.messages.find(m => m.thread_id === data.primary_link.gmail_thread_id);
            return { preview: { inquiry_id: request.inquiry_id, gmail_thread_id: message.thread_id,
                reply_source_message_id: message.id, reply_source_explicit: Boolean(request.reply_source_message_id),
                recipient: message.reply_to, cc_addresses: request.cc_addresses, subject: `Re: ${message.subject}`,
                body: request.body + '\nARA-TECH signature', html: '<p>ARA-TECH fixture</p>', mode: request.mode,
                attachments: [], confirmation_token: 'fixture-token' } };
        },
        supabase: { from(table) {
            const query = { id: null, select() { return this; }, eq(_field, id) { this.id = id; return this; },
                is() { return this; }, order() { return this; }, limit() { return this; },
                single() { return box.caseLoad ? box.caseLoad(this.id) : Promise.resolve({ data: this.id === A.id ? A : B }); },
                maybeSingle() { return Promise.resolve({ data: null }); },
                then(done) { return Promise.resolve({ data: [] }).then(done); } };
            return query;
        } }
    };
    ['gmailReplyPanel','gmailCandidates','gmailSyncState','detailCard','caseStatusMessage','listStatus','caseTrashSection',
        'resultEmailSection','nextActionSection','tokenSection','caseForm','firstFormSection','firstFormDetails',
        'emailSection','contentHearingSection','resultActionPanel','currentSituationSection','progressManagementSection',
        'paymentSection','progressForm','paymentForm','automaticMailStatus','emailHistory','technicalDetails','responseDetails','auditList']
        .forEach(key => { box[key] = element(key); });
    ['renderGmailCandidates','renderEmailHistory','renderOverview','populateCaseForm','renderTokenState','renderResponse','renderAudit',
        'renderAutomaticMailStatus','renderTechnicalDetails','renderScheduleState','populateProgressManagement','clearSelectedCaseReference']
        .forEach(key => { box[key] = () => {}; });
    box.defaultConditions = '';
    const names = ['setMessage','clearMessage','invalidateGmailReplyPreview','isEstimateSubmissionMode','isCommercialComposerMode',
        'gmailReplyRecipientForMessage','gmailReplySubjectForMessage','setGmailReplyMode','openGmailReply','openEstimateSubmission',
        'openSharedComposer','renderGmailReplyAttachments','openCase','applyGmailSyncResult','syncGmail','previewGmailReply',
        'sameGmailReplyAttachments','isGmailReplySnapshotSelected','createGmailReplySendSnapshot','resetForm'];
    if (source.includes('const resetGmailReplyComposer =')) names.push('resetGmailReplyComposer','resetCaseGmailState','gmailReplyMessageKey',
        'isCurrentGmailReplyMessage','isGmailReplyContextCurrent','bindGmailReplyMessage','ensureGmailReplyContext','isGmailReplySendContextSelected');
    vm.createContext(box);
    vm.runInContext(names.map(extract).join('\n') + '\nthis.api = { openCase, openGmailReply, openSharedComposer, openEstimateSubmission, previewGmailReply, syncGmail, resetForm, createGmailReplySendSnapshot, invalidateGmailReplyPreview, applyGmailSyncResult };', box);
    const close = source.match(/const closeSelectedCase = \(\) => \{[^\n]*\};/)[0];
    vm.runInContext(close + '\nthis.api.close = closeSelectedCase;', box);
    const state = () => ({ recipient: $('#gmail-reply-recipient').value, cc: $('#gmail-reply-cc').value,
        subject: $('#gmail-reply-subject').value, body: $('#gmail-reply-body').value, mode: box.gmailReplyMode,
        source: box.gmailReplySource, context: box.gmailReplyContext, preview: box.gmailReplyPreview,
        binding: box.gmailReplyPreviewBinding, html: $('#gmail-reply-preview-frame').srcdoc, sendDisabled: $('#send-gmail-reply').disabled });
    return { box, $, events, state, api: box.api };
}
let count = 0;
async function test(name, fn) { await fn(); count++; console.log('PASS ' + name); }
const assertCurrent = (h, message, explicit = false) => {
    const state = h.state();
    assert.equal(state.recipient, message.reply_to);
    assert.equal(state.subject, `Re: ${message.subject}`);
    assert.equal(state.context?.inquiryId, message.inquiry_id);
    assert.equal(state.context?.messageId, message.id);
    assert.equal(state.context?.threadId, message.thread_id);
    assert.equal(Boolean(state.source), explicit);
    assert.equal(state.cc, message.cc_addresses.join(', '));
};
(async () => {
    for (const [from, to, first, second] of [[A,B,a,b],[B,A,b,a]]) await test(`${from.id} -> ${to.id}: real openCase + normal entry has zero previous fields`, async () => {
        const h = harness(); await h.api.openCase(from.id); h.api.openGmailReply(first);
        h.$('#gmail-reply-body').value = 'OLD BODY'; h.box.gmailReplyMode = 'invoice';
        h.box.gmailReplyAttachments = [{ file: { name: 'OLD.pdf' } }]; h.box.commercialComposerOperation = { id: 'OLD' };
        await h.api.previewGmailReply();
        await h.api.openCase(to.id); h.api.openSharedComposer('normal'); assertCurrent(h, second);
        assert.equal(h.state().body, ''); assert.equal(h.state().mode, 'normal'); assert.equal(h.state().preview, null);
        assert.equal(h.state().binding, null); assert.equal(h.state().html, ''); assert.equal(h.state().sendDisabled, true);
        assert.equal(h.box.gmailReplyAttachments.length, 0); assert.equal(h.box.commercialComposerOperation, null);
        assert(!JSON.stringify(h.state()).includes(first.reply_to)); assert.equal(h.events.sends, 0);
    });
    await test('same case: select another message/thread, normal mode preserves the explicitly selected source', async () => {
        const h = harness(); await h.api.openCase(B.id); h.api.openGmailReply(b2); assertCurrent(h, b2, true);
        h.api.openSharedComposer('normal'); assertCurrent(h, b2, true);
        h.$('#gmail-reply-body').value = 'draft'; await h.api.previewGmailReply();
        assert.equal(h.box.gmailReplyPreview.reply_source_message_id, b2.id); assert.equal(h.box.gmailReplyPreview.gmail_thread_id, b2.thread_id);
        h.api.openGmailReply(b); assertCurrent(h, b, true); assert.equal(h.state().body, '');
        assert.equal(h.state().preview, null); assert.equal(h.state().sendDisabled, true); assert.equal(h.events.prompts, 1);
    });
    await test('same thread: choose a different inbound message and reject stale detached message closures', async () => {
        const h = harness(); await h.api.openCase(B.id);
        const another = { ...b, id: 'b-earlier', subject: 'Earlier subject' }; h.box.currentGmailTimeline.push(another);
        h.api.openGmailReply(another); assertCurrent(h, another, true);
        h.api.openGmailReply(b); assertCurrent(h, b, true);
        assert.equal(h.api.openGmailReply(a), false); assertCurrent(h, b, true);
        assert.equal(h.api.openGmailReply({ ...b, inquiry_id: A.id }), false);
    });
    await test('reload: a fresh VM with a stale case URL has only the selected case reply state', async () => {
        const h = harness(); h.box.window.location.href += '?case=case-B'; await h.api.openCase(B.id);
        h.api.openSharedComposer('normal'); assertCurrent(h, b); assert.equal(h.state().body, '');
        assert.equal(new URL(h.box.window.location.href).searchParams.get('case'), B.id);
    });
    await test('list transition/close and new-case reset erase all source and DOM state', async () => {
        const h = harness(); await h.api.openCase(A.id); h.api.openGmailReply(a); h.api.close();
        assert.equal(h.state().context, null); assert.equal(h.state().source, null); assert.equal(h.state().subject, '');
        assert.equal(h.state().recipient, ''); assert.equal(h.box.currentGmailTimeline.length, 0); assert.equal(h.box.currentGmailLink, null);
        await h.api.openCase(B.id); h.api.openSharedComposer('normal'); assertCurrent(h, b);
        h.api.resetForm(); assert.equal(h.state().context, null); assert.equal(h.state().body, ''); assert.equal(h.state().sendDisabled, true);
    });
    await test('selection start clears A immediately; delayed A preview cannot arrive while B is loading', async () => {
        const h = harness(); await h.api.openCase(A.id); h.$('#gmail-reply-body').value = 'A draft';
        const preview = deferred(), load = deferred(); const original = h.box.callGmailApi;
        h.box.callGmailApi = req => req.action === 'reply_preview' ? preview.promise : original(req);
        const pending = h.api.previewGmailReply(); await Promise.resolve();
        h.box.caseLoad = () => load.promise; const opening = h.api.openCase(B.id);
        assert.equal(h.box.currentCase, null); assert.equal(h.state().recipient, '');
        preview.resolve({ preview: { inquiry_id: A.id } }); await pending; assert.equal(h.state().preview, null);
        load.resolve({ data: B }); await opening; assertCurrent(h, b);
    });
    await test('delayed sync A cannot replace B; overlapping same-case sync uses only newest response', async () => {
        const h = harness(); await h.api.openCase(A.id); const late = deferred(); const original = h.box.callGmailApi;
        h.box.callGmailApi = () => late.promise; const pending = h.api.syncGmail();
        h.box.callGmailApi = original; await h.api.openCase(B.id); late.resolve({ result: fixtures[A.id] }); await pending; assertCurrent(h, b);
        const one = deferred(), two = deferred(); let n = 0;
        h.box.callGmailApi = () => (++n === 1 ? one.promise : two.promise);
        const oldSync = h.api.syncGmail(), newSync = h.api.syncGmail();
        two.resolve({ result: fixtures[B.id] }); await newSync;
        one.resolve({ result: fixtures[A.id] }); await oldSync; assertCurrent(h, b);
    });
    await test('delayed preview after other-thread selection or close is discarded', async () => {
        for (const action of ['thread', 'close']) {
            const h = harness(); await h.api.openCase(B.id); h.$('#gmail-reply-body').value = 'draft';
            const late = deferred(); h.box.callGmailApi = () => late.promise; const pending = h.api.previewGmailReply(); await Promise.resolve();
            if (action === 'thread') h.api.openGmailReply(b2); else h.api.close();
            late.resolve({ preview: { inquiry_id: B.id } }); await pending;
            assert.equal(h.state().preview, null); assert.equal(h.state().sendDisabled, true);
        }
    });
    await test('wrong-case link and unowned thread sync results cannot become selectable reply sources', async () => {
        const h = harness(); await h.api.openCase(B.id);
        assert.throws(() => h.api.applyGmailSyncResult(fixtures[A.id]), /invalid_gmail_reply_binding/);
        assert.throws(() => h.api.applyGmailSyncResult({ ...fixtures[B.id], messages: [...fixtures[B.id].messages, a] }), /invalid_gmail_reply_binding/);
        assertCurrent(h, b);
    });
    await test('two previews of the same draft accept only the most recent request', async () => {
        const h = harness(); await h.api.openCase(B.id); h.$('#gmail-reply-body').value = 'draft';
        const first = deferred(), second = deferred(), firstStarted = deferred(), secondStarted = deferred(); const original = h.box.callGmailApi; let calls = 0;
        h.box.callGmailApi = () => { if (++calls === 1) { firstStarted.resolve(); return first.promise; } secondStarted.resolve(); return second.promise; };
        const oldPreview = h.api.previewGmailReply(); await firstStarted.promise;
        const newPreview = h.api.previewGmailReply(); await secondStarted.promise;
        const response = await original({ action: 'reply_preview', inquiry_id: B.id, body: 'draft', mode: 'normal', cc_addresses: b.cc_addresses });
        second.resolve(response); await newPreview; assert.equal(h.state().preview.confirmation_token, 'fixture-token');
        first.resolve({ preview: { inquiry_id: A.id } }); await oldPreview; assert.equal(h.state().preview.confirmation_token, 'fixture-token');
    });
    await test('edit/revert cannot resurrect an older preview; wrong-case/thread/source/To/subject response fails closed', async () => {
        for (const field of ['inquiry_id','gmail_thread_id','reply_source_message_id','recipient','subject']) {
            const h = harness(); await h.api.openCase(B.id); h.$('#gmail-reply-body').value = 'draft'; const original = h.box.callGmailApi;
            h.box.callGmailApi = async req => { const response = await original(req); response.preview[field] = 'WRONG'; return response; };
            await h.api.previewGmailReply(); assert.equal(h.state().preview, null); assert.equal(h.state().sendDisabled, true);
        }
        const h = harness(); await h.api.openCase(B.id); h.$('#gmail-reply-body').value = 'draft'; const original = h.box.callGmailApi, late = deferred();
        h.box.callGmailApi = () => late.promise; const pending = h.api.previewGmailReply(); await Promise.resolve();
        h.api.invalidateGmailReplyPreview(); late.resolve(await original({ action: 'reply_preview', inquiry_id: B.id, body: 'draft', mode: 'normal', cc_addresses: [] }));
        await pending; assert.equal(h.state().preview, null);
    });
    await test('current preview binding rejects source/recipient/CC drift and permits valid fake snapshot only', async () => {
        const h = harness(); await h.api.openCase(B.id); h.$('#gmail-reply-body').value = 'draft'; await h.api.previewGmailReply();
        assert.equal(h.api.createGmailReplySendSnapshot().replySourceMessageId, b.id);
        h.$('#gmail-reply-cc').value = 'wrong@example.invalid'; assert.throws(() => h.api.createGmailReplySendSnapshot(), /invalid_gmail_reply_binding/);
        h.$('#gmail-reply-cc').value = b.cc_addresses[0]; h.$('#gmail-reply-recipient').value = a.reply_to;
        assert.throws(() => h.api.createGmailReplySendSnapshot(), /invalid_gmail_reply_binding/); assert.equal(h.events.sends, 0);
    });
    await test('direct affected modes preserve source/body/attachments; confirmation retains dedicated route', async () => {
        const h = harness(); await h.api.openCase(B.id); h.api.openGmailReply(b2); h.$('#gmail-reply-body').value = 'draft';
        const attachment = { file: { name: 'fixture.pdf' } }; h.box.gmailReplyAttachments = [attachment];
        h.api.openSharedComposer('invoice'); assertCurrent(h, b2, true); assert.equal(h.state().body, 'draft'); assert.equal(h.box.gmailReplyAttachments[0], attachment);
        h.api.openEstimateSubmission(); assertCurrent(h, b2, true); assert.equal(h.state().mode, 'estimate_submission');
        h.api.openSharedComposer('normal'); assert.equal(h.state().body, 'draft'); assert.equal(h.box.gmailReplyAttachments[0], attachment);
        h.api.openSharedComposer('confirmation'); assert.equal(h.events.confirmation, true);
    });
    await test('outbound-only primary thread initializes its customer To; unlinked case clears the composer', async () => {
        const h = harness(); await h.api.openCase(A.id);
        const outbound = { ...a, id: 'a-delivery', direction: 'outbound', from_address: 'aratechsound@gmail.com', reply_to: '', to_addresses: ['a@example.invalid'], cc_addresses: [] };
        h.api.applyGmailSyncResult({ ...fixtures[A.id], messages: [outbound] });
        h.api.openSharedComposer('normal'); assert.equal(h.state().recipient, 'a@example.invalid');
        assert.equal(h.state().context.messageId, 'a-delivery'); assert.equal(h.state().source, null);
        h.api.applyGmailSyncResult({ linked: false, messages: [] });
        assert.equal(h.state().recipient, ''); assert.equal(h.state().subject, ''); assert.equal(h.state().context, null); assert.equal(h.state().sendDisabled, true);
    });
    assert.equal(count, 15);
    console.log(JSON.stringify({ task: 'MAIL-REPLY-001', passed: count, actualEMAIL_SENT: 0, fakeProviderSend: 0,
        fixtureNetwork: 'forbidden', scenarios: 'A→B/B→A/same-case other-thread/same-thread/reload/list/selection-loading/preview and sync races/modes/source binding' }));
})().catch(e => { console.error(e.stack); process.exitCode = 1; }).finally(() => clearTimeout(completionGuard));
