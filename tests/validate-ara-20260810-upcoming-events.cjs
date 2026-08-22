const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const workHandler = require('../api/work.js');
const sitemapHandler = require('../api/sitemap.js');
const shared = require('../api/_shared.cjs');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const stripImports = (source) => source.replace(/^import[\s\S]*?from ['"][^'"]+['"];\r?\n/gm, '');

const upcoming = {
    id: 9001,
    slug: '2026-sample-live-hiroshima',
    title: 'SAMPLE LIVE 2026 広島公演',
    category: 'ライブ・アーティストPA',
    lifecycle_status: 'upcoming',
    performer_name: 'SAMPLE ARTIST',
    event_date: '2026-12-20',
    venue: '広島サンプルホール',
    area: '広島県広島市',
    venue_address: '広島県広島市中区サンプル1-2-3',
    organizer_name: 'サンプル主催者',
    official_announcement_url: 'https://example.com/events/sample-live',
    announcement_confirmed_on: '2026-08-10',
    service_plan: null,
    assignment_items: ['sound_equipment', 'pa_operation'],
    participant_groups: null,
    system_setup: null,
    role_type: 'artist_pa_operation',
    role_types: ['artist_pa_operation'],
    artists: 'SAMPLE ARTIST',
    operation_artists: 'SAMPLE ARTIST',
    support_artists: null,
    description: null,
    flyer_path: null,
    flyer_alt: null,
    is_published: true,
    publish_at: null,
    updated_at: '2026-08-10T00:00:00+00:00'
};

