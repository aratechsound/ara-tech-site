const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PDFDocument } = require('pdf-lib');
const { createFixture } = require('./helpers/ara-case-fixture.cjs');
const { read } = require('./helpers/pa-estimate-fixture.cjs');
const publicIntake = require('../api/pa-inquiry.js');
const { getInquiry, sendContentHearingAndFinalize } = require('../api/_pa-mail.cjs');
const { linkIntakeFollowUp, syncCase } = require('../api/_pa-gmail.cjs');
const { createService: commercialService, decryptSecret } = require('../api/_pa-commercial.cjs');
const { createService: contractService } = require('../api/_pa-contract.cjs');
const { sha } = require('../api/_pa-contract-pdf.cjs');

const origin = 'http://127.0.0.1:8871';
const mailbox = 'aratechsound@gmail.com';
const amount = 110000;

async function submit(body) {
  const response = {
    setHeader() {},
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; return this; }
  };
  await publicIntake({
    method: 'POST', body, headers: { origin, host: '127.0.0.1:8871' },
    socket: { remoteAddress: '127.0.0.1' }
  }, response);
  assert.equal(response.statusCode, 200, JSON.stringify(response.body));
  return response.body;
}

function caseTransport(fixture) {
  const sent = [];
  const pending = new Set();
  const databaseRequest = async (...args) => {
    const request = fixture.fetchImpl(...args);
    pending.add(request);
    try {
      return await request;
    } finally {
      pending.delete(request);
    }
  };
  const fetchImpl = async (target, options = {}) => {
    const url = new URL(target);
    if (url.hostname === 'gmail.googleapis.com' && url.pathname.endsWith('/messages/send')) {
      assert.equal(options.method, 'POST');
      const request = JSON.parse(options.body);
      const mime = Buffer.from(request.raw, 'base64url').toString('utf8');
      const [headerBlock] = mime.split(/\r?\n\r?\n/u);
      const unfolded = headerBlock.replace(/\r?\n[ \t]+/gu, ' ');
      const header = name => new RegExp(`^${name}: (.+)$`, 'imu').exec(unfolded)?.[1].trim();
      const id = `fixture_sent_${sent.length + 1}`;
      const threadId = request.threadId || `fixture_thread_${sent.length + 1}`;
      const subject = header('Subject').replace(/=\?UTF-8\?B\?([^?]+)\?=/giu,
        (_, value) => Buffer.from(value, 'base64').toString('utf8'));
      const recipient = header('To');
      assert([mailbox, 'public-customer@example.invalid'].includes(recipient), recipient);
      const message = fixture.raw(id, threadId, mailbox, '隔離環境で送信したメール');
      message.labelIds = ['SENT'];
      message.internalDate = String(Date.now());
      message.payload.headers.find(row => row.name === 'To').value = recipient;
      message.payload.headers.find(row => row.name === 'Subject').value = subject;
      fixture.state.messages.set(id, message);
      const thread = fixture.state.threadMessages.get(threadId) || [];
      fixture.state.threadMessages.set(threadId, [...thread, message]);
      sent.push({ id, threadId, recipient, mime });
      return { ok: true, status: 200, json: async () => ({ id, threadId }) };
    }
    if (url.origin === 'https://fixture.invalid' && url.pathname.startsWith('/rest/v1/')) {
      assert.equal(options.headers?.authorization, 'Bearer fixture-service');
    }
    const response = await databaseRequest(target, options);
    if (url.origin !== 'https://fixture.invalid' || options.method || !response.ok) return response;
    const rows = await response.json();
    if (!Array.isArray(rows)) return response;
    // PostgREST encodes bytea columns as hexadecimal strings.
    return { ...response, json: async () => rows.map(row => Object.fromEntries(
      Object.entries(row).map(([key, value]) => [
        key, value instanceof Uint8Array ? '\\x' + Buffer.from(value).toString('hex') : value
      ])
    )) };
  };
  return { fetchImpl, sent, drain: () => Promise.allSettled(pending) };
}

