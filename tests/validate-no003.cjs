const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const workHandler = require('../api/work.js');
const { getFlyerDimensions } = require('../api/_shared.cjs');
const { rows } = require('./fixtures.cjs');

const repoRoot = path.resolve(__dirname, '..');
const post = rows.find((row) => row.flyer_path) || rows[0];
const html = workHandler.renderWorkPage(post, { relatedWorks: rows.filter((row) => row.slug !== post.slug).slice(0, 3) });
const css = fs.readFileSync(path.join(repoRoot, 'work-detail.css'), 'utf8');

const primaryImage = html.match(/<figure class="detail-flyer">([\s\S]*?)<\/figure>/)?.[1] || '';
assert.match(primaryImage, /\/storage\/v1\/render\/image\/public\/work-flyers\//);
assert.match(primaryImage, /\?width=800&amp;quality=78&amp;resize=contain/);
assert.match(primaryImage, /\?width=480&amp;quality=78&amp;resize=contain 480w/);
assert.match(primaryImage, /\?width=1200&amp;quality=78&amp;resize=contain 1200w/);
assert.match(primaryImage, /sizes="\(max-width: 991px\) calc\(100vw - 72px\), 52vw"/);
assert.match(primaryImage, /fetchpriority="high" loading="eager" decoding="async"/);
const primaryDimensions = getFlyerDimensions(post.flyer_path);
assert.ok(primaryDimensions);
assert.ok(primaryImage.includes(`width="${primaryDimensions.width}" height="${primaryDimensions.height}"`));

const preload = html.match(/<link rel="preload" as="image"[^>]+>/)?.[0] || '';
assert.ok(preload);
assert.match(preload, /imagesrcset=/);
assert.match(preload, /imagesizes=/);
assert.match(preload, /fetchpriority="high"/);

const originalUrl = `/storage/v1/object/public/work-flyers/${post.flyer_path}`;
assert.ok(html.includes(`<meta property="og:image" content="https://kogbnremsouajxxsgxro.supabase.co${originalUrl}">`));
assert.ok(html.includes(`<meta name="twitter:image" content="https://kogbnremsouajxxsgxro.supabase.co${originalUrl}">`));
const jsonLd = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
const imageObject = jsonLd['@graph'].find((item) => item['@type'] === 'ImageObject');
assert.ok(imageObject.contentUrl.includes(originalUrl));
assert.ok(!imageObject.contentUrl.includes('/render/image/'));

assert.ok(!html.includes('fonts.googleapis.com'));
assert.ok(!html.includes('fonts.gstatic.com'));
assert.ok(!html.includes('bootstrap.min.css'));
assert.ok(!html.includes('bootstrap.bundle.min.js'));
assert.ok(!html.includes('data-bs-toggle'));
assert.match(html, /window\.addEventListener\('load'/);
assert.ok(!html.includes('<script async src="https://www.googletagmanager.com/'));
assert.match(html, /requestIdleCallback\(loadAnalytics/);

const relatedSection = html.match(/<section class="content-section related-works"[\s\S]*?<\/section>/)?.[0] || '';
assert.match(relatedSection, /\?width=240&amp;quality=72&amp;resize=contain/);
assert.match(relatedSection, /\?width=480&amp;quality=72&amp;resize=contain 480w/);
assert.match(relatedSection, /loading="lazy" decoding="async"/);

assert.match(css, /font-family: -apple-system, BlinkMacSystemFont/);
assert.match(css, /\.navbar-collapse\.is-open/);
assert.match(css, /\.navbar-toggler-icon::before/);
assert.match(css, /\.site-footer/);
assert.ok(!css.includes("font-family: 'Noto Sans JP'"));
assert.match(css, /\.navbar \{ background: var\(--interactive\)/);
assert.match(css, /\.nav-link\[aria-current='page'\] \{ text-decoration: none/);
assert.ok(!html.includes('aria-label="関連する実績：'));
assert.ok(!html.includes('aria-label="過去の実績：'));
assert.ok(!html.includes('aria-label="新しい実績：'));

console.log('validate-no003: responsive LCP image, original social image, local navigation CSS, and delayed analytics checks passed');
