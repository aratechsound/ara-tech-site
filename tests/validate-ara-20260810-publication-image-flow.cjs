const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const adminHtml = read('admin.html');
const adminJs = read('js/admin.js');
const migration = read('supabase/migrations/20260810020000_work_candidate_image_publication_audit.sql');
const pendingMigration = read('supabase/migrations/20260810010000_works_publication_pending_preview.sql');
const restoreMigration = read('supabase/migrations/20260810030000_restore_pending_flyer_candidates.sql');
const imageApi = require('../api/work-review-image.js');

assert.match(adminHtml, /id="review-image-preview"/u);
assert.match(adminHtml, /id="post-omit-public-image"/u);
assert.match(adminHtml, /画像を掲載しない/u);
assert.match(adminHtml, /公開待ちのフライヤーは通常「公開する」だけで掲載されます/u);
assert.doesNotMatch(adminHtml, /このフライヤーを公開ページに掲載する/u);
assert.match(adminJs, /fetch\('\/api\/work-review-image'/u);
assert.match(adminJs, /candidate_hash: post\.candidate_hash/u);
assert.match(adminJs, /pendingDisplayedImages/u);
assert.match(adminJs, /URL\.createObjectURL\(displayed\.file\)/u);
assert.match(adminJs, /一覧で確認したフライヤーをARA-TECH側Storageへ保存しています/u);
assert.match(adminJs, /await uploadFlyer\(displayed\.file\)/u);
assert.match(adminJs, /\.eq\('candidate_hash', post\.candidate_hash\)/u);
assert.match(adminJs, /p_candidate_hash: publishablePost\.candidate_hash/u);
assert.match(adminJs, /public_image_source_url: displayed\.origin === 'review'/u);
assert.match(adminJs, /public_image_sha256: publicImageSha256/u);
assert.match(adminJs, /pendingImageOmitted \? 'not_permitted'/u);
assert.match(adminJs, /image_usage_status: 'confirmed'/u);
assert.match(adminJs, /if \(uploadedFlyerPath\) await supabase\.storage\.from\(WORKS_BUCKET\)\.remove/u);
assert.match(adminJs, /一覧のフライヤーとStorage画像が一致しません/u);
assert.match(adminJs, /公演情報・掲載文章・SEO/u);
assert.match(adminJs, /候補SHA-256/u);

assert.match(migration, /create table if not exists public\.work_candidate_image_audit/u);
assert.match(migration, /'public_image_selected'/u);
assert.match(migration, /'public_image_reconfirmed'/u);
assert.match(migration, /'public_image_deselected'/u);
assert.match(migration, /image_publication_confirmed_at/u);
assert.match(migration, /image_publication_confirmed_by/u);
assert.match(migration, /auth\.uid\(\) is null/u);
assert.match(migration, /not public\.is_work_admin\(\)/u);
assert.match(migration, /'public_image_source_url', p_work\.public_image_source_url/u);
assert.match(migration, /'public_image_sha256', p_work\.public_image_sha256/u);
assert.match(pendingMigration, /new\.approved_hash := null/u);
assert.match(migration, /v_work\.image_publication_confirmed_at is null/u);
assert.match(migration, /v_work\.image_publication_confirmed_by is null/u);
assert.match(migration, /enable row level security/u);
assert.match(migration, /grant select on public\.work_candidate_image_audit to authenticated/u);
assert.match(restoreMigration, /v_target_count <> 3 or v_public_count <> 3/u);
assert.equal((restoreMigration.match(/publication_pending_approval/gu) || []).length, 1);
assert.equal((restoreMigration.match(/2026-08-14-bark-lagoon-hiroshima/gu) || []).length, 3);
assert.equal((restoreMigration.match(/2026-08-28-cream-lagoon-hiroshima/gu) || []).length, 3);
assert.equal((restoreMigration.match(/2026-09-11-ife-city-of-heaven-tour-lagoon-hiroshima/gu) || []).length, 3);
assert.match(restoreMigration, /use_image_on_public_page = false/u);
assert.doesNotMatch(restoreMigration, /verry/iu);

assert.equal(imageApi.bearerToken({ headers: { authorization: 'Bearer admin-token' } }), 'admin-token');
assert.throws(() => imageApi.bearerToken({ headers: {} }), /not_authorized/u);
assert.deepEqual(
    imageApi.parseBody({ body: { id: 7, candidate_hash: 'a'.repeat(64) } }),
    { id: 7, candidateHash: 'a'.repeat(64) }
);
assert.throws(() => imageApi.parseBody({ body: { id: 7, candidate_hash: 'stale' } }), /invalid_input/u);
assert.equal(imageApi.domainsAreRelated('lagoon-hiroshima.com', 'www.lagoon-hiroshima.com'), true);
assert.equal(imageApi.domainsAreRelated('cdn.lagoon-hiroshima.com', 'lagoon-hiroshima.com'), true);
assert.equal(imageApi.domainsAreRelated('evil.example', 'lagoon-hiroshima.com'), false);
assert.equal(imageApi.isPrivateAddress('127.0.0.1'), true);
assert.equal(imageApi.isPrivateAddress('10.0.0.1'), true);
assert.equal(imageApi.isPrivateAddress('93.184.216.34'), false);
assert.equal(imageApi.matchesImageSignature(Buffer.from([0xff, 0xd8, 0xff, 0x00]), 'image/jpeg'), true);
assert.equal(imageApi.matchesImageSignature(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), 'image/png'), true);
assert.equal(imageApi.matchesImageSignature(Buffer.from('not-an-image'), 'image/jpeg'), false);

