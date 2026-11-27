const crypto = require('node:crypto');
const { isUuid, supabaseRequest } = require('./_pa-mail.cjs');

const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const hex = /^[a-f0-9]{64}$/u;
const idPattern = /^[A-Za-z0-9_-]{1,200}$/u;
const unknown = () => ({ state: 'unknown' });
const mailbox = addresses => addresses.map(a => String(a).trim().toLowerCase()).sort();
const ATTEMPT = 'operation_key,inquiry_id,actor_id,outbox_id,lookup_key,rfc_message_id,envelope_hash,thread_id,started_at,resend_of,resend_root,resend_number';
const operationKey = (kind, id) => hash([kind, String(id).toLowerCase()]);
const messageIdFor = key => '<pa-once-' + key + '@ara-tech.cc>';
const legacyMessageId = (kind, id) => isUuid(id) ? messageIdFor(operationKey(kind, id)) : undefined;
const snapshotKey = label => {
    const secret = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
    if (!secret) throw Error('mail_resend_unavailable');
    return crypto.createHmac('sha256', secret).update('pa-mail-resend-v1:' + label).digest();
};
function sealSnapshot(row, snapshot) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', snapshotKey('snapshot'), iv);
    cipher.setAAD(Buffer.from(row.operation_key + ':' + row.inquiry_id));
    const body = Buffer.concat([cipher.update(JSON.stringify(snapshot)), cipher.final()]);
    return [iv, cipher.getAuthTag(), body].map(bytes => bytes.toString('base64url')).join('.');
}
function openSnapshot(row) {
    try {
        const [iv, tag, body] = row.snapshot_ciphertext.split('.').map(v => Buffer.from(v, 'base64url'));
        const cipher = crypto.createDecipheriv('aes-256-gcm', snapshotKey('snapshot'), iv);
        cipher.setAAD(Buffer.from(row.operation_key + ':' + row.inquiry_id));
        cipher.setAuthTag(tag);
        return JSON.parse(Buffer.concat([cipher.update(body), cipher.final()]).toString('utf8'));
    } catch {
        throw Error('mail_resend_unavailable');
    }
}

function envelopeHash({ to, cc, subject, attachments }) {
    const files = attachments.map(a => JSON.stringify([
        String(a.original_filename || a.filename).normalize('NFC'),
        String(a.mime_type).toLowerCase(), Number(a.size)
    ])).sort();
    return hash([mailbox(to), mailbox(cc), String(subject).normalize('NFC'), files]);
}

function mailAttempt({ inquiryId, actorId, outboxId, lookupKey, legacyId, messageId, preview, attachments }) {
    if (!isUuid(inquiryId) || !isUuid(actorId) || outboxId && !isUuid(outboxId)
        || legacyId && !isUuid(legacyId) || lookupKey != null && !hex.test(lookupKey)) throw Error('invalid_mail_attempt');
    const envelope = envelopeHash({ to: [preview.recipient], cc: preview.cc_addresses || [], subject: preview.subject, attachments });
    const thread = preview.gmail_thread_id || null;
    // For direct replies, independently derive the key; a client nonce or a new
    // preview of the same content must never grant another provider invocation.
    const binding = preview.reply_source_message_id || null;
    const attachmentContent = attachments.map(a => hash([a.filename, a.mime_type, a.data])).sort();
    const key = legacyId ? operationKey('legacy-receipt', legacyId) : outboxId
        ? operationKey('outbox', outboxId)
        : hash(['reply', inquiryId.toLowerCase(), thread, binding, envelope, preview.body, attachmentContent]);
    return {
        operation_key: key, inquiry_id: inquiryId, actor_id: actorId, outbox_id: outboxId || null,
        lookup_key: lookupKey || null, rfc_message_id: messageId || messageIdFor(key),
        envelope_hash: envelope, thread_id: thread
    };
}

function freezeMailAttempt(row, snapshot) {
    if (row.outbox_id || row.lookup_key) row.snapshot_ciphertext = sealSnapshot(row, snapshot);
}

function resendAttempt(parent, actorId, snapshot) {
    const key = operationKey('owner-resend', parent.operation_key);
    const row = {
        operation_key: key, inquiry_id: parent.inquiry_id, actor_id: actorId,
        rfc_message_id: messageIdFor(key), envelope_hash: parent.envelope_hash, thread_id: parent.thread_id,
        resend_of: parent.operation_key, resend_root: parent.resend_root || parent.operation_key,
        resend_number: parent.resend_number + 1
    };
    row.snapshot_ciphertext = sealSnapshot(row, snapshot);
    return row;
}

async function reserveMailAttempt(row, fetchImpl) {
    const rows = await supabaseRequest('/rest/v1/pa_mail_send_attempts?on_conflict=operation_key&select=operation_key', {
        method: 'POST', prefer: 'return=representation,resolution=ignore-duplicates',
        body: JSON.stringify(row)
    }, fetchImpl);
    if (!Array.isArray(rows) || rows.length !== 1 || rows[0]?.operation_key !== row.operation_key) {
        throw Error('mail_outcome_unknown');
    }
    return row.rfc_message_id;
}

