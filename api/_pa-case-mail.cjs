'use strict';
// CASE DESK orchestration over the existing Gmail MIME/OAuth, ledger and sync.
// Existing reply/commercial send paths remain unchanged.
const crypto=require('node:crypto'),mail=require('./_pa-mail.cjs'),gmail=require('./_pa-gmail.cjs');
const oldOps=require('./_pa-reply-operations.cjs'),proof=require('./_pa-reply-proof.cjs');
const hash=oldOps.hash,uuid=mail.isUuid,ids=gmail.validGmailId;
const address=v=>String(v||'').trim().toLowerCase();
const valid=v=>/^[^\s<>@,;\r\n]+@[^\s<>@,;\r\n]+\.[^\s<>@,;\r\n]+$/u.test(v)&&v!==mail.OFFICIAL_EMAIL&&!/(?:^|[+._-])(?:no-?reply|notifications?)(?:[+._-]|@)|@(?:[^@.]+\.)?formspree\.io$/iu.test(v);
const unique=v=>[...new Set(v.map(address).filter(valid))].sort();
const canonical=v=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))):x);
async function rows(table,q,f){const v=await mail.supabaseRequest('/rest/v1/'+table+'?'+new URLSearchParams(q),{},f);if(!Array.isArray(v))throw Error('case_mail_read_unavailable');return v;}
async function rpc(actorId,action,payload,f){const v=await mail.supabaseRequest('/rest/v1/rpc/pa_case_mail_operation_v1',{method:'POST',body:JSON.stringify({p_actor:actorId,p_action:action,p_payload:payload})},f);if(v?.ok!==true)throw Error('case_mail_operation_unavailable');return v;}
function safe(o){if(!o)return null;return {...oldOps.safe(o),gmail_thread_id:o.gmail_thread_id||null,kind:o.binding.kind,purpose:o.binding.purpose,recipient:o.binding.to,subject:o.binding.subject,attachments:o.binding.attachments,invoice:o.binding.invoice||null,formal_invoice_dispatched:false};}
async function boundRecipientEvidence(inquiry,recipient,cc,allowed,f){
 const wanted=[...new Set([recipient,...cc].filter(v=>!allowed.includes(v)))];if(!wanted.length)return [];
 const index=await rows('pa_gmail_message_index',{inquiry_id:'eq.'+inquiry.id,select:'gmail_message_id,gmail_thread_id,from_address,to_addresses,cc_addresses',order:'indexed_at.desc',limit:'200'},f);
 const verified=[],cache=new Map();
 for(const target of wanted){
  let found=null;
  const candidates=index.filter(m=>[m.from_address,...(m.to_addresses||[]),...(m.cc_addresses||[])].map(address).includes(target)).slice(0,10);
  for(const candidate of candidates){
   if(!ids(candidate.gmail_message_id)||!ids(candidate.gmail_thread_id))continue;
   if(!cache.has(candidate.gmail_message_id)){
    if(cache.size>=10)throw Error('case_mail_recipient_unverified');
    const [links,owners,raw]=await Promise.all([rows('pa_gmail_thread_links',{gmail_thread_id:'eq.'+candidate.gmail_thread_id,select:'inquiry_id',limit:'3'},f),rows('pa_gmail_message_index',{gmail_message_id:'eq.'+candidate.gmail_message_id,select:'inquiry_id,gmail_thread_id',limit:'3'},f),gmail.gmailMessage(candidate.gmail_message_id,f)]);
    const m=gmail.normalizeMessage(raw),headerNames=(raw.payload?.headers||[]).map(h=>String(h.name).toLowerCase());
    if(links.length!==1||links[0].inquiry_id!==inquiry.id||owners.length!==1||owners[0].inquiry_id!==inquiry.id||owners[0].gmail_thread_id!==candidate.gmail_thread_id||m.id!==candidate.gmail_message_id||m.thread_id!==candidate.gmail_thread_id||m.reply_identity_invalid||!/^<[^<>\s]{1,998}>$/u.test(m.rfc_message_id)||['to','cc','message-id'].some(n=>headerNames.filter(x=>x===n).length>1))throw Error('reply_operation_mismatch');
    const customer=address(inquiry.email),participants=[m.from_address,m.reply_to,...m.to_addresses,...m.cc_addresses].map(address);
    if(!participants.includes(customer)||m.direction==='outbound'&&(address(m.from_address)!==mail.OFFICIAL_EMAIL||!raw.labelIds?.includes('SENT'))){cache.set(candidate.gmail_message_id,null);continue;}
    cache.set(candidate.gmail_message_id,{id:m.id,thread_id:m.thread_id,from:m.from_address,to:m.to_addresses,cc:m.cc_addresses,reply_to:m.reply_to,rfc:m.rfc_message_id});
   }
   const evidence=cache.get(candidate.gmail_message_id);if(!evidence)continue;if([evidence.from,evidence.reply_to,...evidence.to,...evidence.cc].map(address).includes(target)){found=evidence;break;}
  }
  verified.push({recipient:target,verified:!!found,source:found});
 }return verified;
}
async function authority(input,f=fetch){
 if(!uuid(input.inquiry_id)||!['reply','contact','new'].includes(input.kind)||!['general','invoice'].includes(input.purpose||'general'))throw Error('invalid_case_mail');
 const purpose=input.purpose||'general';
 const inquiry=await mail.getInquiry(input.inquiry_id,f);let source=null,raw=null;
 const customer=address(inquiry.email);if(!valid(customer))throw Error('case_mail_recipient_unverified');
 if(input.source_id||input.thread_id){
  if(!ids(input.source_id)||!ids(input.thread_id))throw Error('invalid_reply_source');
  const [links,index]=await Promise.all([rows('pa_gmail_thread_links',{gmail_thread_id:'eq.'+input.thread_id,select:'inquiry_id',limit:'3'},f),rows('pa_gmail_message_index',{gmail_message_id:'eq.'+input.source_id,select:'inquiry_id,gmail_thread_id',limit:'3'},f)]);
  if(links.length!==1||links[0].inquiry_id!==inquiry.id||index.length!==1||index[0].inquiry_id!==inquiry.id||index[0].gmail_thread_id!==input.thread_id)throw Error('reply_operation_mismatch');
  raw=await gmail.gmailMessage(input.source_id,f);source=gmail.normalizeMessage(raw);
  const headers=raw.payload?.headers||[];for(const name of ['from','to','cc','subject','message-id','references']){const found=headers.filter(h=>String(h.name).toLowerCase()===name);if(found.length>1||found.some(h=>/[\r\n]/u.test(h.value)))throw Error('invalid_reply_source');}
  if(source.id!==input.source_id||source.thread_id!==input.thread_id||source.reply_identity_invalid||!/^<[^<>\s]{1,998}>$/u.test(source.rfc_message_id))throw Error('invalid_reply_source');
  if(source.direction==='outbound'){
   if(address(source.from_address)!==mail.OFFICIAL_EMAIL||!source.to_addresses.map(address).includes(customer)||!raw.labelIds?.includes('SENT')||(source.reply_to&&address(source.reply_to)!==mail.OFFICIAL_EMAIL))throw Error('case_mail_recipient_unverified');
  }else{
   const from=address(source.from_address),relay=/@(?:[^@.]+\.)?formspree\.io$/iu.test(from);
   if(relay){if(inquiry.first_form_data?.import_source!=='gmail_owner_confirmed'||inquiry.first_form_data.gmail_message_id!==source.id||inquiry.first_form_data.gmail_thread_id!==source.thread_id||address(source.reply_to)!==customer)throw Error('case_mail_recipient_unverified');}
   else if(!valid(from)||(source.reply_to&&address(source.reply_to)!==from)||from!==customer&&![...source.to_addresses,...source.cc_addresses].map(address).includes(customer))throw Error('case_mail_recipient_unverified');
  }
 }else if(input.kind!=='new')throw Error('invalid_reply_source');
 if(source?.direction==='inbound'&&['gmail_owner_confirmed','general_public_form'].includes(inquiry.first_form_data?.import_source)&&address(source.reply_to||source.from_address)!==customer)throw Error('case_mail_recipient_unverified');
 const allowed=unique([customer,...(source?[source.from_address,source.reply_to,...source.to_addresses,...source.cc_addresses]:[])]);
 const recipient=input.to==null?(source?.direction==='inbound'&&valid(address(source.reply_to||source.from_address))?address(source.reply_to||source.from_address):customer):address(input.to);
 if(!valid(recipient))throw Error('case_mail_recipient_unverified');
 const cc=input.cc==null?[]:input.cc;if(!Array.isArray(cc)||cc.length>30||cc.some(v=>!valid(address(v))||address(v)===recipient))throw Error('invalid_reply_cc');
 const ccAddresses=[...new Set(cc.map(address))].sort();
 const recipientEvidence=await boundRecipientEvidence(inquiry,recipient,ccAddresses,allowed,f);
 for(const evidence of recipientEvidence)if(evidence.verified&&!allowed.includes(evidence.recipient))allowed.push(evidence.recipient);allowed.sort();
 const unverifiedRecipients=recipientEvidence.filter(e=>!e.verified).map(e=>e.recipient);
 const sourceSubject=source?proof.subject(source.subject):'';
 const subject=input.subject==null?(input.kind==='new'?(purpose==='invoice'?'請求書送付のご案内':''):gmail.replySubject(sourceSubject)):String(input.subject);
 if(subject&&(/[\r\n\u0000-\u001f]/u.test(subject)||subject.length>240))throw Error('invalid_subject');
 const evidence={case_id:inquiry.id,customer,recipient_evidence:recipientEvidence,source:source?{id:source.id,thread_id:source.thread_id,from:source.from_address,reply_to:source.reply_to,to:source.to_addresses,cc:source.cc_addresses,rfc:source.rfc_message_id,references:source.references}:null};
 let invoice=null;
 if(purpose==='invoice')try{
  const [contracts,billings,events]=await Promise.all([rows('pa_contracts',{inquiry_id:'eq.'+inquiry.id,select:'id,version,snapshot,snapshot_sha256',order:'version.desc',limit:'2'},f),rows('pa_billings',{inquiry_id:'eq.'+inquiry.id,select:'id,amount_minor,invoice_document_id,invoice_policy',order:'billing_number.desc',limit:'100'},f),rows('pa_change_evidence_events',{inquiry_id:'eq.'+inquiry.id,event_kind:'in.(adopted,revoked)',select:'id,event_kind,evidence,event_number',order:'event_number.desc',limit:'1'},f)]);
  const documentIds=[...new Set(billings.map(b=>b.invoice_document_id).filter(uuid))];
  const documents=documentIds.length?await rows('pa_commercial_documents',{inquiry_id:'eq.'+inquiry.id,id:'in.('+documentIds.join(',')+')',select:'id,sha256',limit:'100'},f):[];
  const contract=contracts[0]||null,adopted=events[0]?.event_kind==='adopted'?events[0]:null;
  const snapshot=contract?.snapshot;const contractAmount=snapshot?.estimate?.amount_minor??snapshot?.quote?.amount_minor??snapshot?.amount_minor??null;
  invoice={contract_id:contract?.id||null,contract_amount_minor:contractAmount,adopted_amount_minor:adopted?.evidence?.quote?.amount_minor??null,adoption_id:adopted?.id||null,adopted_quote_sha256:adopted?.evidence?.quote?.sha256||null,billings:billings.map(b=>({id:b.id,amount_minor:b.amount_minor,document_id:b.invoice_document_id,document_sha256:documents.find(d=>d.id===b.invoice_document_id)?.sha256||null,policy:b.invoice_policy})),formal_billing_created:false};
 }catch{invoice={context_unavailable:true,formal_billing_created:false};}
 return {case_email:customer,inquiry_id:inquiry.id,case_number:inquiry.inquiry_number,case_name:inquiry.event_name,kind:input.kind,purpose,source_id:source?.id||null,thread_id:source?.thread_id||null,source_rfc:source?.rfc_message_id||null,source_references:source?.references||'',source_subject:sourceSubject,source_direction:source?.direction||null,to:recipient,cc:ccAddresses,allowed_recipients:allowed,unverified_recipients:unverifiedRecipients,recipient_confirmation_needed:unverifiedRecipients.length>0,subject,authority_hash:hash(canonical(evidence)),invoice};
}
function token(payload){const key=String(process.env.SUPABASE_SERVICE_ROLE_KEY||'');if(!key)throw Error('case_mail_unavailable');const data=Buffer.from(JSON.stringify(payload)).toString('base64url');return data+'.'+crypto.createHmac('sha256',key).update('PAUI-062:'+data).digest('base64url');}
function verify(tokenValue){try{const [data,sig,...extra]=String(tokenValue).split('.');const expected=token(JSON.parse(Buffer.from(data,'base64url'))).split('.')[1];if(extra.length||!sig||sig.length!==expected.length||!crypto.timingSafeEqual(Buffer.from(sig),Buffer.from(expected)))throw Error();const p=JSON.parse(Buffer.from(data,'base64url'));if(p.expires_at<=Date.now())throw Error();return p;}catch{throw Error('invalid_confirmation');}}
function binding(a,input){
 const attachments=mail.normalizeReplyAttachments(input.attachments||[]),body=mail.normalizeCustomerBody(mail.cleanBody(input.body));
 if(!a.subject||!String(input.body||'').trim()||String(input.body).length>20000)throw Error('invalid_case_mail');
 const manifest=attachments.map(x=>({filename:x.filename,mime_type:x.mime_type,size:x.size,sha256:hash(Buffer.from(x.data,'base64url')),...(x.document_kind?{document_kind:x.document_kind}:{})}));
 return {b:{contract:'PAUI-062',account:mail.OFFICIAL_EMAIL,case_email:a.case_email,inquiry_id:a.inquiry_id,kind:a.kind,thread_id:a.thread_id,source_id:a.source_id,source_rfc:a.source_rfc,authority_hash:a.authority_hash,unverified_recipients:a.unverified_recipients,to:a.to,cc:a.cc,subject:a.subject,body_sha256:hash(body),attachments:manifest},body,attachments};
}
async function preview(input,actorId,f=fetch){const a=await authority(input,f),{b,body,attachments}=binding(a,input);if(!(await gmail.mailboxProfile(f)).matchesOfficialMailbox)throw Error('gmail_mailbox_mismatch');const row=await rpc(actorId,'prepare',{operation_id:crypto.randomUUID(),inquiry_id:a.inquiry_id,binding:b,binding_hash:hash(canonical(b)),new_operation:input.new_operation===true,previous_operation_id:input.previous_operation_id||null},f);const o=row.operation;
 return {...a,body,html:mail.buildCustomerHtml(body),attachments:b.attachments,unverified_recipients:b.unverified_recipients,recipient_confirmation_needed:b.unverified_recipients.length>0,operation:safe(o),operation_id:o.operation_id,expires_at:o.expires_at,confirmation_token:token({actor_id:actorId,inquiry_id:a.inquiry_id,operation_id:o.operation_id,binding_hash:hash(canonical(b)),expires_at:Date.parse(o.expires_at)})};}
