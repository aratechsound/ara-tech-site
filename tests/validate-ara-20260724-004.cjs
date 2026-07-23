const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const visibleText = (html) => html
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, '');

const contact = read('contact.html');
const general = read('general-inquiry.html');
const inquiry = read('pa-inquiry.html');
const thanks = read('thanks.html');
const sitemap = read('api/sitemap.js');

assert.match(contact, /<h2 id="contact-route-title"[^>]*>お問い合わせ内容をお選びください<\/h2>/);
assert.match(contact, /<h3>イベントPA・ステージ制作<\/h3>/);
assert.match(contact, /<h3>その他のお問い合わせ<\/h3>/);
assert.match(contact, /href="pa-inquiry\.html\?source=contact">イベント依頼・空き状況確認フォームへ<\/a>/);
assert.match(contact, /id="general-inquiry"/);
assert.match(contact, /href="general-inquiry\.html">一般お問い合わせフォームへ<\/a>/);
assert.doesNotMatch(contact, /<form\b|contact-form|formspree|data-fs-field|data-fs-submit-btn/i);

assert.match(general, /<title>一般お問い合わせフォーム \| ARA-TECH（広島）<\/title>/);
assert.match(general, /<meta name="description" content="[^"]*ツアーPA[^"]*設備[^"]*技術講習[^"]*既存案件[^"]*">/);
assert.match(general, /<link rel="canonical" href="https:\/\/ara-tech\.cc\/general-inquiry\.html">/);
assert.match(general, /<meta name="robots" content="index, follow">/);
assert.doesNotMatch(general, /noindex/i);
assert.match(general, /このフォームは、ツアーPA、設備施工・保守、技術講習、営業・取材、既存案件などのお問い合わせ窓口です。イベントPA・ステージ制作の新規依頼は、イベント依頼・空き状況確認フォームをご利用ください。/);
assert.match(general, /href="pa-inquiry\.html">イベント依頼・空き状況確認フォームへ<\/a>/);

assert.match(general, /<form id="contact-form" action="https:\/\/formspree\.io\/f\/mojqjwnr" method="POST" accept-charset="UTF-8">/);
for (const requiredField of [
    /<select id="inquiry-type" name="種類"[^>]*required>/,
    /<input id="name" type="text" name="お名前"[^>]*required>/,
    /<input id="email" type="email" name="email"[^>]*required>/,
    /<input id="tel" type="tel" name="電話番号"/,
    /<textarea id="message" name="メッセージ"[^>]*required>/
]) {
    assert.match(general, requiredField);
}
assert.match(general, /formId: 'mojqjwnr'/);
assert.match(general, /window\.location\.assign\('thanks\.html\?sent=1'\)/);
assert.match(general, /https:\/\/unpkg\.com\/@formspree\/ajax@1/);
const messagePlaceholder = general.match(/<textarea id="message"[^>]*placeholder="([^"]+)"/)?.[1] || '';
assert.ok(messagePlaceholder);
assert.doesNotMatch(messagePlaceholder, /開催日時|開催日|予定人数/);

assert.match(read('tour-pa.html'), /href="general-inquiry\.html"[^>]*>一般お問い合わせフォームへ<\/a>/);
assert.match(read('installation.html'), /href="general-inquiry\.html"[^>]*>一般お問い合わせフォームへ<\/a>/);
assert.match(read('privacy.html'), /href="general-inquiry\.html">一般お問い合わせフォーム<\/a>/);
assert.match(sitemap, /\['\/general-inquiry\.html', '0\.6'\]/);

assert.match(inquiry, /<title>イベント依頼・空き状況確認フォーム \| ARA-TECH<\/title>/);
assert.match(inquiry, /<meta name="description" content="[^"]*イベントPA・ステージ制作[^"]*空き状況[^"]*">/);
assert.match(inquiry, /<meta property="og:title" content="イベント依頼・空き状況確認フォーム \| ARA-TECH">/);
assert.ok(visibleText(inquiry).includes('イベント依頼・空き状況確認フォーム'));
assert.match(inquiry, /<p class="result-label">イベント依頼・空き状況確認フォーム<\/p>/);
assert.match(thanks, /formContextElement\.textContent = 'イベント依頼・空き状況確認フォーム'/);
assert.match(read('pa-rental.html'), /pa-inquiry\.html\?service=pa-rental&amp;source=pa-rental"[^>]*>イベント依頼・空き状況確認フォームへ<\/a>/);
assert.match(read('stage-production.html'), /pa-inquiry\.html\?service=stage-production&amp;source=stage-production"[^>]*>イベント依頼・空き状況確認フォームへ<\/a>/);

const publicHtmlFiles = [
    'index.html',
    'contact.html',
    'general-inquiry.html',
    'pa-inquiry.html',
    'pa-rental.html',
    'stage-production.html',
    'tour-pa.html',
    'installation.html',
    'works.html',
    'privacy.html',
    'thanks.html',
    'pa-schedule-confirm.html'
];
const oldPublicNames = /PA予約お問い合わせフォーム|PA予約・お問い合わせフォーム|PA予約受付フォーム|イベント依頼フォーム/;
for (const file of publicHtmlFiles) {
    const html = read(file);
    assert.doesNotMatch(html, oldPublicNames, `${file} contains an old public event-form name`);
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
    assert.equal(new Set(ids).size, ids.length, `${file} contains duplicate IDs`);
    for (const match of html.matchAll(/\s(?:href|src)="([^"]+)"/g)) {
        const value = match[1].replaceAll('&amp;', '&');
        if (/^(?:https?:|mailto:|tel:|data:|#|javascript:)/.test(value)) continue;
        const url = new URL(value, 'http://local.test/');
        if (url.pathname === '/' || url.pathname.startsWith('/works/')) continue;
        const target = decodeURIComponent(url.pathname.replace(/^\//, ''));
        assert.ok(fs.existsSync(path.join(root, target)), `${file} links to missing local target: ${value}`);
    }
}

const generalInlineScripts = [...general.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
assert.ok(generalInlineScripts.length >= 2);
for (const [index, script] of generalInlineScripts.entries()) {
    new vm.Script(script, { filename: `general-inquiry-inline-${index}.js` });
}

console.log('ARA-20260724-004 general inquiry split validation passed');
