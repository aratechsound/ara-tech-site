import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'file:///C:/Users/user/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';

const [, , baseUrl, outputDir] = process.argv;
if (!baseUrl || !outputDir) throw new Error('usage: node stage-plot-topview-presets-stroke-audit.mjs <baseUrl> <outputDir>');
await fs.mkdir(outputDir, { recursive: true });
const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
await context.addInitScript(() => {
  window.__ARA_STAGE_PLOT_PAGE_TEST_DEPS__ = {
    createClient: () => ({
      auth: { getSession: async () => ({ data: { session: { access_token: 'local-topview-audit' } } }) },
      from: () => ({ select() { return this; }, eq() { return this; }, is() { return this; }, maybeSingle: async () => ({ data: { event_date: '2026-10-18' }, error: null }) }),
    }),
    persistence: { list: async () => [], create: async (_id, state) => ({ id: crypto.randomUUID(), current_revision: 1, state }) },
  };
});

let page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(String(error)));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
const url = `${baseUrl}/pa-stage-plot-editor.html?caseId=55555555-5555-4555-8555-555555555555`;
await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.StagePlotEditor && window.StagePlotPage?.mode === 'new');

const blank = await page.evaluate(() => {
  const value = window.StagePlotEditor.snapshot();
  value.objects = [];
  value.equipment = { brought: [], venue_borrow: [], rental: [], unspecified: [], order: { brought: [], venue_borrow: [], rental: [], unspecified: [] } };
  return value;
});
await page.evaluate(value => window.StagePlotEditor.loadSnapshot(value, { rememberPrevious: false, source: 'topview-audit' }), blank);

const fixture = [
  { id: 'legacy', type: 'rect', x: 30, y: 30, width: 76, height: 40, rotation: 0, scale: 100, label: 'Legacy', fontSize: 11, category: 'unspecified', labelEdited: true, className: '', html: '<div class="rect">Legacy</div>' },
  { id: 'rect05', type: 'rect', x: 130, y: 30, width: 76, height: 40, rotation: 0, scale: 50, strokeWidth: .5, label: '.5', fontSize: 11, category: 'unspecified', labelEdited: true, className: '', html: '<div class="rect">.5</div>' },
  { id: 'circle2', type: 'circle', x: 250, y: 30, width: 64, height: 64, rotation: 0, scale: 100, strokeWidth: 2, label: '2', fontSize: 10, category: 'unspecified', labelEdited: true, className: '', html: '<div class="circle">2</div>' },
  { id: 'line4', type: 'line', x: 370, y: 50, width: 110, height: 12, rotation: 0, scale: 200, strokeWidth: 4, label: '線', fontSize: 11, category: 'unspecified', labelEdited: true, className: '', html: '<div class="engine-line"></div>' },
];
await page.evaluate(objects => {
  const value = window.StagePlotEditor.snapshot();
  value.objects = objects;
  window.StagePlotEditor.loadSnapshot(value, { rememberPrevious: false, source: 'stroke-fixture' });
}, fixture);

const renderedThickness = await page.evaluate(() => [...document.querySelectorAll('.engine-object')].map(node => {
  const object = node.querySelector('.rect,.circle,.engine-line');
  const matrix = new DOMMatrixReadOnly(getComputedStyle(node).transform);
  const scale = Math.hypot(matrix.a, matrix.b);
  const style = getComputedStyle(object);
  const width = object.classList.contains('engine-line')
    ? parseFloat(style.height)
    : node.classList.contains('has-custom-stroke')
      ? parseFloat(getComputedStyle(node).getPropertyValue('--object-stroke-width'))
      : parseFloat(style.borderTopWidth);
  return { id: node.dataset.id, width, scale, effective: width * scale, custom: node.classList.contains('has-custom-stroke') };
}));
const byId = id => renderedThickness.find(item => item.id === id);

await page.locator('[data-id="rect05"]').click();
const strokeA = await page.locator('#strokeWidthInput').inputValue();
await page.locator('[data-id="line4"]').click();
const strokeB = await page.locator('#strokeWidthInput').inputValue();
await page.locator('[data-id="rect05"]').click();
await page.locator('[data-id="line4"]').click({ modifiers: ['Shift'] });
const multiTitle = await page.locator('.left > .panel-title').nth(1).textContent();
const mixed = await page.locator('#strokeWidthInput').getAttribute('placeholder');
await page.locator('#strokeWidthInput').fill('3.5');
await page.locator('#strokeWidthInput').dispatchEvent('change');
const bulk = await page.evaluate(() => window.StagePlotEditor.snapshot().objects.filter(item => ['rect05', 'line4'].includes(item.id)).map(item => item.strokeWidth));

