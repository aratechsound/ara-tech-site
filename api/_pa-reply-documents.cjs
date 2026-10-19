'use strict';
// Classification is immutable send-operation content, not a filename heuristic.
// These reads never send, sync, register, adopt or alter a commercial row.
const mail=require('./_pa-mail.cjs'),ops=require('./_pa-reply-operations.cjs');
const proof=require('./_pa-reply-proof.cjs');
const uuid=v=>/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(String(v||''));
async function list({actorId,inquiryId},fetchImpl=fetch){
 if(!uuid(actorId)||!uuid(inquiryId))throw Error('invalid_reply_document');
 await mail.getInquiry(inquiryId,fetchImpl);
 let r;try{r=await mail.supabaseRequest('/rest/v1/rpc/pa_reply_document_list_v1',{method:'POST',body:JSON.stringify({p_actor:actorId,p_case:inquiryId})},fetchImpl);}catch{throw Error('reply_document_read_unavailable');}
 if(r?.ok!==true||!Array.isArray(r.operations)||r.operations.length>21)throw Error('reply_document_read_unavailable');
 const operations=await Promise.all(r.operations.slice(0,20).map(async o=>{
  if(!uuid(o.operation_id)||o.inquiry_id!==inquiryId||o.binding?.inquiry_id!==inquiryId||o.binding?.account!==mail.OFFICIAL_EMAIL||!Array.isArray(o.binding.attachments))throw Error('reply_document_mismatch');
  const current=o.binding.contract==='PAUI-062'?(await require('./_pa-case-mail.cjs').status({inquiry_id:inquiryId,operation_id:o.operation_id},actorId,fetchImpl)).operation:null;
  return {...ops.safe(o),...(current||{}),attachments:o.binding.attachments.map((a,index)=>({index,filename:a.filename,mime_type:a.mime_type,size:a.size,sha256:a.sha256,document_kind:a.document_kind||'normal'})),recipient:o.binding.to,cc:o.binding.cc,source_message_id:o.binding.source_id};
 }));
 return {inquiry_id:inquiryId,operations,truncated:r.operations.length>20};
}
async function verify({actorId,inquiryId,operationId,messageId},fetchImpl=fetch){
 if(!uuid(inquiryId)||!uuid(operationId)||!proof.ids(messageId))throw Error('invalid_reply_document');
 let row=await ops.status({actorId,inquiryId,operationId},fetchImpl),o=row.operation;const unified=o?.binding?.contract==='PAUI-062';if(unified)o=(await require('./_pa-case-mail.cjs').rpc(actorId,'get',{inquiry_id:inquiryId,operation_id:operationId},fetchImpl)).operation;
 if(!o||o.state!=='SENT'||o.inquiry_id!==inquiryId||o.gmail_message_id!==messageId)throw Error('reply_document_unconfirmed');
 const gmail=require('./_pa-gmail.cjs');
 const result=unified?await require('./_pa-case-mail.cjs').reconcile({inquiry_id:inquiryId,operation_id:operationId},actorId,fetchImpl):await ops.reconcile({actorId,inquiryId,operationId},gmail.gmailJson,gmail.normalizeMessage,fetchImpl);
 if(!(unified?result.verified:result.matched)||result.verification?.status!=='VERIFIED')throw Error('reply_document_mismatch');
 // Reconcile independently checks the Provider original. The persisted case
 // index must also identify the same message/thread and every exact MIME part.
 const query=new URLSearchParams({inquiry_id:'eq.'+inquiryId,gmail_message_id:'eq.'+messageId,select:'inquiry_id,gmail_message_id,gmail_thread_id,direction,attachment_metadata',limit:'2'});
 const rows=await mail.supabaseRequest('/rest/v1/pa_gmail_message_index?'+query,{},fetchImpl);
 const atts=result.verification.attachments,idx=rows?.[0];
 if(!Array.isArray(rows)||rows.length!==1||idx.gmail_thread_id!==(o.gmail_thread_id||o.binding.thread_id)||idx.direction!=='outbound'||!Array.isArray(atts)||!Array.isArray(idx.attachment_metadata)||idx.attachment_metadata.length!==atts.length)throw Error('reply_document_mismatch');
 for(const a of atts){const matches=idx.attachment_metadata.filter(p=>p.part_id===a.part_id&&p.mime_type===a.mime_type&&Number(p.size)===a.size&&p.filename===a.filename);if(matches.length!==1)throw Error('reply_document_mismatch');a.attachment_id=matches[0].id;}
 return {inquiry_id:inquiryId,operation_id:operationId,state:'SENT',gmail_message_id:messageId,gmail_thread_id:o.gmail_thread_id||o.binding.thread_id,sent_at:result.verification.occurred_at,recipient:o.binding.to,cc:o.binding.cc,attachments:atts.map((a,index)=>({...a,document_kind:o.binding.attachments[index].document_kind||'normal'})),verification:'VERIFIED'};
}
module.exports={list,verify};
