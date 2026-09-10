import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'file:///C:/Users/user/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';

const [, , baseUrl, outputDir] = process.argv;
if (!baseUrl || !outputDir) throw new Error('usage: node stage-equipment-sync-batch1-audit.mjs <baseUrl> <outputDir>');
await fs.mkdir(outputDir, { recursive: true });

const caseId = '11111111-1111-4111-8111-111111111111';
const plotId = '22222222-2222-4222-8222-222222222222';
const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
await context.addInitScript(({ expectedCaseId, expectedPlotId }) => {
  const readRecord = () => JSON.parse(localStorage.getItem('__equipment_sync_record__') || 'null');
  const writeRecord = value => localStorage.setItem('__equipment_sync_record__', JSON.stringify(value));
  const builderFor = table => {
    const builder = { select() { return builder; }, eq() { return builder; }, is() { return builder; }, maybeSingle: async () => ({ data: table === 'pa_inquiries' ? { event_date: '2026-10-18' } : { confirmed_event_date: '2026-10-18' }, error: null }) };
    return builder;
  };
  window.__ARA_STAGE_PLOT_PAGE_TEST_DEPS__ = {
    createClient: () => ({ auth: { getSession: async () => ({ data: { session: { access_token: 'equipment-sync-local-only' } } }) }, from: builderFor }),
    persistence: {
      list: async id => id === expectedCaseId && readRecord() ? [readRecord()] : [],
      get: async (id, requestedPlotId) => {
        const record = readRecord();
        if (id !== expectedCaseId || requestedPlotId !== expectedPlotId || !record) throw new Error('stage_plot_not_found');
        return record;
      },
      create: async (id, state) => {
        if (id !== expectedCaseId) throw new Error('inquiry_not_found');
        const record = { id: expectedPlotId, case_id: expectedCaseId, current_revision: 1, state };
        writeRecord(record);
        return record;
      },
      save: async (id, requestedPlotId, state) => {
        const record = readRecord();
        if (id !== expectedCaseId || requestedPlotId !== expectedPlotId || !record) throw new Error('stage_plot_case_mismatch');
        const next = { ...record, current_revision: record.current_revision + 1, state };
        writeRecord(next);
        return next;
      },
    },
  };
}, { expectedCaseId: caseId, expectedPlotId: plotId });

const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(String(error)));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
await page.goto(`${baseUrl}/pa-stage-plot-editor.html?caseId=${caseId}`, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.StagePlotEditor && window.StagePlotPage?.mode === 'new');

const blankState = await page.evaluate(() => {
  const value = window.StagePlotEditor.snapshot();
  value.objects = [];
  value.equipment = { brought: [], venue_borrow: [], rental: [], unspecified: [], order: { brought: [], venue_borrow: [], rental: [], unspecified: [] } };
  value.notes = '';
  value.otherRequests = '';
  return value;
});
await page.evaluate(value => window.StagePlotEditor.loadSnapshot(value, { rememberPrevious: false, source: 'batch1-start' }), blankState);

const category = () => page.evaluate(() => window.StagePlotEditor.snapshot().objects.at(-1)?.category || '');
const rows = kind => page.evaluate(value => window.StagePlotEditor.equipmentRows(value), kind);
const color = () => page.evaluate(() => {
  const node = document.querySelector('.engine-object.selected');
  const line = node?.querySelector('.mic-svg line');
  const rect = node?.querySelector('.rect,.circle,.power-mark,.mon-svg rect');
  return line ? getComputedStyle(line).stroke : rect ? `${getComputedStyle(rect).backgroundColor}|${getComputedStyle(rect).stroke}` : '';
});
const inspectorInput = page.locator('#objectLabelInput');
const categorySelect = page.locator('#objectCategorySelect');
const duplicateButton = page.locator('.left .props [data-editor-action="duplicate"]');
const deleteButton = page.locator('.left .props [data-editor-action="delete"]');
const openInspector = async selector => {
  const toggle = page.locator(selector);
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
};

await page.locator('.tool[data-tool="microphone"]').click();
await page.locator('[data-object-category="brought"]').click();
const a = { category: await category(), color: await color(), carry: await rows('brought'), venue: await rows('venue_borrow'), dirty: await page.evaluate(() => window.StagePlotPage.dirty) };
await page.screenshot({ path: path.join(outputDir, '01_red_to_carry.png'), fullPage: false, animations: 'disabled' });

