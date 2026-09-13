const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createFixture } = require('./helpers/pa-contract-fixture.cjs');
const { read } = require('./helpers/pa-estimate-fixture.cjs');
const { sha } = require('../api/_pa-contract-pdf.cjs');

global.fetch = async () => { throw Error('LIVE_NETWORK_FORBIDDEN'); };
const call = async (db, name, args) => (await db.query(
  `select public.${name}(${Object.keys(args).map((key, index) => `${key} => $${index + 1}`).join(',')}) result`,
  Object.values(args)
)).rows[0].result;
const apply = db => db.exec(
  read('20260913110000_pa_case_management_v5.sql') + '\n'
  + read('20260913130000_pa_case_management_v5_r1.sql') + '\n'
  + read('20260913170000_pa_case_management_v5_payment_race.sql')
);
const finish = async (db, actor, job, message = crypto.randomUUID()) => {
  const lease = crypto.randomUUID();
  await call(db, 'pa_v5_outbox_claim', { p_actor: actor, p_job: job, p_lease: lease });
  await call(db, 'pa_v5_outbox_finish', { p_actor: actor, p_job: job, p_lease: lease, p_state: 'sent', p_message: message, p_thread: 'thread_123', p_error: null });
};

async function recoveryAndReminder() {
  const fixture = await createFixture();
  const { db, actorId, inquiryId, quote } = fixture;
  try {
    await apply(db);
    const recoveryOperation = crypto.randomUUID();
    const recovery = await call(db, 'pa_v5_import_sent_estimate', {
      p_actor: actorId, p_case: inquiryId, p_expected_revision: 0, p_expected_current: null,
      p_operation: recoveryOperation, p_mode: 'current', p_document_id: crypto.randomUUID(),
      p_filename: 'final-estimate.pdf', p_content_base64: quote.toString('base64'), p_sha256: sha(quote),
      p_amount_minor: 110000, p_currency: 'JPY', p_tax_basis: 'tax_included', p_conditions: { source: 'fixture' },
      p_gmail_message_id: 'direct_sent_001', p_gmail_attachment_id: 'attachment_1'
    });
    assert.equal(recovery.current, true);
    assert.equal((await call(db, 'pa_v5_import_sent_estimate', {
      p_actor: actorId, p_case: inquiryId, p_expected_revision: 1, p_expected_current: recovery.id,
      p_operation: crypto.randomUUID(), p_mode: 'historical', p_document_id: crypto.randomUUID(),
      p_filename: 'final-estimate.pdf', p_content_base64: quote.toString('base64'), p_sha256: sha(quote),
      p_amount_minor: 110000, p_currency: 'JPY', p_tax_basis: 'tax_included', p_conditions: { source: 'fixture' },
      p_gmail_message_id: 'direct_sent_001', p_gmail_attachment_id: 'attachment_1'
    })).duplicate, true);
    await assert.rejects(call(db, 'pa_v5_import_sent_estimate', {
      p_actor: actorId, p_case: inquiryId, p_expected_revision: 1, p_expected_current: recovery.id,
      p_operation: recoveryOperation, p_mode: 'historical', p_document_id: crypto.randomUUID(),
      p_filename: 'final-estimate.pdf', p_content_base64: quote.toString('base64'), p_sha256: sha(quote),
      p_amount_minor: 110000, p_currency: 'JPY', p_tax_basis: 'tax_included', p_conditions: { source: 'fixture' },
      p_gmail_message_id: 'other_message', p_gmail_attachment_id: 'attachment_1'
    }), /idempotency_payload_mismatch/);

    const offer = crypto.randomUUID();
    const confirmation = await call(db, 'pa_v5_issue_confirmation', {
      p_actor: actorId, p_case: inquiryId, p_expected_revision: 1, p_estimate: recovery.id,
      p_offer: offer, p_operation: crypto.randomUUID(), p_token_hash: sha('r'.repeat(64)),
      p_secret_envelope: 'r1-encrypted-original-secret-000000000000000000000000000000000000', p_snapshot: { event_name: 'R1 fixture', event_date: '2026-10-18', amount_minor: 110000 },
      p_recipient: 'customer@example.invalid', p_subject: 'R1 confirmation', p_body: 'Confirm {{CONFIRMATION_URL}}', p_reply_binding: { thread_id: 'thread_123' }
    });
    await finish(db, actorId, confirmation.outbox_id);
    const reminderOperation = crypto.randomUUID();
    const reminder = await call(db, 'pa_v5_queue_confirmation_reminder', {
      p_actor: actorId, p_case: inquiryId, p_offer: offer, p_expected_revision: 1,
      p_operation: reminderOperation, p_subject: 'Same confirmation reminder', p_body: 'Same identity {{CONFIRMATION_URL}}', p_reply_binding: { thread_id: 'thread_123' }
    });
    assert.equal(reminder.same_confirmation_identity, true);
    assert.equal((await call(db, 'pa_v5_queue_confirmation_reminder', {
      p_actor: actorId, p_case: inquiryId, p_offer: offer, p_expected_revision: 1,
      p_operation: reminderOperation, p_subject: 'Same confirmation reminder', p_body: 'Same identity {{CONFIRMATION_URL}}', p_reply_binding: { thread_id: 'thread_123' }
    })).already_committed, true);
    const secrets = (await db.query("select distinct secret_envelope from public.pa_commercial_outbox where aggregate_id=$1 and job_kind in ('confirmation','confirmation_reminder')", [offer])).rows;
    assert.deepEqual(secrets.map(row => row.secret_envelope), ['r1-encrypted-original-secret-000000000000000000000000000000000000']);
    await db.query("update public.pa_gmail_message_index set attachment_metadata=attachment_metadata || $1::jsonb where inquiry_id=$2 and gmail_message_id='direct_sent_001'", [JSON.stringify([{ id: 'attachment_2', filename: 'revised-estimate.pdf', mime_type: 'application/pdf' }]), inquiryId]);
    const replacement = await call(db, 'pa_v5_import_sent_estimate', {
      p_actor: actorId, p_case: inquiryId, p_expected_revision: 1, p_expected_current: recovery.id,
      p_operation: crypto.randomUUID(), p_mode: 'current', p_document_id: crypto.randomUUID(),
      p_filename: 'revised-estimate.pdf', p_content_base64: quote.toString('base64'), p_sha256: sha(quote),
      p_amount_minor: 120000, p_currency: 'JPY', p_tax_basis: 'tax_included', p_conditions: { source: 'fixture revised' },
      p_gmail_message_id: 'direct_sent_001', p_gmail_attachment_id: 'attachment_2'
    });
    assert.equal(replacement.revoked_confirmations, 1, 'current switch and pending revocation commit together');
    const corrected = await call(db, 'pa_v5_correct_estimate_import', {
      p_actor: actorId, p_case: inquiryId, p_estimate: recovery.id, p_expected_revision: 2,
      p_operation: crypto.randomUUID(), p_reason: 'Wrong amount discovered against original'
    });
    assert.equal(corrected.revision, 3);
    assert.equal((await db.query('select state from public.pa_contract_tokens where offer_id=$1', [offer])).rows[0].state, 'revoked');
    const cancelledReminder = await call(db, 'pa_v5_outbox_claim', { p_actor: actorId, p_job: reminder.outbox_id, p_lease: crypto.randomUUID() });
    assert.equal(cancelledReminder.state, 'cancelled', 'revoked confirmation reminder cannot reach transport later');
    assert.equal((await db.query('select current_estimate_revision_id from public.pa_case_commercial_state where inquiry_id=$1', [inquiryId])).rows[0].current_estimate_revision_id, replacement.id, 'historical correction does not rewind current');
  } finally { await db.close(); }
}

