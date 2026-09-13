import { chromium } from 'file:///C:/Users/user/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const base = process.env.PA_EST_004_REAL_BASE || 'http://127.0.0.1:8772';
const out = process.env.PA_EST_004_SCREENSHOT_DIR || 'C:/Users/user/Documents/Codex/2026-09-13/model-gpt-5-6-sol-reasoning/outputs';
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', args: ['--disable-extensions', '--no-first-run'] });
const errors = [];
const context = await browser.newContext({ viewport: { width: 1366, height: 720 }, timezoneId: 'Asia/Tokyo' });
const page = await context.newPage();
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
page.on('request', request => { if (!request.url().startsWith(base) && !request.url().startsWith('blob:') && !request.url().startsWith('data:')) errors.push(`external ${request.url()}`); });

const originalCaseId = '123e4567-e89b-42d3-a456-426614174000';
const waitReady = async () => {
  await page.locator('#pa-commercial-workspace:not(.hidden)').waitFor();
  await page.locator('#pa-v5-estimate:not([disabled])').waitFor();
};
const scenario = async value => {
  const response = page.waitForResponse(item => item.url().endsWith('/__fixture/scenario') && item.request().method() === 'POST');
  await page.locator('#real-scenario').selectOption(value);
  await response;
  const expected = { new: '見積未発行', pending: '見積 第1版', revision: '見積 第1版', recovered: '見積 第2版', accepted: '変更見積を作成', partial: '変更見積を作成' }[value];
  await page.waitForFunction(text => (document.getElementById('pa-estimate-summary')?.innerText || '').includes(text), expected);
  await waitReady();
};
const waitGuard = () => page.waitForTimeout(450);
const evidence = {};

await page.request.post(`${base}/__fixture/scenario`, { data: { scenario: 'revision' } });
await page.goto(`${base}/pa-est-004-real-admin-preview.html`, { waitUntil: 'networkidle' });
await waitReady();

// Current estimate, no accepted contract: both entries use the revision Composer.
const revisionButton = page.getByRole('button', { name: '改訂見積を準備', exact: true });
await revisionButton.click();
await page.locator('#gmail-reply-panel:not(.hidden)').waitFor();
assert.equal(await page.locator('#gmail-reply-panel').getAttribute('data-estimate-intent'), 'revision_estimate');
await waitGuard();
await page.locator('#pa-v5-estimate').click();
await waitGuard();
let actions = await page.evaluate(() => window.__paR11a.evidence.actions.slice());
assert.deepEqual(actions.slice(-2).map(item => item.intent), ['revision_estimate', 'revision_estimate']);
evidence.revisionRoutes = actions.slice(-2);

// In-flight guard: a double click opens the one existing Composer once.
const beforeDouble = await page.evaluate(() => window.__paR11a.evidence.openCount);
await page.locator('#pa-v5-estimate').dblclick();
await waitGuard();
const afterDouble = await page.evaluate(() => window.__paR11a.evidence.openCount);
assert.equal(afterDouble - beforeDouble, 1);
assert.equal(await page.locator('#gmail-reply-panel').count(), 1);
evidence.doubleClickOpenDelta = afterDouble - beforeDouble;

// Owner-visible failure and safe recovery.
await page.evaluate(() => window.__paR11a.setComposerFailure(true));
await page.locator('#pa-v5-estimate').click();
await page.getByText('見積作成画面を開けませんでした。もう一度お試しください。', { exact: true }).waitFor();
await waitGuard();
await page.evaluate(() => window.__paR11a.setComposerFailure(false));

// Explicit rerender and Gmail-sync-equivalent refresh retain working handlers.
for (const method of ['rerender', 'refresh']) {
  const before = await page.evaluate(() => window.__paR11a.evidence.openCount);
  await page.evaluate(name => window.__paR11a[name](), method);
  await waitReady();
  await page.getByRole('button', { name: '改訂見積を準備', exact: true }).click();
  await waitGuard();
  assert.equal(await page.evaluate(() => window.__paR11a.evidence.openCount), before + 1);
}
evidence.rerenderAndRefresh = 'PASS';

// Standard button keyboard behavior.
for (const key of ['Enter', 'Space']) {
  const before = await page.evaluate(() => window.__paR11a.evidence.openCount);
  await page.locator('#pa-v5-estimate').focus();
  await page.keyboard.press(key);
  await waitGuard();
  assert.equal(await page.evaluate(() => window.__paR11a.evidence.openCount), before + 1, key);
}
evidence.keyboard = 'Enter/Space PASS';

// Stale case identity is rejected before opening and does not leak into a new render.
const beforeStale = await page.evaluate(() => window.__paR11a.evidence.openCount);
await page.evaluate(() => window.__paR11a.setCaseIdentity('223e4567-e89b-42d3-a456-426614174000'));
await revisionButton.click();
await waitGuard();
assert.equal(await page.evaluate(() => window.__paR11a.evidence.openCount), beforeStale);
await page.evaluate(id => { window.__paR11a.setCaseIdentity(id); window.__paR11a.rerender(); }, originalCaseId);
await waitReady();
evidence.staleCase = 'REJECTED';

