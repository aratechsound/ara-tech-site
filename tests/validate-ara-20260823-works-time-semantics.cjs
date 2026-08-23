const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');

const root = resolve(__dirname, '..');
const adminHtml = readFileSync(resolve(root, 'admin.html'), 'utf8');
const adminJs = readFileSync(resolve(root, 'js/admin.js'), 'utf8');
const workflow = readFileSync(resolve(root, 'scripts/lib/upcoming-event-workflow.mjs'), 'utf8');
const guide = readFileSync(resolve(root, 'docs/UPCOMING_EVENT_CODEX_WORKFLOW.md'), 'utf8');

assert.match(adminHtml, /post-time-evidence-confirmed/);
assert.match(adminHtml, /営業時間・時間帯/);
assert.match(adminJs, /assertTimeEvidence\(\)/);
assert.match(adminJs, /CLOSE／END、推測値は登録できません/);
assert.match(workflow, /A range \(including 22:00-04:00\) is never evidence of OPEN/);
assert.match(workflow, /open_time_label/);
assert.match(workflow, /start_time_label/);
assert.match(guide, /22:00 - 04:00/);
assert.match(guide, /終了時刻をSTART欄へ保存しない/);

console.log('ARA-20260823 WORKS time-semantics validation passed');
