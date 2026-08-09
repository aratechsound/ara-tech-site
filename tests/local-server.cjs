const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const workHandler = require('../api/work.js');
const sitemapHandler = require('../api/sitemap.js');
const { rows } = require('./fixtures.cjs');

const root = path.resolve(__dirname, '..');
const port = Number(process.env.NO001_PORT || 8765);
const originalFetch = global.fetch;
const upcomingPreview = {
    ...rows[0],
    id: 1000,
    slug: '2026-local-upcoming-preview',
    title: '【ローカル検証用・架空】SAMPLE LIVE 2026 広島公演',
    category: 'ライブ・アーティストPA',
    lifecycle_status: 'upcoming',
    performer_name: 'SAMPLE ARTIST',
    event_date: '2026-12-20',
    venue: '広島サンプルホール',
    area: '広島県広島市',
    venue_address: '広島県広島市中区サンプル1-2-3',
    organizer_name: 'サンプル主催者',
    official_announcement_url: 'https://example.com/events/sample-live',
    announcement_confirmed_on: '2026-08-10',
    assignment_items: ['sound_equipment', 'pa_operation'],
    description: null,
    flyer_path: null,
    flyer_alt: null,
    updated_at: '2026-08-10T00:00:00+00:00'
};
const localRows = [upcomingPreview, {
    ...rows[0],
    id: 999,
    slug: '2026-bozuyama-summer-night-preview',
    title: '【ローカル検証】坊主山サマーナイト2026｜お祭り音響・簡易照明',
    category: 'お祭り・地域イベント音響',
    service_plan: 'matsuri_pack',
    assignment_items: ['sound_equipment', 'load_in_setup_strike', 'simple_lighting', 'event_operation'],
    system_setup: 'スタンドスピーカーによる会場音響、LEDバーによる簡易照明',
    event_date: '2026-07-25',
    venue: '熊野坊主山商店街特設会場',
    role_type: null,
    role_types: [],
    artists: null,
    operation_artists: null,
    support_artists: null,
    description: 'Matsuri Packによる会場音響と簡易照明を担当。機材の搬入・設営から本番対応・撤去まで行いました。'
}, ...rows];

global.fetch = async (url, options) => {
    const parsed = new URL(url);
    if (!parsed.hostname.endsWith('.supabase.co')) return originalFetch(url, options);
    const idFilter = parsed.searchParams.get('id');
    const slugFilter = parsed.searchParams.get('slug');
    let result = localRows;
    if (idFilter) result = localRows.filter((row) => row.id === Number(idFilter.replace(/^eq\./, '')));
    if (slugFilter) result = localRows.filter((row) => row.slug === slugFilter.replace(/^eq\./, ''));
    if (parsed.searchParams.get('select') === 'slug,updated_at') result = result.map(({ slug, updated_at }) => ({ slug, updated_at }));
    return { ok: true, status: 200, json: async () => result };
};

const contentTypes = { '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon' };

const adapt = (response) => {
    response.status = (code) => { response.statusCode = code; return response; };
    response.send = (body) => { response.end(body); return response; };
    return response;
};

http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const workMatch = url.pathname.match(/^\/works\/([a-z0-9-]+)\.html$/);
    if (workMatch) return workHandler({ method: request.method, query: { slug: workMatch[1] } }, adapt(response));
    if (url.pathname === '/work.html') return workHandler({ method: request.method, query: { id: url.searchParams.get('id') } }, adapt(response));
    if (url.pathname === '/sitemap.xml') return sitemapHandler({ method: request.method, query: {} }, adapt(response));
    if (url.pathname === '/__admin-preview.html') {
        const html = fs.readFileSync(path.join(root, 'admin.html'), 'utf8')
            .replace('<section id="login-panel" class="card login-card">', '<section id="login-panel" class="card login-card hidden">')
            .replace('<section id="dashboard" class="hidden">', '<section id="dashboard">')
            .replace('<script type="module" src="js/admin.js"></script>', '');
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        return response.end(html);
    }
    if (url.pathname === '/__works-preview.html') {
        const previewCard = `<a class="work-card work-card--link" href="/works/${upcomingPreview.slug}.html" aria-label="${upcomingPreview.title}の詳細を見る"><div class="work-card__image-placeholder" aria-hidden="true">ARA-TECH</div><div class="work-card__body"><span class="work-card__status">開催予定</span><span class="work-card__tag">${upcomingPreview.category}</span><h3>${upcomingPreview.title}</h3><p class="work-card__meta">2026年12月20日</p><p class="work-card__venue">${upcomingPreview.venue}</p><p class="work-card__venue">${upcomingPreview.area}</p><p class="work-card__artist">ARTIST / EVENT：${upcomingPreview.performer_name}</p><span class="work-card__link">VIEW EVENT →</span></div></a>`;
        const html = fs.readFileSync(path.join(root, 'works.html'), 'utf8')
            .replace('<div id="upcoming-works" class="works-grid" aria-live="polite"></div>', `<div id="upcoming-works" class="works-grid" aria-live="polite">${previewCard}</div>`)
            .replace('<div id="upcoming-empty" class="notice">', '<div id="upcoming-empty" class="notice" hidden>')
            .replace('<script type="module" src="js/works.js"></script>', '');
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        return response.end(html);
    }

    const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.replace(/^\//, ''));
    const target = path.resolve(root, relative);
    if (!target.startsWith(`${root}${path.sep}`) || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
        response.statusCode = 404;
        return response.end('Not Found');
    }
    response.setHeader('Content-Type', contentTypes[path.extname(target).toLowerCase()] || 'application/octet-stream');
    fs.createReadStream(target).pipe(response);
}).listen(port, '127.0.0.1', () => console.log(`NO001 local server: http://127.0.0.1:${port}`));
