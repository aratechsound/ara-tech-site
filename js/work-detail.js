import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_ANON_KEY, SUPABASE_URL, WORKS_BUCKET, isSupabaseConfigured } from './supabase-config.js';

const root = document.querySelector('#work-detail');
const postId = Number(new URLSearchParams(window.location.search).get('id'));

const roleDetails = {
    artist_pa_operation: { label: 'ARTIST PA OPERATION', description: 'アーティストPA・音響オペレート' },
    local_technical_support: { label: 'LOCAL TECHNICAL SUPPORT', description: '乗り込みPA対応・現場技術サポート' }
};

const formatDate = (date) => date ? new Intl.DateTimeFormat('ja-JP', { year: 'numeric', month: 'long', day: 'numeric' }).format(new Date(`${date}T00:00:00`)) : '';

const showMessage = (message) => {
    root.className = 'not-found';
    root.textContent = message;
};

const appendMeta = (list, label, value) => {
    if (!value) return;
    const row = document.createElement('div');
    const term = document.createElement('dt');
    term.textContent = label;
    const definition = document.createElement('dd');
    definition.textContent = value;
    row.append(term, definition);
    list.append(row);
};

const renderDetail = (supabase, post) => {
    document.title = `${post.title} | 実績 | ARA-TECH`;
    root.className = 'detail-card';
    root.replaceChildren();

    const layout = document.createElement('div');
    layout.className = 'detail-grid';
    const flyer = document.createElement('figure');
    flyer.className = 'detail-flyer';
    const image = document.createElement('img');
    image.src = supabase.storage.from(WORKS_BUCKET).getPublicUrl(post.flyer_path).data.publicUrl;
    image.alt = post.flyer_alt || `${post.title}のフライヤー`;
    flyer.append(image);

    const body = document.createElement('div');
    body.className = 'detail-body';
    const eyebrow = document.createElement('p');
    eyebrow.className = 'eyebrow';
    eyebrow.textContent = 'FIELD REPORT';
    const tag = document.createElement('span');
    tag.className = 'detail-tag';
    tag.textContent = post.category || 'WORKS';
    body.append(eyebrow, tag);

    const role = roleDetails[post.role_type];
    if (role) {
        const roleTag = document.createElement('span');
        roleTag.className = `detail-role detail-role--${post.role_type === 'artist_pa_operation' ? 'operation' : 'support'}`;
        roleTag.textContent = role.label;
        body.append(roleTag);
    }

    const title = document.createElement('h1');
    title.className = 'detail-title';
    if (post.title.length > 60) title.classList.add('detail-title--long');
    else if (post.title.length > 34) title.classList.add('detail-title--medium');
    title.textContent = post.title;
    body.append(title);

    if (post.artists) {
        const artists = document.createElement('p');
        artists.className = 'artist';
        artists.textContent = `担当アーティスト：${post.artists}`;
        body.append(artists);
    }

    if (role) {
        const roleDescription = document.createElement('p');
        roleDescription.className = 'role-description';
        roleDescription.textContent = role.description;
        body.append(roleDescription);
    }

    const meta = document.createElement('dl');
    meta.className = 'detail-meta';
    appendMeta(meta, '開催日', formatDate(post.event_date));
    appendMeta(meta, '会場', post.venue);
    body.append(meta);

    if (post.description) {
        const description = document.createElement('section');
        description.className = 'description';
        const heading = document.createElement('h2');
        heading.textContent = '現場について';
        const text = document.createElement('p');
        text.textContent = post.description;
        description.append(heading, text);
        body.append(description);
    }

    layout.append(flyer, body);
    root.append(layout);
};

const loadDetail = async () => {
    if (!Number.isSafeInteger(postId) || postId < 1) { showMessage('表示する実績が見つかりませんでした。'); return; }
    if (!isSupabaseConfigured) { showMessage('実績情報を読み込めませんでした。'); return; }
    // 公開詳細ページは、管理画面のログイン状態を引き継がず匿名閲覧に固定する。
    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
    });
    const { data, error } = await supabase
        .from('work_posts')
        .select('id, title, category, role_type, event_date, venue, artists, description, flyer_path, flyer_alt')
        .eq('id', postId)
        .maybeSingle();
    if (error || !data) { showMessage('この実績は公開されていないか、見つかりませんでした。'); return; }
    renderDetail(supabase, data);
};

loadDetail();
