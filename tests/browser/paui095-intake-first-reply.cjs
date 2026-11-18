const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const { PDFDocument } = require('pdf-lib');
const { createFixture } = require('../helpers/ara-case-fixture.cjs');
const { caseTransport, installCommercialMigrations } = require('../validate-ara-paui095-intake-commercial.cjs');
const publicIntake = require('../../api/pa-inquiry.js');
const paMail = require('../../api/pa-mail.js');
const paGmail = require('../../api/pa-gmail.js');
const { normalizeMessage } = require('../../api/_pa-gmail.cjs');
const { createHandler: createCommercialHandler } = require('../../api/_pa-commercial-handler.cjs');
const { createHandler: createContractHandler } = require('../../api/pa-contract.js');
const { createService: createCommercialService, decryptSecret } = require('../../api/_pa-commercial.cjs');
const { createService: createContractService } = require('../../api/_pa-contract.cjs');
const { sha } = require('../../api/_pa-contract-pdf.cjs');

const root = path.resolve(__dirname, '../..');
const email = 'public-customer@example.invalid';
const eventName = 'ブラウザ総合検証の合成イベント';
const replyBody = 'お問い合わせありがとうございます。会場について確認します。';
const incomingBody = 'ご返信ありがとうございます。見積書をお願いします。';
const types = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json'
};

function jsonAdapter(response) {
  response.status = code => { response.statusCode = code; return response; };
  response.json = data => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    return response.end(JSON.stringify(data));
  };
  return response;
}

async function fillIntake(page) {
  for (const [id, value] of Object.entries({
    'event-name': eventName, 'event-date': '2026-11-01',
    'venue-name': '隔離検証会場', 'venue-address': '隔離検証住所',
    'event-overview': '公開フォームから登録する隔離試験です。',
    'organizer-name': '検証担当者', 'organizer-email': email, 'organizer-phone': '0000000000'
  })) await page.locator('#' + id).fill(value);
  await page.locator('#time-undecided').check();
  await page.locator('#attendance').selectOption('21〜50名');
  await page.locator('#requester-relation').selectOption('主催者本人');
  for (const [name, value] of Object.entries({
    venue_type: '屋内', event_status: '検討中', requested_services: 'PA・音響',
    organizer_type: '個人', requester_authority: 'ある', contact_source: 'organizer',
    preferred_contact_method: 'メール', payer_source: 'contact'
  })) await page.locator(`[name="${name}"][value="${value}"]`).check();
  await page.locator('#confirmation-consent').check();
  await page.getByRole('button', { name: '入力内容を確認する' }).click();
}

async function reviewPdf(page, name, bytes, filename) {
  await page.getByRole('button', { name: name + 'PDFを送る', exact: true }).click();
  const draft = page.getByRole('dialog', { name: name + 'の送付', exact: true });
  await draft.getByRole('button', { name: '金額を表示・入力' }).click();
  await draft.getByLabel('税込金額（円）').fill('110000');
  await draft.locator('input[type=file]').setInputFiles({ name: filename, mimeType: 'application/pdf', buffer: bytes });
  if (name === '請求書') await draft.getByLabel('合意した支払期限（未確定の場合は空欄）').fill('2026-11-30');
  await draft.getByRole('button', { name: '送信内容を確認' }).click();
  const review = page.getByRole('dialog', { name: name + 'の送付内容', exact: true });
  await review.getByText(filename).waitFor();
  const send = review.getByRole('button', { name: name + 'を送信する', exact: true });
  assert.equal(await send.isDisabled(), true);
  await review.getByRole('button', { name: '本文・金額を表示' }).click();
  assert.equal(await review.locator('iframe').getAttribute('sandbox'), '');
  assert.equal(await send.isEnabled(), true);
  await send.click();
}

function sentPdf(mime) {
  const section = mime.split(/Content-Type: application\/pdf/iu)[1];
  assert(section, 'simulated message has a PDF MIME part');
  const data = section.split(/\r?\n\r?\n/u)[1].split(/\r?\n--/u)[0];
  return Buffer.from(data.replace(/\s/gu, ''), 'base64');
}

