import { chromium } from 'file:///C:/Users/user/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PDFDocument } from 'pdf-lib';

const base = process.env.PA_EST_004_REAL_BASE || 'http://127.0.0.1:8766';
const out = process.env.PA_EST_004_SCREENSHOT_DIR || 'C:/Users/user/Documents/Codex/2026-09-13/model-gpt-5-6-sol-reasoning/outputs';
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', args: ['--disable-extensions','--no-first-run'] });
const errors = [];
const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
page.on('request', request => {
  const url = request.url();
  if (!url.startsWith(base) && !url.startsWith('blob:') && !url.startsWith('data:')) errors.push(`external request: ${url}`);
});

await page.goto(`${base}/pa-est-004-real-admin-preview.html`, { waitUntil: 'networkidle' });
assert.equal((await page.request.get(`${base}/.env`)).status(), 404, 'local harness serves only an explicit static allow-list');
await page.locator('#pa-commercial-workspace:not(.hidden)').waitFor();
assert.match(await page.locator('#local-fixture-banner').textContent(), /Production DB \/ Storage \/ Gmailへ接続しません/);
assert.equal(await page.locator('.pa-commercial-card').count(), 3);
assert.match(await page.locator('#pa-contract-v5-summary').textContent(), /回答待ち/);
assert.equal(await page.getByRole('button', { name: '正式受注確認を送る' }).count(), 0, 'pending state cannot issue another confirmation');
assert.equal(await page.getByRole('button', { name: '同じ確認を再案内' }).count(), 1);
await page.locator('#pa-v5-reply').click();
await page.locator('#gmail-reply-cc').fill('venue@example.invalid');
await page.locator('#gmail-reply-body').fill('実管理画面Composerの保持確認');
await page.locator('[data-gmail-composer-mode="estimate_submission"]').click();
await page.locator('[data-gmail-composer-mode="invoice"]').click();
await page.locator('[data-gmail-composer-mode="confirmation"]').click();
assert.equal(await page.locator('#gmail-reply-cc').inputValue(), 'venue@example.invalid');
assert.equal(await page.locator('#gmail-reply-body').inputValue(), '実管理画面Composerの保持確認');
await page.locator('#preview-gmail-reply').click();
await page.locator('#gmail-reply-preview:not(.hidden)').waitFor();
assert.equal(await page.locator('#gmail-reply-preview-cc').textContent(), 'venue@example.invalid');
await page.locator('.pa-commercial-file img').waitFor();
assert.equal(await page.locator('.pa-commercial-file img').evaluate(image => image.naturalWidth > 0), true, 'real raster fixture rendered');
const popupPromise = page.waitForEvent('popup');
await page.locator('.pa-commercial-file').first().click();
const popup = await popupPromise; await popup.close();

await page.getByRole('button', { name: '同じ確認を再案内' }).click();
await page.waitForTimeout(300);
let snapshot = await (await page.request.get(`${base}/__fixture/snapshot`)).json();
assert.equal(snapshot.offers.filter(item => item.state === 'active').length, 1);
assert.equal(snapshot.outbox.filter(item => item.job_kind === 'confirmation_reminder' && item.state === 'sent').length, 1);

await page.getByRole('button', { name: '送信済みメールから登録' }).click();
await page.locator('dialog[open] select[name="mode"]').selectOption('historical');
await page.locator('dialog[open] input[name="amount"]').fill('110000');
await page.locator('dialog[open] textarea[name="conditions"]').fill('送信済み原本を所有者が照合');
await page.locator('dialog[open] button[type="submit"]').click();
await page.waitForTimeout(300);
snapshot = await (await page.request.get(`${base}/__fixture/snapshot`)).json();
assert.equal(snapshot.estimate_delivery_evidence.length, 1);
assert.equal(snapshot.offers.filter(item => item.state === 'active').length, 1, 'historical recovery preserves active confirmation');
await page.screenshot({ path: `${out}/PA-EST-004R1-real-admin-pending.png`, fullPage: true });

