import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'file:///C:/Users/user/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';

const [, , beforeBaseUrl, afterBaseUrl, outputDir] = process.argv;
if (!beforeBaseUrl || !afterBaseUrl || !outputDir) {
  throw new Error('usage: node stage-plot-center-grid-audit.mjs <beforeBaseUrl> <afterBaseUrl> <outputDir>');
}

const caseId = '11111111-1111-4111-8111-111111111111';
const chrome = 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe';
await fs.mkdir(outputDir, { recursive: true });

const browser = await chromium.launch({ executablePath: chrome, headless: true });

async function installHarness(page) {
  await page.addInitScript(expectedCaseId => {
    window.__ARA_STAGE_PLOT_PAGE_TEST_DEPS__ = {
      createClient: () => ({
        auth: { getSession: async () => ({ data: { session: { access_token: 'center-grid-local-only' } } }) },
        from: () => {
          const builder = {
            select() { return builder; },
            eq() { return builder; },
            is() { return builder; },
            maybeSingle: async () => ({ data: { event_date: '2026-10-18', confirmed_event_date: '2026-10-18' }, error: null }),
          };
          return builder;
        },
      }),
      persistence: {
        list: async id => id === expectedCaseId ? [] : Promise.reject(new Error('inquiry_not_found')),
        create: async (_id, state) => ({ id: '22222222-2222-4222-8222-222222222222', current_revision: 1, state }),
        save: async (_id, plotId, state) => ({ id: plotId, current_revision: 2, state }),
      },
    };
  }, caseId);
}

async function openEditor(baseUrl, viewport = { width: 1440, height: 1000 }) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await installHarness(page);
  await page.goto(`${baseUrl}/pa-stage-plot-editor.html?caseId=${caseId}`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.StagePlotEditor && window.StagePlotPage?.mode === 'new');
  await page.evaluate(() => {
    const state = window.StagePlotEditor.snapshot();
    state.objects = [];
    window.StagePlotEditor.loadSnapshot(state, { rememberPrevious: false, source: 'center-grid-audit' });
  });
  return { context, page, errors };
}

async function screenMetrics(page) {
  return page.evaluate(() => {
    const stage = document.querySelector('.stage');
    const style = getComputedStyle(stage);
    const centerStyle = getComputedStyle(stage, '::before');
    const borderLeft = Number.parseFloat(style.borderLeftWidth);
    const spacing = Number.parseFloat(style.backgroundSize.split(' ')[0]);
    const positionText = style.backgroundPositionX;
    const positionPercent = Number.parseFloat(positionText);
    const positioningWidth = stage.clientWidth;
    const tileStart = borderLeft + (positioningWidth - spacing) * positionPercent / 100;
    const firstDot = tileStart + spacing / 2;
    const centerX = borderLeft + Number.parseFloat(centerStyle.left);
    const indexAtOrBelow = Math.floor((centerX - firstDot) / spacing);
    const dotAtOrBelow = firstDot + indexAtOrBelow * spacing;
    const centerDotAligned = positionText === '50%';
    const nearestLeft = centerDotAligned ? centerX - spacing : dotAtOrBelow;
    const nearestRight = centerDotAligned ? centerX + spacing : dotAtOrBelow + spacing;
    const symmetricColumns = Array.from({ length: 4 }, (_, index) => {
      const n = index + 1;
      return { n, leftX: centerX - n * spacing, rightX: centerX + n * spacing, leftDistance: n * spacing, rightDistance: n * spacing };
    });
    return {
      stageLogicalWidth: 830,
      stageBorderBoxWidth: stage.getBoundingClientRect().width,
      stagePositioningWidth: positioningWidth,
      scale: stage.getBoundingClientRect().width / 830,
      centerX,
      centerLineLeft: centerStyle.left,
      gridSpacing: spacing,
      backgroundPositionX: positionText,
      centerDotAligned,
      observedCenterDotDelta: Math.min(Math.abs(dotAtOrBelow - centerX), Math.abs(dotAtOrBelow + spacing - centerX)),
      nearestLeft,
      nearestRight,
      nearestLeftDistance: centerX - nearestLeft,
      nearestRightDistance: nearestRight - centerX,
      symmetricColumns,
    };
  });
}

