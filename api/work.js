const {
    SITE_URL,
    buildSummary,
    escapeHtml,
    fetchWorks,
    formatDate,
    getRoleTypes,
    publicFlyerUrl,
    roleDetails,
    safeJson
} = require('./_shared.cjs');

const getQueryValue = (request, key) => {
    const value = request.query?.[key];
    return Array.isArray(value) ? value[0] : value;
};

const truncate = (value, length) => {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    return text.length <= length ? text : `${text.slice(0, length - 1).trim()}…`;
};

const renderErrorPage = (status, heading, message) => `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex, follow"><title>${escapeHtml(heading)} | ARA-TECH</title>
<link rel="stylesheet" href="/work-detail.css"><link rel="icon" href="/img/favicon.ico"></head>
<body><main class="detail-shell"><section class="not-found"><p class="eyebrow">${status}</p><h1>${escapeHtml(heading)}</h1><p>${escapeHtml(message)}</p><a class="button" href="/works.html">実績一覧へ戻る</a></section></main></body></html>`;

const serviceFor = (post, roleTypes) => {
    if (post.category === 'STAGE PRODUCTION') return { href: '/stage-production.html', title: 'ステージ制作', text: 'ステージ制作サービスをご案内します。' };
    if (post.category === 'INSTALLATION') return { href: '/installation.html', title: '音響・映像設備工事', text: '音響・映像設備工事サービスをご案内します。' };
    if (roleTypes.includes('artist_pa_operation') || post.category === 'TOUR PA') return { href: '/tour-pa.html', title: 'ツアーPA・サウンドエンジニア派遣', text: 'アーティストPAとライブオペレートに関連するサービスをご案内します。' };
    return { href: '/pa-rental.html', title: 'PAレンタル・イベント音響', text: '現場技術サポートとPAサービスをご案内します。' };
};

