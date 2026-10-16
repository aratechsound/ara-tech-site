'use strict';
// PAUI-046: this ledger is separate from the commercial outbox. It never
// updates an inquiry, commercial row, existing audit, or Gmail message.
const crypto=require('node:crypto');
const {supabaseRequest,OFFICIAL_EMAIL,normalizeCustomerBody}=require('./_pa-mail.cjs');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const addresses=values=>[...new Set(values.map(v=>String(v).trim().toLowerCase()))].sort();
const rfcId=id=>`<pa-reply-${id}@ara-tech.cc>`;
const uuid=value=>/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(String(value||''));
const binding=(preview,attachments)=>({account:OFFICIAL_EMAIL,inquiry_id:preview.inquiry_id,
 thread_id:preview.gmail_thread_id,source_id:preview.reply_source_message_id,
 source_rfc:preview.reply_source_rfc_message_id,source_hash:preview.reply_source_authority_hash,
 to:preview.recipient.toLowerCase(),cc:addresses(preview.cc_addresses),subject:preview.subject,
 body_sha256:hash(normalizeCustomerBody(preview.body)),
 attachments:attachments.map(a=>({filename:a.filename,mime_type:a.mime_type,size:a.size,
 sha256:hash(Buffer.from(a.data,'base64url')),...(a.document_kind?{document_kind:a.document_kind}:{})}))});
const digest=b=>hash(JSON.stringify(b));
async function rpc(actorId,action,payload,fetchImpl){
 const row=await supabaseRequest('/rest/v1/rpc/pa_reply_operation_v1',{method:'POST',body:JSON.stringify({p_actor:actorId,p_action:action,p_payload:payload})},fetchImpl);
 if(!row||typeof row!=='object'||Array.isArray(row)||row.ok!==true)throw Error('reply_operation_unavailable');
 return row;
}
async function prepare({actorId,preview,attachments,newOperation=false,previousOperationId=null},fetchImpl){
 const b=binding(preview,attachments);
 return rpc(actorId,'prepare',{operation_id:crypto.randomUUID(),inquiry_id:preview.inquiry_id,
 binding:b,binding_hash:digest(b),new_operation:newOperation===true,previous_operation_id:previousOperationId},fetchImpl);
}
async function bound({actorId,preview,attachments,operationId},fetchImpl){
 if(!uuid(operationId))throw Error('invalid_reply_operation');
 const row=await rpc(actorId,'get',{inquiry_id:preview.inquiry_id,operation_id:operationId},fetchImpl);
 if(row.operation.binding_hash!==digest(binding(preview,attachments)))throw Error('reply_operation_mismatch');
 return row;
}
const act=(actorId,action,operation,payload,fetchImpl)=>rpc(actorId,action,{inquiry_id:operation.inquiry_id,operation_id:operation.operation_id,...payload},fetchImpl);
// A status-only request is safe after logout/login or a lost response. It does
// not need a draft, confirmation token, or a browser-owned operation identifier.
const status=({actorId,inquiryId,operationId,sourceMessageId,sourceThreadId},fetchImpl)=>rpc(actorId,'get',{
 inquiry_id:inquiryId,operation_id:operationId||null,source_id:sourceMessageId||null,thread_id:sourceThreadId||null},fetchImpl);
const safe=op=>({operation_id:op.operation_id,inquiry_id:op.inquiry_id,state:op.state,
 gmail_message_id:op.gmail_message_id||null,gmail_thread_id:op.binding?.thread_id||null,
 history_sync:op.history_sync||'NOT_COMPLETED',created_at:op.created_at,expires_at:op.expires_at,
 can_send:op.state==='PREPARED'&&Date.parse(op.expires_at)>Date.now(),can_reconcile:['UNKNOWN','SENDING','SENT'].includes(op.state)});