async function pngMetrics(page) {
  return page.evaluate(async () => {
    const image = new Image();
    image.src = window.StagePlotEditor.stagePng();
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    const rgbaAt = (logicalX, logicalY) => [...context.getImageData(logicalX * 2, logicalY * 2, 1, 1).data];
    return {
      naturalWidth: image.naturalWidth,
      naturalHeight: image.naturalHeight,
      left395: rgbaAt(395, 20),
      oldLeft400: rgbaAt(400, 20),
      center415: rgbaAt(415, 20),
      oldRight420: rgbaAt(420, 20),
      right435: rgbaAt(435, 20),
    };
  });
}

const before = await openEditor(beforeBaseUrl);
const beforeMetrics = await screenMetrics(before.page);
await before.page.locator('.stage').screenshot({ path: path.join(outputDir, 'before-center-grid.png'), animations: 'disabled' });
await before.context.close();

const after = await openEditor(afterBaseUrl);
const initialState = JSON.stringify(await after.page.evaluate(() => window.StagePlotEditor.snapshot()));
const desktopMetrics = await screenMetrics(after.page);
const exportedPng = await pngMetrics(after.page);
await after.page.locator('.stage').screenshot({ path: path.join(outputDir, 'after-center-grid.png'), animations: 'disabled' });

await after.page.setViewportSize({ width: 1000, height: 800 });
await after.page.waitForTimeout(100);
const resizedMetrics = await screenMetrics(after.page);

await after.page.setViewportSize({ width: 390, height: 844 });
await after.page.waitForTimeout(100);
const mobile390Metrics = await screenMetrics(after.page);
await after.page.evaluate(() => window.StagePlotEditor.enterMobileEdit());
await after.page.waitForTimeout(100);
const mobileFullscreenMetrics = await screenMetrics(after.page);
await after.page.screenshot({ path: path.join(outputDir, 'mobile-center-grid.png'), fullPage: false, animations: 'disabled' });

await after.page.setViewportSize({ width: 1440, height: 1000 });
await after.page.evaluate(() => window.StagePlotEditor.exitMobileEdit());
await after.page.emulateMedia({ media: 'print' });
await after.page.evaluate(() => document.body.classList.add('print-stage-only'));
const printMetrics = await screenMetrics(after.page);
await after.page.pdf({
  path: path.join(outputDir, 'native-stage-center-grid.pdf'),
  format: 'A4',
  landscape: true,
  margin: { top: '0', right: '0', bottom: '0', left: '0' },
  printBackground: true,
  tagged: true,
});
const finalState = JSON.stringify(await after.page.evaluate(() => window.StagePlotEditor.snapshot()));

const aligned = metrics => metrics.centerDotAligned
  && Math.abs(metrics.centerX - 415) < 0.01
  && Math.abs(metrics.nearestLeftDistance - metrics.nearestRightDistance) < 0.01
  && metrics.symmetricColumns.every(item => item.leftDistance === item.rightDistance);
const gridColor = rgba => rgba[0] === 219 && rgba[1] === 231 && rgba[2] === 240 && rgba[3] === 255;
const report = {
  before: beforeMetrics,
  after: {
    desktop: desktopMetrics,
    resized: resizedMetrics,
    mobile390: mobile390Metrics,
    mobileFullscreen: mobileFullscreenMetrics,
    print: printMetrics,
    exportedPng,
  },
  snapGridPresent: false,
  errors: after.errors,
  checks: {
    beforeMismatchReproduced: !beforeMetrics.centerDotAligned && beforeMetrics.nearestLeftDistance !== beforeMetrics.nearestRightDistance,
    desktopAligned: aligned(desktopMetrics),
    resizedAligned: aligned(resizedMetrics),
    mobile390Aligned: aligned(mobile390Metrics),
    mobileFullscreenAligned: aligned(mobileFullscreenMetrics),
    printAligned: aligned(printMetrics),
    pngAligned: gridColor(exportedPng.left395) && gridColor(exportedPng.right435) && !gridColor(exportedPng.oldLeft400) && !gridColor(exportedPng.oldRight420),
    stateUnchanged: initialState === finalState,
    noFatalErrors: after.errors.length === 0,
  },
};
await fs.writeFile(path.join(outputDir, 'center-grid-numeric-proof.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report.checks, null, 2));
await after.context.close();
await browser.close();
if (Object.values(report.checks).some(value => !value)) process.exitCode = 1;