const jsonRoundTrip = await page.evaluate(() => {
  const before = window.StagePlotEditor.snapshot();
  window.StagePlotEditor.loadSnapshot(JSON.parse(JSON.stringify(before)), { rememberPrevious: false, source: 'json-roundtrip' });
  return window.StagePlotEditor.snapshot().objects.find(item => item.id === 'line4')?.strokeWidth;
});

const pngProbe = await page.evaluate(() => {
  const value = window.StagePlotEditor.snapshot();
  value.objects = [50, 100, 200].map((scale, index) => ({ id: `png-${scale}`, type: 'line', x: 70, y: 100 + index * 80, width: 100, height: 12, rotation: 0, scale, strokeWidth: 2, label: '線', fontSize: 11, category: 'unspecified', labelEdited: true, className: '', html: '<div class="engine-line"></div>' }));
  window.StagePlotEditor.loadSnapshot(value, { rememberPrevious: false, source: 'png-scale-fixture' });
  const widths = [];
  const original = CanvasRenderingContext2D.prototype.stroke;
  CanvasRenderingContext2D.prototype.stroke = function (...args) {
    const transform = this.getTransform();
    const effective = this.lineWidth * Math.hypot(transform.a, transform.b);
    if (effective > 3.9 && effective < 4.1) widths.push(effective);
    return original.apply(this, args);
  };
  const dataUrl = window.StagePlotEditor.stagePng();
  CanvasRenderingContext2D.prototype.stroke = original;
  return { widths, dataUrl };
});
const pngEffectiveWidths = pngProbe.widths;
const pngBytes = Buffer.from(pngProbe.dataUrl.split(',')[1], 'base64');
await fs.writeFile(path.join(outputDir, 'stage-export.png'), pngBytes);
await page.emulateMedia({ media: 'print' });
const printMetrics = await page.evaluate(() => [...document.querySelectorAll('.engine-line')].map(line => {
  const node = line.closest('.engine-object');
  const matrix = new DOMMatrixReadOnly(getComputedStyle(node).transform);
   const width = parseFloat(getComputedStyle(line).height);
  const scale = Math.hypot(matrix.a, matrix.b);
  return { width, scale, effective: width * scale, variable: node.style.getPropertyValue('--object-stroke-width') };
}));
const printThickness = printMetrics.map(item => item.effective);
await page.pdf({ path: path.join(outputDir, 'stage-export.pdf'), printBackground: true, format: 'A4' });
const pdfBytes = (await fs.stat(path.join(outputDir, 'stage-export.pdf'))).size;
await page.emulateMedia({ media: 'screen' });

await page.evaluate(value => window.StagePlotEditor.loadSnapshot(value, { rememberPrevious: false, source: 'library-empty' }), blank);
const launcher = page.locator('#equipmentLibraryLauncher');
await launcher.click();
const initiallyOpenedFromClosed = !(await page.locator('#equipmentLibraryFlyout').isHidden());
await page.locator('.library-preset').filter({ hasText: 'Roland JC-120' }).getByRole('button', { name: '配置' }).click();
const jc = await page.evaluate(() => window.StagePlotEditor.snapshot().objects.at(-1));
await launcher.click();
await page.locator('.library-preset').filter({ hasText: 'Marshall JCM900 + 4x12' }).getByRole('button', { name: '配置' }).click();
const jcm = await page.evaluate(() => window.StagePlotEditor.snapshot().objects.at(-1));
const jcmRenderedText = await page.locator(`[data-id="${jcm.id}"]`).innerText();
await launcher.click();
await page.locator('.library-preset').filter({ hasText: 'SVT + 810' }).getByRole('button', { name: '配置' }).click();
const svt = await page.evaluate(() => window.StagePlotEditor.snapshot().objects.at(-1));
const svtRenderedText = await page.locator(`[data-id="${svt.id}"]`).innerText();
const splitLabelsReadable = await page.evaluate(ids => ids.every(id => {
  const symbol = document.querySelector(`[data-id="${id}"] .topview-symbol.is-split`);
  const labels = [...(symbol?.querySelectorAll('span') || [])];
  return symbol && getComputedStyle(symbol, '::after').zIndex === '0'
    && labels.length === 2
    && labels.every(label => getComputedStyle(label).zIndex === '1' && getComputedStyle(label).backgroundColor !== 'rgba(0, 0, 0, 0)');
}), [jcm.id, svt.id]);
await launcher.click();
await page.locator('.library-preset').filter({ hasText: 'Roland RD-300' }).getByRole('button', { name: '配置' }).click();
const rd = await page.evaluate(() => window.StagePlotEditor.snapshot().objects.at(-1));

