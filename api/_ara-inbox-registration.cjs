'use strict';
// Selected-message review over existing authenticated Gmail reads and inbox RPC.
const crypto=require('node:crypto'),mail=require('./_pa-mail.cjs'),gmail=require('./_pa-gmail.cjs');
const addr=v=>String(v||'').trim().toLowerCase();
const customer=v=>/^[^\s<>@,;\r\n]+@[^\s<>@,;\r\n]+\.[^\s<>@,;\r\n]+$/u.test(v)&&v!==mail.OFFICIAL_EMAIL&&!/(?:no-?reply|notification)|@(?:[^@.]+\.)?formspree\.(?:io|invalid)$/iu.test(v);
const digest=v=>crypto.createHash('sha256').update(v).digest('hex');
function secret(){const s=String(process.env.SUPABASE_SERVICE_ROLE_KEY||'');if(s.length<24)throw Error('inbox_review_unavailable');return s;}
function sign(p){const v=Buffer.from(JSON.stringify(p)).toString('base64url');return v+'.'+crypto.createHmac('sha256',secret()).update(v).digest('base64url');}
function verify(token,actorId){try{const [v,s,...extra]=String(token||'').split('.'),expected=crypto.createHmac('sha256',secret()).update(v).digest('base64url');if(extra.length||!s||s.length!==expected.length||!crypto.timingSafeEqual(Buffer.from(s),Buffer.from(expected)))throw Error();const p=JSON.parse(Buffer.from(v,'base64url'));if(p.purpose!=='inbox-message-review-v1'||p.actor!==actorId||!Number.isFinite(p.expires)||Date.now()>p.expires)throw Error();return p;}catch{throw Error('inbox_review_stale');}}
async function authority(messageId,fetchImpl=fetch){
 if(!gmail.validGmailId(messageId))throw Error('invalid_mail_decision');
 const profile=await gmail.gmailJson('/profile',{},fetchImpl);if(addr(profile.emailAddress)!==mail.OFFICIAL_EMAIL)throw Error('gmail_mailbox_mismatch');
 const rows=await mail.supabaseRequest('/rest/v1/ara_unlinked_mail?gmail_message_id=eq.'+encodeURIComponent(messageId)+'&select=*&limit=1',{},fetchImpl);const candidate=rows?.[0];
 if(!candidate||candidate.decision!=='pending')throw Error('mail_link_conflict');
 const raw=await gmail.gmailMessage(messageId,fetchImpl),m=gmail.normalizeMessage(raw);
 if(m.id!==messageId||m.thread_id!==candidate.gmail_thread_id||m.direction!=='inbound'||(raw.labelIds||[]).some(x=>['SENT','TRASH','SPAM','DRAFT'].includes(x)))throw Error('invalid_mail_decision');
 const headers=raw.payload?.headers||[];if(m.reply_identity_invalid||['to','cc','subject','message-id'].some(n=>headers.filter(h=>String(h.name).toLowerCase()===n).length>1)||!m.to_addresses.map(addr).includes(mail.OFFICIAL_EMAIL)||!/^<[^<>\s]{1,998}>$/u.test(m.rfc_message_id))throw Error('mail_identity_review_required');
 const relay=/@(?:[^@.]+\.)?formspree\.io$/iu.test(m.from_address),recipient=addr(relay?m.reply_to:m.from_address);
 const eligible=customer(recipient)&&(relay?!!m.reply_to:!m.reply_to||addr(m.reply_to)===recipient);
 const body=String(m.body_text||'');if(body.length>20000)throw Error('mail_identity_review_required');
 const binding={message:m.id,thread:m.thread_id,from:m.from_address,reply:m.reply_to,to:m.to_addresses,cc:m.cc_addresses,subject:m.subject,rfc:m.rfc_message_id,body_sha256:digest(body),occurred_at:m.occurred_at,attachments:m.attachments.map(a=>[a.part_id,a.original_filename,a.mime_type,a.size])};
 return {m,body,relay,recipient,eligible,fingerprint:digest(JSON.stringify(binding))};
}
async function review({messageId,actorId},f=fetch){if(!mail.isUuid(actorId))throw Error('not_authorized');const a=await authority(messageId,f);return {...a.m,body_html:'',customer_candidate:a.eligible?a.recipient:null,customer_confirmed:false,identity_source:a.relay?'relay_reply_to':'sender',registration_blocked:!a.eligible,review_token:a.eligible?sign({purpose:'inbox-message-review-v1',actor:actorId,message:a.m.id,thread:a.m.thread_id,fingerprint:a.fingerprint,expires:Date.now()+10*60000}):null};}
async function register(input,f=fetch){
 if(input.identityConfirmed!==true||input.caseType!=='OTHER'||!mail.isUuid(input.actorId)||!String(input.customerName||'').trim()||String(input.customerName).length>160)throw Error('mail_identity_review_required');
 const p=verify(input.reviewToken,input.actorId);if(p.message!==input.messageId)throw Error('inbox_review_stale');
 const a=await authority(input.messageId,f);if(!a.eligible||p.thread!==a.m.thread_id||p.fingerprint!==a.fingerprint||addr(input.customerEmail)!==a.recipient)throw Error('mail_identity_review_required');
 const proof={server_verified:true,owner_confirmed:true,gmail_message_id:a.m.id,gmail_thread_id:a.m.thread_id,from_address:a.m.from_address,reply_to:a.m.reply_to,to_addresses:a.m.to_addresses,cc_addresses:a.m.cc_addresses,customer_email:a.recipient,subject:a.m.subject,received_at:a.m.occurred_at,body_sha256:digest(a.body),fingerprint:a.fingerprint,attachment_metadata:a.m.attachments,identity_source:a.relay?'relay_reply_to':'sender'};
 try{return await mail.supabaseRequest('/rest/v1/rpc/ara_decide_mail',{method:'POST',body:JSON.stringify({p_actor:input.actorId,p_message:input.messageId,p_action:'create',p_case:null,p_customer:String(input.customerName).trim(),p_email:a.recipient,p_type:'OTHER',p_content:a.body,p_review:proof})},f);}catch(e){throw Error(e.safeDatabaseReason||'inbox_registration_unavailable');}
}
module.exports={review,register};