await openInspector('#inspectorGroupToggle');
await duplicateButton.click();
await duplicateButton.click();
const b = { carry: await rows('brought') };
await page.locator('.print-stage-page').screenshot({ path: path.join(outputDir, '04_auto_quantity.png'), animations: 'disabled' });

await page.locator('[data-object-category="venue_borrow"]').click();
const c = { category: await category(), color: await color(), carry: await rows('brought'), venue: await rows('venue_borrow') };
await page.screenshot({ path: path.join(outputDir, '02_black_to_requested.png'), fullPage: false, animations: 'disabled' });

await page.locator('[data-object-category="brought"]').click();
const d = { carry: await rows('brought'), venue: await rows('venue_borrow') };
await categorySelect.selectOption('venue_borrow');
await categorySelect.dispatchEvent('change');
const e = { category: await category(), color: await color(), carry: await rows('brought'), venue: await rows('venue_borrow') };
await page.screenshot({ path: path.join(outputDir, '03_dropdown_sync.png'), fullPage: false, animations: 'disabled' });
await categorySelect.selectOption('brought');
await categorySelect.dispatchEvent('change');
const f = { category: await category(), color: await color(), carry: await rows('brought'), venue: await rows('venue_borrow') };
await categorySelect.selectOption('rental');
await categorySelect.dispatchEvent('change');
const rentalState = { category: await category(), color: await color(), rental: await rows('rental') };
await categorySelect.selectOption('unspecified');
await categorySelect.dispatchEvent('change');
const g = { category: await category(), color: await color(), carry: await rows('brought'), venue: await rows('venue_borrow'), unspecified: await rows('unspecified') };

await categorySelect.selectOption('venue_borrow');
await categorySelect.dispatchEvent('change');
await inspectorInput.fill('Vo Wireless');
await inspectorInput.dispatchEvent('change');
const h = { venue: await rows('venue_borrow') };
await openInspector('#inspectorGroupToggle');
await deleteButton.click();
const i = { venue: await rows('venue_borrow') };

await page.evaluate(value => window.StagePlotEditor.loadSnapshot(value, { rememberPrevious: false, source: 'manual-separation' }), blankState);
await page.locator('.add-equip').click();
const manualName = page.locator('#carryList [data-source="manual"] input').first();
const manualQty = page.locator('#carryList [data-source="manual"] .qty');
await manualName.fill('Manual Stand');
await manualName.dispatchEvent('change');
await manualQty.fill('2');
await manualQty.dispatchEvent('change');
await page.locator('.tool[data-tool="microphone"]').click();
await inspectorInput.fill('Stage Mic');
await inspectorInput.dispatchEvent('change');
await page.locator('[data-object-category="brought"]').click();
await openInspector('#inspectorGroupToggle');
await deleteButton.click();
const j = { carry: await rows('brought'), snapshot: await page.evaluate(() => window.StagePlotEditor.snapshot().equipment.brought) };

const orderState = {
  ...blankState,
  objects: [
    { id: 'carry-amp', type: 'rect', x: 40, y: 60, width: 76, height: 40, rotation: 0, scale: 100, label: 'Amp', fontSize: 11, category: 'brought', labelEdited: true, className: '', html: '<div class="rect">Amp</div>' },
    { id: 'carry-monitor', type: 'monitor', x: 150, y: 60, width: 56, height: 46, rotation: 0, scale: 100, label: 'Monitor', fontSize: 11, category: 'brought', labelEdited: true, className: '', html: '' },
    { id: 'venue-di', type: 'rect', x: 260, y: 60, width: 76, height: 40, rotation: 0, scale: 100, label: 'DI', fontSize: 11, category: 'venue_borrow', labelEdited: true, className: '', html: '<div class="rect">DI</div>' },
    { id: 'venue-power', type: 'power', x: 370, y: 60, width: 46, height: 20, rotation: 0, scale: 100, label: '100V', fontSize: 8.5, category: 'venue_borrow', labelEdited: true, className: '', html: '' },
  ],
  equipment: {
    brought: [{ id: 'manual-cable', source: 'manual', name: 'Manual Cable', qty: '2', detail: '' }],
    venue_borrow: [{ id: 'manual-stand', source: 'manual', name: 'Manual Stand', qty: '1', detail: '' }],
    rental: [], unspecified: [],
    order: { brought: [], venue_borrow: [], rental: [], unspecified: [] },
  },
};
await page.evaluate(value => window.StagePlotEditor.loadSnapshot(value, { rememberPrevious: false, source: 'order-start' }), orderState);
const names = kind => page.locator(kind === 'brought' ? '#carryList [data-equipment-key] > input:not(.qty)' : '#venueBorrowList [data-equipment-key] > input:not(.qty)').evaluateAll(inputs => inputs.map(input => input.value));
const initialCarryOrder = await names('brought');
await page.locator('#carryList [data-equipment-key]').last().dragTo(page.locator('#carryList [data-equipment-key]').first());
const carryOrder = await names('brought');
const carryOrderState = await page.evaluate(() => window.StagePlotEditor.snapshot().equipment.order.brought);
await page.locator('#undoBtn').click();
const carryUndo = await names('brought');
await page.locator('#redoBtn').click();
const carryRedo = await names('brought');
await page.locator('.print-stage-page').screenshot({ path: path.join(outputDir, '05_carry_drag_order.png'), animations: 'disabled' });