const publicResolver = async () => [{ address: '93.184.216.34', family: 4 }];

(async () => {
    const validated = await imageApi.validateImageUrl(
        'https://lagoon-hiroshima.com/flyer.jpg',
        'https://www.lagoon-hiroshima.com/events/bark',
        publicResolver
    );
    assert.equal(validated.href, 'https://lagoon-hiroshima.com/flyer.jpg');
    await assert.rejects(
        imageApi.validateImageUrl(
            'https://evil.example/flyer.jpg',
            'https://lagoon-hiroshima.com/events/bark',
            publicResolver
        ),
        /image_source_invalid/u
    );
    await assert.rejects(
        imageApi.validateImageUrl(
            'https://127.0.0.1/flyer.jpg',
            'https://127.0.0.1/events/bark',
            async () => [{ address: '127.0.0.1', family: 4 }]
        ),
        /image_source_invalid/u
    );

    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
    const downloaded = await imageApi.downloadImage({
        imageUrl: 'https://lagoon-hiroshima.com/flyer.png',
        officialUrl: 'https://lagoon-hiroshima.com/events/bark',
        resolver: publicResolver,
        fetchImpl: async () => new Response(png, {
            status: 200,
            headers: { 'content-type': 'image/png', 'content-length': String(png.length) }
        })
    });
    assert.equal(downloaded.contentType, 'image/png');
    assert.deepEqual(downloaded.buffer, png);
    assert.match(downloaded.sha256, /^[0-9a-f]{64}$/u);

    const stored = await imageApi.downloadStoredImage({
        storagePath: 'flyers/pending.png',
        expectedSha256: downloaded.sha256,
        fetchImpl: async (url) => {
            assert.match(String(url), /\/storage\/v1\/object\/public\/work-flyers\/flyers\/pending\.png$/u);
            return new Response(png, {
                status: 200,
                headers: { 'content-type': 'image/png', 'content-length': String(png.length) }
            });
        }
    });
    assert.equal(stored.sha256, downloaded.sha256);
    await assert.rejects(
        imageApi.downloadStoredImage({
            storagePath: 'flyers/pending.png',
            expectedSha256: '0'.repeat(64),
            fetchImpl: async () => new Response(png, { status: 200, headers: { 'content-type': 'image/png' } })
        }),
        /image_hash_mismatch/u
    );
    assert.throws(() => imageApi.storageObjectUrl('flyers/../secret.png'), /image_source_invalid/u);

    await assert.rejects(
        imageApi.downloadImage({
            imageUrl: 'https://lagoon-hiroshima.com/flyer.svg',
            officialUrl: 'https://lagoon-hiroshima.com/events/bark',
            resolver: publicResolver,
            fetchImpl: async () => new Response('<svg/>', {
                status: 200,
                headers: { 'content-type': 'image/svg+xml' }
            })
        }),
        /image_type_invalid/u
    );

    console.log('ARA-20260810 one-click pending flyer publication, exact displayed bytes, Storage import, audit, and fail-closed validation passed');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
