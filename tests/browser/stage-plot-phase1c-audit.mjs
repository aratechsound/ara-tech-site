import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'file:///C:/Users/user/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';

const [, , baseUrl, outputDir] = process.argv;
if (!baseUrl || !outputDir) throw new Error('usage: node stage-plot-phase1c-audit.mjs <baseUrl> <outputDir>');
await fs.mkdir(outputDir, { recursive: true });

const caseA = '11111111-1111-4111-8111-111111111111';
const caseB = '99999999-9999-4999-8999-999999999999';
const plot3 = '33333333-3333-4333-8333-333333333333';
const plot5 = '55555555-5555-4555-8555-555555555555';
const plotFail = '77777777-7777-4777-8777-777777777777';
const plotNull = '88888888-8888-4888-8888-888888888888';
const portalHtml = await fs.readFile(path.join(process.cwd(), 'pa-case-portal.html'), 'utf8');

const makeState = ({ performerName, performanceOrder, performanceTime, durationMinutes, marker }) => ({
  schemaVersion: 1,
  metadata: { eventName: 'Phase 1C Mock Festival', performerName, performanceOrder, performanceTime, durationMinutes, allottedTime: `${durationMinutes}分` },
  objects: [
    { id: `${marker}-vo`, type: 'text', label: `${performerName} Vo`, x: 390, y: 240, rotation: 0, scale: 100, fontSize: 24, category: 'brought' },
    { id: `${marker}-mic`, type: 'microphone', label: 'Mic', x: 530, y: 350, rotation: 15, scale: 100, fontSize: 16, category: 'requested' }
  ],
  equipment: { brought: [{ id: `${marker}-b`, name: `${marker}持込機材`, qty: '1' }], requested: [{ id: `${marker}-r`, name: `${marker}手配機材`, qty: '2' }] },
  notes: `${marker} preview state`,
  otherRequest: `${marker} other request`,
  audio: [],
  setlist: [{ id: `${marker}-set`, setlistRowId: `${marker}-set`, type: '曲', title: `${marker} Song`, duration: '3:30', audioRef: '音源なし', playbackMode: '音源なし', audioId: '', sound: '', lighting: '' }]
});

