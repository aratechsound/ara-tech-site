const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createFixture } = require('./helpers/pa-contract-fixture.cjs');
const { read } = require('./helpers/pa-estimate-fixture.cjs');
const { createService } = require('../api/_pa-commercial.cjs');
const { sha } = require('../api/_pa-contract-pdf.cjs');

const migrationChain = [
  '20260913110000_pa_case_management_v5.sql',
  '20260913130000_pa_case_management_v5_r1.sql',
  '20260913190000_pa_estimate_recovery_ux.sql',
  '20260914100000_pa_est_005a_confirmation_snapshot_compat.sql',
  '20260914170000_pa_est_007r1_production_e2e.sql',
  '20260914213000_pa_est_007r3_delivery_recovery.sql'
];

(async () => {
  const fixture = await createFixture();
  try {
    process.env.PA_MAIL_ADAPTER = 'gmail';
    process.env.PA_COMMERCIAL_OUTBOX_KEY = '77'.repeat(32);
    for (const name of migrationChain) await fixture.db.exec(read(name));

    const service = createService({ fetchImpl: fixture.fetchImpl });
    const estimate = await service.issueEstimate({
      case_id: fixture.inquiryId, expected_revision: 0, expected_current: null,
      operation_id: crypto.randomUUID(), document_id: crypto.randomUUID(), filename: 'R3-binding-estimate.pdf',
      content_base64: fixture.quote.toString('base64'), sha256: sha(fixture.quote), amount_minor: 110000,
      currency: 'JPY', tax_basis: 'tax_included', conditions: { source: 'R3 attachment binding test' },
      source_kind: 'managed_send', source_sent_at: null, body: 'R3 estimate delivery fixture'
    }, { id: fixture.actorId });
    await service.dispatch({ job_id: estimate.outbox_id }, { id: fixture.actorId });
    const confirmationPreview = await service.confirmationPreview({ case_id: fixture.inquiryId }, { id: fixture.actorId });
    const confirmation = await service.issueConfirmation({
      case_id: fixture.inquiryId, preview_fingerprint: confirmationPreview.fingerprint, operation_id: crypto.randomUUID()
    }, { id: fixture.actorId });
    const confirmationSent = await service.dispatch({ job_id: confirmation.outbox_id }, { id: fixture.actorId });
    assert.equal(confirmationSent.state, 'sent', 'formal confirmation token is bound to the actual estimate attachment');
    const confirmationRow = (await fixture.db.query('select * from public.pa_commercial_outbox where id=$1', [confirmation.outbox_id])).rows[0];
    assert.equal(confirmationRow.delivery_state, 'sent'); assert.equal(confirmationRow.provider_response_received, true);
    assert.equal(confirmationRow.attachment_ids.length, 1);

    const job = crypto.randomUUID();
    await fixture.db.query(`insert into public.pa_commercial_outbox(
      id,inquiry_id,operation_id,job_kind,aggregate_id,recipient,subject,body_text,reply_binding,attachment_ids
    ) values($1,$2,$3,'invoice',$4,'customer@example.invalid','R3 diagnostic fixture','No live delivery','{}','{}')`,
    [job, fixture.inquiryId, crypto.randomUUID(), crypto.randomUUID()]);

    let lease = crypto.randomUUID();
    await fixture.db.query('select public.pa_v5_outbox_claim($1,$2,$3)', [fixture.actorId, job, lease]);
    let row = (await fixture.db.query('select * from public.pa_commercial_outbox where id=$1', [job])).rows[0];
    assert.equal(row.state, 'processing'); assert.equal(row.delivery_state, 'processing');
    await fixture.db.query(`select public.pa_v5_outbox_finish_v2(
      $1,$2,$3,'failed',null,null,'invalid_confirmation','failed_before_provider',
      'preview_validation','invalid_confirmation','送信内容の確認情報と添付ファイルが一致しません。',false,false,null)`,
    [fixture.actorId, job, lease]);
    row = (await fixture.db.query('select * from public.pa_commercial_outbox where id=$1', [job])).rows[0];
    assert.equal(row.state, 'failed'); assert.equal(row.delivery_state, 'failed_before_provider');
    assert.equal(row.failure_phase, 'preview_validation'); assert.equal(row.failure_code, 'invalid_confirmation');
    assert.equal(row.provider_request_started, false); assert.equal(row.provider_response_received, false);

    lease = crypto.randomUUID();
    await fixture.db.query('select public.pa_v5_outbox_claim($1,$2,$3)', [fixture.actorId, job, lease]);
    await fixture.db.query(`select public.pa_v5_outbox_finish_v2(
      $1,$2,$3,'unknown',null,null,'mail_outcome_unknown','unknown_after_provider_start',
      'gmail_api_request','network_response_lost','送信開始後の結果を確定できません。',true,false,null)`,
    [fixture.actorId, job, lease]);
    row = (await fixture.db.query('select * from public.pa_commercial_outbox where id=$1', [job])).rows[0];
    assert.equal(row.state, 'unknown'); assert.equal(row.delivery_state, 'unknown_after_provider_start');
    await assert.rejects(fixture.db.query('select public.pa_v5_outbox_claim($1,$2,$3)', [fixture.actorId, job, crypto.randomUUID()]), /outbox_unknown_requires_reconciliation/);

    const audit = (await fixture.db.query("select count(*)::int n from public.pa_inquiry_audit where inquiry_id=$1 and action='commercial_outbox_delivery_finished' and details->>'outbox_id'=$2", [fixture.inquiryId, job])).rows[0];
    assert.equal(audit.n, 2);
    await assert.rejects(fixture.db.query(`update public.pa_commercial_outbox set safe_error_message='https://secret.invalid/token' where id=$1`, [job]), /pa_commercial_outbox_delivery_diagnostics_check/);
    console.log('PASS PA-EST-007R3 delivery: concrete phase/code, provider boundary, safe retry before provider, unknown suppression and audit');
  } finally { await fixture.db.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