const initialRequestedOrder = await names('venue_borrow');
await page.locator('#venueBorrowList [data-equipment-key]').last().dragTo(page.locator('#venueBorrowList [data-equipment-key]').first());
const requestedOrder = await names('venue_borrow');
const requestedOrderState = await page.evaluate(() => window.StagePlotEditor.snapshot().equipment.order.venue_borrow);
await page.locator('.print-stage-page').screenshot({ path: path.join(outputDir, '06_requested_drag_order.png'), animations: 'disabled' });

const beforeSave = await page.evaluate(() => window.StagePlotEditor.snapshot());
const jsonRoundTrip = await page.evaluate(value => {
  const encoded = JSON.stringify(value);
  window.StagePlotEditor.loadSnapshot(JSON.parse(encoded), { rememberPrevious: false, source: 'json-roundtrip' });
  return JSON.stringify(window.StagePlotEditor.snapshot().equipment.order) === JSON.stringify(value.equipment.order);
}, beforeSave);
await page.evaluate(() => window.StagePlotPage.save());
await page.reload({ waitUntil: 'networkidle' });
await page.waitForFunction(() => window.StagePlotEditor && window.StagePlotPage?.revision === 1);
const reload = {
  carry: await names('brought'),
  requested: await names('venue_borrow'),
  order: await page.evaluate(() => window.StagePlotEditor.snapshot().equipment.order),
  dirty: await page.evaluate(() => window.StagePlotPage.dirty),
};

const savedState = await page.evaluate(() => window.StagePlotEditor.snapshot());
const backward = await page.evaluate(value => {
  delete value.equipment.order;
  value.equipment.brought.forEach(item => delete item.source);
  value.equipment.venue_borrow.forEach(item => delete item.source);
  window.StagePlotEditor.loadSnapshot(value, { rememberPrevious: false, source: 'backward-compat' });
  const snapshot = window.StagePlotEditor.snapshot();
  return {
    schemaVersion: snapshot.schemaVersion,
    manualSources: [...snapshot.equipment.brought, ...snapshot.equipment.venue_borrow].every(item => item.source === 'manual'),
    orderPresent: Array.isArray(snapshot.equipment.order?.brought) && Array.isArray(snapshot.equipment.order?.venue_borrow),
  };
}, structuredClone(savedState));
await page.evaluate(value => window.StagePlotEditor.loadSnapshot(value, { rememberPrevious: false, source: 'pdf-restore' }), savedState);

const pdfDom = { carry: await names('brought'), requested: await names('venue_borrow') };
await page.emulateMedia({ media: 'print' });
await page.evaluate(() => document.body.classList.add('print-stage-only'));
await page.pdf({ path: path.join(outputDir, 'equipment-order.pdf'), format: 'A4', landscape: true, margin: { top: '0', right: '0', bottom: '0', left: '0' }, printBackground: true, tagged: true });
await page.emulateMedia({ media: 'screen' });
await page.evaluate(() => document.body.classList.remove('print-stage-only'));

