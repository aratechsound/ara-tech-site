import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'file:///C:/Users/user/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';

const [, , baseUrl, outputDir] = process.argv;
if (!baseUrl || !outputDir) throw new Error('usage: node stage-plot-production-review-phase-b-audit.mjs <baseUrl> <outputDir>');
await fs.mkdir(outputDir, { recursive: true });

const caseId = '11111111-1111-4111-8111-111111111111';
const performerA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const performerB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const performerC = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const plotA = '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const plotB = '22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const plotConflict = '33333333-cccc-4ccc-8ccc-cccccccccccc';
const plotUnknownStable = '44444444-dddd-4ddd-8ddd-dddddddddddd';

const makeState = ({ name, order, performerId = '' }) => ({
  schemaVersion: 2,
  metadata: { eventName: 'LOCAL PORTAL REVIEW', eventDate: '2026-10-18', performerName: name, performanceOrder: String(order), performanceTime: '', allottedTime: '', ...(performerId ? { performerId } : {}) },
  objects: [
    { id: `${order}-b`, type: 'rect', x: 80, y: 70, width: 100, height: 50, rotation: 0, scale: 100, label: '持込AMP', fontSize: 11, category: 'brought', strokeWidth: 1.5, labelEdited: true, className: '', html: '<div class="rect">持込AMP</div>' },
    { id: `${order}-v`, type: 'monitor', x: 240, y: 110, width: 70, height: 55, rotation: 0, scale: 100, label: '会場MONITOR', fontSize: 10, category: 'venue_borrow', strokeWidth: 2, labelEdited: true, className: '', html: '' },
    { id: `${order}-r`, type: 'circle', x: 430, y: 150, width: 70, height: 70, rotation: 0, scale: 100, label: 'レンタルMIC', fontSize: 10, category: 'rental', strokeWidth: 2.5, labelEdited: true, className: '', html: '<div class="circle">レンタルMIC</div>' },
    { id: `${order}-u`, type: 'rect', x: 610, y: 210, width: 105, height: 45, rotation: 0, scale: 100, label: '要確認 泛用DI', fontSize: 10, category: 'unspecified', strokeWidth: 1, labelEdited: true, className: '', html: '<div class="rect">要確認 泛用DI</div>' },
  ],
  equipment: {
    brought: [{ id: 'manual-b', source: 'manual', name: 'Guitar Amplifier', qty: '1', detail: '' }],
    venue_borrow: [{ id: 'manual-v', source: 'manual', name: 'Venue Monitor', qty: '2', detail: '' }],
    rental: [{ id: 'manual-r', source: 'manual', name: 'Wireless Microphone', qty: '1', detail: '' }],
    unspecified: [{ id: 'manual-u', source: 'manual', name: 'Direct Injection Box', qty: '1', detail: '' }],
    order: { brought: [], venue_borrow: [], rental: [], unspecified: [] },
  },
  notes: '', otherRequests: '', audio: [], setlist: [], setlistOutputMode: 'none', singleMix: {},
});

const records = new Map([
  [plotA, { id: plotA, case_id: caseId, performer_name: 'STALE NAME', performer_order: '6', current_revision: 7, updated_at: '2026-09-10T08:00:00Z', state: makeState({ name: 'STALE NAME', order: 6, performerId: performerA }) }],
  [plotB, { id: plotB, case_id: caseId, performer_name: 'BETA', performer_order: '2番目', current_revision: 3, updated_at: '2026-09-10T07:00:00Z', state: makeState({ name: 'BETA', order: 2 }) }],
  [plotConflict, { id: plotConflict, case_id: caseId, performer_name: 'OTHER BAND', performer_order: '3番目', current_revision: 2, updated_at: '2026-09-10T06:00:00Z', state: makeState({ name: 'OTHER BAND', order: 3 }) }],
  [plotUnknownStable, { id: plotUnknownStable, case_id: caseId, performer_id: 'missing-performer-id', performer_name: 'GAMMA', performer_order: '3番目', current_revision: 5, updated_at: '2026-09-10T05:00:00Z', state: makeState({ name: 'GAMMA', order: 3 }) }],
]);
const summaries = [...records.values()].map(({ state, ...summary }) => summary);
const portalModel = {
  portal: { id: '99999999-9999-4999-8999-999999999999', case_id: caseId },
  cards: [
    { id: performerA, category: 'performer', title: 'ALPHA', performer_order: 1, current_version_id: 'doc-a', versions: [{ id: 'doc-a', display_filename: 'ALPHA提出資料.txt', mime_type: 'text/plain', contributor_kind: 'performer', created_at: '2026-09-09T03:00:00Z' }] },
    { id: performerB, category: 'performer', title: 'BETA', performer_order: 2, current_version_id: null, versions: [] },
    { id: performerC, category: 'performer', title: 'GAMMA', performer_order: 3, current_version_id: null, versions: [] },
    { id: 'fixed-timetable', category: 'timetable', title: 'タイムテーブル', card_kind: 'fixed', versions: [] },
    { id: 'fixed-script', category: 'script', title: '台本', card_kind: 'fixed', versions: [] },
  ],
  photos: [],
};

