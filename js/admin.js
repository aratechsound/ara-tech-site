import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_ANON_KEY, SUPABASE_URL, WORKS_BUCKET, isSupabaseConfigured } from './supabase-config.js';
import {
    getAssignmentItemLabels,
    getServicePlanLabel,
    isAllowedWorkCategory,
    normalizeAssignmentItems,
    normalizeServicePlan
} from './work-taxonomy.mjs';

const $ = (selector) => document.querySelector(selector);
const configMessage = $('#config-message');
const loginPanel = $('#login-panel');
const dashboard = $('#dashboard');
const loginForm = $('#login-form');
const loginStatus = $('#login-status');
const postForm = $('#post-form');
const postStatus = $('#post-status');
const postList = $('#admin-posts');
const pendingList = $('#pending-posts');
const pendingCount = $('#pending-count');
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
const servicePlanInput = $('#post-service-plan');
const participantGroupsInput = $('#post-participant-groups');
const systemSetupInput = $('#post-system-setup');
const lifecycleStatusInput = $('#post-lifecycle-status');
const performerNameInput = $('#post-performer-name');
const areaInput = $('#post-area');
const venueAddressInput = $('#post-venue-address');
const organizerNameInput = $('#post-organizer-name');
const officialAnnouncementUrlInput = $('#post-official-announcement-url');
const announcementConfirmedOnInput = $('#post-announcement-confirmed-on');
const flyerAltInput = $('#post-flyer-alt');
const openTimeInput = $('#post-open-time');
const startTimeInput = $('#post-start-time');
const seoTitleInput = $('#post-seo-title');
const metaDescriptionInput = $('#post-meta-description');
const reviewImageUrlInput = $('#post-review-image-url');
const reviewImageMethodInput = $('#post-review-image-method');
const reviewImagePreview = $('#review-image-preview');
const imageUsageStatusInput = $('#post-image-usage-status');
const usePublicImageInput = $('#post-use-public-image');
const publicationModeField = $('#publication-mode-field');
const candidateContext = $('#candidate-context');
const candidateHash = $('#candidate-hash');
const candidateActions = $('#candidate-actions');
const previewCandidateButton = $('#preview-candidate');
const publishCandidateButton = $('#publish-candidate');
const rejectCandidateButton = $('#reject-candidate');
const previewDialog = $('#preview-dialog');
const previewFrame = $('#preview-frame');
const assignmentInputs = [...document.querySelectorAll('input[name="assignment-item"]')];

let supabase;
let posts = [];
let editingPost = null;
let slugWasEdited = false;
let candidateFormDirty = false;

const PENDING_STATUS = 'publication_pending_approval';
const isPendingCandidate = (post) => post?.publication_review_status === PENDING_STATUS && !post.is_published;
const toTimeInput = (value) => String(value || '').match(/^\d{2}:\d{2}/u)?.[0] || '';

const roleLabels = {
    artist_pa_operation: 'ARTIST PA OPERATION ｜ アーティストPA・音響オペレート',
    local_technical_support: 'LOCAL TECHNICAL SUPPORT ｜ 乗り込みPA対応・現場技術サポート'
};

const getRoleTypes = (post) => Array.isArray(post.role_types) && post.role_types.length ? post.role_types : (post.role_type ? [post.role_type] : []);
const getSelectedAssignmentItems = () => normalizeAssignmentItems(
    assignmentInputs.filter((input) => input.checked).map((input) => input.value)
);

const loadClassification = (post = {}) => {
    servicePlanInput.value = normalizeServicePlan(post.service_plan) || '';
    const selected = new Set(normalizeAssignmentItems(post.assignment_items));
    assignmentInputs.forEach((input) => { input.checked = selected.has(input.value); });
    participantGroupsInput.value = post.participant_groups || '';
    systemSetupInput.value = post.system_setup || '';
};

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

