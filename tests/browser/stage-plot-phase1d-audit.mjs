import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'file:///C:/Users/user/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';

const [, , baseUrl, outputDir] = process.argv;
if (!baseUrl || !outputDir) throw new Error('usage: node stage-plot-phase1d-audit.mjs <baseUrl> <outputDir>');
await fs.mkdir(outputDir, { recursive: true });

const caseId = '11111111-1111-4111-8111-111111111111';
const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, deviceScaleFactor: 1 });
await context.addInitScript(expectedCaseId => {
  const resultFor = table => table === 'pa_inquiries'
    ? { data: { event_date: '2026-10-18' }, error: null }
    : { data: { confirmed_event_date: '2026-10-18' }, error: null };
  const builderFor = table => {
    const builder = { select() { return builder; }, eq() { return builder; }, is() { return builder; }, maybeSingle: async () => resultFor(table) };
    return builder;
  };
  window.__ARA_STAGE_PLOT_PAGE_TEST_DEPS__ = {
    createClient: () => ({ auth: { getSession: async () => ({ data: { session: { access_token: 'phase1d-local-admin' } } }) }, from: builderFor }),
    persistence: {
      list: async id => id === expectedCaseId ? [] : Promise.reject(Object.assign(new Error('inquiry_not_found'), { code: 'inquiry_not_found' })),
      create: async (_id, state) => ({ id: '22222222-2222-4222-8222-222222222222', current_revision: 1, state }),
      save: async (_id, plotId, state) => ({ id: plotId, current_revision: 2, state }),
    },
  };
}, caseId);

const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(String(error)));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
await page.goto(`${baseUrl}/pa-stage-plot-editor.html?caseId=${caseId}`, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.StagePlotEditor && window.StagePlotPage?.mode === 'new');
await page.waitForFunction(() => window.StagePlotEditor.snapshot().metadata.eventDate === '2026-10-18');

const baseState = await page.evaluate(() => window.StagePlotEditor.snapshot());
const audio = (id, fileName) => ({ id, audioId: id, fileName, name: fileName, mimeType: 'audio/wav', type: 'audio/wav', size: 12345 });
const row = (id, type, title, duration, cue = 'none', options = {}) => ({
  id, setlistRowId: id, type, title, duration,
  audioRef: options.audioId ? `audio:${options.audioId}` : '音源なし', audioId: options.audioId || '', playbackMode: options.audioId ? 'file' : '音源なし',
  soundRequest: options.sound || '', lightRequest: options.light || '', playbackCue: cue,
  playbackCueCustom: options.custom || '', playbackCueDetail: options.detail || '',
});
const equipment = (broughtCount, requestedCount) => ({
  brought: Array.from({ length: broughtCount }, (_, index) => ({ id: `b-${index + 1}`, name: `Brought item ${index + 1}`, qty: String((index % 3) + 1) })),
  requested: Array.from({ length: requestedCount }, (_, index) => ({ id: `r-${index + 1}`, name: `Requested item ${index + 1}`, qty: String((index % 4) + 1) })),
});
const metadata = { eventName: 'Phase 1D Local Festival', performerName: 'LOCAL FIXTURE', performanceOrder: '3番目', performanceTime: '14:15〜14:50', allottedTime: '35分', eventDate: '2026-10-18' };
const common = { ...baseState, schemaVersion: 2, metadata, notes: 'Phase 1D synthetic local fixture', otherRequests: 'ステージ転換時は安全確認を優先してください。' };

