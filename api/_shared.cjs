const SITE_URL = 'https://ara-tech.cc';
const SUPABASE_URL = 'https://kogbnremsouajxxsgxro.supabase.co';
// This is Supabase's browser-safe publishable key. It is governed by RLS and is not a service-role secret.
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_nGgPKpwiePrFS_vH8lPpVg_0I1HGGaS';
const WORKS_BUCKET = 'work-flyers';
const flyerDimensions = require('./flyer-dimensions.json');

const WORK_FIELDS = [
    'id', 'slug', 'title', 'category', 'role_type', 'role_types', 'event_date', 'venue',
    'artists', 'operation_artists', 'support_artists', 'description', 'flyer_path',
    'flyer_alt', 'is_published', 'publish_at', 'created_at', 'updated_at'
].join(',');

const roleDetails = {
    artist_pa_operation: {
        label: 'ARTIST PA OPERATION',
        description: 'アーティストPA・音響オペレート',
        artistLabel: '担当対象'
    },
    local_technical_support: {
        label: 'LOCAL TECHNICAL SUPPORT',
        description: '乗り込みPA対応・現場技術サポート',
        artistLabel: '対応対象'
    }
};

const fallbackWorks = [
    ['2026-exwhyz-last-tour-dance-your-dance-1', '2026-07-14T17:29:15.271791+00:00'],
    ['2026-envii-gabriella-special-live-talk-vol-41-in-2', '2026-07-14T17:29:15.271791+00:00'],
    ['2026-jam-massive-30th-anniversary-vol-1-3', '2026-07-14T17:29:15.271791+00:00'],
    ['2026-2nd-live-ikimaru-4', '2026-07-14T17:29:15.271791+00:00'],
    ['2026-quadrophenia-presents-vol-100-x-5', '2026-07-14T17:29:15.271791+00:00'],
    ['2026-yutori-oneman-tour-2026-bless-you-6', '2026-07-14T17:29:15.271791+00:00'],
    ['2026-the-ravens-live-tour-2026-7', '2026-07-14T17:29:15.271791+00:00'],
    ['2026-spring-live-8', '2026-07-14T17:29:15.271791+00:00'],
    ['2026-finlands-tour-9', '2026-07-14T17:29:15.271791+00:00'],
    ['2026-blue-mash-10', '2026-07-14T17:29:15.271791+00:00'],
    ['2026-back-beat-presented-by-vocal-society-11', '2026-07-14T17:29:15.271791+00:00'],
    ['2026-x-pre-vol-3-12', '2026-07-14T17:29:15.271791+00:00'],
    ['2026-1-live-2-circle-sensation-13', '2026-07-15T11:13:41.705249+00:00'],
    ['2026-bye-bye-bye-14', '2026-07-14T17:29:15.271791+00:00'],
    ['2026-hbg-live-15', '2026-07-14T17:29:15.271791+00:00'],
    ['2026-kotori-pre-local-match-2026-16', '2026-07-14T17:29:15.271791+00:00'],
    ['2026-hello-ailly-1st-tour-2026-17', '2026-07-14T17:29:15.271791+00:00'],
    ['2026-one-man-live-tour-18', '2026-07-14T17:29:15.271791+00:00'],
    ['2026-work-life-balance-vol-5-burn-bright-19', '2026-07-14T17:29:15.271791+00:00'],
    ['2026-dannie-may-oneman-tour-meraki-20', '2026-07-14T17:29:15.271791+00:00'],
    ['2026-2026-21', '2026-07-14T17:29:15.271791+00:00'],
    ['2026-sonsi', '2026-07-14T17:29:15.271791+00:00'],
    ['2026-have-a-nice-trip-23', '2026-07-14T17:29:15.271791+00:00'],
    ['2025-teppan-mini-album-release-live-26', '2026-07-14T17:38:13.648882+00:00'],
    ['2025-christmas-party-27', '2026-07-14T17:39:56.99465+00:00'],
    ['2025-nee-10th-tour-exotic-mettya-saisei-28', '2026-07-14T17:41:55.5664+00:00'],
    ['2025-watwing-live-house-tour-2025-honest-29', '2026-07-14T17:43:45.713927+00:00'],
    ['2025-1-2025-2026-wasuta-made-2-2025-2026-wasuta-made-out-to-the-world-30', '2026-07-14T17:45:00.186613+00:00'],
    ['2025-special-others-tour-2025-31', '2026-07-14T17:47:16.812714+00:00'],
    ['2025-mooove-2nd-live-tour-2025-by-32', '2026-07-14T17:48:28.783798+00:00'],
    ['2025-the-yellow-monkey-respect-live-accel-33', '2026-07-14T17:50:46.866296+00:00'],
    ['2026-veretta-tour-at-club-l2-hiroshima-34', '2026-07-15T10:51:46.707438+00:00'],
    ['2026-gigs-case-of-hiroshima-vol-2-35', '2026-07-15T10:59:00.677423+00:00'],
    ['2026-hyakka-ryoran-vol-20', '2026-07-16T22:31:14.414895+00:00'],
    ['2026-works-38', '2026-07-16T22:35:50.371592+00:00'],
    ['2026-p-g-p-ill-lounge-a-night-with-party-gun-paul-39', '2026-07-18T17:31:52.105048+00:00']
].map(([slug, updated_at]) => ({ slug, updated_at }));

