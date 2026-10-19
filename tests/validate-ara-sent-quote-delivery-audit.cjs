'use strict';
const assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path');
const {PDFDocument}=require('pdf-lib'),{setup}=require('./validate-pam-025-direct-confirmation.cjs');
const {createService,decryptSecret}=require('../api/_pa-commercial.cjs'),{sha}=require('../api/_pa-contract-pdf.cjs');
const sql=n=>fs.readFileSync(path.join(__dirname,'../ops',n),'utf8');
const json=(v,status=200)=>({ok:status<300,status,json:async()=>v});
async function fixture(){
 const f=await setup({transport:async()=>({gmail_message_id:'replacement_ack',gmail_thread_id:'thread_123'})});
 await f.db.exec(sql('PAUI-051-change-evidence.sql'));
 const est=await f.createEstimate(null);await f.service.dispatch({job_id:est.outbox_id},f.actor);
 let p=await f.service.confirmationPreview({case_id:f.inquiryId},f.actor);
 f.old=await f.service.issueConfirmation({case_id:f.inquiryId,preview_fingerprint:p.fingerprint,operation_id:crypto.randomUUID()},f.actor);
 p=await f.service.confirmationPreview({case_id:f.inquiryId,replace_offer_id:f.old.id},f.actor);
 f.replacement=await f.service.replaceConfirmation({case_id:f.inquiryId,old_offer_id:f.old.id,expected_old_version:1,preview_fingerprint:p.fingerprint,operation_id:crypto.randomUUID(),reason:'Synthetic explicit same-original replacement'},f.actor);
 p=await f.service.confirmationSendPreview({case_id:f.inquiryId,offer_id:f.replacement.id},f.actor);
 await f.service.dispatch({case_id:f.inquiryId,offer_id:f.replacement.id,job_id:f.replacement.outbox_id,preview_fingerprint:p.fingerprint},f.actor);
 const job=(await f.db.query('select * from pa_commercial_outbox where id=$1',[f.replacement.outbox_id])).rows[0];
 const offer=(await f.db.query('select * from pa_contract_offers where id=$1',[f.replacement.id])).rows[0];
 await f.contract.accept({token:decryptSecret(job.secret_envelope).split('#')[1],offer_id:offer.id,snapshot_sha256:offer.snapshot_sha256,confirmer_name:'Synthetic Owner',agree:true});
 // Seed the preserved historical UNKNOWN after creating the explicit replacement
 // through the normal fixture API. Current reissue guards are not bypassed by
 // application code; only this isolated historical fixture is seeded directly.
 await f.db.exec('begin;alter table pa_commercial_outbox disable trigger user');
 await f.db.query("update pa_commercial_outbox set state='unknown',delivery_state=null,provider_request_started=null,provider_response_received=null where id=$1",[f.old.outbox_id]);
 await f.db.exec('alter table pa_commercial_outbox enable trigger user;commit');
 f.contractId=offer.id;
 const doc=await PDFDocument.create();doc.addPage().drawText('TOTAL JPY 200,000');f.bytes=Buffer.from(await doc.save());
 const sent=Date.now()+600000,thread='thread_123';f.messages=new Map();
 for(const id of ['sent_quote','approval_quote']){const outbound=id==='sent_quote';f.messages.set(id,{id,threadId:thread,labelIds:[outbound?'SENT':'INBOX'],internalDate:String(sent+(outbound?0:1000)),payload:{mimeType:'multipart/mixed',headers:[{name:'From',value:outbound?'aratechsound@gmail.com':'customer@example.invalid'},{name:'To',value:outbound?'customer@example.invalid':'aratechsound@gmail.com'},{name:'Subject',value:'Synthetic quote approval'},{name:'Message-ID',value:'<'+id+'@fixture.invalid>'},...(!outbound?[{name:'In-Reply-To',value:'<sent_quote@fixture.invalid>'},{name:'References',value:'<sent_quote@fixture.invalid>'}]:[])],parts:[{mimeType:'text/plain',body:{data:Buffer.from(outbound?'Synthetic quote':'見積書を確認し承認します。').toString('base64url')}},...(outbound?[{mimeType:'application/pdf',filename:'synthetic.pdf',partId:'1',body:{attachmentId:'sent_quote_att',size:f.bytes.length}}]:[])]}});
  await f.db.query('insert into pa_gmail_message_index(gmail_message_id,gmail_thread_id,inquiry_id,direction,from_address,to_addresses,subject,message_source,sent_at,received_at,attachment_metadata) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[id,thread,f.inquiryId,outbound?'outbound':'inbound',outbound?'aratechsound@gmail.com':'customer@example.invalid',outbound?['customer@example.invalid']:['aratechsound@gmail.com'],'Synthetic quote approval','gmail_direct',outbound?new Date(sent).toISOString():null,outbound?null:new Date(sent+1000).toISOString(),outbound?[{id:'sent_quote_att',part_id:'1',mime_type:'application/pdf',filename:'synthetic.pdf',size:f.bytes.length}]:[]]);
 }
 f.network=[];f.gateFailure=false;
 f.fetch=async(url,options={})=>{const u=new URL(url);f.network.push({host:u.host,path:u.pathname,method:options.method||'GET'});
  if(u.pathname.endsWith('/rpc/pa_sent_quote_delivery_gate_v1')||u.pathname.endsWith('/rpc/pa_sent_quote_adopt_v1')||u.pathname.endsWith('/rpc/pa_change_evidence_append')){
   if(f.gateFailure&&u.pathname.endsWith('/rpc/pa_sent_quote_delivery_gate_v1'))return json({},503);
   const name=u.pathname.split('/').at(-1),v=JSON.parse(options.body),keys=Object.keys(v);
   if(name==='pa_sent_quote_adopt_v1')f.lastRpc=structuredClone(v);
   try{return json((await f.db.query('select '+name+'('+keys.map((k,i)=>k+'=>$'+(i+1)).join(',')+') result',Object.values(v))).rows[0].result);}catch(e){f.rpcError=e.message;return json({message:e.message},400);}
  }
  if(u.host==='gmail.googleapis.com'){
   assert.equal(options.method||'GET','GET');
   if(u.pathname.includes('/attachments/'))return json({data:f.bytes.toString('base64url')});
   if(u.pathname.includes('/threads/'))return json({id:thread,messages:[...f.messages.values()]});
   if(u.pathname.includes('/messages/'))return json(f.messages.get(u.pathname.split('/').at(-1))||{},f.messages.has(u.pathname.split('/').at(-1))?200:404);
  }
  return f.fetchImpl(url,options);
 };
 f.service=createService({fetchImpl:f.fetch});f.input={case_id:f.inquiryId,owner_original_selected:true,quote:{source:'gmail',message_id:'sent_quote',thread_id:thread,attachment_id:'sent_quote_att',part_id:'1',sha256:sha(f.bytes)},values:{document_amount_minor:200000,revised_total_minor:200000,additional_amount_minor:90000,amount_basis:'revised_total',tax_basis:'tax_included',currency:'JPY',owner_amounts_confirmed:true}};
 f.digest=async names=>JSON.stringify(await Promise.all(names.map(async t=>(await f.db.query('select to_jsonb(t) v from '+t+' t order by to_jsonb(t)::text')).rows)));
 f.gate=async()=>((await f.db.query('select pa_sent_quote_delivery_gate_v1($1,$2,$3) result',[f.actor.id,f.inquiryId,f.contractId])).rows[0].result);
 return f;
}
async function main({overlay}={}){
 global.fetch=async()=>{throw Error('LIVE_NETWORK_FORBIDDEN');};
 const f=await fixture(),evidence={};if(overlay)await f.db.exec(overlay);
 try{
  const protectedTables=['pa_contracts','pa_contract_receipts','pa_contract_offers','pa_contract_tokens','pa_commercial_outbox','pa_billings','pa_payment_records','pa_payment_adjustments'];
  const immutableBefore=await f.digest(protectedTables);
  await f.db.exec(sql('PAUI-057-sent-quote-adoption.sql'));
  const original=await f.service.sentQuotePreview(f.input,f.actor);assert.equal(original.can_complete,false);assert(original.reasons.includes('COMMERCIAL_STATE_HOLD'));
  // Original A remains untouched. A clean isolated fixture installs the proposed
  // alternative; dropping here is test cleanup of its own unapplied objects only.
  await f.db.exec('drop function pa_sent_quote_adopt_v1(uuid,uuid,uuid,jsonb,jsonb,text);drop table pa_sent_quote_adoptions_v1;');
  await f.db.exec(sql('PAUI-058-sent-quote-adoption.sql'));
  assert.equal(await f.digest(protectedTables),immutableBefore,'install is additive with no existing data rewrite');
  const gate=await f.gate();assert.equal(gate.blocked,false,JSON.stringify(gate));assert.equal(gate.historical_unknown.length,1);assert.equal(gate.historical_unknown[0].state,'unknown');
  assert.equal((await f.db.query('select state from pa_commercial_outbox where id=$1',[f.old.outbox_id])).rows[0].state,'unknown');
  const safe=await f.service.sentQuotePreview(f.input,f.actor);assert.equal(safe.can_complete,true,JSON.stringify(safe.reasons));assert.equal(safe.delivery_gate.historical_unknown.length,1);
  f.gateFailure=true;assert.equal((await f.service.sentQuotePreview(f.input,f.actor)).can_complete,false,'read failure is HOLD');f.gateFailure=false;
  // Corrupt isolated fixture rows inside rolled-back transactions to exercise
  // each missing identity. No trigger/permission change is shipped or persisted.
  async function deny(name,table,statement,values){await f.db.exec('begin');try{await f.db.exec('alter table '+table+' disable trigger user');await f.db.query(statement,values);assert.equal((await f.gate()).blocked,true,name);assert.equal((await f.service.sentQuotePreview(f.input,f.actor)).can_complete,false,name);evidence[name]=true;}finally{await f.db.exec('rollback');}}
  await deny('current_unknown','pa_commercial_outbox',"update pa_commercial_outbox set state='unknown' where id=$1",[f.replacement.outbox_id]);
  await deny('processing_never_excluded','pa_commercial_outbox',"update pa_commercial_outbox set state='processing' where id=$1",[f.old.outbox_id]);
  await deny('different_job_kind','pa_commercial_outbox',"update pa_commercial_outbox set job_kind='confirmation_reminder' where id=$1",[f.old.outbox_id]);
  await deny('unknown_identity_missing','pa_commercial_outbox',"update pa_commercial_outbox set aggregate_id=gen_random_uuid() where id=$1",[f.old.outbox_id]);
  await deny('old_token_not_revoked','pa_contract_tokens',"update pa_contract_tokens set state='active' where offer_id=$1",[f.old.id]);
  await deny('new_token_not_accepted','pa_contract_tokens',"update pa_contract_tokens set state='revoked' where offer_id=$1",[f.contractId]);
  await deny('replacement_proof_missing','pa_contract_offers',"update pa_contract_offers set snapshot=snapshot#-'{customer_acknowledgement,replaced_offer_id}',snapshot_sha256=encode(sha256(convert_to((snapshot#-'{customer_acknowledgement,replaced_offer_id}')::text,'UTF8')),'hex') where id=$1",[f.contractId]);
  await deny('replacement_audit_missing','pa_inquiry_audit',"delete from pa_inquiry_audit where inquiry_id=$1 and action='formal_contract_replaced'",[f.inquiryId]);
  await deny('old_hash_corrupt','pa_contract_offers',"update pa_contract_offers set snapshot_sha256=repeat('0',64) where id=$1",[f.old.id]);
  await deny('new_original_mismatch','pa_contract_offers',"update pa_contract_offers set quote_pdf=quote_pdf||decode('00','hex'),quote_sha256=encode(sha256(quote_pdf||decode('00','hex')),'hex') where id=$1",[f.contractId]);
  await deny('contract_business_mismatch','pa_contracts',"update pa_contracts set snapshot=jsonb_set(snapshot,'{amount_minor}','110001'),snapshot_sha256=encode(sha256(convert_to(jsonb_set(snapshot,'{amount_minor}','110001')::text,'UTF8')),'hex') where id=$1",[f.contractId]);
  await deny('recipient_mismatch','pa_commercial_outbox',"update pa_commercial_outbox set recipient='other@example.invalid' where id=$1",[f.old.outbox_id]);
  await deny('thread_mismatch','pa_commercial_outbox',"update pa_commercial_outbox set reply_binding=jsonb_set(reply_binding,'{thread_id}','\"other_thread\"') where id=$1",[f.old.outbox_id]);
  await deny('attachment_mismatch','pa_commercial_outbox',"update pa_commercial_outbox set attachment_ids='{}' where id=$1",[f.old.outbox_id]);
  await deny('chronology_mismatch','pa_commercial_outbox',"update pa_commercial_outbox set finished_at=clock_timestamp()+interval '1 day' where id=$1",[f.old.outbox_id]);
  await deny('ack_identity_missing','pa_commercial_outbox',"update pa_commercial_outbox set provider_message_id=null where id=$1",[f.replacement.outbox_id]);
  await f.db.exec('begin');try{await f.db.exec('alter table pa_commercial_outbox disable trigger user');await assert.rejects(f.db.query('update pa_commercial_outbox set provider_response_received=false where id=$1',[f.replacement.outbox_id]),err=>err.code==='23514');evidence.incomplete_ack_rejected_by_existing_constraint=true;}finally{await f.db.exec('rollback');}
  await f.db.exec('begin');try{await f.db.query("insert into pa_commercial_outbox(id,inquiry_id,operation_id,job_kind,aggregate_id,state,recipient,subject,body_text,reply_binding,attachment_ids) values(gen_random_uuid(),$1,gen_random_uuid(),'confirmation',gen_random_uuid(),'unknown','customer@example.invalid','Synthetic','Synthetic','{}','{}')",[f.inquiryId]);assert.equal((await f.gate()).blocked,true);evidence.additional_unknown_blocks=true;}finally{await f.db.exec('rollback');}
  // Reuse exact prior Owner evidence, then commit the genuine no-resend route.
  const input={case_id:f.inquiryId,contract_id:f.contractId,quote:{...f.input.quote,amount_minor:200000,tax_basis:'tax_included'},approval:{source:'gmail',message_id:'approval_quote',thread_id:'thread_123'},change_description:'Synthetic prior adoption',reason:'Synthetic Owner confirmed original',owner_confirmed:true,owner_case_relation_confirmed:true};
  const ep=await f.service.changeEvidencePreview(input,f.actor);await f.service.changeEvidenceAppend({...input,event_kind:'adopted',operation_id:crypto.randomUUID(),fingerprint:ep.fingerprint,previous_event_id:ep.previous_event_id,evidence_sha256:sha(require('../api/_pa-change-evidence.cjs').canonical(ep.evidence))},f.actor);
  const prior=await f.digest(['pa_change_evidence_events']),ready=await f.service.sentQuotePreview(f.input,f.actor);assert.equal(ready.can_complete,true);
  const request={...f.input,adoption_operation_id:crypto.randomUUID(),owner_confirmed:true,fingerprint:ready.fingerprint};
  await f.db.exec("create function public.fixture_fail_058() returns trigger language plpgsql as $$begin raise exception 'fixture_058_rollback';end$$;create trigger fixture_fail_058 before insert on pa_sent_quote_adoptions_v1 for each row execute function fixture_fail_058();");
  const business=['pa_commercial_documents','pa_estimate_revisions','pa_change_orders','pa_case_commercial_state','pa_change_evidence_events','pa_sent_quote_adoptions_v1'],before=await f.digest(business);
  await assert.rejects(f.service.sentQuoteAdopt(request,f.actor));assert.equal(f.rpcError,'fixture_058_rollback');assert.equal(await f.digest(business),before);await f.db.exec('drop trigger fixture_fail_058 on pa_sent_quote_adoptions_v1');
  await f.db.exec('begin');try{
   await f.db.query("insert into pa_commercial_outbox(id,inquiry_id,operation_id,job_kind,aggregate_id,state,recipient,subject,body_text,reply_binding,attachment_ids) values(gen_random_uuid(),$1,gen_random_uuid(),'confirmation',gen_random_uuid(),'unknown','customer@example.invalid','Synthetic','Synthetic','{}','{}')",[f.inquiryId]);
   const v=f.lastRpc;await assert.rejects(f.db.query('select pa_sent_quote_adopt_v1($1,$2,$3,$4,$5,$6)',[v.p_actor,v.p_case,v.p_operation,v.p_request,v.p_evidence,v.p_content_base64]),/sent_quote_commercial_hold/);evidence.commit_rechecks_unknown_after_preview=true;
  }finally{await f.db.exec('rollback');}
  const result=await f.service.sentQuoteAdopt(request,f.actor);assert.equal(result.complete,true);assert.equal(result.document_amount_minor,200000);assert.equal(result.additional_amount_minor,90000);
  assert.equal(await f.digest(protectedTables),immutableBefore);assert.equal(await f.digest(['pa_change_evidence_events']),prior);assert.equal((await f.service.sentQuoteAdopt(request,f.actor)).already_committed,true);
  await assert.rejects(f.db.query('select pa_sent_quote_delivery_gate_v1($1,$2,$3)',[null,f.inquiryId,f.contractId]),/not_authorized/);
  for(const role of ['anon','authenticated']){await f.db.exec('begin;set local role '+role);try{await assert.rejects(f.db.exec('select pa_sent_quote_delivery_gate_v1(null,null,null)'),err=>err.code==='42501');}finally{await f.db.exec('rollback');}}
  assert(!f.network.some(n=>n.path.endsWith('/messages/send')));
  console.log(JSON.stringify({status:'PASS',historical_unknown_not_reconciled:true,exact_explicit_replacement_only:true,original_A_holds:true,alternative_no_resend_registration:true,owner_evidence_reused:true,total_and_delta_distinct:true,atomic_rollback:true,role_denials:true,negative_cases:evidence,production_writes:0,real_sends:0}));
 }finally{await f.db.close();}
}
if(require.main===module)main().catch(e=>{console.error(e);process.exitCode=1;});
module.exports={fixture,main};
