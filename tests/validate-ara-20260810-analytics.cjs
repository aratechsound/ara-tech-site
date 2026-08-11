const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
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
for (const name of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_id', 'utm_term', 'utm_content']) {
    assert.ok(occurrences(analytics, new RegExp(`'${name}'`, 'g')) >= 1);
}
assert.match(analytics, /preserveCampaignParameters: true/);
assert.doesNotMatch(analytics, /parsed\.hash/);
assert.match(analytics, /window\.gtag\('config', measurementId, config\)/);
assert.equal(occurrences(analytics, /window\.gtag\('config'/g), 1);
assert.match(analytics, /window\.va\('beforeSend'/);
assert.match(analytics, /\/_vercel\/insights\/script\.js/);
assert.match(analytics, /ara_tech_internal_analytics/);
assert.match(analytics, /ara:ga4-blocked/);

const executeAnalytics = (href, { internal = false } = {}) => {
    const appendedScripts = [];
    const dispatchedEvents = [];
    const storage = new Map(internal ? [['ara_tech_internal_analytics', 'true']] : []);
    const document = {
        currentScript: { dataset: {} },
        referrer: 'https://referrer.example/from?email=private%40example.com#private',
        createElement: () => ({}),
        head: { appendChild: (element) => appendedScripts.push(element) }
    };
    const window = {
        location: { href, origin: 'https://ara-tech.cc' },
        localStorage: {
            getItem: (key) => storage.get(key) ?? null,
            setItem: (key, value) => storage.set(key, value),
            removeItem: (key) => storage.delete(key)
        },
        dispatchEvent: (event) => dispatchedEvents.push(event)
    };
    const context = {
        URL,
        CustomEvent: function CustomEvent() {},
        document,
        window
    };

    vm.runInNewContext(analytics, context);

    const configCalls = (window.dataLayer || [])
        .map((entry) => Array.from(entry))
        .filter(([command]) => command === 'config');
    return { configCalls, appendedScripts, dispatchedEvents, storage, window };
};

const utmUrl = [
    'https://ara-tech.cc/pa-rental.html?',
    'utm_source=google',
    'utm_medium=cpc',
    'utm_campaign=summer_sale',
    'utm_id=1234567890',
    'utm_term=live+sound',
    'utm_content=hero_banner',
    'email=private%40example.com',
    'phone=09012345678',
    'form_message=secret'
].join('&').replace('?&', '?') + '#private';
const validCampaign = executeAnalytics(utmUrl);
assert.equal(validCampaign.configCalls.length, 1, 'GA4 config must be sent exactly once');
validCampaign.config = validCampaign.configCalls[0][2];
const sentLocation = new URL(validCampaign.config.page_location);
assert.equal(sentLocation.origin + sentLocation.pathname, 'https://ara-tech.cc/pa-rental.html');
assert.deepEqual(
    Object.fromEntries(sentLocation.searchParams),
    {
        utm_source: 'google',
        utm_medium: 'cpc',
        utm_campaign: 'summer_sale',
        utm_id: '1234567890',
        utm_term: 'live sound',
        utm_content: 'hero_banner'
    }
);
assert.equal(sentLocation.hash, '');
assert.equal(sentLocation.searchParams.has('email'), false);
assert.equal(sentLocation.searchParams.has('phone'), false);
assert.equal(sentLocation.searchParams.has('form_message'), false);
assert.equal(validCampaign.config.page_referrer, 'https://referrer.example/from');

const unsafeCampaign = executeAnalytics(
    'https://ara-tech.cc/?utm_source=mail%40example.com&utm_medium=email&utm_campaign=https%3A%2F%2Fexample.com&utm_term=09012345678&utm_content=valid'
);
assert.equal(unsafeCampaign.configCalls.length, 1, 'GA4 config must be sent exactly once');
unsafeCampaign.config = unsafeCampaign.configCalls[0][2];
const unsafeLocation = new URL(unsafeCampaign.config.page_location);
assert.deepEqual(Object.fromEntries(unsafeLocation.searchParams), {
    utm_medium: 'email',
    utm_content: 'valid'
});

const beforeSendRegistration = validCampaign.window.vaq
    .map((entry) => Array.from(entry))
    .find(([command]) => command === 'beforeSend');
assert.ok(beforeSendRegistration, 'Vercel beforeSend sanitizer must be registered');
const sanitizedVercelEvent = beforeSendRegistration[1]({
    url: utmUrl,
    referrer: 'https://external.example/page?token=secret#private'
});
assert.equal(sanitizedVercelEvent.url, 'https://ara-tech.cc/pa-rental.html');
assert.equal(sanitizedVercelEvent.referrer, 'https://external.example/page');

const internalBrowser = executeAnalytics(utmUrl, { internal: true });
assert.equal(internalBrowser.window.__araGa4Internal, true);
assert.equal(internalBrowser.configCalls.length, 0, 'internal browsers must not send GA4 config');
assert.equal(internalBrowser.window.gtag, undefined, 'internal browsers must not initialize gtag');
assert.equal(internalBrowser.window.dataLayer, undefined, 'internal browsers must not initialize dataLayer');
assert.equal(
    internalBrowser.appendedScripts.some(({ src }) => src?.includes('googletagmanager.com')),
    false,
    'internal browsers must not load the Google tag'
);
assert.equal(
    internalBrowser.appendedScripts.filter(({ src }) => src === '/_vercel/insights/script.js').length,
    1,
    'Vercel Web Analytics remains independent of the GA4 exclusion'
);
assert.equal(internalBrowser.dispatchedEvents.length, 1);

const returnedToNormal = executeAnalytics(utmUrl);
assert.equal(returnedToNormal.window.__araGa4Internal, false);
assert.equal(returnedToNormal.configCalls.length, 1, 'removing the internal flag must restore GA4');

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

const admin = read('admin.html');
const adminScript = read('js/admin.js');
assert.match(admin, /id="analytics-exclusion-toggle"/);
assert.match(admin, /ブラウザプロファイル単位/);
assert.match(adminScript, /INTERNAL_ANALYTICS_STORAGE_KEY = 'ara_tech_internal_analytics'/);
assert.match(adminScript, /現在：GA4内部アクセス除外 ON/);
assert.match(adminScript, /localStorage\.setItem\(INTERNAL_ANALYTICS_STORAGE_KEY, 'true'\)/);
assert.match(adminScript, /localStorage\.removeItem\(INTERNAL_ANALYTICS_STORAGE_KEY\)/);

const privacy = read('privacy.html');
assert.match(privacy, /Google AnalyticsおよびVercel Web Analytics/);
assert.match(privacy, /クエリパラメータとハッシュを除外/);
assert.match(privacy, /受付番号等をアクセス解析へ送信しません/);

console.log('ARA-20260810 shared GA4 and Vercel Web Analytics validation passed');
