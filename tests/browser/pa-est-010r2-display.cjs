const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('C:/Users/user/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.js');

const root = path.resolve(__dirname, '../..');
const outputDir = process.env.PA_EST_010R2_OUTPUT_DIR || path.join(root, 'tmp', 'pa-est-010r2-display');
fs.mkdirSync(outputDir, { recursive: true });

const oldOffer = { id: 'offer-6', version: 6, state: 'revoked', estimate_revision_id: 'estimate-2', snapshot: { estimate_revision_number: 2 } };
const activeOffer = { id: 'offer-7', version: 7, state: 'active', estimate_revision_id: 'estimate-2', expires_at: '2026-09-22T01:56:42Z', snapshot: { estimate_revision_number: 2 } };
const oldUnknown = { id: 'job-6', aggregate_id: oldOffer.id, job_kind: 'confirmation', state: 'unknown', delivery_state: 'unknown_after_provider_start', created_at: '2026-09-14T01:00:00Z' };
const currentDelivery = (state, deliveryState = state) => ({ id: 'job-7', aggregate_id: activeOffer.id, job_kind: 'confirmation', state, delivery_state: deliveryState, created_at: '2026-09-15T02:00:00Z' });

const snapshot = (scenario) => {
    const accepted = scenario === 'accepted';
    const deliveryState = scenario === 'sent' ? ['sent', 'sent'] : scenario === 'queued' ? ['queued', 'queued'] : scenario === 'unknown' ? ['unknown', 'unknown_after_provider_start'] : ['failed', 'failed_before_provider'];
    const offer = accepted ? { ...activeOffer, state: 'accepted', confirmed_at: '2026-09-15T03:00:00Z' } : activeOffer;
    const outbox = [oldUnknown, currentDelivery(...deliveryState)];
    const billings = accepted ? [{ id: 'billing-1', billing_number: 1, state: 'open', amount_minor: 198550, currency: 'JPY', invoice_policy: 'separate_pdf', invoice_delivery_state: 'unknown' }] : [];
    if (accepted) outbox.push(
        { id: 'receipt-7', aggregate_id: offer.id, job_kind: 'accept_receipt', state: 'unknown', created_at: '2026-09-15T03:00:01Z' },
        { id: 'invoice-1', aggregate_id: 'billing-1', job_kind: 'invoice', state: 'unknown', created_at: '2026-09-15T03:00:02Z' }
    );
    return {
        state: { current_estimate_revision_id: 'estimate-2', estimate_change_state: 'ready', fulfillment_state: 'not_confirmed', settlement_state: 'unsettled', settlement_currency: 'JPY', revision: 2, updated_at: '2026-09-15T02:37:34Z' },
        estimates: [{ id: 'estimate-2', revision_number: 2, amount_minor: 198550, currency: 'JPY', source_kind: 'sent_recovery', source_sent_at: '2026-09-11T03:54:00Z', issued_at: '2026-09-11T03:54:00Z' }],
        offers: [offer, oldOffer], outbox, billings, payments: [], adjustments: [], change_orders: [], documents: [], related_materials: [], case_status: 'active', production_e2e_test: false
    };
};

