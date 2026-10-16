'use strict';
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const {setup,MODE}=require('./validate-pam-025-direct-confirmation.cjs'),{read}=require('./helpers/pa-estimate-fixture.cjs');
const {createService,decryptSecret}=require('../api/_pa-commercial.cjs'),{createHandler}=require('../api/_pa-commercial-handler.cjs');
const {sha}=require('../api/_pa-contract-pdf.cjs'),{canonical}=require('../api/_pa-change-evidence.cjs'),{PDFDocument}=require('pdf-lib');
const json=(data,status=200)=>({ok:status<300,status,json:async()=>data});
async function main(){
 global.fetch=async()=>{throw Error('LIVE_NETWORK_FORBIDDEN');};
 const f=await setup({transport:async()=>({gmail_message_id:'mock_sent',gmail_thread_id:'thread_123'})});
 try{
  await f.db.exec(require('node:fs').readFileSync(require('node:path').join(__dirname,'../ops/PAUI-051-change-evidence.sql'),'utf8'));
  const e=await f.createEstimate(),p=await f.service.confirmationPreview({case_id:f.inquiryId,confirmation_mode:MODE},f.actor);
  const sent=await f.service.issueDirectConfirmationAndSend({case_id:f.inquiryId,confirmation_mode:MODE,preview_fingerprint:p.fingerprint,operation_id:crypto.randomUUID()},f.actor);
  const job=(await f.db.query('select * from pa_commercial_outbox where id=$1',[sent.outbox_id])).rows[0],offer=(await f.db.query('select * from pa_contract_offers where id=$1',[sent.id])).rows[0];
  await f.contract.accept({token:decryptSecret(job.secret_envelope).split('#')[1],offer_id:sent.id,snapshot_sha256:offer.snapshot_sha256,confirmer_name:'Fixture Owner',agree:true});
  const protectedNames=['pa_case_commercial_state','pa_estimate_revisions','pa_commercial_documents','pa_contract_offers','pa_contracts','pa_billings','pa_payment_records','pa_commercial_outbox'];
  const digest=async()=>{const o={};for(const t of protectedNames)o[t]=(await f.db.query('select to_jsonb(t) data from '+t+' t order by to_jsonb(t)::text')).rows;return canonical(o);};
  const before=await digest(),providerBefore=f.state.sendCount;let uncertain=false,foreign=false,ambiguous=false,duplicate=false,network=[];
  const stamp=Date.now()+86400000;
  let rotatedAttachment=false,duplicatePart=false;
  const raw=(id)=>{const out=id==='change_sent';return {id,labelIds:out?['SENT']:['INBOX'],threadId:foreign?'thread_other':id==='separate_reply'?'unlinked_thread':'thread_123',internalDate:String(stamp+(out?0:1000)),payload:{mimeType:'multipart/mixed',headers:[{name:'From',value:out?'aratechsound@gmail.com':'customer@example.invalid'},{name:'To',value:out?'customer@example.invalid':'aratechsound@gmail.com'},{name:'Subject',value:out?'見積書変更':'Re: 見積書変更'},{name:'Message-ID',value:'<'+id+'@example.invalid>'},...(!out?[{name:'In-Reply-To',value:'<change_sent@example.invalid>'},{name:'References',value:'<change_sent@example.invalid>'}]:[])],parts:[{mimeType:'text/plain',body:{data:Buffer.from(out?'変更見積書です。':(ambiguous?'見積を検討します。':'機材構成および見積書を確認いたしました。こちらの内容でお願いいたします。')+'\n\n> 過去の引用').toString('base64url')}},...(out?[{mimeType:'application/pdf',filename:'変更見積.pdf',partId:'1',body:{attachmentId:rotatedAttachment?'attachment_rotated':'attachment_1',size:f.quote.length}},...(duplicatePart?[{mimeType:'application/pdf',filename:'other.pdf',partId:'1',body:{attachmentId:'attachment_duplicate',size:f.quote.length}}]:[])]:[])]}};};
  await f.db.query(`insert into pa_gmail_message_index(gmail_message_id,gmail_thread_id,inquiry_id,direction,from_address,message_source,sent_at,received_at,subject,to_addresses,attachment_metadata) values
   ('change_sent','thread_123',$1,'outbound','aratechsound@gmail.com','gmail_direct',$2,null,'変更見積書','["customer@example.invalid"]',$3),
   ('approval_1','thread_123',$1,'inbound','customer@example.invalid','gmail_direct',null,$2,'Re: 変更見積書','["aratechsound@gmail.com"]','[]')`,[f.inquiryId,new Date(stamp).toISOString(),JSON.stringify([{id:'attachment_1',part_id:'1',filename:'変更見積.pdf',mime_type:'application/pdf'}])]);
  const fetchImpl=async(url,options={})=>{
   const u=new URL(url);network.push({host:u.host,path:u.pathname,method:options.method||'GET'});
   if(u.pathname.endsWith('/rpc/pa_change_evidence_append')){const v=JSON.parse(options.body),keys=Object.keys(v);try{const r=await f.db.query('select pa_change_evidence_append('+keys.map((k,i)=>k+'=> $'+(i+1)).join(',')+') result',Object.values(v));return json(r.rows[0].result);}catch(err){return json({message:err.message},400);}}
   if(u.host==='gmail.googleapis.com'&&u.pathname.endsWith('/messages'))return json({messages:duplicate?[{id:'separate_reply'},{id:'approval_2'}]:[{id:'separate_reply'}]});
   if(u.host==='gmail.googleapis.com'&&u.pathname.endsWith('/attachments/attachment_rotated'))return json({data:(f.state.quote||f.quote).toString('base64url'),size:(f.state.quote||f.quote).length});
   if(u.host==='gmail.googleapis.com'&&/\/messages\/(change_sent|approval_1|approval_2|separate_reply)$/u.test(u.pathname)){if(uncertain)throw Error('fixture_original_unavailable');return json(raw(u.pathname.split('/').at(-1)));}
   return f.fetchImpl(url,options);
  };
  const service=createService({fetchImpl}),base={case_id:f.inquiryId,contract_id:sent.id,quote:{source:'gmail',message_id:'change_sent',thread_id:'thread_123',attachment_id:'attachment_1',part_id:'1',amount_minor:110000,tax_basis:'tax_included'},approval:{source:'gmail',message_id:'approval_1',thread_id:'thread_123'},change_description:'機材構成を変更',reason:'原本と顧客の承認文を確認',owner_confirmed:true,owner_case_relation_confirmed:true};
  const model=await service.changeEvidencePreview(base,f.actor);assert(model.can_adopt);assert.equal(model.evidence.quote.sha256,sha(f.quote));assert.equal(model.evidence.quote.estimate_id,e.id);assert.equal(model.evidence.approval.status,'verified');assert(!model.evidence.approval.reply_body.includes('過去の引用'));assert(model.evidence.approval.quoted_body.includes('過去の引用'));
  assert.equal(await digest(),before,'Read-only evidence matching preserves contract, estimate, invoices/payments and outbox');
  const candidates=await service.changeEvidenceCandidates({case_id:f.inquiryId,detect:true},f.actor);assert.equal(candidates.detected.length,1);assert.equal(candidates.detection_state,'candidate_found');
  rotatedAttachment=true;
  const rotated=await service.changeEvidencePreview(base,f.actor);assert.equal(rotated.evidence.quote.sha256,model.evidence.quote.sha256);assert.equal(rotated.fingerprint,model.fingerprint,'A transient Gmail resource ID must not change evidence identity');
  assert.equal((await service.changeEvidenceCandidates({case_id:f.inquiryId,detect:true},f.actor)).detected.length,1);
  await assert.rejects(service.changeEvidencePreview({...base,quote:{...base.quote,part_id:'2'}},f.actor),/change_evidence_mismatch/);
  await assert.rejects(service.changeEvidencePreview({...base,quote:{...base.quote,attachment_id:'unindexed_resource'}},f.actor),/change_evidence_mismatch/);
  duplicatePart=true;await assert.rejects(service.changeEvidencePreview(base,f.actor),/change_evidence_mismatch/);duplicatePart=false;rotatedAttachment=false;
  duplicate=true;const search=await service.changeEvidenceCandidates({case_id:f.inquiryId,search:{keywords:'見積'},detect:true},f.actor);assert(search.detected.length>1);assert.equal(search.detection_state,'multiple_candidates');duplicate=false;
  uncertain=true;const unavailable=await service.changeEvidenceCandidates({case_id:f.inquiryId,detect:true},f.actor);assert.equal(unavailable.detection_state,'incomplete');assert(unavailable.detection_errors.length);await assert.rejects(service.changeEvidencePreview(base,f.actor));uncertain=false;
  foreign=true;await assert.rejects(service.changeEvidencePreview(base,f.actor),/change_evidence_mismatch/);foreign=false;
  const separate=await service.changeEvidencePreview({...base,approval:{source:'gmail',message_id:'separate_reply',thread_id:'unlinked_thread'}},f.actor);assert(separate.can_adopt);assert.equal(separate.evidence.approval.linked,false);assert(separate.evidence.warnings.includes('unlinked_thread_requires_owner_case_confirmation'));
  const separateUnchecked=await service.changeEvidencePreview({...base,owner_case_relation_confirmed:false,approval:{source:'gmail',message_id:'separate_reply',thread_id:'unlinked_thread'}},f.actor);assert.equal(separateUnchecked.can_adopt,false);
  ambiguous=true;const a=await service.changeEvidencePreview(base,f.actor);assert.equal(a.evidence.approval.approval_language,'ambiguous');assert.equal(a.evidence.approval.status,'owner_reviewed');ambiguous=false;
  await assert.rejects(service.changeEvidencePreview({...base,quote:{...base.quote,sha256:'f'.repeat(64)}},f.actor));
  await assert.rejects(service.changeEvidencePreview({...base,case_id:f.otherId},f.actor),/contract_not_found/);
  await assert.rejects(service.changeEvidencePreview({...base,quote:{...base.quote,amount_minor:999999}},f.actor),/change_evidence_mismatch/);
  const manualDoc=await PDFDocument.create();manualDoc.addPage().drawText('Manual evidence fixture');const manualBytes=Buffer.from(await manualDoc.save());
  f.state.quote=manualBytes;
  const unknownAmount=await service.changeEvidenceCandidates({case_id:f.inquiryId,detect:true},f.actor);assert.equal(unknownAmount.detected.length,1);assert.equal(unknownAmount.detected[0].quote.amount_minor,null,'Unavailable extraction must retain the original candidate without inventing an amount');
  const ownerAmount=await service.changeEvidencePreview({...base,quote:{...base.quote,amount_minor:200000}},f.actor);assert(ownerAmount.evidence.warnings.includes('amount_requires_owner_pdf_confirmation'));assert.equal(ownerAmount.evidence.quote.registered_sha_match,false);
  await assert.rejects(service.changeEvidencePreview({...base,quote:{...base.quote,amount_minor:200000,compare_estimate_id:e.id}},f.actor),/change_evidence_mismatch/);
  f.state.quote=f.quote;
  const local={...base,quote:{source:'local',filename:'manual.pdf',content_base64:f.quote.toString('base64'),sha256:sha(f.quote),amount_minor:110000,tax_basis:'tax_included'},approval:{source:'manual_pdf',filename:'mail-copy.pdf',content_base64:manualBytes.toString('base64'),sha256:sha(manualBytes)}};
  const manual=await service.changeEvidencePreview(local,f.actor);assert.equal(manual.evidence.approval.gmail_original_verified,false);assert(manual.can_adopt);assert(manual.evidence.warnings.includes('local_original_delivery_unverified'));
  const copy=await service.changeEvidenceMailPdf(base,f.actor);assert.equal((await PDFDocument.load(copy.bytes)).getPageCount()>0,true);assert.equal(await digest(),before);
  const original=await service.changeEvidenceContractPdf({case_id:f.inquiryId,contract_id:sent.id});assert(original.bytes.length>0);assert.equal(await digest(),before);
  const op=crypto.randomUUID(),commit={...base,event_kind:'adopted',operation_id:op,fingerprint:model.fingerprint,previous_event_id:model.previous_event_id,evidence_sha256:sha(canonical(model.evidence))};
  const adopted=await service.changeEvidenceAppend(commit,f.actor);assert.equal(adopted.event_kind,'adopted');assert.equal((await service.changeEvidenceAppend(commit,f.actor)).already_committed,true);
  assert.equal((await service.changeEvidenceCandidates({case_id:f.inquiryId},f.actor)).current_agreement.id,adopted.id);
  assert.equal(await digest(),before,'Adoption appends authority/audit only; original commercial tables remain byte-equivalent');
  assert.equal((await f.db.query('select count(*)::int n from pa_change_evidence_blobs')).rows[0].n,0,'Identical registered PDF must not be duplicated');
  const draftPreview=await service.changeEvidencePreview({...base,change_description:'次の変更候補'},f.actor);
  const draft=await service.changeEvidenceAppend({...base,change_description:'次の変更候補',event_kind:'saved',operation_id:crypto.randomUUID(),previous_event_id:draftPreview.previous_event_id,fingerprint:draftPreview.fingerprint},f.actor);
  assert.equal((await service.changeEvidenceCandidates({case_id:f.inquiryId},f.actor)).current_agreement.id,adopted.id,'Saving another candidate must preserve adopted authority');
  await assert.rejects(service.changeEvidenceAppend({...commit,reason:'changed'},f.actor),/idempotency_payload_mismatch/);
  await assert.rejects(service.changeEvidenceAppend({...commit,operation_id:crypto.randomUUID()},f.actor),/change_evidence_changed/);
  const revoked=await service.changeEvidenceAppend({case_id:f.inquiryId,contract_id:sent.id,operation_id:crypto.randomUUID(),event_kind:'revoked',previous_event_id:draft.id,reason:'証拠を再確認する'},f.actor);assert.equal(revoked.event_kind,'revoked');assert.equal((await service.changeEvidenceCandidates({case_id:f.inquiryId},f.actor)).current_agreement,null);
  const again=await service.changeEvidencePreview(local,f.actor),saved=await service.changeEvidenceAppend({...local,event_kind:'saved',operation_id:crypto.randomUUID(),previous_event_id:again.previous_event_id,fingerprint:again.fingerprint},f.actor);assert.equal(saved.event_kind,'saved');assert.equal(await digest(),before);
  for(const table of ['pa_change_evidence_events','pa_change_evidence_blobs']){await assert.rejects(f.db.exec('delete from '+table),/change_evidence_immutable/);assert.equal((await f.db.query("select has_table_privilege('authenticated',$1,'SELECT') allowed",[table])).rows[0].allowed,false);assert.equal((await f.db.query("select has_table_privilege('service_role',$1,'INSERT') allowed",[table])).rows[0].allowed,false);}
  assert.equal((await f.db.query("select has_function_privilege('service_role','pa_change_evidence_append(uuid,uuid,uuid,uuid,uuid,text,jsonb,text,jsonb)','EXECUTE') allowed")).rows[0].allowed,true);
  assert.equal((await f.db.query("select has_function_privilege('authenticated','pa_change_evidence_append(uuid,uuid,uuid,uuid,uuid,text,jsonb,text,jsonb)','EXECUTE') allowed")).rows[0].allowed,false);
  for(const role of ['anon','authenticated','service_role'])assert.equal((await f.db.query('select has_sequence_privilege($1,$2,$3) allowed',[role,'pa_change_evidence_events_event_number_seq','USAGE'])).rows[0].allowed,false);
  const invoke=async(options,origin='https://fixture.invalid')=>{const res={setHeader(){},status(n){this.code=n;return this;},json(b){this.body=b;}};await createHandler(options)({method:'POST',headers:{origin,authorization:'Bearer fixture'},body:{action:'change_evidence_preview',...base}},res);return res;};
  assert.equal((await invoke({service,admin:async()=>{throw Error('not_authorized');},rate:async()=>({allowed:true})})).code,401);assert.equal((await invoke({service,admin:async()=>f.actor,rate:async()=>({allowed:false})})).code,429);assert.equal((await invoke({service,admin:async()=>{throw Error('NO');}},'https://other.invalid')).code,403);
  assert(!network.some(n=>n.host==='gmail.googleapis.com'&&n.method!=='GET'));assert.equal(f.state.sendCount,providerBefore,'No send after the isolated pre-existing accepted-contract setup');
  console.log(JSON.stringify({status:'PASS',original_identity_sha_matching:true,automatic_zero_multiple_unavailable:true,separate_thread_and_foreign_case:true,ambiguous_requires_owner:true,manual_pdf_provenance:true,email_pdf_copy:true,append_only_adoption_revoke_correction:true,idempotency_and_stale_guard:true,registered_pdf_deduplicated:true,original_commercial_tables_unchanged:true,rls_service_rpc_only:true,auth_origin_rate:true,real_provider_sends:0,production_business_writes:0}));
 }finally{await f.db.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
