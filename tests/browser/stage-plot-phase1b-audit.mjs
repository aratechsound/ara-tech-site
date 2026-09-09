import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'file:///C:/Users/user/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';

const [, , baseUrl, outputDir] = process.argv;
if (!baseUrl || !outputDir) throw new Error('usage: node stage-plot-phase1b-audit.mjs <baseUrl> <outputDir>');
await fs.mkdir(outputDir, { recursive: true });

const caseId = '11111111-1111-4111-8111-111111111111';
const plotId = '22222222-2222-4222-8222-222222222222';
const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', headless: true });

async function installAuthorizedHarness(page) {
  await page.addInitScript(({ expectedCaseId, expectedPlotId }) => {
    const readRecord = () => JSON.parse(localStorage.getItem('__stage_plot_test_record__') || 'null');
    const writeRecord = value => localStorage.setItem('__stage_plot_test_record__', JSON.stringify(value));
    const increment = key => {
      const next = Number(localStorage.getItem(key) || 0) + 1;
      localStorage.setItem(key, String(next));
      return next;
    };
    window.__ARA_STAGE_PLOT_PAGE_TEST_DEPS__ = {
      createClient: () => ({ auth: { getSession: async () => ({ data: { session: { access_token: 'local-admin-token' } } }) } }),
      persistence: {
        list: async caseId => {
          if (caseId !== expectedCaseId) throw Object.assign(new Error('inquiry_not_found'), { code: 'inquiry_not_found' });
          return readRecord() ? [readRecord()] : [];
        },
        get: async (caseId, requestedPlotId) => {
          const record = readRecord();
          if (caseId !== expectedCaseId || requestedPlotId !== expectedPlotId || !record) throw Object.assign(new Error('stage_plot_not_found'), { code: 'stage_plot_not_found' });
          return record;
        },
        create: async (caseId, state) => {
          if (caseId !== expectedCaseId) throw Object.assign(new Error('inquiry_not_found'), { code: 'inquiry_not_found' });
          increment('__stage_plot_create_count__');
          const record = { id: expectedPlotId, case_id: expectedCaseId, current_revision: 1, state };
          writeRecord(record);
          return record;
        },
        save: async (caseId, requestedPlotId, state) => {
          const record = readRecord();
          if (caseId !== expectedCaseId || requestedPlotId !== expectedPlotId || !record) throw Object.assign(new Error('stage_plot_case_mismatch'), { code: 'stage_plot_case_mismatch' });
          increment('__stage_plot_save_count__');
          const next = { ...record, current_revision: record.current_revision + 1, state };
          writeRecord(next);
          return next;
        },
      },
    };
  }, { expectedCaseId: caseId, expectedPlotId: plotId });
}

const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(String(error)));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
await installAuthorizedHarness(page);
await page.goto(`${baseUrl}/pa-stage-plot-editor.html?caseId=${caseId}`, { waitUntil: 'networkidle' });
try {
  await page.waitForFunction(() => window.StagePlotPage?.mode === 'new' && window.StagePlotEditor);
} catch (error) {
  console.error(JSON.stringify({
    startup: await page.evaluate(() => ({
      bodyClass: document.body.className,
      message: document.querySelector('#stagePlotAccessMessage')?.textContent,
      page: Boolean(window.StagePlotPage),
      editor: Boolean(window.StagePlotEditor),
      testDependencies: Boolean(window.__ARA_STAGE_PLOT_PAGE_TEST_DEPS__),
      scripts: [...document.scripts].map(script => script.src),
    })),
    errors,
  }, null, 2));
  throw error;
}

const routeChecks = await page.evaluate(({ expectedCaseId }) => ({
  mode: window.StagePlotPage.mode,
  caseId: window.StagePlotPage.caseId,
  plotId: window.StagePlotPage.plotId,
  saveStatus: document.querySelector('#stagePlotSaveStatus')?.textContent,
  schemaVersion: window.StagePlotEditor.snapshot().schemaVersion,
  editorVisible: getComputedStyle(document.querySelector('.app')).display !== 'none',
  expectedCaseId,
}), { expectedCaseId: caseId });

await page.evaluate(() => Promise.all([window.StagePlotPage.save(), window.StagePlotPage.save()]));
const firstSave = await page.evaluate(() => ({
  mode: window.StagePlotPage.mode,
  plotId: window.StagePlotPage.plotId,
  revision: window.StagePlotPage.revision,
  createCount: Number(localStorage.getItem('__stage_plot_create_count__') || 0),
  url: location.href,
  status: document.querySelector('#stagePlotSaveStatus')?.textContent,
}));

