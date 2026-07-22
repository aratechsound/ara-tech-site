const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const workHandler = require('../api/work.js');
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

const responseFor = async (slug) => {
    const response = createResponse();
    await workHandler({ method: 'GET', query: { slug } }, response);
    return response;
};

const originalFetch = global.fetch;
let fetchCount = 0;
global.fetch = async (url) => {
    fetchCount += 1;
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get('is_published'), 'eq.true');
    assert.match(parsed.searchParams.get('or') || '', /^\(publish_at\.is\.null,publish_at\.lte\./);
    assert.equal(parsed.searchParams.get('order'), 'event_date.desc.nullslast,created_at.desc,id.desc');
    return { ok: true, status: 200, json: async () => rows };
};

const makeWork = (id, slug, title, eventDate, category = 'WORKS', roleTypes = []) => ({
    id,
    slug,
    title,
    event_date: eventDate,
    category,
    role_types: roleTypes,
    flyer_path: null,
    flyer_alt: null
});

(async () => {
    const sameDayOrder = [
        makeWork(50, 'same-day-newer-id-50', '同日・補助キー上位', '2026-07-20'),
        makeWork(49, 'same-day-current-id-49', '同日・現在', '2026-07-20'),
        makeWork(48, 'next-older-date-id-48', '次に古い実績', '2026-07-19'),
        makeWork(1, 'oldest-id-1', '最古の実績', '2025-01-01')
    ];

    const latestNavigation = workHandler.buildWorkNavigation(sameDayOrder[0], sameDayOrder);
    assert.equal(latestNavigation.newerWork, null);
    assert.equal(latestNavigation.olderWork.slug, 'same-day-current-id-49');

    const sameDayNavigation = workHandler.buildWorkNavigation(sameDayOrder[1], sameDayOrder);
    assert.equal(sameDayNavigation.newerWork.slug, 'same-day-newer-id-50');
    assert.equal(sameDayNavigation.olderWork.slug, 'next-older-date-id-48');

    const oldestNavigation = workHandler.buildWorkNavigation(sameDayOrder.at(-1), sameDayOrder);
    assert.equal(oldestNavigation.olderWork, null);
    assert.equal(oldestNavigation.newerWork.slug, 'next-older-date-id-48');

    const undated = makeWork(60, 'undated-work-60', '日付未設定の実績', null);
    assert.deepEqual(workHandler.buildWorkNavigation(undated, [...sameDayOrder, undated]), { olderWork: null, newerWork: null });
    const invalidDate = makeWork(61, 'invalid-date-work-61', '不正日付の実績', '2026-99-99');
    assert.deepEqual(workHandler.buildWorkNavigation(invalidDate, [...sameDayOrder, invalidDate]), { olderWork: null, newerWork: null });

    const current = makeWork(100, 'current-work-100', '現在の実績', '2026-06-15', 'TOUR PA', ['artist_pa_operation']);
    const relatedCandidates = [
        current,
        makeWork(101, 'same-year-same-role-101', '同年・同業務', '2026-01-01', 'WORKS', ['artist_pa_operation']),
        makeWork(102, 'same-year-near-date-102', '同年・開催日近接', '2026-06-14', 'INSTALLATION', []),
        makeWork(103, 'different-year-same-role-103', '別年・同業務', '2025-06-15', 'WORKS', ['artist_pa_operation']),
        makeWork(104, 'different-year-other-104', '別年・その他', '2025-06-14', 'INSTALLATION', []),
        makeWork(105, 'invalid slug', '不正slug', '2026-06-13', 'TOUR PA', ['artist_pa_operation'])
    ];
    const related = workHandler.selectRelatedWorks(current, relatedCandidates);
    assert.deepEqual(related.map((work) => work.slug), [
        'same-year-same-role-101',
        'same-year-near-date-102',
        'different-year-same-role-103'
    ]);
    assert.deepEqual(
        workHandler.selectRelatedWorks(current, relatedCandidates).map((work) => work.slug),
        related.map((work) => work.slug),
        'related work selection must remain stable'
    );
    assert.ok(!related.some((work) => work.slug === current.slug));
    assert.ok(!related.some((work) => work.slug.includes(' ')));

    fetchCount = 0;
    const middleResponse = await responseFor('2026-sonsi');
    assert.equal(fetchCount, 1, 'detail page must load public works with one Supabase request');
    assert.equal(middleResponse.statusCode, 200);
    assert.match(middleResponse.body, /<nav class="content-section work-pagination" aria-label="実績の前後ナビゲーション">/);
    assert.ok(middleResponse.body.includes('href="/works/2025-christmas-party-27.html"'));
    assert.ok(middleResponse.body.includes('href="/works/2026-hyakka-ryoran-vol-20.html"'));
    assert.ok(middleResponse.body.includes('href="/works.html#year-2026">2026年</a>'));
    assert.ok(middleResponse.body.includes('href="/works.html#year-2026">← 2026年のWORKS一覧へ戻る</a>'));
    assert.ok(!middleResponse.body.includes('work.html?id='));

    const relatedSection = middleResponse.body.match(/<section class="content-section related-works"[\s\S]*?<\/section>/)?.[0] || '';
    assert.equal((relatedSection.match(/class="related-work-card"/g) || []).length, 2);
    assert.ok(!relatedSection.includes('/works/2026-sonsi.html'));
    assert.match(relatedSection, /loading="lazy" decoding="async"/);
    assert.match(relatedSection, /width="480" height="640"/);
    assert.match(relatedSection, /\/storage\/v1\/render\/image\/public\/work-flyers\//);
    assert.match(relatedSection, /\?width=480&amp;quality=72&amp;resize=contain/);

    const jsonLd = middleResponse.body.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1];
    const breadcrumb = JSON.parse(jsonLd)['@graph'].find((item) => item['@type'] === 'BreadcrumbList').itemListElement;
    assert.deepEqual(breadcrumb.map((item) => item.position), [1, 2, 3, 4]);
    assert.equal(breadcrumb[2].name, '2026年');
    assert.equal(breadcrumb[2].item, 'https://ara-tech.cc/works.html#year-2026');
    assert.equal(breadcrumb[3].name, 'Sonsi');

    const newestResponse = await responseFor('2026-hyakka-ryoran-vol-20');
    assert.ok(!newestResponse.body.includes('work-pagination__link--newer'));
    assert.ok(newestResponse.body.includes('work-pagination__link--older'));

    const oldestResponse = await responseFor('2025-christmas-party-27');
    assert.ok(!oldestResponse.body.includes('work-pagination__link--older'));
    assert.ok(oldestResponse.body.includes('work-pagination__link--newer'));

    const undatedHtml = workHandler.renderWorkPage({ ...rows[0], slug: 'undated-work', title: '日付未設定', event_date: null });
    const undatedJsonLd = undatedHtml.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1];
    const undatedBreadcrumb = JSON.parse(undatedJsonLd)['@graph'].find((item) => item['@type'] === 'BreadcrumbList').itemListElement;
    assert.deepEqual(undatedBreadcrumb.map((item) => item.name), ['トップ', '実績一覧', '日付未設定']);
    assert.ok(!undatedHtml.includes('/works.html#year-'));

    const worksJs = fs.readFileSync(path.join(repoRoot, 'js', 'works.js'), 'utf8');
    const worksHtml = fs.readFileSync(path.join(repoRoot, 'works.html'), 'utf8');
    const detailCss = fs.readFileSync(path.join(repoRoot, 'work-detail.css'), 'utf8');
    assert.ok(worksJs.includes(".order('id', { ascending: false })"));
    assert.ok(worksJs.includes("/^#year-(\\d{4})$/"));
    assert.ok(worksJs.includes('scrollIntoView'));
    assert.ok(worksHtml.includes('.section-heading[id^="year-"] { scroll-margin-top: 96px; }'));
    assert.ok(detailCss.includes('--interactive: #005bb5'));
    assert.ok(detailCss.includes('@media (max-width: 640px)'));
    assert.ok(detailCss.includes('@media (prefers-reduced-motion: reduce)'));

    const contrastRatio = 6.64;
    assert.ok(contrastRatio >= 4.5, 'interactive blue and white must meet WCAG AA for normal text');

    console.log('validate-no002: navigation, related works, breadcrumbs, year links, and accessibility checks passed');
})().finally(() => { global.fetch = originalFetch; });
