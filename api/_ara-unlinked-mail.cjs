const { OFFICIAL_EMAIL, supabaseRequest, getInquiry, isUuid } = require('./_pa-mail.cjs');
const { gmailJson, gmailMessage, getGlobalThreadLink, normalizeMessage, validGmailId } = require('./_pa-gmail.cjs');
const { CASE_TYPES } = require('./_ara-case.cjs');
const rpc = async (name, input, fetchImpl) => { try { return await supabaseRequest(`/rest/v1/rpc/${name}`, { method: 'POST', body: JSON.stringify(input) }, fetchImpl); } catch (error) { if (error.message === 'supabase_400' || error.message === 'supabase_409') throw new Error('mail_operation_conflict'); throw error; } };
const assertBusinessMailbox = async (fetchImpl = fetch) => {
 const profile = await gmailJson('/profile', {}, fetchImpl);
 if (String(profile?.emailAddress || '').toLowerCase() !== OFFICIAL_EMAIL) throw new Error('gmail_mailbox_mismatch');
 return OFFICIAL_EMAIL;
};
const listUnlinkedMail = (fetchImpl = fetch) => supabaseRequest('/rest/v1/ara_unlinked_mail?decision=eq.pending&select=*&order=received_at.desc&limit=100', {}, fetchImpl);
// One bounded page per invocation. The DB commits the page and cursor together.
const syncUnlinkedMail = async ({ actorId }, fetchImpl = fetch) => {
 await assertBusinessMailbox(fetchImpl);
 const states = await supabaseRequest('/rest/v1/ara_mail_sync_state?select=*&limit=1', {}, fetchImpl);
 const state = states?.[0];
 const until = state?.window_end || new Date().toISOString();
 const since = state?.window_start || new Date(Date.parse(until) - 30 * 86400000).toISOString();
 const page = state?.page_token || '';
 const params = new URLSearchParams({ q: `after:${Math.floor(Date.parse(since)/1000)} before:${Math.floor(Date.parse(until)/1000)} -in:spam -in:trash -in:drafts -in:sent`, maxResults: '50', includeSpamTrash: 'false' });
 if (page) params.set('pageToken', page);
 const result = await gmailJson(`/messages?${params}`, {}, fetchImpl);
 const rows = [];
 for (const entry of result.messages || []) {
  if (!validGmailId(entry.id)) throw new Error('gmail_page_invalid');
  const raw = await gmailMessage(entry.id, fetchImpl);
  const mail = normalizeMessage(raw);
  if (!validGmailId(mail.id) || !validGmailId(mail.thread_id)) throw new Error('gmail_page_invalid');
  if ((raw.labelIds || []).some(id => ['DRAFT', 'SENT', 'SPAM', 'TRASH'].includes(id)) || mail.direction !== 'inbound') continue;
  // Global lookup deliberately includes archived cases.
  if (await getGlobalThreadLink(mail.thread_id, fetchImpl)) continue;
  rows.push({ gmail_message_id: mail.id, gmail_thread_id: mail.thread_id, from_address: mail.from_address,
   subject: mail.subject.slice(0,500), snippet: String(raw.snippet || mail.body_text || '').slice(0,500),
   received_at: mail.occurred_at, has_attachments: mail.attachments.length > 0 });
 }
 await rpc('ara_commit_mail_page', { p_actor: actorId, p_start: since, p_end: until, p_expected_page: page,
  p_next_page: result.nextPageToken || '', p_rows: rows }, fetchImpl);
 return { candidates: await listUnlinkedMail(fetchImpl), has_more: Boolean(result.nextPageToken), synced_at: new Date().toISOString() };
};
const decideUnlinkedMail = async ({ actorId, messageId, action, caseId, customerName, customerEmail, caseType }, fetchImpl = fetch) => {
 if (!validGmailId(messageId) || !['create','link','exclude'].includes(action)) throw new Error('invalid_mail_decision');
 if (action === 'link') { if (!isUuid(caseId)) throw new Error('invalid_mail_decision'); await getInquiry(caseId, fetchImpl); }
 if (action === 'create' && (!CASE_TYPES[caseType] || !customerName || String(customerName).length > 160
   || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(customerEmail || '')))) throw new Error('invalid_mail_decision');
 let content = null;
 if (action === 'create') {
  await assertBusinessMailbox(fetchImpl);
  const candidate = await supabaseRequest(`/rest/v1/ara_unlinked_mail?gmail_message_id=eq.${encodeURIComponent(messageId)}&select=*&limit=1`, {}, fetchImpl);
  const mail = normalizeMessage(await gmailMessage(messageId, fetchImpl));
  if (!candidate?.[0] || mail.id !== messageId || mail.thread_id !== candidate[0].gmail_thread_id || mail.direction !== 'inbound') throw new Error('invalid_mail_decision');
  content = String(mail.body_text || mail.body || candidate[0].snippet || '');
  if (content.length > 20000) throw new Error('invalid_mail_decision');
 }
 return rpc('ara_decide_mail', { p_actor: actorId, p_message: messageId, p_action: action,
  p_case: action === 'link' ? caseId : null, p_customer: customerName || null, p_email: customerEmail || null, p_type: caseType || null, p_content: content }, fetchImpl);
};
module.exports = { assertBusinessMailbox, listUnlinkedMail, syncUnlinkedMail, decideUnlinkedMail };
