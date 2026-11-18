const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const { createFixture } = require('../helpers/pa-contract-fixture.cjs');
const { setup, MODE } = require('../validate-pam-025-direct-confirmation.cjs');
const { read } = require('../helpers/pa-estimate-fixture.cjs');
const { createService, decryptSecret } = require('../../api/_pa-commercial.cjs');
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
    let fixture, billingFixture, pdfFixture, unknownFixture, server, browser;
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
        const options = { admin: async () => ({ id: fixture.actorId }), rate: async () => ({ allowed: true }) };
        let handler = createHandler({ service: safeService, ...options });
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
        browser = await chromium.launch({ headless: true, ...(process.env.PA_CHROME_EXECUTABLE ? { executablePath: process.env.PA_CHROME_EXECUTABLE } : {}) });
        const context = await browser.newContext();
        await context.route('**/*', (route) => { const url = new URL(route.request().url()); return url.origin === base || url.protocol === 'blob:' ? route.continue() : route.abort(); });
        const deskCases = [
            { id: fixture.inquiryId, inquiry_number: 'PA-FIXTURE-A', event_name: '隔離見積案件', case_type: 'PA_EVENT', status: 'new' },
            { id: fixture.otherId, inquiry_number: 'PA-FIXTURE-B', event_name: '別の隔離案件', case_type: 'PA_EVENT', status: 'new' }
        ];
        await context.route(base + '/pa-ui/js/integration.mjs', route => route.fulfill({
            contentType: 'text/javascript',
            body: `const session={user:{id:'fixture-owner'},access_token:'fixture-admin',expires_at:9999999999};
                export const workspaceAuth={restore:async()=>session,current:async()=>session};
                export const readUrl=path=>'/fixture-desk-read?path='+encodeURIComponent(path);
                export const legacyUrl=id=>'/pa-admin-legacy.html?case='+id;`
        }));
        await context.route(base + '/fixture-desk-read?**', async route => {
            const target = new URL(route.request().url()).searchParams.get('path');
            let result = target === '/data/cases' ? { cases: deskCases, progress: [] }
                : target.startsWith('/data/commercial/') ? { estimates: [], offers: [], billings: [] }
                : target.startsWith('/data/sent-estimates/') ? { messages: [], unknown: [] } : [];
            const activeFixture = unknownFixture || pdfFixture || billingFixture;
            if (activeFixture) {
                const { db, inquiryId, service } = activeFixture;
                if (target === '/data/cases') {
                    const { rows } = await db.query('select id,status from pa_inquiries where id=$1', [inquiryId]);
                    result = {
                        cases: deskCases.map(item => item.id === rows[0].id ? { ...item, status: rows[0].status } : item),
                        progress: (await db.query('select * from pa_case_progress')).rows
                    };
                } else if (target === '/data/commercial/' + inquiryId) {
                    result = await service.snapshot(inquiryId);
                } else if (target === '/data/case/' + inquiryId + '/payments') {
                    result = (await db.query('select * from pa_payment_records where inquiry_id=$1', [inquiryId])).rows;
                } else if (target === '/data/case/' + inquiryId + '/audit') {
                    result = (await db.query('select occurred_at,action,details from pa_inquiry_audit where inquiry_id=$1 order by occurred_at desc', [inquiryId])).rows;
                }
            }
            return route.fulfill({ json: { ok: true, result } });
        });
        const page = await context.newPage(); page.on('pageerror', (error) => { pageErrors.push(error.message); console.error('PAGEERROR', error.message); }); page.on('console', (message) => { if (message.type() === 'error') console.error('CONSOLE', message.text()); }); page.on('response', (response) => { if (response.status() >= 400) console.error('HTTP', response.status(), response.url()); });
        const before = await counts(fixture.db, fixture.inquiryId);
        const otherCaseBefore = (await fixture.db.query(
            'select to_jsonb(i) as row from pa_inquiries i where id=$1', [fixture.otherId]
        )).rows;
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

        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto(`${base}/pa-admin.html?case=${fixture.inquiryId}`);
        await page.getByRole('button', { name: '見積・受注', exact: true }).click();
        await page.getByRole('button', { name: '正式受注の操作', exact: true }).click();
        await openPreview();
        const deskPreview = page.locator('.pa-confirmation-preview-dialog');
        const brandedFrame = deskPreview.locator('iframe.pa-confirmation-preview__email');
        assert.equal(await brandedFrame.getAttribute('sandbox'), '');
        assert.equal(await brandedFrame.getAttribute('srcdoc'), null);
        assert.doesNotMatch(await deskPreview.innerText(), /198,550/u);
        await deskPreview.getByRole('button', { name: '金額・原本を表示' }).click();
        assert.match(await deskPreview.innerText(), /198,550/u);
        assert.match(await brandedFrame.getAttribute('srcdoc'), /ARA-TECH/u);
        await deskPreview.getByRole('button', { name: '金額・原本を表示' }).click();
        assert.equal(await brandedFrame.getAttribute('srcdoc'), null);
        assert.doesNotMatch(await deskPreview.innerText(), /198,550/u);
        assert(await deskPreview.evaluate(node => node.getBoundingClientRect().width <= innerWidth));
        await page.screenshot({ path: path.join(out, 'desk-confirmation-390.png') });
        await page.getByLabel('上記の内容を確認しました。').check();
        await ownerButton().click();
        await page.locator('.pa-confirmation-final-dialog').waitFor({ state: 'visible' });
        // Simulate a case change while the final confirmation is displayed.
        await page.locator(`[data-case="${fixture.otherId}"]`).evaluate(node => node.click());
        await deskPreview.waitFor({ state: 'detached' });
        await page.locator('.pa-confirmation-final-dialog').waitFor({ state: 'detached' });
        assert.equal(issueCalls(), 0);
        await page.setViewportSize({ width: 1366, height: 1000 });
        await page.locator(`[data-case="${fixture.inquiryId}"]`).click();
        await page.getByRole('button', { name: '見積・受注', exact: true }).click();
        await page.getByRole('button', { name: '正式受注の操作', exact: true }).click();
        await openPreview();
        await page.screenshot({ path: path.join(out, 'desk-confirmation-1366.png') });
        await page.getByLabel('上記の内容を確認しました。').check(); await ownerButton().click();
        await page.getByRole('button', { name: '正式受注確認を発行する（送信しない）' }).click();
        await page.getByRole('button', { name: '正式受注確認を送る' }).waitFor({ state: 'visible' });
        assert.equal(new URL(page.url()).pathname, '/pa-admin.html');
        assert.equal(context.pages().length, 1, 'CASE DESK must not open the legacy admin');
        const afterIssue = await counts(fixture.db, fixture.inquiryId);
        assert.equal(afterIssue.offers, before.offers + 1); assert.equal(afterIssue.tokens, before.tokens + 1); assert.equal(afterIssue.contracts, before.contracts); assert.equal(apiActions.filter((action) => action === 'dispatch_outbox').length, 0);
        await page.setViewportSize({ width: 1366, height: 1000 });
        await page.goto(`${base}/harness.html`);
        await page.getByRole('button', { name: '正式受注確認を送る' }).click(); await page.locator('.pa-confirmation-preview-dialog').waitFor({ state: 'visible' }); await page.waitForFunction(() => document.querySelector('.pa-confirmation-preview__fingerprint'));
        assert.match(await page.locator('.pa-confirmation-preview-dialog').innerText(), /発行済みです。案内メールはまだ送信されていません/u);
        await page.getByLabel('上記の内容を確認しました。').check(); await page.getByRole('button', { name: '正式受注確認を送る' }).last().click();
        await page.locator('.pa-confirmation-final-dialog').waitFor({ state: 'visible' }); assert.equal(apiActions.filter((action) => action === 'dispatch_outbox').length, 0);
        await page.getByRole('button', { name: '戻って確認する' }).click(); await page.getByRole('button', { name: '閉じる' }).click();

        const firstOffer = (await fixture.db.query('select id,version from public.pa_contract_offers where inquiry_id=$1 order by version desc limit 1', [fixture.inquiryId])).rows[0];
        const firstJob = (await fixture.db.query("select id from public.pa_commercial_outbox where inquiry_id=$1 and aggregate_id=$2 and job_kind='confirmation'", [fixture.inquiryId, firstOffer.id])).rows[0];
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
        const replaced = page.waitForResponse(response => response.url().includes('/api/pa-mail?surface=commercial')
            && response.request().postDataJSON()?.action === 'replace_confirmation');
        await page.getByRole('button', { name: '旧確認を失効して新しい確認を発行する（送信しない）' }).click();
        const replacementResponse = await replaced;
        assert.equal(replacementResponse.status(), 200, await replacementResponse.text());
        await page.locator('#pa-contract-v5-summary').getByText(/正式受注確認 #2/u).waitFor();
        const replaceAfter = await counts(fixture.db, fixture.inquiryId);
        assert.equal(replaceAfter.offers, replaceBefore.offers + 1);
        assert.equal(replaceAfter.tokens, replaceBefore.tokens + 1);
        assert.equal(replaceAfter.outbox, replaceBefore.outbox + 1);
        assert.equal(replaceAfter.contracts, replaceBefore.contracts);
        assert.equal((await fixture.db.query("select state from public.pa_commercial_outbox where id=$1", [firstJob.id])).rows[0].state, 'cancelled');
        assert.equal(Number((await fixture.db.query("select count(*) n from public.pa_contract_tokens t join public.pa_contract_offers o on o.id=t.offer_id where o.inquiry_id=$1 and t.state='active'", [fixture.inquiryId])).rows[0].n), 1);
        assert.equal(apiActions.filter((action) => action === 'dispatch_outbox').length, 0, 'replacement never dispatches provider');

        const currentJob = (await fixture.db.query(
            "select id,aggregate_id from public.pa_commercial_outbox where inquiry_id=$1 and job_kind='confirmation' and id<>$2",
            [fixture.inquiryId, firstJob.id]
        )).rows[0];
        await fixture.db.query("update public.pa_commercial_outbox set state='unknown',delivery_state='unknown_after_provider_start' where id=$1", [currentJob.id]);
        const unknownBefore = await counts(fixture.db, fixture.inquiryId);
        await page.goto(`${base}/harness.html`);
        const contractPanel = page.locator('#pa-contract-v5-summary');
        await contractPanel.getByText('送信結果を照合してから、正式受注確認を準備してください。').waitFor();
        assert.equal(await contractPanel.getByRole('button', { name: 'この確認を失効して再発行準備' }).count(), 0);
        assert.equal(await contractPanel.getByRole('button', { name: '正式受注確認を送る' }).count(), 0);
        await assert.rejects(service.confirmationPreview({
            case_id: fixture.inquiryId, replace_offer_id: currentJob.aggregate_id
        }, { id: fixture.actorId }), /delivery_outcome_unresolved/u);
        assert.deepEqual(await counts(fixture.db, fixture.inquiryId), unknownBefore);
        assert.equal((await fixture.db.query("select state from public.pa_commercial_outbox where id=$1", [currentJob.id])).rows[0].state, 'unknown');
        assert.deepEqual((await fixture.db.query(
            'select to_jsonb(i) as row from pa_inquiries i where id=$1', [fixture.otherId]
        )).rows, otherCaseBefore);
        const beforeReadOnly = apiActions.length;
        await page.goto(`${base}/pa-admin.html?case=${fixture.inquiryId}&mail-view=readonly`);
        await page.getByRole('button', { name: '見積・受注', exact: true }).click();
        await page.getByRole('heading', { name: '見積・正式受注', exact: true }).waitFor();
        assert.equal(await page.getByRole('button', { name: '正式受注の操作', exact: true }).count(), 0);
        assert.equal(apiActions.length, beforeReadOnly);

        billingFixture = await setup();
        const f = billingFixture;
        process.env.ALLOWED_ORIGINS = base;
        const case_id = f.inquiryId;
        await f.createEstimate();
        const quote = await f.service.confirmationPreview({ case_id, confirmation_mode: MODE }, f.actor);
        const agreement = await f.service.issueDirectConfirmationAndSend({
            case_id, confirmation_mode: MODE, preview_fingerprint: quote.fingerprint, operation_id: crypto.randomUUID()
        }, f.actor);
        const { rows: [offer] } = await f.db.query('select snapshot_sha256 from pa_contract_offers where id=$1', [agreement.id]);
        const { rows: [job] } = await f.db.query('select secret_envelope from pa_commercial_outbox where id=$1', [agreement.outbox_id]);
        const accepted = await f.contract.accept({
            token: decryptSecret(job.secret_envelope).split('#')[1], offer_id: agreement.id,
            snapshot_sha256: offer.snapshot_sha256, confirmer_name: '合成案件担当者', agree: true
        });
        assert.equal(accepted.state, 'accepted');
        const sendsBeforeBilling = f.state.sendCount;
        handler = createHandler({ service: f.service, ...options });
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto(`${base}/pa-admin.html?case=${case_id}`);
        await page.getByRole('button', { name: '請求・入金', exact: true }).click();
        await page.getByRole('button', { name: '請求・入金の操作', exact: true }).click();
        const entryResponse = action => page.waitForResponse(response =>
            response.url().includes('/api/pa-mail?surface=commercial')
            && response.request().postDataJSON()?.action === action);
        const recordPayment = async ({ button, title, action, submit, amount, date }) => {
            await page.getByRole('button', { name: button, exact: true }).click();
            const paymentForm = page.getByRole('dialog', { name: title, exact: true });
            await paymentForm.getByRole('button', { name: '金額を表示・入力' }).click();
            await paymentForm.getByLabel('入金確認日').fill(date);
            await paymentForm.locator('input[type="number"]').fill(String(amount));
            await paymentForm.getByLabel('確認メモ').fill('合成案件の確認済み入金');
            const response = entryResponse(action);
            await paymentForm.getByRole('button', { name: submit, exact: true }).click();
            const result = await response;
            assert.equal(result.status(), 200, await result.text());
        };
        await recordPayment({ button:'前払いを記録', title:'前払いの手動確認', action:'record_prepayment',
            submit:'前払いとして記録', amount:30000, date:'2026-11-04' });
        const { rows: [originalPrepayment] } = await f.db.query('select id,amount,billing_id from pa_payment_records where inquiry_id=$1', [case_id]);
        assert.equal(Number(originalPrepayment.amount), 30000);
        assert.equal(originalPrepayment.billing_id, null);
        await page.getByRole('button', { name: '前払いを訂正', exact: true }).click();
        const correction = page.getByRole('dialog', { name: '前払い記録の訂正', exact: true });
        await correction.getByRole('button', { name: '金額を表示・入力' }).click();
        await correction.getByLabel('対象記録').selectOption(originalPrepayment.id);
        await correction.getByLabel('訂正差額（減額はマイナス）').fill('-5000');
        await correction.getByLabel('訂正理由').fill('合成案件の照合による訂正');
        const adjusted = entryResponse('adjust_payment');
        await correction.getByRole('button', { name: '追記で訂正', exact: true }).click();
        const adjustment = await adjusted;
        assert.equal(adjustment.status(), 200, await adjustment.text());
        const settle = page.getByRole('button', { name: '実施・精算を確認', exact: true });
        await settle.click();
        let form = page.getByRole('dialog', { name: '実施・精算確認', exact: true });
        assert.equal(await form.getByLabel('最終精算額（円）').inputValue(), '');
        assert.equal(await form.getByRole('button', { name: '実施・精算を確定' }).isDisabled(), true);
        await page.keyboard.press('Escape');
        await form.waitFor({ state: 'detached' });
        assert.equal(apiActions.filter(action => action === 'confirm_settlement').length, 0);
        await settle.click();
        await form.getByRole('button', { name: '金額を表示・入力' }).click();
        assert.equal(await form.getByLabel('最終精算額（円）').inputValue(), '110000');
        await form.getByLabel('確認根拠').fill('隔離案件の実施確認');
        await form.getByRole('button', { name: '実施・精算を確定' }).click();
        await page.getByRole('button', { name: '既存書類で請求管理', exact: true }).click();
        form = page.getByRole('dialog', { name: '既存書類で請求管理', exact: true });
        await form.getByLabel('合意した支払期限（未確定の場合は空欄）').fill('2026-11-30');
        await form.getByRole('button', { name: '請求書を別途発行せずに登録' }).click();
        await recordPayment({ button:'入金を記録', title:'手動入金確認', action:'record_payment',
            submit:'入金のみ記録', amount:20000, date:'2026-11-08' });
        await page.getByRole('button', { name: '案件完了を確認', exact: true }).click();
        form = page.getByRole('dialog', { name: '入金確認と案件完了', exact: true });
        await form.getByRole('button', { name: '金額を表示・入力' }).click();
        await form.getByLabel('追加入金確認日').fill('2026-11-10');
        assert.equal(await form.getByLabel('今回確認した金額（円）').inputValue(), '65000');
        await form.getByRole('button', { name: '全条件を確認して完了' }).click();
        assert.equal(apiActions.filter(action => action === 'close_case').length, 0);
        await form.getByLabel('確認メモ').fill('隔離案件の銀行振込を確認');
        const closeResponse = page.waitForResponse(response => response.url().includes('/api/pa-mail?surface=commercial')
            && response.request().postDataJSON()?.action === 'close_case');
        await form.getByRole('button', { name: '全条件を確認して完了' }).click();
        const saved = await closeResponse;
        assert.equal(saved.status(), 200, await saved.text());
        await page.getByText('案件は完了しました。', { exact: true }).waitFor();
        await page.waitForFunction(() => document.getElementById('head-state')?.textContent === '入金確認済みで完了');
        await page.getByText('入金記録に基づく完了', { exact: true }).waitFor();
        const { rows: [bill] } = await f.db.query('select * from pa_billings where inquiry_id=$1', [case_id]);
        assert.equal(bill.invoice_policy, 'no_separate_invoice');
        assert.equal(bill.state, 'paid');
        assert.equal((await f.db.query('select status from pa_inquiries where id=$1', [case_id])).rows[0].status, 'closed');
        const { rows: ledger } = await f.db.query(
            'select id,amount from pa_payment_records where billing_id=$1 order by payment_date', [bill.id]);
        assert.deepEqual(ledger.map(row => Number(row.amount)), [30000, 20000, 65000]);
        assert.equal(ledger[0].id, originalPrepayment.id);
        const { rows: corrections } = await f.db.query(
            'select payment_id,delta_minor from pa_payment_adjustments where inquiry_id=$1', [case_id]);
        assert.deepEqual(corrections.map(row => [row.payment_id, Number(row.delta_minor)]), [[originalPrepayment.id, -5000]]);
        assert.equal(f.state.sendCount, sendsBeforeBilling);
        assert.equal(apiActions.filter(action => action === 'close_case').length, 1);
        assert.equal(context.pages().length, 1);
        await page.reload();
        await page.waitForFunction(() => document.getElementById('head-state')?.textContent === '入金確認済みで完了');
        await page.getByRole('button', { name: '請求・入金', exact: true }).click();
        await page.getByText('bank_transfer', { exact: true }).first().waitFor();
        assert.equal(await page.getByRole('button', { name: '請求・入金の操作', exact: true }).count(), 0);
        console.log('PASS CASE DESK prepayment, append-only correction, partial payment, exact remaining balance, and closure without separate invoice or billing mail');

        const openDesk = async (testFixture, invoice) => {
            process.env.ALLOWED_ORIGINS = base;
            handler = createHandler({ service: testFixture.service, ...options });
            await page.goto(`${base}/pa-admin.html?case=${testFixture.inquiryId}`);
            await page.getByRole('button', { name: invoice ? '請求・入金' : '見積・受注', exact: true }).click();
            await page.getByRole('button', { name: invoice ? '請求・入金の操作' : '正式受注の操作', exact: true }).click();
        };
        const reviewPdf = async (invoice, bytes, filename) => {
            const name = invoice ? '請求書' : '見積書';
            await page.getByRole('button', { name: name + 'PDFを送る', exact: true }).click();
            const draft = page.getByRole('dialog', { name: name + 'の送付', exact: true });
            await draft.getByRole('button', { name: '金額を表示・入力' }).click();
            await draft.getByLabel('税込金額（円）').fill('110000');
            await draft.locator('input[type=file]').setInputFiles({ name: filename, mimeType: 'application/pdf', buffer: bytes });
            if (invoice) await draft.getByLabel('合意した支払期限（未確定の場合は空欄）').fill('2026-11-30');
            await draft.getByRole('button', { name: '送信内容を確認' }).click();
            const review = page.getByRole('dialog', { name: name + 'の送付内容', exact: true });
            await review.getByText(filename).waitFor();
            const send = review.getByRole('button', { name: name + 'を送信する', exact: true });
            assert.equal(await send.isDisabled(), true);
            await review.getByRole('button', { name: '本文・金額を表示' }).click();
            assert.equal(await review.locator('iframe').getAttribute('sandbox'), '');
            assert.match(await review.locator('iframe').getAttribute('srcdoc'), /ARA-TECH/u);
            assert.equal(await send.isDisabled(), false);
            return send;
        };
        pdfFixture = await setup();
        const pf = pdfFixture;
        await openDesk(pf, false);
        const proof = {
            case_id: pf.inquiryId, body: '確認した内容', cc_addresses: [],
            filename: '原本.pdf', content_base64: pf.quote.toString('base64'), sha256: sha(pf.quote)
        };
        const reviewAuthority = await pf.service.composerPreview(proof, pf.actor);
        await assert.rejects(pf.service.issueEstimate({
            ...proof, body: 'プレビュー後に変更された本文',
            preview_token: reviewAuthority.confirmation_token, expected_revision: 0,
            operation_id: crypto.randomUUID(), document_id: crypto.randomUUID(),
            amount_minor: 110000, currency: 'JPY', tax_basis: 'tax_included', source_kind: 'managed_send'
        }, pf.actor), /invalid_confirmation/u);
        const sendEstimate = await reviewPdf(false, pf.quote, '見積書 現行画面.pdf');
        assert.equal(pf.state.sendCount, 0);
        await sendEstimate.click();
        await page.getByText(/見積書送信済み/u).waitFor();
        assert.equal(pf.state.sendCount, 1);
        const { rows: [sentEstimate] } = await pf.db.query(
            "select * from pa_commercial_outbox where inquiry_id=$1 and job_kind='estimate'", [pf.inquiryId]
        );
        assert.equal(sentEstimate.state, 'sent');
        await assert.rejects(pf.service.dispatch({case_id: pf.otherId, job_id: sentEstimate.id}, pf.actor), /outbox_not_found/u);
        assert.equal(pf.state.sendCount, 1);
        const revisedPdf = Buffer.concat([pf.quote, Buffer.from('\n% Fixture revision 2\n')]);
        const revisedFilename = '見積書 改訂第2版.pdf';
        const sendRevision = await reviewPdf(false, revisedPdf, revisedFilename);
        assert.equal(pf.state.sendCount, 1);
        await sendRevision.click();
        await page.getByRole('cell', { name: /^版 2 \/ /u }).waitFor();
        await page.getByRole('cell', { name: /^版 1 \/ /u }).waitFor();
        const revisedSnapshot = await pf.service.snapshot(pf.inquiryId);
        const [original, revision] = [...revisedSnapshot.estimates].sort((a,b) => a.revision_number-b.revision_number);
        assert.deepEqual([original.revision_number, revision.revision_number], [1, 2]);
        assert.equal(revisedSnapshot.state.current_estimate_revision_id, revision.id);
        assert.equal(original.delivery.state, 'sent');
        assert.equal(revision.delivery.state, 'sent');
        assert.equal(pf.state.sendCount, 2);
        const originalDocument = await pf.service.document(pf.inquiryId, original.document_id);
        const revisedDocument = await pf.service.document(pf.inquiryId, revision.document_id);
        assert.equal(originalDocument.filename, '見積書 現行画面.pdf');
        assert.equal(revisedDocument.filename, revisedFilename);
        assert.deepEqual(originalDocument.bytes, pf.quote);
        assert.deepEqual(revisedDocument.bytes, revisedPdf);
        console.log('PASS CASE DESK estimate revision preserves both sent rows and both PDF originals');
        const fp = await pf.service.confirmationPreview({ case_id: pf.inquiryId }, pf.actor);
        const issued = await pf.service.issueConfirmation({
            case_id: pf.inquiryId, preview_fingerprint: fp.fingerprint, operation_id: crypto.randomUUID()
        }, pf.actor);
        const sendModel = await pf.service.confirmationSendPreview({ case_id: pf.inquiryId, offer_id: issued.id }, pf.actor);
        assert.equal((await pf.service.dispatch({
            case_id: pf.inquiryId, offer_id: issued.id, job_id: issued.outbox_id, preview_fingerprint: sendModel.fingerprint
        }, pf.actor)).state, 'sent');
        const { rows: [approved] } = await pf.db.query('select snapshot_sha256 from pa_contract_offers where id=$1', [issued.id]);
        const { rows: [outbound] } = await pf.db.query('select secret_envelope from pa_commercial_outbox where id=$1', [issued.outbox_id]);
        assert.equal((await pf.contract.accept({
            token: decryptSecret(outbound.secret_envelope).split('#')[1], offer_id: issued.id,
            snapshot_sha256: approved.snapshot_sha256, confirmer_name: '隔離の承認者', agree: true
        })).state, 'accepted');
        const snapshot = await pf.service.snapshot(pf.inquiryId);
        await pf.service.settle({
            case_id: pf.inquiryId, expected_revision: snapshot.state.revision, operation_id: crypto.randomUUID(),
            amount_minor: 110000, unresolved_changes: false, evidence: { source: 'synthetic event completed' }
        }, pf.actor);
        await openDesk(pf, true);
        const sendInvoice = await reviewPdf(true, pf.quote, '請求書 現行画面.pdf');
        const beforeInvoiceSend = pf.state.sendCount;
        await sendInvoice.click();
        await page.getByText('請求書PDF・送信済み').waitFor();
        assert.equal(pf.state.sendCount, beforeInvoiceSend + 1);
        const { rows: [invoiceDocument] } = await pf.db.query(
            "select original_filename,sha256 from pa_commercial_documents where inquiry_id=$1 and document_kind='invoice'", [pf.inquiryId]
        );
        assert.equal(invoiceDocument.original_filename, '請求書 現行画面.pdf');
        assert.equal(invoiceDocument.sha256, sha(pf.quote));
        const mime = Buffer.from(pf.state.lastRaw.raw, 'base64url').toString('utf8');
        const invoiceAttachment = mime.split(/Content-Type: application\/pdf/iu)[1];
        const invoiceData = invoiceAttachment.split(/\r?\n\r?\n/u)[1].split(/\r?\n--/u)[0];
        assert.deepEqual(Buffer.from(invoiceData.replace(/\s/gu, ''), 'base64'), pf.quote);
        assert.equal(context.pages().length, 1);

        const persistedService = pf.service;
        const firstReviewRead = apiActions.length;
        pf.service = { ...persistedService, snapshot: async (...args) => {
            const model = await persistedService.snapshot(...args);
            const billings = model.billings.map(billing => ({
                ...billing, invoice_delivery_state: 'queued', invoice_requires_reconciliation: true
            }));
            return { ...model, billings };
        } };
        await openDesk(pf, true);
        await page.getByText('請求書PDF・送信結果要確認').waitFor();
        await page.getByText('再送せず、Gmail送信済みと配送記録を照合してください。', { exact: true }).waitFor();
        assert.equal(await page.getByText('請求書PDF・送信結果要確認').count(), 1);
        assert.equal(await page.getByText('請求書PDF・配送状況は操作欄で確認', { exact: true }).count(), 1);
        assert.equal(await page.getByText('請求書PDF・送信待ち').count(), 0);
        assert.equal(await page.getByRole('button', { name: '案件完了を確認', exact: true }).count(), 0);
        assert.equal(await page.getByRole('button', { name: '請求書PDFを送る', exact: true }).count(), 0);
        assert.deepEqual([...new Set(apiActions.slice(firstReviewRead))], ['snapshot']);
        assert.equal(pf.state.sendCount, beforeInvoiceSend + 1);
        console.log('PASS CASE DESK invoice reconciliation display without resend or close');
        pf.service = persistedService;
        await openDesk(pf, true);
        await page.getByRole('button', { name: '案件完了を確認', exact: true }).click();
        const closeInvoice = page.getByRole('dialog', { name: '入金確認と案件完了', exact: true });
        await closeInvoice.getByRole('button', { name: '金額を表示・入力' }).click();
        await closeInvoice.getByLabel('追加入金確認日').fill('2026-11-12');
        await closeInvoice.getByLabel('確認メモ').fill('隔離案件の請求書に対する入金を確認');
        await closeInvoice.getByRole('button', { name: '全条件を確認して完了' }).click();
        await page.waitForFunction(() => document.getElementById('head-state')?.textContent === '入金確認済みで完了');
        await page.getByText('入金記録に基づく完了', { exact: true }).waitFor();
        assert.equal((await pf.db.query('select count(*)::int n from pa_payment_records where inquiry_id=$1', [pf.inquiryId])).rows[0].n, 1);
        assert.equal(pf.state.sendCount, beforeInvoiceSend + 1);
        console.log('PASS CASE DESK estimate and separate invoice PDFs, byte identity on delivery, payment and close');

        unknownFixture = await setup();
        unknownFixture.state.transport = 'uncertain';
        await openDesk(unknownFixture, false);
        const sendUnknown = await reviewPdf(false, unknownFixture.quote, '送信結果照合テスト.pdf');
        await sendUnknown.click();
        await page.getByText('見積の処理結果を確認できません。状態を再取得して履歴を確認してください。', { exact: true }).waitFor();
        assert.equal(unknownFixture.state.sendCount, 1);
        assert.equal((await unknownFixture.db.query("select state from pa_commercial_outbox where job_kind='estimate'")).rows[0].state, 'unknown');
        await openDesk(unknownFixture, false);
        await page.getByText('送信結果を照合してから、正式受注確認を準備してください。', { exact: true }).waitFor();
        assert.equal(await page.getByRole('button', { name: '見積書PDFを送る', exact: true }).count(), 0);
        assert.equal(unknownFixture.state.sendCount, 1);
        console.log('PASS CASE DESK lost Gmail response stays UNKNOWN on reload and cannot resend');
        const result = { pass: true, widths: [1366, 940, 390], zoom: '200%', unchecked_disabled: true, checked_enabled: true, final_dialog_open: true, preview_open_mutation: 0, preview_refresh_mutation: 0, final_dialog_mutation: 0, escape_close: true, back_close: true, focus_return: true, rerender_binding: true, refresh_binding: true, double_click_singleton: true, visible_error: true, issue_without_dispatch: true, desk_same_tab: true, desk_switch_cancels_confirmation: true, issued_preview: true, unknown_replacement_blocked: true, atomic_replacement_dialog: true, atomic_replacement_prepared_without_send: true, active_token_count: 1, desk_pdf_delivery: true, desk_estimate_revision_originals: true, desk_prepayment_partial_and_correction: true, preview_payload_guard: true, desk_separate_invoice_close: true, unknown_pdf_send_no_retry: true, real_issue: 0, real_email: 0 };
        fs.writeFileSync(path.join(out, 'pa-est-006-browser-results.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
    } finally {
        if (browser) await browser.close();
        if (server) await new Promise((resolve) => server.close(resolve));
        for (const instance of [fixture, billingFixture, pdfFixture, unknownFixture]) await instance?.db.close();
    }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