// PAUI-049: a persisted Provider ACK is correlated by Gmail's immutable API
// ID. RFC lookup is a positive-proof fallback only; absence never permits retry.
async function reconcile({actorId,inquiryId,operationId},read,normalize,fetchImpl){
 const row=await status({actorId,inquiryId,operationId},fetchImpl),op=row.operation;
 if(!op)throw Error('invalid_reply_operation');
 if(!['SENT','UNKNOWN','SENDING'].includes(op.state))return {operation:safe(op),matched:false};
 const evidence=require('./_pa-reply-proof.cjs'),expected=op.binding;
 if(expected.account!==OFFICIAL_EMAIL||expected.inquiry_id!==inquiryId||!evidence.ids(expected.thread_id)||!evidence.ids(expected.source_id))throw Error('reply_operation_mismatch');
 // Recheck the whole source attribution before reading Gmail, including SENT.
 const threadQuery=new URLSearchParams({gmail_thread_id:'eq.'+expected.thread_id,select:'inquiry_id',limit:'2'});
 const sourceQuery=new URLSearchParams({gmail_message_id:'eq.'+expected.source_id,select:'inquiry_id,gmail_thread_id',limit:'2'});
 const [links,sources]=await Promise.all([
  supabaseRequest('/rest/v1/pa_gmail_thread_links?'+threadQuery,{},fetchImpl),
  supabaseRequest('/rest/v1/pa_gmail_message_index?'+sourceQuery,{},fetchImpl)
 ]);
 if(!Array.isArray(links)||links.length!==1||links[0].inquiry_id!==inquiryId||!Array.isArray(sources)||sources.length!==1||sources[0].inquiry_id!==inquiryId||sources[0].gmail_thread_id!==expected.thread_id)throw Error('reply_operation_mismatch');
 const get=(path,options)=>read(path,options,fetchImpl);
 let proof=null,verification={status:'UNVERIFIED',basis:null};
 const acknowledged=evidence.ids(op.gmail_message_id)?op.gmail_message_id:null;
 try{
  if(acknowledged){
   const message=await get('/messages/'+encodeURIComponent(acknowledged)+'?format=full',{method:'GET'});
   const inspected=await evidence.inspect(message,expected,normalize,get);
   if(message.id===acknowledged&&inspected.binding_matches)proof=inspected;
   verification={status:proof?'VERIFIED':'MISMATCH',basis:'PERSISTED_PROVIDER_ACK_GMAIL_ID',...inspected};
  }else if(op.state!=='SENT'){
   const list=await get('/messages?'+new URLSearchParams({q:'in:anywhere rfc822msgid:'+rfcId(op.operation_id),maxResults:'2'}),{method:'GET'});
   if(!list.nextPageToken&&Array.isArray(list.messages)&&list.messages.length===1&&evidence.ids(list.messages[0].id)){
    const message=await get('/messages/'+encodeURIComponent(list.messages[0].id)+'?format=full',{method:'GET'});
    const inspected=await evidence.inspect(message,expected,normalize,get);
    if(message.id===list.messages[0].id&&inspected.rfc_message_id===rfcId(op.operation_id)&&inspected.binding_matches)proof=inspected;
   }
   verification={status:proof?'VERIFIED':'UNVERIFIED',basis:proof?'EXACT_GENERATED_RFC_AND_FULL_BINDING':null};
  }
 }catch{verification={status:'UNAVAILABLE',basis:acknowledged?'PERSISTED_PROVIDER_ACK_GMAIL_ID':null};}
 if(proof)verification={...verification,rfc_message_id:proof.rfc_message_id,generated_rfc_preserved:proof.rfc_message_id===rfcId(op.operation_id)};
 // Historical SENT and history_sync remain byte-for-byte untouched, even if
 // Gmail is unavailable or a subsequent read disagrees with the saved binding.
 if(op.state==='SENT')return {operation:safe(op),matched:!!proof,verification};
 if(proof){
  const result=await act(actorId,'sent',op,{gmail_message_id:proof.gmail_message_id,gmail_thread_id:proof.gmail_thread_id},fetchImpl);
  return {operation:safe(result.operation),matched:true,verification};
 }
 const review=await evidence.reviewThread(op,get,normalize);
 const result=await act(actorId,'unknown',op,{},fetchImpl);
 return {operation:safe(result.operation),matched:false,verification,review};
}

module.exports={hash,binding,digest,rfcId,rpc,prepare,bound,act,status,safe,reconcile};
