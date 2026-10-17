'use strict';
const assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path');
const {PDFDocument}=require('pdf-lib'),{setup,MODE}=require('./validate-pam-025-direct-confirmation.cjs');
const {createService,decryptSecret}=require('../api/_pa-commercial.cjs');
const {sha}=require('../api/_pa-contract-pdf.cjs');
const json=(body,status=200)=>({ok:status<300,status,json:async()=>body});
async function fixture(post){
 const f=await setup({transport:async()=>({gmail_message_id:'managed_fixture_ack',gmail_thread_id:'thread_123'})});
 for(const file of ['PAUI-051-change-evidence.sql','PAUI-057-sent-quote-adoption.sql'])await f.db.exec(fs.readFileSync(path.join(__dirname,'../ops',file),'utf8'));
 await f.createEstimate();
 if(post){const p=await f.service.confirmationPreview({case_id:f.inquiryId,confirmation_mode:MODE},f.actor),o=await f.service.issueDirectConfirmationAndSend({case_id:f.inquiryId,confirmation_mode:MODE,preview_fingerprint:p.fingerprint,operation_id:crypto.randomUUID()},f.actor);
  const job=(await f.db.query('select * from pa_commercial_outbox where id=$1',[o.outbox_id])).rows[0],offer=(await f.db.query('select * from pa_contract_offers where id=$1',[o.id])).rows[0];
  await f.contract.accept({token:decryptSecret(job.secret_envelope).split('#')[1],offer_id:o.id,snapshot_sha256:offer.snapshot_sha256,confirmer_name:'Synthetic Owner',agree:true});
 }
 const p=await PDFDocument.create();p.addPage().drawText('TOTAL JPY 200,000');f.bytes=Buffer.from(await p.save());
 const when=Date.now()+600000,thread='thread_123';
 f.messages=new Map();
 const raw=(id,sent,time,body,reference)=>({id,threadId:thread,labelIds:[sent?'SENT':'INBOX'],internalDate:String(time),payload:{mimeType:'multipart/mixed',headers:[{name:'From',value:sent?'aratechsound@gmail.com':'customer@example.invalid'},{name:'To',value:sent?'customer@example.invalid':'aratechsound@gmail.com'},{name:'Subject',value:'Synthetic estimate approval'},{name:'Message-ID',value:'<'+id+'@fixture.invalid>'},...(reference?[{name:'In-Reply-To',value:reference},{name:'References',value:reference}]:[])],parts:[{mimeType:'text/plain',body:{data:Buffer.from(body).toString('base64url')}},...(sent?[{mimeType:'application/pdf',partId:'1',filename:'revised-total.pdf',body:{attachmentId:'sent_quote_att',size:f.bytes.length}}]:[])]}});
 f.messages.set('sent_quote',raw('sent_quote',true,when,'Synthetic sent quote'));
 f.messages.set('approval_quote',raw('approval_quote',false,when+1000,'見積書を確認し承認します。','<sent_quote@fixture.invalid>'));
 for(const [id,m]of f.messages)await f.db.query('insert into pa_gmail_message_index(gmail_message_id,gmail_thread_id,inquiry_id,direction,from_address,to_addresses,cc_addresses,subject,message_source,sent_at,received_at,attachment_metadata) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',[id,thread,f.inquiryId,id==='sent_quote'?'outbound':'inbound',id==='sent_quote'?'aratechsound@gmail.com':'customer@example.invalid',id==='sent_quote'?['customer@example.invalid']:['aratechsound@gmail.com'],[],'Synthetic estimate approval','gmail_direct',id==='sent_quote'?new Date(when).toISOString():null,id==='sent_quote'?null:new Date(when+1000).toISOString(),id==='sent_quote'?[{id:'sent_quote_att',part_id:'1',mime_type:'application/pdf',filename:'revised-total.pdf',size:f.bytes.length}]:[]]);
 f.calls=[];f.originalWrong=false;f.lastRpc=null;f.failReadback=false;
 f.fetch=async(url,options={})=>{const u=new URL(url);f.calls.push({path:u.pathname,method:options.method||'GET'});
  if(u.pathname.endsWith('/rpc/pa_sent_quote_adopt_v1')||u.pathname.endsWith('/rpc/pa_change_evidence_append')){
   const name=u.pathname.split('/').at(-1),v=JSON.parse(options.body),keys=Object.keys(v);f.lastRpc=structuredClone(v);
   try{return json((await f.db.query('select '+name+'('+keys.map((k,i)=>k+'=> $'+(i+1)).join(',')+') result',Object.values(v))).rows[0].result);}catch(e){f.rpcError=e.message;return json({message:e.message},400);}
  }
  if(f.failReadback&&u.pathname.endsWith('/pa_sent_quote_adoptions_v1'))return json({},503);
  if(u.host==='gmail.googleapis.com'){
   assert.equal(options.method||'GET','GET','already-delivered registration cannot modify Gmail');
   if(u.pathname.includes('/attachments/'))return json({data:(f.originalWrong?Buffer.from('wrong'):f.bytes).toString('base64url')});
   if(u.pathname.includes('/threads/'))return json({id:thread,messages:[...f.messages.values()]});
   if(u.pathname.includes('/messages/'))return json(f.messages.get(u.pathname.split('/').at(-1))||{},f.messages.has(u.pathname.split('/').at(-1))?200:404);
  }
  return f.fetchImpl(url,options);
 };
 f.service=createService({fetchImpl:f.fetch});
 f.input={case_id:f.inquiryId,owner_original_selected:true,quote:{source:'gmail',message_id:'sent_quote',thread_id:thread,attachment_id:'sent_quote_att',part_id:'1',sha256:sha(f.bytes)},values:{document_amount_minor:200000,tax_basis:'tax_included',currency:'JPY',owner_amounts_confirmed:true,...(post?{amount_basis:'revised_total',revised_total_minor:200000,additional_amount_minor:90000}:{})}};
 f.digest=async tables=>JSON.stringify(await Promise.all(tables.map(async t=>(await f.db.query('select to_jsonb(t) v from '+t+' t order by to_jsonb(t)::text')).rows)));
 return f;
}
async function main(){
 global.fetch=async()=>{throw Error('LIVE_NETWORK_FORBIDDEN');};
 for(const scenario of ['pre','post','post_existing_adoption']){
  const post=scenario!=='pre',reuse=scenario==='post_existing_adoption',f=await fixture(post);
  try{
   if(reuse){
    const c=(await f.db.query('select * from pa_contracts where inquiry_id=$1',[f.inquiryId])).rows[0],input={case_id:f.inquiryId,contract_id:c.id,quote:f.input.quote,approval:{source:'gmail',message_id:'approval_quote',thread_id:'thread_123'},change_description:'Synthetic prior adoption',reason:'Synthetic Owner already confirmed original',owner_confirmed:true,owner_case_relation_confirmed:true};
    const p=await f.service.changeEvidencePreview(input,f.actor);await f.service.changeEvidenceAppend({...input,event_kind:'adopted',operation_id:crypto.randomUUID(),fingerprint:p.fingerprint,previous_event_id:p.previous_event_id,evidence_sha256:sha(require('../api/_pa-change-evidence.cjs').canonical(p.evidence))},f.actor);
   }
   const frozen=['pa_contracts','pa_contract_receipts','pa_contract_offers','pa_contract_tokens','pa_billings','pa_payment_records','pa_payment_adjustments','pa_commercial_outbox'];
   const immutableBefore=await f.digest(frozen),priorAdoption=await f.digest(['pa_change_evidence_events']),business=['pa_estimate_revisions','pa_commercial_documents','pa_change_orders','pa_case_commercial_state','pa_change_evidence_events','pa_sent_quote_adoptions_v1'];
   const before=await f.digest(business);
   const missing=await f.service.sentQuotePreview({...f.input,values:{}},f.actor);assert.equal(missing.can_complete,false);assert(missing.reasons.includes('OWNER_AMOUNT_CONFIRMATION_REQUIRED'));
   const preview=await f.service.sentQuotePreview(f.input,f.actor);assert.equal(preview.phase,post?'POST_CONTRACT':'PRE_CONTRACT');assert.equal(preview.can_complete,true,JSON.stringify(preview.reasons));assert.equal(preview.approval.message_id,'approval_quote');
   assert.equal(await f.digest(business),before,'all preview, field edits and cancellation are read-only');
   await assert.rejects(f.service.sentQuoteAdopt({...f.input,adoption_operation_id:crypto.randomUUID(),fingerprint:'wrong',owner_confirmed:true},f.actor),/sent_quote_changed/);
   f.originalWrong=true;await assert.rejects(f.service.sentQuotePreview(f.input,f.actor));f.originalWrong=false;
   await assert.rejects(f.service.sentQuotePreview({...f.input,case_id:f.otherId},f.actor));
   await assert.rejects(f.service.sentQuotePreview({...f.input,approval_message_id:'other_case_message',approval_thread_id:'thread_other'},f.actor),/sent_quote_identity_mismatch/);
   // Loss or ambiguity never grants permission to adopt by similar text.
   const original=f.messages.get('approval_quote');f.messages.delete('approval_quote');assert.equal((await f.service.sentQuotePreview(f.input,f.actor)).can_complete,false);f.messages.set('approval_quote',original);
   const copy=structuredClone(original);copy.id='approval_second';copy.payload.headers.find(h=>h.name==='Message-ID').value='<approval_second@fixture.invalid>';f.messages.set(copy.id,copy);
   await f.db.query("insert into pa_gmail_message_index(gmail_message_id,gmail_thread_id,inquiry_id,direction,from_address,to_addresses,subject,message_source,received_at,attachment_metadata) select 'approval_second',gmail_thread_id,inquiry_id,direction,from_address,to_addresses,subject,message_source,received_at,'[]'::jsonb from pa_gmail_message_index where gmail_message_id='approval_quote'");
   assert.equal((await f.service.sentQuotePreview(f.input,f.actor)).can_complete,false);
   const selected={...f.input,approval_message_id:'approval_quote',approval_thread_id:'thread_123'},ready=await f.service.sentQuotePreview(selected,f.actor);assert.equal(ready.can_complete,true);
   if(post){const wrong=await f.service.sentQuotePreview({...selected,values:{...selected.values,additional_amount_minor:200000}},f.actor);assert.equal(wrong.can_complete,false,'PDF total cannot be treated as additional charge');
    await f.db.query("update pa_case_commercial_state set unresolved_changes=true where inquiry_id=$1",[f.inquiryId]);assert.equal((await f.service.sentQuotePreview(selected,f.actor)).can_complete,false);await f.db.query("update pa_case_commercial_state set unresolved_changes=false where inquiry_id=$1",[f.inquiryId]);}
   // A failure after every commercial insert must roll back ALL ledgers.
   await f.db.exec("create function public.fixture_fail_registration() returns trigger language plpgsql as $$begin raise exception 'fixture_atomic_failure';end$$;create trigger fixture_fail before insert on pa_sent_quote_adoptions_v1 for each row execute function fixture_fail_registration();");
   const op=crypto.randomUUID(),commit={...selected,adoption_operation_id:op,owner_confirmed:true,fingerprint:ready.fingerprint};
   const rollbackBefore=await f.digest(business);await assert.rejects(f.service.sentQuoteAdopt(commit,f.actor),/service_unavailable/);assert.equal(f.rpcError,'fixture_atomic_failure','failure injection must be reached after all preceding SQL guards');assert.equal(await f.digest(business),rollbackBefore,'transaction rollback protects evidence and business state');
   const rpc=f.lastRpc;await f.db.exec('drop trigger fixture_fail on pa_sent_quote_adoptions_v1;');
   const result=await f.service.sentQuoteAdopt(commit,f.actor);assert.equal(result.complete,true);assert.equal(result.amount_basis,post?'revised_total':'initial_total');assert.equal(result.document_amount_minor,200000);assert.equal(result.additional_amount_minor,post?90000:0);
   assert.equal(await f.digest(frozen),immutableBefore,'no original contract, confirmation, billing, payment or outbox is changed');
   const stateAfter=await f.digest(business),replay=await f.service.sentQuoteAdopt(commit,f.actor);assert.equal(replay.id,result.id);assert.equal(replay.already_committed,true);assert.equal(await f.digest(business),stateAfter);
   await assert.rejects(f.service.sentQuoteAdopt({...commit,values:{...commit.values,document_amount_minor:200001}},f.actor),/idempotency_payload_mismatch/);
   await assert.rejects(f.service.sentQuoteAdopt(commit,{id:crypto.randomUUID()}));
   const afterReload=createService({fetchImpl:f.fetch});assert.equal((await afterReload.sentQuoteStatus({case_id:f.inquiryId,adoption_operation_id:op},f.actor)).id,result.id);
   const results=await Promise.all([1,2].map(()=>f.db.query('select pa_sent_quote_adopt_v1($1,$2,$3,$4,$5,$6) v',[rpc.p_actor,rpc.p_case,rpc.p_operation,rpc.p_request,rpc.p_evidence,rpc.p_content_base64])));assert(results.every(r=>r.rows[0].v.already_committed));assert.equal(await f.digest(business),stateAfter);
   f.failReadback=true;await assert.rejects(afterReload.sentQuoteStatus({case_id:f.inquiryId,adoption_operation_id:op},f.actor),/sent_quote_storage_unavailable/);f.failReadback=false;
   const rights=(await f.db.query("select has_function_privilege('service_role','pa_sent_quote_adopt_v1(uuid,uuid,uuid,jsonb,jsonb,text)','EXECUTE') service,has_function_privilege('anon','pa_sent_quote_adopt_v1(uuid,uuid,uuid,jsonb,jsonb,text)','EXECUTE') anon,has_function_privilege('authenticated','pa_sent_quote_adopt_v1(uuid,uuid,uuid,jsonb,jsonb,text)','EXECUTE') authenticated")).rows[0];assert.deepEqual(rights,{service:true,anon:false,authenticated:false});
   await assert.rejects(f.db.exec('update pa_sent_quote_adoptions_v1 set part_id=part_id'),/commercial_history_immutable/);
   if(post){assert.equal((await f.db.query('select agreed_amount_minor from pa_change_orders where id=$1',[result.change_order_id])).rows[0].agreed_amount_minor,90000);assert.equal((await f.db.query('select count(*)::int n from pa_change_evidence_events')).rows[0].n,1);}
   if(reuse)assert.equal(await f.digest(['pa_change_evidence_events']),priorAdoption,'PAUI-054 adoption is reused byte-for-byte, without another event');
   if(scenario==='post'){
    const mail=require('../api/_pa-mail.cjs'),ops=require('../api/_pa-reply-operations.cjs'),source='invoice_source';
    const original=f.messages.get('sent_quote'),incoming=structuredClone(f.messages.get('approval_quote'));incoming.id=source;incoming.internalDate=String(Number(original.internalDate)-1000);incoming.payload.headers=incoming.payload.headers.filter(h=>!['Message-ID','In-Reply-To','References'].includes(h.name));incoming.payload.headers.push({name:'Message-ID',value:'<invoice_source@fixture.invalid>'});f.messages.set(source,incoming);
    original.payload.headers.push({name:'In-Reply-To',value:'<invoice_source@fixture.invalid>'},{name:'References',value:'<invoice_source@fixture.invalid>'});
    await f.db.query("insert into pa_gmail_message_index(gmail_message_id,gmail_thread_id,inquiry_id,direction,from_address,to_addresses,subject,message_source,received_at,attachment_metadata) select $1,gmail_thread_id,inquiry_id,direction,from_address,to_addresses,subject,message_source,$2,'[]'::jsonb from pa_gmail_message_index where gmail_message_id='approval_quote'",[source,new Date(Number(incoming.internalDate)).toISOString()]);
    const preview={inquiry_id:f.inquiryId,gmail_thread_id:'thread_123',reply_source_message_id:source,reply_source_rfc_message_id:'<invoice_source@fixture.invalid>',reply_source_authority_hash:'fixture',recipient:'customer@example.invalid',cc_addresses:[],subject:'Synthetic estimate approval',body:mail.normalizeCustomerBody('Synthetic sent quote')};
    const attachments=mail.normalizeReplyAttachments([{filename:'revised-total.pdf',mime_type:'application/pdf',data:f.bytes.toString('base64url'),document_kind:'invoice'}]);
    const prepared=await ops.prepare({actorId:f.actor.id,preview,attachments},f.fetch),operation=prepared.operation;await ops.act(f.actor.id,'claim',operation,{},f.fetch);await ops.act(f.actor.id,'sent',operation,{gmail_message_id:'sent_quote',gmail_thread_id:'thread_123'},f.fetch);
    const doc=crypto.randomUUID(),billing=crypto.randomUUID(),r=(await f.db.query('select * from pa_sent_quote_adoptions_v1 where id=$1',[result.id])).rows[0];
    await f.db.query("insert into pa_commercial_documents(id,inquiry_id,document_kind,source_kind,original_filename,mime_type,content,sha256,created_by) values($1,$2,'invoice','private_upload','invoice.pdf','application/pdf',$3,$4,$5)",[doc,f.inquiryId,f.bytes,sha(f.bytes),f.actor.id]);
    await f.db.query("insert into pa_billings(id,inquiry_id,billing_number,contract_id,estimate_revision_id,amount_minor,invoice_policy,invoice_document_id,invoice_delivery_state,due_basis,agreement_evidence,operation_id,created_by) values($1,$2,1,$3,$4,200000,'separate_pdf',$5,'registered','{}','{}',$6,$7)",[billing,f.inquiryId,r.contract_id,r.estimate_revision_id,doc,crypto.randomUUID(),f.actor.id]);
    const invoiceInput={case_id:f.inquiryId,operation_id:operation.operation_id,gmail_message_id:'sent_quote',part_id:'1',sha256:sha(f.bytes)},invoiceBefore=await f.digest([...frozen,'pa_estimate_revisions','pa_change_orders']);
    const invoice=await f.service.replyDocumentReview(invoiceInput,f.actor);assert.equal(invoice.invoice_state,'REGISTERED_IDENTITY_MATCH');assert.equal(invoice.billing.id,billing);assert.equal(invoice.commercial_write,false);assert.equal(await f.digest([...frozen,'pa_estimate_revisions','pa_change_orders']),invoiceBefore,'invoice reading cannot confirm invoice, payment or amount');
    await assert.rejects(f.service.replyDocumentReview({...invoiceInput,sha256:'0'.repeat(64)},f.actor));
    await f.db.exec('begin');
    try{const unknown=await ops.prepare({actorId:f.actor.id,preview:{...preview,body:mail.normalizeCustomerBody('Another uncertain reply')},attachments},f.fetch);await ops.act(f.actor.id,'claim',unknown.operation,{},f.fetch);await ops.act(f.actor.id,'unknown',unknown.operation,{},f.fetch);
     await assert.rejects(f.service.sentQuotePreview(f.input,f.actor),/sent_quote_commercial_hold/,'manual original selection cannot bypass an UNKNOWN send on that thread');
     await assert.rejects(f.service.sentQuotePreview({...f.input,operation_id:unknown.operation.operation_id},f.actor),/reply_document_unconfirmed/);
    }finally{await f.db.exec('rollback');}
   }
   assert(!f.calls.some(c=>c.path.endsWith('/messages/send')));
  }finally{await f.db.close();}
 }
 const manual=await fixture(true);
 try{
  const m=manual.messages.get('approval_quote');m.threadId='separate_approval_thread';m.payload.headers=m.payload.headers.filter(h=>!['In-Reply-To','References'].includes(h.name));
  await manual.db.query("update pa_gmail_message_index set gmail_thread_id='separate_approval_thread' where gmail_message_id='approval_quote'");
  const input={...manual.input,approval_message_id:'approval_quote',approval_thread_id:'separate_approval_thread'},unconfirmed=await manual.service.sentQuotePreview(input,manual.actor);
  assert.equal(unconfirmed.approval.status,'owner_reviewed');assert.equal(unconfirmed.can_complete,false);assert(unconfirmed.reasons.includes('MANUAL_APPROVAL_CONFIRMATION_REQUIRED'));
  const confirmed={...input,values:{...input.values,owner_approval_confirmed:true,owner_approval_reason:'隔離原本の見積PDFと別threadの顧客了承をOwnerが確認しました。'}},ready=await manual.service.sentQuotePreview(confirmed,manual.actor);assert.equal(ready.can_complete,true);
  const original=m.payload.parts[0].body.data;m.payload.parts[0].body.data=Buffer.from('再見積をお願いします。修正してください。').toString('base64url');assert.equal((await manual.service.sentQuotePreview(confirmed,manual.actor)).can_complete,false,'a clearly negative reply is not an approval even with manual fields');m.payload.parts[0].body.data=original;
  const r=await manual.service.sentQuoteAdopt({...confirmed,adoption_operation_id:crypto.randomUUID(),fingerprint:ready.fingerprint,owner_confirmed:true},manual.actor);assert.equal(r.complete,true);const e=(await manual.db.query('select evidence from pa_change_evidence_events where id=$1',[r.adoption_event_id])).rows[0].evidence;assert.equal(e.approval.status,'owner_reviewed');assert.equal(e.approval.exact_quote_reference,false);assert.equal(e.owner_reason,confirmed.values.owner_approval_reason);
 }finally{await manual.db.close();}
 // Existing authentication/Origin/rate guards must run before the new actions.
 const {createHandler}=require('../api/_pa-commercial-handler.cjs');let invoked=0;const service={sentQuotePreview:async()=>{invoked++;return {};}};
 const admin=async token=>{if(token!=='owner-fixture')throw Error('not_authorized');return {id:crypto.randomUUID()};};
 const call=async({origin='https://fixture.invalid',token='owner-fixture',allowed=true}={})=>{const handler=createHandler({service,admin,rate:async()=>({allowed,retryAfter:60})}),res={setHeader(){},status(n){this.statusCode=n;return this;},json(body){this.body=body;return this;}};await handler({method:'POST',headers:{origin,authorization:'Bearer '+token},body:{action:'sent_quote_preview'},socket:{remoteAddress:'127.0.0.1'}},res);return res;};
 process.env.ALLOWED_ORIGINS='https://fixture.invalid';assert.equal((await call({origin:'https://foreign.invalid'})).statusCode,403);assert.equal((await call({token:'wrong'})).statusCode,401);assert.equal((await call({allowed:false})).statusCode,429);assert.equal(invoked,0);assert.equal((await call()).statusCode,200);assert.equal(invoked,1);
 console.log(JSON.stringify({status:'PASS',pre_contract_reuses_recover_current:true,post_contract_without_resend:true,total_vs_additional_distinct:true,strict_original_and_approval:true,ambiguous_not_adopted:true,atomic_rollback:true,replay_and_reload_safe:true,existing_paui054_evidence_reused:true,registered_invoice_readonly_match:true,unknown_manual_bypass_rejected:true,service_role_only:true,immutable_registration:true,original_contract_billing_outbox_unchanged:true,real_sends:0,production_writes:0}));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
