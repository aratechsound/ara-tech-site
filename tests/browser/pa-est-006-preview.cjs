const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('C:/Users/user/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.js');
const { createFixture } = require('../helpers/pa-contract-fixture.cjs');
const { read } = require('../helpers/pa-estimate-fixture.cjs');
const { createService } = require('../../api/_pa-commercial.cjs');
const { createHandler } = require('../../api/_pa-commercial-handler.cjs');
const { sha } = require('../../api/_pa-contract-pdf.cjs');

const root = path.resolve(__dirname, '../..');
const out = process.env.PA_EST_006_OUTPUT_DIR || path.join(root, 'tmp', 'pa-est-006-preview');
fs.mkdirSync(out, { recursive: true });
const readBody = (request) => new Promise((resolve, reject) => { const parts = []; request.on('data', (part) => parts.push(part)); request.on('end', () => { try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8'))); } catch (error) { reject(error); } }); request.on('error', reject); });
const adapt = (response) => { response.status = (code) => { response.statusCode = code; return response; }; response.json = (value) => { response.setHeader('Content-Type', 'application/json; charset=utf-8'); response.end(JSON.stringify(value)); return response; }; return response; };
const harness = (caseId) => `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/pa-admin.css"><link rel="stylesheet" href="/pa-commercial.css"><link rel="stylesheet" href="/pa-confirmation-preview.css"><style>body{padding:12px}.hidden{display:none!important}.button{border:1px solid #0877ea;border-radius:8px;background:#0877ea;color:white;padding:8px 12px}.button--secondary{background:white;color:#0877ea}</style></head><body><section id="pa-commercial-workspace" class="pa-commercial hidden"><button id="pa-commercial-refresh"></button><button id="pa-v5-reply"></button><button id="pa-v5-estimate"></button><button id="pa-v5-add-file"></button><button id="pa-v5-note"></button><div class="pa-commercial__cards"><section class="pa-commercial-card"><button id="pa-estimate-tab"></button><button id="pa-billing-tab"></button><div id="pa-estimate-summary"></div><div id="pa-billing-summary"></div></section><section class="pa-commercial-card"><div id="pa-contract-v5-summary"></div></section><section class="pa-commercial-card"><span id="pa-data-freshness"></span><div id="pa-next-action-summary"></div></section></div><button id="pa-related-left"></button><button id="pa-related-right"></button><button id="pa-related-all"></button><span id="pa-related-files-count"></span><div id="pa-related-files"></div></section><script type="module">import{renderCommercialWorkspace}from'/js/pa-commercial-admin.js';const current={id:'${caseId}',event_name:'龍姫湖まつり2026（検証用）'};renderCommercialWorkspace({case:current,getCurrentCase:()=>current,getAccessToken:async()=> 'fixture-admin',openComposer:()=>{},focusBilling:()=>{},focusNote:()=>{},openFileSearch:()=>{}});</script></body></html>`;
async function counts(db, caseId) { const result = {}; for (const [key, sql] of Object.entries({ offers: 'select count(*) n from pa_contract_offers where inquiry_id=$1', tokens: 'select count(*) n from pa_contract_tokens t join pa_contract_offers o on o.id=t.offer_id where o.inquiry_id=$1', contracts: 'select count(*) n from pa_contracts where inquiry_id=$1', outbox: 'select count(*) n from pa_commercial_outbox where inquiry_id=$1', audit: "select count(*) n from pa_inquiry_audit where inquiry_id=$1 and action='formal_contract_issued'" })) result[key] = Number((await db.query(sql, [caseId])).rows[0].n); result.revision = Number((await db.query('select revision from pa_case_commercial_state where inquiry_id=$1', [caseId])).rows[0].revision); return result; }

async function main() {
    let fixture, server, browser;
    const pageErrors = [];
    try {
        fixture = await createFixture();
        await fixture.db.exec(read('20260913110000_pa_case_management_v5.sql') + '\n' + read('20260913130000_pa_case_management_v5_r1.sql') + '\n' + read('20260913190000_pa_estimate_recovery_ux.sql') + '\n' + read('20260914100000_pa_est_005a_confirmation_snapshot_compat.sql'));
        const service = createService({ fetchImpl: fixture.fetchImpl, sendTransport: async (job) => ({ gmail_message_id: `fake-${job.id}`, gmail_thread_id: 'thread_123' }) });
        const estimate = await service.issueEstimate({ case_id: fixture.inquiryId, expected_revision: 0, expected_current: null, operation_id: crypto.randomUUID(), document_id: crypto.randomUUID(), filename: '見積書 2026.09.11 龍姫湖まつり（改訂）.pdf', content_base64: fixture.quote.toString('base64'), sha256: sha(fixture.quote), amount_minor: 198550, currency: 'JPY', tax_basis: 'tax_included', conditions: { source: 'pa-est-006-browser' }, source_kind: 'managed_send', source_sent_at: '2026-09-11T12:00:00Z', body: '見積書を送付します。', cc_addresses: [] }, { id: fixture.actorId });
        await service.dispatch({ job_id: estimate.outbox_id }, { id: fixture.actorId });
        const safeService = new Proxy(service, { get: (target, property) => property === 'snapshot' ? async (...args) => ({ ...(await target.snapshot(...args)), related_materials: [] }) : target[property] });
        const handler = createHandler({ service: safeService, admin: async () => ({ id: fixture.actorId }), rate: async () => ({ allowed: true }) });
        server = http.createServer(async (request, response) => {
            try {
                const url = new URL(request.url, `http://${request.headers.host}`);
                if (url.pathname === '/harness.html') { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return response.end(harness(fixture.inquiryId)); }
                if (url.pathname === '/api/pa-mail') { const body = await readBody(request); return handler({ ...request, body, query: { surface: 'commercial' } }, adapt(response)); }
                const target = path.resolve(root, decodeURIComponent(url.pathname.slice(1)));
                assert(target.startsWith(root + path.sep) && fs.statSync(target).isFile());
                const type = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png' }[path.extname(target)] || 'application/octet-stream';
                response.writeHead(200, { 'Content-Type': type }); fs.createReadStream(target).pipe(response);
            } catch (error) { response.writeHead(500); response.end(String(error.message)); }
        });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const base = `http://127.0.0.1:${server.address().port}`;
        process.env.ALLOWED_ORIGINS = base; process.env.PA_PUBLIC_ORIGIN = base; process.env.PA_COMMERCIAL_OUTBOX_KEY = '77'.repeat(32);
        browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
        const context = await browser.newContext();
        await context.route('**/*', (route) => { const url = new URL(route.request().url()); return url.origin === base || url.protocol === 'blob:' ? route.continue() : route.abort(); });
        const page = await context.newPage(); page.on('pageerror', (error) => { pageErrors.push(error.message); console.error('PAGEERROR', error.message); }); page.on('console', (message) => { if (message.type() === 'error') console.error('CONSOLE', message.text()); }); page.on('response', (response) => { if (response.status() >= 400) console.error('HTTP', response.status(), response.url()); });
        const before = await counts(fixture.db, fixture.inquiryId);
        for (const width of [1366, 940, 390]) {
            await page.setViewportSize({ width, height: 1000 }); await page.goto(`${base}/harness.html`);
            await page.getByRole('button', { name: '正式受注確認を送る' }).click(); await page.locator('.pa-confirmation-preview-dialog').waitFor({ state: 'visible' });
            await page.waitForFunction(() => document.querySelector('.pa-confirmation-preview__fingerprint'));
            const previewText = await page.locator('.pa-confirmation-preview-dialog').innerText();
            assert.match(previewText, /送信前の最終確認/); assert.match(previewText, /198,550/); assert.match(previewText, /発行時に正式URLが入ります/); assert.match(previewText, /2026年10月18日（日） 10:00〜15:00/); assert.match(previewText, /2026年11月2日（月）/);
            const customerFrame = page.frameLocator('iframe[title="顧客向け正式受注確認ページの送信前プレビュー"]'); await customerFrame.locator('#page').waitFor({ state: 'visible' }); assert.equal(await customerFrame.locator('h1').innerText(), '正式受注確認');
            assert((await page.evaluate(() => document.documentElement.scrollWidth)) <= width); await page.screenshot({ path: path.join(out, `pre-issue-${width}.png`), fullPage: false });
            await page.getByLabel('上記の内容を確認しました。').check(); const finalButton = page.getByRole('button', { name: /この内容で発行して.*へ案内する/ }); assert.equal(await finalButton.isDisabled(), false); await finalButton.click(); await page.locator('.pa-confirmation-final-dialog').waitFor({ state: 'visible' }); await page.getByRole('button', { name: '戻って確認する' }).click();
            await page.getByRole('button', { name: '閉じる' }).click(); await page.locator('.pa-confirmation-preview-dialog').waitFor({ state: 'detached' });
        }
        await page.setViewportSize({ width: 1366, height: 1000 }); await page.goto(`${base}/harness.html`); await page.getByRole('button', { name: '正式受注確認を送る' }).click(); await page.waitForFunction(() => document.querySelector('.pa-confirmation-preview__fingerprint')); await page.evaluate(() => { document.documentElement.style.zoom = '200%'; }); assert((await page.evaluate(() => document.documentElement.scrollWidth)) <= 1366); await page.screenshot({ path: path.join(out, 'pre-issue-200-percent.png') });
        await page.getByRole('button', { name: '内容を再取得' }).evaluate((node) => node.click()); await page.waitForFunction(() => document.querySelector('.pa-confirmation-preview__fingerprint')); await page.getByRole('button', { name: '閉じる' }).evaluate((node) => node.click());
        assert.deepEqual(await counts(fixture.db, fixture.inquiryId), before); assert.equal(pageErrors.length, 0, pageErrors.join('\n'));
        const result = { pass: true, widths: [1366, 940, 390], zoom: '200%', preview_open_mutation: 0, preview_refresh_mutation: 0, final_dialog_back_only: true, real_issue: 0, real_email: 0 };
        fs.writeFileSync(path.join(out, 'pa-est-006-browser-results.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
    } finally { if (browser) await browser.close(); if (server) await new Promise((resolve) => server.close(resolve)); if (fixture) await fixture.db.close(); }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
