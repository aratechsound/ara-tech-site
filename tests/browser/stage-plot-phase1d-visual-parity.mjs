import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'file:///C:/Users/user/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';

const [, , outputDir, renderDir] = process.argv;
if (!outputDir || !renderDir) throw new Error('usage: node stage-plot-phase1d-visual-parity.mjs <outputDir> <renderDir>');
await fs.mkdir(outputDir, { recursive: true });
await fs.mkdir(renderDir, { recursive: true });

const chrome = 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe';
const sourceRoot = 'E:/ダウンロード';
const setlistAuthority = path.join(sourceRoot, 'ARA_TECH_setlist_fullwidth_cue_row_mock_v7_visual_clarity (1).html');
const adaptiveAuthority = path.join(sourceRoot, 'ARA_TECH_adaptive_pdf_layout_mock_v2_brand_date_all_pages.html');
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const page = await browser.newPage({ viewport: { width: 1800, height: 1400 }, deviceScaleFactor: 1 });

async function screenshotAuthority(url, selector, index, name) {
  await page.goto(pathToFileURL(url).href, { waitUntil: 'load' });
  await page.waitForFunction(() => [...document.images].every(image => image.complete));
  const locator = page.locator(selector).nth(index);
  await locator.screenshot({ path: path.join(renderDir, name), animations: 'disabled' });
}

await screenshotAuthority(setlistAuthority, '.paper', 0, 'authority-setlist-v7.png');
await screenshotAuthority(adaptiveAuthority, '.group .paper.landscape', 0, 'authority-dance-v2.png');
await screenshotAuthority(adaptiveAuthority, '.group .paper.portrait', 1, 'authority-equipment-v2.png');

const pairs = [
  ['band-vs-html.png', 'authority-setlist-v7.png', 'band-setlist-fixed-2.png', '承認HTML: SET LIST v7', '候補PDF: BAND'],
  ['idol-vs-html.png', 'authority-setlist-v7.png', 'idol-setlist-fixed-2.png', '承認HTML: SET LIST v7', '候補PDF: IDOL'],
  ['dance-vs-html.png', 'authority-dance-v2.png', 'dance-single-mix-fixed-1.png', '承認HTML: Adaptive v2', '候補PDF: DANCE'],
  ['equipment-vs-html.png', 'authority-equipment-v2.png', 'equipment-overflow-fixed-2.png', '承認HTML: Adaptive v2', '候補PDF: EQUIPMENT'],
];

for (const [outputName, authorityName, candidateName, authorityLabel, candidateLabel] of pairs) {
  const [authority, candidate] = await Promise.all([
    fs.readFile(path.join(renderDir, authorityName)),
    fs.readFile(path.join(renderDir, candidateName)),
  ]);
  const authorityData = `data:image/png;base64,${authority.toString('base64')}`;
  const candidateData = `data:image/png;base64,${candidate.toString('base64')}`;
  await page.setContent(`<!doctype html><meta charset="utf-8"><style>
    *{box-sizing:border-box}body{margin:0;padding:20px;background:#dfe5ea;font-family:Arial,"Noto Sans JP","Yu Gothic",sans-serif;color:#111}
    main{display:flex;gap:20px;align-items:flex-start}.panel{width:min-content;background:#fff;padding:10px;box-shadow:0 4px 16px #0002}
    h1{margin:0 0 8px;font-size:14px;line-height:1.2;white-space:nowrap}img{display:block;width:auto;height:auto;max-height:1123px}
  </style><main><section class="panel"><h1>${authorityLabel}</h1><img src="${authorityData}"></section><section class="panel"><h1>${candidateLabel}</h1><img src="${candidateData}"></section></main>`);
  await page.waitForFunction(() => [...document.images].every(image => image.complete));
  const authorityWidth = await page.locator('.panel img').first().evaluate(image => image.naturalWidth);
  await page.locator('.panel img').nth(1).evaluate((image, width) => { image.style.width = `${width}px`; }, authorityWidth);
  await page.locator('main').screenshot({ path: path.join(outputDir, outputName), animations: 'disabled' });
}

await browser.close();
console.log('PASS stage-plot-phase1d-visual-parity');
