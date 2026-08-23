const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');

const root = resolve(__dirname, '..');
const adminHtml = readFileSync(resolve(root, 'admin.html'), 'utf8');
const adminJs = readFileSync(resolve(root, 'js/admin.js'), 'utf8');
const workflow = readFileSync(resolve(root, 'scripts/lib/upcoming-event-workflow.mjs'), 'utf8');
const guide = readFileSync(resolve(root, 'docs/UPCOMING_EVENT_CODEX_WORKFLOW.md'), 'utf8');
const workApi = readFileSync(resolve(root, 'api/work.js'), 'utf8');
const shared = readFileSync(resolve(root, 'api/_shared.cjs'), 'utf8');
const migration = readFileSync(resolve(root, 'supabase/migrations/20260823110000_works_close_time.sql'), 'utf8');
const workHandler = require(resolve(root, 'api/work.js'));

assert.match(adminHtml, /post-time-evidence-confirmed/);
assert.match(adminHtml, /イベント告知の時間帯/);
assert.match(adminJs, /assertTimeEvidence\(\)/);
assert.match(adminHtml, /post-close-time/);
assert.match(adminJs, /close_time: closeTimeInput\.value \|\| null/);
assert.match(workflow, /event time range maps only to/);
assert.match(workflow, /open_time_label/);
assert.match(workflow, /start_time_label/);
assert.match(workflow, /close_time_label/);
assert.match(guide, /22:00 - 04:00/);
assert.match(guide, /終了時刻をSTART欄へ保存しない/);
assert.match(workApi, /<dt>CLOSE<\/dt>/);
assert.match(shared, /'close_time'/);
assert.match(migration, /add column if not exists close_time text/);
assert.match(migration, /work_posts_close_time_format/);
assert.match(migration, /'close_time', p_work\.close_time/);

const closeHtml = workHandler.renderWorkPage({
    id: 999, slug: 'close-test', title: 'CLOSE TEST', event_date: '2026-09-01',
    lifecycle_status: 'upcoming', event_type: 'ライブ・コンサート', service_types: ['pa_sound'],
    venue: 'TEST HALL', area: '広島県広島市', performer_name: 'TEST', close_time: '25:00'
});
assert.match(closeHtml, /<dt>CLOSE<\/dt><dd><time datetime="25:00">25:00<\/time>/);
assert.doesNotMatch(closeHtml, /<dt>START<\/dt><dd><time datetime="25:00">/);

console.log('ARA-20260823 WORKS time-semantics validation passed');