const band = {
  ...common, metadata: { ...metadata, performerName: 'BAND FIXTURE' }, equipment: equipment(4, 4),
  audio: [audio('band-open', '01_opening.wav'), audio('band-end', '06_end.wav')], setlistOutputMode: 'normal',
  setlist: [
    row('band-1', 'SE', 'Opening SE', '1:00', 'show_start', { audioId: 'band-open', detail: '客電アウト後' }),
    row('band-2', '曲', 'Song A', '3:30', 'none', { sound: 'Voを明瞭に、ギターとのバランスを維持', light: '青を基調にサビで白を追加' }),
    row('band-3', '曲', 'Song B', '4:10'), row('band-4', 'MC', 'MC', '2:00'), row('band-5', '曲', 'Song C', '3:45'),
    row('band-6', 'End SE', 'End SE', '1:10', 'blackout', { audioId: 'band-end', detail: '暗転完了後' }),
  ],
};
const idol = {
  ...common, metadata: { ...metadata, performerName: 'IDOL FIXTURE' }, equipment: equipment(1, 1), audio: [audio('idol-1', 'idol_01.wav'), audio('idol-3', 'idol_03.wav')], setlistOutputMode: 'normal',
  setlist: [
    row('idol-1', '曲', '曲1', '3:20', 'on_stage', { audioId: 'idol-1' }), row('idol-2', '曲', '曲2', '3:40', 'continuous'),
    row('idol-mc', 'MC', 'MC', '2:00'), row('idol-3', '曲', '曲3', '3:50', 'title_call', { audioId: 'idol-3', detail: '曲名を言い切ったタイミング' }),
    row('idol-4', '曲', '曲4', '3:30', 'continuous'), row('idol-end', 'End SE', 'End SE', '1:00', 'custom', { custom: '終演後GO', detail: 'お辞儀のあと' }),
  ],
};
const dance = {
  ...common, metadata: { ...metadata, performerName: 'DANCE FIXTURE', allottedTime: '15分' }, equipment: equipment(1, 1), audio: [audio('dance-mix', 'dance_mix_final.wav')], setlist: [], setlistOutputMode: 'single_mix',
  singleMix: { audioRef: 'audio:dance-mix', audioId: 'dance-mix', playbackMode: 'file', duration: '12:30', playbackCue: 'on_stage', playbackCueCustom: '', playbackCueDetail: '最後まで通し再生・途中停止なし', note: '完成ミックス' },
};
const fit = { ...common, metadata: { ...metadata, performerName: 'EQUIPMENT FIT 7/7' }, equipment: equipment(7, 7), setlist: [], setlistOutputMode: 'none' };
const overflow = {
  ...common, metadata: { ...metadata, performerName: 'EQUIPMENT OVERFLOW' }, equipment: equipment(13, 14), setlistOutputMode: 'normal', setlist: [row('overflow-song', '曲', 'After Equipment', '3:00')],
  otherRequests: Array.from({ length: 35 }, (_, index) => `LONG REQUEST ${index + 1}: 安全確認と転換手順を事前共有してください。`).join('\n'),
};
const longSetlist = {
  ...common, metadata: { ...metadata, performerName: 'PAGE BREAK FIXTURE', allottedTime: '90分' }, equipment: equipment(1, 1), setlistOutputMode: 'normal', audio: [audio('long-audio', 'long_fixture.wav')],
  setlist: Array.from({ length: 25 }, (_, index) => row(`long-${index + 1}`, index % 5 === 0 ? 'SE' : index % 4 === 0 ? 'MC' : '曲', `長い曲名・進行内容 ${index + 1} ${'テキスト'.repeat(index % 3 ? 8 : 18)}`, '3:20', index % 3 === 0 ? 'continuous' : index % 3 === 1 ? 'signal' : 'none', { audioId: index % 3 === 2 ? 'long-audio' : '', sound: `音響要望 ${index + 1} ${'明瞭度とバランスを維持 '.repeat(5)}`, light: `照明要望 ${index + 1} ${'青灰と白を段階的に変更 '.repeat(5)}`, detail: index % 3 ? '対象行と同じページに保持' : '' })),
};

async function loadFixture(state) {
  await page.emulateMedia({ media: 'screen' });
  await page.evaluate(value => {
    document.body.classList.remove('print-adaptive-document', 'print-stage-only', 'print-setlist-only');
    window.StagePlotEditor.loadSnapshot(value, { rememberPrevious: false, source: 'phase1d-audit' });
  }, state);
  await page.waitForTimeout(180);
  await page.waitForFunction(() => [...document.images].every(image => image.complete));
}

async function makePdf(name, state) {
  await loadFixture(state);
  await page.emulateMedia({ media: 'print' });
  await page.evaluate(() => document.body.classList.add('print-adaptive-document'));
  await page.pdf({ path: path.join(outputDir, name), printBackground: true, preferCSSPageSize: true, tagged: true, margin: { top: '0', right: '0', bottom: '0', left: '0' } });
  await page.emulateMedia({ media: 'screen' });
}

await loadFixture(band);
const v1 = await page.evaluate(value => {
  const legacy = structuredClone(value);
  legacy.schemaVersion = 1;
  delete legacy.setlistOutputMode;
  legacy.setlist.forEach(item => { delete item.playbackCue; delete item.playbackCueCustom; delete item.playbackCueDetail; });
  window.StagePlotEditor.loadSnapshot(legacy, { rememberPrevious: false, source: 'v1-audit' });
  return window.StagePlotEditor.snapshot();
}, band);
await loadFixture(band);

await page.selectOption('#setlistOutputMode', 'none');
await page.locator('#setlistOutputMode').dispatchEvent('change');
await page.locator('#undoBtn').click();
const undoMode = await page.evaluate(() => window.StagePlotEditor.snapshot().setlistOutputMode);
await page.locator('#redoBtn').click();
const redoMode = await page.evaluate(() => window.StagePlotEditor.snapshot().setlistOutputMode);
await loadFixture(band);

