const crypto = require('node:crypto');
const portal = require('./_pa-portal.cjs');
const { getAttachmentBinary } = require('./_pa-gmail.cjs');
const { randomSecret, sha256, SECRET, SESSION_SECONDS } = require('./_pa-portal-organizer.cjs');
const requireSecret = value => { if (!SECRET.test(String(value || ''))) throw new Error('link_unavailable'); return String(value); };
const serviceRpc = (name, input, fetchImpl) => portal.rpc(portal.bearerConfig().key, name, input, fetchImpl);
async function manageLink({ accessToken, caseId, grade, action, expiresAt, timezone, eventEndAt }, fetchImpl = fetch) {
  if (!['GENERAL','TECHNICAL'].includes(grade) || !['status','create','rotate','revoke','expiry','settings'].includes(action)) throw new Error('invalid_staff_action');
  const secret = ['create','rotate'].includes(action) ? randomSecret() : null;
  const result = await portal.rpc(accessToken, 'pa_portal_staff_manage_link', { p_case_id: caseId, p_grade: grade, p_action: action, p_token_hash: secret ? sha256(secret) : null, p_expires_at: expiresAt || null, p_timezone: timezone || null, p_event_end_at: eventEndAt || null }, fetchImpl);
  return secret ? { ...result, share_url: `/staff-portal#${secret}` } : result;
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
module.exports = { manageLink, exchange, read, download, SESSION_SECONDS };
