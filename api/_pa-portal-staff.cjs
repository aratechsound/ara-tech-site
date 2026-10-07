const crypto = require('node:crypto');
const portal = require('./_pa-portal.cjs');
const { getAttachmentBinary } = require('./_pa-gmail.cjs');
const { randomSecret, sha256, SECRET, SESSION_SECONDS } = require('./_pa-portal-organizer.cjs');
const requireSecret = value => { if (!SECRET.test(String(value || ''))) throw new Error('link_unavailable'); return String(value); };
const serviceRpc = (name, input, fetchImpl) => portal.rpc(portal.bearerConfig().key, name, input, fetchImpl);
const ACTIONS = ['status','redisplay','create','rotate','revoke','expiry','settings'];
async function redisplay(rpc, caseId, grade) {
  const record = await rpc('stored_token', {});
  if (!record?.ok || !record.token_plaintext) return { url_redisplay: false };
  if (record.case_id !== caseId || record.grade !== grade) throw new Error('link_unavailable');
  const secret = requireSecret(record.token_plaintext);
  if (sha256(secret) !== record.token_hash) throw new Error('link_unavailable');
  // Reauthorize the same ACTIVE identity after reading its stored token.
  const checked = await rpc('stored_token', { expectedLinkId: record.link_id, expectedTokenHash: record.token_hash });
  if (!checked?.ok || checked.link_id !== record.link_id || checked.token_hash !== record.token_hash) throw new Error('link_unavailable');
  return { url_redisplay: true, share_url: '/staff-portal#' + secret };
}
async function manageLink({ accessToken, caseId, grade, action, expiresAt, timezone, eventEndAt }, fetchImpl = fetch) {
  caseId = String(caseId || '').toLowerCase();
  if (!['GENERAL','TECHNICAL'].includes(grade) || !ACTIONS.includes(action)) throw new Error('invalid_staff_action');
  const rpc = (operation, extra) => operation === 'stored_token'
    ? portal.rpc(accessToken, 'pa_portal_staff_link_token', { p_case_id: caseId, p_grade: grade, p_expected_link_id: extra.expectedLinkId || null, p_expected_token_hash: extra.expectedTokenHash || null }, fetchImpl)
    : portal.rpc(accessToken, 'pa_portal_staff_manage_link_v2', { p_case_id: caseId, p_grade: grade, p_action: operation, p_token_hash: extra.hash || null, p_expires_at: expiresAt || null, p_timezone: timezone || null, p_event_end_at: eventEndAt || null, p_plain_token: extra.secret || null }, fetchImpl);
  if (action === 'redisplay') return redisplay(rpc, caseId, grade);
  const secret = ['create','rotate'].includes(action) ? randomSecret() : null;
  const hash = secret ? sha256(secret) : null;
  const result = await rpc(action, { hash, secret });
  if (secret) return { ...result, url_redisplay: true, share_url: '/staff-portal#' + secret };
  if (action === 'status' && result.active) {
    try { return { ...result, ...await redisplay(rpc, caseId, grade) }; }
    catch (error) { if (error.message !== 'staff_url_unavailable') throw error; return { ...result, url_redisplay: false }; }
  }
  return result;
}
async function manageOrganizerLink({ session, grade, action, caseId, portalRef }, fetchImpl = fetch) {
  if (!['GENERAL','TECHNICAL'].includes(grade) || !['status','redisplay','create','rotate','revoke'].includes(action)) throw new Error('invalid_staff_action');
  const rpc = (operation, extra = {}) => serviceRpc('pa_portal_organizer_staff_manage_link', { p_session_hash: sha256(requireSecret(session)), p_grade: grade, p_action: operation, p_case_id: caseId || null, p_portal_ref: portalRef || null, p_token_hash: extra.hash || null, p_plain_token: extra.secret || null, p_expected_link_id: extra.expectedLinkId || null, p_expected_token_hash: extra.expectedTokenHash || null }, fetchImpl);
  const status = await rpc('status');
  if (!status?.ok) throw new Error('link_unavailable');
  const eventCase = status.case_id;
  if (action === 'redisplay') return redisplay(rpc, eventCase, grade);
  if (action === 'status') {
    if (!status.active) return status;
    try { return { ...status, ...await redisplay(rpc, eventCase, grade) }; }
    catch (error) { if (error.message !== 'staff_url_unavailable') throw error; return { ...status, url_redisplay: false }; }
  }
  const secret = ['create','rotate'].includes(action) ? randomSecret() : null;
  const hash = secret ? sha256(secret) : null;
  const result = await rpc(action, { hash, secret });
  if (!result?.ok) throw new Error('link_unavailable');
  return secret ? { ...result, url_redisplay: true, share_url: '/staff-portal#' + secret } : result;
}
async function exchange(rawToken, fetchImpl = fetch) {
  const session = randomSecret();
  const result = await serviceRpc('pa_portal_staff_exchange', { p_token_hash: sha256(requireSecret(rawToken)), p_session_hash: sha256(session) }, fetchImpl);
  if (!result?.ok) throw new Error('link_unavailable');
  return { session, expiresAt: result.expires_at };
}
async function read(session, fetchImpl = fetch) {
  const result = await serviceRpc('pa_portal_staff_read', { p_session_hash: sha256(requireSecret(session)) }, fetchImpl);
  if (!result?.ok) throw new Error('link_unavailable');
  return result.portal;
}
async function download({ session, assetRef, kind }, fetchImpl = fetch) {
  if (!/^[a-f0-9]{36}$/u.test(String(assetRef || '')) || !['version','photo'].includes(kind)) throw new Error('asset_unavailable');
  const asset = await serviceRpc('pa_portal_staff_asset', { p_session_hash: sha256(requireSecret(session)), p_asset_ref: assetRef, p_asset_kind: kind }, fetchImpl);
  if (!asset?.ok) throw new Error('asset_unavailable');
  if (['gmail_attachment','pa_attachment'].includes(asset.source_type)) return getAttachmentBinary({ inquiryId: asset.case_id, gmailMessageId: asset.source_ref.gmail_message_id, gmailAttachmentId: asset.source_ref.gmail_attachment_id, gmailPartId: asset.gmail_part_id || '' }, fetchImpl);
  if (asset.source_type !== 'portal_upload') throw new Error('asset_unavailable');
  const response = await portal.storageRequest(asset.source_ref.storage_path, { method: 'GET' }, fetchImpl);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== asset.source_ref.sha256) throw new Error('asset_unavailable');
  return { bytes, filename: asset.display_filename, mime_type: asset.mime_type };
}
module.exports = { manageLink, manageOrganizerLink, exchange, read, download, SESSION_SECONDS };