async function status(input,actorId,f=fetch){const row=await rpc(actorId,'get',{inquiry_id:input.inquiry_id,operation_id:input.operation_id||null},f);return {operation:safe(row.operation)};}
async function send(input,actorId,f=fetch){
 const signed=verify(input.confirmation_token);if(signed.actor_id!==actorId||signed.inquiry_id!==input.inquiry_id||signed.operation_id!==input.operation_id||input.owner_confirmed!==true)throw Error('invalid_confirmation');
 let o=(await rpc(actorId,'get',{inquiry_id:input.inquiry_id,operation_id:input.operation_id},f)).operation;
 if(o.binding_hash!==signed.binding_hash)throw Error('reply_operation_mismatch');
 let claimed=false,started=false;
 try{
  const a=await authority(input,f),{b,body,attachments}=binding(a,input);
  if(hash(canonical(b))!==signed.binding_hash||b.unverified_recipients.length&&input.unverified_recipients_confirmed!==true)throw Error('invalid_confirmation');
  if(o.state==='SENT')return {operation:safe(o),gmail_message_id:o.gmail_message_id,gmail_thread_id:o.gmail_thread_id,already_sent:true,history_sync:o.history_sync};
  if(o.state!=='PREPARED'||Date.parse(o.expires_at)<=Date.now())throw Error('reply_operation_blocked');
  const config=mail.mailConfig(),access=await mail.getGmailAccessToken(config,f);
  if(!(await gmail.mailboxProfile(f)).matchesOfficialMailbox)throw Error('gmail_mailbox_mismatch');
  const fresh=await authority(input,f);if(fresh.authority_hash!==a.authority_hash)throw Error('case_mail_stale');
  const claim=await rpc(actorId,'claim',{inquiry_id:a.inquiry_id,operation_id:o.operation_id},f);if(!claim.claimed)throw Error('reply_operation_blocked');claimed=true;
  const raw=mail.buildRawMessage({to:b.to,cc:b.cc,subject:b.subject,body,messageType:'customer_receipt',config,attachments,messageId:oldOps.rfcId(o.operation_id),replyHeaders:b.kind==='new'?{}:{inReplyTo:a.source_rfc,references:gmail.replyReferences(a.source_references,a.source_rfc)}});
  // A changed subject starts a new Gmail thread. Its ACK is persisted separately
  // from the verified source thread; no invented thread identity is recorded.
  const sameThread=b.kind!=='new'&&b.subject===gmail.replySubject(a.source_subject);
  started=true;
  const response=await f('https://gmail.googleapis.com/gmail/v1/users/me/messages/send',{method:'POST',headers:{authorization:'Bearer '+access,'content-type':'application/json',accept:'application/json'},body:JSON.stringify({...(sameThread?{threadId:a.thread_id}:{}),raw})});
  if(!response.ok)throw Error('gmail_send_'+response.status);const ack=await response.json();if(!ids(ack.id)||!ids(ack.threadId))throw Error('gmail_send_invalid');
  o=(await rpc(actorId,'sent',{inquiry_id:a.inquiry_id,operation_id:o.operation_id,gmail_message_id:ack.id,gmail_thread_id:ack.threadId},f)).operation;
  let complete=true;
  try{
   await mail.supabaseRequest('/rest/v1/pa_inquiry_audit',{method:'POST',prefer:'return=representation',body:JSON.stringify({inquiry_id:a.inquiry_id,actor_user_id:actorId,action:'gmail_case_message_sent',details:{operation_id:o.operation_id,communication_kind:b.kind,entry_context:a.purpose,gmail_message_id:ack.id,gmail_thread_id:ack.threadId,reply_source_message_id:a.source_id,attachments:b.attachments,formal_billing_created:false,formal_invoice_dispatched:false,attachment_filenames:b.attachments.map(x=>x.filename)}})},f);
   await mail.supabaseRequest('/rest/v1/pa_inquiry_audit',{method:'POST',prefer:'return=representation',body:JSON.stringify({inquiry_id:a.inquiry_id,actor_user_id:actorId,action:'gmail_case_reply_sent',details:{operation_id:o.operation_id,communication_kind:b.kind,gmail_message_id:ack.id,gmail_thread_id:ack.threadId,attachment_count:b.attachments.length,attachment_filenames:b.attachments.map(x=>x.filename)}})},f);
   // Existing binding/sync path, only after an actual ACK. It rejects foreign links.
   const linked=await gmail.getGlobalThreadLink(ack.threadId,f);
   if(linked){if(linked.inquiry_id!==a.inquiry_id)throw Error('reply_operation_mismatch');await gmail.syncCase({inquiryId:a.inquiry_id,actorId},f);}
   else await gmail.manualLink({inquiryId:a.inquiry_id,gmailThreadId:ack.threadId,conversationRole:'secondary_conversation',actorId},f);
  }catch{complete=false;}
  try{o=(await rpc(actorId,'history',{inquiry_id:a.inquiry_id,operation_id:o.operation_id,complete},f)).operation;}catch{complete=false;}
  return {operation:safe(o),gmail_message_id:ack.id,gmail_thread_id:ack.threadId,history_sync:complete?'COMPLETE':'INCOMPLETE',formal_billing_created:false,formal_invoice_dispatched:false};
 }catch(e){if(claimed||!started&&!['invalid_confirmation','reply_operation_blocked'].includes(e.message)){try{await rpc(actorId,started?'unknown':'failed',{inquiry_id:input.inquiry_id,operation_id:o.operation_id},f);}catch{}}if(started)throw Error('reply_operation_unknown');throw e;}
}
async function inspectNew(message,b,f){
 const n=gmail.normalizeMessage(message),headers=message.payload?.headers||[];
 const values=name=>headers.filter(h=>String(h.name).toLowerCase()===name).map(h=>String(h.value));
 if(!ids(message.id)||!message.labelIds?.includes('SENT')||n.thread_id!==b.thread_id||!proof.rfc(message)
  ||values('in-reply-to').length||values('references').length||values('from').length!==1||values('to').length!==1||values('cc').length>1||values('bcc').length||values('subject').length!==1
  ||n.reply_identity_invalid||address(n.from_address)!==b.account||JSON.stringify([...new Set(n.to_addresses.map(address))].sort())!==JSON.stringify([b.to])||JSON.stringify([...new Set(n.cc_addresses.map(address))].sort())!==JSON.stringify(b.cc)
  ||proof.subject(values('subject')[0])!==b.subject||hash(mail.normalizeCustomerBody(n.body_text))!==b.body_sha256||n.attachments.length!==b.attachments.length)return false;
 const parts=[];const collect=p=>{if(!p)return;parts.push(p);for(const x of p.parts||[])collect(x);};collect(message.payload);
 for(let i=0;i<n.attachments.length;i++){const a=n.attachments[i],expected=b.attachments[i];if(a.filename!==expected.filename||a.mime_type!==expected.mime_type||a.size!==expected.size)return false;
  const data=a.gmail_attachment_id?(await gmail.gmailJson('/messages/'+encodeURIComponent(n.id)+'/attachments/'+encodeURIComponent(a.gmail_attachment_id),{method:'GET'},f)).data:parts.find(p=>String(p.partId||'')===a.part_id)?.body?.data;
  if(typeof data!=='string'||data.length>4500000||hash(Buffer.from(data,'base64url'))!==expected.sha256)return false;
 }return true;
}
async function reconcile(input,actorId,f=fetch){
 let o=(await rpc(actorId,'get',{inquiry_id:input.inquiry_id,operation_id:input.operation_id},f)).operation;if(!o||!['SENT','SENDING','UNKNOWN'].includes(o.state))return {operation:safe(o),verified:false};
 const b=o.binding;const a=await authority({inquiry_id:b.inquiry_id,kind:b.kind,purpose:b.purpose,source_id:b.source_id,thread_id:b.thread_id,to:b.to,cc:b.cc,subject:b.subject},f);if(a.authority_hash!==b.authority_hash)throw Error('case_mail_stale');
 let message=null,verified=false;
 try{
  if(o.gmail_message_id)message=await gmail.gmailMessage(o.gmail_message_id,f);
  else {const found=await gmail.gmailJson('/messages?'+new URLSearchParams({q:'in:sent rfc822msgid:'+oldOps.rfcId(o.operation_id),maxResults:'2'}),{method:'GET'},f);if(!found.nextPageToken&&found.messages?.length===1){message=await gmail.gmailMessage(found.messages[0].id,f);if(proof.rfc(message)!==oldOps.rfcId(o.operation_id))message=null;}}
  if(message){
   // Reuse PAUI-049 full proof for replies; new mail checks actual headers only.
   const expected={...b,thread_id:o.gmail_thread_id||message.threadId};
   verified=b.kind==='new'?await inspectNew(message,expected,f):(await proof.inspect(message,expected,gmail.normalizeMessage,(p,opt)=>gmail.gmailJson(p,opt,f))).binding_matches;
  }
 }catch{verified=false;}
 if(verified&&o.state!=='SENT')o=(await rpc(actorId,'sent',{inquiry_id:b.inquiry_id,operation_id:o.operation_id,gmail_message_id:message.id,gmail_thread_id:message.threadId},f)).operation;
 const verification=verified?{status:'VERIFIED',occurred_at:gmail.normalizeMessage(message).occurred_at,attachments:gmail.normalizeMessage(message).attachments.map((a,i)=>({filename:a.filename,mime_type:a.mime_type,size:a.size,part_id:a.part_id,sha256:b.attachments[i].sha256}))}:null;
 return {operation:safe(o),verified,verification,reason:verified?'EXACT_PROVIDER_RECORD':'UNKNOWN_NO_UNIQUE_PROOF',automatic_resend:false};
}
module.exports={authority,binding,preview,status,send,reconcile,rpc,safe,canonical};
