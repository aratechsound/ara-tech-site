const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const adminHtml = read('admin.html');
const adminJs = read('js/admin.js');
const migration = read('supabase/migrations/20260810010000_works_publication_pending_preview.sql');
const vercel = JSON.parse(read('vercel.json'));
const previewApi = require('../api/work-preview.js');
const workHandler = require('../api/work.js');

[
    'pending-posts',
    'pending-count',
    'candidate-context',
    'post-open-time',
    'post-start-time',
    'post-review-image-url',
    'post-review-image-method',
    'post-image-usage-status',
    'post-use-public-image',
    'post-seo-title',
    'post-meta-description',
    'preview-candidate',
    'publish-candidate',
    'reject-candidate',
    'preview-dialog',
    'preview-frame'
].forEach((id) => assert.ok(adminHtml.includes(`id="${id}"`), `${id} is missing`));

assert.match(adminHtml, /公開待ち/);
assert.match(adminHtml, /画像を掲載しない/);
assert.doesNotMatch(adminHtml, /このフライヤーを公開ページに掲載する/);
assert.match(adminHtml, /sandbox="allow-same-origin"/);
assert.match(adminJs, /publication_pending_approval/);
assert.match(adminJs, /publish_work_candidate/);
assert.match(adminJs, /reject_work_candidate/);
assert.match(adminJs, /p_candidate_hash: publishablePost\.candidate_hash/);
assert.match(adminJs, /公演情報・掲載文章・SEO・\$\{hasPublishedImage/);
assert.match(adminJs, /imageUsageStatusInput\.value !== 'confirmed'/);
assert.match(adminJs, /use_image_on_public_page: pendingCandidate \? pendingUsesStoredImage : usePublicImageInput\.checked/);
assert.match(adminJs, /const flyerPath = uploadedFlyerPath \|\| editingPost\?\.flyer_path \|\| '';/);
assert.match(adminJs, /if \(!post\.is_published\) actions\.append\(remove\)/);

assert.match(migration, /work_candidate_content_hash/);
assert.match(migration, /extensions\.digest/);
assert.match(migration, /old\.candidate_hash is distinct from v_hash/);
assert.match(migration, /new\.approved_hash := null/);
assert.match(migration, /p_candidate_hash <> v_work\.candidate_hash/);
assert.match(migration, /v_work\.image_usage_status <> 'confirmed'/);
assert.match(migration, /publication_review_status = null/);
assert.match(migration, /announcement_confirmed_on = current_date/);
assert.match(migration, /'2026-08-14-bark-lagoon-hiroshima'/);
assert.match(migration, /'2026-08-28-cream-lagoon-hiroshima'/);
assert.match(migration, /'2026-09-11-ife-city-of-heaven-tour-lagoon-hiroshima'/);
assert.doesNotMatch(migration, /verrysmol_20260904|2026-09-04-verry/i);
assert.equal((migration.match(/'publication_pending_approval'/g) || []).length >= 4, true);
assert.equal((migration.match(/'unknown', false,/g) || []).length, 3);

const previewHeaders = vercel.headers.find((entry) => entry.source === '/admin.html');
assert.ok(previewHeaders, 'admin.html private headers are required');
const headerMap = Object.fromEntries(previewHeaders.headers.map((header) => [header.key.toLowerCase(), header.value]));
assert.match(headerMap['cache-control'], /private, no-store/);
assert.match(headerMap['x-robots-tag'], /noindex, nofollow, noarchive/);
assert.match(headerMap['content-security-policy'], /frame-ancestors 'none'/);

assert.equal(previewApi.parseBody({ body: { id: 42 } }), 42);
assert.throws(() => previewApi.parseBody({ body: { id: 0 } }), /invalid_input/);
assert.equal(previewApi.bearerToken({ headers: { authorization: 'Bearer admin-token' } }), 'admin-token');
assert.throws(() => previewApi.bearerToken({ headers: {} }), /not_authorized/);

const previewPost = {
    id: 42,
    title: 'PREVIEW LIVE',
    slug: '2026-preview-live',
    event_date: '2026-12-20',
    open_time: '18:00:00',
    start_time: '19:00:00',
    category: 'ライブ・アーティストPA',
    lifecycle_status: 'upcoming',
    performer_name: 'PREVIEW ARTIST',
    area: '広島県広島市',
    venue_address: '広島県広島市中区1-2-3',
    organizer_name: 'EXAMPLE VENUE',
    official_announcement_url: 'https://example.com/event',
    assignment_items: ['pa_operation'],
    role_type: 'artist_pa_operation',
    role_types: ['artist_pa_operation'],
    operation_artists: 'PREVIEW ARTIST',
    artists: 'PREVIEW ARTIST',
    venue: 'EXAMPLE VENUE',
    description: '公開前プレビューの説明です。',
    flyer_path: null,
    flyer_alt: 'PREVIEW LIVEの確認用フライヤー',
    review_image_url: 'https://example.com/review.jpg',
    image_usage_status: 'unknown',
    use_image_on_public_page: false,
    seo_title: 'PREVIEW SEO TITLE',
    meta_description: 'PREVIEW META DESCRIPTION',
    is_published: false,
    publish_at: null
};

const previewHtml = workHandler.renderWorkPage(previewPost, { preview: true });
assert.match(previewHtml, /<title>PREVIEW SEO TITLE<\/title>/);
assert.match(previewHtml, /PREVIEW META DESCRIPTION/);
assert.match(previewHtml, /noindex, nofollow, noarchive, nosnippet/);
assert.match(previewHtml, /公開待ちプレビュー/);
assert.match(previewHtml, /https:\/\/example\.com\/review\.jpg/);
assert.match(previewHtml, /管理画面の確認用画像です。公開画像としては未選択です。/);
assert.match(previewHtml, /<dt>OPEN<\/dt><dd><time datetime="18:00">18:00<\/time>/);
assert.match(previewHtml, /<dt>START<\/dt><dd><time datetime="19:00">19:00<\/time>/);
assert.match(previewHtml, /"startDate":"2026-12-20T19:00:00\+09:00"/);
assert.doesNotMatch(previewHtml, /googletagmanager/);

const publicHtml = workHandler.renderWorkPage(previewPost);
assert.doesNotMatch(publicHtml, /https:\/\/example\.com\/review\.jpg/);
assert.match(publicHtml, /画像は掲載されていません/);
assert.match(publicHtml, /<meta name="robots" content="index, follow">/);

console.log('ARA-20260810 publication pending admin preview, edit, image consent, hash invalidation, and publish guard validation passed');