async function acceptedChangeOrder() {
  const fixture = await createFixture();
  const { db, actorId, inquiryId, quote } = fixture;
  try {
    await apply(db);
    const issue = await call(db, 'pa_v5_issue_estimate', {
      p_actor: actorId, p_case: inquiryId, p_expected_revision: 0, p_expected_current: null,
      p_operation: crypto.randomUUID(), p_document_id: crypto.randomUUID(), p_filename: 'base.pdf', p_mime: 'application/pdf',
      p_content_base64: quote.toString('base64'), p_sha256: sha(quote), p_amount_minor: 110000, p_currency: 'JPY',
      p_tax_basis: 'tax_included', p_conditions: { base: true }, p_source_kind: 'managed_send', p_source_sent_at: null,
      p_recipient: 'customer@example.invalid', p_subject: 'Base', p_body: 'Base estimate', p_reply_binding: { thread_id: 'thread_123' }
    });
    await finish(db, actorId, issue.outbox_id);
    const offer = crypto.randomUUID(); const token = 'c'.repeat(64);
    const confirmation = await call(db, 'pa_v5_issue_confirmation', {
      p_actor: actorId, p_case: inquiryId, p_expected_revision: 1, p_estimate: issue.id, p_offer: offer,
      p_operation: crypto.randomUUID(), p_token_hash: sha(token), p_secret_envelope: 'r1-contract-secret-0000000000000000000000000000000000000000',
      p_snapshot: { event_name: 'R1 accepted', event_date: '2026-10-18', amount_minor: 110000 },
      p_recipient: 'customer@example.invalid', p_subject: 'Confirm', p_body: 'Confirm', p_reply_binding: { thread_id: 'thread_123' }
    });
    await finish(db, actorId, confirmation.outbox_id);
    const offerRow = (await db.query('select snapshot_sha256 from public.pa_contract_offers where id=$1', [offer])).rows[0];
    await call(db, 'pa_contract_accept', { p_token_hash: sha(token), p_offer_id: offer, p_snapshot_sha256: offerRow.snapshot_sha256, p_name: 'R1 Customer', p_agree: true });
    const change = await call(db, 'pa_v5_create_change_proposal', {
      p_actor: actorId, p_case: inquiryId, p_expected_revision: 1, p_operation: crypto.randomUUID(), p_contract: offer,
      p_estimate: crypto.randomUUID(), p_document: crypto.randomUUID(), p_filename: 'change.pdf', p_content_base64: quote.toString('base64'),
      p_sha256: sha(quote), p_amount_minor: 15000, p_currency: 'JPY', p_tax_basis: 'tax_included', p_conditions: { change: 'extra operator' },
      p_recipient: 'customer@example.invalid', p_subject: 'Change proposal', p_body: 'Change proposal', p_reply_binding: { thread_id: 'thread_123' }
    });
    assert.equal((await db.query('select count(*)::int n from public.pa_contracts where id=$1', [offer])).rows[0].n, 1, 'accepted contract is preserved');
    await assert.rejects(call(db, 'pa_v5_confirm_fulfillment_and_settlement', { p_actor: actorId, p_case: inquiryId, p_expected_revision: 2, p_operation: crypto.randomUUID(), p_amount_minor: 125000, p_unresolved: false, p_evidence: { source: 'fixture' } }), /unresolved_change_orders/);
    await finish(db, actorId, change.outbox_id);
    const agreed = await call(db, 'pa_v5_record_change_agreement', {
      p_actor: actorId, p_case: inquiryId, p_change: change.id, p_expected_revision: 2, p_operation: crypto.randomUUID(),
      p_evidence: { source: 'customer_email', reference: 'gmail:r1-change-accept' }
    });
    assert.equal(agreed.agreed_amount_minor, 15000);
    const prepaymentOperation = crypto.randomUUID();
    const prepaymentArgs = {
      p_actor: actorId, p_case: inquiryId, p_operation: prepaymentOperation,
      p_payment_date: '2026-10-10', p_amount_minor: 126000, p_method: 'bank_transfer', p_memo: 'verified full prepayment with correction'
    };
    const prepayment = await call(db, 'pa_v5_record_prepayment', prepaymentArgs);
    assert.ok(prepayment.id);
    assert.equal((await call(db, 'pa_v5_record_prepayment', prepaymentArgs)).already_committed, true, 'same prepayment operation does not double count');
    await assert.rejects(call(db, 'pa_v5_record_prepayment', { ...prepaymentArgs, p_amount_minor: 125000 }), /idempotency_payload_mismatch/);
    const adjustment = await call(db, 'pa_v5_adjust_payment', {
      p_actor: actorId, p_case: inquiryId, p_billing: null, p_payment: prepayment.id,
      p_operation: crypto.randomUUID(), p_delta_minor: -1000, p_reason: 'owner corrected prepayment amount before billing'
    });
    assert.ok(adjustment.id);
    const settled = await call(db, 'pa_v5_confirm_fulfillment_and_settlement', {
      p_actor: actorId, p_case: inquiryId, p_expected_revision: 3, p_operation: crypto.randomUUID(),
      p_amount_minor: 125000, p_unresolved: false, p_evidence: { source: 'owner_fixture_review' }
    });
    assert.equal(settled.final_settlement_minor, 125000);
    const invoiceDocument = crypto.randomUUID();
    const billing = await call(db, 'pa_v5_create_billing', {
      p_actor: actorId, p_case: inquiryId, p_expected_revision: 4, p_operation: crypto.randomUUID(), p_contract: offer, p_estimate: issue.id,
      p_amount_minor: 125000, p_policy: 'separate_pdf', p_document_id: invoiceDocument, p_filename: 'invoice.pdf', p_content_base64: quote.toString('base64'), p_sha256: sha(quote),
      p_due: '2026-11-30', p_due_basis: { status: 'agreed', source: 'fixture contract evidence' }, p_customer_planned: null,
      p_evidence: { source: 'fixture invoice document' }, p_recipient: 'customer@example.invalid', p_subject: 'Invoice fixture', p_body: 'Fixture invoice, no external delivery', p_reply_binding: { thread_id: 'thread_123' }
    });
    assert.ok(billing.outbox_id);
    await finish(db, actorId, billing.outbox_id);
    const billingRow = (await db.query('select due_date,invoice_delivery_state from public.pa_billings where id=$1', [billing.id])).rows[0];
    assert.equal(billingRow.due_date.toISOString().slice(0, 10), '2026-11-30');
    assert.equal(billingRow.invoice_delivery_state, 'sent');
    assert.equal((await call(db, 'pa_v5_outbox_claim', { p_actor: actorId, p_job: billing.outbox_id, p_lease: crypto.randomUUID() })).already_committed, true);
    assert.equal((await db.query('select due_date from public.pa_billings where id=$1', [billing.id])).rows[0].due_date.toISOString().slice(0, 10), '2026-11-30', 'document resend does not extend the agreed due date');
    const applied = (await db.query('select billing_id from public.pa_payment_records where id=$1', [prepayment.id])).rows[0];
    assert.equal(applied.billing_id, billing.id, 'prepayment is atomically bound when billing is created');
    assert.equal((await db.query('select billing_id from public.pa_payment_adjustments where id=$1', [adjustment.id])).rows[0].billing_id, null, 'append-only prepayment correction is not rewritten');
    const closeOperation = crypto.randomUUID();
    const closed = await call(db, 'pa_v5_payment_and_close', {
      p_actor: actorId, p_case: inquiryId, p_billing: billing.id, p_expected_revision: 4, p_operation: closeOperation,
      p_payment_date: null, p_new_payment_minor: 0, p_method: null, p_memo: 'full prepayment and fulfillment verified'
    });
    assert.equal(closed.confirmed_total_minor, 125000, 'full prepayment closes only after fulfillment, settlement and billing');
    assert.equal((await call(db, 'pa_v5_payment_and_close', {
      p_actor: actorId, p_case: inquiryId, p_billing: billing.id, p_expected_revision: 4, p_operation: closeOperation,
      p_payment_date: null, p_new_payment_minor: 0, p_method: null, p_memo: 'full prepayment and fulfillment verified'
    })).already_committed, true);
    await db.exec('set role anon');
    try {
      await assert.rejects(db.query("select public.pa_v5_record_prepayment($1,$2,$3,$4,$5,$6,$7)", [
        actorId, inquiryId, crypto.randomUUID(), '2026-10-11', 1, 'bank_transfer', 'must not execute'
      ]), /permission denied/);
    } finally { await db.exec('reset role'); }
  } finally { await db.close(); }
}

(async () => {
  await recoveryAndReminder();
  await acceptedChangeOrder();
  console.log('PASS PA-EST-004R1 DB: recovery, reminder, accepted-contract-safe change, corrected full prepayment, atomic billing bind and close');
})().catch(error => { console.error(error); process.exitCode = 1; });