async function runCommerce({ page, browser, origin, inquiry, rows, sent, separateInvoice }) {
  const caseId = inquiry.id;
  const pdf = await PDFDocument.create();
  pdf.addPage().drawText('Synthetic event JPY 110,000', { x: 45, y: 730 });
  const quote = Buffer.from(await pdf.save());
  const mainThread = sent.at(-1).threadId;
  const click = (name, scope = page) => scope.getByRole('button', { name, exact: true }).click();
  const tab = async (name, action) => { await click(name); await click(action); };
  await tab('見積・受注', '正式受注の操作');
  await reviewPdf(page, '見積書', quote, '隔離見積書 日本語.pdf');
  await page.getByText(/見積書送信済み/u).waitFor();
  assert.equal(sent.length, 4);
  assert.equal(sent.at(-1).threadId, mainThread);
  assert.deepEqual(sentPdf(sent.at(-1).mime), quote);

  await click('正式受注確認を発行準備');
  let review = page.locator('.pa-confirmation-preview-dialog');
  await review.locator('.pa-confirmation-preview__fingerprint').waitFor();
  await review.getByLabel('上記の内容を確認しました。').check();
  await click('この内容で正式受注確認を発行する（送信しない）', review);
  await click('正式受注確認を発行する（送信しない）', page.locator('.pa-confirmation-final-dialog'));
  await click('正式受注確認を送る');
  assert.equal(sent.length, 4);
  review = page.locator('.pa-confirmation-preview-dialog');
  await review.locator('.pa-confirmation-preview__fingerprint').waitFor();
  await review.getByLabel('上記の内容を確認しました。').check();
  await click('正式受注確認を送る', review);
  const final = page.locator('.pa-confirmation-final-dialog');
  const [sendOffer] = await Promise.all([
    page.waitForResponse(res => res.url().includes('surface=commercial') && res.request().postDataJSON()?.action === 'dispatch_outbox'),
    final.getByRole('button', { name: /送信する/u }).click()
  ]);
  assert.equal(sendOffer.status(), 200, await sendOffer.text());
  assert.equal(sent.length, 5);
  assert.equal(sent.at(-1).threadId, mainThread);

  const [outbox] = await rows("select secret_envelope from pa_commercial_outbox where inquiry_id=$1 and job_kind='confirmation'", [caseId]);
  const customerUrl = decryptSecret(outbox.secret_envelope);
  assert.equal(new URL(customerUrl).origin, origin);
  assert(sent.at(-1).mime.split(/\r?\n--/u).some(part =>
    /Content-Transfer-Encoding: base64/iu.test(part) &&
    Buffer.from(part.split(/\r?\n\r?\n/u).at(-1).replace(/\s/gu, ''), 'base64').toString('utf8').includes(customerUrl)));
  const customerContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    await customerContext.route('**/*', route =>
      new URL(route.request().url()).origin === origin || route.request().url().startsWith('blob:')
        ? route.continue() : route.abort());
    const customer = await customerContext.newPage();
    await customer.goto(customerUrl);
    await customer.locator('#page').waitFor();
    assert.equal(new URL(customer.url()).hash, '');
    assert.match(await customer.locator('#quote-filename').innerText(), /隔離見積書 日本語\.pdf/u);
    const cancellation = customer.locator('#cancel-bands:visible, #cancel-text:visible');
    assert.match(await cancellation.innerText(), /%|％/u);
    assert((await customer.locator('#due-date').innerText()).trim());
    const quoteFile = customer.waitForEvent('download');
    await customer.locator('#save-quote').click();
    const quoteDownload = await quoteFile;
    assert.equal(quoteDownload.suggestedFilename(), '隔離見積書 日本語.pdf');
    assert.deepEqual(fs.readFileSync(await quoteDownload.path()), quote);
    const submit = customer.locator('#submit');
    await customer.locator('#confirmer').fill('隔離試験の確認者');
    assert.equal(await submit.isDisabled(), true);
    await customer.locator('#agree').check();
    await submit.click();
    assert.equal(sent.length, 5);
    await customer.locator('#dialog-accept').click();
    await customer.locator('#accepted').waitFor();
    assert.equal(sent.length, 6);
    const receiptFile = customer.waitForEvent('download');
    await customer.locator('#save-receipt').click();
    const receiptDownload = await receiptFile;
    assert.match(receiptDownload.suggestedFilename(), /^正式受注確認書_.*\.pdf$/u);
    assert.equal(fs.readFileSync(await receiptDownload.path()).subarray(0, 5).toString('ascii'), '%PDF-');
  } finally {
    await customerContext.close();
  }
  const [contract] = await rows('select snapshot from pa_contracts where inquiry_id=$1', [caseId]);
  assert.equal(contract.snapshot.acceptance.agreed, true);
  assert.equal(contract.snapshot.estimate.sha256, sha(quote));

  await page.reload();
  await tab('請求・入金', '請求・入金の操作');
  await click('実施・精算を確認');
  const settlement = page.getByRole('dialog', { name: '実施・精算確認', exact: true });
  await click('金額を表示・入力', settlement);
  assert.equal(await settlement.getByLabel('最終精算額（円）').inputValue(), '110000');
  await settlement.getByLabel('確認根拠').fill('隔離ブラウザで実施を確認');
  await click('実施・精算を確定', settlement);
  if (separateInvoice) {
    await reviewPdf(page, '請求書', quote, '隔離請求書 日本語.pdf');
    await page.getByText('請求書PDF・送信済み').waitFor();
    assert.equal(sent.length, 7);
    assert.equal(sent.at(-1).threadId, mainThread);
    assert.deepEqual(sentPdf(sent.at(-1).mime), quote);
  } else {
    await click('既存書類で請求管理');
    const billing = page.getByRole('dialog', { name: '既存書類で請求管理', exact: true });
    await billing.getByLabel('合意した支払期限（未確定の場合は空欄）').fill('2026-11-30');
    await click('請求書を別途発行せずに登録', billing);
    assert.equal(sent.length, 6);
  }

  await click('案件完了を確認');
  const close = page.getByRole('dialog', { name: '入金確認と案件完了', exact: true });
  await click('金額を表示・入力', close);
  await close.getByLabel('追加入金確認日').fill('2026-11-12');
  await close.getByLabel('確認メモ').fill('隔離ブラウザで銀行振込を確認');
  await click('全条件を確認して完了', close);
  const closed = page.locator('#head-state').filter({ hasText: /^入金確認済みで完了$/u });
  await closed.waitFor();
  await page.reload();
  await closed.waitFor();
  const [billing] = await rows('select invoice_policy,state from pa_billings where inquiry_id=$1', [caseId]);
  assert.equal(billing.invoice_policy, separateInvoice ? 'separate_pdf' : 'no_separate_invoice');
  assert.equal(billing.state, 'paid');
  assert.equal((await rows('select status from pa_inquiries where id=$1', [caseId]))[0].status, 'closed');
  assert.equal((await rows('select count(*)::int as count from pa_payment_records where inquiry_id=$1', [caseId]))[0].count, 1);
  assert.equal(sent.length, separateInvoice ? 7 : 6);
  return {
    policy: billing.invoice_policy, customerConsent: true, quoteDownloadMatches: true,
    receiptPdfDownload: true, closedAfterReload: true, simulatedSends: sent.length
  };
}

