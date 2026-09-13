import { chromium } from 'file:///C:/Users/user/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const base = process.env.PA_EST_004_BASE || 'http://127.0.0.1:8765';
const out = process.env.PA_EST_004_SCREENSHOT_DIR || 'C:/Users/user/Documents/Codex/2026-09-13/model-gpt-5-6-sol-reasoning/outputs';
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', args: ['--disable-extensions','--no-first-run'] });
const errors = [];
async function assertNoExternal(page) {
  const urls = await page.evaluate(() => performance.getEntriesByType('resource').map(entry => entry.name));
  assert.equal(urls.filter(url => !url.startsWith(base) && !url.startsWith('blob:') && !url.startsWith('data:')).length, 0, `external resources: ${urls.join(', ')}`);
}
const desktop = await browser.newPage({ viewport: { width: 1366, height: 768 } });
desktop.on('pageerror', e => errors.push(e.message));
desktop.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
await desktop.goto(`${base}/pa-est-004-preview.html`, { waitUntil: 'networkidle' });
await desktop.locator('[data-pdf-thumbnail][data-rendered="true"]').waitFor();
await assertNoExternal(desktop);
assert.equal(await desktop.locator('.preview-card').count(), 3);
assert.equal(await desktop.getByRole('button', { name: '正式受注確認を発行' }).count(), 0);
assert.equal(await desktop.getByRole('button', { name: '同じ確認を再案内' }).count(), 1);
assert.equal(await desktop.locator('.fixture-raster').evaluate(image => image.naturalWidth > 0), true);
assert.equal(await desktop.locator('.preview-file').count(), 8);
assert.match(await desktop.locator('#file-count').textContent(), /20/);
assert.equal((await desktop.locator('.mail-item time').allTextContents())[0], '2026/10/28 16:42');
const cardBox = await desktop.locator('.preview-cards').boundingBox();
const fileBox = await desktop.locator('.preview-files').boundingBox();
const mailBox = await desktop.locator('.preview-mail').boundingBox();
assert(cardBox && fileBox && mailBox && cardBox.y < fileBox.y && fileBox.y < mailBox.y);

await desktop.locator('[data-open-composer="normal"]').first().click();
await desktop.locator('#composer-cc').fill('audit@example.invalid');
await desktop.locator('#composer-body').fill('保持される本文 fixture');
await desktop.locator('#composer-attachment').fill('fixture.pdf');
await desktop.locator('[data-composer-mode="estimate"]').click();
await desktop.locator('[data-composer-mode="confirmation"]').click();
assert.equal(await desktop.locator('#composer-cc').inputValue(), 'audit@example.invalid');
assert.equal(await desktop.locator('#composer-body').inputValue(), '保持される本文 fixture');
assert.equal(await desktop.locator('#composer-attachment').inputValue(), 'fixture.pdf');
assert.match(await desktop.locator('#composer-thread').inputValue(), /fixture-thread/);
await desktop.locator('#preview-send').click();
assert.equal(await desktop.locator('#confirm-dialog').getAttribute('open') !== null, true);
await desktop.locator('#confirm-dialog button[value="cancel"]').click();
assert.equal(await desktop.locator('#confirmation-badge').textContent(), 'お客様確認待ち');
await desktop.locator('#preview-send').click();
await desktop.locator('#confirm-action').click();
assert.equal(await desktop.locator('#confirmation-badge').textContent(), 'お客様確認待ち');

await desktop.selectOption('#scenario-select','pending');
await desktop.locator('[data-action="revise"]').click();
await desktop.locator('#confirm-action').click();
assert.match(await desktop.locator('#estimate-panel').textContent(), /v2/);
assert.equal(await desktop.locator('#confirmation-badge').textContent(), '失効済み');
await desktop.locator('#scenario-reset').click();
assert.equal(await desktop.locator('#confirmation-badge').textContent(), 'お客様確認待ち');

await desktop.selectOption('#scenario-select','partial');
await desktop.locator('#billing-tab').click();
assert.match(await desktop.locator('#billing-panel').textContent(), /￥220,000/);
await desktop.locator('[data-action="payment"]').first().click();
await desktop.locator('#payment-amount').fill('220000');
await desktop.locator('#payment-checked').check();
await desktop.locator('#close-case').click();
assert.match(await desktop.locator('#next-panel').textContent(), /案件完了/);
await desktop.selectOption('#scenario-select','completed');
await desktop.locator('#billing-tab').click();
assert.equal(await desktop.getByRole('button', { name: '入金記録を見る' }).count(), 1);
await desktop.locator('[data-pdf-thumbnail][data-rendered="true"]').waitFor();
await desktop.screenshot({ path: `${out}/PA-EST-004-desktop.png`, fullPage: true });

const compact = await browser.newPage({ viewport: { width: 940, height: 950 } });
compact.on('pageerror', e => errors.push(e.message));
await compact.goto(`${base}/pa-est-004-preview.html`, { waitUntil: 'networkidle' });
await assertNoExternal(compact);
assert.equal(await compact.locator('.preview-card').count(), 3);
await compact.locator('#open-library').click();
assert.equal(await compact.locator('#library-dialog').getAttribute('open') !== null, true);
await compact.locator('#library-dialog button[value="cancel"]').click();
await compact.screenshot({ path: `${out}/PA-EST-004R1-dedicated-940.png`, fullPage: true });

const zoomed = await browser.newPage({ viewport: { width: 683, height: 325 } });
zoomed.on('pageerror', e => errors.push(e.message));
await zoomed.goto(`${base}/pa-est-004-preview.html`, { waitUntil: 'networkidle' });
await zoomed.screenshot({ path: `${out}/PA-EST-004R1-dedicated-200pct.png`, fullPage: true });
// 683x325 CSS pixels represents a 1366x650 viewport at browser zoom 200%.
await zoomed.locator('[data-open-composer="normal"]').first().click();
assert.equal(await zoomed.locator('#composer-dialog').getAttribute('open') !== null, true);
await zoomed.locator('#composer-dialog button[value="cancel"]').click();

const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
mobile.on('pageerror', e => errors.push(e.message));
await mobile.goto(`${base}/pa-est-004-preview.html`, { waitUntil: 'networkidle' });
await assertNoExternal(mobile);
const order = await mobile.locator('.preview-card').evaluateAll(nodes => nodes.map(n => ({ text:n.querySelector('h2')?.textContent, top:n.getBoundingClientRect().top })).sort((a,b)=>a.top-b.top));
assert.equal(order[0].text, '現在の状況・次の対応');
await mobile.screenshot({ path: `${out}/PA-EST-004-mobile.png`, fullPage: true });
await mobile.screenshot({ path: `${out}/PA-EST-004R1-dedicated-mobile.png`, fullPage: true });
assert.deepEqual(errors, []);
await browser.close();
console.log('PASS PA-EST-004 owner preview: layout, files, newest-first mail, composer preservation, cancel/finalize, revision revoke, payment close, mobile priority, no external requests');