await page.locator('.notes textarea').fill('ローカル保存・再読込テスト');
await page.locator('.notes textarea').dispatchEvent('change');
const dirtyBeforeSave = await page.evaluate(() => window.StagePlotPage.dirty);
await page.evaluate(() => window.StagePlotPage.save());
const secondSave = await page.evaluate(() => ({
  revision: window.StagePlotPage.revision,
  saveCount: Number(localStorage.getItem('__stage_plot_save_count__') || 0),
  dirty: window.StagePlotPage.dirty,
  status: document.querySelector('#stagePlotSaveStatus')?.textContent,
}));

await page.reload({ waitUntil: 'networkidle' });
await page.waitForFunction(() => window.StagePlotPage?.revision === 2 && window.StagePlotEditor);
const reload = await page.evaluate(() => ({
  mode: window.StagePlotPage.mode,
  revision: window.StagePlotPage.revision,
  notes: window.StagePlotEditor.snapshot().notes,
  dirty: window.StagePlotPage.dirty,
  audioTruth: document.querySelector('#audioFiles')?.textContent,
  audioMetadata: window.StagePlotEditor.snapshot().audio.map(({ audioId, fileName, mimeType }) => ({ audioId, fileName, mimeType })),
}));

await page.screenshot({ path: path.join(outputDir, 'desktop.png'), fullPage: true });
const desktop = await page.evaluate(() => ({
  width: innerWidth,
  scrollWidth: document.documentElement.scrollWidth,
  clientWidth: document.documentElement.clientWidth,
  toolbar: document.querySelector('.topbar')?.getBoundingClientRect().toJSON(),
  stage: document.querySelector('.stage')?.getBoundingClientRect().toJSON(),
  equipmentMode: window.StagePlotEditor.equipmentLayout(),
  pngLength: window.StagePlotEditor.stagePng().length,
}));

await page.evaluate(() => {
  const next = window.StagePlotEditor.snapshot();
  next.equipment.brought = Array.from({ length: 11 }, (_, index) => ({ id: `b-${index}`, name: `持込機材${index + 1}`, qty: '1', detail: '' }));
  next.equipment.requested = Array.from({ length: 11 }, (_, index) => ({ id: `r-${index}`, name: `借用機材${index + 1}`, qty: '1', detail: '' }));
  next.setlist = Array.from({ length: 34 }, (_, index) => ({
    id: `set-${index}`, setlistRowId: `set-${index}`, type: index % 3 === 0 ? 'SE' : '曲',
    title: `進行 ${index + 1}`, duration: '1:00', audioRef: index % 2 ? 'song.wav' : '音源なし',
    audioId: '', playbackMode: index % 2 ? 'file' : '音源なし', soundRequest: `音響要望 ${index + 1}`, lightRequest: `照明要望 ${index + 1}`,
  }));
  window.StagePlotEditor.loadSnapshot(next, { source: 'audit' });
});
await page.waitForTimeout(150);
const adaptive = await page.evaluate(() => ({
  layout: window.StagePlotEditor.equipmentLayout(),
  continuation: document.querySelector('.equipment-continuation')?.classList.contains('has-overflow'),
  setlistPages: document.querySelectorAll('.print-setlist-page').length,
}));

await page.emulateMedia({ media: 'print' });
await page.evaluate(() => document.body.classList.add('print-stage-only'));
await page.pdf({ path: path.join(outputDir, 'native-stage-landscape.pdf'), format: 'A4', landscape: true, margin: { top: '0', right: '0', bottom: '0', left: '0' }, printBackground: true, tagged: true });
await page.evaluate(() => {
  document.body.classList.remove('print-stage-only');
  document.body.classList.add('print-setlist-only');
  const next = window.StagePlotEditor.snapshot();
  next.equipment.brought = next.equipment.brought.slice(0, 2);
  next.equipment.requested = next.equipment.requested.slice(0, 2);
  window.StagePlotEditor.loadSnapshot(next, { source: 'audit-print' });
});
await page.waitForTimeout(100);
await page.pdf({ path: path.join(outputDir, 'native-setlist-portrait.pdf'), format: 'A4', landscape: false, margin: { top: '34mm', right: '8mm', bottom: '8mm', left: '8mm' }, printBackground: true, tagged: true });
await page.emulateMedia({ media: 'screen' });
await page.evaluate(() => document.body.classList.remove('print-setlist-only'));