const harness = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><link rel="stylesheet" href="/pa-commercial.css"></head><body>
<section id="pa-commercial-workspace" class="pa-commercial hidden"><button id="pa-commercial-refresh"></button><button id="pa-v5-reply"></button><button id="pa-v5-estimate"></button><button id="pa-v5-add-file"></button><button id="pa-v5-note"></button><div class="pa-commercial__cards"><section class="pa-commercial-card"><button id="pa-estimate-tab"></button><button id="pa-billing-tab"></button><div id="pa-estimate-summary"></div><div id="pa-billing-summary"></div></section><section class="pa-commercial-card"><div id="pa-contract-v5-summary"></div></section><section class="pa-commercial-card"><span id="pa-data-freshness"></span><div id="pa-next-action-summary"></div></section></div><button id="pa-related-left"></button><button id="pa-related-right"></button><button id="pa-related-all"></button><span id="pa-related-files-count"></span><div id="pa-related-files"></div></section>
<script type="module">import{renderCommercialWorkspace}from'/js/pa-commercial-admin.js';const current={id:'case-real',event_name:'2026龍姫湖まつり'};renderCommercialWorkspace({case:current,getCurrentCase:()=>current,getAccessToken:async()=> 'fixture-admin',openComposer:()=>{},focusBilling:()=>{},focusNote:()=>{},openFileSearch:()=>{}});</script></body></html>`;

const readBody = (request) => new Promise((resolve) => { const chunks = []; request.on('data', (chunk) => chunks.push(chunk)); request.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))); });

async function main() {
    let server;
    let browser;
    let activeScenario = 'sent';
    const apiActions = [];
    const pageErrors = [];
    try {
        server = http.createServer(async (request, response) => {
            const url = new URL(request.url, `http://${request.headers.host}`);
            if (process.env.PA_EST_010R2_DEBUG) console.error('REQUEST', request.method, url.pathname, url.search);
            if (url.pathname === '/favicon.ico') { response.writeHead(204); return response.end(); }
            if (url.pathname === '/harness.html') { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return response.end(harness); }
            if (url.pathname === '/api/pa-mail') {
                const body = await readBody(request); apiActions.push(body.action);
                response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); return response.end(JSON.stringify({ ok: true, result: snapshot(activeScenario) }));
            }
            const target = path.resolve(root, decodeURIComponent(url.pathname.slice(1)));
            if (!target.startsWith(root + path.sep) || !fs.existsSync(target) || !fs.statSync(target).isFile()) { response.writeHead(404); return response.end('not found'); }
            const type = { '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' }[path.extname(target)] || 'application/octet-stream';
            response.writeHead(200, { 'Content-Type': type }); fs.createReadStream(target).pipe(response);
        });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const base = `http://127.0.0.1:${server.address().port}`;
        browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
        const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
        const page = await context.newPage();
        page.on('pageerror', (error) => pageErrors.push(error.message));
        page.on('console', (message) => { if (message.type() === 'error') console.error('BROWSER', message.text()); });
        page.on('requestfailed', (request) => console.error('REQUEST_FAILED', request.url(), request.failure()?.errorText));

        const load = async (scenario) => {
            activeScenario = scenario;
            await page.goto(`${base}/harness.html`);
            try {
                await page.locator('#pa-contract-v5-summary').getByText(/現在：/u).waitFor({ timeout: 10000 });
            } catch (error) {
                console.error('HARNESS_TEXT', await page.locator('body').innerText());
                throw error;
            }
            return {
                center: await page.locator('#pa-contract-v5-summary').innerText(),
                next: await page.locator('#pa-next-action-summary').innerText()
            };
        };

        const sent = await load('sent');
        assert.match(sent.center, /現在：回答待ち/u);
        assert.match(sent.center, /正式受注確認 #7/u);
        assert.match(sent.center, /過去の配送要確認 1件/u);
        assert.doesNotMatch(sent.next, /送信結果を照合/u);
        assert.match(sent.next, /お客様の正式回答を待っています/u);
        assert.doesNotMatch(sent.next, /正式受注確認：送信結果要確認/u);
        await page.locator('.pa-confirmation-delivery-history summary').click();
        assert.match(await page.locator('.pa-confirmation-delivery-history').innerText(), /履歴：正式受注確認 #6／送信結果要確認/u);
        assert.equal(await page.locator('.pa-confirmation-delivery-history button').count(), 0);
        await page.screenshot({ path: path.join(outputDir, 'local-current-7-sent-old-6-history.png'), fullPage: true });

        const queued = await load('queued');
        assert.match(queued.center, /現在：送信未完了/u);
        assert.match(queued.next, /正式受注確認は送信待ち/u);
        assert.match(queued.next, /現在の正式受注確認 #7：送信待ち/u);
        assert.equal(await page.getByRole('button', { name: '正式受注確認を送る' }).count(), 1);
        assert.equal(await page.getByRole('button', { name: '固定済み内容を送信' }).count(), 0);

        const unknown = await load('unknown');
        assert.match(unknown.center, /現在：送信結果確認中/u);
        assert.match(unknown.next, /現在の正式受注確認の送信結果を照合/u);
        assert.match(unknown.next, /現在の正式受注確認 #7：送信結果要確認/u);

        const failed = await load('failed');
        assert.match(failed.center, /現在：送信未完了/u);
        assert.match(failed.next, /現在の正式受注確認は送信未完了/u);
        assert.match(failed.next, /現在の正式受注確認 #7：送信失敗/u);

        const accepted = await load('accepted');
        assert.match(accepted.center, /現在：正式受注済み/u);
        assert.match(accepted.next, /現在の正式受注確認 #7の受領メール：送信結果要確認/u);
        assert.match(accepted.next, /現在の請求書：送信結果要確認/u);
        assert.match(accepted.next, /開催終了後、実施・追加費用を人が確認/u);
        assert.equal(pageErrors.length, 0);
        const redrawn = await load('sent');
        assert.match(redrawn.center, /現在：回答待ち/u);
        assert.doesNotMatch(redrawn.next, /現在の正式受注確認 #7：/u, 'successful redraw clears the prior current warning');
        assert.deepEqual(apiActions, ['snapshot', 'snapshot', 'snapshot', 'snapshot', 'snapshot', 'snapshot']);
        console.log(JSON.stringify({ pass: true, browser_scenarios: ['active-sent-old-unknown', 'active-queued-old-unknown', 'active-unknown-old-unknown', 'active-failed-before-provider-old-unknown', 'accepted-receipt-unknown', 'redraw-clears-current-warning'], mutation_api_calls: 0, screenshot: path.join(outputDir, 'local-current-7-sent-old-6-history.png') }));
    } finally {
        if (browser) await browser.close();
        if (server) await new Promise((resolve) => server.close(resolve));
    }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
