import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'file:///C:/Users/user/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';

const [, , baseUrl, outputDir] = process.argv;
if (!baseUrl || !outputDir) throw new Error('usage: node stage-plot-production-review-phase-a-audit.mjs <baseUrl> <outputDir>');
await fs.mkdir(outputDir, { recursive: true });
const caseA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const caseB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const caseMap = {
  [caseA]: { event_name: 'CASE A EVENT', event_date: '2026-10-01' },
  [caseB]: { event_name: 'CASE B EVENT', event_date: '2026-11-02' },
};

const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', headless: true });
const context = await browser.newContext({ viewport: { width: 1500, height: 1100 }, deviceScaleFactor: 1, acceptDownloads: true });
await context.addInitScript(({ cases }) => {
  localStorage.removeItem('ara-tech-stage-plot-editor-ui:v1');
  localStorage.removeItem('ara-tech-stage-plot-library-ui:v1');
  localStorage.removeItem('ara-tech-stage-plot-user-presets:v1');
  const from = table => {
    const query = { table, value: '' };
    query.select = () => query;
    query.eq = (_field, value) => { query.value = value; return query; };
    query.is = () => query;
    query.maybeSingle = async () => {
      const item = cases[query.value] || {};
      return { data: table === 'pa_case_progress' ? { confirmed_event_date: item.event_date || '' } : item, error: null };
    };
    return query;
  };
  window.__ARA_STAGE_PLOT_PAGE_TEST_DEPS__ = {
    createClient: () => ({ auth: { getSession: async () => ({ data: { session: { access_token: 'phase-a-local' } } }) }, from }),
    persistence: {
      list: async () => [],
      create: async (_id, state) => ({ id: crypto.randomUUID(), current_revision: 1, state }),
      save: async (_id, plotId, state) => ({ id: plotId, current_revision: 2, state }),
    },
  };
}, { cases: caseMap });

const page = await context.newPage();
page.setDefaultTimeout(10000);
const errors = [];
page.on('pageerror', error => errors.push(String(error)));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
const checks = {};
const debug = {};
const record = (name, value) => { checks[name] = Boolean(value); };
const url = (caseId, extra = '') => baseUrl + '/pa-stage-plot-editor.html?caseId=' + caseId + extra;
const ready = () => page.waitForFunction(() => window.StagePlotEditor && window.StagePlotPage);
const snapshot = () => page.evaluate(() => window.StagePlotEditor.snapshot());
const selectIds = ids => page.evaluate(value => window.StagePlotEditor.selectIds(value), ids);
const action = name => page.evaluate(value => window.StagePlotEditor.runAction(value), name);
const setField = (name, value) => page.evaluate(([key, next]) => window.StagePlotEditor.setField(key, next), [name, value]);
const setGeometry = (name, value) => page.evaluate(([key, next]) => window.StagePlotEditor.setGeometry(key, next), [name, value]);
const getObject = id => page.evaluate(value => window.StagePlotEditor.snapshot().objects.find(item => item.id === value), id);

await page.goto(url(caseA), { waitUntil: 'networkidle' });
await ready();
const firstA = await snapshot();
await page.screenshot({ path: path.join(outputDir, '01_editor_default_100.png'), fullPage: false, animations: 'disabled' });
await page.goto(url(caseB), { waitUntil: 'networkidle' });
await ready();
const onlyB = await snapshot();
await page.goto(url(caseA), { waitUntil: 'networkidle' });
await ready();
const secondA = await snapshot();
record('case A B A metadata isolation', firstA.metadata.eventName === 'CASE A EVENT' && firstA.metadata.eventDate === '2026-10-01' && onlyB.metadata.eventName === 'CASE B EVENT' && secondA.metadata.eventName === 'CASE A EVENT');
record('generic performer blank', secondA.metadata.performerName === '' && secondA.metadata.performanceOrder === '');
record('order dropdown', await page.locator('.meta-form select').evaluate(node => [...node.options].map(option => option.value).join(',') === ',1,2,3,4,5,6'));
record('left panel document flow', await page.locator('.panel.left').evaluate(node => { const s = getComputedStyle(node); return s.overflowY === 'visible' && s.maxHeight === 'none' && s.position === 'static'; }));

