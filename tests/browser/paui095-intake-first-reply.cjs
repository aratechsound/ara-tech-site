const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const { createFixture } = require('../helpers/ara-case-fixture.cjs');
const { caseTransport } = require('../validate-ara-paui095-intake-commercial.cjs');
const publicIntake = require('../../api/pa-inquiry.js');
const paMail = require('../../api/pa-mail.js');
const paGmail = require('../../api/pa-gmail.js');
const { normalizeMessage } = require('../../api/_pa-gmail.cjs');

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

async function main() {
  const fixture = await createFixture();
  const { db, actor, state } = fixture;
  const transport = caseTransport(fixture);
  const oldFetch = global.fetch;
  global.fetch = transport.fetchImpl;
  const syncCalls = [];
  const serverErrors = [];
  const rows = async (statement, args) => (await db.query(statement, args)).rows;
  const handlers = new Map([
    ['/api/pa-inquiry', publicIntake], ['/api/pa-mail', paMail], ['/api/pa-gmail', paGmail]
  ]);
  // Model the Desk's GET projections from the same isolated database.
  // Public registration, preview, dispatch and linked sync use the actual HTTP handlers.
  async function readProjection(route) {
    const [, , surface, id, detail] = route.split('/');
    if (surface === 'cases') return { cases: await rows('select * from pa_inquiries'), progress: [] };
    if (surface === 'attention') return rows('select * from pa_case_mail_attention');
    if (surface === 'commercial') return { estimates: [], offers: [], billings: [] };
    if (surface === 'materials') return { cards: [], photos: [] };
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
    if (surface === 'mail-candidates') return { candidates: [], matching_case_count: 1 };
    return [];
  }
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    try {
      const handler = handlers.get(url.pathname);
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
    await db.exec("create function auth.role() returns text language sql stable as $$ select 'service_role'::text $$");
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    Object.assign(process.env, {
      ALLOWED_ORIGINS: origin, PA_PUBLIC_ORIGIN: 'https://example.invalid', PA_MAIL_ADAPTER: 'gmail'
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
    assert.equal(transport.sent.length, 3);
    assert.deepEqual(serverErrors, []);
    assert.deepEqual(pageErrors, []);
    console.log(JSON.stringify({
      publicForm: true, brandedPreview: true, firstReply: true,
      firstReplyLinkRequiresOwnerAction: true, exactDeliveryLinkedInDesk: true, mismatchAndBadAuthRejected: true,
      idempotent: true, readOnlyNoLink: true,
      singleSentCard: true, reload: true, simulatedSends: 3, realSends: 0, productionWrites: 0
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
