import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_ANON_KEY, SUPABASE_URL, WORKS_BUCKET, isSupabaseConfigured } from './supabase-config.js';

const grid = document.querySelector('#latest-works');
const emptyState = document.querySelector('#latest-empty');
const yearTabs = document.querySelector('#works-year-tabs');
const latestTitle = document.querySelector('#latest-title');

const roleLabels = {
    artist_pa_operation: 'ARTIST PA OPERATION',
    local_technical_support: 'LOCAL TECHNICAL SUPPORT'
};

const getRoleTypes = (post) => Array.isArray(post.role_types) && post.role_types.length ? post.role_types : (post.role_type ? [post.role_type] : []);
const publicWorkUrl = (post) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(post.slug || '')
    ? `/works/${post.slug}.html`
    : '/works.html';
const workImageSizes = [
    '(min-width: 1400px) 245px',
    '(min-width: 1200px) 209px',
    '(min-width: 992px) 221px',
    '(min-width: 768px) 220px',
    '(min-width: 576px) 249px',
    '(min-width: 460px) calc(50vw - 21px)',
    'calc(100vw - 24px)'
].join(', ');
const initialRowCount = () => {
    if (matchMedia('(min-width: 1200px)').matches) return 5;
    if (matchMedia('(min-width: 992px)').matches) return 4;
    if (matchMedia('(min-width: 768px)').matches) return 3;
    if (matchMedia('(min-width: 460px)').matches) return 2;
    return 1;
};

