import { chromium } from 'file:///C:/Users/user/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const base = process.env.PA_EST_004_REAL_BASE || 'http://127.0.0.1:8771';
const out = process.env.PA_EST_004_SCREENSHOT_DIR || 'C:/Users/user/Documents/Codex/2026-09-13/model-gpt-5-6-sol-reasoning/outputs';
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', args: ['--disable-extensions', '--no-first-run'] });
const errors = [];
const evidence = [];

const amountPage = await browser.newPage({ viewport: { width: 940, height: 950 } });
await amountPage.goto(`${base}/pa-est-004-real-admin-preview.html`, { waitUntil: 'networkidle' });
await amountPage.getByRole('button', { name: '送信済みメールから登録' }).click();
const recovery = amountPage.locator('dialog[open]');
await recovery.getByText('見積書 2026.09.11 龍姫湖まつり（改訂.pdf', { exact: true }).waitFor();
await recovery.getByText('￥198,550', { exact: true }).waitFor();
assert.match(await recovery.innerText(), /￥198,550/u);
assert.match(await recovery.innerText(), /PDFから自動取得/u);
assert.equal(await recovery.locator('textarea[name="conditions"]').count(), 0);
await amountPage.screenshot({ path: `${out}/PA-EST-004R11-amount-preview-198550.png`, fullPage: false });
await recovery.getByRole('button', { name: 'キャンセル' }).click();
await amountPage.close();

for (const layout of [
  { name: '1366x650', width: 1366, height: 650 },
  { name: '940x950', width: 940, height: 950 },
  { name: '390x844', width: 390, height: 844 },
  { name: '200pct-equivalent', width: 683, height: 325 }
]) {
  const page = await browser.newPage({ viewport: { width: layout.width, height: layout.height } });
  page.on('pageerror', error => errors.push(`${layout.name}: ${error.message}`));
  page.on('console', message => { if (message.type() === 'error') errors.push(`${layout.name}: ${message.text()}`); });
  page.on('request', request => { if (!request.url().startsWith(base) && !request.url().startsWith('blob:') && !request.url().startsWith('data:')) errors.push(`${layout.name}: external ${request.url()}`); });
  await page.goto(`${base}/pa-est-004-real-admin-preview.html`, { waitUntil: 'networkidle' });
  await page.locator('#pa-commercial-workspace:not(.hidden)').waitFor();
  await page.locator('.pa-commercial-file canvas').first().waitFor();

  assert.equal(await page.locator('.pa-commercial-card').count(), 3);
  assert.match(await page.locator('#pa-related-files-count').textContent(), /^20件/u);
  assert.equal(await page.locator('.pa-commercial-file').count(), 20);
  assert.equal(await page.locator('.pa-contract-history-older').isHidden(), true);
  assert.equal(await page.getByRole('button', { name: '過去の正式受注確認 4件を表示 ▸' }).count(), 1);
  const visibleText = await page.locator('#pa-commercial-workspace').innerText();
  for (const raw of ['not_confirmed', 'unsettled', 'queued', 'processing']) assert.equal(visibleText.includes(raw), false, `raw state ${raw}`);
  assert.doesNotMatch(visibleText, /送信状態\s*[:：]\s*sent\b/iu);
  assert.match(visibleText, /実施確認前/u);
  assert.match(visibleText, /精算確認前/u);

  const metrics = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.pa-commercial-card')].map(node => node.getBoundingClientRect());
    const files = document.querySelector('.pa-commercial__files').getBoundingClientRect();
    const communication = document.querySelector('#communication-section').getBoundingClientRect();
    const strip = document.querySelector('#pa-related-files');
    const image = document.querySelector('.pa-commercial-file canvas');
    return { cardTops: cards.map(box => Math.round(box.top)), cardBottom: Math.round(Math.max(...cards.map(box => box.bottom))), filesTop: Math.round(files.top), communicationTop: Math.round(communication.top),
      documentOverflow: document.documentElement.scrollWidth - window.innerWidth, stripScrollable: strip.scrollWidth > strip.clientWidth,
      imageReady: Boolean(image?.width), formalCardHeight: Math.round(cards[1]?.height || 0) };
  });
  assert.equal(metrics.documentOverflow <= 1, true, `${layout.name} has no page-level horizontal overflow`);
  assert.equal(metrics.stripScrollable, true, `${layout.name} keeps the 20-item strip scrollable`);
  assert.equal(metrics.imageReady, true, `${layout.name} renders a real image thumbnail`);
  assert.equal(metrics.cardBottom <= metrics.filesTop + 1, true, `${layout.name} keeps related materials below all three cards`);
  assert.equal(metrics.filesTop < metrics.communicationTop, true, `${layout.name} keeps communication below related materials`);
  assert.equal(metrics.formalCardHeight < 520, true, `${layout.name} formal card is naturally compact`);
  evidence.push({ ...layout, ...metrics });
  await page.locator('#pa-commercial-workspace').evaluate(node => node.scrollIntoView({ block: 'start' }));
  await page.screenshot({ path: `${out}/PA-EST-004R11-${layout.name}.png`, fullPage: false });
  if (layout.name === '390x844') await page.screenshot({ path: `${out}/PA-EST-004R11-390x844-full.png`, fullPage: true });
  await page.close();
}

const interaction = await browser.newPage({ viewport: { width: 1366, height: 650 } });
await interaction.goto(`${base}/pa-est-004-real-admin-preview.html`, { waitUntil: 'networkidle' });
const toggle = interaction.locator('.pa-contract-history-toggle');
await toggle.click();
assert.equal(await interaction.locator('.pa-contract-history-older').isVisible(), true);
assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
await toggle.click();
assert.equal(await interaction.locator('.pa-contract-history-older').isHidden(), true);
await interaction.close();

assert.deepEqual(errors, []);
fs.writeFileSync(`${out}/PA-EST-004R11-layout-readback.json`, JSON.stringify({ fixture: 'LOCAL_PGLITE_AND_FAKE_ASSETS_ONLY', production_connected: false, gmail_connected: false, measurements: evidence }, null, 2));
await browser.close();
console.log('PASS PA-EST-004R11 browser: 20 materials, real thumbnails, compact/collapsible confirmation, Japanese states and four responsive viewports');
