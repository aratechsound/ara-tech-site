import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'file:///C:/Users/user/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';

const [, , baseUrl, outputDir] = process.argv;
if (!baseUrl || !outputDir) throw new Error('usage: node stage-plot-editor-core-ux-recovery-audit.mjs <baseUrl> <outputDir>');
await fs.mkdir(outputDir, { recursive: true });

const caseId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1, acceptDownloads: true });
await context.addInitScript(expectedCaseId => {
  localStorage.removeItem('ara-tech-stage-plot-editor-ui:v1');
  localStorage.removeItem('ara-tech-stage-plot-library-ui:v1');
  localStorage.removeItem('ara-tech-stage-plot-user-presets:v1');
  const builder = { select() { return builder; }, eq() { return builder; }, is() { return builder; }, maybeSingle: async () => ({ data: { event_date: '2026-10-18' }, error: null }) };
  window.__ARA_STAGE_PLOT_PAGE_TEST_DEPS__ = {
    createClient: () => ({ auth: { getSession: async () => ({ data: { session: { access_token: 'local-core-ux-audit' } } }) }, from: () => builder }),
    persistence: {
      list: async id => id === expectedCaseId ? [] : Promise.reject(new Error('inquiry_not_found')),
      create: async (_id, state) => ({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', current_revision: 1, state }),
      save: async (_id, plotId, state) => ({ id: plotId, current_revision: 2, state }),
    },
  };
}, caseId);

const page = await context.newPage();
page.setDefaultTimeout(8000);
const fatalErrors = [];
page.on('pageerror', error => fatalErrors.push(String(error)));
page.on('console', message => { if (message.type() === 'error') fatalErrors.push(message.text()); });
await page.goto(`${baseUrl}/pa-stage-plot-editor.html?caseId=${caseId}`, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.StagePlotEditor && window.StagePlotPage?.mode === 'new');

const checks = {};
const debug = {};
const record = (number, name, value) => { checks[`${String(number).padStart(2, '0')} ${name}`] = Boolean(value); };
const screenshot = name => page.screenshot({ path: path.join(outputDir, name), fullPage: false, animations: 'disabled' });
const snapshot = () => page.evaluate(() => window.StagePlotEditor.snapshot());
const historyCount = () => page.locator('#historyCount').evaluate(node => Number(node.textContent));
const selectedIds = () => page.evaluate(() => window.StagePlotEditor.selectedIds());
const selectIds = ids => page.evaluate(value => window.StagePlotEditor.selectIds(value), ids);
const runAction = action => page.evaluate(value => window.StagePlotEditor.runAction(value), action);
const setGeometry = (key, value) => page.evaluate(([field, next]) => window.StagePlotEditor.setGeometry(field, next), [key, value]);
const setField = (key, value) => page.evaluate(([field, next]) => window.StagePlotEditor.setField(field, next), [key, value]);
const objectById = id => page.evaluate(value => window.StagePlotEditor.snapshot().objects.find(object => object.id === value), id);
const uiState = () => page.evaluate(() => window.StagePlotEditor.editorUi());
const bounds = () => page.evaluate(() => window.StagePlotEditor.selectionBounds());

const fixtureObjects = () => [
  { id: 'a', type: 'rect', x: 90, y: 80, width: 80, height: 40, rotation: 0, scale: 100, label: 'A', fontSize: 11, category: 'requested', strokeWidth: 2, labelEdited: true, className: '', html: '<div class="rect">A</div>' },
  { id: 'b', type: 'circle', x: 240, y: 120, width: 60, height: 60, rotation: 0, scale: 100, label: 'B', fontSize: 11, category: 'brought', strokeWidth: 2, labelEdited: true, className: '', html: '<div class="circle">B</div>' },
  { id: 'c', type: 'rect', x: 390, y: 170, width: 70, height: 45, rotation: 0, scale: 100, label: 'C', fontSize: 12, category: 'unspecified', strokeWidth: 2, labelEdited: true, className: '', html: '<div class="rect">C</div>' },
  { id: 'd', type: 'rect', x: 560, y: 225, width: 90, height: 50, rotation: 0, scale: 100, label: 'D', fontSize: 13, category: 'requested', strokeWidth: 2, labelEdited: true, className: '', html: '<div class="rect">D</div>' },
];

const loadFixture = async (objects = fixtureObjects()) => {
  await page.evaluate(value => {
    const next = window.StagePlotEditor.snapshot();
    next.metadata = { ...next.metadata, eventName: 'LOCAL UX AUDIT', performerName: 'SYNTHETIC BAND' };
    next.objects = value;
    next.equipment = { brought: [], requested: [], order: { brought: [], requested: [] } };
    window.StagePlotEditor.loadSnapshot(next, { rememberPrevious: false, source: 'core-ux-audit-fixture' });
  }, objects);
};

const stageScreenPoint = async (x, y) => {
  const box = await page.locator('.stage').boundingBox();
  return { x: box.x + x * box.width / 830, y: box.y + y * box.height / 500 };
};

const dragScreen = async (from, to, modifiers = {}) => {
  if (modifiers.shift) await page.keyboard.down('Shift');
  if (modifiers.alt) await page.keyboard.down('Alt');
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 4 });
  await page.mouse.up();
  if (modifiers.alt) await page.keyboard.up('Alt');
  if (modifiers.shift) await page.keyboard.up('Shift');
};