if (grid && emptyState && isSupabaseConfigured) {
    // 管理画面へログイン済みの同じブラウザでも、公開WORKSは常に匿名閲覧として扱う。
    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
    });

    const formatDate = (date) => {
        if (!date) return '';
        return new Intl.DateTimeFormat('ja-JP', { year: 'numeric', month: 'long', day: 'numeric' }).format(new Date(`${date}T00:00:00`));
    };

    const createArtistLine = (label, value) => {
        const artists = document.createElement('p');
        artists.className = 'work-card__artist';
        artists.textContent = `${label}：${value}`;
        return artists;
    };

    const publicFlyerUrl = (path) => supabase.storage.from(WORKS_BUCKET).getPublicUrl(path).data.publicUrl;
    const publicFlyerThumbnailUrl = (path, width) => {
        const url = new URL(publicFlyerUrl(path));
        url.pathname = url.pathname.replace('/storage/v1/object/public/', '/storage/v1/render/image/public/');
        url.searchParams.set('width', String(width));
        url.searchParams.set('quality', '66');
        url.searchParams.set('resize', 'contain');
        return url.href;
    };

    const createCard = (post, index, eagerCount) => {
        const card = document.createElement('a');
        card.className = 'work-card work-card--link';
        card.href = publicWorkUrl(post);
        card.setAttribute('aria-label', `${post.title}の詳細を見る`);

        const originalImageUrl = publicFlyerUrl(post.flyer_path);
        const image = document.createElement('img');
        image.srcset = [320, 480, 640]
            .map((width) => `${publicFlyerThumbnailUrl(post.flyer_path, width)} ${width}w`)
            .join(', ');
        image.sizes = workImageSizes;
        image.src = publicFlyerThumbnailUrl(post.flyer_path, 480);
        image.alt = post.flyer_alt || `${post.title}のフライヤー`;
        image.width = 3;
        image.height = 4;
        image.loading = index < eagerCount ? 'eager' : 'lazy';
        image.decoding = index < eagerCount ? 'sync' : 'async';
        if (index === 0) image.fetchPriority = 'high';
        image.addEventListener('error', () => {
            image.removeAttribute('srcset');
            image.removeAttribute('sizes');
            image.src = originalImageUrl;
        }, { once: true });

        const body = document.createElement('div');
        body.className = 'work-card__body';
        const tag = document.createElement('span');
        tag.className = 'work-card__tag';
        tag.textContent = post.category || 'WORKS';
        body.append(tag);

        const roleTypes = getRoleTypes(post);
        roleTypes.forEach((roleType) => {
            if (!roleLabels[roleType]) return;
            const role = document.createElement('span');
            role.className = `work-card__role work-card__role--${roleType === 'artist_pa_operation' ? 'operation' : 'support'}`;
            role.textContent = roleLabels[roleType];
            body.append(role);
        });

        const title = document.createElement('h3');
        title.textContent = post.title;
        body.append(title);

        const meta = document.createElement('p');
        meta.className = 'work-card__meta';
        meta.textContent = formatDate(post.event_date);
        if (meta.textContent) body.append(meta);

        if (post.venue) {
            const venue = document.createElement('p');
            venue.className = 'work-card__venue';
            venue.textContent = post.venue;
            body.append(venue);
        }

        const operationArtists = post.operation_artists || (roleTypes.includes('artist_pa_operation') ? post.artists : null);
        const supportArtists = post.support_artists || (roleTypes.includes('local_technical_support') ? post.artists : null);
        if (operationArtists) body.append(createArtistLine('OPERATION', operationArtists));
        if (supportArtists) body.append(createArtistLine('SUPPORT', supportArtists));
        if (!operationArtists && !supportArtists && post.artists) body.append(createArtistLine('担当アーティスト', post.artists));

        if (post.description) {
            const description = document.createElement('p');
            description.className = 'mt-3';
            description.textContent = post.description;
            body.append(description);
        }

        const link = document.createElement('span');
        link.className = 'work-card__link';
        link.textContent = 'VIEW REPORT →';
        body.append(link);
        card.append(image, body);
        return card;
    };

    const queryWorks = (fields) => supabase
        .from('work_posts')
        .select(fields)
        .eq('is_published', true)
        .or(`publish_at.is.null,publish_at.lte.${new Date().toISOString()}`)
        .order('event_date', { ascending: false, nullsFirst: false })
        .order('created_at', { ascending: false })
        .order('id', { ascending: false });

    const getYear = (post) => String(post.event_date || '').match(/^(\d{4})-\d{2}-\d{2}$/)?.[1] || null;

    const renderWorks = (posts, selectedYear) => {
        grid.replaceChildren();
        const visiblePosts = selectedYear === 'undated' ? posts.filter((post) => !getYear(post)) : posts.filter((post) => getYear(post) === selectedYear);
        if (!visiblePosts.length) {
            emptyState.hidden = false;
            emptyState.innerHTML = '<strong>この年の実績は準備中です。</strong>新しい実績を順次掲載します。';
            return;
        }
        emptyState.hidden = true;
        const eagerCount = initialRowCount();
        visiblePosts.forEach((post, index) => grid.append(createCard(post, index, eagerCount)));
    };

    const renderYearTabs = (posts) => {
        const years = [...new Set(posts.map(getYear).filter(Boolean))].sort((a, b) => Number(b) - Number(a));
        const hasUndatedPosts = posts.some((post) => !getYear(post));
        const tabs = years.map((year) => ({ value: year, label: `${year}年` }));
        if (hasUndatedPosts) tabs.push({ value: 'undated', label: '日付未設定' });
        if (!tabs.length) return;

        const yearFromHash = () => {
            try { return decodeURIComponent(location.hash).match(/^#year-(\d{4})$/)?.[1] || null; }
            catch { return null; }
        };
        const requestedYear = yearFromHash();
        let selectedYear = tabs.some((tab) => tab.value === requestedYear) ? requestedYear : tabs[0].value;
        const buttons = new Map();
        const latestSection = latestTitle.closest('section');

        const updateSelectedYear = (year, { updateHash = false, scroll = false } = {}) => {
            if (!tabs.some((tab) => tab.value === year)) return;
            selectedYear = year;
            buttons.forEach((button, value) => button.setAttribute('aria-pressed', String(value === selectedYear)));
            const headingId = selectedYear === 'undated' ? 'year-undated' : `year-${selectedYear}`;
            latestTitle.id = headingId;
            latestSection?.setAttribute('aria-labelledby', headingId);
            latestTitle.textContent = selectedYear === 'undated' ? '開催日未設定の現場' : `${selectedYear}年の現場`;
            renderWorks(posts, selectedYear);
            if (updateHash && selectedYear !== 'undated') {
                history.replaceState(null, '', `${location.pathname}${location.search}#year-${selectedYear}`);
            }
            if (scroll) requestAnimationFrame(() => latestTitle.scrollIntoView({ block: 'start' }));
        };

        yearTabs.replaceChildren();
        tabs.forEach((tab) => {
            const button = document.createElement('button');
            button.className = 'year-tab';
            button.type = 'button';
            button.textContent = tab.label;
            button.setAttribute('aria-controls', 'latest-works');
            button.setAttribute('aria-label', `${tab.label}の実績を表示`);
            button.addEventListener('click', () => updateSelectedYear(tab.value, { updateHash: true }));
            buttons.set(tab.value, button);
            yearTabs.append(button);
        });

        updateSelectedYear(selectedYear, { scroll: Boolean(requestedYear) });
        window.addEventListener('hashchange', () => {
            const hashYear = yearFromHash();
            if (hashYear) updateSelectedYear(hashYear, { scroll: true });
        });
    };

    const loadWorks = async () => {
        const newFields = 'id, slug, title, category, role_type, role_types, event_date, venue, artists, operation_artists, support_artists, description, flyer_path, flyer_alt';
        const legacyFields = 'id, title, category, role_type, event_date, venue, artists, description, flyer_path, flyer_alt';
        let { data, error } = await queryWorks(newFields);
        if (error) ({ data, error } = await queryWorks(legacyFields));
        if (error || !data?.length) return;
        renderYearTabs(data);
    };

    loadWorks();
}
