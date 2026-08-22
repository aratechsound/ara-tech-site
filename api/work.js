const {
    SITE_URL,
    buildSummary,
    escapeHtml,
    fetchWorks,
    formatDate,
    getEventType,
    getFlyerDimensions,
    getRoleTypes,
    getServiceTypeLabels,
    getServiceTypes,
    getWorkYear,
    hasFlyer,
    isValidWorkSlug,
    isUpcomingWork,
    publicFlyerTransformedUrl,
    publicFlyerThumbnailUrl,
    publicFlyerUrl,
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

const eventTime = (post) => {
    if (!getWorkYear(post)) return null;
    const timestamp = Date.parse(`${post.event_date}T00:00:00Z`);
    return Number.isFinite(timestamp) ? timestamp : null;
};

const businessAffinity = (current, candidate) => {
    const currentServices = getServiceTypes(current);
    const candidateServices = getServiceTypes(candidate);
    const currentRoles = getRoleTypes(current);
    const candidateRoles = getRoleTypes(candidate);
    const hasSharedService = currentServices.some((service) => candidateServices.includes(service))
        || (!currentServices.length && !candidateServices.length && currentRoles.some((role) => candidateRoles.includes(role)));
    const currentEventType = getEventType(current);
    const candidateEventType = getEventType(candidate);
    const hasSharedEventType = Boolean(currentEventType && currentEventType === candidateEventType);
    return (hasSharedService ? 2 : 0) + (hasSharedEventType ? 1 : 0);
};

const buildWorkNavigation = (current, orderedWorks) => {
    if (isUpcomingWork(current)) return { olderWork: null, newerWork: null };
    const navigableWorks = (orderedWorks || []).filter((work) => !isUpcomingWork(work) && isValidWorkSlug(work.slug) && eventTime(work) !== null);
    const currentIndex = navigableWorks.findIndex((work) => work.slug === current.slug);
    if (currentIndex < 0) return { olderWork: null, newerWork: null };
    return {
        olderWork: navigableWorks[currentIndex + 1] || null,
        newerWork: navigableWorks[currentIndex - 1] || null
    };
};

const selectRelatedWorks = (current, orderedWorks, limit = 3) => {
    if (isUpcomingWork(current)) return [];
    const currentYear = getWorkYear(current);
    const currentTime = eventTime(current);
    return (orderedWorks || [])
        .map((work, index) => ({ work, index }))
        .filter(({ work }) => !isUpcomingWork(work) && work.slug !== current.slug && isValidWorkSlug(work.slug))
        .sort((left, right) => {
            const leftSameYear = Boolean(currentYear && getWorkYear(left.work) === currentYear);
            const rightSameYear = Boolean(currentYear && getWorkYear(right.work) === currentYear);
            if (leftSameYear !== rightSameYear) return leftSameYear ? -1 : 1;

            const leftBusinessAffinity = businessAffinity(current, left.work);
            const rightBusinessAffinity = businessAffinity(current, right.work);
            if (leftBusinessAffinity !== rightBusinessAffinity) return rightBusinessAffinity - leftBusinessAffinity;

            const leftTime = eventTime(left.work);
            const rightTime = eventTime(right.work);
            const leftDistance = currentTime === null || leftTime === null ? Number.POSITIVE_INFINITY : Math.abs(currentTime - leftTime);
            const rightDistance = currentTime === null || rightTime === null ? Number.POSITIVE_INFINITY : Math.abs(currentTime - rightTime);
            if (leftDistance !== rightDistance) return leftDistance - rightDistance;
            return left.index - right.index;
        })
        .slice(0, limit)
        .map(({ work }) => work);
};

const workHref = (post) => `/works/${post.slug}.html`;

const renderWorkNavigation = (olderWork, newerWork) => {
    if (!olderWork && !newerWork) return '';
    const renderLink = (work, direction) => {
        if (!work) return '';
        const isOlder = direction === 'older';
        const date = formatDate(work.event_date) || (getWorkYear(work) ? `${getWorkYear(work)}年` : '開催日未設定');
        const directionLabel = isOlder ? '← 過去の実績' : '新しい実績 →';
        return `<a class="work-pagination__link work-pagination__link--${direction}" href="${workHref(work)}">
                    <span class="work-pagination__direction">${directionLabel}</span>
                    <span class="work-pagination__date">${escapeHtml(date)}</span>
                    <span class="work-pagination__title">${escapeHtml(work.title)}</span>
                </a>`;
    };
    return `<nav class="content-section work-pagination" aria-label="実績の前後ナビゲーション">
            <div class="work-pagination__grid${olderWork && newerWork ? '' : ' work-pagination__grid--single'}">
                ${renderLink(olderWork, 'older')}
                ${renderLink(newerWork, 'newer')}
            </div>
        </nav>`;
};

const renderRelatedWorks = (relatedWorks) => {
    if (!relatedWorks?.length) return '';
    const cards = relatedWorks.map((work) => {
        const date = formatDate(work.event_date) || (getWorkYear(work) ? `${getWorkYear(work)}年` : '開催日未設定');
        const workHasFlyer = hasFlyer(work);
        const imageUrl = workHasFlyer ? publicFlyerThumbnailUrl(work.flyer_path, 240) : '';
        const imageUrl2x = workHasFlyer ? publicFlyerThumbnailUrl(work.flyer_path, 480) : '';
        const dimensions = workHasFlyer ? getFlyerDimensions(work.flyer_path) || { width: 480, height: 640 } : null;
        const media = workHasFlyer
            ? `<img src="${escapeHtml(imageUrl)}" srcset="${escapeHtml(imageUrl)} 240w, ${escapeHtml(imageUrl2x)} 480w" sizes="(max-width: 640px) 34vw, (max-width: 991px) 50vw, 33vw" alt="${escapeHtml(work.flyer_alt || `${work.title}のフライヤー`)}" width="${dimensions.width}" height="${dimensions.height}" loading="lazy" decoding="async">`
            : '<span class="related-work-card__placeholder" aria-hidden="true">ARA-TECH</span>';
        return `<a class="related-work-card" href="${workHref(work)}">
                    <span class="related-work-card__image">${media}</span>
                    <span class="related-work-card__body"><span class="related-work-card__date">${escapeHtml(date)}</span><span class="related-work-card__title">${escapeHtml(work.title)}</span></span>
                </a>`;
    }).join('');
    return `<section class="content-section related-works" aria-labelledby="related-works-heading">
            <p class="eyebrow">RELATED WORKS</p>
            <h2 id="related-works-heading">関連する実績</h2>
            <div class="related-works__grid">${cards}</div>
        </section>`;
};

const renderErrorPage = (status, heading, message) => `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex, follow"><title>${escapeHtml(heading)} | ARA-TECH</title>
<link rel="stylesheet" href="/work-detail.css"><link rel="icon" href="/img/favicon.ico"></head>
<body><main class="detail-shell"><section class="not-found"><p class="eyebrow">${status}</p><h1>${escapeHtml(heading)}</h1><p>${escapeHtml(message)}</p><a class="button" href="/works.html">実績一覧へ戻る</a></section></main></body></html>`;

const serviceFor = (post) => {
    const serviceTypes = getServiceTypes(post);
    if (serviceTypes.includes('system_design_construction')) return { href: '/installation.html', title: '音響・照明・映像設備施工', text: 'システム設計・施工に関連するサービスをご案内します。' };
    if (serviceTypes.some((service) => ['event_technical_production', 'temporary_stage_setup', 'truss_setup', 'stage_lighting', 'led_video'].includes(service))) return { href: '/stage-production.html', title: 'イベント技術制作・ステージ設営', text: 'イベント技術制作、ステージ設営、照明・映像に関連するサービスをご案内します。' };
    if (serviceTypes.includes('artist_pa_operation')) return { href: '/tour-pa.html', title: 'ツアーPA・サウンドエンジニア派遣', text: 'アーティストPAオペレートに関連するサービスをご案内します。' };
    return { href: '/pa-rental.html', title: 'PAレンタル・イベント音響', text: '現場技術サポートとPAサービスをご案内します。' };
};

const safeHttpsUrl = (value) => {
    try {
        const url = new URL(String(value || ''));
        return url.protocol === 'https:' ? url.href : '';
    } catch {
        return '';
    }
};

const performerNames = (value) => String(value || '')
    .split(/[、,\n]+/)
    .map((name) => name.trim())
    .filter(Boolean);

const formatClockTime = (value) => {
    const match = String(value || '').match(/^(\d{2}):(\d{2})/u);
    return match ? `${match[1]}:${match[2]}` : '';
};

const renderWorkPage = (post, {
    olderWork = null,
    newerWork = null,
    relatedWorks = [],
    preview = false
} = {}) => {
    const canonical = `${SITE_URL}/works/${post.slug}.html`;
    const upcoming = isUpcomingWork(post);
    const publicWorkHasFlyer = hasFlyer(post);
    const reviewImageUrl = preview ? safeHttpsUrl(post.review_image_url) : '';
    const workHasFlyer = publicWorkHasFlyer || Boolean(reviewImageUrl);
    const imageUrl = publicWorkHasFlyer
        ? publicFlyerUrl(post.flyer_path)
        : reviewImageUrl || `${SITE_URL}/img/cta-bg.jpg`;
    const displayImageUrl = publicWorkHasFlyer ? publicFlyerTransformedUrl(post.flyer_path, 800, 78) : reviewImageUrl;
    const displayImageSrcset = publicWorkHasFlyer ? [480, 800, 1200]
        .map((width) => `${publicFlyerTransformedUrl(post.flyer_path, width, 78)} ${width}w`)
        .join(', ') : '';
    const displayImageSizes = '(max-width: 991px) calc(100vw - 72px), 52vw';
    const displayImageDimensions = publicWorkHasFlyer ? getFlyerDimensions(post.flyer_path) : null;
    const displayImageDimensionAttributes = displayImageDimensions
        ? ` width="${displayImageDimensions.width}" height="${displayImageDimensions.height}"`
        : '';
    const hasStaleUpcomingCopy = [post.description, post.seo_title, post.meta_description]
        .some((value) => /開催予定|担当予定/u.test(String(value || '')));
    const neutralizeUpcomingCopy = !upcoming
        && (post.lifecycle_status === 'upcoming' || hasStaleUpcomingCopy);
    // Upcoming copy is approval-time information, not a confirmed field report.
    // After the date boundary, use the neutral completed summary until an editor
    // explicitly records the result instead of displaying stale "予定" claims.
    const summary = buildSummary(neutralizeUpcomingCopy ? { ...post, description: null } : post);
    const seoDescription = truncate(neutralizeUpcomingCopy ? summary : post.meta_description || summary, 155);
    const date = formatDate(post.event_date);
    const year = post.event_date?.slice(0, 4) || '';
    const titleContext = [year ? `${year}年` : '', post.venue || ''].filter(Boolean).join(' ');
    const seoSuffix = upcoming ? 'ARA-TECH 音響担当予定' : 'ARA-TECH実績';
    const pageTitle = (neutralizeUpcomingCopy ? '' : String(post.seo_title || '').trim())
        || `${post.title}${titleContext ? `｜${titleContext}` : ''}｜${seoSuffix}`;
    const eventType = getEventType(post);
    const serviceTypes = getServiceTypes(post);
    const serviceTypeLabels = getServiceTypeLabels(post);
    const service = serviceFor(post);
    const assignedArtists = post.operation_artists || post.artists || post.support_artists || null;
    const participantGroups = String(post.participant_groups || '').trim();
    const systemSetup = String(post.system_setup || '').trim();
    const systemSetupHtml = escapeHtml(systemSetup).replace(/\r?\n/g, '<br>');
    const officialAnnouncementUrl = safeHttpsUrl(post.official_announcement_url);
    const announcementConfirmedDate = formatDate(post.announcement_confirmed_on);
    const openTime = formatClockTime(post.open_time);
    const startTime = formatClockTime(post.start_time);

    const breadcrumbItems = [
        { name: 'トップ', item: `${SITE_URL}/` },
        { name: '実績一覧', item: `${SITE_URL}/works.html` },
        ...(upcoming
            ? [{ name: '開催予定', item: `${SITE_URL}/works.html#upcoming` }]
            : year ? [{ name: `${year}年`, item: `${SITE_URL}/works.html#year-${year}` }] : []),
        { name: post.title, item: canonical }
    ];
    const breadcrumbHtml = breadcrumbItems.map((item, index) => index === breadcrumbItems.length - 1
        ? `<li aria-current="page">${escapeHtml(item.name)}</li>`
        : `<li><a href="${escapeHtml(item.item.replace(SITE_URL, '') || '/')}">${escapeHtml(item.name)}</a></li>`).join('');

    const metaRows = [
        `<div><dt>状態</dt><dd><span class="detail-status detail-status--${upcoming ? 'upcoming' : 'completed'}">${upcoming ? '開催予定' : '終了済み'}</span></dd></div>`,
        eventType ? `<div><dt>イベント種別</dt><dd>${escapeHtml(eventType)}</dd></div>` : '',
        serviceTypeLabels.length ? `<div><dt>担当業務</dt><dd>${escapeHtml(serviceTypeLabels.join('、'))}</dd></div>` : '',
        post.performer_name ? `<div><dt>アーティスト・イベント</dt><dd>${escapeHtml(post.performer_name)}</dd></div>` : '',
        date ? `<div><dt>開催日</dt><dd><time datetime="${escapeHtml(post.event_date)}">${escapeHtml(date)}</time></dd></div>` : '',
        openTime ? `<div><dt>OPEN</dt><dd><time datetime="${escapeHtml(openTime)}">${escapeHtml(openTime)}</time></dd></div>` : '',
        startTime ? `<div><dt>START</dt><dd><time datetime="${escapeHtml(startTime)}">${escapeHtml(startTime)}</time></dd></div>` : '',
        post.venue ? `<div><dt>会場</dt><dd>${escapeHtml(post.venue)}</dd></div>` : '',
        post.area ? `<div><dt>地域</dt><dd>${escapeHtml(post.area)}</dd></div>` : '',
        participantGroups ? `<div><dt>出演・参加団体</dt><dd>${escapeHtml(participantGroups)}</dd></div>` : '',
        systemSetup ? `<div><dt>機材・システム構成</dt><dd>${systemSetupHtml}</dd></div>` : '',
        upcoming && announcementConfirmedDate ? `<div><dt>公式告知確認日</dt><dd><time datetime="${escapeHtml(post.announcement_confirmed_on)}">${escapeHtml(announcementConfirmedDate)}</time></dd></div>` : ''
    ].filter(Boolean).join('');

    const officialInformation = upcoming && officialAnnouncementUrl
        ? `<section class="content-section official-information" aria-labelledby="official-information-heading">
            <p class="eyebrow">OFFICIAL INFORMATION</p>
            <h2 id="official-information-heading">公演・チケット等の詳細</h2>
            <p>ARA-TECHはこの公演の主催者ではありません。最新の公演内容、開場・開演時刻、チケット等は、${post.organizer_name ? `${escapeHtml(post.organizer_name)}の` : ''}公式情報をご確認ください。</p>
            <a class="button button--secondary" href="${escapeHtml(officialAnnouncementUrl)}" target="_blank" rel="external noopener noreferrer">会場・主催者の公式告知を見る</a>
        </section>`
        : '';

    const structuredGraph = [
        {
            '@type': 'WebPage',
            '@id': `${canonical}#webpage`,
            url: canonical,
            name: pageTitle,
            description: seoDescription,
            inLanguage: 'ja-JP',
            breadcrumb: { '@id': `${canonical}#breadcrumb` },
            ...(workHasFlyer ? { primaryImageOfPage: { '@id': `${canonical}#primaryimage` } } : {}),
            ...(post.updated_at ? { dateModified: post.updated_at } : {})
        },
        {
            '@type': 'BreadcrumbList',
            '@id': `${canonical}#breadcrumb`,
            itemListElement: breadcrumbItems.map((item, index) => ({
                '@type': 'ListItem',
                position: index + 1,
                name: item.name,
                item: item.item
            }))
        }
    ];

    if (workHasFlyer) {
        structuredGraph.push({
            '@type': 'ImageObject',
            '@id': `${canonical}#primaryimage`,
            contentUrl: imageUrl,
            url: imageUrl,
            caption: post.flyer_alt || `${post.title}のフライヤー`
        });
    }

    const canRenderGoogleEvent = upcoming
        && post.event_date
        && post.venue
        && post.area
        && post.venue_address
        && officialAnnouncementUrl;
    if (canRenderGoogleEvent) {
        const performers = performerNames(post.performer_name);
        structuredGraph.push({
            '@type': 'Event',
            '@id': `${canonical}#event`,
            name: post.title,
            startDate: `${post.event_date}${startTime || openTime ? `T${startTime || openTime}:00+09:00` : ''}`,
            eventStatus: 'https://schema.org/EventScheduled',
            eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
            location: {
                '@type': 'Place',
                name: post.venue,
                address: {
                    '@type': 'PostalAddress',
                    streetAddress: post.venue_address,
                    addressRegion: post.area,
                    addressCountry: 'JP'
                }
            },
            description: summary,
            url: canonical,
            sameAs: officialAnnouncementUrl,
            ...(workHasFlyer ? { image: [imageUrl] } : {}),
            ...(performers.length ? { performer: performers.map((name) => ({ '@type': 'PerformingGroup', name })) } : {}),
            ...(post.organizer_name ? { organizer: { '@type': 'Organization', name: post.organizer_name, url: officialAnnouncementUrl } } : {})
        });
    }

    const structuredData = {
        '@context': 'https://schema.org',
        '@graph': structuredGraph
    };

    const previewImageNote = preview && reviewImageUrl && !publicWorkHasFlyer
        ? post.image_usage_status === 'not_permitted'
            ? '管理画面の確認用画像です。現在は「画像を掲載しない」設定です。'
            : '公開待ち一覧で確認中の画像です。「公開する」で公開ページに掲載されます。'
        : '';
    const detailMedia = workHasFlyer
        ? `<figure class="detail-flyer${previewImageNote ? ' detail-flyer--review' : ''}"><img src="${escapeHtml(displayImageUrl)}"${displayImageSrcset ? ` srcset="${escapeHtml(displayImageSrcset)}" sizes="${escapeHtml(displayImageSizes)}"` : ''} alt="${escapeHtml(post.flyer_alt || `${post.title}のフライヤー`)}"${displayImageDimensionAttributes} fetchpriority="high" loading="eager" decoding="async">${previewImageNote ? `<figcaption class="preview-image-note">${previewImageNote}</figcaption>` : ''}</figure>`
        : '<div class="detail-flyer detail-flyer--placeholder" role="img" aria-label="画像は掲載されていません"><span>ARA-TECH</span><strong>画像は掲載されていません</strong></div>';

    const analyticsScript = preview ? '' : `<script>(()=>{const button=document.querySelector('.navbar-toggler');const menu=document.getElementById('navbarNav');const closeMenu=()=>{button.setAttribute('aria-expanded','false');button.setAttribute('aria-label','メニューを開く');menu.classList.remove('is-open')};if(button&&menu){button.addEventListener('click',()=>{const willOpen=button.getAttribute('aria-expanded')!=='true';button.setAttribute('aria-expanded',String(willOpen));button.setAttribute('aria-label',willOpen?'メニューを閉じる':'メニューを開く');menu.classList.toggle('is-open',willOpen)});document.addEventListener('keydown',(event)=>{if(event.key==='Escape'&&button.getAttribute('aria-expanded')==='true'){closeMenu();button.focus()}})}})();</script><script src="/js/analytics.js" data-analytics-load="idle" defer></script>`;

    return `<!doctype html>
<html lang="ja">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    ${preview ? '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'self\'; img-src \'self\' data: https:; font-src \'self\'; base-uri \'none\'; form-action \'none\'">' : ''}
    <title>${escapeHtml(pageTitle)}</title>
    <meta name="description" content="${escapeHtml(seoDescription)}">
    <meta name="robots" content="${preview ? 'noindex, nofollow, noarchive, nosnippet' : 'index, follow'}">
    <link rel="canonical" href="${escapeHtml(canonical)}">
    <meta property="og:type" content="article">
    <meta property="og:locale" content="ja_JP">
    <meta property="og:site_name" content="ARA-TECH">
    <meta property="og:title" content="${escapeHtml(pageTitle)}">
    <meta property="og:description" content="${escapeHtml(seoDescription)}">
    <meta property="og:url" content="${escapeHtml(canonical)}">
    <meta property="og:image" content="${escapeHtml(imageUrl)}">
    <meta property="og:image:alt" content="${escapeHtml(workHasFlyer ? post.flyer_alt || `${post.title}のフライヤー` : 'ARA-TECH 音響・ステージ制作')}">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${escapeHtml(pageTitle)}">
    <meta name="twitter:description" content="${escapeHtml(seoDescription)}">
    <meta name="twitter:image" content="${escapeHtml(imageUrl)}">
    <meta name="theme-color" content="#007bff">
    <link rel="icon" href="/img/favicon.ico">
    <link rel="preconnect" href="https://kogbnremsouajxxsgxro.supabase.co" crossorigin>
    ${workHasFlyer ? `<link rel="preload" as="image" href="${escapeHtml(displayImageUrl)}"${displayImageSrcset ? ` imagesrcset="${escapeHtml(displayImageSrcset)}" imagesizes="${escapeHtml(displayImageSizes)}"` : ''} fetchpriority="high">` : ''}
    <link rel="stylesheet" href="/work-detail.css">
    <link rel="stylesheet" href="/site-navigation.css?v=ara-20260724-007">
    <script type="application/ld+json">${safeJson(structuredData)}</script>
</head>
<body>
    ${preview ? '<aside class="admin-preview-banner" role="status"><strong>公開待ちプレビュー</strong><span>一般公開されていない管理画面内の確認表示です。</span></aside>' : ''}
    <nav class="navbar navbar-expand-lg navbar-dark">
        <div class="container">
            <a class="navbar-brand" href="/"><img src="/img/ARA-TECH ロゴ横 白.png" alt="ARA-TECH" width="2919" height="422" decoding="async"></a>
            <button class="navbar-toggler" type="button" aria-controls="navbarNav" aria-expanded="false" aria-label="メニューを開く"><span class="navbar-toggler-icon"></span></button>
            <div class="collapse navbar-collapse" id="navbarNav"><div class="navbar-nav ms-auto text-center">
                <a class="nav-link" href="/">HOME</a><a class="nav-link" href="/pa-rental.html">PA RENTAL</a><a class="nav-link" href="/stage-production.html">STAGE</a><a class="nav-link" href="/tour-pa.html">TOUR PA</a><a class="nav-link" href="/installation.html">INSTALLATION</a><a class="nav-link" href="/works.html" aria-current="page">WORKS</a><a class="nav-link" href="/contact.html">CONTACT</a>
            </div></div>
        </div>
    </nav>
    <main class="detail-shell">
        <nav class="breadcrumb-nav" aria-label="パンくず"><ol>${breadcrumbHtml}</ol></nav>
        <article class="detail-card">
            <div class="detail-grid">
                ${detailMedia}
                <div class="detail-body">
                    <p class="eyebrow">${upcoming ? 'UPCOMING EVENT' : 'FIELD REPORT'}</p><div class="detail-tag-row">${upcoming ? '<span class="detail-status detail-status--upcoming">開催予定</span>' : ''}${eventType ? `<span class="detail-tag">${escapeHtml(eventType)}</span>` : ''}${serviceTypeLabels.length ? `<span class="detail-services">${escapeHtml(serviceTypeLabels.join(' / '))}</span>` : ''}</div>
                    <h1 class="detail-title${post.title.length > 60 ? ' detail-title--long' : post.title.length > 34 ? ' detail-title--medium' : ''}">${escapeHtml(post.title)}</h1>
                    <p class="work-summary">${escapeHtml(summary)}</p>
                    ${assignedArtists ? `<p class="artist">担当アーティスト：${escapeHtml(assignedArtists)}</p>` : ''}
                    ${metaRows ? `<dl class="detail-meta">${metaRows}</dl>` : ''}
                </div>
            </div>
            ${renderWorkNavigation(olderWork, newerWork)}
            ${renderRelatedWorks(relatedWorks)}
            ${officialInformation}
            <section class="content-section" aria-labelledby="service-heading"><p class="eyebrow">RELATED SERVICE</p><h2 id="service-heading">${escapeHtml(service.title)}</h2><p>${escapeHtml(service.text)}</p><a class="button button--secondary" href="${service.href}">サービスを見る</a></section>
            <section class="content-section contact-panel" aria-labelledby="contact-heading"><div><p class="eyebrow">CONTACT</p><h2 id="contact-heading">音響・現場対応のご相談</h2><p>日程、会場、必要な機材や技術体制など、決まっている内容からご相談いただけます。</p></div><a class="button" href="/contact.html">お問い合わせ・お見積り</a></section>
        </article>
        <a class="back" href="/works.html${upcoming ? '#upcoming' : year ? `#year-${year}` : ''}">← ${upcoming ? '開催予定' : year ? `${year}年のWORKS` : 'WORKS'}一覧へ戻る</a>
    </main>
    <footer class="site-footer"><small>&copy; 2025 ARA-TECH. All Rights Reserved. <span aria-hidden="true">|</span> <a href="/privacy.html">プライバシーポリシー</a></small></footer>
    ${analyticsScript}
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

        const works = await fetchWorks();
        const post = works.find((work) => work.slug === slug);
        if (!post) {
            response.setHeader('X-Robots-Tag', 'noindex, follow');
            return response.status(404).send(request.method === 'HEAD' ? '' : renderErrorPage(404, '実績が見つかりません', 'この実績は公開されていないか、存在しません。'));
        }

        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
        // The effective lifecycle changes at JST midnight. Do not let a stale
        // pre-midnight detail page disagree with the client-classified index.
        response.setHeader('CDN-Cache-Control', 'no-store');
        response.setHeader('X-Content-Type-Options', 'nosniff');
        const navigation = buildWorkNavigation(post, works);
        const relatedWorks = selectRelatedWorks(post, works);
        return response.status(200).send(request.method === 'HEAD' ? '' : renderWorkPage(post, { ...navigation, relatedWorks }));
    } catch (error) {
        console.error('work detail error', error.message);
        response.setHeader('X-Robots-Tag', 'noindex, follow');
        response.setHeader('Retry-After', '60');
        return response.status(503).send(request.method === 'HEAD' ? '' : renderErrorPage(503, '実績を読み込めません', '時間をおいて、もう一度お試しください。'));
    }
};

module.exports.renderWorkPage = renderWorkPage;
module.exports.buildWorkNavigation = buildWorkNavigation;
module.exports.selectRelatedWorks = selectRelatedWorks;
