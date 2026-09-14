import { chromium } from 'file:///C:/Users/user/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const base = process.env.PA_EST_004_REAL_BASE || 'http://127.0.0.1:8772';
const out = process.env.PA_EST_005A_OUTPUT_DIR || 'C:/Users/user/Documents/Codex/2026-09-13/model-gpt-5-6-sol-reasoning/outputs/PA-EST-005A-R1';
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', args: ['--disable-extensions', '--no-first-run'] });
const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
page.on('request', request => {
  const url = request.url();
  if (!url.startsWith(base) && !url.startsWith('blob:') && !url.startsWith('data:')) errors.push(`external request: ${url}`);
});

const card = page.locator('#pa-contract-v5-summary');
const scenario = async (value, expected) => {
  await page.locator('#real-scenario').selectOption(value);
  await page.waitForFunction(text => document.querySelector('#pa-contract-v5-summary')?.textContent.includes(text), expected);
};

try {
  await page.request.post(`${base}/__fixture/scenario`, { data: { scenario: 'pending' } });
  await page.goto(`${base}/pa-est-004-real-admin-preview.html`, { waitUntil: 'networkidle' });
  await card.waitFor();
  assert.match(await card.innerText(), /現在：回答待ち/);
  assert.equal(await card.getByRole('button', { name: '同じ確認を再案内' }).count(), 1);
  await page.screenshot({ path: `${out}/admin-confirmation-pending.png`, fullPage: true });

  await scenario('preissue', '現在：未発行');
  const preissue = await card.innerText();
  assert.match(preissue, /龍姫湖まつり2026（検証用）/);
  assert.match(preissue, /2026-10-18 10:00〜15:00/);
  assert.match(preissue, /テスト実行委員会.*管理下テスト担当者/s);
  assert.match(preissue, /支払期限.*2026-11-02/s);
  assert.match(preissue, /Gmail thread.*thread_123/s);
  assert.equal(await card.getByRole('button', { name: '正式受注確認を送る' }).count(), 1);
  await page.screenshot({ path: `${out}/admin-confirmation-preissue.png`, fullPage: true });

  await scenario('accepted', '現在：正式受注済み');
  assert.match(await card.innerText(), /確認メール.*送信済み/s);
  assert.equal(await card.getByRole('button', { name: '正式受注確認書PDF' }).count(), 1);
  assert.equal(await card.getByRole('button', { name: '見積PDF' }).count(), 1);
  assert.equal(await card.getByRole('button', { name: '実施準備へ' }).count(), 1);
  await page.screenshot({ path: `${out}/admin-confirmation-accepted.png`, fullPage: true });

  await scenario('accepted-mail-failed', '現在：正式受注済み');
  await page.waitForFunction(() => document.querySelector('#pa-contract-v5-summary')?.textContent.includes('送信失敗'));
  assert.equal(await card.getByRole('button', { name: '確認メールを再送' }).count(), 1);
  await page.screenshot({ path: `${out}/admin-confirmation-mail-failed.png`, fullPage: true });
  await card.getByRole('button', { name: '確認メールを再送' }).click();
  await page.waitForFunction(() => document.querySelector('#pa-contract-v5-summary')?.textContent.includes('送信済み'));
  assert.equal(await card.getByRole('button', { name: '確認メールを再送' }).count(), 0);
  const snapshot = await (await page.request.get(`${base}/__fixture/snapshot`)).json();
  const receiptJobs = snapshot.outbox.filter(item => item.job_kind === 'accept_receipt');
  assert.equal(receiptJobs.length, 1);
  assert.equal(receiptJobs[0].state, 'sent');
  await page.screenshot({ path: `${out}/admin-confirmation-mail-retried.png`, fullPage: true });

  assert.deepEqual(errors, []);
  const result = { pass: true, states: ['preissue', 'pending', 'accepted', 'accepted-mail-failed', 'accepted-mail-retried'], receipt_outbox_rows: 1, real_email_sent: false, production_changed: false };
  fs.writeFileSync(`${out}/pa-est-005a-admin-state-results.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
}
