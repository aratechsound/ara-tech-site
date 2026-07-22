const { SITE_URL, escapeHtml, fallbackWorks, fetchWorks } = require('./_shared.cjs');

const baseUrls = [
    ['/', '1.0'],
    ['/pa-rental.html', '0.8'],
    ['/stage-production.html', '0.8'],
    ['/tour-pa.html', '0.8'],
    ['/installation.html', '0.8'],
    ['/works.html', '0.7'],
    ['/contact.html', '0.8'],
    ['/privacy.html', '0.2']
];

const lastModifiedDate = (value) => {
    const match = String(value || '').match(/^\d{4}-\d{2}-\d{2}/);
    return match ? match[0] : '';
};

const renderSitemap = (works) => {
    const uniqueWorks = [];
    const seen = new Set();
    for (const work of works || []) {
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(work.slug || '') || seen.has(work.slug)) continue;
        seen.add(work.slug);
        uniqueWorks.push(work);
    }

    const baseEntries = baseUrls.map(([path, priority]) => `  <url>\n    <loc>${escapeHtml(`${SITE_URL}${path}`)}</loc>\n    <priority>${priority}</priority>\n  </url>`);
    const workEntries = uniqueWorks.map((work) => {
        const lastmod = lastModifiedDate(work.updated_at);
        return `  <url>\n    <loc>${escapeHtml(`${SITE_URL}/works/${work.slug}.html`)}</loc>${lastmod ? `\n    <lastmod>${lastmod}</lastmod>` : ''}\n    <priority>0.6</priority>\n  </url>`;
    });
    return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${[...baseEntries, ...workEntries].join('\n')}\n</urlset>\n`;
};

module.exports = async (request, response) => {
    if (!['GET', 'HEAD'].includes(request.method)) {
        response.setHeader('Allow', 'GET, HEAD');
        return response.status(405).send('Method Not Allowed');
    }

    let works = fallbackWorks;
    try {
        const currentWorks = await fetchWorks({ sitemap: true });
        if (currentWorks?.length) works = currentWorks;
    } catch (error) {
        console.error('sitemap data error', error.message);
    }

    response.setHeader('Content-Type', 'application/xml; charset=utf-8');
    response.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
    response.setHeader('CDN-Cache-Control', 'public, s-maxage=300, stale-while-revalidate=3600');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    return response.status(200).send(request.method === 'HEAD' ? '' : renderSitemap(works));
};

module.exports.renderSitemap = renderSitemap;
