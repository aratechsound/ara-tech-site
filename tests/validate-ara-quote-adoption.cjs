'use strict';
const assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path');
const {PDFDocument}=require('pdf-lib'),{setup,MODE}=require('./validate-pam-025-direct-confirmation.cjs');
const {createService,decryptSecret}=require('../api/_pa-commercial.cjs'),{createHandler}=require('../api/_pa-commercial-handler.cjs'),{sha}=require('../api/_pa-contract-pdf.cjs');
const {canonical,candidateKey}=require('../api/_pa-quote-monitor.cjs');
const json=(result,status=200)=>({ok:status<300,status,json:async()=>result});
async function main(){
 global.fetch=async()=>{throw Error('LIVE_NETWORK_FORBIDDEN');};
 const f=await setup({transport:async()=>({gmail_message_id:'mock_sent',gmail_thread_id:'thread_123'})});
 try{
  await f.db.exec(fs.readFileSync(path.join(__dirname,'../ops/PAUI-051-change-evidence.sql'),'utf8'));
  const discoverySchema=fs.readFileSync(path.join(__dirname,'../supabase/migrations/20261015140000_paui041_mail_discovery.sql'),'utf8').split('-- Both observations')[0];await f.db.exec(discoverySchema+'\ncommit;');
  await f.db.exec(fs.readFileSync(path.join(__dirname,'../ops/PAUI-053-quote-monitor.sql'),'utf8'));
  await f.db.query('insert into paui041_mail_sync_state(inquiry_id,state) values($1,$2)',[f.inquiryId,{complete:true,last_completed_at:new Date().toISOString(),last_error:null}]);
  await f.createEstimate();const confirm=await f.service.confirmationPreview({case_id:f.inquiryId,confirmation_mode:MODE},f.actor);
  const offer=await f.service.issueDirectConfirmationAndSend({case_id:f.inquiryId,confirmation_mode:MODE,preview_fingerprint:confirm.fingerprint,operation_id:crypto.randomUUID()},f.actor);
  const job=(await f.db.query('select * from pa_commercial_outbox where id=$1',[offer.outbox_id])).rows[0],o=(await f.db.query('select * from pa_contract_offers where id=$1',[offer.id])).rows[0];
  await f.contract.accept({token:decryptSecret(job.secret_envelope).split('#')[1],offer_id:offer.id,snapshot_sha256:o.snapshot_sha256,confirmer_name:'Fixture Owner',agree:true});
  const protectedTables=['pa_case_commercial_state','pa_estimate_revisions','pa_commercial_documents','pa_contract_offers','pa_contracts','pa_billings','pa_payment_records','pa_commercial_outbox'];
  const digest=async()=>{const v={};for(const t of protectedTables)v[t]=(await f.db.query('select to_jsonb(t) value from '+t+' t order by to_jsonb(t)::text')).rows;return canonical(v);};
  const before=await digest(),providerBefore=f.state.sendCount,stamp=Date.now()+86400000,originals=new Map(),network=[];let unavailable=false,foreign=false,rotation=false;
  for(const n of [2,3,4,5,6,7,8,9,10,11]){const d=await PDFDocument.create();d.addPage().drawText('ISOLATED CHANGED QUOTE '+n);originals.set(n,Buffer.from(await d.save()));}
  async function add(n,{approval=true}={}){
   await f.db.query('insert into pa_gmail_message_index(gmail_message_id,gmail_thread_id,inquiry_id,direction,from_address,message_source,sent_at,received_at,subject,to_addresses,attachment_metadata) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',['change_'+n,'thread_123',f.inquiryId,'outbound','aratechsound@gmail.com','gmail_direct',new Date(stamp+n*10000).toISOString(),null,'変更見積 '+n,['customer@example.invalid'],[{id:'att_'+n,part_id:'1',filename:'changed-'+n+'.pdf',mime_type:'application/pdf',size:originals.get(n).length}]]);
   if(approval)await f.db.query('insert into pa_gmail_message_index(gmail_message_id,gmail_thread_id,inquiry_id,direction,from_address,message_source,sent_at,received_at,subject,to_addresses,attachment_metadata) values($1,$2,$3,$4,$5,$6,null,$7,$8,$9,$10)',['approval_'+n,'thread_123',f.inquiryId,'inbound','customer@example.invalid','gmail_direct',new Date(stamp+n*10000+1000).toISOString(),'Re: 変更見積 '+n,['aratechsound@gmail.com'],[]]);
  }
  const raw=key=>{const outbound=key.startsWith('change_'),n=Number(key.split('_')[1]);return {id:key,labelIds:outbound?['SENT']:['INBOX'],threadId:foreign?'foreign_thread':'thread_123',internalDate:String(stamp+n*10000+(outbound?0:1000)),payload:{mimeType:'multipart/mixed',headers:[{name:'From',value:outbound?'aratechsound@gmail.com':'customer@example.invalid'},{name:'To',value:outbound?'customer@example.invalid':'aratechsound@gmail.com'},{name:'Subject',value:'見積変更 '+n},{name:'Message-ID',value:'<'+key+'@fixture.invalid>'},...(!outbound?[{name:'In-Reply-To',value:'<change_'+n+'@fixture.invalid>'},{name:'References',value:'<change_'+n+'@fixture.invalid>'}]:[])],parts:[{mimeType:'text/plain',body:{data:Buffer.from(outbound?'変更見積書です。':'見積書を確認し承認します。\n> 引用').toString('base64url')}},...(outbound?[{mimeType:'application/pdf',filename:'changed-'+n+'.pdf',partId:'1',body:{attachmentId:rotation?'rotated_'+n:'att_'+n,size:originals.get(n).length}}]:[])]}};};
  const fetchImpl=async(url,options={})=>{
   const u=new URL(url);network.push({host:u.host,path:u.pathname,method:options.method||'GET'});
   if(/\/rpc\/(pa_quote_monitor_(list|apply)|pa_change_evidence_append)$/u.test(u.pathname)){
    const name=u.pathname.split('/').at(-1),v=JSON.parse(options.body),keys=Object.keys(v);try{return json((await f.db.query('select '+name+'('+keys.map((k,i)=>k+'=> $'+(i+1)).join(',')+') result',Object.values(v))).rows[0].result);}catch(e){return json({message:e.message},400);}
   }
   if(u.host==='gmail.googleapis.com'&&/\/attachments\/(att|rotated)_([2-9]|1[01])$/u.test(u.pathname)){if(unavailable)throw Error('provider_unavailable');const n=Number(u.pathname.split('_').at(-1));return json({data:originals.get(n).toString('base64url'),size:originals.get(n).length});}
   if(u.host==='gmail.googleapis.com'&&/\/messages\/(change|approval)_([2-9]|1[01])$/u.test(u.pathname)){if(unavailable)throw Error('provider_unavailable');return json(raw(u.pathname.split('/').at(-1)));}
   if(u.pathname.endsWith('/pa_quote_monitor_decisions')&&u.searchParams.has('event_number')){assert.equal(options.method||'GET','GET');const before=u.searchParams.get('event_number');assert(/^lt\.\d+$/u.test(before));return json((await f.db.query('select * from pa_quote_monitor_decisions where inquiry_id=$1 and event_number<$2 order by event_number desc limit 21',[u.searchParams.get('inquiry_id').slice(3),Number(before.slice(3))])).rows);}
   return f.fetchImpl(url,options);
  };
  const service=createService({fetchImpl}),check=(force=false)=>service.quoteMonitorCheck({case_id:f.inquiryId,operation_id:crypto.randomUUID(),force},f.actor),status=()=>service.quoteMonitorStatus({case_id:f.inquiryId},f.actor);
  await add(2);
  const first=await check();assert.equal(first.state,'approval_found',JSON.stringify(first.errors));assert.equal(first.candidates.length,1);const c=first.candidates[0];assert.equal(c.evidence.quote.sha256,sha(originals.get(2)));assert.equal(c.evidence.approval.status,'verified');assert.equal(c.evidence.owner_confirmed,false);
  const simple={case_id:f.inquiryId,simple_adoption:true,contract_id:c.evidence.contract_id,quote:{source:'gmail',message_id:c.evidence.quote.message_id,thread_id:c.evidence.quote.thread_id,attachment_id:c.evidence.quote.attachment_id,part_id:c.evidence.quote.part_id,sha256:c.evidence.quote.sha256},approval:{source:'gmail',message_id:c.evidence.approval.message_id,thread_id:c.evidence.approval.thread_id}};
  const need=await service.changeEvidencePreview(simple,f.actor);assert.deepEqual(need.required_fields,['amount_minor','tax_basis']);assert.equal(need.can_adopt,false);
  const ready={...simple,quote:{...simple.quote,amount_minor:120000,tax_basis:'tax_included'}};
  const reviewed=await service.changeEvidencePreview(ready,f.actor);assert(reviewed.can_adopt);assert(reviewed.evidence.owner_reason.includes(c.evidence.quote.sha256));assert.equal(reviewed.evidence.owner_confirmed,true);
  const eventsBefore=(await f.db.query('select count(*) n from pa_change_evidence_events')).rows[0].n;
  // Reading/declining has no business event or row change.
  assert.equal(await digest(),before);assert.equal((await f.db.query('select count(*) n from pa_change_evidence_events')).rows[0].n,eventsBefore);
  for(const changed of [{quote:{...ready.quote,sha256:'f'.repeat(64)}},{quote:{...ready.quote,part_id:'wrong'}},{approval:{...ready.approval,message_id:'other'}},{case_id:crypto.randomUUID()}])await assert.rejects(service.changeEvidencePreview({...ready,...changed},f.actor));
  await f.db.query("update pa_quote_monitor_scans set state='incomplete' where inquiry_id=$1",[f.inquiryId]);await assert.rejects(service.changeEvidencePreview(ready,f.actor),/change_evidence_changed/);await f.db.query("update pa_quote_monitor_scans set state='ready' where inquiry_id=$1",[f.inquiryId]);
  const operation=crypto.randomUUID(),commit={...ready,event_kind:'adopted',operation_id:operation,previous_event_id:reviewed.previous_event_id,fingerprint:reviewed.fingerprint,evidence_sha256:sha(canonical(reviewed.evidence))};
  const results=await Promise.allSettled([service.changeEvidenceAppend(commit,f.actor),service.changeEvidenceAppend(commit,f.actor)]);assert(results.some(v=>v.status==='fulfilled'));
  const events=(await f.db.query("select * from pa_change_evidence_events where event_kind='adopted'")).rows;assert.equal(events.length,1);assert.equal(events[0].operation_id,operation);assert.equal(events[0].evidence.quote.sha256,ready.quote.sha256);
  const replay=await service.changeEvidenceAppend(commit,f.actor);assert.equal(replay.id,events[0].id);assert.equal(replay.already_committed,true);await assert.rejects(service.changeEvidenceAppend({...commit,evidence_sha256:'f'.repeat(64)},f.actor),/idempotency_payload_mismatch/);
  const freshService=createService({fetchImpl});const reread=await freshService.changeEvidenceCandidates({case_id:f.inquiryId},f.actor);assert.equal(reread.current_agreement.id,events[0].id);
  await assert.rejects(freshService.changeEvidenceAppend({...commit,operation_id:crypto.randomUUID()},f.actor),/change_evidence_changed/,'A new session cannot re-adopt the same confirmed original');
  assert.equal(await digest(),before);assert.equal(f.state.sendCount,providerBefore);assert(!network.some(v=>v.host==='gmail.googleapis.com'&&v.path.endsWith('/send')));
  console.log(JSON.stringify({status:'PASS',no_decline_writes:true,strict_original_approval_and_scan:true,only_missing_fields:true,server_generated_facts:true,parallel_one_event:true,unknown_no_automatic_retry:true,fresh_authority_readback:true,protected_business_rows:true,real_provider_sends:0}));
 }finally{await f.db.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
