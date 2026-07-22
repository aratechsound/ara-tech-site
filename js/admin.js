import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_ANON_KEY, SUPABASE_URL, WORKS_BUCKET, isSupabaseConfigured } from './supabase-config.js';

const $ = (selector) => document.querySelector(selector);
const configMessage = $('#config-message');
const loginPanel = $('#login-panel');
const dashboard = $('#dashboard');
const loginForm = $('#login-form');
const loginStatus = $('#login-status');
const postForm = $('#post-form');
const postStatus = $('#post-status');
const postList = $('#admin-posts');
const flyerInput = $('#post-flyer');
const flyerPreview = $('#flyer-preview');
const cancelEdit = $('#cancel-edit');
const formTitle = $('#form-title');
const saveButton = $('#save-post');
const templateSelect = $('#post-template');
const titleHistory = $('#title-history');
const operationArtistsHistory = $('#operation-artists-history');
const supportArtistsHistory = $('#support-artists-history');
const venueHistory = $('#venue-history');
const operationRoleInput = $('#post-role-operation');
const supportRoleInput = $('#post-role-support');
const operationArtistsField = $('#operation-artists-field');
const supportArtistsField = $('#support-artists-field');
const operationArtistsInput = $('#post-operation-artists');
const supportArtistsInput = $('#post-support-artists');
const publicationMode = $('#post-publication-mode');
const publishAtField = $('#publish-at-field');
const publishAtInput = $('#post-publish-at');
const slugInput = $('#post-slug');
const slugPreview = $('#slug-preview');
const unlockSlugButton = $('#unlock-slug');

let supabase;
let posts = [];
let editingPost = null;
let slugWasEdited = false;

const roleLabels = {
    artist_pa_operation: 'ARTIST PA OPERATION ｜ アーティストPA・音響オペレート',
    local_technical_support: 'LOCAL TECHNICAL SUPPORT ｜ 乗り込みPA対応・現場技術サポート'
};

const getRoleTypes = (post) => Array.isArray(post.role_types) && post.role_types.length ? post.role_types : (post.role_type ? [post.role_type] : []);

const updateRoleFields = () => {
    operationArtistsField.classList.toggle('hidden', !operationRoleInput.checked);
    supportArtistsField.classList.toggle('hidden', !supportRoleInput.checked);
    operationArtistsInput.disabled = !operationRoleInput.checked;
    supportArtistsInput.disabled = !supportRoleInput.checked;
};

const loadRoleAssignment = (post) => {
    const roleTypes = getRoleTypes(post);
    operationRoleInput.checked = roleTypes.includes('artist_pa_operation');
    supportRoleInput.checked = roleTypes.includes('local_technical_support');
    operationArtistsInput.value = post.operation_artists || (operationRoleInput.checked ? post.artists || '' : '');
    supportArtistsInput.value = post.support_artists || (supportRoleInput.checked ? post.artists || '' : '');
    updateRoleFields();
};

const setMessage = (element, message, type = 'info') => {
    element.textContent = message;
    element.className = `alert alert--${type}`;
};

const clearMessage = (element) => {
    element.textContent = '';
    element.className = 'alert hidden';
};

const formatDate = (date) => date ? new Intl.DateTimeFormat('ja-JP', { year: 'numeric', month: 'short', day: 'numeric' }).format(new Date(`${date}T00:00:00`)) : '開催日未設定';
const formatDateTime = (dateTime) => dateTime ? new Intl.DateTimeFormat('ja-JP', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(dateTime)) : '';
const toLocalDateTimeInput = (dateTime) => {
    if (!dateTime) return '';
    const date = new Date(dateTime);
    const pad = (number) => String(number).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};
const toIsoDateTime = (localDateTime) => localDateTime ? new Date(localDateTime).toISOString() : null;

const normalizeSlug = (value) => value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, '-and-')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 96)
    .replace(/-+$/g, '');

const generatedSlug = () => {
    const year = $('#post-date').value.slice(0, 4) || String(new Date().getFullYear());
    const titlePart = normalizeSlug($('#post-title').value);
    const categoryPart = normalizeSlug($('#post-category').value) || 'work';
    return normalizeSlug(`${year}-${titlePart || categoryPart}`) || `${year}-work`;
};

const workUrl = (slug) => `https://ara-tech.cc/works/${slug}.html`;
const hasValidSlug = (slug) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug);

const updateSlugPreview = () => {
    const slug = normalizeSlug(slugInput.value);
    slugPreview.replaceChildren();
    if (!slug) {
        slugPreview.textContent = 'イベント名または開催日を入力すると、公開URLを表示します。';
        return;
    }
    const label = document.createTextNode('公開URL：');
    const link = document.createElement('a');
    link.href = workUrl(slug);
    link.textContent = workUrl(slug);
    link.target = '_blank';
    link.rel = 'noopener';
    slugPreview.append(label, link);
};