await page.evaluate(value => window.StagePlotEditor.loadSnapshot(value, { rememberPrevious: false, source: 'drum-visual-empty' }), blank);
await launcher.click();
await page.locator('.library-preset').filter({ hasText: 'SIX ONE Live STAR Drum' }).getByRole('button', { name: '配置' }).click();
const drumBeforeUndo = await page.evaluate(() => ({ objects: window.StagePlotEditor.snapshot().objects.slice(-10), selected: window.StagePlotEditor.selectedIds(), history: Number(document.querySelector('#historyCount').textContent) }));
await page.locator('.stage').click({ position: { x: 10, y: 10 } });
await page.screenshot({ path: path.join(outputDir, 'drum-preset.png'), fullPage: false, animations: 'disabled' });
await page.locator('#undoBtn').click();
const afterUndoCount = await page.evaluate(() => window.StagePlotEditor.snapshot().objects.length);

const beforeCustom = await page.evaluate(() => window.StagePlotEditor.snapshot());
const customFixture = [
  { id: 'custom-a', type: 'rect', x: 100, y: 100, width: 80, height: 40, rotation: 0, scale: 100, strokeWidth: 1, label: 'A', fontSize: 11, category: 'rental', fillStyle: 'white', equipmentModel: 'Synthetic A', labelEdited: true, className: '', html: '<div class="rect">A</div>' },
  { id: 'custom-b', type: 'circle', x: 220, y: 160, width: 50, height: 50, rotation: 15, scale: 80, strokeWidth: 4, label: 'B', fontSize: 12, category: 'brought', fillStyle: 'white', equipmentModel: 'Synthetic B', labelEdited: true, className: '', html: '<div class="circle">B</div>' },
];
await page.evaluate(({ before, objects }) => { before.objects = objects; window.StagePlotEditor.loadSnapshot(before, { rememberPrevious: false, source: 'custom-preset-fixture' }); }, { before: beforeCustom, objects: customFixture });
await page.locator('[data-id="custom-a"]').click();
await page.locator('[data-id="custom-b"]').click({ modifiers: ['Control'] });
await launcher.click();
await page.locator('#presetEditToggle').click();
await page.locator('#presetNameInput').fill('My Local Rig');
await page.locator('#createCustomPreset').click();
const storedBeforeReload = await page.evaluate(() => JSON.parse(localStorage.getItem('ara-tech-stage-plot-user-presets:v1')));

await page.reload({ waitUntil: 'networkidle' });
await page.waitForFunction(() => window.StagePlotEditor && window.StagePlotPage?.mode === 'new');
const reloadHasPreset = await page.evaluate(() => window.StagePlotEditor.presets().some(item => item.name === 'My Local Rig'));
await page.locator('#equipmentLibraryLauncher').click();
const myLocalRigId = await page.locator('#customPresetSelect option', { hasText: 'My Local Rig' }).getAttribute('value');
await page.locator('#presetEditToggle').click();
await page.locator('#customPresetSelect').selectOption(myLocalRigId);
const builtinAvailableForEdit = await page.locator('#customPresetSelect option', { hasText: 'Roland JC-120' }).count() === 1;
await page.locator('#presetEditToggle').click();
await page.locator('.library-preset').filter({ hasText: 'My Local Rig' }).getByRole('button', { name: '配置' }).click();
const placedCustom = await page.evaluate(() => ({ objects: window.StagePlotEditor.snapshot().objects.slice(-2), selected: window.StagePlotEditor.selectedIds() }));

await page.locator('#equipmentLibraryLauncher').click();
await page.locator('#presetEditToggle').click();
await page.locator('#customPresetSelect').selectOption(myLocalRigId);
page.once('dialog', dialog => dialog.accept());
await page.locator('#updateCustomPreset').click();
const overwritten = await page.evaluate(() => JSON.parse(localStorage.getItem('ara-tech-stage-plot-user-presets:v1')).custom.find(item => item.name === 'My Local Rig'));

const flyout = page.locator('#equipmentLibraryFlyout');
await page.locator('#equipmentLibraryClose').click();
const closeX = await flyout.isHidden();
await page.locator('#equipmentLibraryLauncher').click();
await page.locator('#equipmentLibraryLauncher').click();
const closeToggle = await flyout.isHidden();
await page.locator('#equipmentLibraryLauncher').click();
await page.keyboard.press('Escape');
const closeEsc = await flyout.isHidden();
await page.locator('#equipmentLibraryLauncher').click();
await page.locator('.workspace-head').click();
const closeOutside = await flyout.isHidden();
const venueBorrowSwatchWhite = await page.locator('[data-object-category="venue_borrow"]').evaluate(node => getComputedStyle(node).backgroundColor === 'rgb(255, 255, 255)');

