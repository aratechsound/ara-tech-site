'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const root = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const config = JSON.parse(read('vercel.json'));

// Both surfaces retain browser protections; legacy business assertions stay in
// their original validators and now read the preserved legacy document.
for (const file of ['pa-admin.html', 'pa-admin-legacy.html']) {
  const html = read(file);
  assert.match(html, /<meta name="robots" content="noindex, nofollow, noarchive">/);
  assert.match(html, /<meta name="referrer" content="no-referrer">/);
  assert.doesNotMatch(html, /analytics\.js|googletagmanager|_vercel\/insights|service_role/i);
  const entry = config.headers.find(h => h.source === '/' + file);
  assert.ok(entry, file + ' security headers required');
  const headers = Object.fromEntries(entry.headers.map(h => [h.key.toLowerCase(), h.value]));
  assert.match(headers['cache-control'], /private, no-store/);
  assert.equal(headers['referrer-policy'], 'no-referrer');
  for (const directive of ['noindex', 'nofollow', 'noarchive']) assert.ok(headers['x-robots-tag'].includes(directive));
  const csp = headers['content-security-policy'];
  for (const directive of ["frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'", "connect-src 'self' https://kogbnremsouajxxsgxro.supabase.co"]) assert.ok(csp.includes(directive));
  assert.doesNotMatch(csp, /script-src[^;]*'unsafe-inline'|script-src[^;]*'unsafe-eval'/);
}
const html = read('pa-admin.html');
assert.match(html, /id="workspace"[^>]*hidden/);
assert.match(html, /<script type="module" src="\/pa-ui\/js\/desk.mjs"><\/script>/);
assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/);
const desk = read('pa-ui/js/desk.mjs');
assert.match(desk, /workspaceAuth\.restore\(\)/);
assert.match(desk, /fetch\(readUrl\(url\),\{method:'GET',cache:'no-store',headers:\{authorization:'Bearer '\+session\.access_token\}/);
assert.match(read('pa-ui/js/integration.mjs'), /return '\/pa-admin-legacy\.html\?case='/);

async function main() {
  const {createWorkspaceAuth} = await import(pathToFileURL(path.join(root, 'pa-ui/js/auth-session.mjs')));
  const uid = 'synthetic-owner';
  const session = {access_token: 'synthetic-session', user: {id: uid}, expires_at: 100};
  function client({expired = false, authDenied = false, mismatch = false, member = true, aclDenied = false} = {}) {
    return {
      auth: {
        getSession: async () => ({data: {session: {...session, expires_at: expired ? 0 : 100}}}),
        getUser: async () => ({data: {user: {id: mismatch ? 'other' : uid}}, error: authDenied ? Error('denied') : null})
      },
      from(table) {
        assert.equal(table, 'work_admins');
        return {select(column) {
          assert.equal(column, 'user_id');
          return {eq(column, value) {
            assert.equal(column, 'user_id'); assert.equal(value, uid);
            return {maybeSingle: async () => ({data: member ? {user_id: uid} : null, error: aclDenied ? Error('acl') : null})};
          }};
        }};
      }
    };
  }
  assert.equal((await createWorkspaceAuth(client(), () => 1000).restore()).user.id, uid);
  for (const options of [{expired: true}, {authDenied: true}, {mismatch: true}, {member: false}, {aclDenied: true}]) {
    await assert.rejects(createWorkspaceAuth(client(options), () => 1000).restore(), /login_required|admin_required/);
  }
  console.log('PAUI-019 admin browser protections and normal-session membership gates passed');
}
main().catch(error => {console.error(error); process.exitCode = 1;});
