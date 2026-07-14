import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_ANON_KEY, SUPABASE_URL, WORKS_BUCKET, isSupabaseConfigured } from './supabase-config.js';

const grid = document.querySelector('#latest-works');
const emptyState = document.querySelector('#latest-empty');

if (grid && emptyState && isSupabaseConfigured) {
    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

    const formatDate = (date) => {
        if (!date) return '';
        return new Intl.DateTimeFormat('ja-JP', { year: 'numeric', month: 'long', day: 'numeric' }).format(new Date(`${date}T00:00:00`));
    };

    const createCard = (post) => {
        const card = document.createElement('article');
        card.className = 'work-card';

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

        const description = document.createElement('p');
        description.className = 'mt-3';
        description.textContent = post.description;

        body.append(tag, title);
        if (meta.textContent) body.append(meta);
        if (post.description) body.append(description);
        card.append(image, body);
        return card;
    };

    const loadWorks = async () => {
        const { data, error } = await supabase
            .from('work_posts')
            .select('id, title, category, event_date, venue, description, flyer_path, flyer_alt')
            .eq('is_published', true)
            .order('event_date', { ascending: false, nullsFirst: false })
            .order('created_at', { ascending: false });

        if (error || !data?.length) return;
        emptyState.hidden = true;
        data.forEach((post) => grid.append(createCard(post)));
    };

    loadWorks();
}
