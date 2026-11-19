const assert = require('node:assert/strict');
const { createFixture, actor } = require('./helpers/ara-case-fixture.cjs');
const { mailAttempt, matchSentAttempt, readMailAttempt, reserveMailAttempt } = require('../api/_pa-send-once.cjs');
const { assertMailResendOwner } = require('../api/_pa-mail.cjs');

const inquiryId = 'cef47a96-3145-4ccb-83c9-6e83643f4001';
const otherActor = 'cef47a96-3145-4ccb-83c9-6e83643f4002';
const lookupKey = 'a'.repeat(64);
const preview = {
    recipient: 'buyer@example.invalid', cc_addresses: [], subject: 'Re: テスト',
    body: 'Isolated test', gmail_thread_id: 'thread-fixture', reply_source_message_id: 'source-fixture'
};
const attachments = [
    { filename: '資料.pdf', mime_type: 'application/pdf', size: 3, data: 'YWJj' },
    { filename: 'notes.txt', mime_type: 'text/plain', size: 2, data: 'YWU' }
];
const attempt = mailAttempt({ inquiryId, actorId: actor, lookupKey, preview, attachments });

async function checkReservation() {
    const f = await createFixture();
    try {
        const repeat = mailAttempt({
            inquiryId, actorId: otherActor, lookupKey: 'b'.repeat(64),
            preview, attachments: [...attachments].reverse()
        });
        assert.equal(repeat.operation_key, attempt.operation_key);
        assert.notEqual(mailAttempt({ inquiryId, actorId: actor, preview: { ...preview, body: 'new text' }, attachments }).operation_key, attempt.operation_key);
        const trials = await Promise.allSettled([attempt, repeat].map(row => reserveMailAttempt(row, f.fetchImpl)));
        assert.equal(trials.filter(r => r.status === 'fulfilled').length, 1);
        assert.equal(trials.find(r => r.status === 'rejected').reason.message, 'mail_outcome_unknown');
        const winner = trials[0].status === 'fulfilled' ? attempt : repeat;
        assert.equal((await readMailAttempt({ inquiryId, actorId: winner.actor_id, lookupKey: winner.lookup_key }, f.fetchImpl)).rfc_message_id, attempt.rfc_message_id);
        assert.equal(await readMailAttempt({ inquiryId, actorId: otherActor, lookupKey }, f.fetchImpl), null);
        const acl = await f.db.query(`
            select has_table_privilege('anon', 'pa_mail_send_attempts', 'select') as anon_read,
                   has_table_privilege('authenticated', 'pa_mail_send_attempts', 'insert') as auth_write,
                   has_table_privilege('service_role', 'pa_mail_send_attempts', 'update') as service_update
        `);
        assert.deepEqual(acl.rows, [{ anon_read: false, auth_write: false, service_update: false }]);
        assert.equal(f.state.sendCount, 0);
    } finally {
        await f.db.close();
    }
}

async function checkReadback() {
    const start = Date.parse('2026-01-01T00:00:00Z');
    const stored = { ...attempt, started_at: new Date(start).toISOString() };
    const id = 'gmail-fixture';
    const evidence = {
        direction: 'outbound', id, thread_id: preview.gmail_thread_id, subject: preview.subject,
        rfc_message_id: attempt.rfc_message_id, occurred_at: new Date(start + 1000).toISOString(),
        to_addresses: [preview.recipient], cc_addresses: [], attachments
    };
    let searches = 0;
    const single = { messages: [{ id }] };
    const deps = {
        now: () => start + 60_000,
        list: async query => { searches++; assert.equal(query, attempt.rfc_message_id.slice(1, -1)); return single; },
        read: async candidate => { assert.equal(candidate, id); return { labelIds: ['SENT'] }; },
        normalize: () => evidence
    };
    assert.deepEqual(await matchSentAttempt(stored, { ...deps, now: () => start + 59_999 }), { state: 'unknown' });
    assert.equal(searches, 0);
    assert.deepEqual(await matchSentAttempt(stored, deps), {
        state: 'sent', gmail_message_id: id, gmail_thread_id: evidence.thread_id, sent_at: evidence.occurred_at
    });
    for (const list of [async () => ({}), async () => ({ messages: [{ id }, { id: 'another' }] }),
        async () => ({ ...single, nextPageToken: 'more' }), async () => { throw Error('permission denied'); }]) {
        assert.deepEqual(await matchSentAttempt(stored, { ...deps, list }), { state: 'unknown' });
    }
    for (const change of [{ to_addresses: ['other@example.invalid'] }, { subject: 'Fallback' },
        { thread_id: 'wrong-thread' }, { rfc_message_id: '<unrelated@example.invalid>' },
        { occurred_at: '2025-12-31T20:00:00Z' }, { attachments: [] }, { direction: 'inbound' }]) {
        assert.deepEqual(await matchSentAttempt(stored, { ...deps, normalize: () => ({ ...evidence, ...change }) }), { state: 'unknown' });
    }
    for (const labelIds of [[], ['SENT', 'TRASH']]) {
        assert.deepEqual(await matchSentAttempt(stored, { ...deps, read: async () => ({ labelIds }) }), { state: 'unknown' });
    }
}

async function main() {
    process.env.PA_MAIL_OWNER_USER_ID = actor;
    assert.throws(() => assertMailResendOwner(otherActor, true), /retry_not_allowed/);
    assert.throws(() => assertMailResendOwner(actor, false), /retry_not_allowed/);
    assert.doesNotThrow(() => assertMailResendOwner(actor, true));
    delete process.env.PA_MAIL_OWNER_USER_ID;
    assert.throws(() => assertMailResendOwner(actor, true), /retry_not_allowed/);
    await checkReservation();
    await checkReadback();
    console.log('PASS send reservation race, RLS, SENT readback, false matches, owner gate; real sends 0');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