await page.emulateMedia({ media: 'print' });
await page.evaluate(() => document.body.classList.add('print-adaptive-document'));
await page.locator('.print-stage-page').screenshot({ path: path.join(outputDir, 'stage-page-black-logo.png') });
const cueVisual = await page.evaluate(() => {
  const trigger = document.querySelector('.cue-trigger .cue-action.trigger');
  return trigger ? { borderStyle: getComputedStyle(trigger).borderStyle, background: getComputedStyle(trigger).backgroundColor } : null;
});
await page.emulateMedia({ media: 'screen' });

await loadFixture(idol);
await page.emulateMedia({ media: 'print' });
await page.evaluate(() => document.body.classList.add('print-adaptive-document'));
await page.locator('.cue-trigger').first().screenshot({ path: path.join(outputDir, 'setlist-cue-trigger.png') });
await page.locator('.cue-continuous').first().screenshot({ path: path.join(outputDir, 'setlist-cue-continuous.png') });
const continuousVisual = await page.evaluate(() => {
  const node = document.querySelector('.cue-continuous .cue-action.continuous');
  return node ? { borderStyle: getComputedStyle(node).borderStyle, background: getComputedStyle(node).backgroundColor } : null;
});
await page.emulateMedia({ media: 'screen' });

await loadFixture(overflow);
const overflowEvidence = await page.evaluate(() => ({
  layout: window.StagePlotEditor.equipmentLayout(),
  expectedItemCount: window.StagePlotEditor.equipmentRows('brought').length + window.StagePlotEditor.equipmentRows('requested').length,
  page1VisibleItems: [...document.querySelectorAll('#carryList .equip-row, #requestList .request-row')].filter(node => !node.hidden).length,
  pageCount: document.querySelectorAll('.print-equipment-page').length,
  firstSupplementItem: document.querySelector('.print-equipment-page td')?.textContent,
  otherOnlyPages: document.querySelectorAll('.print-equipment-page.other-only').length,
  emptySectionsOnOtherOnly: [...document.querySelectorAll('.print-equipment-page.other-only')].some(node => node.querySelector('.equipment-columns, .equipment-panel')),
  order: [...document.querySelectorAll('.print-stage-page, .print-equipment-pages, .print-setlist-pages')].map(node => node.className),
}));
await page.evaluate(() => {
  const clone = document.querySelector('.print-equipment-page')?.cloneNode(true);
  if (clone) { clone.classList.add('audit-equipment-shot'); document.body.append(clone); }
});
await page.emulateMedia({ media: 'print' });
await page.evaluate(() => document.body.classList.add('print-adaptive-document'));
await page.locator('.audit-equipment-shot').screenshot({ path: path.join(outputDir, 'equipment-overflow-page2.png') });
await page.evaluate(() => document.querySelector('.audit-equipment-shot')?.remove());
await page.emulateMedia({ media: 'screen' });

await loadFixture(fit);
const fitEvidence = await page.evaluate(() => ({ layout: window.StagePlotEditor.equipmentLayout(), supplementPages: document.querySelectorAll('.print-equipment-pages .print-equipment-page').length }));

await page.setViewportSize({ width: 390, height: 844 });
await loadFixture(idol);
await page.screenshot({ path: path.join(outputDir, 'mobile-390.png'), fullPage: true });
const mobile = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
await page.setViewportSize({ width: 1440, height: 1050 });

await makePdf('band-setlist-fixed.pdf', band);
await makePdf('idol-setlist-fixed.pdf', idol);
await makePdf('dance-single-mix-fixed.pdf', dance);
await makePdf('equipment-fit-fixed.pdf', fit);
await makePdf('equipment-overflow-fixed.pdf', overflow);
await makePdf('setlist-page-break-fixed.pdf', longSetlist);

await loadFixture(longSetlist);
await page.emulateMedia({ media: 'print' });
await page.evaluate(() => document.body.classList.add('print-adaptive-document'));
const printDom = await page.evaluate(() => ({
  columns: [...document.querySelectorAll('.print-setlist-table thead th')].slice(0, 6).map(node => node.textContent),
  units: document.querySelectorAll('.print-setlist-unit').length,
  cueUnits: [...document.querySelectorAll('.print-setlist-unit')].filter(unit => unit.firstElementChild?.classList.contains('print-cue-row')).length,
  badCueOrder: [...document.querySelectorAll('.print-setlist-unit')].filter(unit => unit.querySelector('.print-cue-row') && !unit.firstElementChild?.classList.contains('print-cue-row')).length,
  pageCount: document.querySelectorAll('.print-setlist-page').length,
  brandCount: document.querySelectorAll('.print-setlist-page .print-brand img').length,
  eventDateCount: [...document.querySelectorAll('.print-setlist-page .print-brand')].filter(node => node.textContent.includes('2026/10/18')).length,
  selectableText: document.querySelector('.print-setlist-page')?.textContent.includes('音響要望'),
  visual: (() => {
    const style = selector => getComputedStyle(document.querySelector(selector));
    return {
      metaHeight: document.querySelector('.print-document-meta')?.getBoundingClientRect().height,
      metaBorderTop: style('.print-document-meta').borderTopWidth,
      metaBorderBottom: style('.print-document-meta').borderBottomWidth,
      titleFontSize: style('.print-page-title strong').fontSize,
      totalFontSize: style('.print-total-badge b').fontSize,
      tableOuterBorder: style('.print-setlist-table').borderTopWidth,
      internalBorder: style('.print-main-row td').borderRightWidth,
      bodyFontSize: style('.print-main-row td').fontSize,
      bodyLineHeight: style('.print-main-row td').lineHeight,
      triggerBackground: style('.print-cue-row.cue-trigger td').backgroundColor,
      continuousBackground: style('.print-cue-row.cue-continuous td').backgroundColor,
    };
  })(),
}));
await page.emulateMedia({ media: 'screen' });

