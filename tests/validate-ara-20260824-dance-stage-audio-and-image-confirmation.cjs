const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { pathToFileURL } = require('node:url');

const root = resolve(__dirname, '..');
const read = (relativePath) => readFileSync(resolve(root, relativePath), 'utf8');

(async () => {
    const taxonomy = await import(pathToFileURL(resolve(root, 'js/work-taxonomy.mjs')));
    const confirmation = await import(pathToFileURL(resolve(root, 'js/image-confirmation.mjs')));
    const adminHtml = read('admin.html');
    const adminJs = read('js/admin.js');
    const shared = require(resolve(root, 'api/_shared.cjs'));
    const migration = read('supabase/migrations/20260824130000_dance_stage_audio_and_image_confirmation.sql');

    assert.equal(taxonomy.serviceTypeLabels.dance_stage_audio_operation, 'ダンス・舞台音響オペレート');
    assert.equal(shared.serviceTypeLabels.dance_stage_audio_operation, 'ダンス・舞台音響オペレート');
    assert.match(adminHtml, /name="service-type" value="dance_stage_audio_operation">ダンス・舞台音響オペレート/u);
    assert.deepEqual(taxonomy.normalizeServiceTypes(['dance_stage_audio_operation', 'invalid']), ['dance_stage_audio_operation']);

    const existing = {
        flyer_path: 'flyers/current.jpg',
        public_image_source_url: 'https://example.com/current.jpg',
        public_image_sha256: 'a'.repeat(64),
        image_usage_status: 'confirmed',
        use_image_on_public_page: true
    };
    const unchanged = confirmation.resolveImageConfirmation({
        previousPost: existing,
        nextImage: { flyer_path: 'flyers/current.jpg', public_image_source_url: 'https://example.com/current.jpg', public_image_sha256: 'a'.repeat(64) },
        requestedStatus: 'confirmed',
        requestedPublicUse: true
    });
    assert.deepEqual(unchanged, { imageChanged: false, image_usage_status: 'confirmed', use_image_on_public_page: true });
    ['event_type', 'service_types', 'title'].forEach((unrelatedField) => {
        const unrelatedEdit = confirmation.resolveImageConfirmation({
            previousPost: { ...existing, [unrelatedField]: 'before' },
            nextImage: { flyer_path: 'flyers/current.jpg', public_image_source_url: 'https://example.com/current.jpg', public_image_sha256: 'a'.repeat(64) },
            requestedStatus: 'confirmed',
            requestedPublicUse: true
        });
        assert.equal(unrelatedEdit.image_usage_status, 'confirmed');
        assert.equal(unrelatedEdit.use_image_on_public_page, true);
    });
    const changed = confirmation.resolveImageConfirmation({
        previousPost: existing,
        nextImage: { flyer_path: 'flyers/replacement.jpg', public_image_source_url: null, public_image_sha256: 'b'.repeat(64) },
        requestedStatus: 'confirmed',
        requestedPublicUse: true
    });
    assert.deepEqual(changed, { imageChanged: true, image_usage_status: 'unknown', use_image_on_public_page: false });
    const changedSource = confirmation.resolveImageConfirmation({
        previousPost: existing,
        nextImage: { flyer_path: 'flyers/current.jpg', public_image_source_url: 'https://example.com/replacement.jpg', public_image_sha256: 'a'.repeat(64) },
        requestedStatus: 'confirmed',
        requestedPublicUse: true
    });
    assert.deepEqual(changedSource, { imageChanged: true, image_usage_status: 'unknown', use_image_on_public_page: false });
    const noImage = confirmation.resolveImageConfirmation({
        previousPost: { flyer_path: '', image_usage_status: null, use_image_on_public_page: false },
        nextImage: { flyer_path: '', public_image_source_url: null, public_image_sha256: null },
        requestedStatus: 'unknown',
        requestedPublicUse: false
    });
    assert.deepEqual(noImage, { imageChanged: false, image_usage_status: 'unknown', use_image_on_public_page: false });
    assert.equal(confirmation.hasPublicImage({ flyer_path: '', use_image_on_public_page: true }), false);
    assert.equal(confirmation.hasPublicImage({ flyer_path: 'flyers/current.jpg', use_image_on_public_page: false }), false);

    assert.match(adminJs, /usePublicImageInput\.checked = editingPost\.use_image_on_public_page !== false/u);
    assert.match(adminJs, /resolveImageConfirmation\(/u);
    assert.match(migration, /'dance_stage_audio_operation'/u);
    assert.match(migration, /reset_work_image_confirmation_on_change/u);
    assert.match(migration, /new\.image_usage_status := 'unknown'/u);
    assert.match(migration, /new\.use_image_on_public_page := false/u);
    console.log('ARA-20260824 dance-stage-audio and image-confirmation validation passed');
})();
