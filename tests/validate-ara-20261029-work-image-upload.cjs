const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

(async () => {
    const { validateFlyerFile, imageSourceUrl } = await import('../js/work-image-upload.mjs');
    const jpeg = new File([new Uint8Array([255, 216, 255, 0])], 'misleading.png', { type: 'image/jpeg' });
    let closed = false;
    assert.equal(await validateFlyerFile(jpeg, async () => ({ width: 100, height: 200, close() { closed = true; } })), 'jpg');
    assert.equal(closed, true);
    await assert.rejects(validateFlyerFile(new File(['html'], 'fake.jpg', { type: 'image/jpeg' }), async () => { throw new Error('must not decode'); }), /形式と内容/u);
    await assert.rejects(validateFlyerFile(new File(['<svg/>'], 'fake.svg', { type: 'image/svg+xml' })), /10MB/u);
    await assert.rejects(validateFlyerFile({ type: 'image/jpeg', size: 10 * 1024 * 1024 + 1 }), /10MB/u);
    await assert.rejects(validateFlyerFile(jpeg, async () => { throw new Error('corrupt'); }), /読み込めません/u);
    assert.equal(imageSourceUrl('https://www.instagram.com/lagoon_hiroshima/p/DerG7OEpZUL/'), 'https://www.instagram.com/lagoon_hiroshima/p/DerG7OEpZUL/');
    assert.equal(imageSourceUrl(''), null);
    assert.throws(() => imageSourceUrl('http://example.org/image.jpg'));
    assert.throws(() => imageSourceUrl('https://user:password@example.org/image.jpg'));
    const admin = fs.readFileSync(path.join(__dirname, '../js/admin.js'), 'utf8');
    assert.doesNotMatch(admin, /img\/cta-bg\.jpg/u);
    const imageSaveFlows = admin.slice(admin.indexOf('const prepareCandidateImageForPublication'));
    assert.doesNotMatch(imageSaveFlows, /remove\(\[post\.flyer_path\]\)|remove\(\[editingPost\.flyer_path\]\)/u);
    assert.match(admin, /upsert: false/u);
    assert.match(admin, /imageSourceUrlInput\.value\.trim\(\)/u);
    assert.match(admin, /review_image_url: file \? null : reviewImageUrl \|\| null/u);
    const vm = require('node:vm');
    const post = { id: 89, candidate_hash: 'a'.repeat(64), flyer_path: 'flyers/official.jpg', public_image_sha256: 'b'.repeat(64), image_usage_status: 'unknown', image_owner_instruction_ref: 'WKS-011 selection', public_image_source_url: 'https://example.org/event', use_image_on_public_page: false };
    const displayedImages = new Map([[89, { candidateHash: post.candidate_hash, origin: 'storage', sha256: post.public_image_sha256 }]]);
    const updates = [], conditions = [];
    const chain = { eq(key, value) { conditions.push([key, value]); return this; }, select() { return this; }, async maybeSingle() { return { data: { ...post, image_usage_status: 'unknown', use_image_on_public_page: true, candidate_hash: 'c'.repeat(64) }, error: null }; } };
    const context = vm.createContext({ pendingDisplayedImages: displayedImages, PENDING_STATUS: 'publication_pending_approval', supabase: { from(table) { assert.equal(table, 'work_posts'); return { update(value) { updates.push(value); return chain; } }; } }, uploadFlyer() { throw new Error('stored bytes must not be uploaded again'); } });
    vm.runInContext(admin.slice(admin.indexOf('const prepareCandidateImageForPublication'), admin.indexOf('const checkPublicationCandidate')) + '; globalThis.prepare = prepareCandidateImageForPublication;', context);
    const ready = await context.prepare(post, true, displayedImages.get(89));
    assert.equal(ready.candidate_hash, 'c'.repeat(64));
    assert.equal(ready.use_image_on_public_page, true);
    assert.deepEqual(JSON.parse(JSON.stringify(updates)), [{ image_usage_status: 'unknown', use_image_on_public_page: true }]);
    assert.deepEqual(conditions, [['id',89],['candidate_hash',post.candidate_hash],['publication_review_status','publication_pending_approval'],['is_published',false]]);
    displayedImages.get(89).sha256 = 'd'.repeat(64);
    await assert.rejects(context.prepare(post, true, displayedImages.get(89)), /採用画像のSHA-256/u);
    await assert.rejects(context.prepare(post, false, null), /画像なしへの変更/u);
    assert.equal(updates.length, 1);
    displayedImages.get(89).candidateHash = 'e'.repeat(64);
    await assert.rejects(context.prepare(post, true, displayedImages.get(89)), /状態が古く/u);
    assert.equal(updates.length, 1);
    const source = 'https://example.org/event';
    const { publishStoredFlyer } = await import('../js/work-existing-flyer.mjs');
    // The production module verifies real bytes and calls the existing administrator helper.
    // Only the browser decoder and Supabase transport are mocked in this Node fixture.
    const storedImage = new File([Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAABP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AJGAYI//2Q==', 'base64')], 'stored.jpg', { type: 'image/jpeg' });
    const actualSha = async (file) => require('node:crypto').createHash('sha256').update(Buffer.from(await file.arrayBuffer())).digest('hex');
    const sha256 = await actualSha(storedImage);
    const originalBitmap = globalThis.createImageBitmap;
    globalThis.createImageBitmap = async (file) => {
        assert.equal(file.type, 'image/jpeg');
        return { width: 1, height: 1, close() {} };
    };
    const imageOnlyChanges = [];
    const imagesRead = [];
    let uploaded = 0;
    let actor = 'admin', member = true, storageBytes = storedImage, failWrite = false;
    const imageAudits = [];
    let state = { id: 100, slug: 'hiroshima', event_date: '2026-11-15', lifecycle_status: 'upcoming', is_published: true,
        publication_review_status: null, use_image_on_public_page: false, flyer_path: '', updated_at: 'before', image_owner_instruction_ref: null, approved_hash: 'original' };
    const imageContext = vm.createContext({
        WORKS_BUCKET: 'work-flyers',
        publishStoredFlyer,
        fileSha256: async (file) => file.sha256 || actualSha(file),
        readWorksAdministrator: async () => ({ status: 'ready', user: { id: 'admin' } }),
        validateFlyerFile: async () => {},
        uploadFlyer: async () => { uploaded++; return 'flyers/new.webp'; },
        supabase: {
            auth: { async getUser() { return { data: { user: actor ? { id: actor } : null } }; } },
            from(table) {
                if (table === 'work_admins') return { select(fields) {
                    assert.equal(fields, 'user_id');
                    return { eq(key, value) {
                        assert.equal(key, 'user_id');
                        assert.equal(value, actor);
                        return { async maybeSingle() { return { data: member ? { user_id: actor } : null }; } };
                    } };
                } };
                assert.equal(table, 'work_posts');
                return { update(value) {
                    const filters = {};
                    return {
                        eq(key, expected) { filters[key] = expected; return this; },
                        is(key, expected) { filters[key] = expected; return this; },
                        select() { return this; },
                        async maybeSingle() {
                            if (Object.entries(filters).some(([key, expected]) => state[key] !== expected)) return { data: null };
                            const originalFilters = ['id', 'is_published', 'publication_review_status', 'updated_at', 'use_image_on_public_page'];
                            const storedRepair = 'image_owner_instruction_ref' in value && !('flyer_path' in value);
                            assert.deepEqual(Object.keys(filters).sort(), storedRepair
                                ? [...originalFilters, 'flyer_path', 'public_image_sha256', 'public_image_source_url', 'image_owner_instruction_ref', 'image_usage_status'].sort()
                                : originalFilters);
                            if (storedRepair) assert.deepEqual(Object.keys(value).sort(), ['image_owner_instruction_ref', 'image_usage_status', 'use_image_on_public_page']);
                            if (failWrite || !actor || !member) return { data: null, error: { message: 'permission denied' } };
                            imageOnlyChanges.push(JSON.parse(JSON.stringify(value)));
                            state = { ...state, ...value, updated_at: String(imageOnlyChanges.length) };
                            if ('flyer_path' in value) state.image_usage_status = 'unknown';
                            if (value.use_image_on_public_page) {
                                state.image_publication_confirmed_by = actor;
                                state.image_publication_confirmed_at = '2026-11-28T00:00:00Z';
                                imageAudits.push({ work_id: state.id, actor_user_id: actor });
                            }
                            return { data: { ...state } };
                        }
                    };
                } };
            },
            storage: { from(bucket) {
                assert.equal(bucket, 'work-flyers');
                return { async download(key) {
                    imagesRead.push(key);
                    return { data: storageBytes };
                } };
            } }
        }
    });
    vm.runInContext(
        admin.slice(admin.indexOf('const canAddPublishedFlyer'), admin.indexOf('const isCreatingPendingCandidate'))
        + admin.slice(admin.indexOf('const updatePublishedFlyer'), admin.indexOf('const fetchReviewImageFile'))
        + '; globalThis.add = addPublishedFlyer;', imageContext
    );
    const alt = '広島公演の公式フライヤー';
    const evidence = { sourceUrl: source, alt, instructionRef: 'WKS-011 selection', expectedSha: sha256, rights: 'unknown' };
    for (const otherSha of ['1', '2', '3']) {
        await assert.rejects(imageContext.add(state, { sha256: otherSha.repeat(64) }, evidence), /SHA-256/u);
    }
    await assert.rejects(imageContext.add(state, storedImage, { ...evidence, rights: 'not_permitted' }), /明示的/u);
    assert.equal(uploaded, 0);
    const attached = await imageContext.add(state, storedImage, evidence);
    assert.equal(uploaded, 1);
    assert.deepEqual(imagesRead, ['flyers/new.webp']);
    assert.deepEqual(imageOnlyChanges, [
        { flyer_path: 'flyers/new.webp', flyer_alt: alt, public_image_source_url: source, public_image_sha256: sha256, image_owner_instruction_ref: 'WKS-011 selection' },
        { image_usage_status: 'unknown', use_image_on_public_page: true }
    ]);
    assert.equal(attached.is_published, true);
    assert.equal(attached.event_date, '2026-11-15');
    assert.equal(attached.approved_hash, 'original');
    await assert.rejects(imageContext.add(state, storedImage, evidence), /掲載画像のない/u);
    state = { ...state, use_image_on_public_page: false };
    const beforeStored = structuredClone(state);
    const writesBefore = imageOnlyChanges.length;
    const auditBefore = imageAudits.length;
    await assert.rejects(imageContext.add(state, storedImage, { ...evidence, sourceUrl: 'https://example.org/different' }), /一致しません/u);
    await assert.rejects(imageContext.add({ ...state, updated_at: 'stale' }, storedImage, evidence), /更新結果を確認できません/u);
    assert.equal(imageOnlyChanges.length, writesBefore);
    assert.equal(imageAudits.length, auditBefore);
    // Existing matching adoption record: no upload and no repeat publication of the article.
    const reused = await imageContext.add(state, storedImage, evidence);
    assert.equal(reused.approved_hash, beforeStored.approved_hash);
    assert.equal(uploaded, 1, 'retry must reuse the already stored image');
    // WKS-017: previously uploaded image with no adoption record; select without a local file.
    state = { ...state, use_image_on_public_page: false, image_owner_instruction_ref: null };
    const pin = structuredClone(state);
    const writesBeforeRepair = imageOnlyChanges.length;
    const auditsBeforeRepair = imageAudits.length;
    actor = null;
    await assert.rejects(imageContext.add(pin, undefined, evidence), /管理者権限/u);
    actor = 'admin'; member = false;
    await assert.rejects(imageContext.add(pin, undefined, evidence), /管理者権限/u);
    member = true;
    await assert.rejects(imageContext.add(pin, undefined, { ...evidence, rights: 'confirmed' }), /確認済みへ変更/u);
    await assert.rejects(imageContext.add({ ...pin, image_usage_status: 'not_permitted' }, undefined, evidence), /明示的/u);
    await assert.rejects(imageContext.add(pin, undefined, { ...evidence, instructionRef: '' }), /採用指示/u);
    storageBytes = new File([new Uint8Array([255,216,255,1])], 'different.jpg', { type: 'image/jpeg' });
    await assert.rejects(imageContext.add(pin, undefined, evidence), /一致しません/u);
    storageBytes = storedImage;
    failWrite = true;
    await assert.rejects(imageContext.add(pin, undefined, evidence), /更新結果を確認できません/u);
    failWrite = false;
    assert.equal(imageOnlyChanges.length, writesBeforeRepair);
    assert.equal(imageAudits.length, auditsBeforeRepair);
    const repaired = await imageContext.add(pin, undefined, evidence);
    assert.equal(repaired.image_owner_instruction_ref, evidence.instructionRef);
    assert.equal(repaired.image_usage_status, 'unknown');
    assert.equal(repaired.use_image_on_public_page, true);
    assert.equal(repaired.flyer_path, pin.flyer_path);
    assert.equal(repaired.slug, pin.slug);
    assert.equal(repaired.lifecycle_status, pin.lifecycle_status);
    assert.equal(repaired.approved_hash, pin.approved_hash);
    assert.equal(repaired.image_publication_confirmed_by, actor);
    assert.ok(repaired.image_publication_confirmed_at);
    assert.deepEqual(imageOnlyChanges.slice(writesBeforeRepair), [{ image_owner_instruction_ref: evidence.instructionRef, image_usage_status: 'unknown', use_image_on_public_page: true }]);
    assert.deepEqual(imageAudits.slice(auditsBeforeRepair), [{ work_id: pin.id, actor_user_id: actor }]);
    await assert.rejects(imageContext.add(pin, undefined, evidence), /更新結果を確認できません/u);
    assert.equal(imageAudits.length, auditsBeforeRepair + 1);
    assert.equal(uploaded, 1, 'stored image repair must never upload again');
    globalThis.createImageBitmap = originalBitmap;
    console.log('WORKS local image validation, provenance, neutral placeholders and existing-object preservation passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
