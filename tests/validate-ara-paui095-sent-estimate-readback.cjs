'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');

async function run() {
  const { A, B, values, pdf } = await import('./paui027-fixture.mjs');
  const root = path.resolve(__dirname, '..');
  const server = http.createServer((request, response) => {
    const file = path.join(root, new URL(request.url, 'http://localhost').pathname);
    if (!file.startsWith(root + path.sep)) return response.writeHead(403).end();
    try {
      response.setHeader('Content-Type', file.endsWith('.mjs') ? 'text/javascript' :
        file.endsWith('.css') ? 'text/css' : 'text/html');
      response.end(fs.readFileSync(file));
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    const env = process.platform === 'linux' ? { ...process.env, LC_ALL: 'C.UTF-8' } : process.env;
    browser = await chromium.launch({ env });
    const host = 'http://127.0.0.1:' + server.address().port;
    const originalPath = '/data/sent-estimate-attachment/' + A + '/quote/quote1';
    for (const mobile of [false, true]) {
      const page = await browser.newPage({
        viewport: { width: mobile ? 390 : 1440, height: 900 },
        isMobile: mobile,
        hasTouch: mobile
      });
      const errors = [];
      const unintendedRequests = [];
      let originalReads = 0;
      let releaseCommercial;
      const commercial = new Promise(resolve => { releaseCommercial = resolve; });
      page.on('pageerror', error => errors.push(error.message));
      await page.route(/^https?:\/\/(?!127\.0\.0\.1:)/, route => route.abort());
      await page.route('**/pa-ui/js/integration.mjs', route => route.fulfill({
        contentType: 'text/javascript',
        body: `
          const owner = { user: { id: 'fixture-owner' }, access_token: 'fixture-only', expires_at: 9999999999 };
          export const workspaceAuth = {
            restore: async () => owner, current: async () => owner, subscribe: () => {}, logout: async () => {}
          };
          export const readUrl = key => '/api/pa-workspace-read?path=' + encodeURIComponent(key);
          export const legacyUrl = () => { throw Error('legacy was opened'); };
        `
      }));
      await page.route('**/api/**', async route => {
        const request = route.request();
        const url = new URL(request.url());
        if (request.method() !== 'GET' || url.pathname !== '/api/pa-workspace-read') {
          unintendedRequests.push({ method: request.method(), path: url.pathname });
          return route.abort();
        }
        const name = url.searchParams.get('path');
        if (name === '/data/commercial/' + A) {
          await commercial;
          if (mobile) return route.fulfill({ status: 503, json: { ok: false } });
        }
        if (name === originalPath) {
          ++originalReads;
          return route.fulfill({ contentType: 'application/pdf', body: pdf() });
        }
        return route.fulfill({ json: { ok: true, result: values[name] ?? [] } });
      });
      try {
        await page.goto(host + '/pa-admin.html?mail-view=readonly');
        await page.locator('[data-case="' + A + '"]').click();
        await page.locator('[data-tab="estimate"]').click();
        await page.getByText('商務・原本を取得中…', { exact: true }).waitFor();
        await page.getByRole('button', { name: '見積書_Gmail.pdf の拡大プレビュー', exact: true }).click();
        const preview = page.locator('dialog[open].pa-material-preview-dialog');
        await preview.getByRole('button', { name: '次のページ', exact: true }).click();
        await preview.locator('canvas[aria-label="PDF 2ページ"]').waitFor();
        const focus = preview.getByRole('button', { name: '次のページ', exact: true });
        assert(await focus.evaluate(element => element === document.activeElement));

        releaseCommercial();
        if (mobile) {
          await page.locator('#estimate-commercial .read-error').filter({ hasText: '商務・原本 読取に失敗しました' }).waitFor();
        } else {
          await page.locator('#estimate-commercial').getByText('正式確認の履歴', { exact: true }).waitFor();
        }
        assert(await preview.isVisible(), 'Independent commercial read closed the Gmail-original preview');
        assert(await focus.evaluate(element => element === document.activeElement), 'Preview focus was lost');
        assert(await preview.locator('canvas[aria-label="PDF 2ページ"]').isVisible());
        const download = page.waitForEvent('download');
        await preview.getByRole('link', { name: '原本をダウンロード', exact: true }).click();
        const savedFile = await download;
        assert.equal(savedFile.suggestedFilename(), '見積書_Gmail.pdf');
        assert.deepEqual(fs.readFileSync(await savedFile.path()), Buffer.from(pdf()));
        assert.equal(originalReads, 1, 'Independent read must not refetch the selected Gmail original');

        await preview.getByRole('button', { name: '閉じる', exact: true }).click();
        await page.locator('[data-case="' + B + '"]').click();
        await page.locator('[data-tab="estimate"]').click();
        await page.getByText('保存済み見積なし', { exact: true }).waitFor();
        assert.equal(await page.getByRole('button', { name: '見積書_Gmail.pdf の拡大プレビュー' }).count(), 0);
        assert.deepEqual(unintendedRequests, []);
        assert.deepEqual(errors, []);
        console.log('PASS sent estimate preview and original remain bound after independent commercial ' +
          (mobile ? 'failure (390px touch)' : 'success (1440px)'));
      } finally {
        releaseCommercial();
        await page.close();
      }
    }
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
