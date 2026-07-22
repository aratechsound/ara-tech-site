const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const workHandler = require('../api/work.js');
const sitemapHandler = require('../api/sitemap.js');
const { rows } = require('./fixtures.cjs');

const root = path.resolve(__dirname, '..');
const port = Number(process.env.NO001_PORT || 8765);
const originalFetch = global.fetch;

global.fetch = async (url, options) => {
    const parsed = new URL(url);
    if (!parsed.hostname.endsWith('.supabase.co')) return originalFetch(url, options);
    const idFilter = parsed.searchParams.get('id');
    const slugFilter = parsed.searchParams.get('slug');
    let result = rows;
    if (idFilter) result = rows.filter((row) => row.id === Number(idFilter.replace(/^eq\./, '')));
    if (slugFilter) result = rows.filter((row) => row.slug === slugFilter.replace(/^eq\./, ''));
    if (parsed.searchParams.get('select') === 'slug,updated_at') result = result.map(({ slug, updated_at }) => ({ slug, updated_at }));
    return { ok: true, status: 200, json: async () => result };
};

const contentTypes = { '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon' };

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

    const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.replace(/^\//, ''));
    const target = path.resolve(root, relative);
    if (!target.startsWith(`${root}${path.sep}`) || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
        response.statusCode = 404;
        return response.end('Not Found');
    }
    response.setHeader('Content-Type', contentTypes[path.extname(target).toLowerCase()] || 'application/octet-stream');
    fs.createReadStream(target).pipe(response);
}).listen(port, '127.0.0.1', () => console.log(`NO001 local server: http://127.0.0.1:${port}`));
