import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_ANON_KEY, SUPABASE_URL, WORKS_BUCKET, isSupabaseConfigured } from './supabase-config.js';

const grid = document.querySelector('#latest-works');
const emptyState = document.querySelector('#latest-empty');

const roleLabels = {
    artist_pa_operation: 'ARTIST PA OPERATION',
    local_technical_support: 'LOCAL TECHNICAL SUPPORT'
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

    const createCard = (post) => {
        const card = document.createElement('a');
        card.className = 'work-card work-card--link';
        card.href = `work.html?id=${encodeURIComponent(post.id)}`;
        card.setAttribute('aria-label', `${post.title}の詳細を見る`);

        const image = document.createElement('img');
        image.src = supabase.storage.from(WORKS_BUCKET).getPublicUrl(post.flyer_path).data.publicUrl;
        image.alt = post.flyer_alt || `${post.title}のフライヤー`;
        image.loading = 'lazy';

        const body = document.createElement('div');
        body.className = 'work-card__body';

        const tag = document.createElement('span');
        tag.className = 'work-card__tag';
        tag.textContent = post.category || 'WORKS';

        const title = document.createElement('h3');
        title.textContent = post.title;

        const meta = document.createElement('p');
        meta.className = 'work-card__meta';
        meta.textContent = [formatDate(post.event_date), post.venue].filter(Boolean).join(' ｜ ');

        const artists = document.createElement('p');
        artists.className = 'work-card__artist';
        artists.textContent = `担当アーティスト：${post.artists}`;

        const description = document.createElement('p');
        description.className = 'mt-3';
        description.textContent = post.description;

        const link = document.createElement('span');
        link.className = 'work-card__link';
        link.textContent = 'VIEW REPORT →';

        body.append(tag);
        if (roleLabels[post.role_type]) {
            const role = document.createElement('span');
            role.className = `work-card__role work-card__role--${post.role_type === 'artist_pa_operation' ? 'operation' : 'support'}`;
            role.textContent = roleLabels[post.role_type];
            body.append(role);
        }
        body.append(title);
        if (meta.textContent) body.append(meta);
        if (post.artists) body.append(artists);
        if (post.description) body.append(description);
        body.append(link);
        card.append(image, body);
        return card;
    };

    const loadWorks = async () => {
        const { data, error } = await supabase
            .from('work_posts')
            .select('id, title, category, role_type, event_date, venue, artists, description, flyer_path, flyer_alt')
            .eq('is_published', true)
            .order('event_date', { ascending: false, nullsFirst: false })
            .order('created_at', { ascending: false });

        if (error || !data?.length) return;
        emptyState.hidden = true;
        data.forEach((post) => grid.append(createCard(post)));
    };

    loadWorks();
}