const fixture = [
  { id: 'a', type: 'rect', x: 90, y: 90, width: 80, height: 40, rotation: 0, scale: 100, label: 'A', fontSize: 11, category: 'unspecified', strokeWidth: 2, labelEdited: true, className: '', html: '<div class="rect">A</div>' },
  { id: 'b', type: 'circle', x: 650, y: 110, width: 60, height: 60, rotation: 0, scale: 100, label: 'B', fontSize: 11, category: 'brought', strokeWidth: 2, labelEdited: true, className: '', html: '<div class="circle">B</div>' },
  { id: 'c', type: 'rect', x: 360, y: 210, width: 74, height: 44, rotation: 0, scale: 100, label: 'C', fontSize: 11, category: 'rental', strokeWidth: 2, labelEdited: true, className: '', html: '<div class="rect">C</div>' },
];
await page.evaluate(objects => {
  const next = window.StagePlotEditor.snapshot();
  next.objects = objects;
  next.equipment = { brought: [], venue_borrow: [], rental: [], unspecified: [], order: { brought: [], venue_borrow: [], rental: [], unspecified: [] } };
  window.StagePlotEditor.loadSnapshot(next, { rememberPrevious: false, source: 'phase-a-fixture' });
}, fixture);

await selectIds(['a']);
const provisionButtons = page.locator('.provision-segments button');
record('provision four state UI', await provisionButtons.count() === 4);
const provisionColors = await provisionButtons.evaluateAll(nodes => nodes.map(node => ({ background: getComputedStyle(node).backgroundColor, border: getComputedStyle(node).borderColor })));
record('provision colors unique', new Set(provisionColors.map(item => item.background + '/' + item.border)).size === 4);
record('provision help', (await page.locator('.provision-help').textContent()).includes('会場借用＝会場常設機材'));
for (const kind of ['unspecified', 'brought', 'venue_borrow', 'rental']) {
  await setField('category', kind);
  record('list sync ' + kind, await page.locator('#' + ({ unspecified: 'unspecifiedList', brought: 'carryList', venue_borrow: 'venueBorrowList', rental: 'rentalList' }[kind]) + ' [data-source="auto"] input').evaluateAll(nodes => nodes.some(node => node.value === 'A')));
}
await page.screenshot({ path: path.join(outputDir, '02_provision_four_states_100.png'), fullPage: false, animations: 'disabled' });

await selectIds(['a']);
const toolbarText = () => page.locator('.selection-toolbar > button, .selection-toolbar > span > button').allTextContents();
const one = await toolbarText();
record('single toolbar', one.join('|') === 'Lock|Mirror|Mirror＋');
await page.screenshot({ path: path.join(outputDir, '03_single_select_toolbar_100.png'), fullPage: false, animations: 'disabled' });
await selectIds(['a', 'b']);
const two = await toolbarText();
record('two toolbar', two.includes('Group') && two.includes('整列') && two.includes('Center') && !two.includes('等間隔配置'));
await selectIds(['a', 'b', 'c']);
const three = await toolbarText();
record('three toolbar', three.includes('等間隔配置') && !three.includes('Center'));

await selectIds(['a', 'b']);
await action('group-toggle');
record('group active', await page.locator('.selection-toolbar .group-toggle.is-active').count() === 1);
await action('lock');
record('lock active', await page.locator('.selection-toolbar .lock-toggle.is-active').count() === 1 && await page.locator('.selection-lock-indicator').count() === 1);
await page.screenshot({ path: path.join(outputDir, '04_group_lock_states_100.png'), fullPage: false, animations: 'disabled' });
await selectIds([]);
record('no unselected lock icon', await page.locator('.selection-lock-indicator').count() === 0 && await page.locator('.engine-object.locked').evaluateAll(nodes => nodes.every(node => getComputedStyle(node, '::before').content === 'none')));
await selectIds(['a']); await action('lock'); await action('group-toggle');
record('unlock and ungroup', !(await getObject('a')).locked && !(await getObject('a')).groupId);

await selectIds(['a', 'b', 'c']);
await action('align-menu');
record('align six menu', await page.locator('.align-menu:not([hidden]) button').count() === 6);
await page.screenshot({ path: path.join(outputDir, '05_align_distribute_menu_100.png'), fullPage: false, animations: 'disabled' });
await action('distribute-menu');
record('distribute two menu', await page.locator('.distribute-menu:not([hidden]) button').count() === 2);

