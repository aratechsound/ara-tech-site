const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const gmail = require('../api/_pa-gmail.cjs');
const {
  createService,
  encryptSecret,
  assertLegacyConfirmationRecovery,
  LEGACY_CONFIRMATION_RECOVERY_AUTHORITY: AUTHORITY,
  postgresJsonbText
} = require('../api/_pa-commercial.cjs');
const { issuanceTermsV4 } = require('../api/_pa-contract-terms.cjs');

Object.assign(process.env, {
  SUPABASE_URL: 'https://fixture.invalid',
  SUPABASE_SERVICE_ROLE_KEY: 'fixture-preview-secret',
  GMAIL_CLIENT_ID: 'fixture-client',
  GMAIL_CLIENT_SECRET: 'fixture-secret',
  GMAIL_REFRESH_TOKEN: 'fixture-refresh',
  GMAIL_SENDER_ADDRESS: 'aratechsound@gmail.com',
  GMAIL_REPLY_TO: 'aratechsound@gmail.com'
});

const actorId = '123e4567-e89b-42d3-a456-426614174001';
const subject = 'Re: 【ARA-TECH】正式受注確認';
const inquiry = {
  id: AUTHORITY.case_id,
  email: AUTHORITY.recipient,
  customer_name: '竹林 智也',
  contact_name: '竹林 智也',
  organization_name: '安芸太田町 産業観光課 商工観光係',
  event_name: '2026龍姫湖まつり',
  event_date: '2026-10-18',
  event_time: '10:00〜15:00',
  venue: '温井ダム堤体横駐車場（広島県山県郡安芸太田町加計1956-2）',
  request_summary: 'PA・音響・電源対応',
  internal_memo: '[TEST] 2026龍姫湖まつり 正式受注E2E\nfixture'
};
const confirmationBodyTemplate = `${inquiry.contact_name} 様\n\nお世話になっております。\nARA-TECHの荒殿です。\n\n「${inquiry.event_name}」の正式受注確認をご案内いたします。\n対象のお見積り、キャンセル・変更条件、お支払期限をご確認ください。\n\n確認ページ：{{CONFIRMATION_URL}}\n\nご不明な点や調整が必要な事項がございましたら、正式依頼の前にこのメールへご返信ください。\n\nよろしくお願いいたします。\n\nARA-TECH\n荒殿`;
// Use the DB-authored snapshot shape, not the generator's superset.
// Extract independently from the migration; do not call the recovery projection under test.
const generatedTerms = issuanceTermsV4(inquiry.event_date);
const persistedTermsSql = require('node:fs').readFileSync(require('node:path').join(__dirname,
  '../supabase/migrations/20260914100000_pa_est_005a_confirmation_snapshot_compat.sql'), 'utf8');
const persistedTermsBlock = persistedTermsSql.split("'terms',jsonb_build_object(")[1].split("'issuance',")[0];
const persistedTermsKeys = [...persistedTermsBlock.matchAll(/'([^']+)',p_snapshot->>?'/g)].map((match) => match[1]);
assert.equal(persistedTermsKeys.length, 14);
assert.equal(new Set(persistedTermsKeys).size, 14);
const terms = Object.fromEntries(persistedTermsKeys.map((key) => [key, generatedTerms[key] ?? null]));
assert.notDeepEqual(terms, generatedTerms, 'Persisted terms must not copy generator-only fields.');
const snapshot = {
  snapshot_schema_version: 'PA-FORMAL-V5-20260914-1',
  case: { event_name: inquiry.event_name, event_date: inquiry.event_date, event_time: inquiry.event_time, venue: inquiry.venue, service_scope: inquiry.request_summary },
  customer: { organization: inquiry.organization_name, department: null, contact_name: inquiry.contact_name, display_name: `${inquiry.organization_name} ${inquiry.contact_name}` },
  estimate: {
    estimate_id: AUTHORITY.estimate_id, revision_number: 2, amount_minor: 198550, currency: 'JPY',
    original_filename: AUTHORITY.filename, document_id: AUTHORITY.document_id,
    mime_type: AUTHORITY.mime_type, sha256: AUTHORITY.sha256, sent_at: '2026-09-11T00:00:00Z'
  },
  terms,
  customer_acknowledgement: { estimate_revision_id: AUTHORITY.estimate_id, amount_minor: 198550, source: 'owner_pre_issue_preview' },
  conditions: {},
  recipient: AUTHORITY.recipient,
  payment_due_date: terms.payment_due_date,
  quote: { filename: AUTHORITY.filename, mime_type: AUTHORITY.mime_type, sha256: AUTHORITY.sha256, size: AUTHORITY.byte_size }
};
const snapshotSha = crypto.createHash('sha256').update(postgresJsonbText(snapshot)).digest('hex');