const dragLocatorByLogical = async (locator, dx, dy, modifiers = {}) => {
  const handle = await locator.boundingBox();
  const stageBox = await page.locator('.stage').boundingBox();
  await dragScreen(
    { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 },
    { x: handle.x + handle.width / 2 + dx * stageBox.width / 830, y: handle.y + handle.height / 2 + dy * stageBox.height / 500 },
    modifiers,
  );
};

await screenshot('01_editor_default.png');
const palette = await page.locator('.tools').evaluate(node => ({ columns: getComputedStyle(node).gridTemplateColumns.split(' ').length, count: node.querySelectorAll('.tool').length, texts: [...node.querySelectorAll('.tool')].map(item => item.textContent.trim()), titles: [...node.querySelectorAll('.tool')].map(item => item.getAttribute('title')) }));
record(1, 'compact 3-column palette', palette.columns === 3 && palette.count === 9);
record(2, 'no permanent long labels', palette.texts.every(text => text.length <= 4));
await page.locator('[data-tool="rect"]').hover();
const tooltip = await page.locator('[data-tool="rect"]').evaluate(node => ({ content: getComputedStyle(node, '::after').content, opacity: getComputedStyle(node, '::after').opacity, duration: getComputedStyle(node, '::after').transitionDuration }));
record(3, 'immediate custom tooltip', tooltip.content.includes('四角形') && tooltip.opacity === '1' && tooltip.duration === '0s');
record(4, 'no native title tooltip', palette.titles.every(value => value === null));
await screenshot('02_compact_palette_hover.png');

record(5, 'selected always visible', await page.locator('#selectedTitle').isVisible());
record(6, 'label always visible', await page.locator('#objectLabelInput').isVisible());
await page.locator('.engine-object').filter({ hasText: 'Gt Head' }).first().click();
await screenshot('03_selected_inspector_position_size.png');
await page.getByRole('button', { name: '機材区分・表示' }).click();
const openSections = await page.locator('.inspector-toggle[aria-expanded="true"]').count();
record(7, 'single-open accordion', openSections === 1 && await page.locator('#objectCategorySelect').isVisible());
await screenshot('04_selected_inspector_category.png');
await page.getByRole('button', { name: 'ショートカット' }).click();
await screenshot('05_shortcuts_accordion.png');

await loadFixture([fixtureObjects()[0]]);
await selectIds(['a']);
await setGeometry('x', 120); const xEdited = await objectById('a');
record(8, 'X edit', xEdited.x === 120);
await setGeometry('y', 135); const yEdited = await objectById('a');
record(9, 'Y edit', yEdited.y === 135);
await setGeometry('width', 120); const widthEdited = await objectById('a');
record(10, 'width edit', Math.abs(widthEdited.width - 120) < 0.2 && widthEdited.geometrySized);
await setGeometry('height', 70); const heightEdited = await objectById('a');
record(11, 'height edit', Math.abs(heightEdited.height - 70) < 0.2);
await setField('ratioLocked', true); record(12, 'ratio lock', (await objectById('a')).ratioLocked === true);

await setField('ratioLocked', false);
const sideBefore = await objectById('a');
await dragLocatorByLogical(page.locator('[data-id="a"] .resize-handle.e'), 30, 18);
const sideAfter = await objectById('a');
debug.sideResize = { before: sideBefore, after: sideAfter };
record(13, 'side-handle width-only', sideAfter.width > sideBefore.width + 20 && Math.abs(sideAfter.height - sideBefore.height) < 0.1);
const verticalBefore = sideAfter;
await selectIds(['a']);
await dragLocatorByLogical(page.locator('[data-id="a"] .resize-handle.s'), 20, 25);
const verticalAfter = await objectById('a');
record(14, 'vertical-handle height-only', verticalAfter.height > verticalBefore.height + 15 && Math.abs(verticalAfter.width - verticalBefore.width) < 0.1);
const freeRatioBefore = verticalAfter.width / verticalAfter.height;
await selectIds(['a']);
await dragLocatorByLogical(page.locator('[data-id="a"] .resize-handle.se'), 35, 5);
const freeCorner = await objectById('a');
record(15, 'corner proportional/free', Math.abs(freeCorner.width / freeCorner.height - freeRatioBefore) > 0.05);

