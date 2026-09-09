import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { normalizeCanonicalState } from '../js/stage-plot/stage-plot-persistence.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const html = read('pa-stage-plot-editor.html');
const css = read('css/stage-plot-editor.css');
const engine = read('js/stage-plot/stage-plot-editor.js');
const page = read('js/stage-plot/stage-plot-page.mjs');
const persistence = read('js/stage-plot/stage-plot-persistence.mjs');
const portal = read('js/pa-case-portal.js');

const v1 = normalizeCanonicalState({
  schemaVersion: 1,
  metadata: { eventName: '互換確認', event_date: '2026-10-18' },
  objects: [], equipment: { brought: [], requested: [] }, audio: [],
  otherRequest: '旧名の要望',
  setlist: [{ id: 'legacy', type: '曲', title: '旧曲', sound: '旧音響', lighting: '旧照明' }],
});
assert.equal(v1.schemaVersion, 2);
assert.equal(v1.setlistOutputMode, 'normal');
assert.equal(v1.metadata.eventDate, '2026-10-18');
assert.equal(v1.otherRequests, '旧名の要望');
assert.equal(v1.setlist[0].playbackCue, 'none');
assert.equal(v1.setlist[0].soundRequest, '旧音響');
assert.equal(v1.setlist[0].lightRequest, '旧照明');

assert.match(html, /ara-tech-logo-horizontal-black\.png/u);
assert.match(html, /id="setlistOutputMode"/u);
assert.match(html, /id="singleMixEditor"/u);
assert.match(html, /id="stagePlotPrintDocumentBtn"/u);
assert.match(engine, /colspan="6"/u);
assert.match(engine, /<th>音響要望<\/th><th>照明要望<\/th>/u);
assert.doesNotMatch(engine, /<th>音源<\/th>|<th>再生キュー<\/th>/u);
for (const cue of ['none', 'show_start', 'on_stage', 'title_call', 'mc_end', 'signal', 'blackout', 'continuous', 'custom']) assert.match(engine, new RegExp(`['"]${cue}['"]`, 'u'));
assert.match(css, /\.cue-trigger \.cue-content \{ border: 1px dashed/u);
assert.match(css, /\.cue-continuous \.cue-content \{ border: 1px solid/u);
assert.match(css, /\.print-setlist-unit \{ break-inside: avoid/u);
assert.match(css, /@page adaptiveStage \{ size: A4 landscape/u);
assert.match(css, /@page adaptivePortrait \{ size: A4 portrait/u);
assert.match(page, /from\('pa_inquiries'\)\.select\('event_date'\)/u);
assert.match(page, /from\('pa_case_progress'\)\.select\('confirmed_event_date'\)/u);
assert.doesNotMatch(page, /new Date/u, 'event date must never fall back to print/current date');
assert.match(portal, /stagePlotEventDate = String\(progress\?\.confirmed_event_date \|\| item\.event_date \|\| ""\)/u);
assert.match(portal, /state\.metadata\.eventDate = stagePlotEventDate/u);
assert.match(persistence, /state\.schemaVersion = 2/u);

const logo = fs.readFileSync(path.join(root, 'img', 'ara-tech-logo-horizontal-black.png'));
assert.equal(logo.subarray(1, 4).toString('ascii'), 'PNG');
assert.ok(logo.length > 1000);
assert.equal(fs.readdirSync(path.join(root, 'api')).filter(name => name.endsWith('.js')).length, 12);
assert.equal(fs.readdirSync(path.join(root, 'supabase', 'migrations')).some(name => /phase1d/iu.test(name)), false);

const baseHtml = execFileSync('git', ['show', 'bc2b1a06743845317aed6c02287520a747e126c0:pa-stage-plot-editor.html'], { cwd: root, encoding: 'utf8' });
const stageFragment = value => (value.match(/<div class="stage">[\s\S]*?<\/div>\s*\n\s*<aside class="carry">/u)?.[0].replace(/\s*<aside class="carry">$/u, '') || '').replace(/\r\n/gu, '\n');
const baselineStage = stageFragment(baseHtml);
const candidateStage = stageFragment(html);
assert.ok(baselineStage.length > 1000);
assert.equal(crypto.createHash('sha256').update(candidateStage).digest('hex'), crypto.createHash('sha256').update(baselineStage).digest('hex'), 'Production stage canvas markup changed');

console.log('PASS validate-pa-stage-plot-phase1d');