const baseEvidence = () => ({
  metadata: {
    state: 'active', test_case_id: AUTHORITY.case_id, test_estimate_id: AUTHORITY.estimate_id,
    test_document_id: AUTHORITY.document_id, allowed_recipient: AUTHORITY.recipient,
    source_estimate_sha: AUTHORITY.sha256, source_confirmation_subject: subject, created_by: actorId
  },
  job: {
    id: AUTHORITY.outbox_id, inquiry_id: AUTHORITY.case_id, aggregate_id: AUTHORITY.offer_id,
    job_kind: 'confirmation', state: 'failed', delivery_state: 'failed_before_provider',
    recipient: AUTHORITY.recipient, subject, body_text: confirmationBodyTemplate,
    reply_binding: { delivery_mode: 'standalone_production_e2e' }, attachment_ids: [AUTHORITY.document_id],
    secret_envelope: 'fixture-secret-envelope', provider_request_started: false,
    provider_response_received: false, provider_http_status: null, provider_message_id: null, provider_thread_id: null,
    failure_phase: 'preview_validation', failure_code: 'invalid_confirmation'
  },
  offers: [{ id: AUTHORITY.offer_id }],
  offer: {
    id: AUTHORITY.offer_id, inquiry_id: AUTHORITY.case_id, version: 1, expires_at: '2099-01-01T00:00:00Z',
    issued_by: actorId, estimate_revision_id: AUTHORITY.estimate_id, snapshot, snapshot_sha256: snapshotSha,
    quote_sha256: AUTHORITY.sha256
  },
  tokens: [{ offer_id: AUTHORITY.offer_id, state: 'active', token_hash: 'a'.repeat(64) }],
  contracts: [],
  estimate: {
    id: AUTHORITY.estimate_id, inquiry_id: AUTHORITY.case_id, document_id: AUTHORITY.document_id,
    revision_number: 2, amount_minor: 198550, currency: 'JPY', conditions_snapshot: {}
  },
  document: {
    id: AUTHORITY.document_id, inquiry_id: AUTHORITY.case_id, original_filename: AUTHORITY.filename,
    mime_type: AUTHORITY.mime_type, sha256: AUTHORITY.sha256
  },
  inquiry,
  state: { current_estimate_revision_id: AUTHORITY.estimate_id },
  actorId,
  legacyPreview: { expired: true, attachment_count: 0, attachments_hash: gmail.EMPTY_REPLY_ATTACHMENTS_HASH },
  gmailSentCount: 0,
  customerUrlAuthorityMatches: true,
  customerUrlTokenHashMatches: true,
  documentByteSize: AUTHORITY.byte_size,
  documentComputedSha: AUTHORITY.sha256,
  offerQuoteByteSize: AUTHORITY.byte_size,
  offerQuoteComputedSha: AUTHORITY.sha256,
  offerQuoteMatchesDocument: true
});

const cloned = (value) => structuredClone(value);
const rejected = (mutate, label) => {
  const evidence = cloned(baseEvidence());
  mutate(evidence);
  assert.throws(() => assertLegacyConfirmationRecovery(evidence), /production_e2e_recovery_blocked/u, label);
};