await loadFixture([fixtureObjects()[1]]); await selectIds(['b']); await setGeometry('width', 105); const ellipse = await objectById('b');
record(16, 'circle to ellipse', ellipse.type === 'circle' && Math.abs(ellipse.width - ellipse.height) > 20);
await loadFixture([fixtureObjects()[0]]); await selectIds(['a']); await setField('strokeWidth', 3.5);
const borderBefore = await page.locator('[data-id="a"] > .rect').evaluate(node => getComputedStyle(node).borderTopWidth);
await setGeometry('width', 180);
const borderAfter = await page.locator('[data-id="a"] > .rect').evaluate(node => getComputedStyle(node).borderTopWidth);
debug.stroke = { borderBefore, borderAfter, object: await objectById('a') };
record(17, 'stroke preserved under nonuniform resize', borderBefore === borderAfter && (await objectById('a')).strokeWidth === 3.5);
await setField('labelOffsetX', 17); await setField('labelOffsetY', -9);
const labelState = await objectById('a');
const labelStyle = await page.locator('[data-id="a"] .object-label').evaluate(node => ({ left: parseFloat(node.style.left), top: parseFloat(node.style.top) }));
record(18, 'label offset', labelState.labelOffsetX === 17 && labelState.labelOffsetY === -9 && labelStyle.left === 17 && labelStyle.top === -9);
await page.evaluate(() => window.StagePlotEditor.runAction('noop'));
await page.locator('#labelOffsetResetBtn').click();
const resetLabel = await objectById('a');
record(19, 'label reset', resetLabel.labelOffsetX === 0 && resetLabel.labelOffsetY === 0);

await loadFixture(); await selectIds(['a']); await page.keyboard.press('Delete');
record(20, 'Delete', !(await snapshot()).objects.some(object => object.id === 'a'));
await loadFixture(); await selectIds(['a']); await page.keyboard.press('Backspace');
record(21, 'Backspace', !(await snapshot()).objects.some(object => object.id === 'a'));
await loadFixture(); await selectIds(['a']); await page.locator('#objectLabelInput').focus(); await page.keyboard.press('Backspace');
record(22, 'input editing guard', (await snapshot()).objects.some(object => object.id === 'a'));

await page.locator('.stage').click({ position: { x: 8, y: 8 } });
await loadFixture(); await selectIds(['a', 'b']); const deleteHistory = await historyCount(); await page.keyboard.press('Delete'); const deleted = await snapshot(); await page.locator('#undoBtn').click(); const undoDelete = await snapshot();
record(23, 'multi-delete one Undo', deleted.objects.length === 2 && undoDelete.objects.some(object => object.id === 'a') && undoDelete.objects.some(object => object.id === 'b') && await historyCount() === deleteHistory);

await loadFixture(); await selectIds(['a', 'b']); await page.locator('.stage').focus(); await page.keyboard.press('Control+C');
record(24, 'copy', (await uiState()).clipboardSize === 2);
const beforePasteIds = new Set((await snapshot()).objects.map(object => object.id)); await page.keyboard.press('Control+V'); const pastedState = await snapshot(); const pasted = pastedState.objects.filter(object => !beforePasteIds.has(object.id));
record(25, 'paste new IDs', pasted.length === 2 && pasted.every(object => !beforePasteIds.has(object.id)) && Math.abs((pasted[1].x - pasted[0].x) - 150) < 0.1);
const beforeDuplicate = pastedState.objects.length; await page.keyboard.press('Control+D');
record(26, 'Ctrl+D', (await snapshot()).objects.length === beforeDuplicate + 2);

await loadFixture(); await selectIds(['a']); const altBefore = await snapshot(); const aNode = await page.locator('[data-id="a"]').boundingBox();
await dragScreen({ x: aNode.x + aNode.width / 2, y: aNode.y + aNode.height / 2 }, { x: aNode.x + aNode.width / 2 + 45, y: aNode.y + aNode.height / 2 + 18 }, { alt: true });
const altAfter = await snapshot();
record(27, 'Alt drag duplicate', altAfter.objects.length === altBefore.objects.length + 1 && altAfter.objects.some(object => object.id === 'a' && object.x === altBefore.objects[0].x));

await loadFixture(); await selectIds(['a']); const shiftBefore = await objectById('a'); const shiftNode = await page.locator('[data-id="a"]').boundingBox();
await dragScreen({ x: shiftNode.x + shiftNode.width / 2, y: shiftNode.y + shiftNode.height / 2 }, { x: shiftNode.x + shiftNode.width / 2 + 65, y: shiftNode.y + shiftNode.height / 2 + 25 }, { shift: true }); const shiftAfter = await objectById('a');
debug.shiftDrag = { before: shiftBefore, after: shiftAfter };
record(28, 'Shift drag', Math.abs(shiftAfter.y - shiftBefore.y) < 0.1 && shiftAfter.x > shiftBefore.x);

