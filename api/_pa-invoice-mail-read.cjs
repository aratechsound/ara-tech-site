'use strict';
// A projection of existing send audits, the limited operation GET RPC and Gmail.
// No send, reconciliation/state transition, upload, registration or classification.
function createInvoiceMailRead({getInquiry,rows,rpc,gmailMessage,normalize,official,subject,uuid,ids}){
 const address=v=>String(v||'').trim().toLowerCase();
 const addresses=v=>[...new Set((v||[]).map(address))].sort();
 const canonical=v=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))):x);
 const equal=(a,b)=>canonical(a)===canonical(b);
 const fail=()=>{throw Error('case_mail_invoice_identity_mismatch');};
 return async function invoiceHistory(input,actorId,f){
  if(!uuid(input.inquiry_id)||!uuid(actorId))throw Error('invalid_case_mail');
  const id=input.inquiry_id;await getInquiry(id,f);
  const audits=await rows('pa_inquiry_audit',{inquiry_id:'eq.'+id,action:'eq.gmail_case_message_sent',select:'inquiry_id,actor_user_id,occurred_at,details',order:'occurred_at.desc,id.desc',limit:'101'},f);
  if(audits.some(a=>a.inquiry_id!==id))fail();
  const candidates=audits.slice(0,100).filter(a=>a.details?.entry_context==='invoice'||a.details?.attachments?.some(x=>x.document_kind==='invoice'));
  const records=[],errors=[],seen=new Set();
  for(const a of candidates.slice(0,20)){
   const d=a.details||{},opId=d.operation_id;
   if(seen.has(opId)){errors.push({operation_id:opId,code:'duplicate_send_audit'});continue;}seen.add(opId);
   try{
    if(a.actor_user_id!==actorId||!uuid(opId)||!ids(d.gmail_message_id)||!ids(d.gmail_thread_id))fail();
    const result=await rpc(actorId,'get',{inquiry_id:id,operation_id:opId},f),o=result.operation,b=o?.binding;
    if(!o||o.operation_id!==opId||o.inquiry_id!==id||b?.inquiry_id!==id||b.account!==official||b.contract!=='PAUI-062'||!Array.isArray(b.attachments))fail();
    if(o.state!=='SENT'){records.push({operation_id:opId,state:o.state,verification:'NOT_SENT_CONFIRMED',attachments:[],entry_context:d.entry_context||'general',kind:b.kind});continue;}
    if(o.gmail_message_id!==d.gmail_message_id||o.gmail_thread_id!==d.gmail_thread_id||!equal(b.attachments,d.attachments))fail();
    const [index,links,raw]=await Promise.all([
     rows('pa_gmail_message_index',{gmail_message_id:'eq.'+d.gmail_message_id,select:'inquiry_id,gmail_message_id,gmail_thread_id,direction,attachment_metadata',limit:'2'},f),
     rows('pa_gmail_thread_links',{gmail_thread_id:'eq.'+d.gmail_thread_id,select:'inquiry_id,gmail_thread_id',limit:'2'},f),
     gmailMessage(d.gmail_message_id,f)
    ]);
    const n=normalize(raw),headers=raw.payload?.headers||[];
    if(index.length!==1||index[0].inquiry_id!==id||index[0].gmail_thread_id!==d.gmail_thread_id||index[0].direction!=='outbound'
     ||links.length!==1||links[0].inquiry_id!==id||links[0].gmail_thread_id!==d.gmail_thread_id
     ||raw.id!==d.gmail_message_id||raw.threadId!==d.gmail_thread_id||!raw.labelIds?.includes('SENT')||n.direction!=='outbound'||n.reply_identity_invalid||!/^<[^<>\s]{1,998}>$/u.test(n.rfc_message_id||'')||address(n.from_address)!==official
     ||!equal(addresses(n.to_addresses),addresses([b.to]))||!equal(addresses(n.cc_addresses),addresses(b.cc))||subject(n.subject)!==subject(b.subject)
     ||['from','to','subject','message-id'].some(k=>headers.filter(h=>String(h.name).toLowerCase()===k).length!==1)
     ||['cc','bcc'].some(k=>headers.filter(h=>String(h.name).toLowerCase()===k).length>(k==='bcc'?0:1))
     ||!Array.isArray(index[0].attachment_metadata)||n.attachments.length!==b.attachments.length)fail();
    const attachments=[];
    for(const expected of b.attachments){
     if(expected.mime_type!=='application/pdf'||d.entry_context!=='invoice'&&expected.document_kind!=='invoice')continue;
     if(!/^[a-f0-9]{64}$/u.test(expected.sha256||''))fail();
     const matches=x=>x.filename===expected.filename&&x.mime_type===expected.mime_type&&Number(x.size)===expected.size;
     const persisted=index[0].attachment_metadata.filter(matches),parts=n.attachments.filter(matches);
     if(persisted.length!==1||parts.length!==1||!persisted[0].id||!persisted[0].part_id||persisted[0].part_id!==parts[0].part_id)fail();
     if(b.attachments.filter(matches).length!==1)fail();
     attachments.push({key:'invoice-mail:'+opId+':'+persisted[0].part_id,asset_kind:'mail',asset_id:persisted[0].id,case_id:id,message_id:d.gmail_message_id,gmail_thread_id:d.gmail_thread_id,part_id:persisted[0].part_id,filename:expected.filename,mime_type:expected.mime_type,size:expected.size,sha256:expected.sha256,source_direction:'outbound',read_route:'mail',document_kind:expected.document_kind||'normal',original_state:'送信台帳・Gmail索引・MIME part照合済み / PDF実バイトSHAは取得時に検証'});
    }
    records.push({operation_id:opId,state:'SENT',history_sync:o.history_sync||'NOT_COMPLETED',verification:'SENT_IDENTITY_VERIFIED',entry_context:d.entry_context||'general',entry_evidence:'persisted_send_audit',kind:b.kind,gmail_message_id:raw.id,gmail_thread_id:raw.threadId,subject:subject(n.subject),body_text:n.body_text,from:n.from_address,to:n.to_addresses,cc:n.cc_addresses,sent_at:n.occurred_at,attachments,formal_invoice_dispatched:false});
   }catch{errors.push({operation_id:uuid(opId)?opId:null,code:'case_mail_invoice_identity_unconfirmed'});}
  }
  return {inquiry_id:id,records,errors,partial:errors.length>0,truncated:audits.length>100||candidates.length>20,scope:'recorded_invoice_entry_or_explicit_invoice_attachment',read_only:true,formal_billing_mutation:false};
 };
}
module.exports={createInvoiceMailRead};