const escapeHtml = (value = '') => String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const safeJson = (value) => JSON.stringify(value).replace(/</g, '\\u003c');

const getRoleTypes = (post) => Array.isArray(post.role_types) && post.role_types.length
    ? post.role_types.filter((role) => roleDetails[role])
    : post.role_type && roleDetails[post.role_type] ? [post.role_type] : [];

const getWorkYear = (post) => String(post?.event_date || '').match(/^(\d{4})-\d{2}-\d{2}$/)?.[1] || '';

const getFlyerDimensions = (path) => {
    const [width, height] = flyerDimensions[String(path || '')] || [];
    return Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 ? { width, height } : null;
};

const isValidWorkSlug = (slug) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(slug || ''));

const formatDate = (date) => date
    ? new Intl.DateTimeFormat('ja-JP', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Asia/Tokyo' }).format(new Date(`${date}T00:00:00+09:00`))
    : '';

const publicFlyerUrl = (path) => {
    if (!path) return `${SITE_URL}/img/mr-1.jpg`;
    const encoded = String(path).split('/').map(encodeURIComponent).join('/');
    return `${SUPABASE_URL}/storage/v1/object/public/${WORKS_BUCKET}/${encoded}`;
};

const publicFlyerTransformedUrl = (path, width = 800, quality = 78) => {
    if (!path) return `${SITE_URL}/img/mr-1.jpg`;
    const encoded = String(path).split('/').map(encodeURIComponent).join('/');
    const safeWidth = Math.round(Math.min(1600, Math.max(160, Number(width) || 800)));
    const safeQuality = Math.round(Math.min(90, Math.max(50, Number(quality) || 78)));
    return `${SUPABASE_URL}/storage/v1/render/image/public/${WORKS_BUCKET}/${encoded}?width=${safeWidth}&quality=${safeQuality}&resize=contain`;
};

const publicFlyerThumbnailUrl = (path, width = 480) => publicFlyerTransformedUrl(path, width, 72);

const buildSummary = (post) => {
    if (post.description) return String(post.description).trim();
    const date = formatDate(post.event_date);
    const venue = post.venue ? String(post.venue).trim() : '';
    const whenWhere = date && venue ? `${date}、${venue}で開催された` : date ? `${date}に開催された` : venue ? `${venue}で開催された` : '';
    const displayedTitle = /[「『“"]/u.test(post.title) ? post.title : `「${post.title}」`;
    const lead = `${whenWhere ? `${whenWhere}` : ''}${displayedTitle}のARA-TECH実績です。`;
    const roles = getRoleTypes(post).map((role) => roleDetails[role].description);
    return roles.length ? `${lead}担当：${roles.join('、')}。` : lead;
};

const fetchWorks = async ({ id, slug, sitemap = false } = {}) => {
    const endpoint = new URL(`${SUPABASE_URL}/rest/v1/work_posts`);
    endpoint.searchParams.set('select', sitemap ? 'slug,updated_at' : WORK_FIELDS);
    endpoint.searchParams.set('is_published', 'eq.true');
    endpoint.searchParams.set('or', `(publish_at.is.null,publish_at.lte.${new Date().toISOString()})`);
    if (id) endpoint.searchParams.set('id', `eq.${id}`);
    if (slug) endpoint.searchParams.set('slug', `eq.${slug}`);
    if (!id && !slug) endpoint.searchParams.set('order', 'event_date.desc.nullslast,created_at.desc,id.desc');
    if (id || slug) endpoint.searchParams.set('limit', '1');
    const response = await fetch(endpoint, {
        headers: {
            apikey: SUPABASE_PUBLISHABLE_KEY,
            authorization: `Bearer ${SUPABASE_PUBLISHABLE_KEY}`,
            accept: 'application/json'
        }
    });
    if (!response.ok) throw new Error(`Supabase returned ${response.status}`);
    return response.json();
};

module.exports = {
    SITE_URL,
    buildSummary,
    escapeHtml,
    fallbackWorks,
    fetchWorks,
    formatDate,
    getRoleTypes,
    getFlyerDimensions,
    getWorkYear,
    isValidWorkSlug,
    publicFlyerTransformedUrl,
    publicFlyerThumbnailUrl,
    publicFlyerUrl,
    roleDetails,
    safeJson
};
