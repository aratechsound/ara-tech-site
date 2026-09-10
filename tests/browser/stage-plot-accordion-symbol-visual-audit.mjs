import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'file:///C:/Users/user/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';

const [, , baseUrl, outputDir] = process.argv;
if (!baseUrl || !outputDir) throw new Error('usage: node stage-plot-accordion-symbol-visual-audit.mjs <baseUrl> <outputDir>');
await fs.mkdir(outputDir, { recursive: true });

const caseId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1250 }, deviceScaleFactor: 1, acceptDownloads: true });
await context.addInitScript(expectedCaseId => {
  localStorage.removeItem('ara-tech-stage-plot-editor-ui:v1');
  localStorage.removeItem('ara-tech-stage-plot-library-ui:v1');
  localStorage.removeItem('ara-tech-stage-plot-user-presets:v1');
  const builder = { select() { return builder; }, eq() { return builder; }, is() { return builder; }, maybeSingle: async () => ({ data: { event_date: '2026-10-18' }, error: null }) };
  window.__ARA_STAGE_PLOT_PAGE_TEST_DEPS__ = {
    createClient: () => ({ auth: { getSession: async () => ({ data: { session: { access_token: 'local-accordion-symbol-audit' } } }) }, from: () => builder }),
    persistence: {
      list: async id => id === expectedCaseId ? [] : Promise.reject(new Error('inquiry_not_found')),
      create: async (_id, state) => ({ id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', current_revision: 1, state }),
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
const record = (number, name, value) => { checks[`${String(number).padStart(2, '0')} ${name}`] = Boolean(value); };
const sectionCases = [
  { name: 'position', toggle: '#inspectorPositionToggle', panel: '#inspectorPositionPanel', own: '#objectXInput', foreign: '#objectFontSizeInput' },
  { name: 'text', toggle: '#inspectorTextToggle', panel: '#inspectorTextPanel', own: '#objectFontSizeInput', foreign: '#objectXInput' },
  { name: 'category', toggle: '#inspectorCategoryToggle', panel: '#inspectorCategoryPanel', own: '#objectCategorySelect', foreign: '#objectFontSizeInput' },
  { name: 'label', toggle: '#inspectorLabelToggle', panel: '#inspectorLabelPanel', own: '#labelOffsetXInput', foreign: '#objectXInput' },
  { name: 'group', toggle: '#inspectorGroupToggle', panel: '#inspectorGroupPanel', own: '[data-editor-action="group"]', foreign: '#objectFontSizeInput' },
  { name: 'shortcuts', toggle: '#inspectorShortcutToggle', panel: '#inspectorShortcutPanel', own: '.shortcut-list', foreign: '#objectXInput' },
];

let allStrict = true;
let alwaysVisible = true;
for (let index = 0; index < sectionCases.length; index += 1) {
  const current = sectionCases[index];
  const expanded = await page.locator(current.toggle).getAttribute('aria-expanded');
  if (expanded !== 'true') await page.locator(current.toggle).click();
  const state = await page.evaluate(() => [...document.querySelectorAll('.inspector-section')].map(section => {
    const panel = section.querySelector('.inspector-panel');
    return {
      open: section.classList.contains('open'),
      expanded: section.querySelector('.inspector-toggle')?.getAttribute('aria-expanded'),
      hidden: panel?.hidden,
      inert: panel?.hasAttribute('inert'),
      display: panel ? getComputedStyle(panel).display : '',
    };
  }));
  const strict = state.filter(item => item.open && item.expanded === 'true' && !item.hidden && item.display !== 'none').length === 1
    && state.filter(item => !item.open && item.expanded === 'false' && item.hidden && item.inert && item.display === 'none').length === 5
    && await page.locator(current.own).first().isVisible()
    && !(await page.locator(current.foreign).first().isVisible());
  allStrict &&= strict;
  alwaysVisible &&= await page.locator('#selectedTitle').isVisible() && await page.locator('#objectLabelInput').isVisible();
  record(index + 1, `strict accordion ${current.name}`, strict);
}
record(7, 'maximum one open body and no leaked controls', allStrict);
record(8, 'selected title and label always visible', alwaysVisible);

await page.evaluate(() => {
  const object = window.StagePlotEditor.snapshot().objects.find(item => item.label === 'Gt Head');
  window.StagePlotEditor.selectIds(object ? [object.id] : []);
});
await page.locator('#inspectorPositionToggle').click();
await page.screenshot({ path: path.join(outputDir, '01_accordion_position_open_100pct.png'), fullPage: false, animations: 'disabled' });
await page.locator('#inspectorTextToggle').click();
await page.screenshot({ path: path.join(outputDir, '02_accordion_text_open_100pct.png'), fullPage: false, animations: 'disabled' });

const defaultSymbols = await page.evaluate(() => {
  const mic = document.querySelector('.engine-object.micVo .mic-svg');
  const redMic = document.querySelector('.engine-object.micDr .mic-svg');
  const monitor = document.querySelector('.engine-object.mon2 .mon-svg');
  const micLine = mic?.querySelector('line');
  const redMicLine = redMic?.querySelector('line');
  const monitorRect = monitor?.querySelector('rect');
  const monitorPolygon = monitor?.querySelector('polygon');
  return {
    mic: mic ? { width: parseFloat(getComputedStyle(mic).width), height: parseFloat(getComputedStyle(mic).height), vector: getComputedStyle(micLine).vectorEffect, stroke: getComputedStyle(micLine).stroke, circleFill: getComputedStyle(mic.querySelector('circle')).fill } : null,
    redMic: redMic ? { stroke: getComputedStyle(redMicLine).stroke, fill: getComputedStyle(redMic.querySelector('polygon')).fill } : null,
    monitor: monitor ? { width: parseFloat(getComputedStyle(monitor).width), height: parseFloat(getComputedStyle(monitor).height), vector: getComputedStyle(monitorRect).vectorEffect, fill: getComputedStyle(monitorRect).fill, stroke: getComputedStyle(monitorRect).stroke, wedge: getComputedStyle(monitorPolygon).fill } : null,
  };
});
record(9, 'Mic default visual DOM', defaultSymbols.mic && Math.abs(defaultSymbols.mic.width - 38) < 1 && Math.abs(defaultSymbols.mic.height - 43) < 1 && defaultSymbols.mic.vector === 'none' && defaultSymbols.mic.stroke === 'rgb(0, 0, 0)' && defaultSymbols.mic.circleFill === 'rgb(255, 255, 255)' && defaultSymbols.redMic.stroke === 'rgb(215, 25, 32)' && defaultSymbols.redMic.fill === 'rgb(215, 25, 32)');
record(10, 'Monitor default visual DOM', defaultSymbols.monitor && Math.abs(defaultSymbols.monitor.width - 56) < 1 && Math.abs(defaultSymbols.monitor.height - 46) < 1 && defaultSymbols.monitor.vector === 'none' && defaultSymbols.monitor.fill === 'rgb(255, 255, 255)' && defaultSymbols.monitor.stroke === 'rgb(0, 0, 0)' && defaultSymbols.monitor.wedge === 'rgb(0, 0, 0)');

const closeupTargets = await Promise.all(['.engine-object.mon2', '.engine-object.micVo'].map(selector => page.locator(selector).boundingBox()));
const closeup = {
  x: Math.max(0, Math.min(...closeupTargets.map(box => box.x)) - 45),
  y: Math.max(0, Math.min(...closeupTargets.map(box => box.y)) - 45),
  width: Math.max(...closeupTargets.map(box => box.x + box.width)) - Math.min(...closeupTargets.map(box => box.x)) + 90,
  height: Math.max(...closeupTargets.map(box => box.y + box.height)) - Math.min(...closeupTargets.map(box => box.y)) + 90,
};
await page.screenshot({ path: path.join(outputDir, '03_mic_monitor_closeup_100pct.png'), clip: closeup, animations: 'disabled' });

const micSvg = '<svg class="mic-svg" viewBox="0 0 160 180" aria-label="mic"><line x1="80" y1="28" x2="80" y2="148" stroke="#000" stroke-width="8"/><circle cx="80" cy="92" r="29" fill="#fff" stroke="#000" stroke-width="7"/><line x1="80" y1="54" x2="80" y2="130" stroke="#000" stroke-width="8"/><polygon points="80,8 56,38 104,38" fill="#000"/></svg>';
const monitorSvg = '<svg class="mon-svg" viewBox="0 0 220 180" aria-label="monitor"><rect x="30" y="34" width="160" height="112" fill="#fff" stroke="#000" stroke-width="9"/><polygon points="38,38 182,38 110,112" fill="#000"/></svg>';
await page.evaluate(([micHtml, monitorHtml]) => {
  const next = window.StagePlotEditor.snapshot();
  next.metadata = { ...next.metadata, eventName: 'LOCAL SYMBOL AUDIT', performerName: 'SYNTHETIC BAND' };
  next.objects = [
    { id: 'mic-audit', type: 'microphone', x: 280, y: 180, width: 38, height: 43, rotation: 0, scale: 100, label: 'Mic', fontSize: 11, category: 'brought', labelEdited: true, className: '', html: micHtml },
    { id: 'monitor-audit', type: 'monitor', x: 440, y: 180, width: 56, height: 46, rotation: 0, scale: 100, label: 'Monitor', fontSize: 11, category: 'requested', labelEdited: true, className: '', html: monitorHtml },
  ];
  next.equipment = { brought: [], requested: [], order: { brought: [], requested: [] } };
  window.StagePlotEditor.loadSnapshot(next, { rememberPrevious: false, source: 'accordion-symbol-audit' });
}, [micSvg, monitorSvg]);

await page.evaluate(() => window.StagePlotEditor.selectIds(['mic-audit']));
await page.evaluate(() => window.StagePlotEditor.setField('ratioLocked', false));
await page.evaluate(() => window.StagePlotEditor.setGeometry('width', 76));
await page.evaluate(() => window.StagePlotEditor.setGeometry('height', 86));
await page.evaluate(() => window.StagePlotEditor.setField('rotation', 45));
await page.evaluate(() => window.StagePlotEditor.setField('strokeWidth', 4));
const micChanged = await page.evaluate(() => {
  const object = window.StagePlotEditor.snapshot().objects.find(item => item.id === 'mic-audit');
  const node = document.querySelector('[data-id="mic-audit"]');
  const line = node.querySelector('.mic-svg line');
  return { object, width: node.getBoundingClientRect().width, stroke: getComputedStyle(line).strokeWidth, vector: getComputedStyle(line).vectorEffect };
});
record(11, 'Mic resize rotate stroke regression', micChanged.object.geometrySized && micChanged.object.width === 76 && micChanged.object.height === 86 && micChanged.object.rotation === 45 && micChanged.object.strokeWidth === 4 && micChanged.stroke === '4px' && micChanged.vector === 'non-scaling-stroke');

await page.evaluate(() => window.StagePlotEditor.selectIds(['monitor-audit']));
await page.evaluate(() => window.StagePlotEditor.setField('ratioLocked', false));
await page.evaluate(() => window.StagePlotEditor.setGeometry('width', 112));
await page.evaluate(() => window.StagePlotEditor.setGeometry('height', 92));
await page.evaluate(() => window.StagePlotEditor.setField('rotation', -30));
await page.evaluate(() => window.StagePlotEditor.setField('strokeWidth', 3.5));
const monitorChanged = await page.evaluate(() => {
  const object = window.StagePlotEditor.snapshot().objects.find(item => item.id === 'monitor-audit');
  const rect = document.querySelector('[data-id="monitor-audit"] .mon-svg rect');
  return { object, stroke: getComputedStyle(rect).strokeWidth, vector: getComputedStyle(rect).vectorEffect, fill: getComputedStyle(rect).fill };
});
record(12, 'Monitor resize rotate stroke regression', monitorChanged.object.geometrySized && monitorChanged.object.width === 112 && monitorChanged.object.height === 92 && monitorChanged.object.rotation === -30 && monitorChanged.object.strokeWidth === 3.5 && monitorChanged.stroke === '3.5px' && monitorChanged.vector === 'non-scaling-stroke' && monitorChanged.fill === 'rgb(255, 255, 255)');

const beforeExport = await page.evaluate(() => window.StagePlotEditor.snapshot());
const png = await page.evaluate(() => window.StagePlotEditor.stagePng());
const pdfPath = path.join(outputDir, 'accordion-symbol-regression.pdf');
await page.pdf({ path: pdfPath, printBackground: true, format: 'A4' });
const afterExport = await page.evaluate(() => window.StagePlotEditor.snapshot());
const exportsValid = png.startsWith('data:image/png') && png.length > 1000 && (await fs.stat(pdfPath)).size > 5000 && JSON.stringify(beforeExport) === JSON.stringify(afterExport);
record(13, 'Mic PDF PNG regression', exportsValid && beforeExport.objects.some(item => item.type === 'microphone'));
record(14, 'Monitor PDF PNG regression', exportsValid && beforeExport.objects.some(item => item.type === 'monitor'));

const result = {
  total: Object.keys(checks).length,
  passed: Object.values(checks).filter(Boolean).length,
  failed: Object.values(checks).filter(value => !value).length,
  checks,
  defaultSymbols,
  fatalErrors,
};
await fs.writeFile(path.join(outputDir, 'stage-plot-accordion-symbol-visual-report.json'), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
await context.close();
await browser.close();
if (result.failed || fatalErrors.length) process.exitCode = 1;