await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(100);
const mobile = await page.evaluate(() => ({
  scrollWidth: document.documentElement.scrollWidth,
  clientWidth: document.documentElement.clientWidth,
  handleTouchAction: getComputedStyle(document.querySelector('.equipment-drag-handle')).touchAction,
}));
await page.evaluate(() => window.StagePlotEditor.enterMobileEdit());
await page.waitForTimeout(100);
const fullscreen = await page.evaluate(() => ({
  active: document.body.classList.contains('mobile-stage-edit'),
  viewportHeight: document.querySelector('#viewport').getBoundingClientRect().height,
  innerHeight,
}));
await page.screenshot({ path: path.join(outputDir, '08_mobile_390.png'), fullPage: false, animations: 'disabled' });

const oneAuto = (items, name, qty) => items.length === 1 && items[0].source === 'auto' && items[0].name === name && items[0].qty === String(qty);
const checks = {
  A_redToCarry: a.category === 'brought' && a.color === 'rgb(215, 25, 32)' && oneAuto(a.carry, 'マイク', 1) && a.venue.length === 0 && a.dirty,
  B_quantityThree: oneAuto(b.carry, 'マイク', 3),
  C_blackMovesOne: c.category === 'venue_borrow' && c.color === 'rgb(17, 17, 17)' && oneAuto(c.carry, 'マイク', 2) && oneAuto(c.venue, 'マイク', 1),
  D_redRestoresGroup: oneAuto(d.carry, 'マイク', 3) && d.venue.length === 0,
  E_dropdownVenueBorrow: e.category === 'venue_borrow' && e.color === 'rgb(17, 17, 17)' && oneAuto(e.venue, 'マイク', 1),
  F_dropdownCarry: f.category === 'brought' && f.color === 'rgb(215, 25, 32)' && f.venue.length === 0,
  G_rentalBlueAndListed: rentalState.category === 'rental' && rentalState.color === 'rgb(35, 130, 184)' && oneAuto(rentalState.rental, 'マイク', 1),
  H_unspecifiedGrayAndListed: g.category === 'unspecified' && g.color === 'rgb(201, 209, 216)' && g.carry[0]?.qty === '2' && g.venue.length === 0 && oneAuto(g.unspecified, 'マイク', 1),
  I_renameSync: oneAuto(h.venue, 'Vo Wireless', 1) && !h.venue.some(item => item.name === 'マイク'),
  J_deleteSync: i.venue.length === 0,
  K_manualPreserved: j.carry.length === 1 && j.carry[0].source === 'manual' && j.carry[0].name === 'Manual Stand' && j.carry[0].qty === '2' && j.snapshot[0]?.source === 'manual',
  L_carryReorder: initialCarryOrder.join('|') === 'Manual Cable|Amp|Monitor' && carryOrder.join('|') === 'Monitor|Manual Cable|Amp' && carryUndo.join('|') === initialCarryOrder.join('|') && carryRedo.join('|') === carryOrder.join('|') && carryOrderState.length === 3,
  M_venueBorrowReorder: initialRequestedOrder.join('|') === 'Manual Stand|DI|100V' && requestedOrder.join('|') === '100V|Manual Stand|DI' && requestedOrderState.length === 3,
  N_pdfOrder: pdfDom.carry.join('|') === carryOrder.join('|') && pdfDom.requested.join('|') === requestedOrder.join('|'),
  jsonOrder: jsonRoundTrip,
  dbReloadOrder: reload.carry.join('|') === carryOrder.join('|') && reload.requested.join('|') === requestedOrder.join('|') && !reload.dirty,
  backwardCompatible: backward.schemaVersion === 2 && backward.manualSources && backward.orderPresent,
  mobile390: mobile.scrollWidth <= mobile.clientWidth && mobile.handleTouchAction === 'none',
  mobileFullscreen: fullscreen.active && Math.abs(fullscreen.viewportHeight - fullscreen.innerHeight) <= 1,
  noFatalErrors: errors.length === 0,
};

const report = { checks, a, b, c, d, e, f, rentalState, g, h, i, j, initialCarryOrder, carryOrder, carryUndo, carryRedo, carryOrderState, initialRequestedOrder, requestedOrder, requestedOrderState, jsonRoundTrip, reload, backward, pdfDom, mobile, fullscreen, errors };
await fs.writeFile(path.join(outputDir, '09_test_results.txt'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(checks, null, 2));
await context.close();
await browser.close();
if (Object.values(checks).some(value => value !== true)) process.exitCode = 1;