const fileUrl = (path) => path ? supabase.storage.from(WORKS_BUCKET).getPublicUrl(path).data.publicUrl : '';

const getPublicationState = (post) => {
    if (!post.is_published) return { className: 'draft', label: '下書き' };
    if (post.publish_at && new Date(post.publish_at).getTime() > Date.now()) return { className: 'scheduled', label: '予約中' };
    return { className: 'published', label: '公開中' };
};

const getLifecycleState = (post) => post.lifecycle_status === 'upcoming'
    ? { className: 'upcoming', label: '開催予定' }
    : { className: 'published', label: '終了済み' };

const updateSaveButton = () => {
    if (isPendingCandidate(editingPost)) { saveButton.textContent = '公開待ちを保存'; return; }
    if (editingPost) { saveButton.textContent = '変更を保存'; return; }
    if (publicationMode.value === 'scheduled') { saveButton.textContent = '予約して保存'; return; }
    if (publicationMode.value === 'now') { saveButton.textContent = '公開して保存'; return; }
    saveButton.textContent = '下書き保存';
};

const updatePublicationControls = () => {
    const candidate = isPendingCandidate(editingPost);
    publicationModeField.classList.toggle('hidden', candidate);
    publicationMode.disabled = candidate;
    lifecycleStatusInput.disabled = candidate;
    candidateContext.classList.toggle('hidden', !candidate);
    candidateActions.classList.toggle('hidden', !candidate);
    if (candidate) {
        publicationMode.value = 'draft';
        lifecycleStatusInput.value = 'upcoming';
        candidateHash.textContent = `候補ハッシュ：${editingPost.candidate_hash || '再読み込みが必要です'}`;
    } else {
        candidateHash.textContent = '';
    }
    const isScheduled = !candidate && publicationMode.value === 'scheduled';
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
    candidateFormDirty = false;
    postForm.reset();
    $('#post-category').value = '';
    loadClassification();
    operationRoleInput.checked = false;
    supportRoleInput.checked = false;
    updateRoleFields();
    publicationMode.value = 'draft';
    publicationMode.disabled = false;
    lifecycleStatusInput.disabled = false;
    templateSelect.value = '';
    updatePublicationControls();
    prepareNewSlug();
    flyerPreview.removeAttribute('src');
    flyerPreview.classList.add('hidden');
    reviewImagePreview.removeAttribute('src');
    reviewImagePreview.classList.add('hidden');
    formTitle.textContent = '新しい掲載ページを追加';
    cancelEdit.classList.add('hidden');
    clearMessage(postStatus);
    updateSaveButton();
};

const setPreview = (source) => {
    if (!source) { flyerPreview.removeAttribute('src'); flyerPreview.classList.add('hidden'); return; }
    flyerPreview.src = source;
    flyerPreview.classList.remove('hidden');
};