const refreshGeneratedSlug = () => {
    if (editingPost || slugWasEdited) return;
    slugInput.value = generatedSlug();
    updateSlugPreview();
};

const prepareNewSlug = () => {
    slugWasEdited = false;
    slugInput.readOnly = false;
    unlockSlugButton.classList.add('hidden');
    slugInput.value = generatedSlug();
    updateSlugPreview();
};

const prepareExistingSlug = (slug) => {
    slugWasEdited = false;
    slugInput.value = slug || '';
    slugInput.readOnly = true;
    unlockSlugButton.classList.remove('hidden');
    updateSlugPreview();
};

const findUniqueSlug = async (base, excludedId = null) => {
    const { data, error } = await supabase.from('work_posts').select('id, slug').like('slug', `${base}%`);
    if (error) throw new Error('公開URLの重複を確認できませんでした。もう一度お試しください。');
    const used = new Set((data || []).filter((post) => post.id !== excludedId).map((post) => post.slug));
    if (!used.has(base)) return base;
    for (let suffix = 2; suffix <= 999; suffix += 1) {
        const candidate = `${base}-${suffix}`;
        if (!used.has(candidate)) return candidate;
    }
    throw new Error('一意な公開URLを作成できませんでした。URLを手動で入力してください。');
};

const fileUrl = (path) => supabase.storage.from(WORKS_BUCKET).getPublicUrl(path).data.publicUrl;

const getPublicationState = (post) => {
    if (!post.is_published) return { className: 'draft', label: '下書き' };
    if (post.publish_at && new Date(post.publish_at).getTime() > Date.now()) return { className: 'scheduled', label: '予約中' };
    return { className: 'published', label: '公開中' };
};

const updateSaveButton = () => {
    if (editingPost) { saveButton.textContent = '変更を保存'; return; }
    if (publicationMode.value === 'scheduled') { saveButton.textContent = '予約して保存'; return; }
    if (publicationMode.value === 'now') { saveButton.textContent = '公開して保存'; return; }
    saveButton.textContent = '下書き保存';
};

const updatePublicationControls = () => {
    const isScheduled = publicationMode.value === 'scheduled';
    publishAtField.classList.toggle('hidden', !isScheduled);
    publishAtInput.required = isScheduled;
    if (!isScheduled) publishAtInput.value = '';
    updateSaveButton();
};

const isAdmin = async (user) => {
    const { data, error } = await supabase.from('work_admins').select('user_id').eq('user_id', user.id).maybeSingle();
    return Boolean(data && !error);
};

const resetPostForm = () => {
    editingPost = null;
    postForm.reset();
    $('#post-category').value = 'WORKS';
    operationRoleInput.checked = false;
    supportRoleInput.checked = false;
    updateRoleFields();
    publicationMode.value = 'draft';
    templateSelect.value = '';
    updatePublicationControls();
    prepareNewSlug();
    flyerPreview.removeAttribute('src');
    flyerPreview.classList.add('hidden');
    formTitle.textContent = '新しい実績を追加';
    cancelEdit.classList.add('hidden');
    clearMessage(postStatus);
    updateSaveButton();
};

const setPreview = (source) => {
    if (!source) { flyerPreview.removeAttribute('src'); flyerPreview.classList.add('hidden'); return; }
    flyerPreview.src = source;
    flyerPreview.classList.remove('hidden');
};

const uploadFlyer = async (file) => {
    if (!file) return null;
    if (file.size > 10 * 1024 * 1024) throw new Error('画像は10MB以下にしてください。');
    const extension = file.name.split('.').pop()?.toLowerCase() || 'jpg';
    const safeExtension = ['png', 'jpg', 'jpeg', 'webp'].includes(extension) ? extension : 'jpg';
    const filename = `${Date.now()}-${crypto.randomUUID()}.${safeExtension}`;
    const path = `flyers/${filename}`;
    const { error } = await supabase.storage.from(WORKS_BUCKET).upload(path, file, { cacheControl: '31536000', upsert: false });
    if (error) throw error;
    return path;
};

const addHistoryOptions = (datalist, values) => {
    datalist.replaceChildren();
    [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ja')).forEach((value) => {
        const option = document.createElement('option');
        option.value = value;
        datalist.append(option);
    });
};

