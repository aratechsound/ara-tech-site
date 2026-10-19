'use strict';
const {createReadHandler} = require('./_pa-workspace-read.cjs');
const {ROUTE, createDiagnosticHandler} = require('./_pa-release-diagnostic.cjs');

// Keep the workspace's GET-only authentication/ACL gates in its own handler.
// Lazy initialization isolates a packaging failure from existing mail actions.
function createWorkspaceHandler(options) {
  const read = createReadHandler(options), diagnostic = createDiagnosticHandler(options);
  return (req, res) => {
    let route;
    try { route = new URL(req.url, 'https://ara-tech.cc').searchParams.get('path'); }
    catch { return read(req, res); }
    return route === ROUTE ? diagnostic(req, res) : read(req, res);
  };
}
function workspaceRequest(req) {
  let url;
  try { url = new URL(req.url, 'https://ara-tech.cc'); } catch { return null; }
  // Scoped CASE DESK composition has its own unchanged-strength Owner/Origin gates.
  if (url.pathname === '/api/pa-gmail' && url.searchParams.has('case_mail')) return {caseMailRoute:true,request:req};
  const original = url.pathname === '/api/pa-workspace-read';
  if (!original && (url.pathname !== '/api/pa-gmail' || !url.searchParams.has('workspace_read'))) return null;
  if (original && !url.searchParams.has('workspace_read')) return req;
  // Strip only the exact provider routing selector. Invalid/duplicate selectors
  // remain and are rejected by the unchanged workspace query allowlist.
  if (url.searchParams.getAll('workspace_read').length === 1 && url.searchParams.get('workspace_read') === '1')
    url.searchParams.delete('workspace_read');
  url.pathname = '/api/pa-workspace-read';
  return {method: req.method, headers: req.headers, url: url.pathname + url.search};
}
let handler;
async function dispatchWorkspaceRead(req, res) {
  if(req.caseMailRoute===true)return require('./_pa-case-mail-handler.cjs').createHandler()(req.request,res);
  try {
    handler ||= createWorkspaceHandler();
    return await handler(req, res);
  } catch {
    res.statusCode = 503;
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.end(JSON.stringify({ok: false, code: 'read_unavailable'}));
  }
}
module.exports = {createWorkspaceHandler, workspaceRequest, dispatchWorkspaceRead};