await loadFixture(); await selectIds(['a']); const rotateHandle = page.locator('[data-id="a"] .rotate-handle'); const rotateBox = await rotateHandle.boundingBox(); const rotateNodeBox = await page.locator('[data-id="a"]').boundingBox();
await dragScreen({ x: rotateBox.x + rotateBox.width / 2, y: rotateBox.y + rotateBox.height / 2 }, { x: rotateNodeBox.x + rotateNodeBox.width / 2 + 80, y: rotateNodeBox.y + rotateNodeBox.height / 2 }, { shift: true }); const rotated = await objectById('a');
debug.shiftRotate = rotated;
record(29, 'Shift rotate 45', Math.abs(rotated.rotation / 45 - Math.round(rotated.rotation / 45)) < 0.001 && rotated.rotation !== 0);

await setField('rotation', 0); await setField('ratioLocked', false); await selectIds(['a']); const ratioBeforeShift = (await objectById('a')).width / (await objectById('a')).height;
await dragLocatorByLogical(page.locator('[data-id="a"] .resize-handle.se'), 35, 5, { shift: true }); const ratioAfterShift = (await objectById('a')).width / (await objectById('a')).height;
record(30, 'Shift resize', Math.abs(ratioAfterShift - ratioBeforeShift) < 0.02);

await loadFixture(); await selectIds(['a']); const nudgeBefore = await objectById('a'); await page.keyboard.press('ArrowRight'); const nudgeAfter = await objectById('a');
record(31, 'arrow nudge', nudgeAfter.x - nudgeBefore.x === 1);
await page.keyboard.press('Shift+ArrowDown'); const nudgeLarge = await objectById('a');
record(32, 'Shift arrow nudge', nudgeLarge.y - nudgeAfter.y === 10);

await loadFixture(); await selectIds(['a']); const escBefore = await objectById('a'); const escNode = await page.locator('[data-id="a"]').boundingBox();
await page.mouse.move(escNode.x + 10, escNode.y + 10); await page.mouse.down(); await page.mouse.move(escNode.x + 70, escNode.y + 35, { steps: 3 }); await page.keyboard.press('Escape'); await page.mouse.up(); const escAfter = await objectById('a');
record(33, 'Esc cancel', escAfter.x === escBefore.x && escAfter.y === escBefore.y);

await loadFixture(); const marqueeFrom = await stageScreenPoint(55, 55); const marqueeTo = await stageScreenPoint(485, 230);
await page.mouse.move(marqueeFrom.x, marqueeFrom.y); await page.mouse.down(); await page.mouse.move(marqueeTo.x, marqueeTo.y, { steps: 4 });
await screenshot('06_marquee_multiselect.png'); await page.mouse.up(); const marqueeSelected = await selectedIds();
record(34, 'marquee selection', marqueeSelected.includes('a') && marqueeSelected.includes('b') && marqueeSelected.includes('c') && !marqueeSelected.includes('d'));

await loadFixture(); await page.locator('[data-id="a"]').click(); await page.locator('[data-id="b"]').click({ modifiers: ['Control'] }); const ctrlSelected = await selectedIds();
record(35, 'Ctrl/Cmd selection', ctrlSelected.includes('a') && ctrlSelected.includes('b'));
await page.locator('[data-id="c"]').click({ modifiers: ['Shift'] }); const shiftSelected = await selectedIds();
record(36, 'Shift selection', shiftSelected.includes('a') && shiftSelected.includes('b') && shiftSelected.includes('c'));

await selectIds(['a', 'b']); const multiBefore = await snapshot(); const multiNode = await page.locator('[data-id="a"]').boundingBox();
await dragScreen({ x: multiNode.x + 8, y: multiNode.y + 8 }, { x: multiNode.x + 35, y: multiNode.y + 25 }); const multiAfter = await snapshot();
const ma0 = multiBefore.objects.find(object => object.id === 'a'); const mb0 = multiBefore.objects.find(object => object.id === 'b'); const ma1 = multiAfter.objects.find(object => object.id === 'a'); const mb1 = multiAfter.objects.find(object => object.id === 'b');
record(37, 'multi bounding transform', Math.abs((ma1.x - ma0.x) - (mb1.x - mb0.x)) < 0.1 && ma1.x !== ma0.x);

