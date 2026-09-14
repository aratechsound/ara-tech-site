const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const gmail = require('../api/_pa-gmail.cjs');

const root = path.join(__dirname, '..');
const adminSource = fs.readFileSync(path.join(root, 'js', 'pa-admin.js'), 'utf8');
const adminHtml = fs.readFileSync(path.join(root, 'pa-admin.html'), 'utf8');
assert.match(adminSource, /PRODUCTION_E2E_MARKER = "\[TEST\] 2026龍姫湖まつり 正式受注E2E"/u);
assert.match(adminSource, /isProductionE2eTest\(item\) \? PRODUCTION_E2E_MARKER/u);
assert.match(adminHtml, /pa-admin\.js\?v=pa-est-007r3/u);

Object.assign(process.env, {
  SUPABASE_URL: 'https://fixture.invalid',
  SUPABASE_SERVICE_ROLE_KEY: 'fixture-service-role-key',
  GMAIL_CLIENT_ID: 'fixture-client',
  GMAIL_CLIENT_SECRET: 'fixture-secret',
  GMAIL_REFRESH_TOKEN: 'fixture-refresh',
  GMAIL_SENDER_ADDRESS: 'aratechsound@gmail.com',
  GMAIL_REPLY_TO: 'aratechsound@gmail.com'
});

const inquiryId = '11111111-1111-4111-8111-111111111111';
const actorId = '123e4567-e89b-42d3-a456-426614174001';
const jobId = '71111111-1111-4111-8111-111111111111';
const subject = 'Re: 【ARA-TECH】正式受注確認';
const body = '竹林 智也 様\n\n正式受注確認です。';
const estimateAttachment = { filename: '見積書 2026.09.11 龍姫湖まつり（改訂）.pdf', mime_type: 'application/pdf', data: Buffer.from('fixture estimate pdf').toString('base64url') };
const rfcMessageId = `<pa-e2e-${jobId}@ara-tech.cc>`;
let sentCount = 0;
let listMode = 'one';
let lastSend;
const json = (value, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => value });
const fullMessage = {
  id: 'gmail_message_test_1', threadId: 'gmail_thread_test_1', internalDate: '1790000000000',
  payload: { headers: [
    { name: 'From', value: 'ARA-TECH <aratechsound@gmail.com>' },
    { name: 'To', value: 'tonokun@gmail.com' },
    { name: 'Subject', value: subject },
    { name: 'Message-ID', value: rfcMessageId }
  ], mimeType: 'text/plain', body: { data: Buffer.from(body).toString('base64url') } }
};

const fetchImpl = async (target, options = {}) => {
  const url = new URL(target);
  if (url.origin === 'https://fixture.invalid' && url.pathname === '/rest/v1/pa_inquiries') {
    return json([{ id: inquiryId, email: 'tonokun@gmail.com', internal_memo: '[TEST] 2026龍姫湖まつり 正式受注E2E' }]);
  }
  if (url.origin === 'https://oauth2.googleapis.com') return json({ access_token: 'fixture-access' });
  if (url.origin !== 'https://gmail.googleapis.com') throw new Error(`LIVE_NETWORK_FORBIDDEN ${url.origin}`);
  if (url.pathname.endsWith('/messages/send')) {
    sentCount += 1;
    lastSend = JSON.parse(options.body);
    return json({ id: fullMessage.id, threadId: fullMessage.threadId });
  }
  if (url.pathname.endsWith('/messages')) {
    assert.equal(url.searchParams.get('q'), `in:sent to:tonokun@gmail.com rfc822msgid:${rfcMessageId.slice(1, -1)}`);
    if (listMode === 'none') return json({ messages: [] });
    if (listMode === 'duplicate') return json({ messages: [{ id: fullMessage.id }, { id: 'gmail_message_test_2' }] });
    return json({ messages: [{ id: fullMessage.id, threadId: fullMessage.threadId }] });
  }
  if (url.pathname.endsWith(`/messages/${fullMessage.id}`)) return json(fullMessage);
  throw new Error(`UNEXPECTED_GMAIL_PATH ${url.pathname}`);
};

