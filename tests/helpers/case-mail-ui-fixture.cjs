'use strict';
const {randomUUID,createHash}=require('node:crypto');
// Synthetic UI fixture. The real router/RPC/provider boundary is independently
// exercised by validate-ara-case-mail-062-browser.cjs in isolated PostgreSQL.
function caseMailFixture({inquiryId,messages,caseEmail,onPreview=async()=>{},onSend=async()=>{}}){
 const operations=new Map();let latest=null;
 const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
 return {operations,async route(route){
  const req=route.request(),u=new URL(req.url());const p=req.method()==='GET'?Object.fromEntries(u.searchParams):req.postDataJSON();
  require('node:assert/strict').equal(req.headers().authorization,'Bearer fixture-only');require('node:assert/strict').equal(p.inquiry_id,inquiryId);
  const result=x=>route.fulfill({json:{ok:true,result:x}});
  if(p.action==='context'){
   const source=messages().find(m=>m.gmail_message_id===p.source_id);if(p.source_id&&!source)return route.fulfill({status:409,json:{ok:false,code:'reply_operation_mismatch'}});
   return result({inquiry_id:inquiryId,kind:p.kind,source_id:source?.gmail_message_id||null,thread_id:source?.gmail_thread_id||null,to:source?.direction==='inbound'?source.from_address:caseEmail,cc:[],subject:source?'Re: '+source.subject:'',allowed_recipients:[caseEmail]});
  }
  if(p.action==='invoice_history'){require('node:assert/strict').equal(req.method(),'GET');return result({inquiry_id:inquiryId,read_only:true,records:[],errors:[],partial:false,truncated:false});}
  if(p.action==='status')return result({operation:p.operation_id?[...operations.values()].find(o=>o.operation_id===p.operation_id)||null:latest});
  if(p.action==='reconcile')return result({operation:latest,verified:false});
  if(p.action==='preview'){
   const override=await onPreview(p)||{};const attachments=p.attachments.map(a=>({filename:a.filename,mime_type:a.mime_type,size:Buffer.from(a.data,'base64url').length,sha256:createHash('sha256').update(Buffer.from(a.data,'base64url')).digest('hex')}));
   const key=hash({...p,action:undefined,purpose:undefined});let o=operations.get(key);if(!o){o={operation_id:randomUUID(),inquiry_id:inquiryId,state:'PREPARED',history_sync:null};operations.set(key,o);}latest=o;
   return result({...p,source_id:p.source_id||null,thread_id:p.thread_id||null,attachments,html:'<p>Synthetic preview</p>',unverified_recipients:[],recipient_confirmation_needed:false,operation:o,operation_id:o.operation_id,confirmation_token:'fixture-confirmation',expires_at:new Date(Date.now()+300000).toISOString(),...override});
  }
  require('node:assert/strict').equal(p.action,'send');require('node:assert/strict').equal(p.owner_confirmed,true);require('node:assert/strict').equal(p.confirmation_token,'fixture-confirmation');const o=[...operations.values()].find(o=>o.operation_id===p.operation_id);require('node:assert/strict').equal(o.state,'PREPARED');
  const outcome=await onSend(p)||'complete';if(outcome==='unknown'){o.state='UNKNOWN';latest=o;return route.abort();}o.state='SENT';o.history_sync=outcome==='incomplete'?'INCOMPLETE':'COMPLETE';latest=o;return result({operation:o,history_sync:o.history_sync,formal_billing_created:false,formal_invoice_dispatched:false});
 }};
}
module.exports={caseMailFixture};
