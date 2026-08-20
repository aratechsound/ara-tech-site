const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const lifecycle = require('../js/work-lifecycle.js');
const shared = require('../api/_shared.cjs');
const workHandler = require('../api/work.js');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

const beforeJstMidnight = new Date('2026-08-19T14:59:59.999Z');
const atJstMidnight = new Date('2026-08-19T15:00:00.000Z');
const now = atJstMidnight;
const upcoming = (eventDate) => ({ lifecycle_status: 'upcoming', event_date: eventDate });

assert.equal(lifecycle.getJstDateString(beforeJstMidnight), '2026-08-19');
assert.equal(lifecycle.getJstDateString(atJstMidnight), '2026-08-20');
assert.equal(lifecycle.isUpcomingWork(upcoming('2026-08-19'), beforeJstMidnight), true, 'event remains upcoming through 23:59:59 JST');
assert.equal(lifecycle.isUpcomingWork(upcoming('2026-08-19'), atJstMidnight), false, 'event becomes completed at next-day 00:00 JST');

assert.equal(lifecycle.getEffectiveLifecycleStatus(upcoming('2026-08-19'), now), 'completed', 'yesterday');
assert.equal(lifecycle.getEffectiveLifecycleStatus(upcoming('2026-08-20'), now), 'upcoming', 'today');
assert.equal(lifecycle.getEffectiveLifecycleStatus(upcoming('2026-08-21'), now), 'upcoming', 'tomorrow');
assert.equal(lifecycle.getEffectiveLifecycleStatus(upcoming('2025-01-01'), now), 'completed', 'past');
assert.equal(lifecycle.getEffectiveLifecycleStatus(upcoming('2027-01-01'), now), 'upcoming', 'future');
assert.equal(lifecycle.getEffectiveLifecycleStatus(upcoming(null), now), 'upcoming', 'missing date preserves stored upcoming state');
assert.equal(lifecycle.getEffectiveLifecycleStatus(upcoming('2026-02-30'), now), 'upcoming', 'invalid date preserves stored upcoming state');
assert.equal(lifecycle.getEffectiveLifecycleStatus({ lifecycle_status: 'completed', event_date: '2027-01-01' }, now), 'completed', 'explicit completed state remains completed');
assert.equal(lifecycle.normalizeDateOnly('2024-02-29'), '2024-02-29');
assert.equal(lifecycle.normalizeDateOnly('2026-02-29'), '');

assert.equal(shared.isUpcomingWork, lifecycle.isUpcomingWork, 'API and browser use the same lifecycle implementation');

const expiredPost = {
    id: 1,
    slug: 'expired-sample',
    title: 'Expired Sample',
    category: 'その他',
    lifecycle_status: 'upcoming',
    event_date: '2020-01-01',
    venue: 'Sample Hall',
    performer_name: 'Sample',
    area: '広島県',
    venue_address: '広島県広島市',
    organizer_name: 'Sample Organizer',
    official_announcement_url: 'https://example.com/event',
    description: 'Sample Hallで開催予定の公演で、ARA-TECHが音響を担当予定です。',
    seo_title: 'Expired Sample｜ARA-TECH 音響担当予定',
    meta_description: '開催予定の公演です。',
    is_published: true
};
const expiredHtml = workHandler.renderWorkPage(expiredPost);
assert.match(expiredHtml, /detail-status--completed">終了済み/u);
assert.match(expiredHtml, /FIELD REPORT/u);
assert.doesNotMatch(expiredHtml, /EventScheduled/u);
assert.match(expiredHtml, /<title>Expired Sample｜2020年 Sample Hall｜ARA-TECH実績<\/title>/u);
assert.match(expiredHtml, /Expired Sample」のARA-TECH実績です/u);
assert.doesNotMatch(expiredHtml, /開催予定の公演/u);

const staleCompletedHtml = workHandler.renderWorkPage({ ...expiredPost, lifecycle_status: 'completed' });
assert.match(staleCompletedHtml, /<title>Expired Sample｜2020年 Sample Hall｜ARA-TECH実績<\/title>/u);
assert.match(staleCompletedHtml, /Expired Sample」のARA-TECH実績です/u);
assert.doesNotMatch(staleCompletedHtml, /開催予定の公演/u);

const worksSource = read('js/works.js');
const adminSource = read('js/admin.js');
const worksHtml = read('works.html');
const adminHtml = read('admin.html');
const workApiSource = read('api/work.js');
assert.match(worksSource, /window\.AraTechWorkLifecycle/u);
assert.match(adminSource, /getJstDateString/u);
assert.match(adminSource, /isUpcomingWork\(post\)/u);
assert.match(worksHtml, /js\/work-lifecycle\.js\?v=ara-20260820-001/u);
assert.match(adminHtml, /js\/work-lifecycle\.js\?v=ara-20260820-001/u);
assert.match(workApiSource, /CDN-Cache-Control', 'no-store'/u);

console.log(`ARA-20260820 WORKS automatic JST lifecycle validation passed (runtime TZ=${Intl.DateTimeFormat().resolvedOptions().timeZone})`);