async function readMailAttempt({ inquiryId, actorId, outboxId, lookupKey, legacyId, latest = false, withSnapshot = false }, fetchImpl) {
    if (!isUuid(inquiryId) || (outboxId || legacyId ? !isUuid(outboxId || legacyId) : !isUuid(actorId) || !hex.test(lookupKey || ''))) {
        throw Error('invalid_mail_attempt');
    }
    const select = ATTEMPT + (withSnapshot ? ',snapshot_ciphertext' : '');
    const q = new URLSearchParams({ inquiry_id: 'eq.' + inquiryId,
        select, limit: '2' });
    if (outboxId) q.set('outbox_id', 'eq.' + outboxId);
    else if (legacyId) q.set('operation_key', 'eq.' + operationKey('legacy-receipt', legacyId));
    else {
        q.set('actor_id', 'eq.' + actorId);
        q.set('lookup_key', 'eq.' + lookupKey);
    }
    const rows = await supabaseRequest('/rest/v1/pa_mail_send_attempts?' + q, {}, fetchImpl);
    if (!Array.isArray(rows) || rows.length !== 1) return null;
    const root = rows[0];
    if (!latest) return root;
    const children = await supabaseRequest('/rest/v1/pa_mail_send_attempts?' + new URLSearchParams({
        inquiry_id: 'eq.' + inquiryId, resend_root: 'eq.' + root.operation_key,
        select, order: 'resend_number.desc', limit: '1'
    }), {}, fetchImpl);
    return children?.[0] || root;
}

async function recordMailResult(row, state, ids, fetchImpl) {
    if (state === 'sent' && ![ids?.gmail_message_id, ids?.gmail_thread_id].every(id => idPattern.test(id || ''))) throw Error('mail_outcome_unknown');
    return supabaseRequest('/rest/v1/pa_mail_send_results?on_conflict=operation_key&select=operation_key', {
        method: 'POST', prefer: 'return=representation,resolution=ignore-duplicates',
        body: JSON.stringify({ operation_key: row.operation_key, state,
            gmail_message_id: state === 'sent' ? ids.gmail_message_id : null,
            gmail_thread_id: state === 'sent' ? ids.gmail_thread_id : null })
    }, fetchImpl);
}

function signedResendApproval(row, actorId, sent, expiresAt) {
    const payload = Buffer.from(JSON.stringify([row.operation_key, actorId, sent.state, sent.gmail_message_id || null, expiresAt]));
    return payload.toString('base64url') + '.' + crypto.createHmac('sha256', snapshotKey('approval')).update(payload).digest('base64url');
}

function verifyResendApproval({ token, row, actorId, sent, now = Date.now }) {
    try {
        const [claims] = String(token || '').split('.');
        const [, , , , expiresAt] = JSON.parse(Buffer.from(claims, 'base64url').toString());
        const expected = Buffer.from(signedResendApproval(row, actorId, sent, expiresAt));
        const actual = Buffer.from(token);
        if (!Number.isSafeInteger(expiresAt) || expiresAt <= now() || expected.length !== actual.length
            || !crypto.timingSafeEqual(expected, actual)) throw Error();
    } catch {
        throw Error('mail_resend_approval_changed');
    }
}

async function matchSentAttempt(row, { list, read, normalize, now = Date.now }) {
    if (!row || !/^<pa-(?:once-[a-f0-9]{64}|e2e-[0-9a-f-]{36})@ara-tech\.cc>$/u.test(row.rfc_message_id)) return unknown();
    const start = Date.parse(row.started_at);
    // A late Gmail index is not proof of non-delivery.
    if (!Number.isFinite(start) || now() - start < 60_000) return unknown();
    try {
        const page = await list(row.rfc_message_id.slice(1, -1));
        if (!Array.isArray(page?.messages) || page.messages.length !== 1 || page.nextPageToken) return unknown();
        const id = page.messages[0]?.id;
        if (!idPattern.test(id || '')) return unknown();
        const raw = await read(id);
        const mail = normalize(raw);
        const time = Date.parse(mail.occurred_at);
        if (!raw.labelIds?.includes('SENT') || raw.labelIds.some(label => ['DRAFT', 'TRASH', 'SPAM'].includes(label))
            || mail.direction !== 'outbound' || mail.id !== id || !idPattern.test(mail.thread_id || '')
            || (row.thread_id && mail.thread_id !== row.thread_id)
            || mail.rfc_message_id !== row.rfc_message_id
            || !Number.isFinite(time) || time < start - 120_000 || time > now() + 120_000
            || envelopeHash({ to: mail.to_addresses, cc: mail.cc_addresses, subject: mail.subject,
                attachments: mail.attachments.filter(a => !a.inline) }) !== row.envelope_hash) return unknown();
        return { state: 'sent', gmail_message_id: mail.id, gmail_thread_id: mail.thread_id, sent_at: mail.occurred_at };
    } catch {
        return unknown();
    }
}

module.exports = { envelopeHash, freezeMailAttempt, legacyMessageId, mailAttempt, matchSentAttempt, openSnapshot, readMailAttempt,
    recordMailResult, reserveMailAttempt, resendAttempt, signedResendApproval, verifyResendApproval };
