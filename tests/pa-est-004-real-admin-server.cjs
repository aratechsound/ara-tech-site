const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createFixture } = require('./helpers/pa-contract-fixture.cjs');
const { read } = require('./helpers/pa-estimate-fixture.cjs');
const { createService } = require('../api/_pa-commercial.cjs');
const { createHandler } = require('../api/_pa-commercial-handler.cjs');
const { sha } = require('../api/_pa-contract-pdf.cjs');

const root = path.resolve(__dirname, '..');
const port = Number(process.env.PA_EST_004_REAL_PORT || 8766);
const staticFiles = new Set([
  'admin-navigation.css', 'pa-admin.css', 'pa-commercial.css',
  'js/pa-est-004-real-admin-preview.js', 'js/pa-commercial-admin.js',
  'img/favicon.ico', 'img/ARA-TECH ロゴ横 白.png'
]);
process.env.PA_COMMERCIAL_OUTBOX_KEY = '44'.repeat(32);
process.env.PA_PUBLIC_ORIGIN = `http://127.0.0.1:${port}`;
let fixture;
let service;
let handler;
let scenario = 'pending';
let mailMode = 'success';

const rpc = async (db, name, args) => (await db.query(
  `select public.${name}(${Object.keys(args).map((key, index) => `${key} => $${index + 1}`).join(',')}) result`, Object.values(args)
)).rows[0].result;

async function initialize(nextScenario = 'pending') {
  if (fixture) await fixture.db.close();
  fixture = await createFixture();
  process.env.ALLOWED_ORIGINS = `http://127.0.0.1:${port}`;
  await fixture.db.exec(
    read('20260913110000_pa_case_management_v5.sql') + '\n'
    + read('20260913130000_pa_case_management_v5_r1.sql') + '\n'
    + read('20260913170000_pa_case_management_v5_payment_race.sql') + '\n'
    + read('20260913190000_pa_estimate_recovery_ux.sql')
  );
  service = createService({
    fetchImpl: fixture.fetchImpl,
    sendTransport: async (job) => {
      if (mailMode === 'failure') throw Error('gmail_send_fixture_failure');
      if (mailMode === 'unknown') throw Error('fixture_response_lost');
      return { gmail_message_id: `fake-${job.id}`, gmail_thread_id: 'thread_123' };
    }
  });
  handler = createHandler({ service, admin: async token => {
    if (token !== 'fixture-admin') throw Error('not_authorized');
    return { id: fixture.actorId };
  }, rate: async () => ({ allowed: true }) });
  const issued = await service.issueEstimate({
    case_id: fixture.inquiryId, expected_revision: 0, expected_current: null, operation_id: crypto.randomUUID(),
    document_id: crypto.randomUUID(), filename: '実管理画面-fixture-estimate.pdf', content_base64: fixture.quote.toString('base64'),
    sha256: sha(fixture.quote), amount_minor: 110000, currency: 'JPY', tax_basis: 'tax_included',
    conditions: { source: 'local_real_admin_fixture' }, source_kind: 'managed_send', source_sent_at: null,
    body: 'ローカル実管理画面fixtureの見積です。外部送信は行いません。', cc_addresses: ['venue@example.invalid']
  }, { id: fixture.actorId });
  await service.dispatch({ job_id: issued.outbox_id }, { id: fixture.actorId });
  const confirmation = await service.issueConfirmation({
    case_id: fixture.inquiryId, expected_revision: 1, estimate_revision_id: issued.id,
    offer_id: crypto.randomUUID(), operation_id: crypto.randomUUID(), event_name: '龍姫湖まつり2026（検証用）', event_date: '2026-10-18',
    customer_acknowledgement: { source: 'local_fixture', estimate_revision_id: issued.id },
    body_template: '正式受注確認の内容をご確認ください。\n\n{{CONFIRMATION_URL}}', cc_addresses: ['venue@example.invalid']
  }, { id: fixture.actorId });
  await service.dispatch({ job_id: confirmation.outbox_id }, { id: fixture.actorId });
  if (nextScenario === 'partial' || nextScenario === 'accepted') {
    const token = confirmation.secret_url_returned_once.split('#')[1];
    const row = (await fixture.db.query('select snapshot_sha256 from public.pa_contract_offers where id=$1', [confirmation.id])).rows[0];
    await rpc(fixture.db, 'pa_contract_accept', { p_token_hash: sha(token), p_offer_id: confirmation.id, p_snapshot_sha256: row.snapshot_sha256, p_name: '管理下テスト担当者', p_agree: true });
    if (nextScenario === 'partial') {
      await service.settle({ case_id: fixture.inquiryId, expected_revision: 1, operation_id: crypto.randomUUID(), amount_minor: 110000, unresolved_changes: false, evidence: { source: 'local_fixture' } }, { id: fixture.actorId });
    const billing = await service.createBilling({
      case_id: fixture.inquiryId, expected_revision: 2, operation_id: crypto.randomUUID(), contract_id: confirmation.id,
      estimate_revision_id: issued.id, amount_minor: 110000, invoice_policy: 'no_separate_invoice', due_date: '2026-10-31',
      due_basis: { status: 'agreed', source: 'local_fixture' }, customer_planned_payment_on: null,
      agreement_evidence: { source: 'local_fixture' }
    }, { id: fixture.actorId });
      await service.recordPayment({ case_id: fixture.inquiryId, billing_id: billing.id, operation_id: crypto.randomUUID(), payment_date: '2026-10-20', amount_minor: 50000, payment_method: 'bank_transfer', memo: 'local fixture partial' }, { id: fixture.actorId });
    }
  }
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR42mNkYPj/n4GBgYGJAQoAHgQCAQWZVJ8AAAAASUVORK5CYII=', 'base64');
  await fixture.db.query("insert into public.pa_commercial_documents(id,inquiry_id,document_kind,source_kind,original_filename,mime_type,content,sha256,metadata,created_by) values($1,$2,'supporting','private_upload','会場配置-fixture.png','image/png',$3,$4,$5,$6)", [crypto.randomUUID(), fixture.inquiryId, png, sha(png), { local_fixture: true }, fixture.actorId]);
  scenario = nextScenario;
}