const portalHtml = await fs.readFile(path.join(process.cwd(), 'pa-case-portal.html'), 'utf8');
const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', headless: true });
const context = await browser.newContext({ viewport: { width: 1500, height: 1100 }, deviceScaleFactor: 1 });
await context.addInitScript(() => {
  const session = { access_token: 'local-portal-review' };
  const builderFor = table => {
    const builder = { select() { return builder; }, eq() { return builder; }, is() { return builder; }, maybeSingle: async () => ({ data: table === 'pa_inquiries' ? { event_name: 'LOCAL PORTAL REVIEW', event_date: '2026-10-18', event_time: '10:00', venue: 'LOCAL HALL' } : { confirmed_event_date: '2026-10-18' }, error: null }) };
    return builder;
  };
  window.__PA_PORTAL_TEST_DEPS__ = { createClient: () => ({ auth: { getSession: async () => ({ data: { session } }) }, from: builderFor }), pdfjsLib: { GlobalWorkerOptions: {}, getDocument() { throw new Error('not used'); } } };
  window.__ARA_STAGE_PLOT_PAGE_TEST_DEPS__ = { createClient: () => ({ auth: { getSession: async () => ({ data: { session } }) } }) };
});
const requests = [];
await context.route('**/*', async route => {
  const request = route.request();
  const url = new URL(request.url());
  if (url.origin !== new URL(baseUrl).origin) return route.continue();
  if (/^\/pa\/cases\/[0-9a-f-]{36}\/portal$/iu.test(url.pathname)) return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: portalHtml });
  if (url.pathname === '/api/pa-portal') {
    const input = request.postDataJSON();
    requests.push(input);
    if (input.action === 'read') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, result: portalModel }) });
    if (input.action === 'stage_plot_list') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, result: summaries }) });
    if (input.action === 'stage_plot_get') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, result: records.get(input.stage_plot_id) }) });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, result: {} }) });
  }
  return route.continue();
});

const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(String(error)));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
await page.goto(`${baseUrl}/pa/cases/${caseId}/portal`, { waitUntil: 'networkidle' });
await page.locator('#portal:not([hidden])').waitFor();
await page.locator(`[data-performer-id="${performerA}"] [data-plot-id="${plotA}"]`).waitFor();
await page.locator(`[data-performer-id="${performerB}"] [data-plot-id="${plotB}"]`).waitFor();

const alpha = page.locator(`[data-performer-id="${performerA}"]`);
const beta = page.locator(`[data-performer-id="${performerB}"]`);
const gamma = page.locator(`[data-performer-id="${performerC}"]`);
const unassigned = page.locator('#stage-plot-content');
const createUrl = await gamma.locator('.performer-stage-plot-create').getAttribute('href');
const editUrl = await alpha.locator('.stage-plot-card__actions a').nth(0).getAttribute('href');
const printUrl = await alpha.locator('.stage-plot-card__actions a').nth(1).getAttribute('href');
const desktop = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));

await alpha.scrollIntoViewIfNeeded();
await alpha.locator('iframe').waitFor({ timeout: 15000 });
await page.waitForTimeout(500);
await page.screenshot({ path: path.join(outputDir, '09_portal_performer_card_100.png'), fullPage: true, animations: 'disabled' });