const populateHistories = () => {
    addHistoryOptions(titleHistory, posts.map((post) => post.title));
    addHistoryOptions(operationArtistsHistory, posts.map((post) => post.operation_artists || (getRoleTypes(post).includes('artist_pa_operation') ? post.artists : null)));
    addHistoryOptions(supportArtistsHistory, posts.map((post) => post.support_artists || (getRoleTypes(post).includes('local_technical_support') ? post.artists : null)));
    addHistoryOptions(venueHistory, posts.map((post) => post.venue));
    templateSelect.replaceChildren();
    const initial = document.createElement('option');
    initial.value = '';
    initial.textContent = '過去の投稿を選んで入力内容をコピー';
    templateSelect.append(initial);
    posts.forEach((post) => {
        const option = document.createElement('option');
        option.value = post.id;
        const details = [post.operation_artists || post.support_artists || post.artists ? '担当情報あり' : '', post.event_date ? formatDate(post.event_date) : ''].filter(Boolean).join(' ｜ ');
        option.textContent = details ? `${post.title}（${details}）` : post.title;
        templateSelect.append(option);
    });
};

const copyFromPost = (id) => {
    const source = posts.find((post) => post.id === Number(id));
    if (!source) return;
    if (editingPost && !window.confirm('編集中の投稿をやめて、過去の投稿を複製しますか？')) { templateSelect.value = ''; return; }
    editingPost = null;
    $('#post-title').value = source.title || '';
    $('#post-date').value = source.event_date || '';
    $('#post-category').value = source.category || 'WORKS';
    loadRoleAssignment(source);
    $('#post-venue').value = source.venue || '';
    $('#post-description').value = source.description || '';
    prepareNewSlug();
    publicationMode.value = 'draft';
    publishAtInput.value = '';
    flyerInput.value = '';
    setPreview('');
    formTitle.textContent = '過去の投稿を元に新しい実績を追加';
    cancelEdit.classList.remove('hidden');
    updatePublicationControls();
    setMessage(postStatus, '入力内容をコピーしました。開催日を確認し、新しいフライヤーを選択してから保存してください。');
    templateSelect.value = '';
    postForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
};

const renderPosts = () => {
    postList.replaceChildren();
    if (!posts.length) { postList.textContent = 'まだ登録された実績はありません。'; return; }
    posts.forEach((post) => {
        const row = document.createElement('article');
        row.className = 'post-row';
        const image = document.createElement('img');
        image.src = fileUrl(post.flyer_path);
        image.alt = post.flyer_alt || `${post.title}のフライヤー`;
        const body = document.createElement('div');
        const title = document.createElement('h3');
        title.textContent = post.title;
        const publication = getPublicationState(post);
        const status = document.createElement('span');
        status.className = `status status--${publication.className}`;
        status.textContent = publication.label;
        title.append(status);
        const meta = document.createElement('p');
        meta.className = 'post-meta';
        const metaItems = [post.category, formatDate(post.event_date), post.venue].filter(Boolean);
        if (publication.className === 'scheduled') metaItems.push(`公開予定：${formatDateTime(post.publish_at)}`);
        meta.textContent = metaItems.join(' ｜ ');
        body.append(title);
        getRoleTypes(post).forEach((roleType) => {
            if (!roleLabels[roleType]) return;
            const role = document.createElement('p');
            role.className = 'post-role';
            role.textContent = roleLabels[roleType];
            body.append(role);
        });
        const operationArtists = post.operation_artists || (getRoleTypes(post).includes('artist_pa_operation') ? post.artists : null);
        const supportArtists = post.support_artists || (getRoleTypes(post).includes('local_technical_support') ? post.artists : null);
        if (operationArtists) {
            const artists = document.createElement('p');
            artists.className = 'post-artists';
            artists.textContent = `OPERATION：${operationArtists}`;
            body.append(artists);
        }
        if (supportArtists) {
            const artists = document.createElement('p');
            artists.className = 'post-artists';
            artists.textContent = `SUPPORT：${supportArtists}`;
            body.append(artists);
        }
        if (!operationArtists && !supportArtists && post.artists) {
            const artists = document.createElement('p');
            artists.className = 'post-artists';
            artists.textContent = `担当アーティスト：${post.artists}`;
            body.append(artists);
        }
        body.append(meta);
        if (post.slug) {
            const publicUrl = document.createElement('p');
            publicUrl.className = 'post-meta';
            const publicLink = document.createElement('a');
            publicLink.href = workUrl(post.slug);
            publicLink.target = '_blank';
            publicLink.rel = 'noopener';
            publicLink.textContent = workUrl(post.slug);
            publicUrl.append(publicLink);
            body.append(publicUrl);
        }
        const actions = document.createElement('div');
        actions.className = 'post-actions';
        const edit = document.createElement('button');
        edit.className = 'button button--secondary'; edit.type = 'button'; edit.textContent = '編集';
        edit.addEventListener('click', () => beginEdit(post.id));
        const remove = document.createElement('button');
        remove.className = 'button button--danger'; remove.type = 'button'; remove.textContent = '削除';
        remove.addEventListener('click', () => deletePost(post.id));
        actions.append(edit, remove);
        row.append(image, body, actions);
        postList.append(row);
    });
};

