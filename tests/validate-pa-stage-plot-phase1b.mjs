import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  StagePlotApiError,
  StagePlotPersistenceClient,
  normalizeCanonicalState,
  parseStagePlotRoute,
} from '../js/stage-plot/stage-plot-persistence.mjs';
import { StagePlotPage, bootStagePlotPage } from '../js/stage-plot/stage-plot-page.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const html = read('pa-stage-plot-editor.html');
const css = read('css/stage-plot-editor.css');
const engine = read('js/stage-plot/stage-plot-editor.js');
const portalHtml = read('pa-case-portal.html');
const portalJs = read('js/pa-case-portal.js');
const vercel = JSON.parse(read('vercel.json'));

const caseId = '11111111-1111-4111-8111-111111111111';
const plotId = '22222222-2222-4222-8222-222222222222';
assert.deepEqual(parseStagePlotRoute(`?caseId=${caseId}`), { ok: true, caseId, plotId: '', mode: 'new' });
assert.deepEqual(parseStagePlotRoute(`?caseId=${caseId}&plotId=${plotId}`), { ok: true, caseId, plotId, mode: 'edit' });
assert.equal(parseStagePlotRoute('?caseId=nope').code, 'invalid_case_id');
assert.equal(parseStagePlotRoute(`?caseId=${caseId}&plotId=nope`).code, 'invalid_plot_id');

const oldJson = {
  version: 25,
  metadata: { eventName: 'Event' },
  objects: [{ id: 'object-1', type: 'text', x: 1, y: 2, rotation: 15, scale: 120, fontSize: 72, label: 'Label' }],
  equipment: { brought: [], requested: [] },
  notes: 'note', otherRequests: 'request',
  audio: [{ id: 'audio-1', fileName: 'song.wav', mimeType: 'audio/wav', objectUrl: 'blob:must-not-persist' }],
  setlist: [{ id: 'row-1', title: 'Song', audioRef: 'audio:audio-1' }],
};
const canonical = normalizeCanonicalState(oldJson);
assert.equal(canonical.schemaVersion, 1);
assert.equal(canonical.objects[0].fontSize, 72);
assert.equal(canonical.audio[0].fileName, 'song.wav');
assert.equal('objectUrl' in canonical.audio[0], false);
assert.equal(canonical.setlist[0].audioId, 'audio-1');
assert.equal(canonical.setlist[0].playbackMode, 'file');

const requests = [];
const client = new StagePlotPersistenceClient({
  getAccessToken: async () => 'test-token',
  fetchImpl: async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { id: plotId, current_revision: 1, state: canonical } }) };
  },
});
await client.create(caseId, oldJson);
await client.get(caseId, plotId);
await client.list(caseId);
await client.save(caseId, plotId, oldJson);
assert.deepEqual(requests.map(item => item.action), ['stage_plot_create', 'stage_plot_get', 'stage_plot_list', 'stage_plot_save']);
assert.equal(requests[0].state.schemaVersion, 1);
assert.equal(requests[1].inquiry_id, caseId);
assert.equal(requests[1].stage_plot_id, plotId);

const unauthorized = new StagePlotPersistenceClient({
  getAccessToken: async () => '',
  fetchImpl: async () => { throw new Error('must not fetch'); },
});
await assert.rejects(() => unauthorized.list(caseId), error => error instanceof StagePlotApiError && error.code === 'not_authorized');

function editorFixture(state = canonical) {
  let current = structuredClone(state);
  const loads = [];
  return {
    loads,
    snapshot: () => structuredClone(current),
    loadSnapshot: (next, options) => { current = structuredClone(next); loads.push({ next: structuredClone(next), options }); },
  };
}

function nodeFixture() {
  return { textContent: '', dataset: {}, disabled: false, addEventListener() {} };
}

const editor = editorFixture();
const historyCalls = [];
let createCalls = 0;
let saveCalls = 0;
let releaseCreate;
const delayedCreate = new Promise(resolve => { releaseCreate = resolve; });
const persistence = {
  create: async () => { createCalls += 1; await delayedCreate; return { id: plotId, current_revision: 1, state: canonical }; },
  save: async (_caseId, _plotId, state) => { saveCalls += 1; return { id: plotId, current_revision: 2, state }; },
};
const page = new StagePlotPage({
  route: parseStagePlotRoute(`?caseId=${caseId}`), editor, persistence,
  historyImpl: { replaceState: (...args) => historyCalls.push(args) },
  locationImpl: { pathname: '/pa-stage-plot-editor.html' },
  saveButton: nodeFixture(), saveStatus: nodeFixture(),
});
page.initialize();
assert.equal(page.mode, 'new');
assert.equal(page.dirty, true);
const firstSave = page.save();
const duplicateSave = page.save();
releaseCreate();
await Promise.all([firstSave, duplicateSave]);
assert.equal(createCalls, 1);
assert.equal(page.mode, 'edit');
assert.equal(page.plotId, plotId);
assert.equal(page.revision, 1);
assert.equal(page.dirty, false);
assert.match(historyCalls[0][2], new RegExp(`caseId=${caseId}.*plotId=${plotId}`));