// An active pending confirmation is never revoked or bypassed merely by opening the estimate entry.
await scenario('pending');
const beforePending = await page.evaluate(() => window.__paR11a.evidence.openCount);
await page.getByRole('button', { name: '改訂見積を準備', exact: true }).click();
await page.getByText('旧確認が受付中です。先に「旧確認を無効にして改訂開始」を実行してください。画面を開いただけでは失効しません。', { exact: true }).waitFor();
await waitGuard();
assert.equal(await page.evaluate(() => window.__paR11a.evidence.openCount), beforePending);
assert.equal(await page.getByRole('button', { name: '旧確認を無効にして改訂開始', exact: true }).count(), 1);
evidence.activePending = 'BLOCKED_WITHOUT_REVOCATION';

// No estimate: both state authority and top action route to new estimate.
await scenario('new');
await page.getByRole('button', { name: '見積を作成', exact: true }).waitFor();
await page.locator('#pa-v5-estimate').click();
await waitGuard();
assert.equal(await page.locator('#gmail-reply-panel').getAttribute('data-estimate-intent'), 'new_estimate');
assert.doesNotMatch(await page.locator('#pa-estimate-summary').innerText(), /送信：/u);
evidence.newEstimate = 'PASS';

// Recovered estimate: Gmail source sent time wins; V5 registration stays secondary.
await scenario('recovered');
const recoveredText = await page.locator('#pa-estimate-summary').innerText();
assert.match(recoveredText, /見積 第2版・現在/u);
assert.match(recoveredText, /送信：2026\/09\/11 21:00/u);
assert.match(recoveredText, /V5登録：/u);
assert.doesNotMatch(recoveredText, /発行：/u);
const recoveredSnapshot = await (await page.request.get(`${base}/__fixture/snapshot`)).json();
const recoveredCurrent = recoveredSnapshot.estimates.find(item => item.id === recoveredSnapshot.state.current_estimate_revision_id);
assert.notEqual(Date.parse(recoveredCurrent.source_sent_at), Date.parse(recoveredCurrent.issued_at));
const history = page.locator('.pa-estimate-history');
await history.locator('summary').click();
assert.match(await history.innerText(), /第1版/u);
assert.match(await history.innerText(), /送信：/u);
evidence.timestamp = { sourceSentAt: recoveredCurrent.source_sent_at, registeredAt: recoveredCurrent.issued_at, rendered: '2026/09/11 21:00 JST' };

// Accepted contract: top and card both open the same existing change-order dialog, close, and reopen.
await scenario('accepted');
const changeButton = page.getByRole('button', { name: '変更見積を作成', exact: true });
await changeButton.waitFor();
await page.locator('#pa-v5-estimate').click();
let dialog = page.locator('dialog[open]');
await dialog.getByRole('heading', { name: '受注後の変更提案' }).waitFor();
assert.equal(await dialog.count(), 1);
await dialog.getByRole('button', { name: 'キャンセル' }).click();
await waitGuard();
await changeButton.click();
dialog = page.locator('dialog[open]');
await dialog.getByRole('heading', { name: '受注後の変更提案' }).waitFor();
assert.equal(await dialog.count(), 1);
await page.screenshot({ path: `${out}/PA-EST-004R11A-change-order-flow.png`, fullPage: false });
await dialog.getByRole('button', { name: 'キャンセル' }).click();
await waitGuard();
evidence.changeOrder = 'TOP_AND_CARD_SAME_DIALOG_CLOSE_REOPEN_PASS';

// 390px touch-size viewport remains operable.
await page.request.post(`${base}/__fixture/scenario`, { data: { scenario: 'revision' } });
const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'Asia/Tokyo', hasTouch: true, isMobile: true });
const mobile = await mobileContext.newPage();
await mobile.goto(`${base}/pa-est-004-real-admin-preview.html`, { waitUntil: 'networkidle' });
await mobile.locator('#pa-v5-estimate:not([disabled])').waitFor();
await mobile.getByRole('button', { name: '改訂見積を準備', exact: true }).tap();
await mobile.locator('#gmail-reply-panel:not(.hidden)').waitFor();
assert.equal(await mobile.locator('#gmail-reply-panel').getAttribute('data-estimate-intent'), 'revision_estimate');
await mobile.screenshot({ path: `${out}/PA-EST-004R11A-mobile-390.png`, fullPage: false });
await mobileContext.close();
evidence.mobile390 = 'PASS';

assert.deepEqual(errors, []);
fs.writeFileSync(`${out}/PA-EST-004R11A-browser-evidence.json`, JSON.stringify({ fixture: 'LOCAL_PGLITE_DB_API_FAKE_ADAPTER_ONLY', productionConnected: false, gmailConnected: false, evidence }, null, 2));
await context.close();
await browser.close();
console.log('PASS PA-EST-004R11A browser: timestamp authority, three routes, shared entry, feedback, guard, rerender, keyboard, stale case, close/reopen and mobile');