const loadPosts = async () => {
    const { data, error } = await supabase.from('work_posts').select('*').order('event_date', { ascending: false, nullsFirst: false }).order('created_at', { ascending: false });
    if (error) { setMessage(postStatus, '投稿一覧を読み込めませんでした。設定を確認してください。', 'error'); return; }
    posts = data || [];
    populateHistories();
    renderPosts();
};

const beginEdit = (id) => {
    editingPost = posts.find((post) => post.id === id);
    if (!editingPost) return;
    $('#post-title').value = editingPost.title;
    $('#post-date').value = editingPost.event_date || '';
    $('#post-category').value = editingPost.category || 'WORKS';
    loadRoleAssignment(editingPost);
    $('#post-venue').value = editingPost.venue || '';
    $('#post-description').value = editingPost.description || '';
    prepareExistingSlug(editingPost.slug);
    publicationMode.value = !editingPost.is_published ? 'draft' : (editingPost.publish_at && new Date(editingPost.publish_at).getTime() > Date.now() ? 'scheduled' : 'now');
    publishAtInput.value = toLocalDateTimeInput(editingPost.publish_at);
    templateSelect.value = '';
    setPreview(fileUrl(editingPost.flyer_path));
    formTitle.textContent = '実績を編集';
    cancelEdit.classList.remove('hidden');
    clearMessage(postStatus);
    updatePublicationControls();
    postForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
};

const deletePost = async (id) => {
    const post = posts.find((item) => item.id === id);
    if (!post || !window.confirm(`「${post.title}」を削除しますか？`)) return;
    const { error } = await supabase.from('work_posts').delete().eq('id', id);
    if (error) { setMessage(postStatus, '削除できませんでした。', 'error'); return; }
    await supabase.storage.from(WORKS_BUCKET).remove([post.flyer_path]);
    if (editingPost?.id === id) resetPostForm();
    await loadPosts();
};

const showDashboard = async (user) => {
    loginPanel.classList.add('hidden');
    dashboard.classList.remove('hidden');
    $('#session-email').textContent = user.email || '';
    await loadPosts();
};

const restoreSession = async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.user) return;
    if (await isAdmin(session.user)) await showDashboard(session.user);
    else await supabase.auth.signOut();
};

