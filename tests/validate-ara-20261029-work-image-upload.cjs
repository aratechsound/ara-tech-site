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
    assert.match(admin, /imageSourceUrl\(reviewImageUrl/u);
    console.log('WORKS local image validation, provenance, neutral placeholders and existing-object preservation passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
