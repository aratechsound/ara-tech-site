const { OFFICIAL_EMAIL, supabaseRequest, getInquiry, isUuid } = require('./_pa-mail.cjs');
const { gmailJson, gmailMessage, getGlobalThreadLink, normalizeMessage, validGmailId } = require('./_pa-gmail.cjs');
const { CASE_TYPES } = require('./_ara-case.cjs');
const rpc = async (name, input, fetchImpl) => { try { return await supabaseRequest(`/rest/v1/rpc/${name}`, { method: 'POST', body: JSON.stringify(input) }, fetchImpl); } catch (error) { if (error.message === 'supabase_400' || error.message === 'supabase_409') { const wrapped=new Error(error.safeDatabaseReason || 'mail_operation_conflict');wrapped.databaseCode=error.databaseCode;wrapped.phase=name;throw wrapped; } throw error; } };
const assertBusinessMailbox = async (fetchImpl = fetch) => {
 const profile = await gmailJson('/profile', {}, fetchImpl);
 if (String(profile?.emailAddress || '').toLowerCase() !== OFFICIAL_EMAIL) throw new Error('gmail_mailbox_mismatch');
 return OFFICIAL_EMAIL;
};
const listUnlinkedMail = async (input = {}, fetchImpl = fetch) => {
 // Legacy call signature remains available for the preserved R1 harness only.
 if(typeof input==='function')return supabaseRequest('/rest/v1/ara_unlinked_mail?decision=eq.pending&select=*&order=received_at.desc&limit=100',{},input);
 let cursor=input.cursor || null;
 if(cursor && (typeof cursor!=='object'||!Number.isFinite(Date.parse(cursor.snapshot))||!Number.isFinite(Date.parse(cursor.before_time))||!validGmailId(cursor.before_id)))throw Error('invalid_mail_cursor');
 const limit=100;
 const r=await rpc('ara_list_mail',{p_actor:input.actorId,p_limit:limit,p_snapshot:cursor?.snapshot||new Date().toISOString(),p_before_time:cursor?.before_time||null,p_before_id:cursor?.before_id||null},fetchImpl);
 const candidates=r.candidates.slice(0,limit),last=candidates.at(-1);
 return {...r,candidates,next_cursor:r.candidates.length>limit?{snapshot:r.snapshot,before_time:last.received_at,before_id:last.gmail_message_id}:null};
};
// One bounded page per invocation. The DB commits the page and cursor together.
const syncUnlinkedMail = async ({ actorId, now = new Date() }, fetchImpl = fetch) => {
 const attemptedAt=now.toISOString(),cutoff=Math.floor(now.getTime()/1000)*1000;
 await assertBusinessMailbox(fetchImpl);
 const states = await supabaseRequest('/rest/v1/ara_mail_sync_state?select=*&limit=1', {}, fetchImpl);
 const state = states?.[0];
 const coverage=state?.covered_until || (state?.page_token ? state.window_start : state?.window_end);
 const start=coverage ? Date.parse(coverage)-60000 : cutoff-30*86400000;
 const until = state?.page_token ? state.window_end : new Date(Math.min(cutoff,start+30*86400000)).toISOString();
 const since = state?.page_token ? state.window_start : new Date(start).toISOString();
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
 await rpc('ara_commit_mail_page_v2', { p_actor: actorId, p_start: since, p_end: until, p_version:state?.cursor_version||0,
  p_next_page: result.nextPageToken || '', p_rows: rows }, fetchImpl);
 const coveredUntil=result.nextPageToken ? (coverage || since) : until;
 return { ...await listUnlinkedMail({actorId},fetchImpl), has_more: Boolean(result.nextPageToken)||Date.parse(coveredUntil)<cutoff,
  attempted_at:attemptedAt,last_successful_page_at:new Date().toISOString(),covered_until:coveredUntil,captured_cutoff:new Date(cutoff).toISOString() };
};
const reviewUnlinkedMail = async ({messageId,attachmentId},fetchImpl=fetch) => {
 if(!validGmailId(messageId))throw Error('invalid_mail_decision');
 await assertBusinessMailbox(fetchImpl);
 const candidates=await supabaseRequest(`/rest/v1/ara_unlinked_mail?gmail_message_id=eq.${messageId}&decision=eq.pending&select=*&limit=1`,{},fetchImpl);
 if(!candidates?.[0]||await getGlobalThreadLink(candidates[0].gmail_thread_id,fetchImpl))throw Error('mail_link_conflict');
 const raw=await gmailMessage(messageId,fetchImpl),mail=normalizeMessage(raw);
 if(mail.id!==messageId||mail.thread_id!==candidates[0].gmail_thread_id||mail.direction!=='inbound')throw Error('invalid_mail_decision');
 if(attachmentId){
  const part=mail.attachments.find(a=>a.gmail_attachment_id===attachmentId);
  if(!part||part.size>15000000)throw Error('invalid_gmail_attachment');
  const r=await gmailJson(`/messages/${messageId}/attachments/${encodeURIComponent(attachmentId)}`,{},fetchImpl);
  const bytes=Buffer.from(r.data||'','base64url');if(!bytes.length||bytes.length>15000000)throw Error('invalid_gmail_attachment');
  return {filename:require('./_pa-gmail.cjs').safeAttachmentFilename(part.filename),mime_type:part.mime_type,size:bytes.length,bytes};
 }
 return {...mail,body_html:'',customer_candidate:mail.reply_to||mail.from_address,customer_confirmed:false};
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
module.exports = { assertBusinessMailbox, listUnlinkedMail, syncUnlinkedMail, decideUnlinkedMail, reviewUnlinkedMail };