const ratio = (object, w, d) => Math.abs(object.width / object.height - w / d) < 0.0001;
const drum = drumBeforeUndo.objects;
const checks = {
  A_legacy_default_preserved: byId('legacy').width === 2 && !byId('legacy').custom,
  B_rect_circle_line_strokes: Math.abs(byId('rect05').effective - .5) < .01 && Math.abs(byId('circle2').effective - 2) < .01 && Math.abs(byId('line4').effective - 4) < .01,
  C_screen_scale_independent: renderedThickness.filter(item => item.custom).every(item => Math.abs(item.effective - ({ rect05: .5, circle2: 2, line4: 4 })[item.id]) < .01),
  D_print_png_scale_independent: pngEffectiveWidths.length >= 3 && pngBytes.length > 1000 && pdfBytes > 1000 && printThickness.length === 3 && printThickness.every(width => Math.abs(width - 2) < .02),
  E_json_stroke_preserved: jsonRoundTrip === 3.5,
  F_selection_stroke_refresh: strokeA === '0.5' && strokeB === '4',
  G_multiselect_bulk_stroke: multiTitle === '選択中：2個' && mixed === '—' && bulk.every(value => value === 3.5),
  H_jc_ratio: jc.label === 'JC120' && ratio(jc, 760, 280) && jc.physicalDimensionVerified,
  I_jcm_ratio: jcm.splitLabel === '4x12' && jcmRenderedText.includes('JCM900') && jcmRenderedText.includes('4x12') && ratio(jcm, 770, 365),
  J_svt_ratio: svt.splitLabel === '810' && svtRenderedText.includes('SVT') && svtRenderedText.includes('810') && ratio(svt, 660.4, 406.4),
  K_rd300_ratio_identity: rd.label === 'RD300' && rd.equipmentModel === 'Roland RD-300' && ratio(rd, 1405, 461),
  L_drum_composition: drum.length === 10 && drum.find(item => item.symbolKind === 'drum-kick')?.type === 'rect' && drum.filter(item => ['drum-shell', 'cymbal'].includes(item.symbolKind)).every(item => item.type === 'circle') && drum.find(item => item.symbolKind === 'drum-pedal')?.category === 'brought',
  M_preset_ids_layout_z_undo: new Set(drum.map(item => item.id)).size === 10 && drumBeforeUndo.selected.length === 10 && afterUndoCount === 0,
  N_custom_multiselect_saved: storedBeforeReload.schemaVersion === 2 && storedBeforeReload.custom[0].components.length === 2 && storedBeforeReload.custom[0].components.every(item => !('id' in item)),
  O_custom_reload_persisted: reloadHasPreset,
  P_custom_overwrite: Boolean(overwritten.components.length === 2 && overwritten.updatedAt),
  Q_builtin_edit_available: builtinAvailableForEdit,
  R_flyout_close_contract: initiallyOpenedFromClosed && closeX && closeToggle && closeEsc && closeOutside,
  S_selection_refresh_regression_hook: strokeA === '0.5' && strokeB === '4',
  T_equipment_sync_semantics: venueBorrowSwatchWhite && jc.category === 'unspecified' && drum.find(item => item.symbolKind === 'drum-pedal')?.category === 'brought',
  U_topview_labels_readable: splitLabelsReadable,
};

const relativeLayoutPreserved = placedCustom.objects.length === 2
  && placedCustom.objects[1].x - placedCustom.objects[0].x === 120
  && placedCustom.objects[1].y - placedCustom.objects[0].y === 60
  && placedCustom.selected.length === 2
  && placedCustom.objects.every(item => !['custom-a', 'custom-b'].includes(item.id));
checks.M_preset_ids_layout_z_undo = checks.M_preset_ids_layout_z_undo && relativeLayoutPreserved;
const report = { checks, renderedThickness, pngEffectiveWidths, pngBytes: pngBytes.length, pdfBytes, printMetrics, printThickness, jc, jcm, svt, rd, drumBeforeUndo, storedBeforeReload, placedCustom, overwritten, errors };
await fs.writeFile(path.join(outputDir, 'topview-presets-stroke-report.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(checks, null, 2));
await context.close();
await browser.close();
if (errors.length || Object.values(checks).some(value => !value)) process.exitCode = 1;