await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(150);
const mobile = await page.evaluate(() => ({
  width: innerWidth,
  scrollWidth: document.documentElement.scrollWidth,
  clientWidth: document.documentElement.clientWidth,
  bodyScrollWidth: document.body.scrollWidth,
  topbar: document.querySelector('.topbar')?.getBoundingClientRect().toJSON(),
}));
await page.screenshot({ path: path.join(outputDir, 'mobile-390.png'), fullPage: true });
await page.evaluate(() => window.StagePlotEditor.enterMobileEdit());
await page.waitForTimeout(100);
const fullscreen = await page.evaluate(() => ({
  active: document.body.classList.contains('mobile-stage-edit'),
  viewportHeight: document.querySelector('#viewport')?.getBoundingClientRect().height,
  innerHeight,
  scrollWidth: document.documentElement.scrollWidth,
  clientWidth: document.documentElement.clientWidth,
}));
await page.screenshot({ path: path.join(outputDir, 'mobile-fullscreen.png'), fullPage: false });

const deniedContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
const deniedPage = await deniedContext.newPage();
let deniedApiCalls = 0;
await deniedPage.route('**/api/pa-portal**', route => { deniedApiCalls += 1; route.fulfill({ status: 500, body: 'must not call' }); });
await deniedPage.addInitScript(() => {
  window.__ARA_STAGE_PLOT_PAGE_TEST_DEPS__ = {
    createClient: () => ({ auth: { getSession: async () => ({ data: { session: null } }) } }),
  };
});
await deniedPage.goto(`${baseUrl}/pa-stage-plot-editor.html?caseId=${caseId}`, { waitUntil: 'networkidle' });
await deniedPage.waitForFunction(() => document.body.classList.contains('stage-plot-auth-denied'));
const denied = await deniedPage.evaluate(() => ({
  editorVisible: getComputedStyle(document.querySelector('.app')).display !== 'none',
  engineLoaded: Boolean(window.StagePlotEditor),
  message: document.querySelector('#stagePlotAccessMessage')?.textContent,
}));
await deniedContext.close();

const report = {
  routeChecks, firstSave, dirtyBeforeSave, secondSave, reload, desktop, adaptive, mobile, fullscreen,
  denied: { ...denied, apiCalls: deniedApiCalls }, errors,
  checks: {
    routeNew: routeChecks.mode === 'new' && routeChecks.caseId === caseId && routeChecks.schemaVersion === 2,
    firstSaveTransition: firstSave.mode === 'edit' && firstSave.plotId === plotId && firstSave.revision === 1,
    duplicateCreatePrevented: firstSave.createCount === 1,
    revisionIncremented: dirtyBeforeSave && secondSave.revision === 2 && secondSave.saveCount === 1 && !secondSave.dirty,
    saveReload: reload.mode === 'edit' && reload.revision === 2 && reload.notes === 'ローカル保存・再読込テスト' && !reload.dirty,
    audioReloadTruthful: /ファイル未接続/.test(reload.audioTruth || ''),
    pngExport: desktop.pngLength > 1000,
    adaptiveEquipment: adaptive.layout.overflow > 0 && adaptive.continuation,
    setlistPagination: adaptive.setlistPages >= 2,
    mobileNoOverflow: mobile.scrollWidth <= mobile.clientWidth && mobile.bodyScrollWidth <= mobile.width,
    mobileFullscreen: fullscreen.active && Math.abs(fullscreen.viewportHeight - fullscreen.innerHeight) <= 1,
    unauthDenied: !denied.editorVisible && !denied.engineLoaded && deniedApiCalls === 0,
    noFatalErrors: errors.length === 0,
  },
};
await fs.writeFile(path.join(outputDir, 'browser-audit.json'), JSON.stringify(report, null, 2));
await fs.writeFile(path.join(outputDir, 'route-test.txt'), `${JSON.stringify({ routeChecks, denied: report.denied, checks: { routeNew: report.checks.routeNew, unauthDenied: report.checks.unauthDenied } }, null, 2)}\n`);
await fs.writeFile(path.join(outputDir, 'save-reload-test.txt'), `${JSON.stringify({ firstSave, dirtyBeforeSave, secondSave, reload, checks: { firstSaveTransition: report.checks.firstSaveTransition, duplicateCreatePrevented: report.checks.duplicateCreatePrevented, revisionIncremented: report.checks.revisionIncremented, saveReload: report.checks.saveReload, audioReloadTruthful: report.checks.audioReloadTruthful } }, null, 2)}\n`);

console.log(JSON.stringify(report.checks, null, 2));
await context.close();
await browser.close();
if (Object.values(report.checks).some(value => !value)) process.exitCode = 1;
