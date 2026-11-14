const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const { createServer } = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '../..');
const fixture = `
import { createReviewedPublishPanel } from '/js/work-publish-panel.mjs';
const hash = 'a'.repeat(64);
let work = {
    id: 1, title: 'Hiroshima fixture', event_date: '2099-11-15', venue: 'Fixture Hall',
    area: '広島', performer_name: 'Fixture artist', lifecycle_status: 'upcoming',
    service_types: ['artist_pa_operation'], assignment_items: ['pa_operation'],
    official_announcement_url: 'https://example.test/event', candidate_hash: hash,
    is_published: false, publication_review_status: 'publication_pending_approval',
    use_image_on_public_page: false, image_usage_status: 'not_permitted', slug: 'hiroshima',
    description: '第1部 OPEN 14:30 START 15:00\\n第2部 OPEN 17:30 START 18:00'
};
window.rpcCount = 0;
const client = {
    auth: { getUser: async () => ({ data: { user: { id: 'admin' } } }) },
    from(table) {
        return {
            select() { return this; }, eq() { return this; },
            maybeSingle: async () => ({ data: { user_id: 'admin' } }),
            single: async () => ({ data: structuredClone(work) })
        };
    },
    async rpc(name, args) {
        window.rpcCount += 1;
        if (name !== 'publish_work_candidate' || args.p_work_id !== 1 || args.p_candidate_hash !== hash) throw Error('unexpected RPC');
        if (location.search.includes('unknown')) throw Error('transport lost');
        Object.assign(work, { is_published: true, approved_hash: hash, approved_by: 'admin', approved_at: 'now', publication_review_status: null });
        return { data: [{ result: 'published' }] };
    }
};
const panel = createReviewedPublishPanel({
    client, bucket: 'fixture', container: document.querySelector('section'),
    reload: async () => {}, canProceed: () => '', workUrl: slug => '/works/' + slug + '.html',
    prepareImage: async (_post, useImage) => {
        if (useImage) throw Error('unexpected image selection');
        return structuredClone(work);
    },
    readReviewImage: async () => { throw Error('isolated fixture cannot fetch image'); }
});
window.openFixture = (patch = {}) => panel.open({ ...work, ...patch });
`;

async function run() {
    const server = createServer(async (req, res) => {
        try {
            const url = new URL(req.url, 'http://localhost');
            if (url.pathname === '/') {
                const admin = await readFile(path.join(root, 'admin.html'), 'utf8');
                const css = admin.match(/<style>[\s\S]*?<\/style>/)[0];
                res.setHeader('Content-Type', 'text/html; charset=utf-8');
                res.end(`<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1">${css}<main><section id="reviewed-api-publication" class="card hidden"></section></main><script type="module">${fixture}</script>`);
            } else if (/^\/js\/work-[a-z-]+\.mjs$/.test(url.pathname)) {
                res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
                res.end(await readFile(path.join(root, url.pathname.slice(1))));
            } else {
                res.writeHead(404).end();
            }
        } catch {
            res.writeHead(500).end();
        }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    let browser;
    try {
        browser = await chromium.launch(process.env.WORKS_TEST_CHANNEL ? { channel: process.env.WORKS_TEST_CHANNEL } : {});
        const base = `http://127.0.0.1:${server.address().port}`;
        for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
            const page = await browser.newPage({ viewport });
            await page.route('**/*', route => route.request().url().startsWith(base + '/') ? route.continue() : route.abort());
            await page.goto(base);
            await page.waitForFunction(() => Boolean(window.openFixture));
            const stage = text => page.getByRole('heading', { name: new RegExp(text) }).waitFor();
            const click = name => page.getByRole('button', { name, exact: true }).click();
            const quoteCount = () => page.evaluate(() => window.rpcCount);

            await page.evaluate(() => window.openFixture({ venue: '' }));
            await click('次へ');
            await page.getByRole('status').filter({ hasText: '不足項目　会場' }).waitFor();
            await stage('STEP 1');

            await page.evaluate(() => window.openFixture({ review_image_url: 'https://example.test/image' }));
            await click('次へ');
            await stage('STEP 2');
            await page.getByText('画像確認エラー', { exact: false }).waitFor();
            assert.equal(await page.getByRole('button', { name: '次へ' }).isDisabled(), true);
            await click('戻る');
            await stage('STEP 1');
            await click('次へ');
            await click('画像なしで進む');
            await stage('STEP 3');
            await page.getByText('第2部 OPEN 17:30 START 18:00', { exact: false }).waitFor();
            await click('次へ');
            await stage('STEP 4');
            assert.equal(await quoteCount(), 0);
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
            await click('この公演を正式公開');
            await stage('STEP 5');
            const url = await page.getByRole('link', { name: '公開ページを見る' }).getAttribute('href');
            assert.equal(url, '/works/hiroshima.html');
            assert.equal(await quoteCount(), 1);
            await page.close();
        }

        const page = await browser.newPage();
        await page.goto(base + '/?unknown');
        await page.waitForFunction(() => Boolean(window.openFixture));
        const openFinal = async () => {
            await page.evaluate(() => window.openFixture());
            await page.getByRole('button', { name: '次へ', exact: true }).click();
            await page.getByRole('button', { name: '画像なしで進む' }).click();
            await page.getByRole('button', { name: '次へ', exact: true }).click();
        };
        await openFinal();
        await page.getByRole('button', { name: 'この公演を正式公開' }).click();
        await page.getByRole('status').filter({ hasText: '公開APIの再送は停止' }).waitFor();
        assert.equal(await page.getByRole('button', { name: 'この公演を正式公開' }).isDisabled(), true);
        assert.equal(await page.evaluate(() => window.rpcCount), 1);
        await page.reload();
        await page.waitForFunction(() => Boolean(window.openFixture));
        await openFinal();
        await page.getByRole('button', { name: 'この公演を正式公開' }).click();
        await page.getByRole('status').filter({ hasText: '公開APIの再送は停止' }).waitFor();
        assert.equal(await page.evaluate(() => window.rpcCount), 0);
        console.log('WORKS 1440px / 390px: required fields, image omission, next/back, dedicated RPC, result link, UNKNOWN reload guard passed.');
    } finally {
        await browser?.close();
        server.close();
    }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
