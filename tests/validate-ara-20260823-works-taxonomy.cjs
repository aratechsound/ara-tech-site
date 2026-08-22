const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');
const stripImports = (source) => source.replace(/^import[\s\S]*?from ['"][^'"]+['"];\r?\n/gm, '');
const adminHtml = read('admin.html');
const adminJs = read('js/admin.js');
const worksHtml = read('works.html');
const worksJs = read('js/works.js');
const detailCss = read('work-detail.css');
const migration = read('supabase/migrations/20260823090000_works_event_type_service_types.sql');
const workHandler = require('../api/work.js');
const shared = require('../api/_shared.cjs');
const { rows } = require('./fixtures.cjs');

(async () => {
    const taxonomy = await import(pathToFileURL(path.join(root, 'js', 'work-taxonomy.mjs')));
    const expectedEventTypes = [
        'ライブ・コンサート', 'クラブ・DJイベント', '祭り・地域イベント', '企業・式典',
        '講演会・セミナー', 'ダンス・舞台公演', '学校・文化イベント'
    ];
    const expectedServiceTypes = [
        'PA・音響', 'アーティストPAオペレート', '簡易照明', 'ステージ照明', 'LEDビジョン・映像',
        '仮設ステージ設営', 'トラス設営', 'イベント技術制作', 'システム設計・施工'
    ];

    assert.deepEqual(taxonomy.eventTypes, expectedEventTypes);
    assert.deepEqual(Object.values(taxonomy.serviceTypeLabels), expectedServiceTypes);
    assert.deepEqual(taxonomy.normalizeServiceTypes(['pa_sound', 'simple_lighting', 'pa_sound', 'invalid']), ['pa_sound', 'simple_lighting']);
    assert.deepEqual(taxonomy.getServiceTypeLabels(['pa_sound', 'simple_lighting']), ['PA・音響', '簡易照明']);
    assert.equal(taxonomy.isAllowedEventType('祭り・地域イベント'), true);
    assert.equal(taxonomy.isAllowedEventType('お祭り・地域イベント音響'), false);

    expectedEventTypes.forEach((label) => assert.ok(adminHtml.includes(`<option value="${label}">${label}</option>`)));
    expectedServiceTypes.forEach((label) => assert.ok(adminHtml.includes(`>${label}</label>`)));
    ['お祭り・地域イベント音響', 'ライブ・アーティストPA', 'DJイベント音響', 'ステージ・照明', 'ツアーPA', '音響設備・施工', '機材レンタル'].forEach((label) => assert.ok(!adminHtml.includes(label)));
    assert.match(adminHtml, /name="service-type"/);
    assert.match(adminJs, /event_type: eventType/);
    assert.match(adminJs, /service_types: serviceTypes/);
    assert.match(adminJs, /担当業務を1件以上選択してください/);

    const sample = {
        ...rows[0],
        slug: '2026-bouzuyama-summer-night',
        title: '坊主山サマーナイト2026',
        category: '祭り・地域イベント',
        event_type: '祭り・地域イベント',
        service_types: ['pa_sound', 'simple_lighting'],
        event_date: '2026-07-25',
        venue: '熊野坊主山商店街特設会場',
        operation_artists: null,
        support_artists: null
    };
    const detailHtml = workHandler.renderWorkPage(sample);
    assert.match(detailHtml, /祭り・地域イベント/);
    assert.match(detailHtml, /PA・音響 \/ 簡易照明/);
    assert.match(detailHtml, /<dt>担当業務<\/dt><dd>PA・音響、簡易照明<\/dd>/);
    assert.ok(!detailHtml.includes('お祭り・地域イベント音響'));
    assert.deepEqual(shared.getServiceTypeLabels(sample), ['PA・音響', '簡易照明']);

    assert.match(worksJs, /work-card__classification/);
    assert.match(worksJs, /work-card__event-type/);
    assert.match(worksJs, /work-card__service-badge/);
    assert.match(worksHtml, /\.work-card__classification/);
    assert.match(worksHtml, /\.work-card__service-badge/);
    assert.match(detailCss, /\.detail-services/);
    assert.match(migration, /add column if not exists event_type text/);
    assert.match(migration, /add column if not exists service_types text\[\]/);
    assert.match(migration, /venue in \('LAGOON HIROSHIMA', 'club G'\) or venue ilike '%CLUB L2%'/);
    assert.match(migration, /work_posts_service_types_allowed/);
    assert.doesNotMatch(migration, /stage_production/);

    new vm.Script(stripImports(adminJs), { filename: 'js/admin.js' });
    new vm.Script(stripImports(worksJs), { filename: 'js/works.js' });
    console.log('ARA-20260823 WORKS event-type and service-type taxonomy checks passed');
})();