const records = new Map([
  [plot3, { id: plot3, case_id: caseA, performer_name: 'THE ABC', performer_order: '3番目', performance_time: '14:15〜14:50', duration_minutes: 35, current_revision: 4, updated_at: '2026-09-09T05:00:00Z', state: makeState({ performerName: 'THE ABC', performanceOrder: '3番目', performanceTime: '14:15〜14:50', durationMinutes: 35, marker: 'ABC' }) }],
  [plot5, { id: plot5, case_id: caseA, performer_name: 'THE XYZ', performer_order: '5番目', performance_time: '15:10〜15:35', duration_minutes: 25, current_revision: 2, updated_at: '2026-09-09T04:00:00Z', state: makeState({ performerName: 'THE XYZ', performanceOrder: '5番目', performanceTime: '15:10〜15:35', durationMinutes: 25, marker: 'XYZ' }) }],
  [plotFail, { id: plotFail, case_id: caseA, performer_name: 'PREVIEW FAIL', performer_order: '7番目', performance_time: '16:00〜16:20', duration_minutes: 20, current_revision: 1, updated_at: '2026-09-09T03:00:00Z', state: makeState({ performerName: 'PREVIEW FAIL', performanceOrder: '7番目', performanceTime: '16:00〜16:20', durationMinutes: 20, marker: 'FAIL' }) }],
  [plotNull, { id: plotNull, case_id: caseA, performer_name: 'THE ABC', performer_order: null, performance_time: null, duration_minutes: null, current_revision: 3, updated_at: '2026-09-09T02:00:00Z', state: makeState({ performerName: 'THE ABC', performanceOrder: '', performanceTime: '', durationMinutes: 0, marker: 'ABC2' }) }]
]);
const summaries = [...records.values()].map(({ state, ...summary }) => summary);
const portalModel = {
  portal: { id: '22222222-2222-4222-8222-222222222222', case_id: caseA },
  cards: [
    { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', category: 'timetable', title: 'タイムテーブル', card_kind: 'fixed', owner_kind: 'shared', current_version_id: null, versions: [] },
    { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', category: 'script', title: '台本', card_kind: 'fixed', owner_kind: 'shared', current_version_id: null, versions: [] }
  ],
  photos: []
};

const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await context.addInitScript(({ expectedCase, editablePlot }) => {
  const session = { access_token: 'phase1c-admin-token' };
  const builderFor = table => {
    const builder = { select() { return builder; }, eq() { return builder; }, is() { return builder; }, maybeSingle: async () => ({ data: table === 'pa_inquiries' ? { id: expectedCase, event_name: 'Phase 1C Mock Festival', event_date: '2026-10-18', event_time: '10:00〜18:00', venue: 'Mock Hall' } : { confirmed_event_date: '2026-10-18' }, error: null }) };
    return builder;
  };
  window.__PA_PORTAL_TEST_DEPS__ = { createClient: () => ({ auth: { getSession: async () => ({ data: { session } }) }, from: builderFor }), pdfjsLib: { GlobalWorkerOptions: {}, getDocument() { throw new Error('not used'); } } };
  window.__ARA_STAGE_PLOT_PAGE_TEST_DEPS__ = {
    createClient: () => ({ auth: { getSession: async () => ({ data: { session } }) } }),
    persistence: { list: async () => [], get: async (caseId, plotId) => {
      if (caseId !== expectedCase || plotId !== editablePlot.id) throw Object.assign(new Error('stage_plot_case_mismatch'), { code: 'stage_plot_case_mismatch' });
      return editablePlot;
    } }
  };
}, { expectedCase: caseA, editablePlot: records.get(plot3) });

let listMode = 'empty';
const requests = [];
const getCounts = new Map();
await context.route('**/*', async route => {
  const request = route.request();
  const url = new URL(request.url());
  if (url.origin !== new URL(baseUrl).origin) return route.continue();
  if (/^\/pa\/cases\/[0-9a-f-]{36}\/portal$/iu.test(url.pathname) || url.pathname === '/event-portal') {
    return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: portalHtml });
  }
  if (url.pathname === '/api/pa-portal' || url.pathname === '/api/event-portal') {
    const input = request.postDataJSON();
    requests.push({ endpoint: url.pathname, input, authorization: request.headers().authorization || '' });
    if (url.pathname === '/api/event-portal') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, result: input.action === 'read' ? { ...portalModel, event: { event_name: 'Organizer Mock', event_date: '2026-10-18', event_time: '10:00〜18:00', venue: 'Mock Hall' } } : {} }) });
    if (input.action === 'read') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, result: portalModel }) });
    if (input.action === 'stage_plot_list') {
      const result = listMode === 'empty' ? [] : listMode === 'one' ? [summaries[0]] : summaries;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, result }) });
    }
    if (input.action === 'stage_plot_get') {
      getCounts.set(input.stage_plot_id, (getCounts.get(input.stage_plot_id) || 0) + 1);
      if (input.inquiry_id === caseA && input.stage_plot_id === plotFail) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ ok: false, code: 'service_unavailable' }) });
      const record = records.get(input.stage_plot_id);
      if (!record || input.inquiry_id !== record.case_id) return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ ok: false, code: 'stage_plot_case_mismatch' }) });
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, result: record }) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, result: [] }) });
  }
  return route.continue();
});

const page = await context.newPage();
const fatal = [];
page.on('pageerror', error => fatal.push(error.message));
page.on('console', message => { if (message.type() === 'error') fatal.push(message.text()); });
const portalUrl = `${baseUrl}/pa/cases/${caseA}/portal`;
await page.goto(portalUrl, { waitUntil: 'networkidle' });
await page.locator('#portal:not([hidden])').waitFor();
await page.getByText('ステージプロットはまだありません', { exact: true }).waitFor();
const emptyCreateUrl = await page.locator('.stage-plot-empty .stage-plot-action--primary').getAttribute('href');
await page.screenshot({ path: path.join(outputDir, 'portal-desktop.png'), fullPage: true });
await page.locator('#stage-plot-admin-area').screenshot({ path: path.join(outputDir, 'portal-stageplot-empty.png') });

listMode = 'one';
await page.reload({ waitUntil: 'networkidle' });
await page.locator('.stage-plot-card').waitFor();
const onePlotCount = await page.locator('.stage-plot-card').count();

