export async function diagnosticGet(auth, fetchImpl = fetch) {
  const session = await auth.restore();
  if (!session?.access_token) throw Error('login_required');
  const response = await fetchImpl('/api/pa-workspace-read?path=/diagnostic/backend', {
    method: 'GET', cache: 'no-store', redirect: 'error',
    headers: {authorization: 'Bearer ' + session.access_token, accept: 'application/json'}
  });
  if (!response.ok) throw Error('diagnostic_denied_' + response.status);
  const data = await response.json();
  if (data?.ok !== true || data.read_only !== true || data.diagnostic_version !== 'PAUI017-1' ||
      !/^\d{4}-\d{2}-\d{2}T[0-9:.]+Z$/.test(data.observed_at || '') ||
      !/^dpl_[A-Za-z0-9]+$/.test(data.deployment?.id || '') ||
      !['preview', 'production'].includes(data.deployment?.environment) ||
      !/^[a-f0-9]{40}$/.test(data.deployment?.git_commit_sha || '') ||
      !/^[a-f0-9]{64}$/.test(data.diagnostic_sha256 || '') ||
      data.backend?.project_ref !== 'kogbnremsouajxxsgxro' ||
      data.backend?.auth_get !== 'PASS' || data.backend?.admin_membership_get !== 'PASS') throw Error('receipt_identity_refused');
  // Explicit non-secret projection. Never render session, header, user, or raw error.
  return {ok: true, diagnostic_version: data.diagnostic_version, observed_at: data.observed_at,
    deployment: {id: data.deployment.id, environment: data.deployment.environment, git_commit_sha: data.deployment.git_commit_sha},
    backend: {project_ref: data.backend.project_ref, host: 'kogbnremsouajxxsgxro.supabase.co', schema: 'public',
      auth_get: 'PASS', admin_membership_get: 'PASS', database_name: null, branch: null, db4_hashes: 'NOT_QUERIED'},
    diagnostic_sha256: data.diagnostic_sha256, read_only: true};
}