await page.locator('#real-scenario').selectOption('accepted');
await page.getByRole('button', { name: '受注後の変更提案' }).waitFor();
await page.getByRole('button', { name: '受注後の変更提案' }).click();
const changeDialog = page.locator('dialog[open]');
await changeDialog.locator('input[name="amount"]').fill('15000');
await changeDialog.locator('textarea[name="conditions"]').fill('オペレーター追加1名');
const changePdf = await PDFDocument.create();
changePdf.addPage([320, 200]);
await changeDialog.locator('input[name="file"]').setInputFiles({ name: 'change-proposal-fixture.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await changePdf.save()) });
await changeDialog.locator('button[type="submit"]').click();
await page.getByRole('button', { name: '変更合意を記録' }).waitFor();
await page.getByRole('button', { name: '変更合意を記録' }).click();
const agreementDialog = page.locator('dialog[open]');
await agreementDialog.locator('input[name="reference"]').fill('gmail:r1-owner-fixture-accept');
await agreementDialog.locator('button[type="submit"]').click();
await page.locator('#pa-billing-tab').click();
await page.getByRole('button', { name: '前払いを記録' }).click();
const prepaymentDialog = page.locator('dialog[open]');
await prepaymentDialog.locator('input[name="date"]').fill('2026-10-10');
await prepaymentDialog.locator('input[name="amount"]').fill('126000');
await prepaymentDialog.locator('textarea[name="memo"]').fill('銀行画面で前払いを確認');
await prepaymentDialog.locator('button[type="submit"]').click();
await page.getByRole('button', { name: '前払いを訂正' }).click();
const prepaymentCorrectionDialog = page.locator('dialog[open]');
await prepaymentCorrectionDialog.locator('input[name="delta"]').fill('-1000');
await prepaymentCorrectionDialog.locator('textarea[name="reason"]').fill('前払いの誤登録を追記訂正');
await prepaymentCorrectionDialog.locator('button[type="submit"]').click();
await page.getByRole('button', { name: '実施・精算を確認' }).click();
const settlementDialog = page.locator('dialog[open]');
await settlementDialog.locator('input[name="amount"]').fill('125000');
await settlementDialog.locator('textarea[name="evidence"]').fill('変更合意を含む実施・精算確認');
await settlementDialog.locator('button[type="submit"]').click();
await page.getByRole('button', { name: '既存書類で請求管理' }).waitFor();
const dialogHandler = async dialog => dialog.accept(dialog.type() === 'prompt' ? '2026-11-30' : undefined);
page.on('dialog', dialogHandler);
await page.getByRole('button', { name: '既存書類で請求管理' }).click();
await page.waitForTimeout(300);
page.off('dialog', dialogHandler);
snapshot = await (await page.request.get(`${base}/__fixture/snapshot`)).json();
assert.equal(snapshot.change_orders[0].state, 'agreed');
assert.equal(snapshot.billings[0].amount_minor, 125000, 'only agreed change is reflected in billing amount');
assert.equal(snapshot.payments[0].billing_id, snapshot.billings[0].id, 'prepayment is bound to the later billing');
assert.equal(snapshot.payments.reduce((sum, item) => sum + Number(item.amount_minor), 0) + snapshot.adjustments.reduce((sum, item) => sum + Number(item.delta_minor), 0), 125000);

await page.locator('#real-scenario').selectOption('partial');
await page.waitForFunction(() => document.getElementById('pa-billing-summary')?.textContent.includes('50,000'));
await page.locator('#pa-billing-tab').click();
await page.getByRole('button', { name: '入金を記録' }).waitFor();
assert.match(await page.locator('#pa-billing-summary').textContent(), /￥50,000/);
snapshot = await (await page.request.get(`${base}/__fixture/snapshot`)).json();
assert.equal(snapshot.billings[0].state, 'open');
assert.equal(snapshot.payments.reduce((sum, item) => sum + Number(item.amount_minor), 0), 50000);
assert.equal(snapshot.state.closed_operation_id, null);
fs.writeFileSync(`${out}/PA-EST-004R1-db-readback-initial.json`, JSON.stringify({
  fixture: 'LOCAL_PGLITE_ONLY', phase: 'PARTIAL_INITIAL', case_id: snapshot.state.inquiry_id,
  case_status: snapshot.case_status, billing_state: snapshot.billings[0].state,
  billing_amount_minor: snapshot.billings[0].amount_minor, confirmed_payment_minor: 50000,
  remaining_minor: 60000, closed_operation_recorded: false,
  production_connected: false, gmail_connected: false
}, null, 2));
await page.screenshot({ path: `${out}/PA-EST-004R1-real-admin-partial-initial.png`, fullPage: true });
await page.getByRole('button', { name: '誤登録を訂正' }).click();
const correctionDialog = page.locator('dialog[open]');
await correctionDialog.locator('input[name="delta"]').fill('-1000');
await correctionDialog.locator('textarea[name="reason"]').fill('ローカルfixtureの誤登録訂正');
await correctionDialog.locator('button[type="submit"]').click();
await page.waitForTimeout(250);
assert.match(await page.locator('#pa-billing-summary').textContent(), /￥49,000/);
await page.getByRole('button', { name: '案件完了を確認' }).click();
const closeDialog = page.locator('dialog[open]');
await closeDialog.locator('input[name="date"]').fill('2026-10-22');
await closeDialog.locator('input[name="amount"]').fill('61000');
await closeDialog.locator('textarea[name="memo"]').fill('銀行画面で残額入金、業務・精算完了を確認');
await closeDialog.locator('button[type="submit"]').click();
await page.waitForTimeout(300);
snapshot = await (await page.request.get(`${base}/__fixture/snapshot`)).json();
assert.equal(snapshot.billings[0].state, 'paid');
assert.equal(snapshot.payments.reduce((sum, item) => sum + Number(item.amount_minor), 0), 111000);
assert.equal(snapshot.adjustments.reduce((sum, item) => sum + Number(item.delta_minor), 0), -1000);
assert.equal(snapshot.state.closed_operation_id != null, true);
assert.equal(await page.getByRole('button', { name: '入金記録を見る' }).count(), 1);
fs.writeFileSync(`${out}/PA-EST-004R1-db-readback-after.json`, JSON.stringify({
  fixture: 'LOCAL_PGLITE_ONLY', phase: 'AFTER_CORRECTION_AND_CLOSE', case_id: snapshot.state.inquiry_id, revision: snapshot.state.revision,
  fulfillment_state: snapshot.state.fulfillment_state, settlement_state: snapshot.state.settlement_state,
  closed_operation_recorded: Boolean(snapshot.state.closed_operation_id), billing_state: snapshot.billings[0].state,
  billing_amount_minor: snapshot.billings[0].amount_minor,
  payments: snapshot.payments.map(item => ({ payment_date: item.payment_date, amount_minor: item.amount_minor, recorded_only: item.recorded_only })),
  adjustments: snapshot.adjustments.map(item => ({ delta_minor: item.delta_minor, reason: item.reason })),
  production_connected: false, gmail_connected: false
}, null, 2));
await page.screenshot({ path: `${out}/PA-EST-004R1-real-admin-closed.png`, fullPage: true });

await page.request.post(`${base}/__fixture/scenario`, { data: { scenario: 'pending' } });
const layoutEvidence = [];
for (const layout of [
  { name: '1366x650', width: 1366, height: 650 },
  { name: '940x950', width: 940, height: 950 },
  { name: '390x844', width: 390, height: 844 },
  { name: '200pct-equivalent', width: 683, height: 325 }
]) {
  const auditPage = await browser.newPage({ viewport: { width: layout.width, height: layout.height } });
  auditPage.on('pageerror', error => errors.push(error.message));
  await auditPage.goto(`${base}/pa-est-004-real-admin-preview.html`, { waitUntil: 'networkidle' });
  await auditPage.locator('#pa-commercial-workspace:not(.hidden)').waitFor();
  await auditPage.evaluate(() => {
    const anchor = window.matchMedia('(max-width: 720px)').matches
      ? document.querySelector('.pa-commercial-card--status')
      : document.getElementById('pa-commercial-workspace');
    anchor.scrollIntoView({ block: 'start' });
  });
  const metrics = await auditPage.evaluate(() => {
    const workspace = document.getElementById('pa-commercial-workspace').getBoundingClientRect();
    const anchor = (window.matchMedia('(max-width: 720px)').matches ? document.querySelector('.pa-commercial-card--status') : document.getElementById('pa-commercial-workspace')).getBoundingClientRect();
    const firstFile = document.querySelector('.pa-commercial-file')?.getBoundingClientRect();
    const search = document.querySelector('.pa-commercial__file-toolbar')?.getBoundingClientRect();
    return { workspace_top: Math.round(workspace.top), anchor_top: Math.round(anchor.top), first_file_top: firstFile ? Math.round(firstFile.top) : null, file_toolbar_top: search ? Math.round(search.top) : null };
  });
  layoutEvidence.push({ ...layout, ...metrics, first_file_in_initial_view: metrics.first_file_top != null && metrics.first_file_top >= 0 && metrics.first_file_top < layout.height });
  await auditPage.screenshot({ path: `${out}/PA-EST-004R1-real-admin-initial-${layout.name}.png`, fullPage: false });
  if (layout.name === '390x844') await auditPage.screenshot({ path: `${out}/PA-EST-004R1-real-admin-mobile.png`, fullPage: true });
  await auditPage.close();
}
fs.writeFileSync(`${out}/PA-EST-004R1-layout-readback.json`, JSON.stringify({ fixture: 'LOCAL_BROWSER_ONLY', measurements: layoutEvidence }, null, 2));

assert.deepEqual(errors, []);
await browser.close();
console.log('PASS PA-EST-004R1 real admin browser: actual component/handler/PGlite, pending/reminder/recovery, corrected prepayment bind, change billing, partial-to-close, mobile, no external requests');
