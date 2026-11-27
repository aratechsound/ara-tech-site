import { readWorksAdministrator } from './work-reviewed-publish.mjs';
import { imageSourceUrl, validateFlyerFile } from './work-image-upload.mjs';

const sha256 = async (file) => {
    const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

// Only repairs an already-published, image-hidden post with a pinned stored image.
// The caller is the existing WORKS administrator editor; no new auth or publication route.
export async function publishStoredFlyer({ client, bucket, post, file, sourceUrl, instructionRef, expectedSha, rights }) {
    if (!post || !Number.isSafeInteger(post.id) || post.id < 1 || !post.updated_at
        || post.is_published !== true || post.publication_review_status != null
        || post.use_image_on_public_page !== false || !post.flyer_path
        || !Object.hasOwn(post, 'image_owner_instruction_ref')) {
        throw new Error('公開済みで保存済み画像が非掲載の投稿を開いてください。');
    }
    if (post.image_usage_status === 'not_permitted' || !['unknown', 'confirmed'].includes(rights)) {
        throw new Error('明示的な画像利用制限があります。');
    }
    // This repair must not turn unknown third-party permission into a confirmed licence.
    if (rights === 'confirmed' && post.image_usage_status !== 'confirmed') {
        throw new Error('第三者の転載許諾を確認済みへ変更する操作は対象外です。');
    }
    if (typeof instructionRef !== 'string' || !instructionRef.trim() || instructionRef !== instructionRef.trim()
        || instructionRef.length > 200 || !/^[a-f0-9]{64}$/.test(expectedSha || '')
        || !sourceUrl || imageSourceUrl(sourceUrl) !== sourceUrl) {
        throw new Error('Owner採用指示の参照・画像出典・SHA-256を確認してください。');
    }
    if (post.public_image_source_url !== sourceUrl || post.public_image_sha256 !== expectedSha
        || (post.image_owner_instruction_ref != null && post.image_owner_instruction_ref !== instructionRef)) {
        throw new Error('保存済み画像または既存のOwner採用指示と一致しません。');
    }
    const actor = await readWorksAdministrator(client);
    if (actor.status !== 'ready') throw new Error('WORKS管理者権限を確認できません。');

    // No replacement/upload: an optional selected file must be exactly the same bytes.
    if (file) {
        await validateFlyerFile(file);
        if (await sha256(file) !== expectedSha) throw new Error('選択画像がOwner採用画像と一致しません。');
    }
    const { data: savedBytes, error: downloadError } = await client.storage.from(bucket).download(post.flyer_path);
    if (downloadError || !savedBytes) throw new Error('Storageの保存画像を確認できませんでした。');
    await validateFlyerFile(savedBytes);
    if (await sha256(savedBytes) !== expectedSha) throw new Error('Storageの保存画像がOwner採用画像と一致しません。');
    const currentActor = await readWorksAdministrator(client);
    if (currentActor.status !== 'ready' || currentActor.user.id !== actor.user.id) {
        throw new Error('管理者セッションが変わりました。投稿を読み直してください。');
    }

    // One CAS update. Existing database triggers set real auth.uid(), time and image audit.
    // Keep path/source/hash, lifecycle, slug and formal publication records untouched.
    let update = client.from('work_posts').update({
        image_owner_instruction_ref: instructionRef,
        image_usage_status: rights,
        use_image_on_public_page: true
    }).eq('id', post.id).eq('updated_at', post.updated_at)
        .eq('is_published', true).eq('use_image_on_public_page', false)
        .is('publication_review_status', null)
        .eq('flyer_path', post.flyer_path).eq('public_image_sha256', expectedSha)
        .eq('public_image_source_url', sourceUrl);
    update = post.image_owner_instruction_ref == null
        ? update.is('image_owner_instruction_ref', null)
        : update.eq('image_owner_instruction_ref', post.image_owner_instruction_ref);
    update = post.image_usage_status == null
        ? update.is('image_usage_status', null)
        : update.eq('image_usage_status', post.image_usage_status);
    const { data: visible, error } = await update.select(
        'id,slug,lifecycle_status,is_published,publication_review_status,updated_at,flyer_path,public_image_sha256,public_image_source_url,image_usage_status,use_image_on_public_page,image_owner_instruction_ref,image_publication_confirmed_by,image_publication_confirmed_at,candidate_hash,approved_hash,approved_by,approved_at'
    ).maybeSingle();
    if (error || !visible) {
        // Caller reloads the same post. Do not automatically retry an uncertain write.
        throw new Error('画像掲載の更新結果を確認できません。最新の投稿を読み直してください。');
    }
    const unchanged = ['id', 'slug', 'lifecycle_status', 'flyer_path', 'public_image_sha256',
        'public_image_source_url', 'candidate_hash', 'approved_hash', 'approved_by', 'approved_at'];
    if (unchanged.some((key) => visible[key] !== post[key])
        || visible.is_published !== true || visible.publication_review_status != null
        || visible.use_image_on_public_page !== true || visible.image_usage_status !== rights
        || visible.image_owner_instruction_ref !== instructionRef
        || visible.image_publication_confirmed_by !== actor.user.id || !visible.image_publication_confirmed_at) {
        throw new Error('画像掲載または監査情報を確認できません。最新の投稿を読み直してください。');
    }
    return visible;
}
