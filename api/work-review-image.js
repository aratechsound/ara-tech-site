const { createHash } = require('node:crypto');
const { lookup } = require('node:dns').promises;
const { isIP } = require('node:net');
const { supabaseRequest, verifyAdmin } = require('./_pa-mail.cjs');
const { applyOriginPolicy } = require('./_request-security.cjs');

const MAX_BODY_BYTES = 2_048;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

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
    const candidateHash = String(input.candidate_hash || '').trim();
    if (!Number.isSafeInteger(id) || id <= 0 || !/^[0-9a-f]{64}$/u.test(candidateHash)) {
        throw new Error('invalid_input');
    }
    return { id, candidateHash };
};

const loadPendingWork = async (id, fetchImpl = fetch) => {
    const query = new URLSearchParams({
        id: `eq.${id}`,
        select: 'id,title,candidate_hash,publication_review_status,is_published,review_image_url,official_announcement_url',
        limit: '1'
    });
    const rows = await supabaseRequest(`/rest/v1/work_posts?${query}`, {}, fetchImpl);
    const work = Array.isArray(rows) ? rows[0] : null;
    if (!work || work.is_published || work.publication_review_status !== 'publication_pending_approval') {
        throw new Error('not_found');
    }
    return work;
};

const normalizedDomain = (hostname) => String(hostname || '').toLowerCase().replace(/^www\./u, '');

const domainsAreRelated = (left, right) => {
    const a = normalizedDomain(left);
    const b = normalizedDomain(right);
    return Boolean(a && b && (a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`)));
};

const isPrivateAddress = (address) => {
    const value = String(address || '').toLowerCase().split('%')[0];
    if (value.startsWith('::ffff:')) return isPrivateAddress(value.slice(7));
    if (isIP(value) === 4) {
        const [a, b] = value.split('.').map(Number);
        return a === 0 || a === 10 || a === 127 || a >= 224
            || (a === 100 && b >= 64 && b <= 127)
            || (a === 169 && b === 254)
            || (a === 172 && b >= 16 && b <= 31)
            || (a === 192 && b === 168)
            || (a === 192 && b === 0)
            || (a === 198 && (b === 18 || b === 19 || b === 51))
            || (a === 203 && b === 0);
    }
    if (isIP(value) === 6) {
        return value === '::' || value === '::1' || value.startsWith('fc') || value.startsWith('fd')
            || /^fe[89ab]/u.test(value) || value.startsWith('2001:db8:');
    }
    return true;
};

const validateImageUrl = async (rawUrl, officialUrl, resolver = lookup) => {
    let image;
    let official;
    try {
        image = new URL(rawUrl);
        official = new URL(officialUrl);
    } catch {
        throw new Error('image_source_invalid');
    }
    if (image.protocol !== 'https:' || official.protocol !== 'https:' || image.username || image.password || image.port) {
        throw new Error('image_source_invalid');
    }
    if (!domainsAreRelated(image.hostname, official.hostname)) throw new Error('image_source_invalid');
    if (image.hostname === 'localhost' || image.hostname.endsWith('.local')) throw new Error('image_source_invalid');
    if (isIP(image.hostname) && isPrivateAddress(image.hostname)) throw new Error('image_source_invalid');
    const addresses = await resolver(image.hostname, { all: true, verbatim: true });
    if (!Array.isArray(addresses) || !addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
        throw new Error('image_source_invalid');
    }
    return image;
};

const readLimitedBody = async (response) => {
    const statedLength = Number(response.headers.get('content-length') || 0);
    if (Number.isFinite(statedLength) && statedLength > MAX_IMAGE_BYTES) throw new Error('image_too_large');
    if (!response.body?.getReader) {
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length > MAX_IMAGE_BYTES) throw new Error('image_too_large');
        return buffer;
    }
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_IMAGE_BYTES) {
            await reader.cancel();
            throw new Error('image_too_large');
        }
        chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, total);
};

const matchesImageSignature = (buffer, contentType) => {
    if (contentType === 'image/jpeg') return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    if (contentType === 'image/png') return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    if (contentType === 'image/webp') return buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';
    return false;
};

const downloadImage = async ({ imageUrl, officialUrl, fetchImpl = fetch, resolver = lookup }) => {
    let current = await validateImageUrl(imageUrl, officialUrl, resolver);
    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
        const response = await fetchImpl(current, {
            method: 'GET',
            redirect: 'manual',
            headers: {
                accept: 'image/webp,image/png,image/jpeg;q=0.9,*/*;q=0.1',
                'user-agent': 'ARA-TECH-Admin-Image-Import/1.0'
            }
        });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
            if (redirect === MAX_REDIRECTS) throw new Error('image_redirect_invalid');
            const location = response.headers.get('location');
            if (!location) throw new Error('image_redirect_invalid');
            current = await validateImageUrl(new URL(location, current).href, officialUrl, resolver);
            continue;
        }
        if (!response.ok) throw new Error('image_download_failed');
        const contentType = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        if (!ALLOWED_IMAGE_TYPES.has(contentType)) throw new Error('image_type_invalid');
        const buffer = await readLimitedBody(response);
        if (!matchesImageSignature(buffer, contentType)) throw new Error('image_type_invalid');
        return {
            buffer,
            contentType,
            sha256: createHash('sha256').update(buffer).digest('hex')
        };
    }
    throw new Error('image_redirect_invalid');
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
        const { id, candidateHash } = parseBody(request);
        await verifyAdmin(bearerToken(request));
        const work = await loadPendingWork(id);
        if (work.candidate_hash !== candidateHash) return sendText(response, 409, 'Candidate changed');
        const image = await downloadImage({
            imageUrl: work.review_image_url,
            officialUrl: work.official_announcement_url
        });
        response.setHeader('Content-Type', image.contentType);
        response.setHeader('Content-Length', String(image.buffer.length));
        response.setHeader('Content-Disposition', 'inline');
        response.setHeader('Cache-Control', 'private, no-store, max-age=0');
        response.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');
        response.setHeader('X-Content-Type-Options', 'nosniff');
        response.setHeader('X-ARA-Image-SHA256', image.sha256);
        return response.status(200).send(image.buffer);
    } catch (error) {
        const code = String(error?.message || '');
        if (code === 'not_authorized') return sendText(response, 401, 'Unauthorized');
        if (code === 'invalid_input') return sendText(response, 400, 'Invalid input');
        if (code === 'not_found') return sendText(response, 404, 'Candidate not found');
        if (/^image_(source_invalid|redirect_invalid|download_failed|too_large|type_invalid)$/u.test(code)) {
            return sendText(response, 422, 'Image import unavailable');
        }
        console.error('work review image error', /^supabase_\d{3}$/u.test(code) ? code : 'internal_error');
        return sendText(response, 503, 'Image import unavailable');
    }
};

module.exports.MAX_IMAGE_BYTES = MAX_IMAGE_BYTES;
module.exports.bearerToken = bearerToken;
module.exports.domainsAreRelated = domainsAreRelated;
module.exports.downloadImage = downloadImage;
module.exports.isPrivateAddress = isPrivateAddress;
module.exports.loadPendingWork = loadPendingWork;
module.exports.matchesImageSignature = matchesImageSignature;
module.exports.parseBody = parseBody;
module.exports.validateImageUrl = validateImageUrl;