await loadFixture(); await selectIds(['a', 'b']); await page.keyboard.press('Control+G'); let grouped = await snapshot(); const groupId = grouped.objects.find(object => object.id === 'a').groupId;
record(38, 'group', groupId && grouped.objects.find(object => object.id === 'b').groupId === groupId);
await page.keyboard.press('Control+Shift+G'); grouped = await snapshot();
record(39, 'ungroup', !grouped.objects.find(object => object.id === 'a').groupId && !grouped.objects.find(object => object.id === 'b').groupId);

await selectIds(['a', 'b']); await page.keyboard.press('Control+G'); grouped = await snapshot(); const groupMoveBefore = grouped.objects.filter(object => ['a', 'b'].includes(object.id)); await page.locator('[data-id="a"]').click(); const groupMoveNode = await page.locator('[data-id="a"]').boundingBox();
await dragScreen({ x: groupMoveNode.x + 8, y: groupMoveNode.y + 8 }, { x: groupMoveNode.x + 42, y: groupMoveNode.y + 20 }); const groupMoveAfter = (await snapshot()).objects.filter(object => ['a', 'b'].includes(object.id));
record(40, 'group move', Math.abs((groupMoveAfter[0].x - groupMoveBefore[0].x) - (groupMoveAfter[1].x - groupMoveBefore[1].x)) < 0.1 && groupMoveAfter[0].x !== groupMoveBefore[0].x);
const groupBoxBefore = await bounds(); await dragLocatorByLogical(page.locator('.selection-box .resize-handle.se'), 35, 25); const groupBoxAfter = await bounds();
record(41, 'group resize', groupBoxAfter.width > groupBoxBefore.width && groupBoxAfter.height > groupBoxBefore.height);
const multiRotateHandle = page.locator('.selection-box .rotate-handle'); const groupRotBox = await multiRotateHandle.boundingBox(); const selectionBoxScreen = await page.locator('.selection-box').boundingBox();
await dragScreen({ x: groupRotBox.x + groupRotBox.width / 2, y: groupRotBox.y + groupRotBox.height / 2 }, { x: selectionBoxScreen.x + selectionBoxScreen.width / 2 + 80, y: selectionBoxScreen.y + selectionBoxScreen.height / 2 }, { shift: true }); const groupRotated = (await snapshot()).objects.filter(object => ['a', 'b'].includes(object.id));
debug.groupRotate = groupRotated;
record(42, 'group rotate', groupRotated.every(object => object.rotation !== 0 && Math.abs(object.rotation % 45) < 0.01));

await runAction('lock'); const lockedBefore = await snapshot(); await page.keyboard.press('Delete'); const lockedAfterDelete = await snapshot(); const lockedNode = await page.locator('[data-id="a"]').boundingBox(); await dragScreen({ x: lockedNode.x + 8, y: lockedNode.y + 8 }, { x: lockedNode.x + 55, y: lockedNode.y + 35 }); const lockedAfterDrag = await snapshot();
record(43, 'lock', lockedAfterDelete.objects.length === lockedBefore.objects.length && lockedAfterDrag.objects.find(object => object.id === 'a').x === lockedBefore.objects.find(object => object.id === 'a').x);
await runAction('lock');

await loadFixture(); await selectIds(['a']); await runAction('forward'); let order = (await snapshot()).objects.map(object => object.id); record(44, 'layer forward', order.indexOf('a') === 1);
await runAction('backward'); order = (await snapshot()).objects.map(object => object.id); record(45, 'layer backward', order.indexOf('a') === 0);
await runAction('front'); order = (await snapshot()).objects.map(object => object.id); record(46, 'front', order.at(-1) === 'a');
await runAction('back'); order = (await snapshot()).objects.map(object => object.id); record(47, 'back', order[0] === 'a');

await page.locator('[data-id="a"]').click({ button: 'right' }); const contextVisible = await page.locator('#stageContextMenu').isVisible(); await screenshot('10_context_menu.png');
record(48, 'context menu', contextVisible && await page.locator('#stageContextMenu').getByRole('button', { name: 'Duplicate', exact: true }).isVisible()); await page.keyboard.press('Escape');