const setReviewImagePreview = (source) => {
    if (!source) {
        reviewImagePreview.removeAttribute('src');
        reviewImagePreview.classList.add('hidden');
        return;
    }
    reviewImagePreview.src = source;
    reviewImagePreview.classList.remove('hidden');
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
    posts.filter((post) => !isPendingCandidate(post)).forEach((post) => {
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
    openTimeInput.value = toTimeInput(source.open_time);
    startTimeInput.value = toTimeInput(source.start_time);
    lifecycleStatusInput.value = source.lifecycle_status === 'upcoming' ? 'upcoming' : 'completed';
    $('#post-category').value = source.category || 'WORKS';
    loadClassification(source);
    loadRoleAssignment(source);
    $('#post-venue').value = source.venue || '';
    performerNameInput.value = source.performer_name || '';
    areaInput.value = source.area || '';
    venueAddressInput.value = source.venue_address || '';
    organizerNameInput.value = source.organizer_name || '';
    officialAnnouncementUrlInput.value = source.official_announcement_url || '';
    announcementConfirmedOnInput.value = source.announcement_confirmed_on || '';
    $('#post-description').value = source.description || '';
    flyerAltInput.value = source.flyer_alt || '';
    seoTitleInput.value = '';
    metaDescriptionInput.value = '';
    reviewImageUrlInput.value = '';
    reviewImageMethodInput.value = '';
    imageUsageStatusInput.value = 'unknown';
    usePublicImageInput.checked = false;
    setReviewImagePreview('');
    prepareNewSlug();
    publicationMode.value = 'draft';
    publishAtInput.value = '';
    flyerInput.value = '';
    setPreview('');
    formTitle.textContent = '過去の投稿を元に新しい掲載ページを追加';
    cancelEdit.classList.remove('hidden');
    updatePublicationControls();
    setMessage(postStatus, '入力内容をコピーしました。開催日を確認し、新しいフライヤーを選択してから保存してください。');
    templateSelect.value = '';
    postForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
};

const imageUsageLabel = (value) => ({
    confirmed: { label: '画像利用確認済み', className: 'confirmed' },
    not_permitted: { label: '公開画像に使用しない', className: 'not-permitted' },
    unknown: { label: '画像利用未確認', className: 'unknown' }
}[value] || { label: '画像利用未確認', className: 'unknown' });

const renderPendingPosts = () => {
    pendingList.replaceChildren();
    const candidates = posts.filter(isPendingCandidate)
        .sort((left, right) => String(left.event_date || '').localeCompare(String(right.event_date || '')));
    pendingCount.textContent = `${candidates.length}件`;
    if (!candidates.length) {
        pendingList.textContent = '現在、公開待ちの候補はありません。';
        return;
    }
    candidates.forEach((post) => {
        const row = document.createElement('article');
        row.className = 'pending-row';
        const image = document.createElement('img');
        const reviewImage = post.review_image_url || (post.flyer_path ? fileUrl(post.flyer_path) : '');
        if (reviewImage) {
            image.src = reviewImage;
            image.alt = post.flyer_alt || `${post.title}の確認用フライヤー`;
        } else {
            image.src = 'img/cta-bg.jpg';
            image.alt = '確認用画像なし';
        }
        const body = document.createElement('div');
        const title = document.createElement('h3');
        title.textContent = post.title;
        const status = document.createElement('span');
        status.className = 'status status--pending';
        status.textContent = '公開待ち';
        title.append(status);
        const usage = imageUsageLabel(post.image_usage_status);
        const usageBadge = document.createElement('span');
        usageBadge.className = `status status--${usage.className}`;
        usageBadge.textContent = usage.label;
        title.append(usageBadge);
        const performer = document.createElement('p');
        performer.className = 'pending-meta';
        performer.textContent = `アーティスト：${post.performer_name || '未設定'}`;
        const assignmentLabels = getAssignmentItemLabels(post.assignment_items);
        const meta = document.createElement('p');
        meta.className = 'pending-meta';
        meta.textContent = [formatDate(post.event_date), post.venue, assignmentLabels.length ? assignmentLabels.join('、') : '担当未設定'].filter(Boolean).join(' ｜ ');
        const imageState = document.createElement('p');
        imageState.className = 'pending-meta';
        imageState.textContent = `${reviewImage ? '確認用画像あり' : '確認用画像なし'} ｜ 公開画像：${post.use_image_on_public_page ? 'ON' : 'OFF'}`;
        const source = document.createElement('a');
        source.className = 'pending-source';
        source.href = post.official_announcement_url;
        source.target = '_blank';
        source.rel = 'external noopener noreferrer';
        source.textContent = `公式情報元：${post.official_announcement_url || '未設定'}`;
        body.append(title, performer, meta, imageState, source);
        const actions = document.createElement('div');
        actions.className = 'pending-actions';
        const preview = document.createElement('button');
        preview.className = 'button button--secondary'; preview.type = 'button'; preview.textContent = 'プレビュー';
        preview.addEventListener('click', () => previewPendingCandidate(post.id));
        const edit = document.createElement('button');
        edit.className = 'button button--secondary'; edit.type = 'button'; edit.textContent = '編集';
        edit.addEventListener('click', () => beginEdit(post.id));
        const publish = document.createElement('button');
        publish.className = 'button'; publish.type = 'button'; publish.textContent = '公開する';
        publish.addEventListener('click', () => publishPendingCandidate(post.id));
        actions.append(preview, edit, publish);
        row.append(image, body, actions);
        pendingList.append(row);
    });
};

const renderPosts = () => {
    postList.replaceChildren();
    const savedPosts = posts.filter((post) => !isPendingCandidate(post));
    if (!savedPosts.length) { postList.textContent = 'まだ登録された実績はありません。'; return; }
    savedPosts.forEach((post) => {
        const row = document.createElement('article');
        row.className = 'post-row';
        const image = post.flyer_path ? document.createElement('img') : document.createElement('div');
        if (post.flyer_path) {
            image.src = fileUrl(post.flyer_path);
            image.alt = post.flyer_alt || `${post.title}のフライヤー`;
        } else {
            image.className = 'post-image-placeholder';
            image.textContent = '画像なし';
        }
        const body = document.createElement('div');
        const title = document.createElement('h3');
        title.textContent = post.title;
        const publication = getPublicationState(post);
        const status = document.createElement('span');
        status.className = `status status--${publication.className}`;
        status.textContent = publication.label;
        title.append(status);
        const lifecycle = getLifecycleState(post);
        const lifecycleBadge = document.createElement('span');
        lifecycleBadge.className = `status status--${lifecycle.className}`;
        lifecycleBadge.textContent = lifecycle.label;
        title.append(lifecycleBadge);
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
        const servicePlanLabel = getServicePlanLabel(post.service_plan);
        if (servicePlanLabel) {
            const plan = document.createElement('p');
            plan.className = 'post-service';
            plan.textContent = `提供プラン：${servicePlanLabel}`;
            body.append(plan);
        }
        const assignmentLabels = getAssignmentItemLabels(post.assignment_items);
        if (assignmentLabels.length) {
            const assignments = document.createElement('p');
            assignments.className = 'post-service';
            assignments.textContent = `担当内容：${assignmentLabels.join('、')}`;
            body.append(assignments);
        }
        if (post.participant_groups) {
            const participants = document.createElement('p');
            participants.className = 'post-service';
            participants.textContent = `出演・参加団体：${post.participant_groups}`;
            body.append(participants);
        }
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
        actions.append(edit);
        if (!post.is_published) actions.append(remove);
        row.append(image, body, actions);
        postList.append(row);
    });
};

const loadPosts = async () => {
    const { data, error } = await supabase.from('work_posts').select('*').order('event_date', { ascending: false, nullsFirst: false }).order('created_at', { ascending: false });
    if (error) { setMessage(postStatus, '投稿一覧を読み込めませんでした。設定を確認してください。', 'error'); return; }
    posts = data || [];
    populateHistories();
    renderPendingPosts();
    renderPosts();
};

const beginEdit = (id) => {
    editingPost = posts.find((post) => post.id === id);
    if (!editingPost) return;
    candidateFormDirty = false;
    $('#post-title').value = editingPost.title;
    $('#post-date').value = editingPost.event_date || '';
    openTimeInput.value = toTimeInput(editingPost.open_time);
    startTimeInput.value = toTimeInput(editingPost.start_time);
    lifecycleStatusInput.value = editingPost.lifecycle_status === 'upcoming' ? 'upcoming' : 'completed';
    $('#post-category').value = editingPost.category || 'WORKS';
    loadClassification(editingPost);
    loadRoleAssignment(editingPost);
    $('#post-venue').value = editingPost.venue || '';
    performerNameInput.value = editingPost.performer_name || '';
    areaInput.value = editingPost.area || '';
    venueAddressInput.value = editingPost.venue_address || '';
    organizerNameInput.value = editingPost.organizer_name || '';
    officialAnnouncementUrlInput.value = editingPost.official_announcement_url || '';
    announcementConfirmedOnInput.value = editingPost.announcement_confirmed_on || '';
    $('#post-description').value = editingPost.description || '';
    flyerAltInput.value = editingPost.flyer_alt || '';
    seoTitleInput.value = editingPost.seo_title || '';
    metaDescriptionInput.value = editingPost.meta_description || '';
    reviewImageUrlInput.value = editingPost.review_image_url || '';
    reviewImageMethodInput.value = editingPost.review_image_acquisition_method || '';
    imageUsageStatusInput.value = editingPost.image_usage_status || 'unknown';
    usePublicImageInput.checked = editingPost.use_image_on_public_page === true;
    prepareExistingSlug(editingPost.slug);
    publicationMode.value = !editingPost.is_published ? 'draft' : (editingPost.publish_at && new Date(editingPost.publish_at).getTime() > Date.now() ? 'scheduled' : 'now');
    publishAtInput.value = toLocalDateTimeInput(editingPost.publish_at);
    templateSelect.value = '';
    setPreview(fileUrl(editingPost.flyer_path));
    setReviewImagePreview(editingPost.review_image_url || '');
    formTitle.textContent = isPendingCandidate(editingPost)
        ? '公開待ち候補を編集'
        : editingPost.lifecycle_status === 'upcoming' ? '開催予定を編集' : '実績を編集';
    cancelEdit.classList.remove('hidden');
    clearMessage(postStatus);
    updatePublicationControls();
    postForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
};

const deletePost = async (id) => {
    const post = posts.find((item) => item.id === id);
    if (post?.is_published) {
        setMessage(postStatus, '公開済み実績はこの画面から削除できません。必要な場合は状態を確認して別途対応してください。', 'error');
        return;
    }
    if (isPendingCandidate(post)) {
        await rejectPendingCandidate(id);
        return;
    }
    if (!post || !window.confirm(`「${post.title}」を削除しますか？`)) return;
    const { error } = await supabase.from('work_posts').delete().eq('id', id);
    if (error) { setMessage(postStatus, '削除できませんでした。', 'error'); return; }
    if (post.flyer_path) await supabase.storage.from(WORKS_BUCKET).remove([post.flyer_path]);
    if (editingPost?.id === id) resetPostForm();
    await loadPosts();
};

const previewPendingCandidate = async (id) => {
    const post = posts.find((item) => item.id === id);
    if (!isPendingCandidate(post)) return;
    if (editingPost?.id === id && candidateFormDirty) {
        setMessage(postStatus, '未保存の変更があります。先に「公開待ちを保存」を実行してからプレビューしてください。', 'error');
        return;
    }
    clearMessage(postStatus);
    try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session?.access_token) throw new Error('ログイン状態を確認できません。再ログインしてください。');
        const response = await fetch('/api/work-preview', {
            method: 'POST',
            headers: {
                authorization: `Bearer ${session.access_token}`,
                'content-type': 'application/json'
            },
            body: JSON.stringify({ id })
        });
        if (!response.ok) throw new Error('プレビューを生成できませんでした。保存状態とログイン状態を確認してください。');
        previewFrame.classList.remove('preview-frame--mobile');
        previewFrame.srcdoc = await response.text();
        previewDialog.showModal();
    } catch (error) {
        setMessage(postStatus, error.message || 'プレビューを表示できませんでした。', 'error');
    }
};

