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

  const model=await service.changeEvidencePreview(base,f.actor);
  const adopted=await service.changeEvidenceAppend({...base,event_kind:'adopted',operation_id:crypto.randomUUID(),fingerprint:model.fingerprint,previous_event_id:model.previous_event_id},f.actor);
  const stored=await service.changeEvidenceDocument({case_id:f.inquiryId,event_id:adopted.id},f.actor);assert.equal(sha(stored.bytes),sha(f.quote));
  const copy=await service.changeEvidenceMailPdf({case_id:f.inquiryId,event_id:adopted.id},f.actor);assert((await PDFDocument.load(copy.bytes)).getPageCount()>0);
  await assert.rejects(service.changeEvidenceDocument({case_id:f.otherId,event_id:adopted.id},f.actor),/change_evidence_changed/);
  const manualDoc=await PDFDocument.create();manualDoc.addPage().drawText('MANUAL APPROVAL COPY');const manualBytes=Buffer.from(await manualDoc.save());
  const local={...base,quote:{source:'local',filename:'manual-quote.pdf',content_base64:manualBytes.toString('base64'),sha256:sha(manualBytes),amount_minor:110000,tax_basis:'tax_included'},approval:{source:'manual_pdf',filename:'manual-approval.pdf',content_base64:manualBytes.toString('base64'),sha256:sha(manualBytes)}};
  const localPreview=await service.changeEvidencePreview(local,f.actor),a=await service.changeEvidenceAppend({...local,event_kind:'adopted',operation_id:crypto.randomUUID(),fingerprint:localPreview.fingerprint,previous_event_id:localPreview.previous_event_id},f.actor);
  for(const method of ['changeEvidenceDocument','changeEvidenceMailPdf']){const result=await service[method]({case_id:f.inquiryId,event_id:a.id},f.actor);assert.equal(sha(result.bytes),sha(manualBytes));}
  await assert.rejects(service.changeEvidenceDocument({case_id:f.inquiryId,event_id:adopted.id},f.actor),/change_evidence_changed/);
  await service.changeEvidenceAppend({case_id:f.inquiryId,contract_id:sent.id,event_kind:'revoked',operation_id:crypto.randomUUID(),previous_event_id:a.id,reason:'Isolated revocation'},f.actor);
  await assert.rejects(service.changeEvidenceDocument({case_id:f.inquiryId,event_id:a.id},f.actor),/change_evidence_changed/);
  assert.equal(await digest(),before);assert.equal(f.state.sendCount,providerBefore);assert(!network.some(n=>n.host==='gmail.googleapis.com'&&n.method!=='GET'));
  console.log(JSON.stringify({status:'PASS',adopted_registered_pdf_reused:true,adopted_local_pdf_and_manual_copy:true,original_sha_checked:true,foreign_case_and_stale_event_rejected:true,revoked_read_refused:true,existing_business_tables_unchanged:true,real_provider_sends:0}));
 }finally{await f.db.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
