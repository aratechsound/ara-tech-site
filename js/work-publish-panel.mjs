import { publishReviewed } from './work-reviewed-publish.mjs';
import { validateFlyerFile } from './work-image-upload.mjs';

export async function verifyStoredPublicationImage(client, bucket, post) {
    if (!post.flyer_path || post.flyer_path.includes('..')) throw new Error('invalid_storage_path');
    const { data } = client.storage.from(bucket).getPublicUrl(post.flyer_path);
    const response = await fetch(data.publicUrl, { cache: 'no-store' });
    if (!response.ok || Number(response.headers.get('content-length')) > 10485760) throw new Error('stored_image_unavailable');
    const bytes = await response.arrayBuffer();
    if (!bytes.byteLength || bytes.byteLength > 10485760) throw new Error('image_size_invalid');
    const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b=>b.toString(16).padStart(2,'0')).join('');
    if (sha256 !== post.public_image_sha256) throw new Error('image_sha256_mismatch');
    const file = new File([bytes], 'reviewed-image', { type: (response.headers.get('content-type') || '').split(';')[0] });
    await validateFlyerFile(file);
    return { sha256, decoded: true };
}

let active = false;
const heldAfterAttempt = new Set();
export async function renderReviewedPublishPanel({ client, bucket, posts, container, reload }) {
    if (!container || active) return;
    container.replaceChildren();
    const heading = document.createElement('h2'); heading.textContent='確認した公演をAPIで正式公開';
    const intro = document.createElement('p'); intro.textContent='表示中の公演・画像・候補ハッシュを確認した管理者本人が、対象1件の操作を1回だけ実行してください。追加のOKダイアログはありません。';
    container.append(heading,intro);
    const pending = posts.filter(p=>p.publication_review_status==='publication_pending_approval' && !p.is_published);
    container.classList.toggle('hidden',!pending.length);
    for (const post of pending) {
        const card=document.createElement('article'); card.className='card';
        const title=document.createElement('h3'); title.textContent=`ID ${post.id}：${post.title}`;
        const detail=document.createElement('p'); detail.textContent=`${post.event_date} ｜ ${post.venue} ｜ ${post.performer_name || ''} ｜ ${(post.service_types || []).join(', ')}`;
        const hash=document.createElement('p'); hash.style.overflowWrap='anywhere'; hash.textContent=`候補SHA-256：${post.candidate_hash}`;
        const picture=document.createElement('img'); picture.alt=post.flyer_alt || post.title; picture.style.cssText='max-width:240px;max-height:320px;object-fit:contain';
        if(post.flyer_path) picture.src=client.storage.from(bucket).getPublicUrl(post.flyer_path).data.publicUrl;
        const state=document.createElement('p'); state.setAttribute('role','status'); state.textContent='保存画像のSHA-256・形式・デコードを確認中';
        const button=document.createElement('button'); button.type='button'; button.className='button'; button.textContent=`${post.performer_name || post.title}を正式公開`; button.disabled=true;
        card.append(title,detail,hash,picture,state,button); container.append(card);
        const pin=structuredClone(post);
        try {
            await verifyStoredPublicationImage(client,bucket,pin);
            state.textContent=`保存画像検証済み ｜ SHA-256：${pin.public_image_sha256}`;
            button.disabled=heldAfterAttempt.has(pin.id);
        } catch(error) { state.textContent=`画像検証HOLD：${error.message}`; }
        button.addEventListener('click',async event=>{
            if(!event.isTrusted || active || heldAfterAttempt.has(pin.id)) return;
            active=true; button.disabled=true; state.textContent='本人・権限・最新候補を確認し、対象1件の公開APIを実行しています。';
            let result;
            try {
                const {data,error}=await client.auth.getUser();
                if(error || !data?.user) throw new Error('authenticated_user_missing');
                result=await publishReviewed({client,pin,authorization:{workId:pin.id,candidateHash:pin.candidate_hash,actorId:data.user.id,instructionRef:'authenticated administrator reviewed-candidate activation',publish:true,image:true},verifyImage:p=>verifyStoredPublicationImage(client,bucket,p)});
            } catch(error) { result={status:'held',id:pin.id,reason:error.message}; }
            // A submitted or ambiguous request is never automatically retried.
            if(result.status==='needs_readback') heldAfterAttempt.add(pin.id);
            state.textContent=JSON.stringify(result);
            active=false;
            if(['published','already_published'].includes(result.status)) {
                button.textContent='正式公開済み';
                await reload();
            } else {
                button.disabled=true;
                state.textContent+=' ｜ 再送せず最新DBを確認してください。';
            }
        });
    }
}