const changed = { ...canonical, notes: 'changed' };
page.handleEditorChange({ source: 'edit', state: changed });
assert.equal(page.dirty, true);
editor.loadSnapshot(changed, { source: 'test' });
await page.save();
assert.equal(saveCalls, 1);
assert.equal(page.revision, 2);
assert.equal(page.dirty, false);
const leaveEvent = { prevented: false, returnValue: undefined, preventDefault() { this.prevented = true; } };
page.beforeUnload(leaveEvent);
assert.equal(leaveEvent.prevented, false);
page.handleEditorChange({ source: 'edit', state: { ...canonical, notes: 'dirty-again' } });
page.beforeUnload(leaveEvent);
assert.equal(leaveEvent.prevented, true);

const failurePage = new StagePlotPage({
  route: parseStagePlotRoute(`?caseId=${caseId}`), editor: editorFixture(),
  persistence: { create: async () => { throw new StagePlotApiError('service_unavailable', 503); } },
  historyImpl: { replaceState() {} }, locationImpl: { pathname: '/pa-stage-plot-editor.html' },
  saveButton: nodeFixture(), saveStatus: nodeFixture(),
});
failurePage.initialize();
await assert.rejects(() => failurePage.save(), /service_unavailable/);
assert.equal(failurePage.dirty, true);
assert.equal(failurePage.saveStatus.textContent, '保存失敗');

const editEditor = editorFixture();
const editPage = new StagePlotPage({
  route: parseStagePlotRoute(`?caseId=${caseId}&plotId=${plotId}`), editor: editEditor, persistence,
  historyImpl: { replaceState() {} }, locationImpl: { pathname: '/pa-stage-plot-editor.html' },
  saveButton: nodeFixture(), saveStatus: nodeFixture(),
});
editPage.initialize({ id: plotId, case_id: caseId, current_revision: 7, state: canonical });
assert.equal(editPage.mode, 'edit');
assert.equal(editPage.revision, 7);
assert.equal(editPage.dirty, false);
assert.equal(editEditor.loads[0].next.schemaVersion, 1);

const classes = new Set(['stage-plot-auth-pending']);
const messageNode = nodeFixture();
globalThis.document = {
  body: { classList: { add: value => classes.add(value), remove: (...values) => values.forEach(value => classes.delete(value)) } },
  getElementById: id => id === 'stagePlotAccessMessage' ? messageNode : nodeFixture(),
};
let guardedApiCalls = 0;
let guardedEngineLoads = 0;
const guardedWindow = {
  location: { search: `?caseId=${caseId}`, pathname: '/pa-stage-plot-editor.html' },
  history: { replaceState() {} }, addEventListener() {},
};
const guardedResult = await bootStagePlotPage({
  authClient: { auth: { getSession: async () => ({ data: { session: null } }) } },
  persistence: { list: async () => { guardedApiCalls += 1; } },
  loadEngine: async () => { guardedEngineLoads += 1; },
  windowImpl: guardedWindow,
  documentImpl: globalThis.document,
});
assert.equal(guardedResult.code, 'not_authorized');
assert.equal(guardedApiCalls, 0);
assert.equal(guardedEngineLoads, 0);
assert.equal(classes.has('stage-plot-auth-denied'), true);

assert.match(html, /id="stagePlotSaveBtn"/);
assert.match(html, /stage-plot-page\.mjs/);
assert.doesNotMatch(html, /canonical-engine\.js/);
assert.match(engine, /schemaVersion:\s*1/);
assert.match(engine, /const HISTORY_LIMIT = 500/);
assert.match(engine, /fontSize: number\([^\n]+8, 72\)/);
assert.match(engine, /const TOOLS = \['rect', 'circle', 'line', 'arrow', 'text', 'microphone', 'monitor', 'power'\]/);
assert.match(engine, /window\.print\(\)/);
assert.match(engine, /enterMobileEdit/);
assert.match(engine, /ファイル未接続/);
assert.match(css, /adaptive-equipment/);
assert.match(css, /@page stageSheet \{ size: A4 landscape/);
assert.match(css, /print-setlist-page/);
assert.match(css, /body\.mobile-stage-edit/);
assert.match(engine, /const TYPES = \['曲', 'SE', 'MC', 'BGM', 'End SE', 'その他'\]/);
assert.equal((html.match(/id="historyCount"/g) || []).length, 1);

const editorHeaders = vercel.headers.find(item => item.source === '/pa-stage-plot-editor.html');
assert.ok(editorHeaders);
assert.match(JSON.stringify(editorHeaders), /no-store/);
assert.match(JSON.stringify(editorHeaders), /frame-ancestors 'self'/);
assert.equal(portalHtml.includes('stage-plot-admin-area'), true);
assert.match(portalJs, /stage_plot_(?:list|get)/);

console.log('PASS validate-pa-stage-plot-phase1b');