const upcomingHtml = workHandler.renderWorkPage(upcoming);
assert.equal(shared.formatDate('2026-08-14'), '2026年8月14日(金)');
assert.equal(shared.formatDate('2026-08-16'), '2026年8月16日(日)');
assert.equal(shared.formatDate(null), '');
assert.match(upcomingHtml, /2026年12月20日\(日\)/u);
assert.match(upcomingHtml, /<title>SAMPLE LIVE 2026 広島公演｜2026年 広島サンプルホール｜ARA-TECH 音響担当予定<\/title>/);
assert.match(upcomingHtml, /<link rel="canonical" href="https:\/\/ara-tech\.cc\/works\/2026-sample-live-hiroshima\.html">/);
assert.match(upcomingHtml, /<span class="detail-status detail-status--upcoming">開催予定<\/span>/);
assert.match(upcomingHtml, /ARA-TECHはこの公演の主催者ではありません/);
assert.match(upcomingHtml, /href="https:\/\/example\.com\/events\/sample-live" target="_blank" rel="external noopener noreferrer"/);
assert.match(upcomingHtml, /画像は掲載されていません/);
assert.doesNotMatch(upcomingHtml, /detail-flyer"><img/);
assert.doesNotMatch(upcomingHtml, /<link rel="preload" as="image"/);

const upcomingJsonLd = JSON.parse(upcomingHtml.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
const upcomingGraph = upcomingJsonLd['@graph'];
const event = upcomingGraph.find((item) => item['@type'] === 'Event');
assert.ok(event, 'eligible upcoming pages must include Event structured data');
assert.equal(event.name, upcoming.title);
assert.equal(event.startDate, upcoming.event_date);
assert.equal(event.eventStatus, 'https://schema.org/EventScheduled');
assert.equal(event.eventAttendanceMode, 'https://schema.org/OfflineEventAttendanceMode');
assert.equal(event.location.name, upcoming.venue);
assert.equal(event.location.address.streetAddress, upcoming.venue_address);
assert.equal(event.location.address.addressRegion, upcoming.area);
assert.equal(event.location.address.addressCountry, 'JP');
assert.equal(event.url, `https://ara-tech.cc/works/${upcoming.slug}.html`);
assert.equal(event.sameAs, upcoming.official_announcement_url);
assert.equal(event.performer[0].name, upcoming.performer_name);
assert.equal(event.organizer.name, upcoming.organizer_name);
assert.equal(event.organizer.url, upcoming.official_announcement_url);
assert.ok(!('image' in event), 'Event image must be omitted when no licensed flyer is stored');
assert.ok(!upcomingGraph.some((item) => item['@type'] === 'ImageObject'));

const completedHtml = workHandler.renderWorkPage({ ...upcoming, lifecycle_status: 'completed' });
assert.match(completedHtml, /<title>SAMPLE LIVE 2026 広島公演｜2026年 広島サンプルホール｜ARA-TECH実績<\/title>/);
assert.match(completedHtml, /<link rel="canonical" href="https:\/\/ara-tech\.cc\/works\/2026-sample-live-hiroshima\.html">/);
assert.doesNotMatch(completedHtml, /"@type":"Event"/);
assert.doesNotMatch(completedHtml, /OFFICIAL INFORMATION/);
assert.match(completedHtml, /detail-status--completed/);

const incompleteEventHtml = workHandler.renderWorkPage({ ...upcoming, venue_address: null });
const incompleteGraph = JSON.parse(incompleteEventHtml.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1])['@graph'];
assert.ok(!incompleteGraph.some((item) => item['@type'] === 'Event'), 'incomplete Google location data must not produce Event markup');

const sitemap = sitemapHandler.renderSitemap([{ slug: upcoming.slug, updated_at: upcoming.updated_at }]);
assert.match(sitemap, /https:\/\/ara-tech\.cc\/works\/2026-sample-live-hiroshima\.html/);
assert.match(sitemap, /<lastmod>2026-08-10<\/lastmod>/);

const adminHtml = read('admin.html');
const adminJs = read('js/admin.js');
const worksHtml = read('works.html');
const worksJs = read('js/works.js');
const sharedSource = read('api/_shared.cjs');
const migration = read('supabase/migrations/20260810000000_works_upcoming_events.sql');

[
    'post-lifecycle-status',
    'post-performer-name',
    'post-area',
    'post-venue-address',
    'post-organizer-name',
    'post-official-announcement-url',
    'post-announcement-confirmed-on',
    'post-flyer-alt'
].forEach((id) => assert.ok(adminHtml.includes(`id="${id}"`), `${id} is missing`));
assert.match(adminHtml, /フライヤー画像[^<]*<span class="help">任意/);
assert.doesNotMatch(adminJs, /!editingPost && !file/);
assert.match(adminJs, /lifecycle_status: lifecycleStatus/);
assert.match(adminJs, /開催予定を公開するには、アーティスト名またはイベント名・開催日・会場・地域・担当内容・HTTPSの公式告知URL・告知解禁確認日が必要です/);
assert.match(adminJs, /開催予定の開催日に過去の日付は指定できません/);
assert.match(adminJs, /flyerAltInput\.value\.trim\(\) \|\| \(flyerPath \|\| reviewImageUrl \? `\$\{title\}のフライヤー` : null\)/);
assert.match(worksHtml, /id="upcoming"/);
assert.match(worksHtml, /ARA-TECHは掲載イベントの主催者ではありません/);
assert.match(worksJs, /partitionWorksByLifecycle\(data\)/);
assert.doesNotMatch(worksJs, /filter\(isUpcomingWork\)/);
assert.match(worksJs, /post\.flyer_path/);
assert.match(sharedSource, /require\('\.\.\/js\/work-lifecycle\.js'\)/);
assert.match(sharedSource, /担当予定です/);
assert.match(worksJs, /日\(\$\{weekdays\[value\.getUTCDay\(\)\]\}\)/u);
assert.match(adminJs, /日\(\$\{weekdays\[value\.getUTCDay\(\)\]\}\)/u);

assert.match(migration, /add column if not exists lifecycle_status text not null default 'completed'/);
assert.match(migration, /work_posts_upcoming_publication_evidence/);
assert.match(migration, /official_announcement_url ~ '\^https:\/\//);
assert.match(migration, /announcement_confirmed_on is not null/);
assert.match(migration, /cardinality\(coalesce\(assignment_items/);
assert.doesNotMatch(migration, /\b(update|delete|truncate|drop column)\b/i);

new vm.Script(stripImports(adminJs), { filename: 'js/admin.js' });
new vm.Script(stripImports(worksJs), { filename: 'js/works.js' });

console.log('ARA-20260810 upcoming event lifecycle, publication evidence, optional image, SEO, sitemap, and Event structured data validation passed');