const renderWorkPage = (post) => {
    const canonical = `${SITE_URL}/works/${post.slug}.html`;
    const imageUrl = publicFlyerUrl(post.flyer_path);
    const summary = buildSummary(post);
    const seoDescription = truncate(summary, 155);
    const date = formatDate(post.event_date);
    const year = post.event_date?.slice(0, 4) || '';
    const titleContext = [year ? `${year}年` : '', post.venue || ''].filter(Boolean).join(' ');
    const pageTitle = `${post.title}${titleContext ? `｜${titleContext}` : ''}｜ARA-TECH実績`;
    const roleTypes = getRoleTypes(post);
    const service = serviceFor(post, roleTypes);
    const operationArtists = post.operation_artists || (roleTypes.includes('artist_pa_operation') ? post.artists : null);
    const supportArtists = post.support_artists || (roleTypes.includes('local_technical_support') ? post.artists : null);

    const roleTags = roleTypes.map((role) => `<span class="detail-role detail-role--${role === 'artist_pa_operation' ? 'operation' : 'support'}">${escapeHtml(roleDetails[role].label)}</span>`).join('');
    const roleAssignments = roleTypes.map((role) => {
        const detail = roleDetails[role];
        const artists = role === 'artist_pa_operation' ? operationArtists : supportArtists;
        return `<section class="role-assignment role-assignment--${role === 'artist_pa_operation' ? 'operation' : 'support'}">
            <h2>${escapeHtml(detail.label)}</h2><p>${escapeHtml(detail.description)}</p>
            ${artists ? `<p class="assignment-artists">${escapeHtml(detail.artistLabel)}：${escapeHtml(artists)}</p>` : ''}
        </section>`;
    }).join('');

    const metaRows = [
        date ? `<div><dt>開催日</dt><dd><time datetime="${escapeHtml(post.event_date)}">${escapeHtml(date)}</time></dd></div>` : '',
        post.venue ? `<div><dt>会場</dt><dd>${escapeHtml(post.venue)}</dd></div>` : '',
        roleTypes.length ? `<div><dt>対応業務</dt><dd>${escapeHtml(roleTypes.map((role) => roleDetails[role].description).join('、'))}</dd></div>` : ''
    ].filter(Boolean).join('');

    const structuredData = {
        '@context': 'https://schema.org',
        '@graph': [
            {
                '@type': 'WebPage',
                '@id': `${canonical}#webpage`,
                url: canonical,
                name: pageTitle,
                description: seoDescription,
                inLanguage: 'ja-JP',
                breadcrumb: { '@id': `${canonical}#breadcrumb` },
                primaryImageOfPage: { '@id': `${canonical}#primaryimage` },
                ...(post.updated_at ? { dateModified: post.updated_at } : {})
            },
            {
                '@type': 'BreadcrumbList',
                '@id': `${canonical}#breadcrumb`,
                itemListElement: [
                    { '@type': 'ListItem', position: 1, name: 'トップ', item: `${SITE_URL}/` },
                    { '@type': 'ListItem', position: 2, name: '実績一覧', item: `${SITE_URL}/works.html` },
                    { '@type': 'ListItem', position: 3, name: post.title, item: canonical }
                ]
            },
            {
                '@type': 'ImageObject',
                '@id': `${canonical}#primaryimage`,
                contentUrl: imageUrl,
                url: imageUrl,
                caption: post.flyer_alt || `${post.title}のフライヤー`
            }
        ]
    };

    return `<!doctype html>
<html lang="ja">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${escapeHtml(pageTitle)}</title>
    <meta name="description" content="${escapeHtml(seoDescription)}">
    <meta name="robots" content="index, follow">
    <link rel="canonical" href="${escapeHtml(canonical)}">
    <meta property="og:type" content="article">
    <meta property="og:locale" content="ja_JP">
    <meta property="og:site_name" content="ARA-TECH">
    <meta property="og:title" content="${escapeHtml(`${post.title}｜ARA-TECH実績`)}">
    <meta property="og:description" content="${escapeHtml(seoDescription)}">
    <meta property="og:url" content="${escapeHtml(canonical)}">
    <meta property="og:image" content="${escapeHtml(imageUrl)}">
    <meta property="og:image:alt" content="${escapeHtml(post.flyer_alt || `${post.title}のフライヤー`)}">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${escapeHtml(`${post.title}｜ARA-TECH実績`)}">
    <meta name="twitter:description" content="${escapeHtml(seoDescription)}">
    <meta name="twitter:image" content="${escapeHtml(imageUrl)}">
    <meta name="theme-color" content="#007bff">
    <link rel="icon" href="/img/favicon.ico">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;700;900&display=swap" rel="stylesheet">
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
    <link rel="stylesheet" href="/work-detail.css">
    <script type="application/ld+json">${safeJson(structuredData)}</script>
    <script async src="https://www.googletagmanager.com/gtag/js?id=G-K8VZM111TY"></script>
    <script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag('js',new Date());gtag('config','G-K8VZM111TY');</script>
</head>
<body>
    <nav class="navbar navbar-expand-lg navbar-dark">
        <div class="container">
            <a class="navbar-brand" href="/"><img src="/img/ARA-TECH ロゴ横 白.png" alt="ARA-TECH" width="2919" height="422" decoding="async"></a>
            <button class="navbar-toggler" type="button" data-bs-toggle="collapse" data-bs-target="#navbarNav" aria-controls="navbarNav" aria-expanded="false" aria-label="メニューを開く"><span class="navbar-toggler-icon"></span></button>
            <div class="collapse navbar-collapse" id="navbarNav"><div class="navbar-nav ms-auto text-center">
                <a class="nav-link" href="/">HOME</a><a class="nav-link" href="/pa-rental.html">PA RENTAL</a><a class="nav-link" href="/stage-production.html">STAGE</a><a class="nav-link" href="/tour-pa.html">TOUR PA</a><a class="nav-link" href="/installation.html">INSTALLATION</a><a class="nav-link" href="/works.html" aria-current="page">WORKS</a><a class="nav-link" href="/contact.html">CONTACT</a>
            </div></div>
        </div>
    </nav>
    <main class="detail-shell">
        <nav class="breadcrumb-nav" aria-label="パンくず"><ol><li><a href="/">トップ</a></li><li><a href="/works.html">実績一覧</a></li><li aria-current="page">${escapeHtml(post.title)}</li></ol></nav>
        <article class="detail-card">
            <div class="detail-grid">
                <figure class="detail-flyer"><img src="${escapeHtml(imageUrl)}" alt="${escapeHtml(post.flyer_alt || `${post.title}のフライヤー`)}" fetchpriority="high"></figure>
                <div class="detail-body">
                    <p class="eyebrow">FIELD REPORT</p><span class="detail-tag">${escapeHtml(post.category || 'WORKS')}</span>${roleTags}
                    <h1 class="detail-title${post.title.length > 60 ? ' detail-title--long' : post.title.length > 34 ? ' detail-title--medium' : ''}">${escapeHtml(post.title)}</h1>
                    <p class="work-summary">${escapeHtml(summary)}</p>
                    ${roleAssignments ? `<div class="role-assignments">${roleAssignments}</div>` : post.artists ? `<p class="artist">担当アーティスト：${escapeHtml(post.artists)}</p>` : ''}
                    ${metaRows ? `<dl class="detail-meta">${metaRows}</dl>` : ''}
                </div>
            </div>
            <section class="content-section" aria-labelledby="service-heading"><p class="eyebrow">RELATED SERVICE</p><h2 id="service-heading">${escapeHtml(service.title)}</h2><p>${escapeHtml(service.text)}</p><a class="button button--secondary" href="${service.href}">サービスを見る</a></section>
            <section class="content-section contact-panel" aria-labelledby="contact-heading"><div><p class="eyebrow">CONTACT</p><h2 id="contact-heading">音響・現場対応のご相談</h2><p>日程、会場、必要な機材や技術体制など、決まっている内容からご相談いただけます。</p></div><a class="button" href="/contact.html">お問い合わせ・お見積り</a></section>
        </article>
        <a class="back" href="/works.html">← WORKS一覧へ戻る</a>
    </main>
    <footer class="py-4 border-top text-center"><small>&copy; 2025 ARA-TECH. All Rights Reserved. <span aria-hidden="true">|</span> <a href="/privacy.html">プライバシーポリシー</a></small></footer>
    <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script>
</body>
</html>`;
};

