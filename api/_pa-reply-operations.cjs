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
 sha256:hash(Buffer.from(a.data,'base64url'))}))});
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
 can_send:op.state==='PREPARED',can_reconcile:['UNKNOWN','SENDING'].includes(op.state)});
// Every lookup uses the normal verified Gmail reader. Search is discovery only;
// SENT requires exactly one full message with all bound identities. Absence,
// truncation, duplicate headers, similar messages and disagreement remain UNKNOWN.
async function reconcile({actorId,inquiryId,operationId},read,normalize,fetchImpl){
 const row=await status({actorId,inquiryId,operationId},fetchImpl),op=row.operation;
 if(op.state==='SENT'||!['UNKNOWN','SENDING'].includes(op.state))return {operation:safe(op),matched:op.state==='SENT'};
 const expected=op.binding;let proof=null;
 try{
  const list=await read('/messages?'+new URLSearchParams({q:'in:anywhere rfc822msgid:'+rfcId(op.operation_id),maxResults:'2'}),{method:'GET'},fetchImpl);
  if(!list.nextPageToken&&Array.isArray(list.messages)&&list.messages.length===1){
   const id=list.messages[0].id;
   if(!/^[A-Za-z0-9_-]{1,200}$/u.test(String(id)))throw Error('invalid_message');
   const message=await read('/messages/'+encodeURIComponent(id)+'?format=full',{method:'GET'},fetchImpl),n=normalize(message);
   const values=name=>(message.payload?.headers||[]).filter(h=>String(h.name).toLowerCase()===name).map(h=>String(h.value));
   const single=(name,value)=>values(name).length===1&&values(name)[0].trim()===value;
   if(message.labelIds?.includes('SENT')&&n.id===id&&n.thread_id===expected.thread_id
    &&single('message-id',rfcId(op.operation_id))&&single('in-reply-to',expected.source_rfc)
    &&values('from').length===1&&values('to').length===1&&values('cc').length<=1&&values('subject').length===1
    &&!n.reply_identity_invalid&&n.from_address.toLowerCase()===expected.account
    &&JSON.stringify(addresses(n.to_addresses))===JSON.stringify([expected.to])
    &&JSON.stringify(addresses(n.cc_addresses))===JSON.stringify(expected.cc)&&n.subject===expected.subject
    &&hash(normalizeCustomerBody(n.body_text))===expected.body_sha256
    &&n.attachments.length===expected.attachments.length
    &&n.attachments.every((a,i)=>a.filename===expected.attachments[i].filename&&a.mime_type===expected.attachments[i].mime_type&&a.size===expected.attachments[i].size)){
     const parts=[];const collect=p=>{if(!p)return;parts.push(p);for(const child of p.parts||[])collect(child);};collect(message.payload);
     let originals=true;
     for(let i=0;i<n.attachments.length;i++){
      const a=n.attachments[i],part=parts.find(p=>String(p.partId||'')===a.part_id);
      const data=a.gmail_attachment_id
       ?(await read('/messages/'+encodeURIComponent(id)+'/attachments/'+encodeURIComponent(a.gmail_attachment_id),{method:'GET'},fetchImpl)).data
       :part?.body?.data;
      if(typeof data!=='string'||hash(Buffer.from(data,'base64url'))!==expected.attachments[i].sha256){originals=false;break;}
     }
     if(originals)proof={gmail_message_id:id,gmail_thread_id:n.thread_id};
    }
  }
 }catch{/* no speculative retry, no negative delivery proof */}
 const result=await act(actorId,proof?'sent':'unknown',op,proof||{},fetchImpl);
 return {operation:safe(result.operation),matched:!!proof};
}
module.exports={hash,binding,digest,rfcId,rpc,prepare,bound,act,status,safe,reconcile};
