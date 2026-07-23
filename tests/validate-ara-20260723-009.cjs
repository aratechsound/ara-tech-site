const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const installation = read('installation.html');

assert.match(installation, /<title>店舗・施設の音響・照明・映像設備施工｜広島のARA-TECH<\/title>/);
assert.match(installation, /<meta name="description" content="[^"]*広島[^"]*店舗・施設[^"]*音響[^"]*照明[^"]*LEDスクリーン[^"]*LEDビジョン[^"]*プロジェクター[^"]*設計・設置・調整[^"]*">/);
assert.match(installation, /<link rel="canonical" href="https:\/\/ara-tech\.cc\/installation\.html">/);
assert.match(installation, /<meta property="og:url" content="https:\/\/ara-tech\.cc\/installation\.html">/);
assert.match(installation, /<meta name="twitter:card" content="summary_large_image">/);

const h1 = installation.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] || '';
assert.match(h1, /店舗・施設の/);
assert.match(h1, /音響・照明・映像設備施工/);

for (const term of [
    'スピーカー', 'アンプ', 'ミキサー', 'マイク', 'BGM設備', '音声配線', '音響調整',
    '店舗・施設の照明設備', 'ステージ照明', '演出照明', '調光・照明制御',
    'LEDスクリーン（LEDビジョン）', 'プロジェクター', '投影スクリーン', 'モニター', '映像信号・配線',
    '総合設備設計', '新規開店・新規導入', '改装・設備追加', '古い設備の更新', '既存設備の改善',
    '約30年の現場経験', '代表者本人', '一人運営の技術会社'
]) {
    assert.ok(installation.includes(term), `installation.html is missing required text: ${term}`);
}

assert.match(installation, /href="contact\.html#general-inquiry"/);
assert.match(installation, /<nav aria-label="パンくず">/);
assert.doesNotMatch(installation, /業界No\.1|最安|必ず改善|プロ集団|現場を知り尽くしたスタッフ/);

const jsonLdText = installation.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1];
assert.ok(jsonLdText, 'JSON-LD is missing');
const graph = JSON.parse(jsonLdText)['@graph'];
assert.deepEqual(graph.map((item) => item['@type']), ['WebPage', 'BreadcrumbList', 'Service']);
assert.equal(graph[0].url, 'https://ara-tech.cc/installation.html');
assert.equal(graph[1].itemListElement.length, 2);
assert.equal(graph[2].name, '店舗・施設の音響・照明・映像設備施工');

for (const match of installation.matchAll(/<img\b[^>]*class="[^"]*showcase-img[^"]*"[^>]*>/g)) {
    assert.match(match[0], /\bwidth="\d+"/);
    assert.match(match[0], /\bheight="\d+"/);
    assert.match(match[0], /\bloading="lazy"/);
    assert.match(match[0], /\bdecoding="async"/);
}
assert.equal((installation.match(/\bclass="showcase-img zoom-single"/g) || []).length, 2);
assert.match(installation, /\.showcase-img \{ width: 100%; height: auto;/);

const inlineScripts = [...installation.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
assert.ok(inlineScripts.length >= 2);
for (const [index, script] of inlineScripts.entries()) {
    new vm.Script(script, { filename: `installation-inline-${index}.js` });
}

const relatedCopy = [
    read('index.html'),
    read('contact.html'),
    read('api/work.js')
].join('\n');
assert.match(relatedCopy, /音響・照明・映像設備施工/);
assert.doesNotMatch(read('index.html'), /店舗音響の設備施工|店舗や施設の音響・照明システム|プロ集団/);
assert.doesNotMatch(read('contact.html'), /店舗音響・設備施工、保守・修理/);
assert.match(read('contact.html'), /店舗設備（音響・照明・映像）導入・保守/);
assert.doesNotMatch(read('api/work.js'), /音響・映像設備工事/);

for (const match of installation.matchAll(/\s(?:href|src)="([^"]+)"/g)) {
    const value = match[1].replaceAll('&amp;', '&');
    if (/^(?:https?:|mailto:|tel:|data:|#)/.test(value)) continue;
    const url = new URL(value, 'http://local.test/');
    if (url.pathname === '/') continue;
    const target = decodeURIComponent(url.pathname.replace(/^\//, ''));
    assert.ok(fs.existsSync(path.join(root, target)), `missing local target: ${value}`);
}

console.log('ARA-20260723-009 installation validation passed');
