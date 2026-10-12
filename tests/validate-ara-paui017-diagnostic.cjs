'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {createDiagnosticHandler} = require('../api/_pa-release-diagnostic.cjs');
const {resolveSupabaseUrl, DEFAULT_SUPABASE_URL} = require('../api/_pa-backend-target.cjs');
const uid = '123e4567-e89b-42d3-a456-426614174000';
const authorization = 'Bearer synthetic_owner_session_123456789';
const key = 'sb_publishable_synthetic_diagnostic_test';
const environment = {PA_RELEASE_DIAGNOSTIC_ENABLED: 'true', VERCEL_ENV: 'preview',
  VERCEL_DEPLOYMENT_ID: 'dpl_SyntheticDiagnostic', VERCEL_GIT_COMMIT_SHA: 'a'.repeat(40)};
const baseRequest = {method: 'GET', url: '/api/pa-workspace-read?path=/diagnostic/backend',
  headers: {host: 'diagnostic-preview.vercel.app', origin: 'https://diagnostic-preview.vercel.app', authorization}};
const results = [];
async function check(name, run) { await run(); results.push({name, status: 'PASS'}); }
async function call({env = environment, req = baseRequest, answers = [{id: uid, email: 'synthetic-private@example.invalid'}, [{user_id: uid}]], keyProvider = () => key} = {}) {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({url, options});
    const answer = answers[requests.length - 1];
    if (answer instanceof Error) throw answer;
    return new Response(JSON.stringify(answer?.payload ?? answer), {status: answer?.status ?? 200});
  };
  const response = {headers: {}, setHeader(k, v) {this.headers[k.toLowerCase()] = v;}, end(body) {this.payload = JSON.parse(body);}};
  await createDiagnosticHandler({fetchImpl, env, keyProvider})(req, response);
  return {response, requests};
}
async function main() {
  await check('Owner GET binds deployment to shared commercial target; no writes or private output', async () => {
    const {response: r, requests} = await call();
    assert.equal(r.statusCode, 200); assert.equal(requests.length, 2);
    assert.equal(r.payload.backend.project_ref, 'kogbnremsouajxxsgxro');
    assert.equal(r.payload.deployment.id, environment.VERCEL_DEPLOYMENT_ID);
    assert.equal(r.payload.backend.database_name, null); assert.equal(r.payload.backend.branch, null);
    assert.equal(r.payload.backend.db4_hashes, 'NOT_QUERIED');
    assert.match(r.headers['cache-control'], /no-store/);
    for (const {url, options} of requests) {
      assert.equal(new URL(url).origin, DEFAULT_SUPABASE_URL);
      assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error');
      assert.equal(options.headers.apikey, key); assert.equal(options.headers.authorization, authorization);
      assert.ok(options.signal instanceof AbortSignal);
      assert.ok(!url.includes('/rpc/'));
    }
    const output = JSON.stringify(r.payload);
    for (const forbidden of [uid, authorization, key, 'synthetic-private', 'service_role', 'password']) assert.ok(!output.includes(forbidden));
    assert.equal(r.payload.diagnostic_sha256, require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(__dirname, '../api/_pa-release-diagnostic.cjs'))).digest('hex'));
  });
  await check('Diagnostic disabled by default, no upstream GET', async () => {const r = await call({env: {}}); assert.equal(r.response.statusCode, 404); assert.equal(r.requests.length, 0);});
  for (const method of ['POST', 'PUT', 'DELETE', 'HEAD', 'OPTIONS']) await check(method + ' denied without writes', async () => {
    const r = await call({req: {...baseRequest, method}}); assert.equal(r.response.statusCode, 405); assert.equal(r.requests.length, 0);
  });
  await check('Anonymous denied before upstream', async () => {const r = await call({req: {...baseRequest, headers: {host: 'ara-tech.cc'}}}); assert.equal(r.response.statusCode, 401); assert.equal(r.requests.length, 0);});
  await check('Expired session denied', async () => {const r = await call({answers: [{status: 401, payload: {message: 'synthetic'}}]}); assert.equal(r.response.statusCode, 401); assert.equal(r.requests.length, 1);});
  for (const label of ['General user', 'Revoked administrator']) await check(label + ' denied', async () => {const r = await call({answers: [{id: uid}, []]}); assert.equal(r.response.statusCode, 403); assert.equal(r.requests.length, 2);});
  await check('Admin ACL rejection remains rejection', async () => {const r = await call({answers: [{id: uid}, {status: 403, payload: {}}]}); assert.equal(r.response.statusCode, 403); assert.equal(r.requests.length, 2);});
  await check('Mismatched admin identity denied', async () => {const r = await call({answers: [{id: uid}, [{user_id: 'another'}]]}); assert.equal(r.response.statusCode, 403);});
  await check('Duplicate membership denied', async () => {const r = await call({answers: [{id: uid}, [{user_id: uid}, {user_id: uid}]]}); assert.equal(r.response.statusCode, 403);});
  for (const headers of [{origin: 'https://evil.invalid'}, {'sec-fetch-site': 'cross-site'}, {host: 'ara-tech.cc.evil.invalid'}]) await check('Cross-origin/host rejection ' + Object.keys(headers)[0], async () => {
    const r = await call({req: {...baseRequest, headers: {...baseRequest.headers, ...headers}}}); assert.equal(r.response.statusCode, 403); assert.equal(r.requests.length, 0);
  });
  for (const suffix of ['&path=/data/cases', '&target=https://evil.invalid', '&inquiry_id=' + uid]) await check('No caller-selected target or business query ' + suffix.split('=')[0], async () => {
    const r = await call({req: {...baseRequest, url: baseRequest.url + suffix}}); assert.equal(r.response.statusCode, 400); assert.equal(r.requests.length, 0);
  });
  for (const target of ['https://another.supabase.co', DEFAULT_SUPABASE_URL + '/rest/v1', 'http://127.0.0.1', 'https://user:password@kogbnremsouajxxsgxro.supabase.co']) await check('Backend mismatch rejected without network ' + target.split('/')[2].replace(/.*@/, ''), async () => {
    const r = await call({env: {...environment, SUPABASE_URL: target}}); assert.equal(r.response.statusCode, 503); assert.equal(r.requests.length, 0); assert.deepEqual(r.response.payload, {ok: false, code: 'backend_identity_refused'});
  });
  await check('Redirect/network failure never falls back or logs raw errors', async () => {const r = await call({answers: [new Error('synthetic-sensitive-error')]}); assert.equal(r.response.statusCode, 503); assert.equal(r.requests.length, 1); assert.equal(JSON.stringify(r.response.payload).includes('sensitive'), false);});
  await check('Oversized auth payload refused', async () => {const r = await call({answers: [{id: uid, ignored: 'x'.repeat(20000)}]}); assert.equal(r.response.statusCode, 503); assert.equal(r.requests.length, 1);});
  await check('Missing deployment identity is UNKNOWN, no successful receipt', async () => {const r = await call({env: {...environment, VERCEL_DEPLOYMENT_ID: ''}}); assert.equal(r.response.statusCode, 503);});
  await check('Production env receipt is explicit and source-null stays null', async () => {const r = await call({env: {...environment, VERCEL_ENV: 'production', VERCEL_GIT_COMMIT_SHA: ''}}); assert.equal(r.response.statusCode, 200); assert.equal(r.response.payload.deployment.environment, 'production'); assert.equal(r.response.payload.deployment.git_commit_sha, null);});
  await check('Resolver retains default, override and trailing slash behavior; commercial uses shared resolver', async () => {
    for (const env of [{}, {SUPABASE_URL: ''}, {SUPABASE_URL: DEFAULT_SUPABASE_URL + '///'}, {SUPABASE_URL: 'https://synthetic.supabase.co///'}]) {
      assert.equal(resolveSupabaseUrl(env), String(env.SUPABASE_URL || DEFAULT_SUPABASE_URL).replace(/\/+$/u, ''));
    }
    assert.match(fs.readFileSync(path.join(__dirname, '../api/_pa-mail.cjs'), 'utf8'), /url: resolveSupabaseUrl\(\)/);
  });
  await check('Privileged public-key substitute refused', async () => {const r = await call({keyProvider: () => 'synthetic_privileged_key'}); assert.equal(r.response.statusCode, 503); assert.equal(r.requests.length, 0);});
  await check('Malformed source identity refuses successful receipt', async () => {const r = await call({env: {...environment, VERCEL_GIT_COMMIT_SHA: 'unverified'}}); assert.equal(r.response.statusCode, 503);});
  await check('Existing HTTP adapter dispatches diagnostic and preserves anonymous read denial', async () => {
    const adapter = require('../api/pa-workspace-read.js');
    const previous = process.env.PA_RELEASE_DIAGNOSTIC_ENABLED;
    delete process.env.PA_RELEASE_DIAGNOSTIC_ENABLED;
    try {
      for (const [url, status] of [[baseRequest.url, 404], ['/api/pa-workspace-read?path=/data/cases', 401]]) {
        const r = {setHeader() {}, end(body) {this.payload = JSON.parse(body);}};
        await adapter({method: 'GET', url, headers: {host: 'ara-tech.cc'}}, r);
        assert.equal(r.statusCode, status);
      }
    } finally {
      if (previous === undefined) delete process.env.PA_RELEASE_DIAGNOSTIC_ENABLED;
      else process.env.PA_RELEASE_DIAGNOSTIC_ENABLED = previous;
    }
  });
  console.log(JSON.stringify({suite: 'PAUI017_SAFE_DIAGNOSTIC', status: 'PASS', tests: results, live_network: 0, mutations: 0}));
}
main().catch(() => {console.error('PAUI017_SAFE_DIAGNOSTIC=FAIL'); process.exitCode = 1;});
