const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const workHandler = require('../api/work.js');
const sitemapHandler = require('../api/sitemap.js');
const { fallbackWorks } = require('../api/_shared.cjs');
const { rows } = require('./fixtures.cjs');

const repoRoot = path.resolve(__dirname, '..');

const createResponse = () => ({
    headers: {},
    statusCode: 200,
    body: '',
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    send(body) { this.body = String(body || ''); return this; }
});

const originalFetch = global.fetch;
global.fetch = async (url) => {
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get('is_published'), 'eq.true');
    assert.match(parsed.searchParams.get('or') || '', /^\(publish_at\.is\.null,publish_at\.lte\./);
    const idFilter = parsed.searchParams.get('id');
    const slugFilter = parsed.searchParams.get('slug');
    let result = rows;
    if (idFilter) result = rows.filter((row) => row.id === Number(idFilter.replace(/^eq\./, '')));
    if (slugFilter) result = rows.filter((row) => row.slug === slugFilter.replace(/^eq\./, ''));
    if (parsed.searchParams.get('select') === 'slug,updated_at') result = result.map(({ slug, updated_at }) => ({ slug, updated_at }));
    return { ok: true, status: 200, json: async () => result };
};

(async () => {
    for (const row of rows) {
        const html = workHandler.renderWorkPage(row);
        assert.match(html, new RegExp(`<h1[^>]*>${row.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</h1>`));
        assert.ok(html.includes(`<link rel="canonical" href="https://ara-tech.cc/works/${row.slug}.html">`));
        assert.ok(html.includes(`<meta property="og:url" content="https://ara-tech.cc/works/${row.slug}.html">`));
        assert.ok(html.includes(row.flyer_alt));
        const jsonLd = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1];
        assert.ok(jsonLd, `${row.slug}: JSON-LD is missing`);
        const graph = JSON.parse(jsonLd)['@graph'];
        assert.equal(graph[0].url, `https://ara-tech.cc/works/${row.slug}.html`);
        assert.equal(graph[1].itemListElement[2].name, `${row.event_date.slice(0, 4)}年`);
        assert.equal(graph[1].itemListElement[3].name, row.title);
    }

    const oldResponse = createResponse();
    await workHandler({ method: 'GET', query: { id: '37' } }, oldResponse);
    assert.equal(oldResponse.statusCode, 308);
    assert.equal(oldResponse.headers.location, '/works/2026-hyakka-ryoran-vol-20.html');

    const detailResponse = createResponse();
    await workHandler({ method: 'GET', query: { slug: '2026-sonsi' } }, detailResponse);
    assert.equal(detailResponse.statusCode, 200);
    assert.match(detailResponse.headers['content-type'], /^text\/html/);
    assert.ok(detailResponse.body.includes('<title>Sonsi｜2026年 LAGOON HIROSHIMA｜ARA-TECH実績</title>'));

    const missingResponse = createResponse();
    await workHandler({ method: 'GET', query: { slug: '../private' } }, missingResponse);
    assert.equal(missingResponse.statusCode, 404);
    assert.equal(missingResponse.headers['x-robots-tag'], 'noindex, follow');

    const sitemapResponse = createResponse();
    await sitemapHandler({ method: 'GET', query: {} }, sitemapResponse);
    assert.equal(sitemapResponse.statusCode, 200);
    assert.match(sitemapResponse.headers['content-type'], /^application\/xml/);
    assert.equal((sitemapResponse.body.match(/<url>/g) || []).length, 13);
    assert.ok(sitemapResponse.body.includes('https://ara-tech.cc/general-inquiry.html'));
    assert.ok(sitemapResponse.body.includes('https://ara-tech.cc/pa-inquiry.html'));
    assert.ok(sitemapResponse.body.includes('https://ara-tech.cc/works/2026-hyakka-ryoran-vol-20.html'));
    assert.ok(!sitemapResponse.body.includes('work.html?id='));

    assert.equal(fallbackWorks.length, 36);
    assert.equal(new Set(fallbackWorks.map((work) => work.slug)).size, 36);
    const originalConsoleError = console.error;
    console.error = () => {};
    global.fetch = async () => { throw new Error('offline'); };
    const fallbackSitemapResponse = createResponse();
    await sitemapHandler({ method: 'GET', query: {} }, fallbackSitemapResponse);
    console.error = originalConsoleError;
    assert.equal(fallbackSitemapResponse.statusCode, 200);
    assert.equal((fallbackSitemapResponse.body.match(/<url>/g) || []).length, 46);
    assert.ok(fallbackSitemapResponse.body.includes('https://ara-tech.cc/works/2026-sonsi.html'));

    const adminHtml = fs.readFileSync(path.join(repoRoot, 'admin.html'), 'utf8');
    const adminJs = fs.readFileSync(path.join(repoRoot, 'js', 'admin.js'), 'utf8');
    const worksJs = fs.readFileSync(path.join(repoRoot, 'js', 'works.js'), 'utf8');
    const vercel = JSON.parse(fs.readFileSync(path.join(repoRoot, 'vercel.json'), 'utf8'));
    assert.ok(adminHtml.includes('id="post-slug"'));
    assert.ok(adminHtml.includes('id="slug-preview"'));
    assert.ok(adminJs.includes("error.code === '23505'"));
    assert.ok(adminJs.includes('findUniqueSlug'));
    assert.ok(worksJs.includes('/works/${post.slug}.html'));
    assert.ok(worksJs.includes(".eq('is_published', true)"));
    assert.ok(worksJs.includes('.or(`publish_at.is.null,publish_at.lte.'));
    assert.deepEqual(vercel.rewrites.map((rewrite) => rewrite.source), ['/works/:slug.html', '/work.html', '/sitemap.xml']);
    assert.ok(!fs.existsSync(path.join(repoRoot, 'work.html')), 'static work.html must not shadow the rewrite');
    assert.ok(!fs.existsSync(path.join(repoRoot, 'sitemap.xml')), 'static sitemap.xml must not shadow the rewrite');

    console.log('validate-no001: validation suite passed');
})().finally(() => { global.fetch = originalFetch; });
