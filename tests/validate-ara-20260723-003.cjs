const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const contact = read('contact.html');
const generalInquiry = read('general-inquiry.html');
const inquiry = read('pa-inquiry.html');
const inquiryScript = read('js/pa-inquiry.js');
const sitemap = read('api/sitemap.js');

assert.match(contact, /id="general-inquiry"/);
assert.match(contact, /href="pa-inquiry\.html\?source=contact"/);
assert.match(contact, /href="general-inquiry\.html"/);
assert.doesNotMatch(contact, /<form\b|formspree/i);
assert.match(generalInquiry, /action="https:\/\/formspree\.io\/f\/mojqjwnr"/);
assert.doesNotMatch(contact, /<option value="PAレンタル">/);
assert.doesNotMatch(contact, /<option value="ステージ制作">/);

assert.match(read('pa-rental.html'), /pa-inquiry\.html\?service=pa-rental&amp;source=pa-rental/);
assert.match(read('stage-production.html'), /pa-inquiry\.html\?service=stage-production&amp;source=stage-production/);
assert.match(read('tour-pa.html'), /general-inquiry\.html/);
assert.match(read('installation.html'), /general-inquiry\.html/);

assert.match(inquiry, /<link rel="canonical" href="https:\/\/ara-tech\.cc\/pa-inquiry\.html">/);
assert.match(inquiry, /<form id="pa-inquiry-form" action="\/api\/pa-inquiry"/);
assert.doesNotMatch(inquiry, /formspree/i);
assert.match(inquiry, /このフォームの送信だけでは、予約または日程確保は完了しません/);
assert.doesNotMatch(inquiry, /noindex|ローカル試作|LOCAL PROTOTYPE/);
assert.match(inquiryScript, /new URLSearchParams\(window\.location\.search\)/);
assert.match(inquiryScript, /allowedSources/);
assert.match(inquiryScript, /"Content-Type": "application\/json"/);
assert.doesNotMatch(inquiryScript, /\.innerHTML\s*=/);

assert.match(sitemap, /\['\/pa-inquiry\.html', '0\.7'\]/);
assert.match(sitemap, /\['\/general-inquiry\.html', '0\.6'\]/);
assert.equal(fs.existsSync(path.join(root, 'pa-schedule-consent.html')), false);

for (const file of ['contact.html', 'general-inquiry.html', 'pa-inquiry.html']) {
    const html = read(file);
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
    assert.equal(new Set(ids).size, ids.length, `${file} contains duplicate IDs`);
}

for (const file of ['js/pa-inquiry.js', 'api/sitemap.js']) {
    new vm.Script(read(file), { filename: file });
}

const publicHtml = [
    'index.html',
    'contact.html',
    'general-inquiry.html',
    'pa-inquiry.html',
    'pa-rental.html',
    'stage-production.html',
    'tour-pa.html',
    'installation.html',
    'works.html',
    'privacy.html'
];
for (const file of publicHtml) {
    const html = read(file);
    assert.doesNotMatch(html, /href="pa-schedule-consent(?:\.html)?[^"]*"/);

    for (const match of html.matchAll(/\s(?:href|src)="([^"]+)"/g)) {
        const value = match[1].replaceAll('&amp;', '&');
        if (/^(?:https?:|mailto:|tel:|data:|#)/.test(value)) continue;
        const url = new URL(value, 'http://local.test/');
        if (url.pathname === '/' || url.pathname.startsWith('/works/')) continue;
        const target = decodeURIComponent(url.pathname.replace(/^\//, ''));
        assert.ok(fs.existsSync(path.join(root, target)), `${file} links to missing local asset: ${value}`);
    }
}

console.log('ARA-20260723-003 static validation passed');