if (!isSupabaseConfigured) {
    configMessage.classList.remove('hidden');
    configMessage.className = 'card alert alert--info';
    configMessage.textContent = '管理画面を有効にする準備中です。Supabaseの接続情報を設定するとログイン・投稿が利用できます。';
    loginPanel.classList.add('hidden');
} else {
    supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    updateRoleFields();
    prepareNewSlug();
    restoreSession();

    loginForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        clearMessage(loginStatus);
        const submit = loginForm.querySelector('button[type="submit"]');
        submit.disabled = true;
        const { data, error } = await supabase.auth.signInWithPassword({ email: $('#login-email').value.trim(), password: $('#login-password').value });
        submit.disabled = false;
        if (error || !data.user) { setMessage(loginStatus, 'メールアドレスまたはパスワードを確認してください。', 'error'); return; }
        if (!await isAdmin(data.user)) { await supabase.auth.signOut(); setMessage(loginStatus, 'このアカウントには管理権限がありません。', 'error'); return; }
        await showDashboard(data.user);
    });

    flyerInput.addEventListener('change', () => {
        const file = flyerInput.files?.[0];
        setPreview(file ? URL.createObjectURL(file) : editingPost ? fileUrl(editingPost.flyer_path) : '');
    });

    templateSelect.addEventListener('change', () => copyFromPost(templateSelect.value));
    $('#post-title').addEventListener('input', refreshGeneratedSlug);
    $('#post-date').addEventListener('input', refreshGeneratedSlug);
    $('#post-category').addEventListener('change', refreshGeneratedSlug);
    slugInput.addEventListener('input', () => {
        slugWasEdited = true;
        updateSlugPreview();
    });
    slugInput.addEventListener('blur', () => {
        slugInput.value = normalizeSlug(slugInput.value);
        updateSlugPreview();
    });
    unlockSlugButton.addEventListener('click', () => {
        if (!editingPost || !window.confirm('公開URLを変更すると、現在のURLは使えなくなります。変更しますか？')) return;
        slugInput.readOnly = false;
        slugWasEdited = true;
        unlockSlugButton.classList.add('hidden');
        slugInput.focus();
    });
    operationRoleInput.addEventListener('change', updateRoleFields);
    supportRoleInput.addEventListener('change', updateRoleFields);
    publicationMode.addEventListener('change', updatePublicationControls);
    publishAtInput.addEventListener('input', updateSaveButton);

    postForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        clearMessage(postStatus);
        const file = flyerInput.files?.[0];
        const title = $('#post-title').value.trim();
        if (!title) { setMessage(postStatus, 'イベント名を入力してください。', 'error'); return; }
        if (!editingPost && !file) { setMessage(postStatus, 'フライヤー画像を選択してください。', 'error'); return; }
        if (publicationMode.value === 'scheduled' && !publishAtInput.value) {
            setMessage(postStatus, '予約投稿では、公開日時を入力してください。', 'error');
            return;
        }
        if (publicationMode.value === 'scheduled' && new Date(publishAtInput.value).getTime() <= Date.now()) {
            setMessage(postStatus, '予約投稿の公開日時は、現在より未来の日時を指定してください。', 'error');
            return;
        }
        saveButton.disabled = true;
        let uploadedFlyerPath = null;
        try {
            const normalizedSlug = normalizeSlug(slugInput.value || generatedSlug());
            if (!hasValidSlug(normalizedSlug)) throw new Error('公開URLは半角小文字・数字・ハイフンだけで入力してください。');
            const slug = !editingPost && !slugWasEdited
                ? await findUniqueSlug(normalizedSlug)
                : await findUniqueSlug(normalizedSlug, editingPost?.id || null);
            if ((editingPost || slugWasEdited) && slug !== normalizedSlug) {
                throw new Error('この公開URLはすでに使用されています。別のURLを入力してください。');
            }
            slugInput.value = slug;
            updateSlugPreview();

            uploadedFlyerPath = file ? await uploadFlyer(file) : null;
            const flyerPath = uploadedFlyerPath || editingPost.flyer_path;
            const isPublished = publicationMode.value !== 'draft';
            const roleTypes = [operationRoleInput.checked ? 'artist_pa_operation' : null, supportRoleInput.checked ? 'local_technical_support' : null].filter(Boolean);
            const operationArtists = operationRoleInput.checked ? operationArtistsInput.value.trim() || null : null;
            const supportArtists = supportRoleInput.checked ? supportArtistsInput.value.trim() || null : null;
            const payload = {
                title, slug, event_date: $('#post-date').value || null, category: $('#post-category').value,
                role_type: roleTypes.length === 1 ? roleTypes[0] : null, role_types: roleTypes,
                operation_artists: operationArtists, support_artists: supportArtists, artists: operationArtists || supportArtists,
                venue: $('#post-venue').value.trim() || null,
                description: $('#post-description').value.trim() || null, flyer_path: flyerPath,
                flyer_alt: `${title}のフライヤー`, is_published: isPublished,
                publish_at: publicationMode.value === 'scheduled' ? toIsoDateTime(publishAtInput.value) : null
            };
            const result = editingPost
                ? await supabase.from('work_posts').update(payload).eq('id', editingPost.id).select('id, slug').single()
                : await supabase.from('work_posts').insert(payload).select('id, slug').single();
            if (result.error) throw result.error;
            if (file && editingPost?.flyer_path) await supabase.storage.from(WORKS_BUCKET).remove([editingPost.flyer_path]);
            const publication = getPublicationState(payload);
            const savedUrl = workUrl(result.data.slug);
            resetPostForm();
            await loadPosts();
            setMessage(postStatus, publication.className === 'scheduled'
                ? `予約投稿を保存しました。公開後のURL：${savedUrl}`
                : publication.className === 'draft'
                    ? `下書きを保存しました。公開後のURL：${savedUrl}`
                    : `保存しました。公開URL：${savedUrl}`);
        } catch (error) {
            if (uploadedFlyerPath) await supabase.storage.from(WORKS_BUCKET).remove([uploadedFlyerPath]);
            const message = error.code === '23505' ? 'この公開URLはすでに使用されています。別のURLを入力してください。' : error.message;
            setMessage(postStatus, message || '保存できませんでした。', 'error');
        } finally { saveButton.disabled = false; }
    });

    cancelEdit.addEventListener('click', resetPostForm);
    $('#sign-out').addEventListener('click', async () => { await supabase.auth.signOut(); location.reload(); });
}