const contentTypes = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.png': 'image/png', '.html': 'text/html; charset=utf-8' };
const readBody = request => new Promise((resolve, reject) => {
  const chunks = []; let size = 0;
  request.on('data', chunk => { size += chunk.length; if (size > 8_000_000) reject(Error('too_large')); else chunks.push(chunk); });
  request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  request.on('error', reject);
});
const adapt = response => {
  response.status = code => { response.statusCode = code; return response; };
  response.json = data => { response.setHeader('Content-Type', 'application/json; charset=utf-8'); response.end(JSON.stringify(data)); return response; };
  return response;
};

function previewHtml() {
  return fs.readFileSync(path.join(root, 'pa-admin.html'), 'utf8')
    .replace(/<link[^>]+fonts\.googleapis[^>]+>/gu, '')
    .replace('<section id="login-panel" class="card login-card">', '<section id="login-panel" class="card login-card hidden">')
    .replace('<section id="dashboard" class="hidden">', '<section id="dashboard">')
    .replace(/<section id="detail-card" class="card hidden"/u, '<section id="detail-card" class="card"')
    .replace(/<script type="module" src="js\/pa-admin\.js[^"]*"><\/script>/u, '<script type="module" src="js/pa-est-004-real-admin-preview.js"></script>')
    .replace('<main>', `<main><aside class="pa-commercial__notice" id="local-fixture-banner"><strong>LOCAL実管理画面／本番未接続</strong><span>PGlite実DB・実API handler・fake送信adapter。Production DB / Storage / Gmailへ接続しません。</span><label>シナリオ <select id="real-scenario"><option value="pending">正式受注確認待ち</option><option value="accepted">正式受注済み・変更前</option><option value="partial">一部入金</option></select></label></aside>`);
}

async function route(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (url.pathname === '/api/pa-mail' && url.searchParams.get('surface') === 'commercial') {
    let body = {};
    try { body = JSON.parse(await readBody(request)); } catch { body = {}; }
    if (body.action === 'recovery_candidates') await new Promise(resolve => setTimeout(resolve, 150));
    return handler({ method: request.method, headers: request.headers, body, query: { surface: 'commercial' }, socket: request.socket }, adapt(response));
  }
  if (url.pathname === '/__fixture/scenario' && request.method === 'POST') {
    const input = JSON.parse(await readBody(request));
    if (!['pending', 'accepted', 'partial'].includes(input.scenario)) { response.statusCode = 400; return response.end('invalid'); }
    await initialize(input.scenario); response.setHeader('Content-Type', 'application/json'); return response.end(JSON.stringify({ ok: true, scenario }));
  }
  if (url.pathname === '/__fixture/snapshot') {
    response.setHeader('Content-Type', 'application/json'); return response.end(JSON.stringify(await service.snapshot(fixture.inquiryId)));
  }
  if (url.pathname === '/pa-est-004-real-admin-preview.html') {
    response.setHeader('Content-Type', 'text/html; charset=utf-8'); return response.end(previewHtml());
  }
  const relative = decodeURIComponent(url.pathname.replace(/^\//u, ''));
  const target = path.resolve(root, relative);
  if (!staticFiles.has(relative) || !target.startsWith(root + path.sep) || !fs.existsSync(target) || !fs.statSync(target).isFile()) { response.statusCode = 404; return response.end('Not Found'); }
  response.setHeader('Content-Type', contentTypes[path.extname(target).toLowerCase()] || 'application/octet-stream');
  fs.createReadStream(target).pipe(response);
}

initialize().then(() => http.createServer((request, response) => route(request, response).catch(error => {
  console.error(error); if (!response.headersSent) response.statusCode = 500; response.end('Local fixture error');
})).listen(port, '127.0.0.1', () => console.log(`PA-EST-004R1 real admin preview: http://127.0.0.1:${port}/pa-est-004-real-admin-preview.html`)));