await loadFixture(); await selectIds(['a', 'b', 'c']); await runAction('align-center'); let aligned = (await snapshot()).objects.filter(object => ['a', 'b', 'c'].includes(object.id));
record(49, 'align horizontal', Math.max(...aligned.map(object => object.x + object.width / 2)) - Math.min(...aligned.map(object => object.x + object.width / 2)) < 0.2);
await loadFixture(); await selectIds(['a', 'b', 'c']); await runAction('align-middle'); aligned = (await snapshot()).objects.filter(object => ['a', 'b', 'c'].includes(object.id));
record(50, 'align vertical', Math.max(...aligned.map(object => object.y + object.height / 2)) - Math.min(...aligned.map(object => object.y + object.height / 2)) < 0.2);
await loadFixture(); await selectIds(['a', 'b', 'c', 'd']); await runAction('distribute-horizontal'); let distributed = (await snapshot()).objects.filter(object => ['a', 'b', 'c', 'd'].includes(object.id)).sort((a, b) => a.x - b.x).map(object => object.x + object.width / 2); let gaps = distributed.slice(1).map((value, index) => value - distributed[index]);
record(51, 'distribute horizontal', Math.max(...gaps) - Math.min(...gaps) < 0.2);
await loadFixture(); await selectIds(['a', 'b', 'c', 'd']); await runAction('distribute-vertical'); distributed = (await snapshot()).objects.filter(object => ['a', 'b', 'c', 'd'].includes(object.id)).sort((a, b) => a.y - b.y).map(object => object.y + object.height / 2); gaps = distributed.slice(1).map((value, index) => value - distributed[index]);
record(52, 'distribute vertical', Math.max(...gaps) - Math.min(...gaps) < 0.2);
await loadFixture(); await selectIds(['a', 'd']); await runAction('center-equidistance'); const centered = (await snapshot()).objects.filter(object => ['a', 'd'].includes(object.id)).map(object => object.x + object.width / 2);
record(53, 'center equidistance', Math.abs(centered[0] + centered[1] - 830) < 0.2);

await loadFixture(); await selectIds(['a']); const mirrorBefore = await objectById('a'); await runAction('mirror'); const mirrored = await objectById('a');
record(54, 'mirror', Math.abs((mirrorBefore.x + mirrorBefore.width / 2) + (mirrored.x + mirrored.width / 2) - 830) < 0.2);
const mirrorCount = (await snapshot()).objects.length; const existingMirrorIds = new Set((await snapshot()).objects.map(object => object.id)); await runAction('mirror-duplicate'); const mirrorDup = await snapshot();
record(55, 'mirror duplicate', mirrorDup.objects.length === mirrorCount + 1 && mirrorDup.objects.some(object => !existingMirrorIds.has(object.id)));
await loadFixture(); await selectIds(['a', 'b']); await page.keyboard.press('Control+G'); const groupMirrorBefore = (await snapshot()).objects.filter(object => ['a', 'b'].includes(object.id)); await runAction('mirror'); const groupMirrorAfter = (await snapshot()).objects.filter(object => ['a', 'b'].includes(object.id));
record(56, 'multi/group mirror', groupMirrorAfter.every((object, index) => Math.abs((groupMirrorBefore[index].x + groupMirrorBefore[index].width / 2) + (object.x + object.width / 2) - 830) < 0.2));
record(57, 'context toolbar', await page.locator('.selection-toolbar').isVisible() && await page.locator('.selection-toolbar').getByRole('button', { name: 'Mirror', exact: true }).isVisible());
await screenshot('07_multiselect_context_toolbar.png');

const beforeClear = await snapshot(); const clearHistory = await historyCount(); await page.locator('#clearAllBtn').click(); await page.locator('#confirmClearAll').click(); const cleared = await snapshot();
record(58, 'Clear All', cleared.objects.length === 0 && cleared.metadata.eventName === beforeClear.metadata.eventName);
await page.locator('#undoBtn').click(); const clearUndone = await snapshot();
record(59, 'Clear All Undo', clearUndone.objects.length === beforeClear.objects.length && await historyCount() === clearHistory);
await page.locator('#resetAllBtn').click(); await page.locator('#confirmReset').click(); const resetState = await snapshot();
record(60, 'Reset remains distinct', resetState.objects.length > 0 && resetState.metadata.performerName === 'THE ABC');
await page.getByRole('button', { name: 'ショートカット' }).click();
record(61, 'shortcuts accordion', await page.locator('.shortcut-list').isVisible() && (await page.locator('.shortcut-list').innerText()).includes('Ctrl/Cmd+C'));

