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
const migration = read('supabase/migrations/2026-07-26-works-category-plan-assignments.sql');
const workHandler = require('../api/work.js');
const shared = require('../api/_shared.cjs');
const { rows } = require('./fixtures.cjs');

(async () => {
    const taxonomy = await import(pathToFileURL(path.join(root, 'js', 'work-taxonomy.mjs')));

    assert.ok(taxonomy.workCategories.includes('お祭り・地域イベント音響'));
    assert.ok(taxonomy.legacyWorkCategories.includes('WORKS'));
    assert.equal(taxonomy.getServicePlanLabel('matsuri_pack'), 'Matsuri Pack');
    assert.deepEqual(
        taxonomy.normalizeAssignmentItems(['simple_lighting', 'event_operation', 'simple_lighting', 'invalid']),
        ['simple_lighting', 'event_operation']
    );
    assert.equal(shared.getServicePlanLabel('matsuri_pack'), 'Matsuri Pack');
    assert.deepEqual(
        shared.getAssignmentItemLabels({ assignment_items: ['sound_equipment', 'simple_lighting', 'event_operation'] }),
        ['音響機材一式', '簡易照明', '本番対応']
    );

    [
        'お祭り・地域イベント音響',
        'ライブ・アーティストPA',
        'DJイベント音響',
        'ステージ・照明',
        'ツアーPA',
        '音響設備・施工',
        '機材レンタル',
        'その他'
    ].forEach((label) => assert.ok(adminHtml.includes(label)));
    [
        'Compact PA',
        'Standard LIVE',
        'Matsuri Pack',
        'School Festival Pack',
        'PA Operator Only',
        'Large Scale',
        'Technical Advisor / Training',
        'その他・個別対応'
    ].forEach((label) => assert.ok(adminHtml.includes(label)));
    [
        'sound_equipment',
        'pa_operation',
        'load_in_setup_strike',
        'simple_lighting',
        'lighting_operation',
        'stage_production',
        'equipment_rental_only',
        'sound_installation',
        'event_operation',
        'other'
    ].forEach((code) => assert.ok(adminHtml.includes(`value="${code}"`)));

    assert.match(adminHtml, /id="post-system-setup"[^>]+maxlength="2000"/);
    assert.match(adminHtml, /\.form-grid, \.assignment-options \{ grid-template-columns: 1fr; \}/);
    assert.match(adminJs, /service_plan: normalizeServicePlan\(servicePlanInput\.value\)/);
    assert.match(adminJs, /assignment_items: assignmentItems\.length \? assignmentItems : null/);
    assert.match(adminJs, /system_setup: systemSetupInput\.value\.trim\(\) \|\| null/);
    assert.match(adminJs, /loadClassification\(editingPost\)/);
    assert.match(adminJs, /loadClassification\(source\)/);
    assert.doesNotMatch(adminJs, /delete payload\.service_plan|delete payload\.assignment_items|delete payload\.system_setup/);

    const sample = {
        ...rows[0],
        slug: '2026-bozuyama-summer-night',
        title: '坊主山サマーナイト2026｜お祭り音響・簡易照明',
        category: 'お祭り・地域イベント音響',
        event_date: '2026-07-25',
        venue: '熊野坊主山商店街特設会場',
        service_plan: 'matsuri_pack',
        assignment_items: ['sound_equipment', 'load_in_setup_strike', 'simple_lighting', 'event_operation'],
        system_setup: 'スタンドスピーカーによる会場音響、LEDバーによる簡易照明\n<script>alert(1)</script>',
        role_type: null,
        role_types: [],
        artists: null,
        operation_artists: null,
        support_artists: null
    };
    const detailHtml = workHandler.renderWorkPage(sample);
    assert.match(detailHtml, /お祭り・地域イベント音響/);
    assert.match(detailHtml, /Matsuri Pack/);
    assert.match(detailHtml, /担当内容<\/dt><dd>音響機材一式、搬入・設営・撤去、簡易照明、本番対応/);
    assert.match(detailHtml, /機材・システム構成<\/dt><dd>スタンドスピーカーによる会場音響、LEDバーによる簡易照明<br>&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.ok(!detailHtml.includes('<script>alert(1)</script>'));

    const legacyHtml = workHandler.renderWorkPage({ ...rows[0], service_plan: null, assignment_items: null, system_setup: null });
    assert.ok(!legacyHtml.includes('<dt>提供プラン</dt>'));
    assert.ok(!legacyHtml.includes('<dt>担当内容</dt>'));
    assert.ok(!legacyHtml.includes('<dt>機材・システム構成</dt>'));

    assert.match(worksJs, /work-card__service-plan/);
    assert.match(worksHtml, /\.work-card__service-plan/);
    assert.match(detailCss, /\.detail-tag-row/);
    assert.match(detailCss, /\.detail-plan/);

    assert.match(migration, /add column if not exists service_plan text/);
    assert.match(migration, /add column if not exists assignment_items text\[\]/);
    assert.match(migration, /add column if not exists system_setup text/);
    assert.match(migration, /work_posts_category_allowed/);
    assert.match(migration, /work_posts_service_plan_allowed/);
    assert.match(migration, /work_posts_assignment_items_allowed/);
    assert.match(migration, /work_posts_system_setup_length/);
    assert.doesNotMatch(migration, /\b(update|delete|truncate|drop column)\b/i);

    new vm.Script(stripImports(adminJs), { filename: 'js/admin.js' });
    new vm.Script(stripImports(worksJs), { filename: 'js/works.js' });

    console.log('ARA-20260726-001 WORKS classification, compatibility, validation, and rendering checks passed');
})();
