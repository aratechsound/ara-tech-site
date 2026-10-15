'use strict';
// Transport adapter for existing unit fixtures only. Production has no fallback
// ledger. SQL/privileges/independent sessions are tested against real engines.
const assert=require('node:assert/strict'),cache=new WeakMap();
const json=d=>({ok:true,status:200,json:async()=>d});
module.exports.withOperations=inner=>{
 if(cache.has(inner))return cache.get(inner);const rows=[];
 const wrapped=async(url,options={})=>{
  if(!new URL(url).pathname.endsWith('/rpc/pa_reply_operation_v1'))return inner(url,options);
  const {p_actor:actor,p_action:action,p_payload:p}=JSON.parse(options.body);let o;
  if(action==='prepare'){
   o=rows.filter(r=>r.actor===actor&&r.inquiry_id===p.inquiry_id&&r.binding_hash===p.binding_hash).at(-1);
   if(!o||o.state==='FAILED_BEFORE_SEND'||p.new_operation&&o.state==='SENT'&&p.previous_operation_id===o.operation_id){
    o={operation_id:p.operation_id,inquiry_id:p.inquiry_id,actor,binding:p.binding,binding_hash:p.binding_hash,state:'PREPARED',expires_at:new Date(Date.now()+600000).toISOString(),created_at:new Date().toISOString()};rows.push(o);
   }
  }else{
   o=p.operation_id?rows.find(r=>r.operation_id===p.operation_id&&r.actor===actor&&r.inquiry_id===p.inquiry_id):rows.filter(r=>r.actor===actor&&r.inquiry_id===p.inquiry_id&&r.binding.source_id===p.source_id&&r.binding.thread_id===p.thread_id).at(-1);
   assert(o,'existing fixture operation binding');
  }
  let claimed=false;
  if(action==='claim'&&o.state==='PREPARED'){o.state='SENDING';claimed=true;}
  if(action==='failed'&&o.state==='PREPARED')o.state='FAILED_BEFORE_SEND';
  if(action==='unknown'&&['SENDING','UNKNOWN'].includes(o.state))o.state='UNKNOWN';
  if(action==='sent'&&['SENDING','UNKNOWN'].includes(o.state)){o.state='SENT';o.gmail_message_id=p.gmail_message_id;o.history_sync='INCOMPLETE';}
  if(action==='history'&&o.state==='SENT')o.history_sync=p.complete?'COMPLETE':'INCOMPLETE';
  return json({ok:true,claimed,operation:structuredClone(o)});
 };cache.set(inner,wrapped);return wrapped;
};
