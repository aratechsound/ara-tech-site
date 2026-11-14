const pending = 'publication_pending_approval';
const formal = p => p.is_published === true && p.publication_review_status === null
    && p.approved_hash === p.candidate_hash && Boolean(p.approved_at && p.approved_by);
const imageReady = p => (p.image_usage_status === 'confirmed'
    || (p.image_usage_status === 'unknown' && Boolean(p.image_owner_instruction_ref?.trim())))
    && p.use_image_on_public_page === true
    && Boolean(p.flyer_path && p.public_image_source_url && p.image_publication_confirmed_at && p.image_publication_confirmed_by)
    && /^[a-f0-9]{64}$/.test(p.public_image_sha256 || '');
const sameImage = (a,b) => ['use_image_on_public_page','image_usage_status','flyer_path',
    'public_image_source_url','public_image_sha256','image_owner_instruction_ref'].every(k=>a[k]===b[k]);
const normalized = s => String(s || '').normalize('NFKC').trim().replace(/\s+/g,' ').toLowerCase();

export function missingPublicationFields(post) {
    const required = [
        ['公演名', post.title], ['開催日', post.event_date], ['会場', post.venue],
        ['地域', post.area], ['出演者・公演名', post.performer_name],
        ['担当内容', post.service_types?.length || post.assignment_items?.length || post.role_types?.length || post.role_type],
        ['公式告知URL（HTTPS）', /^https:\/\/[^\s]+$/.test(post.official_announcement_url || '')],
        ['開催予定の区分', post.lifecycle_status === 'upcoming'],
        ['候補ハッシュ', /^[a-f0-9]{64}$/.test(post.candidate_hash || '')]
    ];
    return required.filter(([, value]) => !String(value || '').trim()).map(([label]) => label);
}

export async function readWorksAdministrator(client) {
    const { data: auth, error: authError } = await client.auth.getUser();
    if (authError || !auth?.user) return { status: 'authenticated_actor_missing' };
    const { data: admin, error } = await client.from('work_admins')
        .select('user_id').eq('user_id', auth.user.id).maybeSingle();
    if (error) return { status: 'admin_membership_unverified' };
    if (admin?.user_id !== auth.user.id) return { status: 'admin_membership_missing' };
    return { status: 'ready', user: auth.user };
}

export async function restoreWorksAdministrator(client) {
    const { data, error } = await client.auth.getSession();
    if (error) return { status: 'session_restore_failed' };
    if (!data?.session) return { status: 'session_absent' };
    return readWorksAdministrator(client);
}
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
            || a?.publish !== true || !a?.instructionRef || !a?.actorId
            || (pin.use_image_on_public_page === true && a?.image !== true)) throw new Error('authorization_scope_missing');
        const actor = await readWorksAdministrator(client);
        if(actor.status !== 'ready') throw new Error(actor.status);
        if(actor.user.id !== a.actorId) throw new Error('authenticated_actor_missing');
        const post = await read();
        if(!sameImage(post,pin) || post.candidate_hash !== pin.candidate_hash) throw new Error('candidate_changed');
        if(formal(post)) return {status:'already_published',id:post.id,slug:post.slug};
        if(post.is_published || post.publication_review_status !== pending) throw new Error('invalid_state');
        if(missingPublicationFields(post).length) throw new Error('validation_failed');
        const withImage = post.use_image_on_public_page === true;
        if(withImage) {
            if(!imageReady(post)) throw new Error('image_approval_missing');
            const image = await verifyImage(post);
            if(image?.decoded !== true || image.sha256 !== post.public_image_sha256) throw new Error('image_verification_failed');
        } else if (post.use_image_on_public_page !== false || post.image_owner_instruction_ref) {
            throw new Error('image_decision_missing');
        }
        const latest = await read();
        if(latest.candidate_hash !== post.candidate_hash || !sameImage(latest,post)
            || latest.is_published || latest.publication_review_status !== pending
            || (withImage && !imageReady(latest))) throw new Error('candidate_changed');
        attempted = true;
        let response;
        try { response = await client.rpc('publish_work_candidate',{p_work_id:latest.id,p_candidate_hash:latest.candidate_hash}); }
        catch { response = {error:true}; }
        const after = await read();
        if(formal(after) && after.candidate_hash === latest.candidate_hash && after.approved_by===actor.user.id
            && sameImage(after,latest) && (!withImage || imageReady(after))) return {
            status:'published',id:after.id,slug:after.slug,candidate_hash:after.candidate_hash,
            approved_hash:after.approved_hash,image_included:withImage,response_error:Boolean(response?.error)
        };
        return {status:'needs_readback',id:pin.id,reason:'publication_not_verified',rpc_attempts:1};
    } catch(error) {
        return {status:attempted?'needs_readback':'held',id:pin?.id,reason:error.message,rpc_attempts:attempted?1:0};
    }
}
