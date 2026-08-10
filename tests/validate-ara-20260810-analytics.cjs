const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const workHandler = require('../api/work.js');
const { rows } = require('./fixtures.cjs');

const repoRoot = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
const occurrences = (text, pattern) => text.match(pattern)?.length || 0;

const publicHtmlFiles = [
    'index.html',
    'pa-rental.html',
    'stage-production.html',
    'tour-pa.html',
    'installation.html',
    'works.html',
    'contact.html',
    'general-inquiry.html',
    'pa-inquiry.html',
    'privacy.html',
    'download.html',
    'thanks.html'
];

for (const file of publicHtmlFiles) {
    const html = read(file);
    assert.equal(occurrences(html, /src="\/js\/analytics\.js"/g), 1, `${file} must load the shared analytics script once`);
    assert.doesNotMatch(html, /googletagmanager\.com\/gtag\/js/);
    assert.doesNotMatch(html, /gtag\(['"]config['"]/);
}

for (const file of ['admin.html', 'pa-admin.html', 'pa-schedule-confirm.html']) {
    const html = read(file);
    assert.doesNotMatch(html, /analytics\.js|googletagmanager|_vercel\/insights/);
}

const analytics = read('js/analytics.js');
assert.equal(occurrences(analytics, /G-K8VZM111TY/g), 1);
assert.match(analytics, /page_location: pageLocation/);
assert.match(analytics, /pageReferrer = sanitizeUrl\(document\.referrer\)/);
assert.match(analytics, /return `\$\{parsed\.origin\}\$\{parsed\.pathname\}`/);
assert.doesNotMatch(analytics, /parsed\.search|parsed\.hash/);
assert.match(analytics, /window\.gtag\('config', measurementId, config\)/);
assert.equal(occurrences(analytics, /window\.gtag\('config'/g), 1);
assert.match(analytics, /window\.va\('beforeSend'/);
assert.match(analytics, /\/_vercel\/insights\/script\.js/);

const publicWorkHtml = workHandler.renderWorkPage(rows[0]);
assert.equal(occurrences(publicWorkHtml, /src="\/js\/analytics\.js"/g), 1);
assert.match(publicWorkHtml, /data-analytics-load="idle"/);
assert.doesNotMatch(publicWorkHtml, /G-K8VZM111TY|googletagmanager/);

const previewWorkHtml = workHandler.renderWorkPage(rows[0], { preview: true });
assert.doesNotMatch(previewWorkHtml, /analytics\.js|googletagmanager|_vercel\/insights/);

const thanks = read('thanks.html');
assert.match(thanks, /history\.replaceState[\s\S]*generate_lead/);
assert.match(thanks, /ara:analytics-ready/);
assert.match(thanks, /parameters\.get\('form'\) === 'pa-inquiry' \? 'pa-inquiry' : 'contact'/);

const privacy = read('privacy.html');
assert.match(privacy, /Google AnalyticsおよびVercel Web Analytics/);
assert.match(privacy, /クエリパラメータとハッシュを除外/);
assert.match(privacy, /受付番号等をアクセス解析へ送信しません/);

console.log('ARA-20260810 shared GA4 and Vercel Web Analytics validation passed');
