const crypto = require('node:crypto');
const { isUuid, supabaseRequest } = require('./_pa-mail.cjs');

const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const hex = /^[a-f0-9]{64}$/u;
const idPattern = /^[A-Za-z0-9_-]{1,200}$/u;
const unknown = () => ({ state: 'unknown' });
const mailbox = addresses => addresses.map(a => String(a).trim().toLowerCase()).sort();

function envelopeHash({ to, cc, subject, attachments }) {
    const files = attachments.map(a => JSON.stringify([
        String(a.original_filename || a.filename).normalize('NFC'),
        String(a.mime_type).toLowerCase(), Number(a.size)
    ])).sort();
    return hash([mailbox(to), mailbox(cc), String(subject).normalize('NFC'), files]);
}

function mailAttempt({ inquiryId, actorId, outboxId, lookupKey, messageId, preview, attachments }) {
    if (!isUuid(inquiryId) || !isUuid(actorId) || outboxId && !isUuid(outboxId)
        || lookupKey != null && !hex.test(lookupKey)) throw Error('invalid_mail_attempt');
    const envelope = envelopeHash({ to: [preview.recipient], cc: preview.cc_addresses || [], subject: preview.subject, attachments });
    const thread = preview.gmail_thread_id || null;
    // For direct replies, independently derive the key; a client nonce or a new
    // preview of the same content must never grant another provider invocation.
    const binding = preview.reply_source_message_id || null;
    const attachmentContent = attachments.map(a => hash([a.filename, a.mime_type, a.data])).sort();
    const key = outboxId
        ? hash(['outbox', outboxId.toLowerCase()])
        : hash(['reply', inquiryId.toLowerCase(), thread, binding, envelope, preview.body, attachmentContent]);
    return {
        operation_key: key, inquiry_id: inquiryId, actor_id: actorId, outbox_id: outboxId || null,
        lookup_key: lookupKey || null, rfc_message_id: messageId || '<pa-once-' + key + '@ara-tech.cc>',
        envelope_hash: envelope, thread_id: thread
    };
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

async function readMailAttempt({ inquiryId, actorId, outboxId, lookupKey }, fetchImpl) {
    if (!isUuid(inquiryId) || (outboxId ? !isUuid(outboxId) : !isUuid(actorId) || !hex.test(lookupKey || ''))) {
        throw Error('invalid_mail_attempt');
    }
    const q = new URLSearchParams({ inquiry_id: 'eq.' + inquiryId,
        select: 'rfc_message_id,envelope_hash,thread_id,started_at', limit: '2' });
    if (outboxId) q.set('outbox_id', 'eq.' + outboxId);
    else {
        q.set('actor_id', 'eq.' + actorId);
        q.set('lookup_key', 'eq.' + lookupKey);
    }
    const rows = await supabaseRequest('/rest/v1/pa_mail_send_attempts?' + q, {}, fetchImpl);
    return Array.isArray(rows) && rows.length === 1 ? rows[0] : null;
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

module.exports = { envelopeHash, mailAttempt, matchSentAttempt, readMailAttempt, reserveMailAttempt };