const publishResultMessage = (result) => ({
    candidate_changed: '候補が編集されています。最新内容を再読み込みしてから、もう一度確認してください。',
    validation_failed: '必須項目が不足しています。内容を編集・保存してから公開してください。',
    event_date_past: '開催日が過去になっています。終了済み実績として扱うか確認してください。',
    image_not_approved: '公開画像を使用するには、画像利用確認済み・公開画像ありの両方が必要です。',
    invalid_state: 'この候補は現在公開できない状態です。',
    not_authorized: '公開権限を確認できません。再ログインしてください。',
    not_found: '公開待ち候補が見つかりません。'
}[result] || '公開処理を完了できませんでした。');

const publishPendingCandidate = async (id) => {
    const post = posts.find((item) => item.id === id);
    if (!isPendingCandidate(post)) return;
    if (editingPost?.id === id && candidateFormDirty) {
        setMessage(postStatus, '未保存の変更があります。先に保存・プレビューしてから公開してください。', 'error');
        return;
    }
    const confirmation = `「${post.title}」を開催予定として公開します。よろしいですか？`;
    if (!window.confirm(confirmation)) return;
    clearMessage(postStatus);
    publishCandidateButton.disabled = true;
    try {
        const { data, error } = await supabase.rpc('publish_work_candidate', {
            p_work_id: post.id,
            p_candidate_hash: post.candidate_hash
        });
        if (error) throw error;
        const result = Array.isArray(data) ? data[0] : data;
        if (result?.result !== 'published') {
            await loadPosts();
            throw new Error(publishResultMessage(result?.result));
        }
        resetPostForm();
        await loadPosts();
        setMessage(postStatus, `公開しました：${workUrl(result.public_slug)}`);
    } catch (error) {
        setMessage(postStatus, error.message || '公開できませんでした。', 'error');
    } finally {
        publishCandidateButton.disabled = false;
    }
};