async function main() {
  const fixture = await createFixture();
  const { db, actor, state } = fixture;
  const transport = caseTransport(fixture);
  const oldFetch = global.fetch;
  global.fetch = transport.fetchImpl;
  const syncCalls = [];
  const serverErrors = [];
  const rows = async (statement, args) => (await db.query(statement, args)).rows;
  const commercialService = createCommercialService({ fetchImpl: transport.fetchImpl });
  const commercial = createCommercialHandler({ service: commercialService });
  const contract = createContractHandler({ service: createContractService({ fetchImpl: transport.fetchImpl }) });
  const handlers = new Map([
    ['/api/pa-inquiry', publicIntake], ['/api/pa-mail', paMail],
    ['/api/pa-gmail', paGmail], ['/api/pa-contract', contract]
  ]);
  // Model the Desk's GET projections from the same isolated database.
  // Public registration, preview, dispatch and linked sync use the actual HTTP handlers.
  async function readProjection(route) {
    const [, , surface, id, detail] = route.split('/');
    if (surface === 'cases') {
      return { cases: await rows('select * from pa_inquiries'), progress: await rows('select * from pa_case_progress') };
    }
    if (surface === 'attention') return rows('select * from pa_case_mail_attention');
    if (surface === 'commercial') return commercialService.snapshot(id);
    if (surface === 'materials') return { cards: [], photos: [] };
    if (surface === 'sent-estimates') return { messages: [], unknown: [] };
    if (surface === 'mail') return rows('select * from pa_gmail_message_index where inquiry_id=$1', [id]);
    if (surface === 'mail-body') {
      const [message] = await rows(
        'select * from pa_gmail_message_index where inquiry_id=$1 and gmail_message_id=$2',
        [id, detail]
      );
      assert(message);
      const raw = state.messages.get(detail);
      const providerMessage = raw ? normalizeMessage(raw) : {};
      return {
        gmail_message_id: detail, inquiry_id: id,
        body_text: message.body_text || providerMessage.body_text || '',
        body_html: message.body_html || providerMessage.body_html || ''
      };
    }
    if (surface === 'case' && detail === 'deliveries') {
      return rows("select * from pa_email_deliveries where inquiry_id=$1 order by requested_at desc", [id]);
    }
    if (surface === 'case' && detail === 'links') {
      return rows('select * from pa_gmail_thread_links where inquiry_id=$1', [id]);
    }
    if (surface === 'case' && detail === 'mail-sync') {
      const [saved] = await rows('select state from paui041_mail_sync_state where inquiry_id=$1', [id]);
      const sync = saved?.state?.linked_sync;
      return {
        inquiry_id: id, scope: 'existing_linked_threads', complete: sync?.complete === true,
        last_success_at: sync?.checked_at || null, thread_ids: sync?.thread_ids || [],
        message_count: sync?.message_count || 0
      };
    }
    if (surface === 'case' && detail === 'attention') {
      return rows('select * from pa_case_mail_attention where inquiry_id=$1', [id]);
    }
    if (surface === 'case' && detail === 'payments') {
      return rows('select * from pa_payment_records where inquiry_id=$1', [id]);
    }
    if (surface === 'mail-candidates') return { candidates: [], matching_case_count: 1 };
    return [];
  }
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    try {
      const handler = url.pathname === '/api/pa-mail' && url.searchParams.get('surface') === 'commercial'
        ? commercial : handlers.get(url.pathname);
      if (handler) {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        request.body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (handler === paGmail) syncCalls.push(request.body);
        return await handler(request, jsonAdapter(response));
      }
      if (url.pathname === '/api/pa-workspace-read') {
        assert.equal(request.method, 'GET');
        assert.equal(request.headers.authorization, 'Bearer fixture-admin');
        return jsonAdapter(response).json({ ok: true, result: await readProjection(url.searchParams.get('path')) });
      }
      const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
      if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        response.writeHead(404); return response.end();
      }
      response.writeHead(200, { 'Content-Type': (types[path.extname(file)] || 'application/octet-stream') + '; charset=utf-8' });
      fs.createReadStream(file).pipe(response);
    } catch (error) {
      serverErrors.push(error.message);
      response.writeHead(500); response.end(String(error.message));
    }
  });
  let browser;
  try {
    // The isolated REST adapter represents the server's service role.
    await installCommercialMigrations(db);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    Object.assign(process.env, {
      ALLOWED_ORIGINS: origin, PA_PUBLIC_ORIGIN: origin, PA_MAIL_ADAPTER: 'gmail', PA_COMMERCIAL_OUTBOX_KEY: '88'.repeat(32)
    });
    browser = await chromium.launch({
      headless: true, ...(process.env.PA_CHROME_EXECUTABLE ? { executablePath: process.env.PA_CHROME_EXECUTABLE } : {})
    });
    const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    await context.route('**/*', route =>
      new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await context.route(origin + '/pa-ui/js/integration.mjs', route => route.fulfill({
      contentType: 'text/javascript',
      body: `
        const session={user:{id:${JSON.stringify(actor)}},access_token:'fixture-admin',expires_at:9999999999};
        export const workspaceAuth={restore:async()=>session,current:async()=>session};
        export const readUrl=p=>'/api/pa-workspace-read?path='+encodeURIComponent(p);
        export const legacyUrl=id=>'/pa-admin-legacy.html?case='+encodeURIComponent(id);
      `
    }));
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('response', async response => {
      if (response.status() < 400 || !response.url().includes('surface=commercial')) return;
      const data = await response.json().catch(() => ({}));
      console.error('Commercial response', response.request().postDataJSON()?.action, response.status(), data.code || '');
    });
    page.setDefaultTimeout(10000);
    await page.goto(origin + '/pa-inquiry.html');
    await fillIntake(page);
    const submission = page.waitForResponse(response => response.url() === origin + '/api/pa-inquiry');
    await page.getByRole('button', { name: 'この内容で送信する' }).click();
    assert.equal((await submission).status(), 200);
    await page.locator('#receipt-number').waitFor();
    const receiptText = await page.locator('#receipt-number').innerText();
    const inquiryNumber = /PA-\d{8}-\d{5}/u.exec(receiptText)?.[0];
    assert(inquiryNumber, receiptText);
    assert.match(await page.locator('#pa-receipt-status').innerText(), /受付確認メールを送信しました/u);
    assert.equal(new URL(page.url()).search, '');
    assert.deepEqual(transport.sent.map(message => message.recipient).sort(), [state.mailbox, email].sort());
    const [inquiry] = await rows('select id, email, case_type from pa_inquiries where inquiry_number=$1', [inquiryNumber]);
    assert.equal(inquiry.email, email);
    assert.equal(inquiry.case_type, 'PA_EVENT');
    await page.goto(origin + '/pa-admin.html?case=' + inquiry.id + '&tab=conversation');
    const formCard = page.locator('[data-timeline-kind="form"]');
    await formCard.getByText(eventName, { exact: true }).waitFor();
    await formCard.getByRole('button', { name: 'お客様に返信' }).click();
    assert.equal(await formCard.locator('textarea[name=body]').inputValue(),'');
    const composer = page.locator('#intake-composer-host form');
    await composer.getByLabel('本文', { exact: true }).fill(replyBody);
    await composer.getByRole('button', { name: 'プレビュー' }).click();
    await composer.frameLocator('iframe').getByText(replyBody, { exact: true }).waitFor();
    assert.equal(await composer.locator('iframe').getAttribute('sandbox'), '');
    assert.equal(transport.sent.length, 2);
    await composer.getByRole('checkbox').check();
    const sendResponse = page.waitForResponse(response => response.url() === origin + '/api/pa-mail'
      && response.request().postDataJSON().action === 'send_content_hearing');
    await composer.getByRole('button', { name: '確認した内容で送信する' }).click();
    const sent = await sendResponse;
    assert.equal(sent.status(), 200, await sent.text());
    await composer.waitFor({ state: 'hidden' });
    await page.getByText('送信しました。', { exact: true }).waitFor();
    assert.equal(transport.sent.length, 3);
    const followUp = transport.sent.at(-1);
    const [delivery] = await rows(
      "select * from pa_email_deliveries where inquiry_id=$1 and message_type='content_hearing_follow_up'",
      [inquiry.id]
    );
    assert.equal(delivery.gmail_message_id, followUp.id);
    assert.equal(delivery.body.split('\n')[0], replyBody);
    assert.match(delivery.body, /ARA-TECH/u);
    assert.equal((await rows('select status from pa_inquiries where id=$1', [inquiry.id]))[0].status, 'waiting_customer_reply');
    await page.locator('[data-delivery-id="' + delivery.id + '"]').getByText(replyBody, { exact: false }).waitFor();

    const inbound = fixture.raw('fixture_browser_customer_reply', followUp.threadId, email, incomingBody);
    state.messages.set(inbound.id, inbound);
    state.threadMessages.get(followUp.threadId).push(inbound);
    assert.deepEqual(await rows('select gmail_thread_id from pa_gmail_thread_links where inquiry_id=$1', [inquiry.id]), []);
    await page.locator('[data-mail-sync-state="unlinked"]').waitFor({ timeout: 5000 });
    await page.getByRole('button', { name: 'この案件のメールを再取得' }).click();
    await page.locator('[data-mail-sync-state="unlinked"]').waitFor({ timeout: 5000 });
    assert.equal(syncCalls.length, 0, 'Desk stops before calling linked-only sync when the case has no approved thread');
    assert.equal(await page.locator('[data-message="' + inbound.id + '"]').count(), 0);

    const readOnly = await context.newPage();
    await readOnly.goto(page.url() + '&mail-view=readonly');
    await readOnly.locator('[data-mail-sync-state="readonly"]').waitFor();
    const linkLabel = '初回返信のスレッドを紐付けて同期';
    assert.equal(await readOnly.getByRole('button', { name: linkLabel }).count(), 0);
    await readOnly.close();
    const command = { action: 'link_intake_follow_up', inquiry_id: inquiry.id, delivery_id: delivery.id };
    const postLink = (payload, token = 'fixture-admin') => context.request.post(origin + '/api/pa-gmail', {
      data: payload, headers: { origin, authorization: 'Bearer ' + token }
    });
    assert.equal((await postLink(command, 'not-the-owner')).status(), 401);
    assert.equal((await postLink({ ...command, delivery_id: '11111111-1111-4111-8111-111111111111' })).status(), 409);
    const providerMessage = state.messages.get(followUp.id);
    const subject = providerMessage.payload.headers.find(header => header.name === 'Subject');
    const originalSubject = subject.value;
    const link = page.getByRole('button', { name: linkLabel });
    subject.value = '異なるメールの件名';
    await link.click();
    await page.getByText('初回返信の紐付けを確認できませんでした。', { exact: false }).waitFor();
    assert.deepEqual(await rows('select gmail_thread_id from pa_gmail_thread_links where inquiry_id=$1', [inquiry.id]), []);
    assert.equal(syncCalls.filter(call => call.action === 'sync').length, 0);

    subject.value = originalSubject;
    const linkRequestsBefore = syncCalls.filter(call => call.action === command.action).length;
    await link.evaluate(button => { button.click(); button.click(); });
    await page.locator('[data-mail-sync-state="success"]').waitFor({ timeout: 5000 });
    assert.equal(syncCalls.filter(call => call.action === command.action).length, linkRequestsBefore + 1);
    const persisted = await rows('select * from pa_gmail_thread_links where inquiry_id=$1', [inquiry.id]);
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].gmail_thread_id, followUp.threadId);
    assert.equal(persisted[0].conversation_role, 'primary_conversation');
    assert.equal(persisted[0].linked_by, actor);
    assert.equal((await postLink(command)).status(), 200);
    assert.deepEqual(await rows('select * from pa_gmail_thread_links where inquiry_id=$1', [inquiry.id]), persisted);
    const inboundCard = page.locator('[data-message="' + inbound.id + '"]');
    await inboundCard.waitFor({ timeout: 5000 });
    assert.match(await inboundCard.innerText(), /お客様からのメール/u);
    await inboundCard.getByRole('button', { name: '全文を表示' }).click({ timeout: 5000 });
    await inboundCard.getByText(incomingBody, { exact: true }).waitFor({ timeout: 5000 });
    assert.equal((await rows(
      'select count(*)::int as count from pa_gmail_message_index where inquiry_id=$1 and gmail_message_id=$2',
      [inquiry.id, inbound.id]
    ))[0].count, 1);
    assert.equal(await page.locator(`[data-message="${followUp.id}"],[data-delivery-id="${delivery.id}"]`).count(), 1);
    const actualSyncs = syncCalls.filter(call => call.action === 'sync');
    assert(actualSyncs.length > 0);
    assert(actualSyncs.every(call => call.linked_only && call.inquiry_id === inquiry.id));
    assert(state.network.every(call => call.host !== 'gmail.googleapis.com' || call.method === 'GET'));
    await page.reload();
    await page.locator('[data-message="' + inbound.id + '"]').waitFor();
    assert.equal(await page.locator('[data-intake-reply]').count(), 0);
    assert.equal(await page.getByRole('button', { name: linkLabel }).count(), 0);
    const callCount = transport.sent.length;
    await page.locator('[data-timeline-kind="form"] [data-form-reply]').click();
    const replyForm = page.locator('.reply-composer');
    await replyForm.waitFor();
    await page.waitForFunction(expected=>document.querySelector('[data-reply-to]')?.value===expected,email);
    assert.equal(await replyForm.locator('[data-reply-body]').inputValue(), '');
    assert.equal(await replyForm.locator('[data-reply-files]').count(), 1);
    assert(await replyForm.locator('[data-reply-subject]').inputValue());
    await replyForm.locator('[data-reply-body]').fill('新しい内容の履歴確認です。');
    await replyForm.locator('[data-reply-files]').setInputFiles({
      name:'fixture.txt',mimeType:'text/plain',buffer:Buffer.from('isolated attachment')
    });
    await replyForm.locator('[data-reply-files-list]').getByText('fixture.txt',{exact:false}).waitFor();
    await replyForm.locator('[data-reply-preview]').click();
    await replyForm.locator('[data-reply-preview-box]').waitFor();
    await replyForm.locator('[data-reply-preview-files]').getByText('fixture.txt',{exact:false}).waitFor();
    assert.equal(await replyForm.locator('[data-reply-send]').isEnabled(), false);
    assert.equal(transport.sent.length,callCount);
    await replyForm.locator('[data-reply-close]').click();
    assert.equal(transport.sent.length, 3);
    const flow = await runCommerce({
      page, browser, origin, inquiry, rows, sent: transport.sent,
      separateInvoice: !process.argv.includes('--no-separate-invoice')
    });
    assert.deepEqual(serverErrors, []);
    assert.deepEqual(pageErrors, []);
    console.log(JSON.stringify({
      publicForm: true, brandedPreview: true, firstReply: true,
      firstReplyLinkRequiresOwnerAction: true, exactDeliveryLinkedInDesk: true, mismatchAndBadAuthRejected: true,
      idempotent: true, readOnlyNoLink: true,
      singleSentCard: true, reload: true, commerce: flow, realSends: 0, productionWrites: 0
    }));
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
    global.fetch = oldFetch;
    await transport.drain();
    await db.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
