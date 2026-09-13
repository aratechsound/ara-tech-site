import { chromium } from 'file:///C:/Users/user/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const base = process.env.PA_EST_004_REAL_BASE || 'http://127.0.0.1:8771';
const out = process.env.PA_EST_004_SCREENSHOT_DIR || 'C:/Users/user/Documents/Codex/2026-09-13/model-gpt-5-6-sol-reasoning/outputs';
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', args: ['--disable-extensions', '--no-first-run'] });
const failures = [];
const measurements = [];

for (const layout of [
  { name: '1366', width: 1366, height: 650 },
  { name: '940', width: 940, height: 950 },
  { name: '390', width: 390, height: 844 },
  { name: 'zoom-200', width: 683, height: 325 }
]) {
  const page = await browser.newPage({ viewport: { width: layout.width, height: layout.height } });
  page.on('pageerror', error => failures.push(`${layout.name}: ${error.message}`));
  page.on('console', message => { if (message.type() === 'error') failures.push(`${layout.name}: ${message.text()}`); });
  page.on('request', request => { if (!request.url().startsWith(base) && !request.url().startsWith('blob:') && !request.url().startsWith('data:')) failures.push(`${layout.name}: external ${request.url()}`); });
  await page.goto(`${base}/pa-est-004-real-admin-preview.html`, { waitUntil: 'networkidle' });
  await page.locator('#pa-commercial-workspace:not(.hidden)').waitFor();
  await page.locator('.pa-commercial-file canvas').first().waitFor();
  assert.equal(await page.locator('.pa-commercial-card').count(), 3);
  assert.equal(await page.locator('.pa-commercial-file').count(), 20);
  assert.equal(await page.locator('.pa-commercial-file iframe, .pa-commercial-file img').count(), 0, 'thumbnails do not depend on CSP-blocked blob frames/images');
  assert.equal(await page.locator('.pa-contract-history-older').isHidden(), true);
  const metrics = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.pa-commercial-card')].map(node => node.getBoundingClientRect());
    const files = document.querySelector('.pa-commercial__files').getBoundingClientRect();
    const communication = document.querySelector('#communication-section').getBoundingClientRect();
    const strip = document.querySelector('#pa-related-files');
    return {
      cardTops: cards.map(box => Math.round(box.top)),
      formalHeight: Math.round(cards[1].height),
      cardBottom: Math.round(Math.max(...cards.map(box => box.bottom))),
      filesTop: Math.round(files.top), communicationTop: Math.round(communication.top),
      pageOverflow: Math.round(document.documentElement.scrollWidth - window.innerWidth),
      stripScrollable: strip.scrollWidth > strip.clientWidth
    };
  });
  assert.equal(metrics.pageOverflow <= 1, true);
  assert.equal(metrics.cardBottom <= metrics.filesTop + 1, true);
  assert.equal(metrics.filesTop < metrics.communicationTop, true);
  assert.equal(metrics.stripScrollable, true);
  assert.equal(metrics.formalHeight < 420, true, `formal card compact at ${layout.name}`);
  measurements.push({ ...layout, ...metrics });
  await page.locator('#pa-commercial-workspace').evaluate(node => node.scrollIntoView({ block: 'start' }));
  await page.screenshot({ path: `${out}/PA-EST-004R11B-${layout.name}.png`, fullPage: false });
  await page.close();
}

const page = await browser.newPage({ viewport: { width: 1366, height: 760 } });
await page.goto(`${base}/pa-est-004-real-admin-preview.html`, { waitUntil: 'networkidle' });
const pdfCard = page.locator('.pa-commercial-file[title$="を開く"]').filter({ hasText: '実管理画面-fixture-estimate.pdf' });
await pdfCard.scrollIntoViewIfNeeded();
await pdfCard.locator('canvas').waitFor();
await pdfCard.click();
const dialog = page.locator('#pa-material-preview-dialog[open]');
await dialog.locator('canvas').first().waitFor();
assert.match(await dialog.getByRole('heading').textContent(), /実管理画面-fixture-estimate\.pdf/u);
await dialog.getByRole('button', { name: '閉じる' }).click();

const imageCard = page.locator('.pa-commercial-file').filter({ hasText: '会場配置-fixture.png' });
await imageCard.scrollIntoViewIfNeeded();
await imageCard.locator('canvas').waitFor();
await imageCard.click();
await dialog.locator('canvas').waitFor();
assert.match(await dialog.getByRole('heading').textContent(), /会場配置-fixture\.png/u);
await dialog.getByRole('button', { name: '閉じる' }).click();

const officeCard = page.locator('.pa-commercial-file[title="連絡表.xlsxを開く"]');
await officeCard.scrollIntoViewIfNeeded();
await officeCard.getByText('ダウンロードして確認').waitFor();
const downloadPromise = page.waitForEvent('download');
await officeCard.click();
const download = await downloadPromise;
assert.equal(download.suggestedFilename(), '連絡表.xlsx');
await dialog.getByRole('button', { name: '閉じる' }).click();

const failedCard = page.locator('.pa-commercial-file[title="fixture-18.pdfを開く"]');
await failedCard.scrollIntoViewIfNeeded();
await failedCard.getByText('プレビューを表示できません').waitFor();
assert.equal(await failedCard.locator('img, iframe').count(), 0);

await page.locator('#real-scenario').selectOption('revision');
await page.getByText('現在：未発行', { exact: true }).waitFor();
assert.match(await page.locator('#pa-contract-v5-summary').innerText(), /正式受注確認を送る/u);
await page.locator('#real-scenario').selectOption('accepted');
await page.getByText('現在：成立済み', { exact: true }).waitFor();
assert.match(await page.locator('#pa-contract-v5-summary').innerText(), /成立：/u);
await page.close();

assert.deepEqual(failures, []);
fs.writeFileSync(`${out}/PA-EST-004R11B-layout-readback.json`, JSON.stringify({ fixture: 'LOCAL_PGLITE_AND_FAKE_ASSETS_ONLY', production_connected: false, gmail_connected: false, measurements }, null, 2));
await browser.close();
console.log('PASS PA-EST-004R11B browser: compact card, PDF/image canvas previews, Office fallback, failure fallback, Japanese filename, four responsive viewports');