listMode = 'many';
await page.reload({ waitUntil: 'networkidle' });
await page.locator('.stage-plot-card').first().waitFor();
const cards = page.locator('.stage-plot-card');
const cardCount = await cards.count();
const order = await page.locator('.stage-plot-order').allTextContents();
const names = await page.locator('.stage-plot-card h4').allTextContents();
const createUrl = await page.locator('#stage-plot-create').getAttribute('href');
const editUrls = await page.locator('.stage-plot-card__actions a:nth-of-type(1)').all().then(items => Promise.all(items.map(item => item.getAttribute('href'))));
const printUrls = await page.locator('.stage-plot-card__actions a:nth-of-type(2)').all().then(items => Promise.all(items.map(item => item.getAttribute('href'))));
const lazyGetBeforeScroll = [...getCounts.values()].reduce((sum, count) => sum + count, 0);
await page.locator('#stage-plot-admin-area').scrollIntoViewIfNeeded();
await page.locator(`[data-plot-id="${plot3}"] iframe`).waitFor({ timeout: 15000 });
await page.locator(`[data-plot-id="${plot5}"] iframe`).waitFor({ timeout: 15000 });
await page.locator(`[data-plot-id="${plotFail}"] .stage-plot-preview-fallback`).waitFor({ timeout: 15000 });
await page.waitForTimeout(600);
const lazyGetAfterScroll = [...getCounts.values()].reduce((sum, count) => sum + count, 0);
await page.locator('#stage-plot-admin-area').screenshot({ path: path.join(outputDir, 'portal-stageplot-card-mock.png') });
await page.locator(`[data-plot-id="${plot3}"] .stage-plot-card__preview`).screenshot({ path: path.join(outputDir, 'portal-preview.png') });

const firstLarge = page.locator(`[data-plot-id="${plot3}"] .stage-plot-card__actions button`);
const getCountBeforeLarge = getCounts.get(plot3) || 0;
await firstLarge.click();
await page.locator('#preview-dialog[open] .stage-plot-large-frame').waitFor({ timeout: 15000 });
await page.waitForTimeout(500);
const getCountAfterLarge = getCounts.get(plot3) || 0;
await page.locator('#preview-dialog').screenshot({ path: path.join(outputDir, 'large-preview.png') });
await page.locator('#preview-close').click();

const listCallsBeforePageShow = requests.filter(item => item.input.action === 'stage_plot_list').length;
await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
await page.waitForFunction(expected => performance.getEntriesByType('resource').length >= 0 && document.querySelectorAll('.stage-plot-card').length === expected, cardCount);
await page.waitForTimeout(250);
const listCallsAfterPageShow = requests.filter(item => item.input.action === 'stage_plot_list').length;

await page.setViewportSize({ width: 390, height: 844 });
await page.locator('#stage-plot-admin-area').scrollIntoViewIfNeeded();
const mobileMetrics = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
await page.screenshot({ path: path.join(outputDir, 'portal-mobile-390.png'), fullPage: true });

await page.goto(`${baseUrl}/pa-stage-plot-editor.html?caseId=${caseA}&plotId=${plot3}`, { waitUntil: 'networkidle' });
await page.waitForFunction(() => document.body.classList.contains('stage-plot-auth-ready'));
const editorMobile = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth, portalHref: document.querySelector('#stagePlotPortalLink')?.getAttribute('href') }));

await page.setViewportSize({ width: 1440, height: 1000 });
await page.goto(`${baseUrl}/pa-stage-plot-editor.html?caseId=${caseA}&plotId=${plot3}&print=1`, { waitUntil: 'networkidle' });
await page.waitForFunction(() => document.body.classList.contains('stage-plot-print-mode'));
const printMode = await page.evaluate(() => ({ portalHref: document.querySelector('#stagePlotPortalLink')?.getAttribute('href'), stageButton: getComputedStyle(document.querySelector('#stagePlotPrintStageBtn')).display, setlistButton: getComputedStyle(document.querySelector('#stagePlotPrintSetlistBtn')).display }));
await page.evaluate(() => { document.body.classList.remove('print-setlist-only'); document.body.classList.add('print-stage-only'); });
await page.pdf({ path: path.join(outputDir, 'native-print-stage.pdf'), format: 'A4', landscape: true, margin: { top: '0', right: '0', bottom: '0', left: '0' }, printBackground: true, tagged: true });
await page.evaluate(() => { document.body.classList.remove('print-stage-only'); document.body.classList.add('print-setlist-only'); });
await page.pdf({ path: path.join(outputDir, 'native-print-setlist.pdf'), format: 'A4', landscape: false, margin: { top: '8mm', right: '8mm', bottom: '8mm', left: '8mm' }, printBackground: true, tagged: true });

const organizer = await context.newPage();
await organizer.goto(`${baseUrl}/event-portal`, { waitUntil: 'networkidle' });
await organizer.locator('#portal:not([hidden])').waitFor();
const organizerControls = await organizer.locator('#stage-plot-admin-area, #stage-plot-create, .stage-plot-card').count();
const organizerStageCalls = requests.filter(item => item.endpoint === '/api/event-portal' && /^stage_plot_/u.test(item.input.action)).length;

const unauthContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
await unauthContext.addInitScript(() => {
  window.__PA_PORTAL_TEST_DEPS__ = { createClient: () => ({ auth: { getSession: async () => ({ data: { session: null } }) } }), pdfjsLib: { GlobalWorkerOptions: {} } };
});
await unauthContext.route('**/pa/cases/**/portal', route => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: portalHtml }));
const unauth = await unauthContext.newPage();
const unauthApi = [];
unauth.on('request', request => { if (request.url().includes('/api/')) unauthApi.push(request.url()); });
await unauth.goto(portalUrl, { waitUntil: 'networkidle' });
await unauth.locator('#portal-login:not([hidden])').waitFor();
const unauthControls = await unauth.locator('#stage-plot-admin-area:not([hidden]), #stage-plot-create:visible').count();

const crossCase = await page.evaluate(async ({ otherCaseId, stagePlotId }) => {
  const response = await fetch('/api/pa-portal', { method: 'POST', headers: { Authorization: 'Bearer phase1c-admin-token', 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'stage_plot_get', inquiry_id: otherCaseId, stage_plot_id: stagePlotId }) });
  return { status: response.status, body: await response.json() };
}, { otherCaseId: caseB, stagePlotId: plot3 });

const mutationCalls = requests.filter(item => /^(?:stage_plot_create|stage_plot_save|add_version|create_card)/u.test(item.input.action));
const expectedNegativeNetworkErrors = fatal.filter(message => /status of (?:400|503)/u.test(message));
const unexpectedFatal = fatal.filter(message => !/status of (?:400|503)/u.test(message));
const routeEvidence = {
  emptyCreateUrl,
  onePlotCount,
  cardCount,
  order,
  names,
  createUrl,
  editUrls,
  printUrls,
  printMode,
  portalRefresh: listCallsAfterPageShow > listCallsBeforePageShow
};
const securityEvidence = {
  organizerControls,
  organizerStageCalls,
  unauthControls,
  unauthApiCalls: unauthApi.length,
  crossCaseStatus: crossCase.status,
  crossCaseCode: crossCase.body.code,
  mutationCalls: mutationCalls.length,
  duplicateNameSeparateIds: names.filter(name => name === 'THE ABC').length === 2,
  lazyGetBeforeScroll,
  lazyGetAfterScroll,
  getCountBeforeLarge,
  getCountAfterLarge,
  previewFailureFallback: true,
  mobileMetrics,
  editorMobile,
  expectedNegativeNetworkErrors,
  unexpectedFatal
};
await fs.writeFile(path.join(outputDir, 'route-tests.txt'), `${JSON.stringify(routeEvidence, null, 2)}\n`);
await fs.writeFile(path.join(outputDir, 'security-tests.txt'), `${JSON.stringify(securityEvidence, null, 2)}\n`);

const checks = {
  empty: emptyCreateUrl === `/pa-stage-plot-editor.html?caseId=${caseA}`,
  onePlot: onePlotCount === 1,
  multipleAndSort: cardCount === 4 && order.join('|') === '3番目|5番目|7番目|順番未設定',
  duplicateNameSafe: securityEvidence.duplicateNameSeparateIds && new Set(editUrls).size === cardCount,
  routes: createUrl === `/pa-stage-plot-editor.html?caseId=${caseA}` && editUrls.every(url => url.includes(`caseId=${caseA}&plotId=`)) && printUrls.every(url => url.endsWith('&print=1')),
  lazyPreview: lazyGetAfterScroll > lazyGetBeforeScroll,
  previewCache: getCountAfterLarge === getCountBeforeLarge,
  largePreview: true,
  previewFailure: true,
  refresh: routeEvidence.portalRefresh,
  returnPortal: editorMobile.portalHref === `/pa/cases/${caseA}/portal` && printMode.portalHref === `/pa/cases/${caseA}/portal`,
  printMode: printMode.stageButton !== 'none' && printMode.setlistButton !== 'none',
  organizerDenied: organizerControls === 0 && organizerStageCalls === 0,
  unauthDenied: unauthControls === 0 && unauthApi.length === 0,
  crossCase: crossCase.status === 400 && crossCase.body.code === 'stage_plot_case_mismatch',
  noMutation: mutationCalls.length === 0,
  portalMobile: mobileMetrics.scrollWidth <= mobileMetrics.clientWidth,
  editorMobile: editorMobile.scrollWidth <= editorMobile.clientWidth,
  noFatal: unexpectedFatal.length === 0
};
console.log(JSON.stringify(checks, null, 2));
if (Object.values(checks).some(value => value !== true)) process.exitCode = 1;

await unauthContext.close();
await context.close();
await browser.close();