async function installCommercialMigrations(db) {
  await db.exec("create function auth.role() returns text language sql stable as $$ select 'service_role'::text $$");
  await db.exec(read('20260914170000_pa_est_007r1_production_e2e.sql'));
  const recovery = read('20260914213000_pa_est_007r3_delivery_recovery.sql');
  const fixturesStart = recovery.search(/\r?\ndo \$\$\r?\ndeclare\r?\n  c_case constant/u);
  assert(fixturesStart > 0);
  await db.exec(recovery.slice(0, fixturesStart) + '\ncommit;');
  await db.exec(read('20260915093000_pa_est_010r1_safe_confirmation_reissue.sql'));
  await db.exec(read('20261008090000_pam025_direct_confirmation_with_estimate.sql'));
}

async function main() {
  const fixture = await createFixture();
  const { db } = fixture;
  const { fetchImpl, sent, drain } = caseTransport(fixture);
  const originalFetch = global.fetch;
  global.fetch = fetchImpl;
  try {
    Object.assign(process.env, {
      PA_COMMERCIAL_OUTBOX_KEY: '88'.repeat(32),
      PA_MAIL_ADAPTER: 'gmail',
      PA_PUBLIC_ORIGIN: 'https://example.invalid'
    });
    // The isolated REST adapter represents the server-side service role.
    await installCommercialMigrations(db);

    const submission = {
      submission_key: randomUUID(), form_source: 'direct', event_date: '2026-11-01',
      event_name: '公開フォームからの総合検証', time_undecided: '未定',
      venue_name: '隔離検証会場', venue_address: '隔離検証住所', venue_type: '屋内',
      expected_attendance: '21〜50名', event_overview: 'PA受付の隔離原文',
      event_status: '検討中', requested_services: ['PA・音響'], organizer_type: '個人',
      organizer_name: '検証担当者', organizer_email: 'public-customer@example.invalid',
      organizer_phone: '0000000000', requester_relation: '主催者本人',
      requester_authority: 'ある', contact_source: 'organizer', preferred_contact_method: 'メール',
      payer_source: 'contact', confirmation_consent: '同意する', website: ''
    };
    const registration = await submit(submission);
    assert.equal(registration.duplicate, false);
    assert.equal(registration.customer_receipt_status, 'sent');
    assert.equal(registration.internal_notification_status, 'sent');
    assert.equal(sent.length, 2);
    const duplicate = await submit(submission);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.inquiry_number, registration.inquiry_number);
    assert.equal(sent.length, 2, 'duplicate registration must not send another acknowledgement');
    const { rows } = await db.query(
      'select id,case_type from pa_inquiries where submission_key=$1', [submission.submission_key]
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].case_type, 'PA_EVENT');
    const caseId = rows[0].id;
    const actor = { id: fixture.actor };
    const inquiry = await getInquiry(caseId, fetchImpl);
    const followUp = await sendContentHearingAndFinalize({
      inquiry, subject: `${inquiry.inquiry_number} お問い合わせへの返信`,
      body: 'お問い合わせありがとうございます。会場の確認事項をお知らせください。',
      actorUserId: actor.id
    }, fetchImpl);
    assert.equal(followUp.delivery.status, 'sent');
    assert.equal((await getInquiry(caseId, fetchImpl)).status, 'waiting_customer_reply');
    const provider = sent.at(-1);
    const customerReply = fixture.raw('fixture_customer_reply', provider.threadId, inquiry.email,
      '確認事項を承知しました。見積書をお願いします。');
    customerReply.internalDate = String(Date.now());
    fixture.state.messages.set(customerReply.id, customerReply);
    fixture.state.threadMessages.get(provider.threadId).push(customerReply);
    const command = { inquiryId: caseId, deliveryId: followUp.delivery.id, actorId: actor.id };
    const otherId = randomUUID();
    await db.query(
      "insert into pa_inquiries(id,inquiry_number,customer_name,email,case_type,status,submission_source,submission_key) values($1,'PA-FIXTURE-OTHER','別の合成案件',$2,'PA_EVENT','new','public_form',$1)",
      [otherId, inquiry.email]
    );
    await assert.rejects(linkIntakeFollowUp({ ...command, inquiryId: otherId }, fetchImpl), /intake_follow_up_not_linkable/u);
    await db.query(
      "insert into pa_gmail_thread_links(inquiry_id,gmail_thread_id,link_source,conversation_role) values($1,$2,'manual','primary_conversation')",
      [otherId, provider.threadId]
    );
    const savedOtherLink = (await db.query('select * from pa_gmail_thread_links where inquiry_id=$1', [otherId])).rows;
    await assert.rejects(linkIntakeFollowUp(command, fetchImpl), /ambiguous_thread_link/u);
    assert.deepEqual((await db.query('select * from pa_gmail_thread_links where inquiry_id=$1', [otherId])).rows, savedOtherLink);
    assert.deepEqual((await db.query('select * from pa_gmail_thread_links where inquiry_id=$1', [caseId])).rows, []);
    await db.query('delete from pa_gmail_thread_links where inquiry_id=$1', [otherId]);
    const linked = await linkIntakeFollowUp(command, fetchImpl);
    assert.equal(linked.gmail_thread_id, provider.threadId);
    const linkedBeforeReplay = (await db.query('select * from pa_gmail_thread_links where inquiry_id=$1', [caseId])).rows;
    assert.equal((await linkIntakeFollowUp(command, fetchImpl)).id, linked.id);
    assert.deepEqual((await db.query('select * from pa_gmail_thread_links where inquiry_id=$1', [caseId])).rows, linkedBeforeReplay);
    assert.equal(sent.length, 3);
    const synced = await syncCase({ inquiryId: caseId, actorId: actor.id, linkedOnly: true }, fetchImpl);
    assert.equal(synced.primary_link.gmail_thread_id, provider.threadId);
    assert.deepEqual(synced.messages.filter(row => row.thread_id === provider.threadId)
      .map(row => row.id).sort(), [customerReply.id, provider.id].sort());
    assert.equal((await db.query(
      'select count(*)::int n from pa_gmail_message_index where inquiry_id=$1 and gmail_message_id=$2',
      [caseId, customerReply.id]
    )).rows[0].n, 1);

    const service = commercialService({ fetchImpl });
    const contract = contractService({ fetchImpl });
    const doc = await PDFDocument.create();
    doc.addPage().drawText('CONTROLLED FIXTURE - TOTAL JPY 110,000', { x: 45, y: 730 });
    const quote = Buffer.from(await doc.save());
    const revision = async () => Number((await db.query(
      'select revision from pa_case_commercial_state where inquiry_id=$1', [caseId]
    )).rows[0]?.revision || 0);
    const estimate = await service.issueEstimate({
      case_id: caseId, expected_revision: await revision(), expected_current: null,
      operation_id: randomUUID(), document_id: randomUUID(), filename: '隔離検証 見積書.pdf',
      content_base64: quote.toString('base64'), sha256: sha(quote), amount_minor: amount,
      currency: 'JPY', tax_basis: 'tax_included', conditions: { source: 'synthetic inquiry' },
      source_kind: 'managed_send', source_sent_at: null,
      body: '御見積書を添付しております。', cc_addresses: []
    }, actor);
    assert(estimate.outbox_id);
    assert.equal((await service.dispatch({ job_id: estimate.outbox_id }, actor)).state, 'sent');
    assert.equal(sent.at(-1).threadId, provider.threadId);
    assert.match(sent.at(-1).mime, /Content-Type: application\/pdf/iu);
    console.log('PASS public intake, duplicate submission, first reply, linked sync and estimate send');
    const preview = await service.confirmationPreview({ case_id: caseId }, actor);
    assert(preview.estimate.sent_at);
    const offer = await service.issueConfirmation({
      case_id: caseId, preview_fingerprint: preview.fingerprint, operation_id: randomUUID()
    }, actor);
    const binding = { case_id: caseId, offer_id: offer.id };
    const sendPreview = await service.confirmationSendPreview(binding, actor);
    assert.equal((await service.dispatch({
      ...binding, job_id: offer.outbox_id, preview_fingerprint: sendPreview.fingerprint
    }, actor)).state, 'sent');
    assert.equal(sent.at(-1).threadId, provider.threadId);
    const storedOffer = (await db.query(
      'select snapshot_sha256,quote_sha256 from pa_contract_offers where inquiry_id=$1 and id=$2',
      [caseId, offer.id]
    )).rows[0];
    assert.equal(storedOffer.quote_sha256, sha(quote));
    const outbox = (await db.query('select secret_envelope from pa_commercial_outbox where id=$1',
      [offer.outbox_id])).rows[0];
    const token = decryptSecret(outbox.secret_envelope).split('#')[1];
    const consent = {
      token, offer_id: offer.id, snapshot_sha256: storedOffer.snapshot_sha256, confirmer_name: '検証担当者'
    };
    await assert.rejects(contract.accept({ ...consent, agree: false }), /consent_required/u);
    const accepted = await contract.accept({ ...consent, agree: true });
    assert.equal(accepted.state, 'accepted');
    assert.equal(accepted.receipt_status, 'ready');
    assert.equal(accepted.email_status, 'sent');
    assert.equal(sent.at(-1).threadId, provider.threadId);
    const { snapshot } = (await db.query(
      'select snapshot from pa_contracts where id=$1 and inquiry_id=$2', [offer.id, caseId]
    )).rows[0];
    assert.equal(snapshot.acceptance.agreed, true);
    assert.equal(snapshot.terms.cancellation_terms, preview.customer_snapshot.terms.cancellation_terms);
    assert.equal(snapshot.terms.payment_terms, preview.customer_snapshot.terms.payment_terms);
    assert.equal(snapshot.estimate.sha256, sha(quote));
    console.log('PASS formal offer sent and accepted with explicit consent');

    await service.settle({
      case_id: caseId, expected_revision: await revision(), operation_id: randomUUID(),
      amount_minor: amount, unresolved_changes: false, evidence: { source: 'synthetic event completed' }
    }, actor);
    const invoiceDoc = await PDFDocument.create();
    invoiceDoc.addPage().drawText('CONTROLLED FIXTURE - INVOICE JPY 110,000', { x: 45, y: 730 });
    const invoice = Buffer.from(await invoiceDoc.save());
    const billing = await service.createBilling({
      case_id: caseId, expected_revision: await revision(), operation_id: randomUUID(),
      contract_id: offer.id, estimate_revision_id: estimate.id, amount_minor: amount,
      invoice_policy: 'separate_pdf', due_date: '2026-11-30',
      due_basis: { status: 'agreed', source: 'synthetic agreement' },
      agreement_evidence: { source: 'synthetic agreement' },
      document_id: randomUUID(), filename: '隔離検証 請求書.pdf',
      content_base64: invoice.toString('base64'), sha256: sha(invoice),
      body: 'ご請求書を添付しております。', cc_addresses: []
    }, actor);
    assert(billing.outbox_id);
    const close = {
      case_id: caseId, billing_id: billing.id, expected_revision: await revision(),
      operation_id: randomUUID(), payment_date: '2026-11-10', new_payment_minor: amount,
      payment_method: 'bank_transfer', memo: 'synthetic payment'
    };
    await assert.rejects(service.close(close, actor), /invoice_not_sent/u);
    assert.equal((await service.dispatch({ job_id: billing.outbox_id }, actor)).state, 'sent');
    assert.equal(sent.at(-1).threadId, provider.threadId);
    const [, attachment] = sent.at(-1).mime.split(/Content-Type: application\/pdf/iu);
    const [data] = attachment.split(/\r?\n\r?\n/u)[1].split(/\r?\n--/u);
    assert.deepEqual(Buffer.from(data.replace(/\s/gu, ''), 'base64'), invoice);
    const sendCount = sent.length;
    assert.equal((await service.dispatch({ job_id: billing.outbox_id }, actor)).already_committed, true);
    close.expected_revision = await revision();
    assert.equal((await service.close(close, actor)).state, 'closed');
    assert.equal((await service.close(close, actor)).already_committed, true);
    assert.equal(sent.length, sendCount);
    assert.equal(sendCount, 7, 'only the two acknowledgements, reply, estimate, offer, receipt and invoice');
    assert.equal((await db.query(
      'select count(*)::int n from pa_payment_records where inquiry_id=$1 and billing_id=$2',
      [caseId, billing.id]
    )).rows[0].n, 1);
    assert((await db.query('select closed_at from pa_case_progress where inquiry_id=$1', [caseId])).rows[0].closed_at);
    console.log('PASS public intake → first reply → linked sync → estimate sent → confirmation → consent → separate PDF invoice sent → payment → closed');
    console.log('PASS 7 simulated Gmail sends, 0 live Gmail sends or production DB changes');
  } finally {
    global.fetch = originalFetch;
    await drain();
    await db.close();
  }
}

if (require.main === module) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
module.exports = { caseTransport, installCommercialMigrations };
