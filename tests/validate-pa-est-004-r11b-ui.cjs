const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const client = fs.readFileSync(path.join(root, 'js', 'pa-material-preview.js'), 'utf8');
const commercial = fs.readFileSync(path.join(root, 'js', 'pa-commercial-admin.js'), 'utf8');
const thumbnailSource = client.slice(client.indexOf('const renderThumbnail'), client.indexOf('if ("IntersectionObserver"'));
const css = fs.readFileSync(path.join(root, 'pa-commercial.css'), 'utf8');
const html = fs.readFileSync(path.join(root, 'pa-admin.html'), 'utf8');
const vercel = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));

assert.match(client, /IntersectionObserver/u, 'thumbnail binaries are lazy-loaded');
assert.match(client, /getDocument\(\{ data:/u, 'PDF bytes are parsed by PDF.js');
assert.match(client, /drawImage/u, 'image bytes are decoded to canvas');
assert.doesNotMatch(client, /window\.open/u);
assert.doesNotMatch(client, /iframe/u, 'related materials no longer use a blob iframe');
assert.doesNotMatch(thumbnailSource, /createObjectURL/u, 'thumbnail rendering no longer depends on blob URLs');
assert.match(client, /download = filename/u, 'Office fallback preserves the original filename');
assert.match(css, /pa-material-preview-dialog/u);
assert.match(html, /見積・請求[\s\S]+正式受注確認[\s\S]+現在の状況・次の対応[\s\S]+関連資料[\s\S]+communication-section/u);
assert(vercel.rewrites.some(item => item.source === '/pdfjs/pdf.min.mjs'));
assert(vercel.rewrites.some(item => item.source === '/pdfjs/pdf.worker.min.mjs'));
assert.doesNotMatch(client, /storage_path|storage\/v1|publicUrl|service_role/iu, 'preview client exposes no storage key or public route');
assert.match(commercial, /Authorization: `Bearer \$\{token\}`/u, 'all preview reads retain owner bearer authentication');
assert.match(commercial, /item\.case_id !== activeCaseId/u, 'client rejects stale or cross-case material identities');

console.log('PASS PA-EST-004R11B UI source: frozen structure, lazy authenticated canvas previews, modal and Office fallback');
