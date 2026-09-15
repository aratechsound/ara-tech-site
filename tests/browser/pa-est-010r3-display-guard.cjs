const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('C:/Users/user/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.js');

const root = path.resolve(__dirname, '../..');
const outputDir = process.env.PA_EST_010R3_OUTPUT_DIR || path.join(root, 'tmp', 'pa-est-010r3-display');
fs.mkdirSync(outputDir, { recursive: true });

const oldOffer = { id: 'offer-6', version: 6, state: 'revoked', estimate_revision_id: 'estimate-2', snapshot: { estimate_revision_number: 2 } };
const activeOffer = { id: 'offer-7', version: 7, state: 'active', estimate_revision_id: 'estimate-2', expires_at: '2026-09-22T01:56:42Z', snapshot: { estimate_revision_number: 2 } };
const oldUnknown = { id: 'job-6', aggregate_id: oldOffer.id, job_kind: 'confirmation', state: 'unknown', created_at: '2026-09-14T01:00:00Z' };
const sent7 = { id: 'job-7', aggregate_id: activeOffer.id, job_kind: 'confirmation', state: 'sent', delivery_state: 'sent', created_at: '2026-09-15T02:00:00Z' };

const snapshot = (scenario) => {
    const outbox = [oldUnknown, sent7];
    const billings = [];
    if (['unknown', 'queued', 'failed'].includes(scenario)) outbox.push({
        id: `unclassified-${scenario}`,
        aggregate_id: 'missing-offer',
        job_kind: 'confirmation',
        state: scenario,
        delivery_state: scenario,
        created_at: '2026-09-15T03:00:00Z'
    });
    if (scenario === 'current-invoice-failed') {
        billings.push({ id: 'billing-1', billing_number: 1, state: 'open', amount_minor: 198550, currency: 'JPY', invoice_policy: 'separate_pdf' });
        outbox.push({ id: 'invoice-1', aggregate_id: 'billing-1', job_kind: 'invoice', state: 'failed', created_at: '2026-09-15T03:00:00Z' });
    }
    return {
        state: { current_estimate_revision_id: 'estimate-2', estimate_change_state: 'ready', fulfillment_state: 'not_confirmed', settlement_state: 'unsettled', settlement_currency: 'JPY', revision: 2, updated_at: '2026-09-15T02:37:34Z' },
        estimates: [{ id: 'estimate-2', revision_number: 2, amount_minor: 198550, currency: 'JPY', source_kind: 'sent_recovery', source_sent_at: '2026-09-11T03:54:00Z', issued_at: '2026-09-11T03:54:00Z' }],
        offers: [activeOffer, oldOffer], outbox, billings, payments: [], adjustments: [], change_orders: [], documents: [], related_materials: [], case_status: 'active', production_e2e_test: false
    };
};

const harness = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><link rel="stylesheet" href="/pa-commercial.css"></head><body>
<section id="pa-commercial-workspace" class="pa-commercial hidden"><button id="pa-commercial-refresh"></button><button id="pa-v5-reply"></button><button id="pa-v5-estimate"></button><button id="pa-v5-add-file"></button><button id="pa-v5-note"></button><div class="pa-commercial__cards"><section class="pa-commercial-card"><button id="pa-estimate-tab"></button><button id="pa-billing-tab"></button><div id="pa-estimate-summary"></div><div id="pa-billing-summary"></div></section><section class="pa-commercial-card"><div id="pa-contract-v5-summary"></div></section><section class="pa-commercial-card"><span id="pa-data-freshness"></span><div id="pa-next-action-summary"></div></section></div><button id="pa-related-left"></button><button id="pa-related-right"></button><button id="pa-related-all"></button><span id="pa-related-files-count"></span><div id="pa-related-files"></div></section>
<script type="module">import{renderCommercialWorkspace}from'/js/pa-commercial-admin.js';const current={id:'case-real',event_name:'2026龍姫湖まつり'};const context={case:current,getCurrentCase:()=>current,getAccessToken:async()=> 'fixture-admin',openComposer:()=>{},focusBilling:()=>{},focusNote:()=>{},openFileSearch:()=>{}};window.__context=context;renderCommercialWorkspace(context);</script></body></html>`;

const readBody = (request) => new Promise((resolve) => { const chunks = []; request.on('data', (chunk) => chunks.push(chunk)); request.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))); });

async function main() {
    let server;
    let browser;
    let activeScenario = 'unknown';
    const apiActions = [];
    const pageErrors = [];
    try {
        server = http.createServer(async (request, response) => {
            const url = new URL(request.url, `http://${request.headers.host}`);
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
        await page.goto(`${base}/harness.html`);
        await page.locator('#pa-contract-v5-summary').getByText(/現在：/u).waitFor({ timeout: 10000 });
        await page.waitForFunction(() => document.querySelector('#pa-next-action-summary')?.innerText.includes('関連先を確認できない配送'));

        const refreshSamePage = async (scenario) => {
            activeScenario = scenario;
            await page.evaluate(() => window.__context.refreshCommercial());
            await page.waitForFunction((expected) => document.querySelector('#pa-next-action-summary')?.innerText.includes(`種別：confirmation）：${expected}`), scenario === 'failed' ? '送信失敗' : scenario === 'queued' ? '送信待ち' : '送信結果要確認');
            return page.locator('#pa-next-action-summary').innerText();
        };

        for (const scenario of ['unknown', 'queued', 'failed']) {
            const next = scenario === 'unknown' ? await page.locator('#pa-next-action-summary').innerText() : await refreshSamePage(scenario);
            assert.match(next, /関連先を確認できない配送（種別：confirmation）：/u);
            assert.equal(await page.getByRole('button', { name: '固定済み内容を送信' }).count(), 0, `unclassified ${scenario} has no send action`);
        }
        await page.screenshot({ path: path.join(outputDir, 'local-unclassified-warning-no-action.png'), fullPage: true });

        activeScenario = 'sent';
        await page.evaluate(() => window.__context.refreshCommercial());
        await page.waitForFunction(() => !document.querySelector('#pa-next-action-summary')?.innerText.includes('関連先を確認できない配送'));
        const sentNext = await page.locator('#pa-next-action-summary').innerText();
        const sentCenter = await page.locator('#pa-contract-v5-summary').innerText();
        assert.match(sentCenter, /現在：回答待ち/u);
        assert.match(sentCenter, /過去の配送要確認 1件/u);
        assert.match(sentNext, /お客様の正式回答を待っています。/u);
        assert.doesNotMatch(sentNext, /関連先を確認できない配送/u, 'same-page redraw clears stale unclassified warning');

        activeScenario = 'current-invoice-failed';
        await page.evaluate(() => window.__context.refreshCommercial());
        await page.waitForFunction(() => document.querySelector('#pa-next-action-summary')?.innerText.includes('現在の請求書：送信失敗'));
        assert.equal(await page.getByRole('button', { name: '固定済み内容を送信' }).count(), 1, 'proven current invoice keeps its existing action');
        assert.equal(pageErrors.length, 0);
        assert.ok(apiActions.every((action) => action === 'snapshot'));
        console.log(JSON.stringify({ pass: true, unclassified_states: ['unknown', 'queued', 'failed'], unclassified_send_action_count: 0, same_page_redraw: 'PASS', current_invoice_action_preserved: true, mutation_api_calls: 0, screenshot: path.join(outputDir, 'local-unclassified-warning-no-action.png') }));
    } finally {
        if (browser) await browser.close();
        if (server) await new Promise((resolve) => server.close(resolve));
    }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
