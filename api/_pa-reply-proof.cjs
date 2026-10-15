'use strict';
// PAUI-049: Gmail's immutable API ID and an RFC Message-ID are different
// authorities. A matching subject/body is only a manual-review candidate.
const {createHash}=require('node:crypto');
const {normalizeCustomerBody}=require('./_pa-mail.cjs');
const hash=b=>createHash('sha256').update(b).digest('hex');
const ids=v=>/^[A-Za-z0-9_-]{1,200}$/u.test(String(v||''));
const addresses=values=>[...new Set(values.map(v=>String(v).trim().toLowerCase()))].sort();
const values=(m,name)=>(m.payload?.headers||[]).filter(h=>String(h.name).toLowerCase()===name).map(h=>String(h.value));
const rfc=m=>{const v=values(m,'message-id');return v.length===1&&/^<[^<>\s]{1,998}>$/u.test(v[0].trim())?v[0].trim():null;};
function subject(value){
 const s=String(value||'').replace(/\r\n[ \t]+/gu,' ');
 if(/[\r\n]/u.test(s)||s.length>2000)throw Error('invalid_subject');
 if(!s.includes('=?'))return s;
 let previousEnd=0,previousWord=false,result='';
 const re=/=\?([^?\s]+)\?([bq])\?([^?]*)\?=/giu;let match;
 while((match=re.exec(s))){
  const gap=s.slice(previousEnd,match.index);
  if(gap.includes('=?'))throw Error('invalid_subject');
  if(!(previousWord&&/^\s*$/u.test(gap)))result+=gap;
  if(!/^(utf-8|us-ascii)$/iu.test(match[1]))throw Error('invalid_subject_charset');
  let bytes;
  if(match[2].toLowerCase()==='b'){
   if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(match[3]))throw Error('invalid_subject');
   bytes=Buffer.from(match[3],'base64');
  }else{
   const encoded=match[3].replace(/_/gu,' ');if(/=(?![a-f0-9]{2})|[^\x20-\x7e]/iu.test(encoded))throw Error('invalid_subject');
   const out=[];for(let i=0;i<encoded.length;i++){if(encoded[i]==='='){out.push(parseInt(encoded.slice(i+1,i+3),16));i+=2;}else out.push(encoded.charCodeAt(i));}bytes=Buffer.from(out);
  }
  if(/^us-ascii$/iu.test(match[1])&&bytes.some(b=>b>127))throw Error('invalid_subject');
  result+=new TextDecoder('utf-8',{fatal:true}).decode(bytes);previousEnd=re.lastIndex;previousWord=true;
 }
 const tail=s.slice(previousEnd);if(!previousWord||tail.includes('=?'))throw Error('invalid_subject');
 result+=tail;if(/[\r\n\u0000-\u001f]/u.test(result))throw Error('invalid_subject');return result;
}
async function inspect(message,expected,normalize,read,{attachmentBytes=true}={}){
 const n=normalize(message),problems=[];
 const check=(ok,reason)=>{if(!ok)problems.push(reason);};
 check(ids(message.id)&&n.id===message.id,'message_id');
 check(message.labelIds?.includes('SENT'),'sent_label');
 check(n.thread_id===expected.thread_id,'thread');
 check(!!rfc(message),'rfc_message_id');
 check(values(message,'in-reply-to').length===1&&values(message,'in-reply-to')[0].trim()===expected.source_rfc,'reply_source');
 const refs=values(message,'references');
 check(refs.length<=1&&(!refs.length||(!/[\r\n]/u.test(refs[0])&&refs[0].includes(expected.source_rfc))),'references');
 check(values(message,'from').length===1&&values(message,'to').length===1&&values(message,'cc').length<=1&&values(message,'bcc').length===0,'recipient_headers');
 check(!n.reply_identity_invalid&&n.from_address.toLowerCase()===expected.account,'account');
 check(JSON.stringify(addresses(n.to_addresses))===JSON.stringify([expected.to]),'to');
 check(JSON.stringify(addresses(n.cc_addresses))===JSON.stringify(expected.cc),'cc');
 try{check(values(message,'subject').length===1&&subject(values(message,'subject')[0])===expected.subject,'subject');}catch{problems.push('subject');}
 check(hash(normalizeCustomerBody(n.body_text))===expected.body_sha256,'body');
 const attachments=Array.isArray(expected.attachments)?expected.attachments:[];
 const attachmentMetadata=n.attachments.length<=10&&n.attachments.length===attachments.length&&n.attachments.every((a,i)=>a.filename===attachments[i].filename&&a.mime_type===attachments[i].mime_type&&a.size===attachments[i].size);
 check(attachmentMetadata,'attachments');
 if(attachmentBytes&&attachmentMetadata&&!problems.length){
  const parts=[];const collect=p=>{if(!p)return;parts.push(p);for(const c of p.parts||[])collect(c);};collect(message.payload);
  for(let i=0;i<n.attachments.length;i++){
   const a=n.attachments[i],part=parts.find(p=>String(p.partId||'')===a.part_id);
   const data=a.gmail_attachment_id?(await read('/messages/'+encodeURIComponent(message.id)+'/attachments/'+encodeURIComponent(a.gmail_attachment_id),{method:'GET'})).data:part?.body?.data;
   if(typeof data!=='string'||data.length>4_500_000||hash(Buffer.from(data,'base64url'))!==attachments[i].sha256){problems.push('attachment_bytes');break;}
  }
 }
 return {gmail_message_id:n.id,gmail_thread_id:n.thread_id,rfc_message_id:rfc(message),occurred_at:n.occurred_at,binding_matches:problems.length===0,mismatches:problems,attachment_bytes_checked:attachmentBytes&&problems.length===0};
}
async function reviewThread(op,read,normalize){
 try{
  const thread=await read('/threads/'+encodeURIComponent(op.binding.thread_id)+'?format=full',{method:'GET'});
  if(thread.id&&thread.id!==op.binding.thread_id)throw Error('thread_mismatch');
  const messages=Array.isArray(thread.messages)?thread.messages:[];
  const candidates=[];
  for(const message of messages.slice(0,10)){
   if(!ids(message.id)||message.threadId!==op.binding.thread_id||!message.labelIds?.includes('SENT'))continue;
   candidates.push(await inspect(message,op.binding,normalize,read,{attachmentBytes:false}));
  }
  return {status:'MANUAL_REVIEW_REQUIRED',reason:'NO_UNIQUE_OPERATION_PROOF',candidates,truncated:messages.length>10,automatic_sent:false};
 }catch{return {status:'MANUAL_REVIEW_REQUIRED',reason:'GMAIL_READ_UNAVAILABLE',candidates:[],automatic_sent:false};}
}
module.exports={ids,rfc,subject,inspect,reviewThread};