module.exports = async (request, response) => {
    if (!['GET', 'HEAD'].includes(request.method)) {
        response.setHeader('Allow', 'GET, HEAD');
        return response.status(405).send('Method Not Allowed');
    }

    const rawId = getQueryValue(request, 'id');
    const rawSlug = getQueryValue(request, 'slug');
    const id = rawId ? String(rawId) : '';
    const slug = rawSlug ? String(rawSlug).toLowerCase() : '';

    try {
        if (id) {
            if (!/^\d+$/.test(id)) {
                response.setHeader('X-Robots-Tag', 'noindex, follow');
                return response.status(404).send(request.method === 'HEAD' ? '' : renderErrorPage(404, '実績が見つかりません', 'URLをご確認ください。'));
            }
            const [post] = await fetchWorks({ id });
            if (!post?.slug) {
                response.setHeader('X-Robots-Tag', 'noindex, follow');
                return response.status(404).send(request.method === 'HEAD' ? '' : renderErrorPage(404, '実績が見つかりません', 'この実績は公開されていないか、存在しません。'));
            }
            response.setHeader('Location', `/works/${post.slug}.html`);
            response.setHeader('Cache-Control', 'public, max-age=86400');
            return response.status(308).send('');
        }

        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
            response.setHeader('X-Robots-Tag', 'noindex, follow');
            return response.status(404).send(request.method === 'HEAD' ? '' : renderErrorPage(404, '実績が見つかりません', 'URLをご確認ください。'));
        }

        const [post] = await fetchWorks({ slug });
        if (!post) {
            response.setHeader('X-Robots-Tag', 'noindex, follow');
            return response.status(404).send(request.method === 'HEAD' ? '' : renderErrorPage(404, '実績が見つかりません', 'この実績は公開されていないか、存在しません。'));
        }

        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
        response.setHeader('CDN-Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
        response.setHeader('X-Content-Type-Options', 'nosniff');
        return response.status(200).send(request.method === 'HEAD' ? '' : renderWorkPage(post));
    } catch (error) {
        console.error('work detail error', error.message);
        response.setHeader('X-Robots-Tag', 'noindex, follow');
        response.setHeader('Retry-After', '60');
        return response.status(503).send(request.method === 'HEAD' ? '' : renderErrorPage(503, '実績を読み込めません', '時間をおいて、もう一度お試しください。'));
    }
};

module.exports.renderWorkPage = renderWorkPage;
