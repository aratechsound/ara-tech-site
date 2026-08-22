import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_ANON_KEY, SUPABASE_URL, WORKS_BUCKET, isSupabaseConfigured } from './supabase-config.js';
import { getServiceTypeLabels } from './work-taxonomy.mjs';

const grid = document.querySelector('#latest-works');
const emptyState = document.querySelector('#latest-empty');
const yearTabs = document.querySelector('#works-year-tabs');
const latestTitle = document.querySelector('#latest-title');
const upcomingGrid = document.querySelector('#upcoming-works');
const upcomingEmptyState = document.querySelector('#upcoming-empty');

const eventTypeFor = (post) => post.event_type || '';
const { isUpcomingWork, partitionWorksByLifecycle } = window.AraTechWorkLifecycle;
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
        const match = String(date || '').match(/^(\d{4})-(\d{2})-(\d{2})$/u);
        if (!match) return '';
        const [, year, month, day] = match;
        const value = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
        const weekdays = ['日', '月', '火', '水', '木', '金', '土'];
        return `${Number(year)}年${Number(month)}月${Number(day)}日(${weekdays[value.getUTCDay()]})`;
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

        let media;
        if (post.flyer_path && post.use_image_on_public_page !== false) {
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
            media = image;
        } else {
            const placeholder = document.createElement('div');
            placeholder.className = 'work-card__image-placeholder';
            placeholder.textContent = 'ARA-TECH';
            placeholder.setAttribute('aria-hidden', 'true');
            media = placeholder;
        }

        const body = document.createElement('div');
        body.className = 'work-card__body';
        if (isUpcomingWork(post)) {
            const status = document.createElement('span');
            status.className = 'work-card__status';
            status.textContent = '開催予定';
            body.append(status);
        }
        const classification = document.createElement('div');
        classification.className = 'work-card__classification';
        const eventType = eventTypeFor(post);
        const serviceLabels = getServiceTypeLabels(post.service_types);
        if (eventType) {
            const eventTypeLine = document.createElement('span');
            eventTypeLine.className = 'work-card__event-type';
            eventTypeLine.textContent = eventType;
            classification.append(eventTypeLine);
        }
        if (serviceLabels.length) {
            const services = document.createElement('span');
            services.className = 'work-card__services';
            serviceLabels.forEach((label) => {
                const service = document.createElement('span');
                service.className = 'work-card__service-badge';
                service.textContent = label;
                services.append(service);
            });
            classification.append(services);
        }
        if (classification.childElementCount) body.append(classification);

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

        if (post.area) {
            const area = document.createElement('p');
            area.className = 'work-card__venue';
            area.textContent = post.area;
            body.append(area);
        }

        if (post.performer_name) body.append(createArtistLine('ARTIST / EVENT', post.performer_name));

        const assignedArtists = post.operation_artists || post.artists || post.support_artists;
        if (assignedArtists) body.append(createArtistLine('担当アーティスト', assignedArtists));
        if (post.participant_groups) body.append(createArtistLine('出演・参加団体', post.participant_groups));

        const link = document.createElement('span');
        link.className = 'work-card__link';
        link.textContent = isUpcomingWork(post) ? 'VIEW EVENT →' : 'VIEW REPORT →';
        body.append(link);
        card.append(media, body);
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

    const renderUpcomingWorks = (posts) => {
        if (!upcomingGrid || !upcomingEmptyState) return;
        upcomingGrid.replaceChildren();
        if (!posts.length) {
            upcomingEmptyState.hidden = false;
            return;
        }
        upcomingEmptyState.hidden = true;
        const eagerCount = initialRowCount();
        posts.forEach((post, index) => upcomingGrid.append(createCard(post, index, eagerCount)));
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
        const newFields = 'id, slug, title, event_type, service_types, participant_groups, system_setup, event_date, open_time, start_time, venue, artists, operation_artists, support_artists, flyer_path, flyer_alt, lifecycle_status, performer_name, area, venue_address, organizer_name, official_announcement_url, announcement_confirmed_on, use_image_on_public_page';
        const legacyFields = 'id, slug, title, event_type, service_types, participant_groups, system_setup, event_date, venue, artists, operation_artists, support_artists, flyer_path, flyer_alt';
        let { data, error } = await queryWorks(newFields);
        const missingOptionalColumn = error
            && ['42703', 'PGRST204'].includes(error.code)
            && /event_type|service_types|participant_groups|system_setup|operation_artists|support_artists|lifecycle_status|performer_name|area|venue_address|organizer_name|official_announcement_url|announcement_confirmed_on|use_image_on_public_page/.test(error.message || '');
        if (missingOptionalColumn) ({ data, error } = await queryWorks(legacyFields));
        if (error || !data?.length) return;
        const { upcoming: upcomingPosts, completed: completedPosts } = partitionWorksByLifecycle(data);
        upcomingPosts.sort((left, right) => {
            const dateOrder = String(left.event_date || '').localeCompare(String(right.event_date || ''));
            if (dateOrder) return dateOrder;
            const timeOrder = String(left.open_time || left.start_time || '99:99').localeCompare(String(right.open_time || right.start_time || '99:99'));
            if (timeOrder) return timeOrder;
            return Number(left.id || 0) - Number(right.id || 0);
        });
        renderUpcomingWorks(upcomingPosts);
        renderYearTabs(completedPosts);
    };

    loadWorks();
}
