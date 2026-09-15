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
    const pageErrors = [], apiActions = [];
    try {
        fixture = await createFixture();
        const r7 = read('20260914213000_pa_est_007r3_delivery_recovery.sql');
        const r7Cut = r7.search(/\r?\ndo \$\$\r?\ndeclare\r?\n  c_case constant/u);
        assert(r7Cut > 0);
        await fixture.db.exec(read('20260913110000_pa_case_management_v5.sql') + '\n'
            + read('20260913130000_pa_case_management_v5_r1.sql') + '\n'
            + read('20260913190000_pa_estimate_recovery_ux.sql') + '\n'
            + read('20260914100000_pa_est_005a_confirmation_snapshot_compat.sql') + '\n'
            + read('20260914170000_pa_est_007r1_production_e2e.sql') + '\n'
            + r7.slice(0, r7Cut) + '\ncommit;\n'
            + read('20260915093000_pa_est_010r1_safe_confirmation_reissue.sql'));
        const service = createService({ fetchImpl: fixture.fetchImpl, sendTransport: async (job) => ({ gmail_message_id: `fake-${job.id}`, gmail_thread_id: 'thread_123' }) });
        const estimate = await service.issueEstimate({ case_id: fixture.inquiryId, expected_revision: 0, expected_current: null, operation_id: crypto.randomUUID(), document_id: crypto.randomUUID(), filename: '見積書 2026.09.11 龍姫湖まつり（改訂）.pdf', content_base64: fixture.quote.toString('base64'), sha256: sha(fixture.quote), amount_minor: 198550, currency: 'JPY', tax_basis: 'tax_included', conditions: { source: 'pa-est-006-browser' }, source_kind: 'managed_send', source_sent_at: '2026-09-11T12:00:00Z', body: '見積書を送付します。', cc_addresses: [] }, { id: fixture.actorId });
        await service.dispatch({ job_id: estimate.outbox_id }, { id: fixture.actorId });
        const safeService = new Proxy(service, { get: (target, property) => property === 'snapshot' ? async (...args) => ({ ...(await target.snapshot(...args)), related_materials: [] }) : target[property] });
        const handler = createHandler({ service: safeService, admin: async () => ({ id: fixture.actorId }), rate: async () => ({ allowed: true }) });
        server = http.createServer(async (request, response) => {
            try {
                const url = new URL(request.url, `http://${request.headers.host}`);
                if (url.pathname === '/harness.html') { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return response.end(harness(fixture.inquiryId)); }
                if (url.pathname === '/api/pa-mail') { const body = await readBody(request); apiActions.push(body.action); return handler({ ...request, body, query: { surface: 'commercial' } }, adapt(response)); }
                const target = path.resolve(root, decodeURIComponent(url.pathname.slice(1)));
                assert(target.startsWith(root + path.sep) && fs.statSync(target).isFile());
                const type = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png' }[path.extname(target)] || 'application/octet-stream';
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
        const openPreview = async () => { await page.getByRole('button', { name: '正式受注確認を発行準備' }).click(); await page.locator('.pa-confirmation-preview-dialog').waitFor({ state: 'visible' }); await page.waitForFunction(() => document.querySelector('.pa-confirmation-preview__fingerprint')); };
        const ownerButton = () => page.getByRole('button', { name: 'この内容で正式受注確認を発行する（送信しない）' });
        const issueCalls = () => apiActions.filter((action) => action === 'issue_confirmation').length;
        for (const width of [1366, 940, 390]) {
            await page.setViewportSize({ width, height: 1000 }); await page.goto(`${base}/harness.html`);
            await openPreview();
            const previewText = await page.locator('.pa-confirmation-preview-dialog').innerText();
            assert.match(previewText, /送信前の最終確認/); assert.match(previewText, /198,550/); assert.match(previewText, /発行時に正式URLが入ります/); assert.match(previewText, /2026年10月18日（日） 10:00〜15:00/); assert.match(previewText, /2026年11月2日（月）/);
            const customerFrame = page.frameLocator('iframe[title="顧客向け正式受注確認ページの送信前プレビュー"]'); await customerFrame.locator('#page').waitFor({ state: 'visible' }); assert.equal(await customerFrame.locator('h1').innerText(), '正式受注確認');
            assert((await page.evaluate(() => document.documentElement.scrollWidth)) <= width); await page.screenshot({ path: path.join(out, `pre-issue-${width}.png`), fullPage: false });
            const finalButton = ownerButton(); assert.equal(await finalButton.isDisabled(), true, 'unchecked owner button remains disabled');
            await page.getByLabel('上記の内容を確認しました。').check(); assert.equal(await finalButton.isDisabled(), false, 'checked owner button becomes enabled');
            const issueBefore = issueCalls(); await finalButton.click(); await page.locator('.pa-confirmation-final-dialog').waitFor({ state: 'visible' }); assert.equal(issueCalls(), issueBefore, 'opening final dialog must not call issue API'); if (width === 1366) await page.screenshot({ path: path.join(out, 'final-dialog-1366.png') });
            if (width === 1366) await page.keyboard.press('Escape'); else await page.getByRole('button', { name: '戻って確認する' }).click();
            await page.locator('.pa-confirmation-final-dialog').waitFor({ state: 'detached' }); assert.equal(await page.evaluate(() => document.activeElement?.textContent?.includes('この内容で正式受注確認を発行する')), true, 'Escape/Back returns focus to owner button');
            await page.getByRole('button', { name: '閉じる' }).click(); await page.locator('.pa-confirmation-preview-dialog').waitFor({ state: 'detached' });
        }
        await page.setViewportSize({ width: 1366, height: 1000 }); await page.goto(`${base}/harness.html`); await openPreview(); await page.evaluate(() => { document.documentElement.style.zoom = '200%'; }); assert((await page.evaluate(() => document.documentElement.scrollWidth)) <= 1366); await page.screenshot({ path: path.join(out, 'pre-issue-200-percent.png') });
        await page.getByRole('button', { name: '内容を再取得' }).evaluate((node) => node.click()); await page.waitForFunction(() => document.querySelector('.pa-confirmation-preview__fingerprint'));
        await page.getByLabel('上記の内容を確認しました。').check(); const refreshedButton = ownerButton(), refreshedIssueBefore = issueCalls(); await refreshedButton.click(); await page.locator('.pa-confirmation-final-dialog').waitFor({ state: 'visible' }); assert.equal(issueCalls(), refreshedIssueBefore, 'refreshed preview dialog open must not mutate'); await page.getByRole('button', { name: '戻って確認する' }).click();
        const doubleIssueBefore = issueCalls(); await refreshedButton.evaluate((node) => { node.click(); node.click(); }); await page.locator('.pa-confirmation-final-dialog').waitFor({ state: 'visible' }); assert.equal(await page.locator('.pa-confirmation-final-dialog').count(), 1, 'double click creates exactly one final dialog'); assert.equal(issueCalls(), doubleIssueBefore, 'double click must not call issue API'); await page.getByRole('button', { name: '戻って確認する' }).click();
        await page.evaluate(() => { const original = HTMLDialogElement.prototype.showModal; HTMLDialogElement.prototype.showModal = function () { if (this.classList.contains('pa-confirmation-final-dialog')) throw Error('simulated_final_dialog_failure'); return original.call(this); }; });
        const errorIssueBefore = issueCalls(); await refreshedButton.click(); const visibleError = page.getByRole('alert'); await visibleError.waitFor({ state: 'visible' }); assert.equal(await visibleError.innerText(), '最終確認画面を開けませんでした。内容を再取得してもう一度お試しください。'); assert.equal(issueCalls(), errorIssueBefore, 'dialog rendering failure must not call issue API'); assert.equal(await refreshedButton.isEnabled(), true, 'dialog rendering failure restores the owner button'); assert.equal(await refreshedButton.getAttribute('aria-busy'), null, 'dialog rendering failure clears aria-busy');
        await page.getByRole('button', { name: '閉じる' }).evaluate((node) => node.click());
        assert.deepEqual(await counts(fixture.db, fixture.inquiryId), before); assert.equal(pageErrors.length, 0, pageErrors.join('\n'));
        assert.equal(issueCalls(), 0);

        await page.goto(`${base}/harness.html`); await openPreview(); await page.getByLabel('上記の内容を確認しました。').check(); await ownerButton().click();
        await page.getByRole('button', { name: '正式受注確認を発行する（送信しない）' }).click();
        await page.getByRole('button', { name: '正式受注確認を送る' }).waitFor({ state: 'visible' });
        const afterIssue = await counts(fixture.db, fixture.inquiryId);
        assert.equal(afterIssue.offers, before.offers + 1); assert.equal(afterIssue.tokens, before.tokens + 1); assert.equal(afterIssue.contracts, before.contracts); assert.equal(apiActions.filter((action) => action === 'dispatch_outbox').length, 0);
        await page.getByRole('button', { name: '正式受注確認を送る' }).click(); await page.locator('.pa-confirmation-preview-dialog').waitFor({ state: 'visible' }); await page.waitForFunction(() => document.querySelector('.pa-confirmation-preview__fingerprint'));
        assert.match(await page.locator('.pa-confirmation-preview-dialog').innerText(), /発行済みです。案内メールはまだ送信されていません/u);
        await page.getByLabel('上記の内容を確認しました。').check(); await page.getByRole('button', { name: '正式受注確認を送る' }).last().click();
        await page.locator('.pa-confirmation-final-dialog').waitFor({ state: 'visible' }); assert.equal(apiActions.filter((action) => action === 'dispatch_outbox').length, 0);
        await page.getByRole('button', { name: '戻って確認する' }).click(); await page.getByRole('button', { name: '閉じる' }).click();

        const firstOffer = (await fixture.db.query('select id,version from public.pa_contract_offers where inquiry_id=$1 order by version desc limit 1', [fixture.inquiryId])).rows[0];
        const firstJob = (await fixture.db.query("select id from public.pa_commercial_outbox where inquiry_id=$1 and aggregate_id=$2 and job_kind='confirmation'", [fixture.inquiryId, firstOffer.id])).rows[0];
        await fixture.db.query("update public.pa_commercial_outbox set state='unknown' where id=$1", [firstJob.id]);
        const replaceBefore = await counts(fixture.db, fixture.inquiryId);
        await page.goto(`${base}/harness.html`);
        await page.getByRole('button', { name: 'この確認を失効して再発行準備' }).click();
        await page.locator('.pa-confirmation-preview-dialog').waitFor({ state: 'visible' });
        await page.waitForFunction(() => document.querySelector('.pa-confirmation-preview__fingerprint'));
        assert.match(await page.locator('.pa-confirmation-preview-dialog').innerText(), /失効し、新しい確認を同じ見積で準備します。案内メールは送信しません/u);
        await page.getByLabel('上記の内容を確認しました。').check();
        await page.getByRole('button', { name: '旧確認を失効して新しい確認を準備（送信しない）' }).click();
        await page.locator('.pa-confirmation-final-dialog').waitFor({ state: 'visible' });
        assert.deepEqual(await counts(fixture.db, fixture.inquiryId), replaceBefore, 'replacement final dialog opens without mutation');
        await page.getByRole('button', { name: '旧確認を失効して新しい確認を発行する（送信しない）' }).click();
        await page.getByRole('button', { name: '正式受注確認を送る' }).waitFor({ state: 'visible' });
        const replaceAfter = await counts(fixture.db, fixture.inquiryId);
        assert.equal(replaceAfter.offers, replaceBefore.offers + 1);
        assert.equal(replaceAfter.tokens, replaceBefore.tokens + 1);
        assert.equal(replaceAfter.outbox, replaceBefore.outbox + 1);
        assert.equal(replaceAfter.contracts, replaceBefore.contracts);
        assert.equal((await fixture.db.query("select state from public.pa_commercial_outbox where id=$1", [firstJob.id])).rows[0].state, 'unknown');
        assert.equal(Number((await fixture.db.query("select count(*) n from public.pa_contract_tokens t join public.pa_contract_offers o on o.id=t.offer_id where o.inquiry_id=$1 and t.state='active'", [fixture.inquiryId])).rows[0].n), 1);
        assert.equal(apiActions.filter((action) => action === 'dispatch_outbox').length, 0, 'replacement never dispatches provider');
        const result = { pass: true, widths: [1366, 940, 390], zoom: '200%', unchecked_disabled: true, checked_enabled: true, final_dialog_open: true, preview_open_mutation: 0, preview_refresh_mutation: 0, final_dialog_mutation: 0, escape_close: true, back_close: true, focus_return: true, rerender_binding: true, refresh_binding: true, double_click_singleton: true, visible_error: true, issue_without_dispatch: true, issued_preview: true, atomic_replacement_dialog: true, atomic_replacement_prepared_without_send: true, old_unknown_preserved: true, active_token_count: 1, real_issue: 0, real_email: 0 };
        fs.writeFileSync(path.join(out, 'pa-est-006-browser-results.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
    } finally { if (browser) await browser.close(); if (server) await new Promise((resolve) => server.close(resolve)); if (fixture) await fixture.db.close(); }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