await alpha.getByRole('button', { name: '大きく見る', exact: true }).last().click();
await page.locator('#preview-dialog[open] .stage-plot-large-frame').waitFor({ timeout: 15000 });
await page.waitForTimeout(500);
const frame = page.frameLocator('#preview-dialog .stage-plot-large-frame');
const overlayState = await frame.locator('body').evaluate(body => ({
  previewMode: body.classList.contains('stage-plot-preview-mode'),
  magnetVisible: [...body.querySelectorAll('.magnet-toggle')].some(node => getComputedStyle(node).display !== 'none'),
  overlayVisible: [...body.querySelectorAll('.editor-overlay,.transform-handle,.selection-lock-indicator,.stage-context-menu')].some(node => getComputedStyle(node).display !== 'none'),
}));
const equipmentPreview = await frame.locator('.carry').evaluate(carry => ({
  sections: [...carry.querySelectorAll('.equip-title span')].map(node => node.textContent.trim()).filter(Boolean),
  names: [...carry.querySelectorAll('.equip-row input:not(.qty)')].map(node => ({ value: node.value, clientWidth: node.clientWidth, scrollWidth: node.scrollWidth })),
}));
await page.locator('#preview-dialog').screenshot({ path: path.join(outputDir, '10_portal_large_preview_100.png'), animations: 'disabled' });
await page.locator('#preview-close').click();

await page.setViewportSize({ width: 390, height: 844 });
const mobile = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));

const parsedCreate = new URL(createUrl, baseUrl);
const checks = {
  performerStableIdBinding: await alpha.locator(`[data-plot-id="${plotA}"]`).count() === 1,
  exactNameOrderFallback: await beta.locator(`[data-plot-id="${plotB}"]`).count() === 1,
  conflictingNameSameOrderNotBound: await gamma.locator(`[data-plot-id="${plotConflict}"]`).count() === 0,
  unknownStableIdNotNameFallback: await gamma.locator(`[data-plot-id="${plotUnknownStable}"]`).count() === 0,
  unassignedFallback: await unassigned.locator('.stage-plot-card').count() === 2 && (await page.locator('#stage-plot-title').textContent()) === '未割当Stage Plot',
  createFromPerformerPassesIds: parsedCreate.searchParams.get('caseId') === caseId && parsedCreate.searchParams.get('performerId') === performerC && parsedCreate.searchParams.get('performerName') === 'GAMMA' && parsedCreate.searchParams.get('performerOrder') === '3',
  existingPlotPreserved: await page.locator('.stage-plot-card').count() === 4,
  revisionPreserved: (await alpha.locator('.stage-plot-revision').textContent()) === 'Revision 7',
  editLinkCorrect: editUrl === `/pa-stage-plot-editor.html?caseId=${caseId}&plotId=${plotA}`,
  printLinkCorrect: printUrl === `/pa-stage-plot-editor.html?caseId=${caseId}&plotId=${plotA}&print=1`,
  existingPortalDocs: await alpha.locator('.performer-document', { hasText: 'ALPHA提出資料.txt' }).count() === 1,
  magnetAbsent: overlayState.previewMode && !overlayState.magnetVisible,
  editorOverlaysAbsent: !overlayState.overlayVisible,
  equipmentNamesFull: equipmentPreview.names.length >= 8 && equipmentPreview.names.every(item => item.value.length > 2 && item.scrollWidth <= item.clientWidth + 1),
  provisionFourSections: ['出演者持込', '会場借用', 'レンタル', '未指定・要確認'].every(label => equipmentPreview.sections.includes(label)),
  desktopNoOverflow: desktop.scrollWidth <= desktop.clientWidth,
  mobile390NoOverflow: mobile.scrollWidth <= mobile.clientWidth,
  noFatalErrors: errors.length === 0,
};
const report = { checks, createUrl, editUrl, printUrl, overlayState, equipmentPreview, desktop, mobile, requests, errors };
await fs.writeFile(path.join(outputDir, 'phase-b-audit.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ total: Object.keys(checks).length, passed: Object.values(checks).filter(Boolean).length, failed: Object.values(checks).filter(value => !value).length, checks }, null, 2));
await context.close();
await browser.close();
if (Object.values(checks).some(value => value !== true)) process.exitCode = 1;
