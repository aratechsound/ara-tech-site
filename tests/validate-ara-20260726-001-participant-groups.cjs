const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const adminHtml = read('admin.html');
const adminJs = read('js/admin.js');
const worksJs = read('js/works.js');
const sharedJs = read('api/_shared.cjs');
const workHandler = require('../api/work.js');
const { rows } = require('./fixtures.cjs');
const migration = read('supabase/migrations/2026-07-26-works-participant-groups.sql');

assert.match(adminHtml, /id="post-participant-groups"[^>]+maxlength="1000"/);
assert.match(adminHtml, /出演・参加団体/);
assert.match(adminHtml, /専属アーティストPAとは別に/);
assert.match(adminJs, /participant_groups: participantGroupsInput\.value\.trim\(\) \|\| null/);
assert.match(adminJs, /participantGroupsInput\.value = post\.participant_groups \|\| ''/);
assert.match(adminJs, /出演・参加団体：\$\{post\.participant_groups\}/);
assert.match(worksJs, /createArtistLine\('出演・参加団体', post\.participant_groups\)/);
assert.match(worksJs, /service_types, participant_groups, system_setup/);
assert.doesNotMatch(worksJs, /description\.textContent = post\.description/);
assert.doesNotMatch(worksJs, /support_artists, description, flyer_path/);
assert.match(sharedJs, /'participant_groups'/);
assert.match(sharedJs, /event_type\|service_types\|service_plan\|assignment_items\|participant_groups\|system_setup/);

const sample = {
    ...rows[0],
    event_type: '祭り・地域イベント',
    service_types: ['pa_sound'],
    participant_groups: 'LOOP DANCE SCHOOL <script>alert(1)</script>',
    role_type: null,
    role_types: [],
    artists: null,
    operation_artists: null,
    support_artists: null
};
const detailHtml = workHandler.renderWorkPage(sample);
assert.match(detailHtml, /出演・参加団体<\/dt><dd>LOOP DANCE SCHOOL &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
assert.ok(!detailHtml.includes('<script>alert(1)</script>'));

const legacyHtml = workHandler.renderWorkPage({ ...rows[0], participant_groups: null });
assert.ok(!legacyHtml.includes('<dt>出演・参加団体</dt>'));

assert.match(migration, /add column if not exists participant_groups text/);
assert.match(migration, /work_posts_participant_groups_length/);
assert.doesNotMatch(migration, /\b(update|delete|truncate|drop column)\b/i);

console.log('ARA-20260726-001 participant groups separation and compatibility checks passed');