const rejectPendingCandidate = async (id) => {
    const post = posts.find((item) => item.id === id);
    if (!isPendingCandidate(post)) return;
    if (!window.confirm(`「${post.title}」を見送りますか？公開は行わず、既存の公開実績は削除しません。`)) return;
    clearMessage(postStatus);
    try {
        const { data, error } = await supabase.rpc('reject_work_candidate', { p_work_id: post.id });
        if (error) throw error;
        const result = Array.isArray(data) ? data[0] : data;
        if (result?.result !== 'rejected') throw new Error('見送り処理を完了できませんでした。');
        if (editingPost?.id === id) resetPostForm();
        await loadPosts();
        setMessage(postStatus, '候補を見送りました。本番公開は行っていません。');
    } catch (error) {
        setMessage(postStatus, error.message || '見送り処理に失敗しました。', 'error');
    }
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
    reviewImageUrlInput.addEventListener('input', () => setReviewImagePreview(reviewImageUrlInput.value.trim()));
    imageUsageStatusInput.addEventListener('change', () => {
        if (imageUsageStatusInput.value !== 'confirmed') usePublicImageInput.checked = false;
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
        if (!editingPost) return;
        const message = isPendingCandidate(editingPost)
            ? '公開前のURL案を変更しますか？変更後は候補ハッシュが更新されます。'
            : '公開URLを変更すると、現在のURLは使えなくなります。変更しますか？';
        if (!window.confirm(message)) return;
        slugInput.readOnly = false;
        slugWasEdited = true;
        unlockSlugButton.classList.add('hidden');
        slugInput.focus();
    });
    operationRoleInput.addEventListener('change', updateRoleFields);
    supportRoleInput.addEventListener('change', updateRoleFields);
    publicationMode.addEventListener('change', updatePublicationControls);
    publishAtInput.addEventListener('input', updateSaveButton);
    previewCandidateButton.addEventListener('click', () => editingPost && previewPendingCandidate(editingPost.id));
    publishCandidateButton.addEventListener('click', () => editingPost && publishPendingCandidate(editingPost.id));
    rejectCandidateButton.addEventListener('click', () => editingPost && rejectPendingCandidate(editingPost.id));
    $('#close-preview').addEventListener('click', () => previewDialog.close());
    $('#preview-desktop').addEventListener('click', () => previewFrame.classList.remove('preview-frame--mobile'));
    $('#preview-mobile').addEventListener('click', () => previewFrame.classList.add('preview-frame--mobile'));
    previewDialog.addEventListener('close', () => { previewFrame.srcdoc = ''; });
    postForm.addEventListener('input', () => {
        if (isPendingCandidate(editingPost)) candidateFormDirty = true;
    });
    postForm.addEventListener('change', () => {
        if (isPendingCandidate(editingPost)) candidateFormDirty = true;
    });

    postForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        clearMessage(postStatus);
        const file = flyerInput.files?.[0];
        const title = $('#post-title').value.trim();
        const category = $('#post-category').value;
        const pendingCandidate = isPendingCandidate(editingPost);
        if (!title) { setMessage(postStatus, 'イベント名を入力してください。', 'error'); return; }
        if (!isAllowedWorkCategory(category)) { setMessage(postStatus, '実績カテゴリーを選択してください。', 'error'); return; }
        const lifecycleStatus = lifecycleStatusInput.value === 'upcoming' ? 'upcoming' : 'completed';
        const isPublishing = !pendingCandidate && publicationMode.value !== 'draft';
        const reviewImageUrl = reviewImageUrlInput.value.trim();
        if (reviewImageUrl) {
            try {
                if (new URL(reviewImageUrl).protocol !== 'https:') throw new Error();
            } catch {
                setMessage(postStatus, '管理画面の確認用画像URLはHTTPSのURLを入力してください。', 'error');
                return;
            }
        }
        if (usePublicImageInput.checked && imageUsageStatusInput.value !== 'confirmed') {
            setMessage(postStatus, '公開ページで画像を使用する場合は、画像利用確認状態を「利用確認済み」にしてください。', 'error');
            return;
        }
        if (pendingCandidate && file && !usePublicImageInput.checked) {
            setMessage(postStatus, '選択したファイルは公開用画像です。公開しない場合はファイル選択を解除してください。', 'error');
            return;
        }
        if (pendingCandidate && usePublicImageInput.checked && !file && !editingPost?.flyer_path) {
            setMessage(postStatus, '公開ページで画像を使用するには、公開用フライヤー画像を選択してください。', 'error');
            return;
        }
        if (lifecycleStatus === 'upcoming' && isPublishing) {
            const officialUrl = officialAnnouncementUrlInput.value.trim();
            let officialUrlIsValid = false;
            try { officialUrlIsValid = new URL(officialUrl).protocol === 'https:'; } catch { officialUrlIsValid = false; }
            const hasAssignment = getSelectedAssignmentItems().length || operationRoleInput.checked || supportRoleInput.checked;
            if (!performerNameInput.value.trim() || !$('#post-date').value || !$('#post-venue').value.trim() || !areaInput.value.trim() || !hasAssignment || !announcementConfirmedOnInput.value || !officialUrlIsValid) {
                setMessage(postStatus, '開催予定を公開するには、アーティスト名またはイベント名・開催日・会場・地域・担当内容・HTTPSの公式告知URL・告知解禁確認日が必要です。', 'error');
                return;
            }
            const today = new Date();
            const todayText = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
            if (announcementConfirmedOnInput.value > todayText) {
                setMessage(postStatus, '告知解禁確認日に未来の日付は指定できません。', 'error');
                return;
            }
            if ($('#post-date').value < todayText) {
                setMessage(postStatus, '開催予定の開催日に過去の日付は指定できません。終了済みとして登録してください。', 'error');
                return;
            }
        }
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
            // The existing production schema stores "no public flyer" as an empty string
            // because flyer_path predates optional images and remains NOT NULL.
            const flyerPath = uploadedFlyerPath || editingPost?.flyer_path || '';
            const isPublished = !pendingCandidate && publicationMode.value !== 'draft';
            const roleTypes = [operationRoleInput.checked ? 'artist_pa_operation' : null, supportRoleInput.checked ? 'local_technical_support' : null].filter(Boolean);
            const operationArtists = operationRoleInput.checked ? operationArtistsInput.value.trim() || null : null;
            const supportArtists = supportRoleInput.checked ? supportArtistsInput.value.trim() || null : null;
            const assignmentItems = getSelectedAssignmentItems();
            const payload = {
                title, slug, event_date: $('#post-date').value || null, category,
                lifecycle_status: lifecycleStatus,
                open_time: openTimeInput.value || null,
                start_time: startTimeInput.value || null,
                performer_name: performerNameInput.value.trim() || null,
                area: areaInput.value.trim() || null,
                venue_address: venueAddressInput.value.trim() || null,
                organizer_name: organizerNameInput.value.trim() || null,
                official_announcement_url: officialAnnouncementUrlInput.value.trim() || null,
                announcement_confirmed_on: announcementConfirmedOnInput.value || null,
                service_plan: normalizeServicePlan(servicePlanInput.value),
                assignment_items: assignmentItems.length ? assignmentItems : null,
                participant_groups: participantGroupsInput.value.trim() || null,
                system_setup: systemSetupInput.value.trim() || null,
                role_type: roleTypes.length === 1 ? roleTypes[0] : null, role_types: roleTypes,
                operation_artists: operationArtists, support_artists: supportArtists, artists: operationArtists || supportArtists,
                venue: $('#post-venue').value.trim() || null,
                description: $('#post-description').value.trim() || null, flyer_path: flyerPath,
                flyer_alt: flyerAltInput.value.trim() || (flyerPath || reviewImageUrl ? `${title}のフライヤー` : null),
                review_image_url: reviewImageUrl || null,
                review_image_acquisition_method: reviewImageMethodInput.value.trim() || null,
                image_usage_status: imageUsageStatusInput.value || 'unknown',
                use_image_on_public_page: usePublicImageInput.checked,
                seo_title: seoTitleInput.value.trim() || null,
                meta_description: metaDescriptionInput.value.trim() || null,
                publication_review_status: pendingCandidate ? PENDING_STATUS : editingPost?.publication_review_status || null,
                is_published: isPublished,
                publish_at: !pendingCandidate && publicationMode.value === 'scheduled' ? toIsoDateTime(publishAtInput.value) : null
            };
            const result = editingPost
                ? await supabase.from('work_posts').update(payload).eq('id', editingPost.id).select('id, slug').single()
                : await supabase.from('work_posts').insert(payload).select('id, slug').single();
            if (result.error) throw result.error;
            if (file && editingPost?.flyer_path) await supabase.storage.from(WORKS_BUCKET).remove([editingPost.flyer_path]);
            const publication = getPublicationState(payload);
            const savedUrl = workUrl(result.data.slug);
            await loadPosts();
            if (pendingCandidate) beginEdit(result.data.id);
            else resetPostForm();
            setMessage(postStatus, publication.className === 'scheduled'
                ? `予約投稿を保存しました。公開後のURL：${savedUrl}`
                : publication.className === 'draft'
                    ? `${pendingCandidate ? '公開待ち候補' : '下書き'}を保存しました。公開後のURL：${savedUrl}`
                    : `保存しました。公開URL：${savedUrl}`);
        } catch (error) {
            if (uploadedFlyerPath) await supabase.storage.from(WORKS_BUCKET).remove([uploadedFlyerPath]);
            const message = error.code === '23505'
                ? 'この公開URLはすでに使用されています。別のURLを入力してください。'
                : error.code === '23514'
                    ? 'カテゴリー、提供プラン、担当内容、または機材構成の入力値を確認してください。'
                    : error.message;
            setMessage(postStatus, message || '保存できませんでした。', 'error');
        } finally { saveButton.disabled = false; }
    });

    cancelEdit.addEventListener('click', resetPostForm);
    $('#sign-out').addEventListener('click', async () => { await supabase.auth.signOut(); location.reload(); });
}
