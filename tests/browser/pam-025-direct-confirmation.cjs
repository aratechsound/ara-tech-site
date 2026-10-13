const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'C:/Users/user/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.js');
const { setup, MODE } = require('../validate-pam-025-direct-confirmation.cjs');
const { createHandler } = require('../../api/_pa-commercial-handler.cjs');
const root = path.resolve(__dirname, '../..');
const out = process.argv[2] || path.join(root, 'tmp/pam-025');
// Reuse the established PA-EST-006 DOM harness, not a parallel product renderer.
const existing = fs.readFileSync(path.join(__dirname, 'pa-est-006-preview.cjs'), 'utf8');
const harnessSource = existing.match(/const harness = ([\s\S]*?);\r?\nasync function counts/u)?.[1];
assert(harnessSource);
const harness = Function('return (' + harnessSource + ')')();
const readBody = req => new Promise((resolve, reject) => { const chunks = []; req.on('data', b => chunks.push(b)); req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks))); } catch (error) { reject(error); } }); });
const adapt = res => { res.status = n => { res.statusCode = n; return res; }; res.json = data => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data)); return res; }; return res; };
async function main() {
  fs.mkdirSync(out, { recursive: true });
  let calls = 0, f, server, browser;
  const actions = [], errors = [];
  try {
    f = await setup({ transport: async (_job, documents) => { calls++; assert.equal(documents.length, 1); assert.deepEqual(Buffer.from(documents[0].data, 'base64url'), f.quote); return { gmail_message_id: 'fake-browser-1', gmail_thread_id: 'thread_123' }; } });
    const estimate = await f.createEstimate();
    assert.equal(estimate.outbox_id, null);
    const safeService = new Proxy(f.service, { get: (target, property) => property === 'snapshot' ? async (...args) => ({ ...(await target.snapshot(...args)), related_materials: [] }) : target[property] });
    const handler = createHandler({ service: safeService, admin: async () => f.actor, rate: async () => ({ allowed: true }) });
    server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        if (url.pathname === '/harness.html') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(harness(f.inquiryId)); }
        if (url.pathname === '/api/pa-mail') { const body = await readBody(req); actions.push(body); return handler({ ...req, body }, adapt(res)); }
        const file = path.resolve(root, decodeURIComponent(url.pathname.slice(1)));
        assert(file.startsWith(root + path.sep));
        if (!fs.existsSync(file)) { res.writeHead(404); return res.end(); }
        const type = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png' }[path.extname(file)] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': type + '; charset=utf-8' }); fs.createReadStream(file).pipe(res);
      } catch (error) { res.writeHead(500); res.end(error.message); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    process.env.ALLOWED_ORIGINS = base; process.env.PA_PUBLIC_ORIGIN = base;
    browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
    const context = await browser.newContext();
    await context.route('**/*', route => { const url = new URL(route.request().url()); return url.origin === base || url.protocol === 'blob:' ? route.continue() : route.abort(); });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    const count = async () => (await f.db.query("select (select count(*) from pa_contract_offers) offers,(select count(*) from pa_contract_tokens) tokens,(select count(*) from pa_commercial_outbox) outbox")).rows[0];
    const before = await count();
    const open = async () => {
      await page.getByRole('button', { name: '正式受注確認として送信', exact: true }).click();
      await page.locator('.pa-confirmation-preview__fingerprint').waitFor();
    };
    for (const width of [1366, 390]) {
      await page.setViewportSize({ width, height: 1000 }); await page.goto(base + '/harness.html'); await open();
      const preview = page.locator('.pa-confirmation-preview-dialog');
      assert.match(await preview.innerText(), /110,000/);
      assert.match(await preview.innerText(), /御見積書を添付しております/);
      const customer = page.frameLocator('iframe[title="顧客向け正式受注確認ページの送信前プレビュー"]');
      await customer.locator('#page').waitFor({ state: 'visible' });
      assert.match(await customer.locator('#agree').locator('..').innerText(), /同意したうえで正式に依頼/);
      assert.equal(await customer.locator('#submit').isDisabled(), true);
      const final = preview.getByRole('button', { name: '正式受注確認として送信', exact: true });
      assert.equal(await final.isDisabled(), true);
      await page.screenshot({ path: path.join(out, `direct-preview-${width}.png`) });
      assert((await page.evaluate(() => document.documentElement.scrollWidth)) <= width);
      await preview.getByLabel('上記の内容を確認しました。').check();
      await final.click(); await page.locator('.pa-confirmation-final-dialog').waitFor({ state: 'visible' });
      assert.deepEqual(await count(), before); assert.equal(calls, 0);
      assert.equal(actions.filter(a => a.action === 'issue_direct_confirmation_and_send').length, 0);
      await page.screenshot({ path: path.join(out, `direct-final-${width}.png`) });
      await page.getByRole('button', { name: '戻って確認する' }).click();
      await page.getByRole('button', { name: '内容を再取得' }).click(); await page.locator('.pa-confirmation-preview__fingerprint').waitFor();
      assert.deepEqual(await count(), before);
      await page.getByRole('button', { name: '閉じる', exact: true }).click();
    }
    await page.setViewportSize({ width: 1366, height: 1000 }); await page.goto(base + '/harness.html'); await open();
    await page.getByLabel('上記の内容を確認しました。').check();
    await page.locator('.pa-confirmation-preview-dialog').getByRole('button', { name: '正式受注確認として送信', exact: true }).evaluate(node => { node.click(); node.click(); });
    await page.locator('.pa-confirmation-final-dialog').waitFor({ state: 'visible' });
    assert.equal(await page.locator('.pa-confirmation-final-dialog').count(), 1); assert.equal(calls, 0);
    await page.getByRole('button', { name: '正式受注確認を送信する', exact: true }).click();
    await page.locator('.pa-confirmation-preview-dialog').waitFor({ state: 'detached' });
    assert.equal(calls, 1);
    assert.equal(actions.filter(a => a.action === 'issue_direct_confirmation_and_send').length, 1);
    assert.match(await page.locator('#pa-estimate-summary').innerText(), /送信済み/);
    assert.match(await page.locator('#pa-contract-v5-summary').innerText(), /回答待ち/);
    await page.screenshot({ path: path.join(out, 'direct-sent-1366.png') });
    // F2: a sent direct estimate keeps its presentation date after revision.
    const sentState = await f.service.snapshot(f.inquiryId);
    const revision = await f.service.beginRevision({ case_id: f.inquiryId, expected_revision: sentState.state.revision,
      operation_id: crypto.randomUUID(), reason: 'Controlled historical-display regression' }, f.actor);
    await f.service.issueEstimate({ case_id: f.inquiryId, expected_revision: revision.revision, expected_current: estimate.id,
      operation_id: crypto.randomUUID(), document_id: crypto.randomUUID(), filename: '改訂見積原本.pdf',
      content_base64: f.quote.toString('base64'), sha256: require('../../api/_pa-contract-pdf.cjs').sha(f.quote),
      amount_minor: 110000, currency: 'JPY', tax_basis: 'tax_included', conditions: { source: 'browser history fixture' },
      source_kind: 'managed_send', source_sent_at: null, body: 'Controlled revised original', confirmation_mode: MODE, cc_addresses: [] }, f.actor);
    await page.reload();
    await page.locator('.pa-estimate-history > summary').click();
    const historical = page.locator('.pa-estimate-history__item');
    await historical.waitFor();
    assert.match(await historical.innerText(), /送信/);
    assert.doesNotMatch(await historical.innerText(), /V5発行/);
    assert.equal(calls, 1);
    await page.screenshot({ path: path.join(out, 'direct-history-1366.png') });
    assert.deepEqual(errors, []);
    const result = { result: 'PASS', widths: [1366, 390], preview_mutation: 0, refresh_mutation: 0, final_dialog_mutation: 0,
      owner_checkbox: 'PASS', owner_final_dialog: 'PASS', double_click_dialog_count: 1, fake_send_count: calls,
      customer_consent_preview: 'PASS', single_provider_delivery_projection: 'PASS', historical_direct_delivery_date: 'PASS', real_gmail_send: 0, production_mutation: 0, page_errors: errors };
    fs.writeFileSync(path.join(out, 'pam-025-browser.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
  } finally { if (browser) await browser.close(); if (server) await new Promise(resolve => server.close(resolve)); if (f) await f.db.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
