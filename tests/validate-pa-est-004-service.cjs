const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createFixture } = require('./helpers/pa-contract-fixture.cjs');
const { read } = require('./helpers/pa-estimate-fixture.cjs');
const { createService } = require('../api/_pa-commercial.cjs');
const { sha } = require('../api/_pa-contract-pdf.cjs');

(async () => {
  const fixture = await createFixture();
  const sent = [];
  let uncertainAttempts = 0;
  try {
    await fixture.db.exec(read('20260913110000_pa_case_management_v5.sql'));
    const service = createService({
      fetchImpl: fixture.fetchImpl,
      sendTransport: async (job, attachments) => {
        if (job.subject === 'UNKNOWN FIXTURE') { uncertainAttempts += 1; throw Error('network_response_lost'); }
        sent.push({ id: job.id, attachments: attachments.map(item => item.filename) });
        return { gmail_message_id: `fake-${job.id}`, gmail_thread_id: 'thread_123' };
      }
    });
    const operation = crypto.randomUUID();
    const result = await service.issueEstimate({
      case_id: fixture.inquiryId, expected_revision: 0, expected_current: null,
      operation_id: operation, document_id: crypto.randomUUID(), filename: 'service-fixture.pdf',
      content_base64: fixture.quote.toString('base64'), sha256: sha(fixture.quote), amount_minor: 110000,
      currency: 'JPY', tax_basis: 'tax_included', conditions: { fixture: true }, source_kind: 'managed_send',
      source_sent_at: null, body: 'Local fake adapter fixture. No external delivery.'
    }, { id: fixture.actorId });
    assert.ok(result.outbox_id);
    const first = await service.dispatch({ job_id: result.outbox_id }, { id: fixture.actorId });
    assert.equal(first.state, 'sent'); assert.equal(sent.length, 1); assert.deepEqual(sent[0].attachments, ['service-fixture.pdf']);
    const duplicate = await service.dispatch({ job_id: result.outbox_id }, { id: fixture.actorId });
    assert.equal(duplicate.already_committed, true); assert.equal(sent.length, 1, 'sent job never reaches transport twice');
    const unknownJob = crypto.randomUUID();
    await fixture.db.query("insert into public.pa_commercial_outbox(id,inquiry_id,operation_id,job_kind,aggregate_id,recipient,subject,body_text,reply_binding,attachment_ids) values($1,$2,$3,'confirmation_reminder',$4,'customer@example.invalid','UNKNOWN FIXTURE','fixture body','{}','{}')", [unknownJob, fixture.inquiryId, crypto.randomUUID(), crypto.randomUUID()]);
    await assert.rejects(service.dispatch({ job_id: unknownJob }, { id: fixture.actorId }), /network_response_lost/);
    assert.equal(uncertainAttempts, 1);
    await assert.rejects(service.dispatch({ job_id: unknownJob }, { id: fixture.actorId }), /outbox_unknown_requires_reconciliation/);
    assert.equal(uncertainAttempts, 1, 'unknown job is never blindly resent');
    console.log('PASS PA-EST-004 service/outbox: real preview binding, byte-exact attachment, fake transport, duplicate and unknown suppression');
  } finally { await fixture.db.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
