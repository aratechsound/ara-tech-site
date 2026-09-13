const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createFixture } = require('./helpers/pa-contract-fixture.cjs');
const { read } = require('./helpers/pa-estimate-fixture.cjs');
const { sha } = require('../api/_pa-contract-pdf.cjs');

global.fetch = async () => { throw Error('LIVE_NETWORK_FORBIDDEN'); };

const call = async (db, name, args) => {
  const values = Object.values(args);
  const names = Object.keys(args);
  const sql = `select public.${name}(${names.map((key, index) => `${key} => $${index + 1}`).join(',')}) result`;
  return (await db.query(sql, values)).rows[0].result;
};

async function main() {
  const fixture = await createFixture();
  const { db, actorId, inquiryId, quote } = fixture;
  try {
    await db.exec(read('20260913110000_pa_case_management_v5.sql'));
    const common = {
      p_actor: actorId,
      p_case: inquiryId,
      p_expected_revision: 0,
      p_expected_current: null,
      p_operation: crypto.randomUUID(),
      p_document_id: crypto.randomUUID(),
      p_filename: 'estimate-v1.pdf',
      p_mime: 'application/pdf',
      p_content_base64: quote.toString('base64'),
      p_sha256: sha(quote),
      p_amount_minor: 110000,
      p_currency: 'JPY',
      p_tax_basis: 'tax_included',
      p_conditions: { payment: 'fixture explicit terms' },
      p_source_kind: 'managed_send',
      p_source_sent_at: '2026-09-13T01:00:00Z',
      p_recipient: 'customer@example.invalid',
      p_subject: 'Fixture estimate',
      p_body: 'Fixture only. No external delivery.',
      p_reply_binding: { thread_id: 'thread_123', message_id: 'direct_sent_001' }
    };
    const estimate1 = await call(db, 'pa_v5_issue_estimate', common);
    assert.equal(estimate1.revision_number, 1);
    assert.equal((await call(db, 'pa_v5_issue_estimate', common)).already_committed, true);
    let rows = (await db.query('select state from public.pa_commercial_outbox where id=$1', [estimate1.outbox_id])).rows;
    assert.equal(rows[0].state, 'queued');
    const lease1 = crypto.randomUUID();
    await call(db, 'pa_v5_outbox_claim', { p_actor: actorId, p_job: estimate1.outbox_id, p_lease: lease1 });
    await call(db, 'pa_v5_outbox_finish', { p_actor: actorId, p_job: estimate1.outbox_id, p_lease: lease1, p_state: 'sent', p_message: 'fixture-message-1', p_thread: 'thread_123', p_error: null });

    const offer1 = crypto.randomUUID();
    const confirmation1 = await call(db, 'pa_v5_issue_confirmation', {
      p_actor: actorId, p_case: inquiryId, p_expected_revision: 1, p_estimate: estimate1.id,
      p_offer: offer1, p_operation: crypto.randomUUID(), p_token_hash: sha('a'.repeat(64)),
      p_secret_envelope: 'fixture-encrypted-envelope-not-a-live-token-0001',
      p_snapshot: { event_name: 'Fixture event', event_date: '2026-10-18', recipient: 'customer@example.invalid' },
      p_recipient: 'customer@example.invalid', p_subject: 'Fixture confirmation', p_body: 'Fixture confirmation body',
      p_reply_binding: { thread_id: 'thread_123' }
    });
    assert.equal(confirmation1.version, 1);
    const started = await call(db, 'pa_v5_begin_estimate_revision', {
      p_actor: actorId, p_case: inquiryId, p_expected_revision: 1, p_operation: crypto.randomUUID(), p_reason: 'fixture revision'
    });
    assert.equal(started.revoked_confirmations, 1);
    assert.equal((await db.query('select state from public.pa_contract_tokens where offer_id=$1', [offer1])).rows[0].state, 'revoked');
    await assert.rejects(call(db, 'pa_contract_accept', { p_token_hash: sha('a'.repeat(64)), p_offer_id: offer1, p_snapshot_sha256: (await db.query('select snapshot_sha256 from public.pa_contract_offers where id=$1', [offer1])).rows[0].snapshot_sha256, p_name: 'Must fail', p_agree: true }), /invalid_link|contract_not_available/);
    await assert.rejects(call(db, 'pa_v5_issue_estimate', { ...common, p_expected_revision: 0, p_operation: crypto.randomUUID(), p_document_id: crypto.randomUUID() }), /commercial_state_changed/);

    const estimate2Args = { ...common, p_expected_revision: 2, p_expected_current: estimate1.id, p_operation: crypto.randomUUID(), p_document_id: crypto.randomUUID(), p_filename: 'estimate-v2.pdf' };
    const estimate2 = await call(db, 'pa_v5_issue_estimate', estimate2Args);
    assert.equal(estimate2.revision_number, 2);
    const lease2 = crypto.randomUUID();
    await call(db, 'pa_v5_outbox_claim', { p_actor: actorId, p_job: estimate2.outbox_id, p_lease: lease2 });
    await call(db, 'pa_v5_outbox_finish', { p_actor: actorId, p_job: estimate2.outbox_id, p_lease: lease2, p_state: 'sent', p_message: 'fixture-message-2', p_thread: 'thread_123', p_error: null });

    const token2 = 'b'.repeat(64);
    const offer2 = crypto.randomUUID();
    const confirmation2 = await call(db, 'pa_v5_issue_confirmation', {
      p_actor: actorId, p_case: inquiryId, p_expected_revision: 3, p_estimate: estimate2.id,
      p_offer: offer2, p_operation: crypto.randomUUID(), p_token_hash: sha(token2),
      p_secret_envelope: 'fixture-encrypted-envelope-not-a-live-token-0002',
      p_snapshot: { event_name: 'Fixture event', event_date: '2026-10-18', recipient: 'customer@example.invalid' },
      p_recipient: 'customer@example.invalid', p_subject: 'Fixture confirmation 2', p_body: 'Fixture confirmation body 2',
      p_reply_binding: { thread_id: 'thread_123' }
    });
    const view = (await db.query('select snapshot_sha256 from public.pa_contract_offers where id=$1', [offer2])).rows[0];
    const accepted = await call(db, 'pa_contract_accept', { p_token_hash: sha(token2), p_offer_id: offer2, p_snapshot_sha256: view.snapshot_sha256, p_name: 'Fixture Customer', p_agree: true });
    assert.equal(accepted.state, 'accepted');
    assert.equal((await call(db, 'pa_contract_accept', { p_token_hash: sha(token2), p_offer_id: offer2, p_snapshot_sha256: view.snapshot_sha256, p_name: 'Fixture Customer', p_agree: true })).already_received, true);
    await assert.rejects(call(db, 'pa_v5_begin_estimate_revision', { p_actor: actorId, p_case: inquiryId, p_expected_revision: 3, p_operation: crypto.randomUUID(), p_reason: 'must use change order' }), /post_contract_change_required/);

    const settled = await call(db, 'pa_v5_confirm_fulfillment_and_settlement', { p_actor: actorId, p_case: inquiryId, p_expected_revision: 3, p_operation: crypto.randomUUID(), p_amount_minor: 110000, p_unresolved: false, p_evidence: { kind: 'owner_confirmed_fixture' } });
    assert.equal(settled.settlement_state, 'confirmed');
    const billing = await call(db, 'pa_v5_create_billing', {
      p_actor: actorId, p_case: inquiryId, p_expected_revision: 4, p_operation: crypto.randomUUID(), p_contract: offer2, p_estimate: estimate2.id,
      p_amount_minor: 110000, p_policy: 'no_separate_invoice', p_document_id: null, p_filename: null, p_content_base64: null, p_sha256: null,
      p_due: null, p_due_basis: { status: 'unconfirmed', reason: 'fixture has no authoritative due date' }, p_customer_planned: null,
      p_evidence: { kind: 'fixture_customer_record' }, p_recipient: null, p_subject: null, p_body: null, p_reply_binding: {}
    });
    const partial = await call(db, 'pa_v5_record_payment', { p_actor: actorId, p_case: inquiryId, p_billing: billing.id, p_operation: crypto.randomUUID(), p_payment_date: '2026-10-20', p_amount_minor: 50000, p_method: 'bank_transfer', p_memo: 'fixture partial payment' });
    assert.ok(partial.id);
    await assert.rejects(call(db, 'pa_v5_payment_and_close', { p_actor: actorId, p_case: inquiryId, p_billing: billing.id, p_expected_revision: 4, p_operation: crypto.randomUUID(), p_payment_date: '2026-10-21', p_new_payment_minor: 1, p_method: 'bank_transfer', p_memo: 'must roll back' }), /payment_balance_not_zero/);
    const closeOperation = crypto.randomUUID();
    const closed = await call(db, 'pa_v5_payment_and_close', { p_actor: actorId, p_case: inquiryId, p_billing: billing.id, p_expected_revision: 4, p_operation: closeOperation, p_payment_date: '2026-10-22', p_new_payment_minor: 60000, p_method: 'bank_transfer', p_memo: 'fixture balance' });
    assert.equal(closed.state, 'closed');
    assert.equal((await call(db, 'pa_v5_payment_and_close', { p_actor: actorId, p_case: inquiryId, p_billing: billing.id, p_expected_revision: 4, p_operation: closeOperation, p_payment_date: '2026-10-22', p_new_payment_minor: 60000, p_method: 'bank_transfer', p_memo: 'fixture balance' })).already_committed, true);
    rows = (await db.query('select count(*)::int n from public.pa_payment_records where billing_id=$1', [billing.id])).rows;
    assert.equal(rows[0].n, 2);
    assert.equal((await db.query('select count(*)::int n from public.pa_contracts where inquiry_id=$1', [inquiryId])).rows[0].n, 1);
    const correctionOperation = crypto.randomUUID();
    const corrected = await call(db, 'pa_v5_adjust_payment', { p_actor: actorId, p_case: inquiryId, p_billing: billing.id, p_payment: partial.id, p_operation: correctionOperation, p_delta_minor: -1000, p_reason: 'fixture correction after close' });
    assert.ok(corrected.id);
    assert.equal((await db.query('select delta_minor from public.pa_payment_adjustments where operation_id=$1', [correctionOperation])).rows[0].delta_minor, -1000);
    const reopened = await call(db, 'pa_v5_reopen_case', { p_actor: actorId, p_case: inquiryId, p_operation: crypto.randomUUID(), p_reason: 'fixture balance correction requires review' });
    assert.ok(reopened.reopened_at);
    assert.equal((await db.query('select count(*)::int n from public.pa_payment_records where billing_id=$1', [billing.id])).rows[0].n, 2);
    console.log('PASS PA-EST-004 real PostgreSQL engine: immutable revisions, atomic revoke, bound accept replay, partial payment and atomic close');
  } finally {
    await db.close();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
