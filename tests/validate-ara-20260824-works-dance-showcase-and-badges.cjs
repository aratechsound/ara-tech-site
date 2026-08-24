const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { pathToFileURL } = require('node:url');

const root = resolve(__dirname, '..');
const read = (relativePath) => readFileSync(resolve(root, relativePath), 'utf8');
const adminHtml = read('admin.html');
const worksHtml = read('works.html');
const worksJs = read('js/works.js');
const detailCss = read('work-detail.css');
const migration = read('supabase/migrations/20260824090000_add_dance_showcase_event_type.sql');
const workHandler = require(resolve(root, 'api/work.js'));

(async () => {
    const taxonomy = await import(pathToFileURL(resolve(root, 'js/work-taxonomy.mjs')));
    assert.ok(taxonomy.eventTypes.includes('ダンス発表会・ショーケース'));
    assert.ok(taxonomy.eventTypes.includes('ダンス・舞台公演'));
    assert.match(adminHtml, /<option value="ダンス発表会・ショーケース">ダンス発表会・ショーケース<\/option>/u);
    assert.match(migration, /work_posts_event_type_allowed/u);
    assert.match(migration, /'ダンス発表会・ショーケース'/u);

    assert.match(worksJs, /normalizeServiceTypes\(post\.service_types\)/u);
    assert.match(worksJs, /work-card__service-badge--\$\{serviceTypes\[index\]\}/u);
    assert.match(worksHtml, /work-card__service-badge--local_touring_pa_support/u);
    assert.match(worksHtml, /overflow-wrap: anywhere/u);
    assert.match(detailCss, /detail-service-badge--local_touring_pa_support/u);

    const detailHtml = workHandler.renderWorkPage({
        id: 999,
        slug: 'badge-test',
        title: 'BADGE TEST',
        event_date: '2026-08-24',
        event_type: 'ダンス発表会・ショーケース',
        service_types: ['artist_pa_operation', 'local_touring_pa_support'],
        venue: 'TEST HALL'
    });
    assert.match(detailHtml, /detail-service-badge--artist_pa_operation[^>]*>アーティストPAオペレート/u);
    assert.match(detailHtml, /detail-service-badge--local_touring_pa_support[^>]*>乗り込みPA・現地技術サポート/u);
    console.log('ARA-20260824 WORKS dance-showcase and badge validation passed');
})();
