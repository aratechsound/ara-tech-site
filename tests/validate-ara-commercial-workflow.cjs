'use strict';
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const {setup,MODE}=require('./validate-pam-025-direct-confirmation.cjs');
const {createService}=require('../api/_pa-commercial.cjs');
const {createHandler}=require('../api/_pa-commercial-handler.cjs');
const digest=async f=>JSON.stringify((await f.db.query(`select table_name from information_schema.tables where table_schema='public' and table_name in ('pa_case_commercial_state','pa_commercial_outbox','pa_estimate_revisions','pa_contract_offers','pa_contract_tokens','pa_contracts','pa_reply_operations_v1','pa_reply_operation_events_v1') order by table_name`)).rows.map(r=>r.table_name));
async function rows(f){const names=JSON.parse(await digest(f)),out={};for(const n of names)out[n]=(await f.db.query('select to_jsonb(t) data from public.'+n+' t order by to_jsonb(t)::text')).rows;return JSON.stringify(out);}
async function main(){
 global.fetch=async()=>{throw Error('LIVE_NETWORK_FORBIDDEN');};let sends=0;
 const f=await setup({transport:async()=>{sends++;return {gmail_message_id:'mock_estimate_'+sends,gmail_thread_id:'thread_123'};}});
 try{
  const result=await f.createEstimate('LEGACY');assert(result.id&&result.outbox_id);assert.equal(sends,0);
  const base={case_id:f.inquiryId,job_id:result.outbox_id,estimate_revision_id:result.id};
  const before=await rows(f);const p=await f.service.estimateSendPreview(base,f.actor);
  assert.equal(p.estimate.id,result.id);assert.equal(p.document.id,p.estimate.document_id);assert.equal(p.delivery_state,'queued');assert.equal(p.fingerprint.length,64);assert(!('confirmation_token' in p));
  await f.service.composerPreview({case_id:f.inquiryId,body:'Read-only preview',content_only:true},f.actor);
  assert.equal(await rows(f),before,'Non-send previews must not create operations or mutate business state');
  const corrupt=createService({fetchImpl:async(url,options)=>{const r=await f.fetchImpl(url,options),u=new URL(url);if(u.pathname.endsWith('/pa_commercial_documents')&&u.searchParams.get('select')?.split(',').includes('content')){const data=await r.json();return {...r,json:async()=>data.map(d=>({...d,content:'\\x62726f6b656e'}))};}return r;}});
  await assert.rejects(corrupt.estimateSendPreview(base,f.actor),/document_identity_mismatch/);
  const invoke=async(options,origin='https://fixture.invalid')=>{const res={status(n){this.code=n;return this;},json(value){this.body=value;return this;},setHeader(){}};await createHandler(options)({method:'POST',headers:{origin,authorization:'Bearer fixture'},body:{action:'estimate_send_preview',...base}},res);return res;};
  assert.equal((await invoke({service:f.service,admin:async()=>{throw Error('not_authorized');},rate:async()=>({allowed:true})})).code,401);
  assert.equal((await invoke({service:f.service,admin:async()=>f.actor,rate:async()=>({allowed:false,retryAfter:60})})).code,429);
  assert.equal((await invoke({service:f.service,admin:async()=>{throw Error('MUST_NOT_REACH_AUTH');}},'https://other.invalid')).code,403);
  await assert.rejects(f.service.estimateSendPreview({...base,case_id:crypto.randomUUID()},f.actor));
  await assert.rejects(f.service.estimateSendPreview({...base,estimate_revision_id:crypto.randomUUID()},f.actor),/stale_estimate_preview/);
  for(const state of ['unknown','processing','failed','sent','cancelled']){
   await f.db.exec('begin');
   try{await f.db.query('update pa_commercial_outbox set state=$1 where id=$2',[state,result.outbox_id]);
    await assert.rejects(f.service.estimateSendPreview(base,f.actor),/estimate_send_not_ready/);
   }finally{await f.db.exec('rollback');}
  }
  await f.db.query("update pa_inquiries set venue='Changed fixture venue' where id=$1",[f.inquiryId]);
  await assert.rejects(f.service.dispatch({...base,expected_revision:p.expected_revision,preview_fingerprint:p.fingerprint},f.actor),/stale_estimate_preview/);assert.equal(sends,0);
  const p2=await f.service.estimateSendPreview(base,f.actor);
  const finished=await f.service.dispatch({...base,expected_revision:p2.expected_revision,preview_fingerprint:p2.fingerprint},f.actor);assert.equal(finished.state,'sent');assert.equal(sends,1);
  await assert.rejects(f.service.dispatch({...base,expected_revision:p2.expected_revision,preview_fingerprint:p2.fingerprint},f.actor),/estimate_send_not_ready/);assert.equal(sends,1);
 }finally{await f.db.close();}
 let directSends=0;const d=await setup({transport:async()=>{directSends++;return {gmail_message_id:'mock_direct',gmail_thread_id:'thread_123'};}});
 try{
  const estimate=await d.createEstimate('LEGACY');const prior=await rows(d);
  const p=await d.service.confirmationPreview({case_id:d.inquiryId,confirmation_mode:MODE},d.actor);
  const pdf=await d.service.confirmationReceiptPreview({case_id:d.inquiryId,confirmation_mode:MODE,preview_fingerprint:p.fingerprint},d.actor);
  assert(pdf.bytes.length>100);assert.equal(p.estimate.tax_basis,'tax_included');assert.equal(await rows(d),prior);assert.equal(directSends,0);
  await d.service.issueDirectConfirmationAndSend({case_id:d.inquiryId,confirmation_mode:MODE,preview_fingerprint:p.fingerprint,operation_id:crypto.randomUUID()},d.actor);
  assert.equal(directSends,1);assert.equal((await d.db.query('select state from pa_commercial_outbox where id=$1',[estimate.outbox_id])).rows[0].state,'cancelled');
  assert.equal((await d.db.query("select count(*)::int n from pa_commercial_outbox where job_kind='confirmation' and state='sent'")).rows[0].n,1);
 }finally{await d.db.close();}
 let unknownSends=0;const u=await setup({transport:async()=>{unknownSends++;throw Error('mock_provider_response_lost');}});
 try{
  const estimate=await u.createEstimate('LEGACY');const base={case_id:u.inquiryId,job_id:estimate.outbox_id,estimate_revision_id:estimate.id};const p=await u.service.estimateSendPreview(base,u.actor);
  await assert.rejects(u.service.dispatch({...base,expected_revision:p.expected_revision,preview_fingerprint:p.fingerprint},u.actor));
  assert.equal((await u.db.query('select state from pa_commercial_outbox where id=$1',[estimate.outbox_id])).rows[0].state,'unknown');
  await assert.rejects(u.service.estimateSendPreview(base,u.actor),/estimate_send_not_ready|delivery_outcome_unresolved/);assert.equal(unknownSends,1);
 }finally{await u.db.close();}
 let racedSends=0;const race=await setup();
 try{
  const estimate=await race.createEstimate('LEGACY'),base={case_id:race.inquiryId,job_id:estimate.outbox_id,estimate_revision_id:estimate.id};
  const p=await race.service.estimateSendPreview(base,race.actor);
  const fetchImpl=async(url,options)=>{if(new URL(url).pathname.endsWith('/rpc/pa_v5_outbox_claim'))await race.db.query("update pa_inquiries set venue='Changed between preview and claim' where id=$1",[race.inquiryId]);return race.fetchImpl(url,options);};
  const service=createService({fetchImpl,sendTransport:async()=>{racedSends++;throw Error('SHOULD_NOT_SEND');}});
  await assert.rejects(service.dispatch({...base,expected_revision:p.expected_revision,preview_fingerprint:p.fingerprint},race.actor),/stale_estimate_preview/);assert.equal(racedSends,0);
 }finally{await race.db.close();}
 console.log(JSON.stringify({status:'PASS',registration_without_send:true,existing_outbox_preview_readonly:true,preview_does_not_prepare_normal_reply:true,fresh_fingerprint_required:true,old_revision_or_other_case_rejected:true,corrupt_original_rejected:true,auth_origin_rate_preserved:true,after_claim_race_rejected_before_provider:true,nonqueued_dispatch_rejected:true,registered_unsent_direct_confirmation:true,existing_estimate_job_cancelled_by_authority:true,unknown_never_retried:true,isolated_state_transitions:true,mock_sends:sends+directSends+unknownSends,real_provider_sends:0,production_business_writes:0}));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