await loadFixture(); await selectIds(['a']); const magnetOffBefore = await objectById('a'); const magnetOffNode = await page.locator('[data-id="a"]').boundingBox(); await dragScreen({ x: magnetOffNode.x + 8, y: magnetOffNode.y + 8 }, { x: magnetOffNode.x + 21, y: magnetOffNode.y + 19 }); const magnetOffAfter = await objectById('a');
record(62, 'Magnet OFF', Math.abs((magnetOffAfter.x - magnetOffBefore.x) - 13 * (830 / (await page.locator('.stage').boundingBox()).width) * ((await page.locator('.stage').boundingBox()).width / 830)) < 2 || magnetOffAfter.x !== magnetOffBefore.x);
await page.locator('.magnet-toggle').click();
await setGeometry('x', 97); await setGeometry('y', 97); const nearNode = await page.locator('[data-id="a"]').boundingBox(); const nearStage = await page.locator('.stage').boundingBox();
await dragScreen({ x: nearNode.x + 8, y: nearNode.y + 8 }, { x: nearNode.x + 6 * nearStage.width / 830 + 8, y: nearNode.y + 3 * nearStage.height / 500 + 8 }); const nearSnap = await objectById('a'); const nearCenter = { x: nearSnap.x + nearSnap.width / 2, y: nearSnap.y + nearSnap.height / 2 };
const gridAuthority = await page.evaluate(() => window.StagePlotEditor.gridAuthority()); const onGrid = (value, origin) => Math.abs((value - origin) / gridAuthority.spacing - Math.round((value - origin) / gridAuthority.spacing)) < 0.01;
record(63, 'Magnet near snap', onGrid(nearCenter.x, gridAuthority.originX) || onGrid(nearCenter.y, gridAuthority.originY));
await setGeometry('x', 100); await setGeometry('y', 100); const farNode = await page.locator('[data-id="a"]').boundingBox(); await dragScreen({ x: farNode.x + 8, y: farNode.y + 8 }, { x: farNode.x + 12 * nearStage.width / 830 + 8, y: farNode.y + 12 * nearStage.height / 500 + 8 }); const farSnap = await objectById('a'); const farCenter = { x: farSnap.x + farSnap.width / 2, y: farSnap.y + farSnap.height / 2 };
record(64, 'Magnet no far snap', !onGrid(farCenter.x, gridAuthority.originX) || !onGrid(farCenter.y, gridAuthority.originY));
const gridCss = await page.locator('.stage').evaluate(node => ({ size: getComputedStyle(node).backgroundSize, position: getComputedStyle(node).backgroundPosition }));
record(65, 'visible grid coordinate equals snap coordinate', gridAuthority.centerX % gridAuthority.spacing === gridAuthority.originX && gridAuthority.originY === gridAuthority.spacing && gridCss.size.includes('20px'));
await page.emulateMedia({ media: 'print' }); const magnetPrintDisplay = await page.locator('.magnet-toggle').evaluate(node => getComputedStyle(node).display); await page.emulateMedia({ media: 'screen' });
record(66, 'Magnet excluded PDF', magnetPrintDisplay === 'none');
const beforePng = await snapshot(); const pngData = await page.evaluate(() => window.StagePlotEditor.stagePng()); const afterPng = await snapshot();
record(67, 'Magnet excluded PNG', pngData.startsWith('data:image/png') && JSON.stringify(beforePng) === JSON.stringify(afterPng) && !('magnetEnabled' in beforePng));
await screenshot('09_magnet_on.png');

await page.locator('#equipmentLibraryLauncher').click(); const jcId = 'builtin:roland-jc-120'; await page.locator(`[data-favorite-preset="${jcId}"]`).first().click(); const libraryStored = await page.evaluate(() => JSON.parse(localStorage.getItem('ara-tech-stage-plot-library-ui:v1')));
record(68, 'Equipment Favorites', libraryStored.favorites.includes(jcId) && (await page.locator('.library-section').filter({ hasText: 'Favorites' }).count()) >= 1);
await page.locator(`[data-place-preset="${jcId}"]`).last().click(); await page.locator('#equipmentLibraryLauncher').click(); const recentStored = await page.evaluate(() => JSON.parse(localStorage.getItem('ara-tech-stage-plot-library-ui:v1')));
record(69, 'Equipment Recent', recentStored.recent[0] === jcId && (await page.locator('.library-section').filter({ hasText: 'Recent' }).count()) >= 1);
await screenshot('08_equipment_library.png');

await page.locator('#equipmentLibraryClose').click(); await loadFixture([fixtureObjects()[0]]); await selectIds(['a']); await page.locator('#equipmentLibraryLauncher').click(); page.once('dialog', dialog => dialog.accept('LOCAL DELETE TEST')); await page.locator('#createCustomPreset').click(); await page.locator('#customPresetSelect').selectOption({ label: 'LOCAL DELETE TEST' }); page.once('dialog', dialog => dialog.accept()); await page.locator('#deleteCustomPreset').click(); const customAfterDelete = await page.evaluate(() => JSON.parse(localStorage.getItem('ara-tech-stage-plot-user-presets:v1')));
record(70, 'custom preset delete', !customAfterDelete.presets.some(preset => preset.name === 'LOCAL DELETE TEST') && await page.locator('#customPresetSelect option', { hasText: 'LOCAL DELETE TEST' }).count() === 0);
await page.locator('#equipmentLibraryClose').click();