await selectIds(['a', 'b']);
await page.evaluate(() => window.StagePlotEditor.setKeyObject('a'));
const keyBefore = await getObject('a');
await action('align-left');
const keyAfter = await getObject('a');
record('key object fixed by align', keyBefore.x === keyAfter.x && await page.locator('[data-id="a"].key-object').count() === 1);
await page.evaluate(() => {
  const next = window.StagePlotEditor.snapshot();
  Object.assign(next.objects.find(item => item.id === 'a'), { x: 120, y: 100 });
  Object.assign(next.objects.find(item => item.id === 'b'), { x: 630, y: 180 });
  window.StagePlotEditor.loadSnapshot(next, { rememberPrevious: false, source: 'center-fixture' });
  window.StagePlotEditor.selectIds(['a', 'b']);
  window.StagePlotEditor.setKeyObject('a');
});
const centerKeyBefore = await getObject('a');
const otherBefore = await getObject('b');
await action('center-equidistance');
const centerKeyAfter = await getObject('a');
const otherAfter = await getObject('b');
record('center key fixed', centerKeyBefore.x === centerKeyAfter.x && centerKeyBefore.y === centerKeyAfter.y);
record('center sides and y preserved', centerKeyAfter.x < 415 && otherAfter.x > 415 && otherAfter.y === otherBefore.y);
await page.screenshot({ path: path.join(outputDir, '06_center_key_object_100.png'), fullPage: false, animations: 'disabled' });
await page.evaluate(() => { const next = window.StagePlotEditor.snapshot(); Object.assign(next.objects.find(item => item.id === 'b'), { x: 250 }); window.StagePlotEditor.loadSnapshot(next, { rememberPrevious: false }); window.StagePlotEditor.selectIds(['a','b']); window.StagePlotEditor.setKeyObject('a'); });
const sameBefore = await getObject('b'); await action('center-equidistance');
record('center same side blocked', (await getObject('b')).x === sameBefore.x && (await page.locator('.editor-toast').textContent()).includes('中央線'));

await selectIds(['a']); const mirrorBefore = await getObject('a'); await action('mirror'); const mirrorAfter = await getObject('a');
record('mirror regression', Math.abs((mirrorBefore.x + mirrorBefore.width / 2) + (mirrorAfter.x + mirrorAfter.width / 2) - 830) < 0.01);
const countBeforeClone = (await snapshot()).objects.length; await action('mirror-duplicate');
record('mirror plus regression', (await snapshot()).objects.length === countBeforeClone + 1);

await page.evaluate(() => { const next = window.StagePlotEditor.snapshot(); next.objects = [{ id:'edge', type:'monitor', x:300, y:200, width:56, height:46, rotation:30, scale:200, label:'EDGE', fontSize:11, category:'rental', strokeWidth:2.5, labelEdited:true, className:'', html:'<svg class="mon-svg" viewBox="0 0 220 180"><rect x="30" y="34" width="160" height="112" fill="#fff" stroke="#000" stroke-width="9"/><polygon points="38,38 182,38 110,112" fill="#000"/></svg>' }]; window.StagePlotEditor.loadSnapshot(next,{rememberPrevious:false}); window.StagePlotEditor.selectIds(['edge']); });
await setGeometry('y', 999); let edgeBounds = await page.evaluate(() => window.StagePlotEditor.selectionBounds());
record('audience boundary', Math.abs(edgeBounds.bottom - 500) < 0.05);
await setGeometry('x', 999); edgeBounds = await page.evaluate(() => window.StagePlotEditor.selectionBounds()); record('right boundary', Math.abs(edgeBounds.right - 830) < 0.05);
await setGeometry('x', -999); edgeBounds = await page.evaluate(() => window.StagePlotEditor.selectionBounds()); record('left boundary', Math.abs(edgeBounds.left) < 0.05);
await setGeometry('y', -999); edgeBounds = await page.evaluate(() => window.StagePlotEditor.selectionBounds()); record('top boundary', Math.abs(edgeBounds.top) < 0.05);

const strokeValues = [];
for (const value of [0.5,1,1.5,2,2.5,3,3.5,4,4.5]) {
  await setField('strokeWidth', value);
  strokeValues.push(await page.locator('[data-id="edge"]').evaluate(node => ({ value: node.style.getPropertyValue('--object-stroke-width'), rendered: getComputedStyle(node.querySelector('.mon-svg rect')).strokeWidth })));
}
record('fractional stroke increments', new Set(strokeValues.map(item => item.value)).size === 9 && new Set(strokeValues.map(item => item.rendered)).size === 9);
await page.screenshot({ path: path.join(outputDir, '08_stroke_fractional_100.png'), fullPage: false, animations: 'disabled' });

