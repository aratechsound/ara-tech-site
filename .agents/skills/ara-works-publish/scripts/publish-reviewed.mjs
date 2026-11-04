const pending = 'publication_pending_approval';
const formal = p => p.is_published === true && p.publication_review_status === null
    && p.approved_hash === p.candidate_hash && Boolean(p.approved_at && p.approved_by);
const imageReady = p => p.image_usage_status === 'confirmed' && p.use_image_on_public_page === true
    && Boolean(p.flyer_path && p.public_image_source_url && p.image_publication_confirmed_at && p.image_publication_confirmed_by)
    && /^[a-f0-9]{64}$/.test(p.public_image_sha256 || '');
const sameImage = (a,b) => ['flyer_path','public_image_source_url','public_image_sha256'].every(k=>a[k]===b[k]);
const normalized = s => String(s || '').normalize('NFKC').trim().replace(/\s+/g,' ').toLowerCase();
// Supply all rows found by the date/performer/venue/title duplicate search, including drafts.
export function resolveExisting(rows,event) {
    const related = rows.filter(p=>p.event_date===event.event_date
        && normalized(p.venue)===normalized(event.venue)
        && normalized(p.performer_name || p.artists)===normalized(event.performer_name));
    if(related.length>1) throw new Error('duplicate_candidates');
    if(related.length && normalized(related[0].title)!==normalized(event.title)) throw new Error('identity_conflict');
    return related[0] || null;
}

// Supply an existing authenticated administrator client. This module never obtains credentials.
export async function publishReviewed({client, pin, authorization:a, verifyImage}) {
    let attempted = false;
    const read = async () => {
        const {data,error} = await client.from('work_posts').select('*').eq('id',pin.id).single();
        if(error || !data) throw new Error('candidate_read_failed');
        return data;
    };
    try {
        if(typeof client?.auth?.getUser !== 'function' || typeof client?.rpc !== 'function') throw new Error('authenticated_runtime_missing');
        if(!Number.isSafeInteger(pin?.id) || !/^[a-f0-9]{64}$/.test(pin.candidate_hash || '')
            || a?.workId !== pin.id || a?.candidateHash !== pin.candidate_hash
            || a?.publish !== true || a?.image !== true || !a?.instructionRef || !a?.actorId) throw new Error('authorization_scope_missing');
        const {data:auth,error:authError} = await client.auth.getUser();
        if(authError || !auth?.user || auth.user.id !== a.actorId) throw new Error('authenticated_actor_missing');
        const {data:admin,error:adminError} = await client.from('work_admins').select('user_id').eq('user_id',auth.user.id).maybeSingle();
        if(adminError || !admin) throw new Error('admin_membership_missing');
        const post = await read();
        if(!sameImage(post,pin) || post.candidate_hash !== pin.candidate_hash) throw new Error('candidate_changed');
        if(formal(post)) return {status:'already_published',id:post.id,slug:post.slug};
        if(post.is_published || post.publication_review_status !== pending) throw new Error('invalid_state');
        if(!imageReady(post)) throw new Error('image_approval_missing');
        const image = await verifyImage(post);
        if(image?.decoded !== true || image.sha256 !== post.public_image_sha256) throw new Error('image_verification_failed');
        const latest = await read();
        if(latest.candidate_hash !== post.candidate_hash || !sameImage(latest,post)
            || latest.is_published || latest.publication_review_status !== pending || !imageReady(latest)) throw new Error('candidate_changed');
        attempted = true;
        let response;
        try { response = await client.rpc('publish_work_candidate',{p_work_id:latest.id,p_candidate_hash:latest.candidate_hash}); }
        catch { response = {error:true}; }
        const after = await read();
        if(formal(after) && after.approved_by===auth.user.id && imageReady(after) && sameImage(after,latest)) return {
            status:'published',id:after.id,slug:after.slug,candidate_hash:after.candidate_hash,
            approved_hash:after.approved_hash,response_error:Boolean(response?.error)
        };
        return {status:'needs_readback',id:pin.id,reason:'publication_not_verified',rpc_attempts:1};
    } catch(error) {
        return {status:attempted?'needs_readback':'held',id:pin?.id,reason:error.message,rpc_attempts:attempted?1:0};
    }
}