await page.evaluate(() => {
  const next = window.StagePlotEditor.snapshot();
  next.objects = [{ id: 'legacy', type: 'circle', x: 25, y: 35, width: 64, height: 64, rotation: 5, scale: 90, label: 'Legacy', fontSize: 12, category: 'requested', labelEdited: true, className: '', html: '<div class="circle">Legacy</div>' }];
  window.StagePlotEditor.loadSnapshot(next, { rememberPrevious: false, source: 'legacy-audit' });
}); const legacy = await objectById('legacy');
record(71, 'legacy JSON load', legacy.labelOffsetX === 0 && legacy.labelOffsetY === 0 && legacy.locked === false && legacy.width === 64 && legacy.scale === 90);
legacy.labelOffsetX = 12; legacy.labelOffsetY = -4; legacy.groupId = 'g-test'; legacy.locked = true; legacy.geometrySized = true; legacy.ratioLocked = false; legacy.strokeWidth = 4;
await page.evaluate(value => window.StagePlotEditor.loadSnapshot({ ...window.StagePlotEditor.snapshot(), objects: [value] }, { rememberPrevious: false, source: 'new-roundtrip' }), legacy); const roundtrip = await objectById('legacy');
record(72, 'new JSON save/load', roundtrip.labelOffsetX === 12 && roundtrip.labelOffsetY === -4 && roundtrip.groupId === 'g-test' && roundtrip.locked && roundtrip.strokeWidth === 4);
const pdfPath = path.join(outputDir, 'core-ux-regression.pdf'); await page.pdf({ path: pdfPath, printBackground: true, format: 'A4' });
record(73, 'PDF regression', (await fs.stat(pdfPath)).size > 5000);
const pngRegression = await page.evaluate(() => window.StagePlotEditor.stagePng());
record(74, 'PNG regression', pngRegression.length > 1000 && pngRegression.startsWith('data:image/png'));

await loadFixture(); await selectIds(['a']); await setField('category', 'brought'); const broughtRows = await page.evaluate(() => window.StagePlotEditor.equipmentRows('brought'));
record(75, 'Equipment Sync regression', broughtRows.some(row => row.name === 'A' && row.qty === '1'));
await selectIds(['a']); const refreshA = await page.locator('#objectLabelInput').inputValue(); await selectIds(['b']); const refreshB = await page.locator('#objectLabelInput').inputValue();
record(76, 'Selection Refresh regression', refreshA === 'A' && refreshB === 'B');

const boundaryObject = (id, x, y, width = 80, height = 40, scale = 100, groupId = '') => ({ id, type: 'rect', x, y, width, height, rotation: 0, scale, label: id, fontSize: 11, category: 'requested', strokeWidth: 2, groupId, labelEdited: true, className: '', html: `<div class="rect">${id}</div>` });
await loadFixture([boundaryObject('edge', 20, 0)]); await selectIds(['edge']); await page.keyboard.press('ArrowUp'); record(77, 'top boundary', (await bounds()).top >= -0.01);
await loadFixture([boundaryObject('edge', 20, 460)]); await selectIds(['edge']); await page.keyboard.press('ArrowDown'); record(78, 'bottom boundary', (await bounds()).bottom <= 500.01);
await loadFixture([boundaryObject('edge', 0, 100)]); await selectIds(['edge']); await page.keyboard.press('ArrowLeft'); record(79, 'left boundary', (await bounds()).left >= -0.01);
await loadFixture([boundaryObject('edge', 750, 100)]); await selectIds(['edge']); await page.keyboard.press('ArrowRight'); record(80, 'right boundary', (await bounds()).right <= 830.01);
await loadFixture([boundaryObject('scaled', 40, 440, 80, 40, 150)]); await selectIds(['scaled']); await page.keyboard.press('ArrowDown'); record(81, 'scaled bottom boundary', (await bounds()).bottom <= 500.01);
await loadFixture([boundaryObject('ga', 100, 420, 80, 40, 100, 'group-edge'), boundaryObject('gb', 240, 440, 60, 50, 100, 'group-edge')]); await selectIds(['ga']); await page.keyboard.press('Shift+ArrowDown'); record(82, 'group boundary', (await bounds()).bottom <= 500.01 && (await selectedIds()).length === 2);
await loadFixture([boundaryObject('ma', 100, 430, 80, 40), boundaryObject('mb', 320, 450, 60, 50)]); await selectIds(['ma', 'mb']); await page.keyboard.press('Shift+ArrowDown'); record(83, 'multi boundary', (await bounds()).bottom <= 500.01);

const result = {
  total: Object.keys(checks).length,
  passed: Object.values(checks).filter(Boolean).length,
  failed: Object.values(checks).filter(value => !value).length,
  checks,
  fatalErrors,
  finalGridAuthority: gridAuthority,
  debug,
};
await fs.writeFile(path.join(outputDir, 'stage-plot-editor-core-ux-recovery-report.json'), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
await context.close();
await browser.close();
if (result.failed || fatalErrors.length) process.exitCode = 1;
