'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {workspaceRequest, createWorkspaceHandler} = require('../api/_pa-workspace-handler.cjs');
const gmail = require('../api/pa-gmail.js');
const {parsePublicConfig} = require('../api/_pa-workspace-read.cjs');
const root = path.resolve(__dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));
assert.equal(fs.readdirSync(path.join(root, 'api')).filter(n => n.endsWith('.js')).length, 12);
assert.deepEqual(config.rewrites.find(r => r.source === '/api/pa-workspace-read'), {
  source: '/api/pa-workspace-read', destination: '/api/pa-gmail?workspace_read=1'
});
assert.equal(config.functions['api/pa-gmail.js'].includeFiles, 'js/supabase-config.js');
const headers = {host: 'ara-tech.cc'};
const req = (url, method = 'GET') => ({url, method, headers});
const response = () => ({headers: {}, setHeader(k, v) {this.headers[k.toLowerCase()] = v;}, end(b) {this.payload = JSON.parse(b);},
  status(n) {this.statusCode = n; return this;}, json(p) {this.payload = p; return this;}});
async function main() {
  for (const quote of ["'", '"']) {
    const source = `const SUPABASE_URL = ${quote}https://kogbnremsouajxxsgxro.supabase.co${quote}; const SUPABASE_ANON_KEY = ${quote}sb_publishable_synthetic${quote};`;
    assert.equal(parsePublicConfig(source), 'sb_publishable_synthetic');
    assert.throws(() => parsePublicConfig(source.replace('kogbnremsouajxxsgxro', 'foreign')), /target_identity_refused/);
    assert.throws(() => parsePublicConfig(source.replace('sb_publishable_synthetic', 'privileged_synthetic')), /public_key_required/);
  }
  let calls = 0;
  const handler = createWorkspaceHandler({key: 'sb_publishable_synthetic', keyProvider: () => 'sb_publishable_synthetic',
    env: {PA_RELEASE_DIAGNOSTIC_ENABLED: 'true'}, fetchImpl: async () => {calls++; throw Error('unexpected_upstream');}});
  for (const url of ['/api/pa-workspace-read?path=/data/cases', '/api/pa-workspace-read?workspace_read=1&path=/data/cases', '/api/pa-gmail?workspace_read=1&path=/data/cases']) {
    const mapped = workspaceRequest(req(url)); assert.equal(new URL(mapped.url, 'https://ara-tech.cc').searchParams.get('path'), '/data/cases');
    const r = response(); await handler(mapped, r); assert.equal(r.statusCode, 401); assert.equal(calls, 0);
  }
  for (const suffix of ['workspace_read=0&path=/data/cases', 'workspace_read=1&workspace_read=1&path=/data/cases', 'workspace_read=1&path=/data/cases&action=send_reply', 'workspace_read=1&path=/data/cases&path=/data/attention']) {
    for (const entry of ['/api/pa-gmail', '/api/pa-workspace-read']) {
      const r = response(); await handler(workspaceRequest(req(entry + '?' + suffix)), r); assert.equal(r.statusCode, 400); assert.equal(calls, 0);
    }
  }
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
    for (const route of ['/data/cases', '/diagnostic/backend']) {
      const r = response(); await handler(workspaceRequest(req('/api/pa-gmail?workspace_read=1&path=' + route, method)), r);
      assert.equal(r.statusCode, 405); assert.equal(calls, 0);
    }
  }
  for (const url of ['/api/pa-gmail', '/api/pa-gmail?action=sync', '/api/pa-inquiry?workspace_read=1&path=/data/cases']) assert.equal(workspaceRequest(req(url)), null);
  // Exercise the actual shared entry point. Legacy POST actions retain their
  // existing handler; workspace requests cannot enter that write path.
  for (const [url, method, status] of [['/api/pa-gmail', 'GET', 405], ['/api/pa-workspace-read?path=/data/cases', 'GET', 401], ['/api/pa-gmail?workspace_read=1&path=/data/cases', 'POST', 405]]) {
    const r = response(); await gmail(req(url, method), r); assert.equal(r.statusCode, status);
  }
  console.log('PAUI-019 12-function deployment routing: URL preserved, selectors fail closed, workspace writes refused, legacy GET unchanged');
}
main().catch(error => {console.error(error); process.exitCode = 1;});
