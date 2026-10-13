const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { PDFDocument, PDFArray, decodePDFRawStream } = require('pdf-lib');
const { createFixture } = require('./helpers/pa-contract-fixture.cjs');
const { read } = require('./helpers/pa-estimate-fixture.cjs');
const { createService, decryptSecret } = require('../api/_pa-commercial.cjs');
const { createService: contractService } = require('../api/_pa-contract.cjs');
const { sha } = require('../api/_pa-contract-pdf.cjs');
const MODE = 'DIRECT_CONFIRM_WITH_ESTIMATE';
const MIGRATION = '20261008090000_pam025_direct_confirmation_with_estimate.sql';
async function setup({ transport, migrate = true } = {}) {
  const f = await createFixture();
  process.env.PA_COMMERCIAL_OUTBOX_KEY = '88'.repeat(32);
  process.env.PA_MAIL_ADAPTER = 'gmail';
  process.env.PA_PUBLIC_ORIGIN = 'https://example.invalid';
  const r7 = read('20260914213000_pa_est_007r3_delivery_recovery.sql');
  const cut = r7.search(/\r?\ndo \$\$\r?\ndeclare\r?\n  c_case constant/u);
  assert(cut > 0);
  for (const name of ['20260913110000_pa_case_management_v5.sql', '20260913130000_pa_case_management_v5_r1.sql',
    '20260913190000_pa_estimate_recovery_ux.sql', '20260914100000_pa_est_005a_confirmation_snapshot_compat.sql',
    '20260914170000_pa_est_007r1_production_e2e.sql']) await f.db.exec(read(name));
  await f.db.exec(r7.slice(0, cut) + '\ncommit;');
  await f.db.exec(read('20260915093000_pa_est_010r1_safe_confirmation_reissue.sql'));
  if (migrate) await f.db.exec(read(MIGRATION));
  f.actor = { id: f.actorId };
  const fetchImpl = async (url, options) => {
    const response = await f.fetchImpl(url, options);
    if (f.missingDocument && new URL(url).pathname.endsWith('/pa_commercial_documents') && (!options?.method || options.method === 'GET')) {
      const original = await response.json();
      return { ...response, json: async () => original.map(row => ({ ...row, ...(Object.hasOwn(row, 'content') ? { content: null } : {}) })) };
    }
    return response;
  };
  f.service = createService({ fetchImpl, ...(transport ? { sendTransport: transport } : {}) });
  f.contract = contractService({ fetchImpl: f.fetchImpl });
  f.createEstimate = (mode = MODE) => f.service.issueEstimate({ case_id: f.inquiryId,
    expected_revision: 0, expected_current: null, operation_id: crypto.randomUUID(), document_id: crypto.randomUUID(),
    filename: '見積書 2026.10.18 龍姫湖まつり（正式原本）.pdf', content_base64: f.quote.toString('base64'),
    sha256: sha(f.quote), amount_minor: 110000, currency: 'JPY', tax_basis: 'tax_included', conditions: { source: 'PAM-025 fixture' },
    source_kind: 'managed_send', source_sent_at: null, body: '御見積書を添付しております。', cc_addresses: [], confirmation_mode: mode
  }, f.actor);
  return f;
}
const counts = async f => {
  const result = {};
  for (const table of ['pa_contract_offers', 'pa_contract_tokens', 'pa_commercial_outbox', 'pa_contracts', 'pa_case_progress'])
    result[table] = (await f.db.query(`select * from public.${table}`)).rows;
  return JSON.stringify(result);
};
async function main() {
  global.fetch = async () => { throw Error('LIVE_NETWORK_FORBIDDEN'); };
  const evidence = {}, f = await setup();
  try {
    const estimate = await f.createEstimate();
    assert.equal(estimate.outbox_id, null, 'explicit register-only operation creates no estimate outbox');
    const before = await counts(f);
    const previews = [];
    for (let i = 0; i < 3; i++) previews.push(await f.service.confirmationPreview({ case_id: f.inquiryId, confirmation_mode: MODE }, f.actor));
    const preview = previews[0];
    assert(previews.every(p => p.fingerprint === preview.fingerprint));
    assert.equal(preview.estimate.sent_at, null);
    assert.equal(preview.confirmation_mode, MODE);
    assert.equal(preview.estimate.sha256, sha(f.quote));
    assert.equal(preview.estimate.amount_minor, 110000);
    assert.match(preview.email.body, /御見積書を添付しております/);
    assert(!JSON.stringify(preview).includes('confirmation_token'));
    const receiptPreview = await f.service.confirmationReceiptPreview({ case_id: f.inquiryId, confirmation_mode: MODE, preview_fingerprint: preview.fingerprint }, f.actor);
    assert.equal(await counts(f), before, 'preview, refresh and receipt preview never create offers/tokens/outbox or waiting state');
    evidence.PREVIEW_READ_ONLY = 'PASS';

    const legacy = await f.service.confirmationPreview({ case_id: f.inquiryId }, f.actor);
    await assert.rejects(f.service.issueConfirmation({ case_id: f.inquiryId, preview_fingerprint: legacy.fingerprint, operation_id: crypto.randomUUID() }, f.actor), /stale_confirmation_preview/);
    evidence.LEGACY_UNSENT_GUARD = 'PASS';
    await assert.rejects(f.service.confirmationPreview({ case_id: f.inquiryId, confirmation_mode: 'implicit' }, f.actor), /invalid_contract/);
    await assert.rejects(f.service.issueConfirmation({ case_id: f.inquiryId, confirmation_mode: MODE, preview_fingerprint: legacy.fingerprint, operation_id: crypto.randomUUID() }, f.actor), /stale_confirmation_preview/);

    async function stale(label, mutate, restore) {
      const p = await f.service.confirmationPreview({ case_id: f.inquiryId, confirmation_mode: MODE }, f.actor);
      await mutate();
      await assert.rejects(f.service.issueDirectConfirmationAndSend({ case_id: f.inquiryId, confirmation_mode: MODE, preview_fingerprint: p.fingerprint, operation_id: crypto.randomUUID() }, f.actor));
      assert.equal(f.state.sendCount, 0, label);
      await restore();
      evidence[label] = 'PASS';
    }
    const changeImmutable = async (table, sql, values) => {
      await f.db.exec(`alter table public.${table} disable trigger user`);
      try { await f.db.query(sql, values); } finally { await f.db.exec(`alter table public.${table} enable trigger user`); }
    };
    await stale('STALE_REVISION', () => changeImmutable('pa_estimate_revisions', 'update pa_estimate_revisions set revision_number=revision_number+1 where id=$1', [estimate.id]), () => changeImmutable('pa_estimate_revisions', 'update pa_estimate_revisions set revision_number=1 where id=$1', [estimate.id]));
    await stale('AMOUNT_MISMATCH', () => changeImmutable('pa_estimate_revisions', 'update pa_estimate_revisions set amount_minor=110001 where id=$1', [estimate.id]), () => changeImmutable('pa_estimate_revisions', 'update pa_estimate_revisions set amount_minor=110000 where id=$1', [estimate.id]));
    const estimateRow = (await f.db.query('select * from pa_estimate_revisions where id=$1', [estimate.id])).rows[0];
    await stale('MISSING_PDF', async () => { f.missingDocument = true; }, async () => { f.missingDocument = false; });
    await stale('WRONG_CASE', () => f.db.query('update pa_case_commercial_state set current_estimate_revision_id=null where inquiry_id=$1', [f.inquiryId]), () => f.db.query('update pa_case_commercial_state set current_estimate_revision_id=$2 where inquiry_id=$1', [f.inquiryId, estimate.id]));
    await stale('WRONG_RECIPIENT', () => f.db.query("update pa_inquiries set email='other@example.invalid' where id=$1", [f.inquiryId]), () => f.db.query("update pa_inquiries set email='customer@example.invalid' where id=$1", [f.inquiryId]));
    await stale('WRONG_THREAD', () => f.db.query("update pa_gmail_thread_links set gmail_thread_id='thread_other_wrong' where inquiry_id=$1", [f.inquiryId]), () => f.db.query("update pa_gmail_thread_links set gmail_thread_id='thread_123' where inquiry_id=$1", [f.inquiryId]));
    await stale('CONDITIONS_CHANGING', () => f.db.query("update pa_case_commercial_state set estimate_change_state='reconfirming' where inquiry_id=$1", [f.inquiryId]), () => f.db.query("update pa_case_commercial_state set estimate_change_state='ready' where inquiry_id=$1", [f.inquiryId]));
    await assert.rejects(f.service.issueDirectConfirmationAndSend({ case_id: f.otherId, confirmation_mode: MODE, preview_fingerprint: preview.fingerprint, operation_id: crypto.randomUUID() }, f.actor));
    evidence.CROSS_CASE_IDOR = 'PASS';
    assert.equal((await f.db.query('select count(*) n from pa_contract_offers')).rows[0].n, 0);

    const fresh = await f.service.confirmationPreview({ case_id: f.inquiryId, confirmation_mode: MODE }, f.actor);
    const finalInput = { case_id: f.inquiryId, confirmation_mode: MODE, preview_fingerprint: fresh.fingerprint, operation_id: crypto.randomUUID() };
    const sent = await f.service.issueDirectConfirmationAndSend(finalInput, f.actor);
    assert.equal(sent.state, 'sent');
    assert.equal(f.state.sendCount, 1, 'one fake provider send');
    const replay = await f.service.issueDirectConfirmationAndSend(finalInput, f.actor);
    assert.equal(replay.already_committed, true); assert.equal(f.state.sendCount, 1);
    const offer = (await f.db.query('select * from pa_contract_offers where id=$1', [sent.id])).rows[0];
    assert.deepEqual(Buffer.from(offer.quote_pdf), f.quote);
    assert.equal(offer.quote_sha256, sha(f.quote));
    assert.equal(offer.snapshot.estimate.estimate_id, estimate.id);
    assert.equal(offer.snapshot.estimate.amount_minor, 110000);
    assert.equal(offer.snapshot.estimate.sha256, sha(f.quote));
    const raw = Buffer.from(f.state.lastRaw.raw, 'base64url').toString('utf8');
    assert.equal(f.state.lastRaw.threadId, 'thread_123');
    assert.equal((raw.match(/Content-Type: application\/pdf/gu) || []).length, 1);
    const attachmentPart = raw.split(/Content-Type: application\/pdf/iu)[1];
    const content = attachmentPart.split(/\r?\n\r?\n/u)[1].split(/\r?\n--/u)[0];
    assert.deepEqual(Buffer.from(content.replace(/\s/g, ''), 'base64'), f.quote);
    const filenameParts = [...raw.matchAll(/filename\*(?:\d+\*)?=(?:UTF-8'')?([^;\r\n]+)/giu)].map(match => match[1].trim());
    assert.equal(decodeURIComponent(filenameParts.join('')), offer.snapshot.estimate.original_filename);
    const plainPart = raw.split(/Content-Type: text\/plain[^\r\n]*/iu)[1];
    const plain = plainPart.split(/\r?\n\r?\n/u).slice(1).join('\n\n').split(/\r?\n--/u)[0];
    assert.equal((plain.match(/https:\/\/example\.invalid\/pa-contract\.html#[a-f0-9]{64}/gu) || []).length, 1, plain);
    const snapshot = await f.service.snapshot(f.inquiryId);
    const delivery = snapshot.estimates.find(e => e.id === estimate.id).delivery;
    assert.equal(delivery.id, sent.outbox_id); assert.equal(delivery.provider_message_id, sent.provider_message_id);
    assert.equal(delivery.state, 'sent');
    evidence.DIRECT_CONFIRM_WITH_ESTIMATE = evidence.PDF_BYTE_IDENTITY = evidence.CONFIRMATION_BINDING = evidence.EMAIL_ATTACHMENT = evidence.JAPANESE_FILENAME = evidence.DOUBLE_SEND_GUARD = 'PASS';

    await assert.rejects(f.service.confirmationPreview({ case_id: f.inquiryId, confirmation_mode: MODE }, f.actor), /confirmation_already_active/);
    evidence.PENDING_CONFIRMATION = 'PASS';
    const job = (await f.db.query('select * from pa_commercial_outbox where id=$1', [sent.outbox_id])).rows[0];
    const token = decryptSecret(job.secret_envelope).split('#')[1];
    await assert.rejects(f.contract.accept({ token, offer_id: sent.id, snapshot_sha256: offer.snapshot_sha256, confirmer_name: '検証者', agree: false }), /consent_required/);
    const accepted = await f.contract.accept({ token, offer_id: sent.id, snapshot_sha256: offer.snapshot_sha256, confirmer_name: '検証者', agree: true });
    assert.equal(accepted.state, 'accepted');
    const contract = (await f.db.query('select snapshot from pa_contracts where id=$1', [sent.id])).rows[0].snapshot;
    assert.equal(contract.explicit_consent.cancellation, true); assert.equal(contract.explicit_consent.payment, true);
    assert.equal(contract.explicit_consent.quote_sha256, sha(f.quote));
    await assert.rejects(f.service.confirmationPreview({ case_id: f.inquiryId, confirmation_mode: MODE }, f.actor), /contract_already_accepted/);
    const receipt = await f.contract.ensureReceipt(f.inquiryId, sent.id);
    const merged = await PDFDocument.load(receipt.bytes), source = await PDFDocument.load(f.quote);
    assert.equal(merged.getPageCount(), source.getPageCount() + 2);
    const streams = (doc, page) => { const raw = page.node.Contents(); return (raw instanceof PDFArray ? raw.asArray() : [raw]).map(ref => Buffer.from(decodePDFRawStream(doc.context.lookup(ref)).decode()).toString('hex')).join(':'); };
    assert.equal(streams(merged, merged.getPage(2)), streams(source, source.getPage(0)));
    assert.deepEqual(merged.getPage(2).getSize(), source.getPage(0).getSize());
    assert.deepEqual(Buffer.from((await f.db.query('select quote_pdf from pa_contract_offers where id=$1', [sent.id])).rows[0].quote_pdf), f.quote);
    const renderInput = (await PDFDocument.load(receiptPreview.bytes)).getPageCount();
    assert.equal(renderInput, merged.getPageCount());
    evidence.CUSTOMER_ACCEPT = evidence.RECEIPT_V4_1 = evidence.ALREADY_ACCEPTED = 'PASS';
    // Reapply the function-only migration within an explicit rollback dry run.
    const dry = read(MIGRATION).replace(/^begin;/u, '').replace(/commit;\s*$/u, '');
    const beforeDry = await counts(f);
    await f.db.exec('begin;\n' + dry + '\nrollback;');
    assert.equal(await counts(f), beforeDry);
    evidence.MIGRATION_LOCAL_DRY_RUN = 'PASS_ROLLED_BACK';
  } finally { await f.db.close(); }

  for (const outcome of ['success', 'failure', 'ambiguous', 'post_send_failure', 'server_error']) {
    let calls = 0, attachments;
    const f = await setup({ transport: async (_job, docs, trace) => {
      calls++; attachments = docs;
      if (outcome === 'ambiguous') throw Error('fixture_response_lost');
      trace.provider_response_received = true; trace.provider_http_status = outcome === 'failure' ? 400 : outcome === 'server_error' ? 503 : 200;
      if (outcome === 'failure') throw Error('gmail_send_400');
      if (outcome === 'post_send_failure') throw Error('fixture_sync_failed');
      if (outcome === 'server_error') throw Error('gmail_send_503');
      return { gmail_message_id: 'fake-direct-1', gmail_thread_id: 'thread_123' };
    } });
    try {
      const estimate = await f.createEstimate('LEGACY');
      const p = await f.service.confirmationPreview({ case_id: f.inquiryId, confirmation_mode: MODE }, f.actor);
      const input = { case_id: f.inquiryId, confirmation_mode: MODE, preview_fingerprint: p.fingerprint, operation_id: crypto.randomUUID() };
      if (outcome === 'success') await f.service.issueDirectConfirmationAndSend(input, f.actor);
      else await assert.rejects(f.service.issueDirectConfirmationAndSend(input, f.actor));
      const replay = await f.service.issueDirectConfirmationAndSend(input, f.actor);
      assert.equal(calls, 1); assert.equal(replay.state, { success: 'sent', failure: 'failed', ambiguous: 'unknown', post_send_failure: 'unknown', server_error: 'unknown' }[outcome]);
      assert.equal(attachments.length, 1); assert.deepEqual(Buffer.from(attachments[0].data, 'base64url'), f.quote);
      const state = await f.service.snapshot(f.inquiryId);
      assert.equal(state.estimates[0].delivery.state, replay.state);
      assert.equal(state.estimates[0].delivery.id, replay.outbox_id);
      assert.equal(state.outbox.find(j => j.id === estimate.outbox_id).state, 'cancelled');
      assert.equal((await f.service.dispatch({ job_id: estimate.outbox_id }, f.actor)).state, 'cancelled');
      assert.equal(calls, 1);
      if (['ambiguous', 'post_send_failure', 'server_error'].includes(outcome)) {
        await assert.rejects(f.service.dispatch({ case_id: f.inquiryId, offer_id: replay.id, job_id: replay.outbox_id, preview_fingerprint: p.fingerprint }, f.actor));
        assert.equal(calls, 1); evidence.AUTO_RESEND = 0;
      }
      evidence['DELIVERY_' + outcome.toUpperCase()] = 'PASS';
    } finally { await f.db.close(); }
  }
  const legacyFixture = await setup({ transport: async () => ({ gmail_message_id: 'fake-legacy-1', gmail_thread_id: 'thread_123' }) });
  try {
    const e = await legacyFixture.createEstimate('LEGACY');
    assert(e.outbox_id);
    await legacyFixture.service.dispatch({ job_id: e.outbox_id }, legacyFixture.actor);
    const p = await legacyFixture.service.confirmationPreview({ case_id: legacyFixture.inquiryId }, legacyFixture.actor);
    const issued = await legacyFixture.service.issueConfirmation({ case_id: legacyFixture.inquiryId, preview_fingerprint: p.fingerprint, operation_id: crypto.randomUUID() }, legacyFixture.actor);
    assert(issued.id); evidence.ESTIMATE_ONLY_FLOW_REGRESSION = 'PASS';
    await legacyFixture.service.revoke({ case_id: legacyFixture.inquiryId, offer_id: issued.id, operation_id: crypto.randomUUID(), reason: 'fixture revoke' }, legacyFixture.actor);
    await assert.rejects(legacyFixture.service.confirmationSendPreview({ case_id: legacyFixture.inquiryId, offer_id: issued.id }, legacyFixture.actor));
    evidence.REVOKED_HISTORICAL = 'PASS';
  } finally { await legacyFixture.db.close(); }

  // New-mode replacement reuses the existing atomic revoke/reissue transaction.
  // No implicit promotion to legacy mode; the unsent estimate stays unsent.
  let directCalls = 0;
  const history = await setup({ transport: async () => { directCalls++; return { gmail_message_id: 'fake-history-1', gmail_thread_id: 'thread_123' }; } });
  try {
    await history.createEstimate();
    const p = await history.service.confirmationPreview({ case_id: history.inquiryId, confirmation_mode: MODE }, history.actor);
    const issued = await history.service.issueConfirmation({ case_id: history.inquiryId, confirmation_mode: MODE, preview_fingerprint: p.fingerprint, operation_id: crypto.randomUUID() }, history.actor);
    const replacement = await history.service.confirmationPreview({ case_id: history.inquiryId, replace_offer_id: issued.id }, history.actor);
    assert.equal(replacement.confirmation_mode, MODE);
    const next = await history.service.replaceConfirmation({ case_id: history.inquiryId, old_offer_id: issued.id, expected_old_version: 1, preview_fingerprint: replacement.fingerprint, operation_id: crypto.randomUUID(), reason: 'fixture replacement' }, history.actor);
    assert.equal(next.version, 2); assert.equal(directCalls, 0);
    await assert.rejects(history.service.confirmationSendPreview({ case_id: history.inquiryId, offer_id: issued.id }, history.actor));
    const nextPreview = await history.service.confirmationSendPreview({ case_id: history.inquiryId, offer_id: next.id }, history.actor);
    assert.equal(nextPreview.confirmation_mode, MODE);
    await history.db.query('select pa_v5_authorize_confirmation_send($1,$2,$3,$4,$5)', [history.actorId, history.inquiryId, next.id, next.outbox_id, nextPreview.fingerprint]);
    await history.db.query('select pa_v5_outbox_claim($1,$2,$3)', [history.actorId, next.outbox_id, crypto.randomUUID()]);
    await history.db.query("update pa_commercial_outbox set lease_expires_at=now()-interval '1 minute' where id=$1", [next.outbox_id]);
    await assert.rejects(history.db.query('select pa_v5_outbox_claim($1,$2,$3)', [history.actorId, next.outbox_id, crypto.randomUUID()]), /outbox_unknown_requires_reconciliation/);
    assert.equal(directCalls, 0);
    evidence.DIRECT_REVOKE_REISSUE = evidence.EXPIRED_LEASE_NO_RESEND = 'PASS';
  } finally { await history.db.close(); }

  const parallel = await setup({ transport: async () => ({ gmail_message_id: 'fake-parallel-1', gmail_thread_id: 'thread_123' }) });
  try {
    await parallel.createEstimate();
    let calls = 0;
    parallel.service = createService({ fetchImpl: parallel.fetchImpl, sendTransport: async () => { calls++; return { gmail_message_id: 'fake-parallel-1', gmail_thread_id: 'thread_123' }; } });
    const p = await parallel.service.confirmationPreview({ case_id: parallel.inquiryId, confirmation_mode: MODE }, parallel.actor);
    const input = { case_id: parallel.inquiryId, confirmation_mode: MODE, preview_fingerprint: p.fingerprint, operation_id: crypto.randomUUID() };
    const results = await Promise.allSettled([parallel.service.issueDirectConfirmationAndSend(input, parallel.actor), parallel.service.issueDirectConfirmationAndSend(input, parallel.actor)]);
    assert(results.some(r => r.status === 'fulfilled' && r.value.state === 'sent'));
    assert.equal(calls, 1);
    assert.equal(Number((await parallel.db.query('select count(*) n from pa_contract_offers')).rows[0].n), 1);
    evidence.CONCURRENT_FINAL_OPERATION = 'PASS_ONE_FAKE_SEND';
  } finally { await parallel.db.close(); }

  // Change the case after server preview generation but just before the SQL RPC.
  // The transaction must reject it rather than freeze an unseen case revision.
  const race = await setup();
  try {
    await race.createEstimate();
    const p = await race.service.confirmationPreview({ case_id: race.inquiryId, confirmation_mode: MODE }, race.actor);
    const changingFetch = async (url, options) => {
      if (new URL(url).pathname.endsWith('/rpc/pa_v5_issue_confirmation')) await race.db.query("update pa_inquiries set updated_at=clock_timestamp(),venue='changed fixture venue' where id=$1", [race.inquiryId]);
      return race.fetchImpl(url, options);
    };
    const service = createService({ fetchImpl: changingFetch });
    await assert.rejects(service.issueDirectConfirmationAndSend({ case_id: race.inquiryId, confirmation_mode: MODE, preview_fingerprint: p.fingerprint, operation_id: crypto.randomUUID() }, race.actor), /stale_confirmation_preview/);
    assert.equal(Number((await race.db.query('select count(*) n from pa_contract_offers')).rows[0].n), 0);
    assert.equal(race.state.sendCount, 0);
    evidence.DB_FRESH_BINDING_RACE = 'PASS';
  } finally { await race.db.close(); }
  evidence.REAL_GMAIL_SEND = 0; evidence.PRODUCTION_MUTATION = 0;
  if (process.argv[2]) { fs.mkdirSync(process.argv[2], { recursive: true }); fs.writeFileSync(path.join(process.argv[2], 'pam-025-tests.json'), JSON.stringify(evidence, null, 2)); }
  console.log(JSON.stringify(evidence, null, 2));
}
module.exports = { setup, MODE, MIGRATION };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
