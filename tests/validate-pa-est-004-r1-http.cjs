const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createFixture } = require('./helpers/pa-contract-fixture.cjs');
const { read } = require('./helpers/pa-estimate-fixture.cjs');
const { createService } = require('../api/_pa-commercial.cjs');
const { createHandler } = require('../api/_pa-commercial-handler.cjs');
const { sha } = require('../api/_pa-contract-pdf.cjs');

process.env.ALLOWED_ORIGINS = 'http://127.0.0.1:8766';
process.env.PA_COMMERCIAL_OUTBOX_KEY = '55'.repeat(32);

(async () => {
  const fixture = await createFixture();
  try {
    process.env.ALLOWED_ORIGINS = 'http://127.0.0.1:8766';
    await fixture.db.exec(read('20260913110000_pa_case_management_v5.sql') + '\n' + read('20260913130000_pa_case_management_v5_r1.sql') + '\n' + read('20260913190000_pa_estimate_recovery_ux.sql'));
    let mode = 'success'; let transportCalls = 0; let loseFinishResponseFor = null;
    const guardedFetch = async (url, options = {}) => {
      const response = await fixture.fetchImpl(url, options);
      if (String(url).includes('/rpc/pa_v5_outbox_finish') && loseFinishResponseFor) {
        const body = JSON.parse(String(options.body || '{}'));
        if (body.p_job === loseFinishResponseFor && body.p_state === 'sent') {
          loseFinishResponseFor = null;
          throw Error('fixture_finish_response_lost_after_commit');
        }
      }
      return response;
    };
    const service = createService({ fetchImpl: guardedFetch, sendTransport: async job => {
      transportCalls += 1;
      if (mode === 'failure') throw Error('gmail_send_fixture_failure');
      if (mode === 'unknown') throw Error('fixture_response_lost');
      return { gmail_message_id: `fake-${job.id}`, gmail_thread_id: 'thread_123' };
    } });
    const handler = createHandler({ service, admin: async token => {
      if (token !== 'fixture-admin') throw Error('not_authorized'); return { id: fixture.actorId };
    }, rate: async () => ({ allowed: true }) });
    const request = async body => {
      const res = { headers: {}, setHeader(k,v){this.headers[k]=v;}, status(s){this.statusCode=s;return this;}, json(v){this.body=v;return this;}, write(v){this.bytes=Buffer.concat([this.bytes||Buffer.alloc(0),Buffer.from(v)]);return true;}, end(){return this;} };
      await handler({ method: 'POST', headers: { origin: 'http://127.0.0.1:8766', authorization: 'Bearer fixture-admin' }, body, socket: { remoteAddress: '127.0.0.1' } }, res);
      return res;
    };
    const insertJob = async subject => {
      const id = crypto.randomUUID();
      await fixture.db.query("insert into public.pa_commercial_outbox(id,inquiry_id,operation_id,job_kind,aggregate_id,recipient,subject,body_text,reply_binding,attachment_ids) values($1,$2,$3,'invoice',$4,'customer@example.invalid',$5,'fixture','{}','{}')", [id, fixture.inquiryId, crypto.randomUUID(), crypto.randomUUID(), subject]);
      return id;
    };
    const estimateOperation = crypto.randomUUID(); const estimateDocument = crypto.randomUUID();
    const estimateRequest = {
      action: 'issue_estimate', case_id: fixture.inquiryId, expected_revision: 0, expected_current: null,
      operation_id: estimateOperation, document_id: estimateDocument, filename: 'http-estimate.pdf',
      content_base64: fixture.quote.toString('base64'), sha256: sha(fixture.quote), amount_minor: 110000,
      currency: 'JPY', tax_basis: 'tax_included', conditions: { source: 'HTTP issue fixture' },
      source_kind: 'managed_send', source_sent_at: null, body: 'HTTP estimate fixture', cc_addresses: ['venue@example.invalid']
    };
    let response = await request(estimateRequest); assert.equal(response.statusCode, 200);
    const estimate = response.body.result;
    response = await request(estimateRequest); assert.equal(response.body.result.already_committed, true);
    response = await request({ ...estimateRequest, amount_minor: 120000 });
    assert.equal(response.statusCode, 400); assert.equal(response.body.code, 'idempotency_payload_mismatch');
    await request({ action: 'dispatch_outbox', case_id: fixture.inquiryId, job_id: estimate.outbox_id });

    const confirmationOperation = crypto.randomUUID(); const offerId = crypto.randomUUID();
    const confirmationRequest = {
      action: 'issue_confirmation', case_id: fixture.inquiryId, expected_revision: 1,
      estimate_revision_id: estimate.id, offer_id: offerId, operation_id: confirmationOperation,
      event_name: 'HTTP fixture event', event_date: '2026-10-18', customer_acknowledgement: { source: 'HTTP fixture' },
      body_template: 'HTTP confirmation {{CONFIRMATION_URL}}', cc_addresses: ['venue@example.invalid']
    };
    response = await request(confirmationRequest); assert.equal(response.statusCode, 200);
    const confirmation = response.body.result;
    response = await request(confirmationRequest); assert.equal(response.body.result.already_committed, true); assert.equal(response.body.result.secret_url_returned_once, null);
    response = await request({ ...confirmationRequest, event_name: 'changed payload' });
    assert.equal(response.statusCode, 400); assert.equal(response.body.code, 'idempotency_payload_mismatch');
    await request({ action: 'dispatch_outbox', case_id: fixture.inquiryId, job_id: confirmation.outbox_id });
    process.env.PA_MAIL_ADAPTER = 'gmail';
    const defaultTransportService = createService({ fetchImpl: fixture.fetchImpl });
    const reminder = await defaultTransportService.remindConfirmation({
      case_id: fixture.inquiryId, offer_id: offerId, expected_revision: 1, operation_id: crypto.randomUUID(),
      body_template: 'The same confirmation identity {{CONFIRMATION_URL}}', cc_addresses: ['venue@example.invalid']
    }, { id: fixture.actorId });
    const reminderSent = await defaultTransportService.dispatch({ job_id: reminder.outbox_id }, { id: fixture.actorId });
    assert.equal(reminderSent.state, 'sent', 'same-token reminder passes the real preview-token/Gmail MIME path');
    const token = confirmation.secret_url_returned_once.split('#')[1];
    const offer = (await fixture.db.query('select snapshot_sha256 from public.pa_contract_offers where id=$1', [offerId])).rows[0];
    await fixture.db.query('select public.pa_contract_accept($1,$2,$3,$4,$5)', [sha(token), offerId, offer.snapshot_sha256, 'HTTP Fixture Customer', true]);
    response = await request({ action: 'confirm_settlement', case_id: fixture.inquiryId, expected_revision: 1, operation_id: crypto.randomUUID(), amount_minor: 110000, unresolved_changes: false, evidence: { source: 'HTTP fixture' } });
    assert.equal(response.statusCode, 200);
    const billingOperation = crypto.randomUUID();
    const billingRequest = { action: 'create_billing', case_id: fixture.inquiryId, expected_revision: 2, operation_id: billingOperation,
      contract_id: offerId, estimate_revision_id: estimate.id, amount_minor: 110000, invoice_policy: 'no_separate_invoice',
      due_date: '2026-10-31', due_basis: { status: 'agreed', source: 'HTTP fixture' }, customer_planned_payment_on: null,
      agreement_evidence: { source: 'HTTP fixture' } };
    response = await request(billingRequest); assert.equal(response.statusCode, 200);
    response = await request(billingRequest); assert.equal(response.body.result.already_committed, true);
    response = await request({ ...billingRequest, due_date: '2026-11-01' });
    assert.equal(response.statusCode, 400); assert.equal(response.body.code, 'idempotency_payload_mismatch');

    const successful = await insertJob('success');
    const callsBeforeSuccess = transportCalls;
    response = await request({ action: 'dispatch_outbox', case_id: fixture.inquiryId, job_id: successful });
    assert.equal(response.statusCode, 200); assert.equal(response.body.result.state, 'sent');
    response = await request({ action: 'dispatch_outbox', case_id: fixture.inquiryId, job_id: successful });
    assert.equal(response.body.result.already_committed, true); assert.equal(transportCalls, callsBeforeSuccess + 1);

    const committedButResponseLost = await insertJob('finish-response-lost-after-commit');
    loseFinishResponseFor = committedButResponseLost;
    const callsBeforeLostFinish = transportCalls;
    response = await request({ action: 'dispatch_outbox', case_id: fixture.inquiryId, job_id: committedButResponseLost });
    assert.equal(response.statusCode, 200); assert.equal(response.body.result.finish_response_recovered, true);
    response = await request({ action: 'dispatch_outbox', case_id: fixture.inquiryId, job_id: committedButResponseLost });
    assert.equal(response.body.result.already_committed, true); assert.equal(transportCalls, callsBeforeLostFinish + 1, 'finish response loss does not resend');

    const expiredWorker = await insertJob('expired-worker-lease');
    await fixture.db.query("select public.pa_v5_outbox_claim($1,$2,$3)", [fixture.actorId, expiredWorker, crypto.randomUUID()]);
    await fixture.db.query("update public.pa_commercial_outbox set lease_expires_at=now()-interval '1 second' where id=$1", [expiredWorker]);
    const callsBeforeLeaseRecovery = transportCalls;
    response = await request({ action: 'dispatch_outbox', case_id: fixture.inquiryId, job_id: expiredWorker });
    assert.equal(response.statusCode, 200); assert.equal(response.body.result.state, 'sent');
    assert.equal(transportCalls, callsBeforeLeaseRecovery + 1, 'expired worker lease is recovered once');
    assert.equal((await fixture.db.query('select attempt_count from public.pa_commercial_outbox where id=$1', [expiredWorker])).rows[0].attempt_count, 2);

    const failed = await insertJob('failure'); mode = 'failure';
    response = await request({ action: 'dispatch_outbox', case_id: fixture.inquiryId, job_id: failed });
    assert.equal(response.statusCode, 503);
    assert.equal((await fixture.db.query('select state from public.pa_commercial_outbox where id=$1', [failed])).rows[0].state, 'failed');
    mode = 'success'; response = await request({ action: 'dispatch_outbox', case_id: fixture.inquiryId, job_id: failed });
    assert.equal(response.body.result.state, 'sent');

    const unknown = await insertJob('unknown'); mode = 'unknown';
    response = await request({ action: 'dispatch_outbox', case_id: fixture.inquiryId, job_id: unknown });
    assert.equal(response.statusCode, 503);
    const callsAtUnknown = transportCalls;
    mode = 'success'; response = await request({ action: 'dispatch_outbox', case_id: fixture.inquiryId, job_id: unknown });
    assert.equal(response.statusCode, 400); assert.equal(response.body.code, 'outbox_unknown_requires_reconciliation');
    assert.equal(transportCalls, callsAtUnknown, 'unknown outcome never re-enters transport');

    const recoveryOperation = crypto.randomUUID(); const documentId = crypto.randomUUID();
    const recovery = { action: 'recover_estimate', case_id: fixture.inquiryId, expected_revision: 2, expected_current: estimate.id,
      operation_id: recoveryOperation, document_id: documentId, mode: 'historical', amount_minor: 110000, currency: 'JPY',
      tax_basis: 'tax_included', conditions: { source: 'HTTP fixture' }, gmail_message_id: 'direct_sent_001', gmail_attachment_id: 'attachment_1' };
    response = await request(recovery); assert.equal(response.statusCode, 200);
    response = await request(recovery); assert.equal(response.statusCode, 200); assert.equal(response.body.result.already_committed, true);
    response = await request({ ...recovery, amount_minor: 120000 });
    assert.equal(response.statusCode, 400); assert.equal(response.body.code, 'amount_extraction_mismatch');
    console.log('PASS PA-EST-004R1 HTTP: handler idempotency, failure/retry, unknown suppression, lost finish response and expired-worker recovery');
  } finally { await fixture.db.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
