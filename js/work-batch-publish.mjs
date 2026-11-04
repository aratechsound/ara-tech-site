import { validateFlyerFile } from './work-image-upload.mjs';

export const WKS001_IDS = Object.freeze([89, 90, 91, 92, 93, 94, 95, 96, 97, 98]);
const PENDING = 'publication_pending_approval';
const approved = (p) => p.is_published === true && p.publication_review_status === null
    && p.approved_hash === p.candidate_hash && Boolean(p.approved_at && p.approved_by)
    && p.image_usage_status === 'confirmed' && p.use_image_on_public_page === true
    && Boolean(p.image_publication_confirmed_at && p.image_publication_confirmed_by);
const sameImage = (a, b) => a.flyer_path === b.flyer_path
    && a.public_image_sha256 === b.public_image_sha256
    && a.public_image_source_url === b.public_image_source_url;

// Uses only the existing authenticated client, RLS and publication RPC.
// No token export, privileged client, SQL, upload, deletion or automatic retry.
export const publishWks001 = async ({ client, expected, verifyImage, onProgress = () => {} }) => {
    if (expected.length !== 10 || expected.some((p, i) => p.id !== WKS001_IDS[i])) {
        throw new Error('WKS-001の対象10件が一致しません。');
    }
    const { data: auth, error: authError } = await client.auth.getUser();
    if (authError || !auth.user) throw new Error('管理者のログインが必要です。');
    const { data: admin, error: adminError } = await client.from('work_admins')
        .select('user_id').eq('user_id', auth.user.id).maybeSingle();
    if (adminError || !admin) throw new Error('管理者権限を確認できません。');
    const read = async (id) => {
        const { data, error } = await client.from('work_posts').select('*').eq('id', id).single();
        if (error || !data) throw new Error('最新の候補を取得できません。');
        return data;
    };
    const results = [];
    for (const pin of expected) {
        let rpcAttempted = false;
        try {
            let post = await read(pin.id);
            if (!sameImage(post, pin)) throw new Error('承認対象の画像が変更されています。');
            await verifyImage(post);
            if (approved(post)) {
                results.push({ id: pin.id, status: 'already_published', slug: post.slug });
                onProgress(results.slice());
                continue;
            }
            if (post.is_published || post.publication_review_status !== PENDING
                || post.candidate_hash !== pin.candidate_hash) throw new Error('候補の内容または状態が変更されています。');
            if (!post.use_image_on_public_page || post.image_usage_status !== 'confirmed') {
                const { data, error } = await client.from('work_posts').update({
                    image_usage_status: 'confirmed', use_image_on_public_page: true
                }).eq('id', post.id).eq('candidate_hash', post.candidate_hash)
                    .eq('publication_review_status', PENDING).eq('is_published', false)
                    .select('*').maybeSingle();
                if (error || !data) throw new Error('画像確認を登録できません。最新状態を再確認してください。');
                post = data;
            }
            const latest = await read(pin.id);
            if (!sameImage(latest, post) || latest.candidate_hash !== post.candidate_hash
                || latest.is_published || latest.publication_review_status !== PENDING
                || !latest.use_image_on_public_page || latest.image_usage_status !== 'confirmed'
                || !latest.image_publication_confirmed_at || !latest.image_publication_confirmed_by) {
                throw new Error('画像確認または最新ハッシュを検証できません。');
            }
            rpcAttempted = true;
            const { data, error } = await client.rpc('publish_work_candidate', {
                p_work_id: latest.id, p_candidate_hash: latest.candidate_hash
            });
            const result = Array.isArray(data) ? data[0] : data;
            const after = await read(pin.id);
            if (approved(after) && sameImage(after, latest)) {
                results.push({ id: pin.id, status: 'published', slug: after.slug,
                    rpc_result: error ? 'response_error_readback_published' : result?.result,
                    candidate_hash: after.candidate_hash, approved_hash: after.approved_hash });
            } else {
                throw new Error(error ? 'API応答エラー。自動再実行せず読戻しで確認してください。'
                    : `公開未成立：${result?.result || 'unknown'}`);
            }
        } catch (error) {
            // A lost response is not permission to send the RPC again.
            results.push({ id: pin.id, status: rpcAttempted ? 'needs_readback' : 'held', message: error.message });
        }
        onProgress(results.slice());
    }
    return results;
};

export const verifyWks001StorageImage = async (post, storageUrl) => {
    if (!post.flyer_path || !/^[a-f0-9]{64}$/u.test(post.public_image_sha256 || '')) {
        throw new Error('画像パスまたはSHA-256がありません。');
    }
    const response = await fetch(storageUrl(post.flyer_path), { cache: 'no-store' });
    if (!response.ok || Number(response.headers.get('content-length')) > 10 * 1024 * 1024) {
        throw new Error('Storage画像を取得できません。');
    }
    const bytes = await response.arrayBuffer();
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
        (b) => b.toString(16).padStart(2, '0')).join('');
    if (digest !== post.public_image_sha256) throw new Error('Storage画像のSHA-256が一致しません。');
    const file = new File([bytes], post.flyer_path.split('/').pop(), {
        type: (response.headers.get('content-type') || '').split(';')[0]
    });
    await validateFlyerFile(file);
};
