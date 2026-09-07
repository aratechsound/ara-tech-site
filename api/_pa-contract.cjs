const crypto=require('node:crypto');
const mail=require('./_pa-mail.cjs');
const gmail=require('./_pa-gmail.cjs');
const pdf=require('./_pa-contract-pdf.cjs');
const {terms}=require('./_pa-contract-terms.cjs');
const TOKEN=/^[a-f0-9]{64}$/;
const SAFE=new Set(['not_authorized','case_unavailable','case_changed','quote_case_mismatch','quote_identity_mismatch','invalid_contract','invalid_link','expired_link','contract_changed','consent_required','receipt_unavailable','delivery_replay','delivery_in_progress','resend_ack_required']);
const uuid=v=>{if(!mail.isUuid(v))throw Error('invalid_contract');return v;};
const text=(v,max)=>{const s=String(v||'').trim();if(!s||s.length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(s))throw Error('invalid_contract');return s;};
const fromBytea=v=>{if(typeof v!=='string'||!/^\\x[0-9a-f]+$/i.test(v))throw Error('quote_missing');return Buffer.from(v.slice(2),'hex');};
const address=v=>String(v||'').trim().match(/<?([^<>\s,;]+@[^<>\s,;]+)>?/u)?.[1]?.toLowerCase()||'';
function createService({fetchImpl=fetch,mergeReceipt=pdf.mergeReceipt}={}) {
 const db=async(path,options={})=>{
  const {url,serviceRoleKey}=mail.supabaseConfig();
  const r=await fetchImpl(url+'/rest/v1/'+path,{...options,headers:{apikey:serviceRoleKey,authorization:`Bearer ${serviceRoleKey}`,'content-type':'application/json',prefer:'return=representation',...(options.headers||{})}});
  if(!r.ok){let data;try{data=await r.json();}catch{}throw Error(SAFE.has(data?.message)?data.message:'service_unavailable');}
  return r.status===204?null:r.json();
 };
 const rpc=(name,input)=>db('rpc/'+name,{method:'POST',body:JSON.stringify(input)});
 const one=async(table,params)=>{const rows=await db(table+'?'+new URLSearchParams({...params,limit:'1'}));return rows?.[0]||null;};
 async function inquiry(id){return mail.getInquiry(uuid(id),fetchImpl);}
 async function quoteSource(caseId,messageId,attachmentId){
  const i=await inquiry(caseId);
  const row=await one('pa_gmail_message_index',{inquiry_id:`eq.${caseId}`,gmail_message_id:`eq.${text(messageId,200)}`,select:'*'});
  if(!row||row.direction!=='outbound'||!row.to_addresses.some(v=>address(v)===address(i.email)))throw Error('quote_case_mismatch');
  const link=await one('pa_gmail_thread_links',{inquiry_id:`eq.${caseId}`,gmail_thread_id:`eq.${row.gmail_thread_id}`,conversation_role:'eq.primary_conversation',select:'id'});
  if(!link)throw Error('quote_case_mismatch');
  const attachment=await gmail.getAttachmentBinary({inquiryId:caseId,gmailMessageId:messageId,gmailAttachmentId:attachmentId},fetchImpl);
  if(attachment.mime_type!=='application/pdf'||!attachment.filename.toLowerCase().endsWith('.pdf'))throw Error('invalid_pdf');
  await pdf.validatePdf(attachment.bytes);
  return {inquiry:i,bytes:attachment.bytes,identity:{file_id:`gmail:${messageId}:${attachmentId}`,gmail_message_id:messageId,gmail_attachment_id:attachmentId,filename:attachment.filename,sha256:pdf.sha(attachment.bytes),size:attachment.bytes.length}};
 }
 async function offers(caseId){
  await inquiry(caseId);
  const rows=await db('pa_contract_offers?'+new URLSearchParams({inquiry_id:`eq.${caseId}`,select:'id,version,issued_at,expires_at,snapshot',order:'version.desc',limit:'50'}));
  const contracts=await db('pa_contracts?'+new URLSearchParams({inquiry_id:`eq.${caseId}`,select:'id,version,confirmed_at,snapshot',order:'version.desc',limit:'50'}));
  const history=[];
  for(const o of rows){
   const token=await one('pa_contract_tokens',{offer_id:`eq.${o.id}`,select:'state'});
   const c=contracts.find(v=>v.id===o.id);
   const receipt=c?await one('pa_contract_receipts',{contract_id:`eq.${o.id}`,select:'sha256,created_at'}):null;
   const delivery=c?await one('pa_contract_deliveries',{contract_id:`eq.${o.id}`,select:'id,status,created_at,finished_at,error_code,gmail_message_id',order:'created_at.desc,id.desc'}):null;
   history.push({...o,state:c?'accepted':token?.state==='active'&&Date.now()>=Date.parse(o.expires_at)?'expired':token?.state,confirmed_at:c?.confirmed_at,receipt,delivery});
  }
  const messages=await db('pa_gmail_message_index?'+new URLSearchParams({inquiry_id:`eq.${caseId}`,direction:'eq.outbound',select:'gmail_message_id,subject,sent_at,attachment_metadata',order:'sent_at.desc',limit:'100'}));
  return {history,quotes:messages.flatMap(m=>(m.attachment_metadata||[]).filter(a=>a.mime_type==='application/pdf'||String(a.filename).toLowerCase().endsWith('.pdf')).map(a=>({gmail_message_id:m.gmail_message_id,gmail_attachment_id:a.id,filename:a.filename,sent_at:m.sent_at,subject:m.subject})))};
 }
 async function issue(input,actor){
  const src=await quoteSource(input.case_id,input.gmail_message_id,input.gmail_attachment_id);
  if(src.identity.sha256!==input.quote_sha256)throw Error('quote_identity_mismatch');
  const amount=Number(input.amount);if(!Number.isSafeInteger(amount)||amount<=0||amount>999999999)throw Error('invalid_contract');
  const i=src.inquiry;
  const custom=String(input.custom_payment||'').trim();
  if(custom&&(input.payment_approved!==true||custom.length>2000))throw Error('invalid_contract');
  const snapshot={event_name:text(i.event_name,200),event_date:i.event_date,recipient:i.email,customer_name:text(input.customer_name,400),confirmer_name:text(i.contact_name||i.customer_name,120),amount,request_summary:text(input.request_summary,10000),...terms(i.event_date,custom),quote:src.identity,payment_approval:custom?{actor_id:actor.id,approved_at:new Date().toISOString()}:null};
  const token=crypto.randomBytes(32).toString('hex');
  const result=await rpc('pa_contract_issue',{p_actor:actor.id,p_id:crypto.randomUUID(),p_case:i.id,p_token_hash:pdf.sha(token),p_snapshot:snapshot,p_quote:src.bytes.toString('base64')});
  return {...result,url:`https://ara-tech.cc/pa-contract.html#${token}`};
 }
 async function resolve(token){
  if(typeof token!=='string'||!TOKEN.test(token))throw Error('invalid_link');
  const t=await one('pa_contract_tokens',{token_hash:`eq.${pdf.sha(token)}`,select:'offer_id,state'});
  if(!t||t.state==='revoked')throw Error('invalid_link');
  const o=await one('pa_contract_offers',{id:`eq.${t.offer_id}`,select:'*'});
  if(!o)throw Error('invalid_link');
  if(t.state==='accepted')return {state:'accepted',offer:o};
  if(Date.now()>=Date.parse(o.expires_at))throw Error('expired_link');
  const i=await inquiry(o.inquiry_id);
  if(['closed','cancelled','declined','schedule_unavailable'].includes(i.status))throw Error('case_unavailable');
  return {state:'active',offer:o};
 }
 async function view(token){
  const {state,offer:o}=await resolve(token);
  if(state==='accepted')return {state};
  const {recipient,issued_by,payment_approval,...snapshot}=o.snapshot;
  return {state,snapshot,offer_id:o.id,snapshot_sha256:o.snapshot_sha256,expires_at:o.expires_at};
 }
 async function customerQuote(token){
  const r=await resolve(token);if(r.state!=='active')throw Error('invalid_link');
  const bytes=fromBytea(r.offer.quote_pdf);await pdf.validatePdf(bytes,r.offer.quote_sha256);
  return {bytes,filename:r.offer.snapshot.quote.filename,mime_type:'application/pdf'};
 }
 async function contract(caseId,id){
  uuid(caseId);uuid(id);await inquiry(caseId);
  const c=await one('pa_contracts',{id:`eq.${id}`,inquiry_id:`eq.${caseId}`,select:'*'});
  if(!c)throw Error('invalid_contract');return c;
 }
 async function ensureReceipt(caseId,id){
  const c=await contract(caseId,id);
  let r=await one('pa_contract_receipts',{contract_id:`eq.${id}`,select:'*'});
  if(!r){
   const o=await one('pa_contract_offers',{id:`eq.${id}`,inquiry_id:`eq.${caseId}`,select:'quote_pdf,quote_sha256'});
   if(!o)throw Error('quote_missing');
   const quote=fromBytea(o.quote_pdf);await pdf.validatePdf(quote,c.snapshot.quote.sha256);
   const merged=await mergeReceipt(c.snapshot,quote);
   try{await db('pa_contract_receipts',{method:'POST',body:JSON.stringify({contract_id:id,pdf:'\\x'+merged.bytes.toString('hex'),sha256:merged.sha256,cover_pages:merged.cover_pages,quote_pages:merged.quote_pages})});}catch(error){
    r=await one('pa_contract_receipts',{contract_id:`eq.${id}`,select:'*'});if(!r)throw error;
   }
   r=r||await one('pa_contract_receipts',{contract_id:`eq.${id}`,select:'*'});
  }
  const bytes=fromBytea(r.pdf);if(pdf.sha(bytes)!==r.sha256)throw Error('receipt_identity_mismatch');
  return {bytes,filename:`ARA-TECH-contract-v${c.version}-${c.id}.pdf`,mime_type:'application/pdf',sha256:r.sha256,snapshot:c.snapshot};
 }
 async function accept(input){
  const r=await resolve(input.token);
  if(r.state==='accepted')return {state:'accepted',already_received:true};
  if(r.offer.id!==input.offer_id)throw Error('invalid_link');
  const quote=fromBytea(r.offer.quote_pdf);await pdf.validatePdf(quote,r.offer.quote_sha256);
  const result=await rpc('pa_contract_accept',{p_token_hash:pdf.sha(input.token),p_offer_id:uuid(input.offer_id),p_snapshot_sha256:input.snapshot_sha256,p_name:input.confirmer_name,p_agree:input.agree===true});
  // Acceptance survives worker/PDF/mail failure. PDF can be retried by an admin.
  try{await ensureReceipt(r.offer.inquiry_id,r.offer.id);return {...result,receipt_status:'ready'};}catch{return {...result,receipt_status:'pending'};}
 }
 async function mailData(caseId,id,actor){
  const receipt=await ensureReceipt(caseId,id);
  const body=`${receipt.snapshot.customer_name} 様\n\n${receipt.snapshot.event_name}の正式依頼を受け付けました。\n契約控えPDFを添付いたします。\n契約ID：${id}\n契約version：${receipt.snapshot.contract_version}\n確認日時：${receipt.snapshot.confirmed_at_jst}\n\n内容をご確認のうえ保管をお願いいたします。`;
  const attachments=[{filename:receipt.filename,mime_type:'application/pdf',data:receipt.bytes.toString('base64url')}];
  const preview=await gmail.replyPreview({inquiryId:caseId,actorId:actor.id,body,attachments},fetchImpl);
  if(address(preview.recipient)!==address(receipt.snapshot.recipient))throw Error('recipient_changed');
  return {body,attachments,preview};
 }
 async function send(input,actor){
  const data=await mailData(input.case_id,input.contract_id,actor);
  await rpc('pa_contract_delivery_claim',{p_actor:actor.id,p_case:input.case_id,p_contract:input.contract_id,p_attempt:uuid(input.attempt_id),p_ack:input.acknowledge_resend===true});
  let sent,dispatched=false,rejected=false;
  const trackedFetch=async(url,options)=>{
   if(url==='https://gmail.googleapis.com/gmail/v1/users/me/messages/send'&&options?.method==='POST'){
    dispatched=true;
    const response=await fetchImpl(url,options);
    rejected=!response.ok&&response.status>=400&&response.status<500;
    return response;
   }
   return fetchImpl(url,options);
  };
  try{
   sent=await gmail.sendReply({inquiryId:input.case_id,actorId:actor.id,body:data.body,attachments:data.attachments,confirmationToken:input.confirmation_token},trackedFetch);
  }catch(e){
   const failed=!dispatched||rejected;
   const status=failed?'failed':'uncertain';
   await db('pa_contract_deliveries?'+new URLSearchParams({id:`eq.${input.attempt_id}`,status:'eq.sending'}),{method:'PATCH',body:JSON.stringify({status,finished_at:new Date().toISOString(),error_code:failed?'mail_failed':'mail_outcome_unknown'})});
   return {state:'accepted',delivery_status:status};
  }
  await db('pa_contract_deliveries?'+new URLSearchParams({id:`eq.${input.attempt_id}`,status:'eq.sending'}),{method:'PATCH',body:JSON.stringify({status:'sent',finished_at:new Date().toISOString(),gmail_message_id:sent.gmail_message_id})});
  return {state:'accepted',delivery_status:'sent'};
 }
 return {offers,quoteSource,issue,view,customerQuote,accept,ensureReceipt,mailPreview:async(input,actor)=>(await mailData(input.case_id,input.contract_id,actor)).preview,send,markUncertain:(input,actor)=>rpc('pa_contract_delivery_uncertain',{p_actor:actor.id,p_case:uuid(input.case_id),p_contract:uuid(input.contract_id)})};
}
module.exports={createService,SAFE};
