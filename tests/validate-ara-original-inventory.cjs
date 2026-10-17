'use strict';
const assert=require('node:assert/strict');
const {setup}=require('./validate-pam-025-direct-confirmation.cjs');
const {createService}=require('../api/_pa-commercial.cjs'),{createHandler}=require('../api/_pa-commercial-handler.cjs');
(async()=>{
 const f=await setup(),calls=[];let foreign=false,excess=false,rateCalls=0;
 try{
  await f.createEstimate('LEGACY');
  await f.db.query('delete from pa_case_commercial_state where inquiry_id=$1',[f.inquiryId]);
  const names=['pa_case_commercial_state','pa_commercial_outbox','pa_estimate_revisions','pa_commercial_documents','pa_contracts','pa_contract_offers','pa_contract_tokens','pa_billings','pa_payment_records','pa_inquiry_audit'];
  const digest=async()=>{const v={};for(const n of names)v[n]=(await f.db.query('select to_jsonb(t) r from '+n+' t order by to_jsonb(t)::text')).rows;return JSON.stringify(v);};
  const before=await digest();
  const service=createService({fetchImpl:async(url,options={})=>{calls.push({url,method:options.method||'GET'});const q=new URL(url),offset=Number(q.searchParams.get('offset')||0);q.searchParams.delete('offset');const res=await f.fetchImpl(q.href,options);
   if(q.pathname.endsWith('/pa_commercial_documents')){const rows=await res.json();return {...res,json:async()=>excess?Array.from({length:250},()=>rows[0]):foreign?rows.map(r=>({...r,inquiry_id:'33333333-3333-4333-8333-333333333333'})):offset?[]:rows};}return res;
  }});
  const inventory=await service.originalIndex(f.inquiryId);assert.equal(inventory.case_id,f.inquiryId);assert(inventory.documents.length);assert(inventory.read_projection);assert(!('content' in inventory.documents[0]));assert(!('snapshot' in inventory.offers));assert.equal(await digest(),before);assert.equal((await f.db.query('select count(*)::int n from pa_case_commercial_state where inquiry_id=$1',[f.inquiryId])).rows[0].n,0,'Read must not initialize commercial state');
  foreign=true;await assert.rejects(service.originalIndex(f.inquiryId),/document_identity_mismatch/);foreign=false;
  excess=true;await assert.rejects(service.originalIndex(f.inquiryId),/commercial_inventory_incomplete/);excess=false;assert.equal(await digest(),before);
  const invoke=async({origin='https://fixture.invalid',admin=async()=>f.actor,rate=async()=>{rateCalls++;return {allowed:true};}}={})=>{const res={status(n){this.code=n;return this;},json(b){this.body=b;return this;},setHeader(){}};await createHandler({service,admin,rate})({method:'POST',headers:{origin,authorization:'Bearer fixture'},body:{action:'original_index',case_id:f.inquiryId}},res);return res;};
  assert.equal((await invoke()).code,200);assert(rateCalls>0);const prior=calls.length;assert.equal((await invoke({origin:'https://other.invalid'})).code,403);assert.equal(calls.length,prior,'Origin rejection before data access');assert.equal((await invoke({admin:async()=>{throw Error('not_authorized');}})).code,401);assert.equal((await invoke({rate:async()=>({allowed:false,retryAfter:60})})).code,429);
  assert(calls.every(c=>c.method==='GET'&&!c.url.includes('/rpc/')));assert.equal(await digest(),before);
  console.log(JSON.stringify({status:'PASS',actual_commercial_service_handler:true,metadata_only:true,bounded_complete_or_hold:true,foreign_case_rejected:true,missing_state_not_initialized:true,protected_rows_identical:true,owner_origin_rate_preserved:true,source_capability_protocol:true,production_writes:0,real_sends:0}));
 }finally{await f.db.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
