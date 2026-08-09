const { supabaseRequest, verifyAdmin } = require('./_pa-mail.cjs');
const { applyOriginPolicy } = require('./_request-security.cjs');
const { renderWorkPage } = require('./work.js');

const MAX_BODY_BYTES = 2_048;

const bearerToken = (request) => {
    const match = String(request.headers?.authorization || '').match(/^Bearer ([^\s]+)$/u);
    if (!match || match[1].length > 4_096) throw new Error('not_authorized');
    return match[1];
};

const parseBody = (request) => {
    let input;
    try {
        input = request.body && typeof request.body === 'object' && !Buffer.isBuffer(request.body)
            ? request.body
            : JSON.parse(String(request.body || ''));
    } catch {
        throw new Error('invalid_input');
    }
    if (!input || Array.isArray(input) || Buffer.byteLength(JSON.stringify(input), 'utf8') > MAX_BODY_BYTES) {
        throw new Error('invalid_input');
    }
    const id = Number(input.id);
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error('invalid_input');
    return id;
};

const loadPendingWork = async (id, fetchImpl = fetch) => {
    const query = new URLSearchParams({ id: `eq.${id}`, select: '*', limit: '1' });
    const rows = await supabaseRequest(`/rest/v1/work_posts?${query}`, {}, fetchImpl);
    const work = Array.isArray(rows) ? rows[0] : null;
    if (!work || work.is_published || work.publication_review_status !== 'publication_pending_approval') {
        throw new Error('not_found');
    }
    return work;
};

const sendText = (response, status, body) => {
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    response.setHeader('Cache-Control', 'private, no-store, max-age=0');
    response.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    return response.status(status).send(body);
};

module.exports = async (request, response) => {
    if (request.method !== 'POST') {
        response.setHeader('Allow', 'POST');
        return sendText(response, 405, 'Method Not Allowed');
    }
    if (!applyOriginPolicy(request, response)) return sendText(response, 403, 'Forbidden');

    try {
        const id = parseBody(request);
        await verifyAdmin(bearerToken(request));
        const work = await loadPendingWork(id);
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.setHeader('Cache-Control', 'private, no-store, max-age=0');
        response.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');
        response.setHeader('X-Content-Type-Options', 'nosniff');
        response.setHeader('Referrer-Policy', 'no-referrer');
        return response.status(200).send(renderWorkPage(work, { preview: true }));
    } catch (error) {
        const code = String(error?.message || '');
        if (code === 'not_authorized') return sendText(response, 401, 'Unauthorized');
        if (code === 'invalid_input') return sendText(response, 400, 'Invalid input');
        if (code === 'not_found') return sendText(response, 404, 'Preview not found');
        console.error('work preview error', /^supabase_\d{3}$/u.test(code) ? code : 'internal_error');
        return sendText(response, 503, 'Preview unavailable');
    }
};

module.exports.MAX_BODY_BYTES = MAX_BODY_BYTES;
module.exports.bearerToken = bearerToken;
module.exports.loadPendingWork = loadPendingWork;
module.exports.parseBody = parseBody;
