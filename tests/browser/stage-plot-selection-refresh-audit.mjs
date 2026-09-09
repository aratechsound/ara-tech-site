import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'file:///C:/Users/user/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';

const [, , baseUrl, outputDir] = process.argv;
if (!baseUrl || !outputDir) throw new Error('usage: node stage-plot-selection-refresh-audit.mjs <baseUrl> <outputDir>');
await fs.mkdir(outputDir, { recursive: true });

const caseId = '33333333-3333-4333-8333-333333333333';
const plotId = '44444444-4444-4444-8444-444444444444';
const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await context.addInitScript(({ expectedCaseId, expectedPlotId }) => {
  let record = null;
  window.__ARA_STAGE_PLOT_PAGE_TEST_DEPS__ = {
    createClient: () => ({
      auth: { getSession: async () => ({ data: { session: { access_token: 'selection-refresh-local-only' } } }) },
      from: () => ({ select() { return this; }, eq() { return this; }, is() { return this; }, maybeSingle: async () => ({ data: { event_date: '2026-10-18' }, error: null }) }),
    }),
    persistence: {
      list: async id => id === expectedCaseId && record ? [record] : [],
      get: async (id, requestedPlotId) => id === expectedCaseId && requestedPlotId === expectedPlotId && record ? record : Promise.reject(new Error('stage_plot_not_found')),
      create: async (id, state) => {
        if (id !== expectedCaseId) throw new Error('inquiry_not_found');
        record = { id: expectedPlotId, case_id: expectedCaseId, current_revision: 1, state };
        return record;
      },
      save: async (id, requestedPlotId, state) => {
        if (id !== expectedCaseId || requestedPlotId !== expectedPlotId || !record) throw new Error('stage_plot_case_mismatch');
        record = { ...record, current_revision: record.current_revision + 1, state };
        return record;
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

const state = await page.evaluate(() => {
  const next = window.StagePlotEditor.snapshot();
  next.objects = [
    { id: 'tom-a', type: 'circle', x: 80, y: 70, width: 64, height: 64, rotation: -15, scale: 75, label: 'Tom 12"', fontSize: 13, category: 'brought', labelEdited: true, className: '', html: '<div class="circle">Tom 12"</div>' },
    { id: 'tom-b', type: 'circle', x: 300, y: 70, width: 64, height: 64, rotation: 15, scale: 100, label: 'Floor Tom 16"', fontSize: 18, category: 'requested', labelEdited: true, className: '', html: '<div class="circle">Floor Tom 16"</div>' },
    { id: 'tom-c', type: 'circle', x: 520, y: 70, width: 64, height: 64, rotation: 0, scale: 90, label: 'Rack Tom', fontSize: 10, category: 'unspecified', labelEdited: true, className: '', html: '<div class="circle">Rack Tom</div>' },
  ];
  next.equipment = { brought: [], requested: [], order: { brought: [], requested: [] } };
  return next;
});
await page.evaluate(value => window.StagePlotEditor.loadSnapshot(value, { rememberPrevious: false, source: 'selection-refresh-fixture' }), state);

const select = id => page.locator(`.engine-object[data-id="${id}"]`).click();
const inspector = () => page.evaluate(() => {
  const fields = [...document.querySelectorAll('.left .props .field')];
  return {
    title: document.querySelectorAll('.left > .panel-title')[1]?.textContent,
    label: fields[0]?.querySelector('input')?.value,
    rotation: fields[1]?.querySelector('input')?.value,
    scale: fields[2]?.querySelector('input')?.value,
    fontSize: fields[3]?.querySelector('input')?.value,
    category: fields[4]?.querySelector('select')?.value,
    swatches: [...document.querySelectorAll('.left .props .sw[data-object-category]')].map(swatch => [swatch.dataset.objectCategory, swatch.getAttribute('aria-pressed')]),
  };
});

await select('tom-a');
const a = await inspector();
// Keep the scale input focused, then select B. This reproduces the reported stale-value path.
const scaleInput = page.locator('.left .props .field').nth(2).locator('input');
await scaleInput.focus();
const activeBeforeB = await page.evaluate(() => document.activeElement === document.querySelectorAll('.left .props .field')[2].querySelector('input'));
await select('tom-b');
const b = await inspector();
await select('tom-a');
const aAgain = await inspector();
await select('tom-c');
const c = await inspector();

await page.evaluate(() => window.StagePlotPage.save());
const beforeSelections = await page.evaluate(() => ({ state: window.StagePlotEditor.snapshot(), dirty: window.StagePlotPage.dirty, history: document.querySelector('#historyCount')?.textContent, revision: window.StagePlotPage.revision }));
await select('tom-a');
await select('tom-b');
await select('tom-c');
await select('tom-a');
const afterSelections = await page.evaluate(() => ({ state: window.StagePlotEditor.snapshot(), dirty: window.StagePlotPage.dirty, history: document.querySelector('#historyCount')?.textContent, revision: window.StagePlotPage.revision }));

const pressed = (value, category) => value.swatches.find(([kind]) => kind === category)?.[1] === 'true';
const checks = {
  scaleRefresh: activeBeforeB && a.scale === '75%' && b.scale === '100%' && aAgain.scale === '75%',
  rotationRefresh: a.rotation === '-15°' && b.rotation === '15°',
  fontSizeRefresh: a.fontSize === '13' && b.fontSize === '18' && c.fontSize === '10',
  labelRefresh: a.label === 'Tom 12"' && b.label === 'Floor Tom 16"' && aAgain.label === 'Tom 12"',
  categoryRefresh: a.category === '出演者持込' && b.category === '借用・手配希望' && c.category === '未指定',
  swatchRefresh: pressed(a, 'brought') && !pressed(a, 'requested') && !pressed(b, 'brought') && pressed(b, 'requested') && !pressed(c, 'brought') && !pressed(c, 'requested'),
  historySafety: beforeSelections.history === afterSelections.history && !afterSelections.dirty && beforeSelections.revision === afterSelections.revision,
  objectStateUnchanged: JSON.stringify(beforeSelections.state) === JSON.stringify(afterSelections.state),
  noFatalErrors: errors.length === 0,
};
const report = { checks, a, b, aAgain, c, beforeSelections, afterSelections, errors };
await fs.writeFile(path.join(outputDir, 'selection-refresh-report.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(checks, null, 2));
await context.close();
await browser.close();
if (Object.values(checks).some(value => !value)) process.exitCode = 1;
