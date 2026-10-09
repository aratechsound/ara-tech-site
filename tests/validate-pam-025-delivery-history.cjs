const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { setup, MODE } = require('./validate-pam-025-direct-confirmation.cjs');
const { sha } = require('../api/_pa-contract-pdf.cjs');
const finalInput = (f, p) => ({ case_id: f.inquiryId, confirmation_mode: MODE, preview_fingerprint: p.fingerprint, operation_id: crypto.randomUUID() });
async function replace(f, offerId, version) {
  const p = await f.service.confirmationPreview({ case_id: f.inquiryId, replace_offer_id: offerId }, f.actor);
  const result = await f.service.replaceConfirmation({ case_id: f.inquiryId, old_offer_id: offerId, expected_old_version: version, preview_fingerprint: p.fingerprint, operation_id: crypto.randomUUID(), reason: 'Controlled delivery-history regression' }, f.actor);
  return { ...result, preview: p };
}
async function main() {
  global.fetch = async () => { throw Error('LIVE_NETWORK_FORBIDDEN'); };
  const evidence = {};
  let calls = 0, outcome = 'success';
  const f = await setup({ transport: async (_job, docs, trace) => {
    calls++; assert.equal(docs.length, 1); assert.deepEqual(Buffer.from(docs[0].data, 'base64url'), f.quote);
    trace.provider_response_received = true; trace.provider_http_status = outcome === 'failure' ? 400 : 200;
    if (outcome === 'failure') throw Error('gmail_send_400');
    return { gmail_message_id: 'fake-history-' + calls, gmail_thread_id: 'thread_123' };
  } });
  try {
    const e = await f.createEstimate();
    const p = await f.service.confirmationPreview({ case_id: f.inquiryId, confirmation_mode: MODE }, f.actor);
    assert.equal(p.estimate.sent_at, null);
    assert.equal((await f.service.snapshot(f.inquiryId)).estimates[0].delivery, null);
    evidence.PREPARED_UNSENT = 'PASS';
    const input = finalInput(f, p), sent = await f.service.issueDirectConfirmationAndSend(input, f.actor);
    let s = await f.service.snapshot(f.inquiryId);
    const first = s.estimates.find(x => x.id === e.id).delivery;
    assert.equal(first.state, 'sent'); assert.equal(first.id, sent.outbox_id); assert(first.finished_at);
    const second = await replace(f, sent.id, 1);
    s = await f.service.snapshot(f.inquiryId);
    assert.equal(s.outbox.find(x => x.id === second.outbox_id).state, 'queued');
    assert.equal(s.estimates.find(x => x.id === e.id).delivery.id, first.id);
    assert.equal(s.estimates.find(x => x.id === e.id).delivery.finished_at, first.finished_at);
    let offer = (await f.db.query('select * from pa_contract_offers where id=$1', [second.id])).rows[0];
    assert.equal(Date.parse(offer.snapshot.estimate.sent_at), Date.parse(first.finished_at));
    assert.equal(Date.parse(second.preview.estimate.sent_at), Date.parse(first.finished_at));
    assert.equal(offer.snapshot.estimate.sha256, sha(f.quote)); assert.deepEqual(Buffer.from(offer.quote_pdf), f.quote);
    evidence.SENT_THEN_REISSUE_QUEUED = 'PASS';
    outcome = 'failure';
    const sendPreview = await f.service.confirmationSendPreview({ case_id: f.inquiryId, offer_id: second.id }, f.actor);
    await assert.rejects(f.service.dispatch({ case_id: f.inquiryId, offer_id: second.id, job_id: second.outbox_id, preview_fingerprint: sendPreview.fingerprint }, f.actor));
    s = await f.service.snapshot(f.inquiryId);
    assert.equal(s.outbox.find(x => x.id === second.outbox_id).state, 'failed');
    assert.equal(s.estimates.find(x => x.id === e.id).delivery.id, first.id);
    assert.equal(s.estimates.find(x => x.id === e.id).delivery.state, 'sent');
    evidence.SENT_THEN_REISSUE_FAILED = 'PASS';
    outcome = 'success';
    const retryPreview = await f.service.confirmationSendPreview({ case_id: f.inquiryId, offer_id: second.id }, f.actor);
    await f.service.dispatch({ case_id: f.inquiryId, offer_id: second.id, job_id: second.outbox_id, preview_fingerprint: retryPreview.fingerprint }, f.actor);
    s = await f.service.snapshot(f.inquiryId);
    assert.equal(s.outbox.find(x => x.id === second.outbox_id).state, 'sent');
    assert.equal(s.estimates.find(x => x.id === e.id).delivery.id, first.id);
    assert.equal(s.estimates.find(x => x.id === e.id).delivery.finished_at, first.finished_at);
    evidence.REISSUE_SENT_PRESERVES_FIRST_DELIVERY = 'PASS';
    await f.service.issueDirectConfirmationAndSend(input, f.actor);
    assert.equal(calls, 3); evidence.ORIGINAL_OPERATION_REPLAY_NO_SEND = 'PASS';
    const rev = await f.service.beginRevision({ case_id: f.inquiryId, expected_revision: s.state.revision, operation_id: crypto.randomUUID(), reason: 'Controlled new-revision fixture' }, f.actor);
    const next = await f.service.issueEstimate({ case_id: f.inquiryId, expected_revision: rev.revision, expected_current: e.id,
      operation_id: crypto.randomUUID(), document_id: crypto.randomUUID(), filename: '改訂見積原本.pdf', content_base64: f.quote.toString('base64'), sha256: sha(f.quote), amount_minor: 110000, currency: 'JPY', tax_basis: 'tax_included', conditions: { source: 'history regression' }, source_kind: 'managed_send', source_sent_at: null, body: 'Controlled unsent revised estimate', confirmation_mode: MODE, cc_addresses: [] }, f.actor);
    s = await f.service.snapshot(f.inquiryId);
    assert.equal(s.state.current_estimate_revision_id, next.id);
    assert.equal(s.estimates.find(x => x.id === e.id).delivery.id, first.id);
    assert.equal(s.estimates.find(x => x.id === next.id).delivery, null);
    assert.equal((await f.service.confirmationPreview({ case_id: f.inquiryId, confirmation_mode: MODE }, f.actor)).estimate.sent_at, null);
    assert.deepEqual((await f.service.document(f.inquiryId, e.document_id || offer.snapshot.estimate.document_id)).bytes, f.quote);
    assert.equal((await f.db.query('select state from pa_contract_tokens where offer_id=$1', [second.id])).rows[0].state, 'revoked');
    evidence.REVISED_CURRENT_UNSENT_OLD_DELIVERY_PRESERVED = 'PASS';
  } finally { await f.db.close(); }
  for (const firstOutcome of ['failure', 'ambiguous']) {
    let attempts = 0;
    const f = await setup({ transport: async (_job, _docs, trace) => {
      attempts++;
      if (firstOutcome === 'ambiguous') throw Error('fixture_response_lost');
      trace.provider_response_received = true; trace.provider_http_status = 400; throw Error('gmail_send_400');
    } });
    try {
      const e = await f.createEstimate();
      const p = await f.service.confirmationPreview({ case_id: f.inquiryId, confirmation_mode: MODE }, f.actor);
      const input = finalInput(f, p);
      await assert.rejects(f.service.issueDirectConfirmationAndSend(input, f.actor));
      const replay = await f.service.issueDirectConfirmationAndSend(input, f.actor);
      const s = await f.service.snapshot(f.inquiryId), delivery = s.estimates.find(x => x.id === e.id).delivery;
      assert.equal(delivery.state, firstOutcome === 'failure' ? 'failed' : 'unknown');
      assert.equal(delivery.id, replay.outbox_id); assert.equal(delivery.provider_message_id, null);
      assert.equal(attempts, 1);
      if (firstOutcome === 'failure') {
        const replacement = await replace(f, replay.id, 1);
        const next = await f.service.snapshot(f.inquiryId);
        assert.equal(next.estimates.find(x => x.id === e.id).delivery.state, 'queued');
        assert.equal(replacement.preview.estimate.sent_at, null);
        assert.equal((await f.db.query('select snapshot from pa_contract_offers where id=$1', [replacement.id])).rows[0].snapshot.estimate.sent_at, null);
      }
      evidence['FIRST_' + firstOutcome.toUpperCase() + '_NOT_SENT_NO_AUTO_RESEND'] = 'PASS';
    } finally { await f.db.close(); }
  }
  let ambiguousCalls = 0;
  const uncertain = await setup({ transport: async () => {
    ambiguousCalls++;
    if (ambiguousCalls > 1) throw Error('fixture_response_lost');
    return { gmail_message_id: 'fake-original-before-unknown', gmail_thread_id: 'thread_123' };
  } });
  try {
    const e = await uncertain.createEstimate();
    const p = await uncertain.service.confirmationPreview({ case_id: uncertain.inquiryId, confirmation_mode: MODE }, uncertain.actor);
    const first = await uncertain.service.issueDirectConfirmationAndSend(finalInput(uncertain, p), uncertain.actor);
    const next = await replace(uncertain, first.id, 1);
    const preview = await uncertain.service.confirmationSendPreview({ case_id: uncertain.inquiryId, offer_id: next.id }, uncertain.actor);
    await assert.rejects(uncertain.service.dispatch({ case_id: uncertain.inquiryId, offer_id: next.id, job_id: next.outbox_id, preview_fingerprint: preview.fingerprint }, uncertain.actor));
    const s = await uncertain.service.snapshot(uncertain.inquiryId);
    assert.equal(s.outbox.find(x => x.id === next.outbox_id).state, 'unknown');
    assert.equal(s.estimates.find(x => x.id === e.id).delivery.id, first.outbox_id);
    assert.equal(s.estimates.find(x => x.id === e.id).delivery.state, 'sent');
    await assert.rejects(uncertain.service.dispatch({ case_id: uncertain.inquiryId, offer_id: next.id, job_id: next.outbox_id, preview_fingerprint: preview.fingerprint }, uncertain.actor));
    assert.equal(ambiguousCalls, 2);
    evidence.SENT_THEN_REISSUE_UNKNOWN_NO_AUTO_RESEND = 'PASS';
  } finally { await uncertain.db.close(); }
  evidence.REAL_GMAIL_SEND = 0; evidence.PRODUCTION_MUTATION = 0;
  if (process.argv[2]) { fs.mkdirSync(process.argv[2], { recursive: true }); fs.writeFileSync(path.join(process.argv[2], 'pam-025-delivery-history.json'), JSON.stringify(evidence, null, 2)); }
  console.log(JSON.stringify(evidence, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