const jsonRoundtrip = JSON.stringify(await page.evaluate(() => window.StagePlotEditor.snapshot())) === JSON.stringify(await page.evaluate(value => {
  window.StagePlotEditor.loadSnapshot(JSON.parse(JSON.stringify(value)), { rememberPrevious: false, source: 'json-roundtrip' });
  return window.StagePlotEditor.snapshot();
}, longSetlist));
const audioTruth = await page.evaluate(() => ({
  metadata: window.StagePlotEditor.snapshot().audio[0],
  objectUrlPersisted: Object.prototype.hasOwnProperty.call(window.StagePlotEditor.snapshot().audio[0] || {}, 'objectUrl'),
  screenText: document.querySelector('#audioFiles')?.textContent || '',
}));

const checks = {
  v1Backward: v1.schemaVersion === 2 && v1.setlistOutputMode === 'normal' && v1.setlist.every(item => item.playbackCue === 'none'),
  eventDate: baseState.metadata.eventDate === '2026-10-18',
  undoRedo: undoMode === 'normal' && redoMode === 'none',
  cueTriggerDashed: cueVisual?.borderStyle.startsWith('dashed'),
  cueContinuousSolid: continuousVisual?.borderStyle === 'solid',
  equipmentFit: fitEvidence.layout.overflow === 0 && fitEvidence.supplementPages === 0,
  equipmentAllOrNothing: overflowEvidence.layout.overflow === overflowEvidence.expectedItemCount && overflowEvidence.page1VisibleItems === 0 && overflowEvidence.firstSupplementItem === 'Brought item 1',
  equipmentContinuation: overflowEvidence.pageCount >= 2,
  emptyEquipmentSectionsHidden: overflowEvidence.otherOnlyPages > 0 && overflowEvidence.emptySectionsOnOtherOnly === false,
  pageOrder: overflowEvidence.order[0]?.includes('print-stage-page') && overflowEvidence.order[1]?.includes('print-equipment-pages') && overflowEvidence.order[2]?.includes('print-setlist-pages'),
  columns: printDom.columns.join('|') === 'No.|種別|曲名・内容|時間|音響要望|照明要望',
  cueBeforeTarget: printDom.badCueOrder === 0 && printDom.cueUnits > 0,
  everySetlistPageBranded: printDom.pageCount === printDom.brandCount && printDom.pageCount === printDom.eventDateCount,
  textDom: printDom.selectableText === true,
  visualAuthorityCss: printDom.visual.metaHeight < 44
    && printDom.visual.metaBorderTop === '1px'
    && printDom.visual.metaBorderBottom === '2px'
    && printDom.visual.titleFontSize === '18px'
    && printDom.visual.totalFontSize === '18px'
    && printDom.visual.tableOuterBorder === '2px'
    && printDom.visual.internalBorder === '1px'
    && printDom.visual.bodyFontSize === '9.3px'
    && printDom.visual.triggerBackground === 'rgb(247, 245, 241)'
    && printDom.visual.continuousBackground === 'rgb(241, 246, 251)',
  jsonRoundtrip,
  audioMetadata: audioTruth.metadata?.fileName === 'long_fixture.wav' && audioTruth.objectUrlPersisted === false,
  audioReloadTruthful: audioTruth.screenText.includes('ファイル未接続'),
  mobile390: mobile.scrollWidth <= mobile.clientWidth,
  noRuntimeErrors: errors.length === 0,
};
await fs.writeFile(path.join(outputDir, 'browser-audit.json'), `${JSON.stringify({ checks, v1, cueVisual, continuousVisual, fitEvidence, overflowEvidence, printDom, mobile, audioTruth, errors }, null, 2)}\n`);
console.log(JSON.stringify(checks, null, 2));
if (Object.values(checks).some(value => value !== true)) process.exitCode = 1;

await context.close();
await browser.close();