await page.locator('#equipmentLibraryLauncher').click();
await page.locator('#presetEditToggle').click();
record('preset edit mode', await page.locator('#presetEditPanel').isVisible());
await page.locator('#customPresetSelect').selectOption('builtin:roland-jc-120');
await page.locator('#presetNameInput').fill('JC-120 REVIEW');
await page.locator('#presetDescriptionInput').fill('開発用内蔵プリセット説明');
await page.locator('#renamePreset').click();
let presets = await page.evaluate(() => window.StagePlotEditor.presets());
record('builtin rename and description', presets.some(item => item.id === 'builtin:roland-jc-120' && item.name === 'JC-120 REVIEW' && item.description.includes('内蔵')));
await page.screenshot({ path: path.join(outputDir, '07_preset_edit_mode_100.png'), fullPage: false, animations: 'disabled' });
page.once('dialog', dialog => dialog.accept());
await page.locator('#deleteCustomPreset').click();
presets = await page.evaluate(() => window.StagePlotEditor.presets());
record('builtin delete tombstone', !presets.some(item => item.id === 'builtin:roland-jc-120'));
record('component count hidden', !(await page.locator('#equipmentLibraryItems').textContent()).includes('components'));

await page.evaluate(() => { const next = window.StagePlotEditor.snapshot(); next.objects = [{ id:'preset-source', type:'rect', x:200, y:150, width:90, height:45, rotation:0, scale:100, label:'CUSTOM', fontSize:11, category:'venue_borrow', strokeWidth:1.5, labelEdited:true, className:'', html:'<div class="rect">CUSTOM</div>' }]; window.StagePlotEditor.loadSnapshot(next,{rememberPrevious:false}); window.StagePlotEditor.selectIds(['preset-source']); });
if ((await page.locator('#equipmentLibraryLauncher').getAttribute('aria-expanded')) !== 'true') await page.locator('#equipmentLibraryLauncher').click();
if ((await page.locator('#presetEditToggle').getAttribute('aria-pressed')) !== 'true') await page.locator('#presetEditToggle').click();
await page.locator('#presetNameInput').fill('Custom Review');
await page.locator('#presetDescriptionInput').fill('custom description');
await page.locator('#createCustomPreset').click();
presets = await page.evaluate(() => window.StagePlotEditor.presets());
const custom = presets.find(item => item.name === 'Custom Review');
record('custom create description', custom && custom.origin === 'custom' && custom.description === 'custom description');
await page.locator('#presetNameInput').fill('Custom Renamed'); await page.locator('#renamePreset').click();
presets = await page.evaluate(() => window.StagePlotEditor.presets());
record('custom stable id rename', presets.some(item => item.id === custom.id && item.name === 'Custom Renamed'));
page.once('dialog', dialog => dialog.accept()); await page.locator('#updateCustomPreset').click();
record('custom update', (await page.evaluate(() => window.StagePlotEditor.presets())).some(item => item.id === custom.id));
page.once('dialog', dialog => dialog.accept()); await page.locator('#deleteCustomPreset').click();
record('custom delete', !(await page.evaluate(() => window.StagePlotEditor.presets())).some(item => item.id === custom.id));

await page.evaluate(() => { const next = window.StagePlotEditor.snapshot(); next.metadata.performerName = 'THE ABC'; next.metadata.performanceOrder = '3番目'; next.objects = [{ id:'legacy', type:'rect', x:200,y:100,width:80,height:40,rotation:0,scale:100,label:'LEGACY',fontSize:11,category:'requested',strokeWidth:2,labelEdited:true,className:'',html:'<div class="rect">LEGACY</div>' }]; next.equipment = { brought: [], requested:[{id:'old',name:'旧手配',qty:'1'}], order:{brought:[],requested:[]} }; window.StagePlotEditor.loadSnapshot(next,{rememberPrevious:false}); });
const legacy = await snapshot();
record('legacy performer and order preserved', legacy.metadata.performerName === 'THE ABC' && legacy.metadata.performanceOrder === '3');
record('legacy requested unspecified', legacy.objects[0].category === 'unspecified' && legacy.equipment.unspecified.some(item => item.name === '旧手配'));
record('JSON canonical', Object.hasOwn(legacy.equipment, 'venue_borrow') && !Object.hasOwn(legacy.equipment, 'requested'));
const png = await page.evaluate(() => window.StagePlotEditor.stagePng());
record('PNG export', png.startsWith('data:image/png') && png.length > 1000);
const pdfPath = path.join(outputDir, 'phase-a-review.pdf');
await page.pdf({ path: pdfPath, format: 'A4', landscape: true, printBackground: true });
record('PDF export', (await fs.stat(pdfPath)).size > 5000);

record('no fatal errors', errors.length === 0);
debug.errors = errors;
debug.strokeValues = strokeValues;
const result = { total: Object.keys(checks).length, passed: Object.values(checks).filter(Boolean).length, failed: Object.values(checks).filter(value => !value).length, checks, debug };
await fs.writeFile(path.join(outputDir, 'phase-a-audit.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
await browser.close();
if (result.failed) process.exitCode = 1;