(async () => {
  assert.equal(gmail.productionE2eMessageId(jobId), rfcMessageId);
  const content = await gmail.standaloneContentPreview({ inquiryId, actorId, body, mode: 'confirmation', subjectOverride: subject }, fetchImpl);
  assert.equal(content.recipient, 'tonokun@gmail.com');
  assert.equal(content.gmail_thread_id, null);
  assert.equal(content.delivery_mode, 'standalone_production_e2e');
  assert.equal(Object.hasOwn(content, 'confirmation_token'), false);

  const legacyPreview = await gmail.standalonePreview({ inquiryId, actorId, body, mode: 'confirmation', subjectOverride: subject }, fetchImpl);
  const rejectedTrace = {};
  await assert.rejects(gmail.sendStandalone({
    inquiryId, actorId, body, attachments: [estimateAttachment], confirmationToken: legacyPreview.confirmation_token,
    subjectOverride: subject, jobId, deliveryTrace: rejectedTrace
  }, fetchImpl), /invalid_confirmation/);
  assert.equal(sentCount, 0, 'attachment hash mismatch fails before Gmail API');
  assert.equal(rejectedTrace.phase, 'preview_validation');
  assert.equal(Boolean(rejectedTrace.provider_request_started), false);

  const preview = await gmail.standalonePreview({ inquiryId, actorId, body, attachments: [estimateAttachment], mode: 'confirmation', subjectOverride: subject }, fetchImpl);
  const deliveryTrace = {};
  const sent = await gmail.sendStandalone({
    inquiryId, actorId, body, attachments: [estimateAttachment], confirmationToken: preview.confirmation_token,
    subjectOverride: subject, jobId, deliveryTrace
  }, fetchImpl);
  assert.equal(sentCount, 1);
  assert.equal(sent.gmail_message_id, fullMessage.id);
  assert.equal(sent.gmail_thread_id, fullMessage.threadId);
  assert.equal(deliveryTrace.provider_request_started, true);
  assert.equal(deliveryTrace.provider_response_received, true);
  assert.equal(deliveryTrace.provider_http_status, 200);
  assert.equal(Object.hasOwn(lastSend, 'threadId'), false, 'the first message creates a new Gmail thread');
  const raw = Buffer.from(lastSend.raw, 'base64url').toString('utf8');
  assert.match(raw, /^To: tonokun@gmail\.com$/mu);
  assert.match(raw, new RegExp(`^Message-ID: ${rfcMessageId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'mu'));
  assert.doesNotMatch(raw, /t\.takebayashi515@akiota\.jp/u);

  const evidence = await gmail.findStandaloneDelivery({ jobId, recipient: 'tonokun@gmail.com', subject }, fetchImpl);
  assert.equal(evidence.match_count, 1);
  assert.equal(evidence.gmail_message_id, fullMessage.id);
  listMode = 'none';
  const absent = await gmail.probeStandaloneDelivery({ jobId, recipient: 'tonokun@gmail.com', subject }, fetchImpl);
  assert.equal(absent.match_count, 0);
  await assert.rejects(gmail.findStandaloneDelivery({ jobId, recipient: 'tonokun@gmail.com', subject }, fetchImpl), /production_e2e_delivery_not_found/);
  listMode = 'duplicate';
  await assert.rejects(gmail.findStandaloneDelivery({ jobId, recipient: 'tonokun@gmail.com', subject }, fetchImpl), /production_e2e_duplicate_delivery/);
  await assert.rejects(gmail.standalonePreview({ inquiryId, actorId, body, mode: 'normal', subjectOverride: subject }, fetchImpl), /invalid_production_e2e_test/);
  console.log('PASS PA-EST-007R1 standalone Gmail: exact recipient, new thread, deterministic identity, fail-closed reconciliation');
})().catch((error) => { console.error(error); process.exitCode = 1; });