(async () => {
  const eligible = assertLegacyConfirmationRecovery(baseEvidence());
  assert.equal(eligible.eligible, true);
  assert.deepEqual(eligible.reasons, ['legacy_preview_expired', 'legacy_attachment_manifest_mismatch']);

  let providerCalls = 0;
  const json = (value, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => value });
  const fetchImpl = async (target) => {
    const url = new URL(target);
    if (url.origin === 'https://fixture.invalid' && url.pathname === '/rest/v1/pa_inquiries') return json([inquiry]);
    if (url.origin === 'https://oauth2.googleapis.com') return json({ access_token: 'fixture-access' });
    if (url.origin === 'https://gmail.googleapis.com' && url.pathname.endsWith('/messages/send')) {
      providerCalls += 1;
      return json({ id: 'gmail_fixture_message', threadId: 'gmail_fixture_thread' });
    }
    throw new Error(`LIVE_NETWORK_FORBIDDEN ${url.origin}${url.pathname}`);
  };
  const attachment = { filename: AUTHORITY.filename, mime_type: AUTHORITY.mime_type, data: Buffer.from('isolated estimate fixture').toString('base64url') };
  const body = confirmationBodyTemplate.replace('{{CONFIRMATION_URL}}', 'https://ara-tech.cc/pa-contract.html#' + 'a'.repeat(64));
  const realNow = Date.now;
  let now = 1800000000000;
  Date.now = () => now;
  try {
    const expiredPreview = await gmail.standalonePreview({ inquiryId: AUTHORITY.case_id, actorId, body, attachments: [attachment], mode: 'confirmation', subjectOverride: subject }, fetchImpl);
    now += 11 * 60 * 1000;
    await assert.rejects(gmail.sendStandalone({
      inquiryId: AUTHORITY.case_id, actorId, body, attachments: [attachment], confirmationToken: expiredPreview.confirmation_token,
      subjectOverride: subject, jobId: AUTHORITY.outbox_id
    }, fetchImpl), /invalid_confirmation/u, 'TEST-A expired normal authorization remains invalid');
    assert.equal(providerCalls, 0);

    const legacy = await gmail.standalonePreview({ inquiryId: AUTHORITY.case_id, actorId, body, attachments: [], mode: 'confirmation', subjectOverride: subject }, fetchImpl);
    await assert.rejects(gmail.sendStandalone({
      inquiryId: AUTHORITY.case_id, actorId, body, attachments: [attachment], confirmationToken: legacy.confirmation_token,
      subjectOverride: subject, jobId: AUTHORITY.outbox_id
    }, fetchImpl), /invalid_confirmation/u, 'TEST-B attachment mismatch remains invalid');
    assert.equal(providerCalls, 0);
    now += 11 * 60 * 1000;
    const legacyContent = await gmail.standaloneContentPreview({ inquiryId: AUTHORITY.case_id, actorId, body, mode: 'confirmation', subjectOverride: subject }, fetchImpl);
    const inspected = gmail.inspectExpiredEmptyStandalonePreview({
      token: legacy.confirmation_token,
      fields: { inquiryId: AUTHORITY.case_id, actorId, recipient: legacyContent.recipient, subject: legacyContent.subject, body: legacyContent.body }
    });
    assert.equal(inspected.attachments_hash, '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945');

    const fresh = await gmail.standalonePreview({ inquiryId: AUTHORITY.case_id, actorId, body, attachments: [attachment], mode: 'confirmation', subjectOverride: subject }, fetchImpl);
    assert.notEqual(fresh.confirmation_token, legacy.confirmation_token);
    assert.equal(fresh.attachments.length, 1);
    const sent = await gmail.sendStandalone({
      inquiryId: AUTHORITY.case_id, actorId, body, attachments: [attachment], confirmationToken: fresh.confirmation_token,
      subjectOverride: subject, jobId: AUTHORITY.outbox_id
    }, fetchImpl);
    assert.equal(sent.production_e2e_standalone, true);
    assert.equal(providerCalls, 1, 'fresh token passes the unchanged normal validator to the fake provider');
  } finally {
    Date.now = realNow;
  }

  rejected((e) => { e.job.recipient = 'other@example.invalid'; }, 'TEST-C recipient');
  rejected((e) => { e.job.inquiry_id = crypto.randomUUID(); }, 'TEST-D case');
  rejected((e) => { e.job.aggregate_id = crypto.randomUUID(); }, 'TEST-E offer');
  rejected((e) => { e.contracts.push({ id: AUTHORITY.offer_id }); }, 'TEST-F contract');
  rejected((e) => { e.job.provider_request_started = true; }, 'TEST-G provider started');
  rejected((e) => { e.gmailSentCount = 1; }, 'TEST-H Gmail Sent existing');
  rejected((e) => { e.metadata.test_case_id = 'cae57d4c-0b19-4fc0-b1d9-b7bb75284ce3'; }, 'TEST-I real case #6');
  rejected((e) => { e.job.recipient = 't.takebayashi515@akiota.jp'; }, 'TEST-J real customer recipient');
  rejected((e) => { e.documentComputedSha = '69' + AUTHORITY.sha256.slice(2); }, 'TEST-K SHA');
  rejected((e) => { e.document.original_filename += '.changed'; }, 'TEST-L filename');
  rejected((e) => { e.document.mime_type = 'application/octet-stream'; }, 'TEST-M MIME');
  rejected((e) => { e.documentByteSize += 1; }, 'TEST-N byte size');
  rejected((e) => { e.document.id = crypto.randomUUID(); }, 'TEST-O document ID');

  process.env.PA_COMMERCIAL_OUTBOX_KEY = '77'.repeat(32);
  process.env.PA_PUBLIC_ORIGIN = 'https://ara-tech.cc';
  const integrationBytes = Buffer.from('isolated recovery integration estimate PDF fixture');
  const integrationSha = crypto.createHash('sha256').update(integrationBytes).digest('hex');
  const integrationAuthority = { ...AUTHORITY, byte_size: integrationBytes.length, sha256: integrationSha };
  const integrationEvidence = cloned(baseEvidence());
  integrationEvidence.metadata.source_estimate_sha = integrationSha;
  integrationEvidence.document.sha256 = integrationSha;
  integrationEvidence.offer.quote_sha256 = integrationSha;
  integrationEvidence.offerQuoteComputedSha = integrationSha;
  integrationEvidence.offerQuoteByteSize = integrationBytes.length;
  integrationEvidence.documentComputedSha = integrationSha;
  integrationEvidence.documentByteSize = integrationBytes.length;
  integrationEvidence.offer.snapshot.estimate.sha256 = integrationSha;
  integrationEvidence.offer.snapshot.quote.sha256 = integrationSha;
  integrationEvidence.offer.snapshot.quote.size = integrationBytes.length;
  integrationEvidence.offer.snapshot_sha256 = crypto.createHash('sha256').update(postgresJsonbText(integrationEvidence.offer.snapshot)).digest('hex');
  const customerToken = 'b'.repeat(64);
  const customerUrl = `https://ara-tech.cc/pa-contract.html#${customerToken}`;
  integrationEvidence.tokens[0].token_hash = crypto.createHash('sha256').update(customerToken).digest('hex');
  integrationEvidence.job.secret_envelope = encryptSecret(customerUrl);
  const integrationBody = confirmationBodyTemplate.replace('{{CONFIRMATION_URL}}', customerUrl);
  let integrationNow = 1800000000000;
  Date.now = () => integrationNow;
  const oldAuthorization = await gmail.standalonePreview({
    inquiryId: AUTHORITY.case_id, actorId, body: integrationBody, attachments: [], mode: 'confirmation', subjectOverride: subject
  }, fetchImpl);
  integrationEvidence.job.reply_binding.confirmation_token = oldAuthorization.confirmation_token;
  integrationNow += 11 * 60 * 1000;
  integrationEvidence.offer.quote_pdf = '\\x' + integrationBytes.toString('hex');
  integrationEvidence.document.content = '\\x' + integrationBytes.toString('hex');
  let claimCount = 0;
  let finishCount = 0;
  let freshAuthorizationSeen = false;
  const integrationFetch = async (target, options = {}) => {
    const url = new URL(target);
    if (url.origin === 'https://fixture.invalid') {
      if (url.pathname.startsWith('/rest/v1/rpc/')) {
        const rpc = url.pathname.split('/').at(-1);
        if (rpc === 'pa_v5_outbox_claim') { claimCount += 1; return json({ state: 'processing' }); }
        if (rpc === 'pa_v5_outbox_finish_v2') { finishCount += 1; return json({ state: 'sent' }); }
        throw new Error(`UNEXPECTED_FIXTURE_RPC ${rpc}`);
      }
      const table = url.pathname.split('/').at(-1);
      const value = {
        pa_inquiries: [inquiry],
        pa_production_e2e_tests: [integrationEvidence.metadata],
        pa_commercial_outbox: [integrationEvidence.job],
        pa_contract_offers: [integrationEvidence.offer],
        pa_contract_tokens: integrationEvidence.tokens,
        pa_contracts: [],
        pa_estimate_revisions: [integrationEvidence.estimate],
        pa_commercial_documents: [integrationEvidence.document],
        pa_case_commercial_state: [integrationEvidence.state]
      }[table];
      if (value === undefined) throw new Error(`UNEXPECTED_FIXTURE_TABLE ${table}`);
      return json(value);
    }
    if (url.origin === 'https://oauth2.googleapis.com') return json({ access_token: 'fixture-access' });
    if (url.origin === 'https://gmail.googleapis.com' && url.pathname.endsWith('/messages')) return json({ messages: [] });
    if (url.origin === 'https://gmail.googleapis.com' && url.pathname.endsWith('/messages/send')) {
      providerCalls += 1;
      return json({ id: 'gmail_integration_message', threadId: 'gmail_integration_thread' });
    }
    throw new Error(`LIVE_NETWORK_FORBIDDEN ${url.origin}${url.pathname}`);
  };
  const service = createService({
    fetchImpl: integrationFetch,
    legacyRecoveryAuthority: integrationAuthority,
    sendTransport: async (job, attachments, trace, internal) => {
      assert.equal(job.id, AUTHORITY.outbox_id);
      assert.equal(attachments.length, 1);
      assert.notEqual(internal.legacyRecoveryAuthorization.confirmation_token, oldAuthorization.confirmation_token);
      freshAuthorizationSeen = true;
      const sent = await gmail.sendStandalone({
        inquiryId: job.inquiry_id, actorId: job.actor_id, body: integrationBody, attachments,
        attachmentAuthority: internal.legacyRecoveryAuthorization.attachment_authority,
        confirmationToken: internal.legacyRecoveryAuthorization.confirmation_token,
        subjectOverride: job.subject, jobId: job.id, deliveryTrace: trace
      }, integrationFetch);
      return { gmail_message_id: sent.gmail_message_id, gmail_thread_id: sent.gmail_thread_id };
    }
  });
  try {
    const recovered = await service.recoverProductionE2eDelivery({ case_id: AUTHORITY.case_id, job_id: AUTHORITY.outbox_id }, { id: actorId });
    assert.equal(recovered.state, 'sent');
    assert.equal(recovered.compatibility_recovery.legacy_preview_used_for_send, false);
    assert.equal(recovered.compatibility_recovery.fresh_preview_regenerated, true);
    assert.equal(recovered.compatibility_recovery.fresh_attachment_count, 1);
    assert.equal(freshAuthorizationSeen, true);
    assert.equal(claimCount, 1);
    assert.equal(finishCount, 1);
  } finally {
    Date.now = realNow;
  }

  console.log('PASS PA-EST-007R4-FIX1: exact TEST #1 legacy evidence, fresh ephemeral authorization, strict normal validation, 15 negative gates');
})().catch((error) => { console.error(error); process.exitCode = 1; });
