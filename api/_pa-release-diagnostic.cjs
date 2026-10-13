'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const {DEFAULT_SUPABASE_URL, resolveSupabaseUrl} = require('./_pa-backend-target.cjs');
const {publicKey} = require('./_pa-workspace-read.cjs');
const ROUTE = '/diagnostic/backend';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
class DiagnosticError extends Error {
  constructor(code, status) { super(code); this.code = code; this.status = status; }
}
function createDiagnosticHandler({fetchImpl = fetch, env = process.env, keyProvider = publicKey} = {}) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const send = (status, payload) => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.end(JSON.stringify(payload));
    };
    try {
      if (env.PA_RELEASE_DIAGNOSTIC_ENABLED !== 'true') throw new DiagnosticError('not_found', 404);
      if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); throw new DiagnosticError('read_only', 405); }
      const query = new URL(req.url, 'https://ara-tech.cc').searchParams;
      if ([...query.keys()].some(k => k !== 'path') || query.getAll('path').length !== 1 || query.get('path') !== ROUTE)
        throw new DiagnosticError('query_refused', 400);
      const host = String(req.headers?.host || '');
      if (!/^(?:ara-tech\.cc|[a-z0-9-]+\.vercel\.app)$/.test(host) ||
          req.headers?.['sec-fetch-site'] === 'cross-site' ||
          req.headers?.origin && req.headers.origin !== 'https://' + host)
        throw new DiagnosticError('origin_refused', 403);
      const authorization = req.headers?.authorization;
      if (!/^Bearer [A-Za-z0-9_.-]{20,8000}$/.test(authorization || '')) throw new DiagnosticError('login_required', 401);
      // Resolve from the actual server commercial backend, not the browser target.
      // No arbitrary/custom origin, redirect, alternate credential, RPC, or fallback.
      const target = resolveSupabaseUrl(env);
      if (target !== DEFAULT_SUPABASE_URL) throw new DiagnosticError('backend_identity_refused', 503);
      const key = keyProvider();
      if (typeof key !== 'string' || !key.startsWith('sb_publishable_')) throw new DiagnosticError('public_key_required', 503);
      async function read(path) {
        const response = await fetchImpl(target + path, {
          method: 'GET', redirect: 'error', signal: AbortSignal.timeout(20000),
          headers: {apikey: key, authorization, accept: 'application/json', 'accept-profile': 'public'}
        });
        if (!response.ok) throw new DiagnosticError(response.status === 401 ? 'login_required' : response.status === 403 ? 'admin_required' : 'read_unavailable', [401, 403].includes(response.status) ? response.status : 503);
        if (Number(response.headers.get('content-length')) > 16384) throw new DiagnosticError('read_unavailable', 503);
        const reader = response.body.getReader(), parts = []; let size = 0;
        try {
          for (;;) {
            const {done, value} = await reader.read(); if (done) break;
            size += value.length;
            if (size > 16384) throw new DiagnosticError('read_unavailable', 503);
            parts.push(Buffer.from(value));
          }
        } finally { await reader.cancel().catch(() => {}); }
        return JSON.parse(Buffer.concat(parts).toString('utf8'));
      }
      const user = await read('/auth/v1/user');
      if (!UUID.test(user?.id || '')) throw new DiagnosticError('login_required', 401);
      const admins = await read('/rest/v1/work_admins?select=user_id&user_id=eq.' + encodeURIComponent(user.id) + '&limit=2');
      if (!Array.isArray(admins) || admins.length !== 1 || admins[0].user_id !== user.id) throw new DiagnosticError('admin_required', 403);
      const deploymentId = String(env.VERCEL_DEPLOYMENT_ID || '');
      const environment = String(env.VERCEL_ENV || '');
      if (!/^dpl_[A-Za-z0-9]+$/.test(deploymentId) || !['preview', 'production'].includes(environment))
        throw new DiagnosticError('deployment_identity_unavailable', 503);
      const commit = String(env.VERCEL_GIT_COMMIT_SHA || '');
      if (commit && !/^[a-f0-9]{40}$/.test(commit)) throw new DiagnosticError('source_identity_refused', 503);
      return send(200, {
        ok: true, diagnostic_version: 'PAUI017-1', observed_at: new Date().toISOString(),
        deployment: {id: deploymentId, environment, git_commit_sha: commit || null},
        backend: {project_ref: 'kogbnremsouajxxsgxro', host: new URL(target).hostname, schema: 'public',
          resolver: 'shared_commercial_server_resolver', auth_get: 'PASS', admin_membership_get: 'PASS',
          database_name: null, branch: null, db4_hashes: 'NOT_QUERIED'},
        diagnostic_sha256: crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'),
        read_only: true
      });
    } catch (error) {
      const safe = error instanceof DiagnosticError ? error : new DiagnosticError('read_unavailable', 503);
      return send(safe.status, {ok: false, code: safe.code});
    }
  };
}
module.exports = {ROUTE, createDiagnosticHandler};
