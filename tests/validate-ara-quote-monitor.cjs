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
  assert.equal(candidateKey(c.evidence),candidateKey({...c.evidence,quote:{...c.evidence.quote,message_id:'resent-copy',part_id:'2',attachment_id:'rotated'}}),'The same original cannot evade exclusion by being resent or changing a resource ID');assert.notEqual(candidateKey(c.evidence),candidateKey({...c.evidence,quote:{...c.evidence.quote,sha256:sha(originals.get(3))}}),'A genuinely new original is never suppressed by the prior PDF exclusion');
  const gmailBefore=network.filter(n=>n.host==='gmail.googleapis.com').length;await check();assert.equal(network.filter(n=>n.host==='gmail.googleapis.com').length,gmailBefore,'Unchanged cursor reuses persistent inspection after a fresh service/session');
  const fresh=createService({fetchImpl});assert.equal((await fresh.quoteMonitorStatus({case_id:f.inquiryId},f.actor)).candidates[0].key,c.key);
  const downloaded=await service.quoteMonitorDocument({case_id:f.inquiryId,candidate_key:c.key,quote_sha256:c.evidence.quote.sha256},f.actor);assert.equal(sha(downloaded.bytes),c.evidence.quote.sha256);
  const decide=(kind,candidate,extra={})=>service.quoteMonitorDecision({case_id:f.inquiryId,operation_id:crypto.randomUUID(),candidate_key:candidate.key,quote_sha256:candidate.evidence.quote.sha256,previous_event_id:candidate.decision?.id||null,event_kind:kind,reason:'Fixture explicit Owner decision',...extra},f.actor);
  const op=crypto.randomUUID(),excluded=await decide('excluded',c,{operation_id:op});assert.equal((await decide('excluded',c,{operation_id:op})).already_committed,true);assert.equal((await status()).candidate_count,undefined);assert.equal((await status()).candidates[0].decision.event_kind,'excluded');
  await assert.rejects(decide('deferred',c),/quote_monitor_changed/);let current=(await status()).candidates[0];await decide('restored',current);current=(await status()).candidates[0];await decide('deferred',current);assert.equal((await status()).deferred,true);
  rotation=true;await f.db.query("update pa_gmail_message_index set attachment_metadata=jsonb_set(attachment_metadata,'{0,id}','\"rotated_2\"'::jsonb) where gmail_message_id='change_2'");
  const beforeRotate=network.filter(n=>n.path.includes('/attachments/')).length;await check();assert.equal(network.filter(n=>n.path.includes('/attachments/')).length,beforeRotate,'Resource-only rotation does not refetch identical stable MIME part');rotation=false;
  await f.db.query("update pa_gmail_message_index set attachment_metadata=jsonb_set(attachment_metadata,'{0,id}','\"att_2\"'::jsonb) where gmail_message_id='change_2'");
  const base={case_id:f.inquiryId,contract_id:offer.id,quote:{source:'gmail',message_id:'change_2',thread_id:'thread_123',attachment_id:'att_2',part_id:'1',sha256:sha(originals.get(2)),amount_minor:120000,tax_basis:'tax_included'},approval:{source:'gmail',message_id:'approval_2',thread_id:'thread_123'},owner_confirmed:true,owner_case_relation_confirmed:true,change_description:'Fixture changed scope',reason:'Fixture Owner verified original and approval'};
  const reviewed=await service.changeEvidencePreview(base,f.actor);assert(reviewed.can_adopt);const adopted=await service.changeEvidenceAppend({...base,event_kind:'adopted',operation_id:crypto.randomUUID(),previous_event_id:reviewed.previous_event_id,fingerprint:reviewed.fingerprint,evidence_sha256:sha(canonical(reviewed.evidence))},f.actor);
  const readAuthority=await fresh.changeEvidenceCandidates({case_id:f.inquiryId},f.actor);assert.equal(readAuthority.current_agreement.id,adopted.id);
  await add(3,{approval:false});const second=await check();assert.equal(second.state,'waiting_approval');assert(second.candidates.some(v=>v.evidence.quote.sha256===sha(originals.get(3))));assert(!second.candidates.some(v=>v.evidence.quote.sha256===sha(originals.get(2))));assert.equal((await fresh.changeEvidenceCandidates({case_id:f.inquiryId},f.actor)).current_agreement.id,adopted.id);
  const manual={...base,quote:{source:'local',filename:'manual-pending.pdf',content_base64:originals.get(4).toString('base64'),sha256:sha(originals.get(4)),amount_minor:130000,tax_basis:'tax_included'},approval:{source:'missing'},owner_confirmed:false,owner_case_relation_confirmed:false};
  const pending=await service.changeEvidencePreview(manual,f.actor);assert.equal(pending.can_adopt,false);await service.changeEvidenceAppend({...manual,event_kind:'saved',operation_id:crypto.randomUUID(),fingerprint:pending.fingerprint,previous_event_id:pending.previous_event_id},f.actor);await assert.rejects(service.changeEvidenceAppend({...manual,event_kind:'adopted',operation_id:crypto.randomUUID(),fingerprint:pending.fingerprint,previous_event_id:pending.previous_event_id},f.actor),/change_evidence_changed|change_evidence_incomplete/);
  const withManual=await check();assert(withManual.candidates.some(v=>v.source_event_id&&v.evidence.quote.source==='local'&&v.evidence.approval.source==='missing'));
  await add(4);const attachmentCount=network.filter(n=>n.path.includes('/attachments/')).length;await Promise.all([check(),check()]);assert.equal(network.filter(n=>n.path.includes('/attachments/')).length-attachmentCount,1,'New cursor checks one new PDF; overlapping sessions reuse the lease');
  await f.db.query("update pa_gmail_message_index set subject=subject||' delta' where gmail_message_id='change_4'");unavailable=true;const failed=await check();assert.equal(failed.state,'incomplete');assert(failed.errors.length);const calls=network.length;await check();assert.equal(network.filter((n,i)=>i>=calls&&n.host==='gmail.googleapis.com').length,0,'Failure cooldown forbids an automatic provider retry');unavailable=false;
  // A deferred candidate must survive a failed original recheck as explicitly stale.
  const beforeFailure=(await status()).candidates.find(v=>v.evidence.quote.sha256===sha(originals.get(3)));await decide('deferred',beforeFailure);
  await f.db.query("update pa_quote_monitor_scans set started_at=now()-interval '2 minutes',retry_after=null where inquiry_id=$1",[f.inquiryId]);
  unavailable=true;const retained=await check(true);unavailable=false;assert(retained.candidates.some(v=>v.key===beforeFailure.key&&v.stale&&v.decision.event_kind==='deferred'));assert.equal(retained.state,'incomplete');
  // Larger inboxes make bounded progress, reuse inspected originals, stop after
  // two automatic scans and resume explicitly without repeating the first PDFs.
  for(const n of [5,6,7,8,9,10,11])await add(n,{approval:false});
  let bulk=await check();assert.equal(bulk.partial,true);assert.equal(bulk.continue_inspection,true);
  const bulkStart=network.filter(n=>n.path.includes('/attachments/')).length;
  bulk=await check();assert.equal(bulk.partial,true);assert.equal(bulk.continue_inspection,false);assert.equal(bulk.automatic_blocked,true);
  const stoppedCalls=network.length;await check();assert.equal(network.filter((n,i)=>i>=stoppedCalls&&n.host==='gmail.googleapis.com').length,0);
  await f.db.query("update pa_quote_monitor_scans set started_at=now()-interval '2 minutes' where inquiry_id=$1",[f.inquiryId]);
  bulk=await service.quoteMonitorCheck({case_id:f.inquiryId,operation_id:crypto.randomUUID(),force:true,resume:true},f.actor);
  if(bulk.continue_inspection)bulk=await check();assert.equal(bulk.scan.state,'ready',JSON.stringify(bulk.errors));
  assert(network.filter(n=>n.path.includes('/attachments/')).length-bulkStart<=6,'Continuation never downloads previously verified PDFs');
  assert.equal(bulk.scan.candidates.filter(c=>!c.source_event_id).length,10);
  await assert.rejects(service.quoteMonitorCheck({case_id:f.inquiryId,operation_id:crypto.randomUUID(),resume:true},f.actor),/quote_monitor_changed/);
  // TTL remains attached to actual original verification; age forces a fresh
  // bounded inspection even if the cursor and server/session have not changed.
  await f.db.query("update pa_quote_monitor_scans set checked_at=now()-interval '7 hours',candidates=(select jsonb_agg(jsonb_set(jsonb_set(c,'{verified_at}',to_jsonb((now()-interval '7 hours')::text)),'{inspections}',coalesce((select jsonb_agg(jsonb_set(i,'{verified_at}',to_jsonb((now()-interval '7 hours')::text))) from jsonb_array_elements(coalesce(c->'inspections','[]'::jsonb)) i),'[]'::jsonb))) from jsonb_array_elements(candidates) c) where inquiry_id=$1",[f.inquiryId]);
  const ttlCalls=network.filter(n=>n.path.includes('/attachments/')).length;const aged=await check();assert.equal(aged.partial,true);assert.equal(network.filter(n=>n.path.includes('/attachments/')).length-ttlCalls,3);
  const light=await service.quoteMonitorList({case_ids:[f.inquiryId]},f.actor);assert(!JSON.stringify(light).includes('body_text'));assert(!JSON.stringify(light).includes('見積書を確認し承認します'));
  for(let n=0;n<23;n++){const v=(await status()).candidates.find(v=>v.key===beforeFailure.key);await decide('deferred',v);}
  const page1=await service.quoteMonitorHistory({case_id:f.inquiryId},f.actor);assert.equal(page1.events.length,20);assert(page1.next_before);const page2=await service.quoteMonitorHistory({case_id:f.inquiryId,before_event:page1.next_before},f.actor);assert(page2.events.length>0);assert.equal(new Set([...page1.events,...page2.events].map(e=>e.id)).size,page1.events.length+page2.events.length);
  await assert.rejects(f.db.query('select pa_quote_monitor_list($1,$2)',[f.otherId,[f.inquiryId]]),/not_authorized/);
  assert.equal((await f.db.query("select has_function_privilege('anon','pa_quote_monitor_list(uuid,uuid[],boolean)','EXECUTE') allowed")).rows[0].allowed,false);
  const wrong={case_id:f.otherId,candidate_key:c.key,quote_sha256:c.evidence.quote.sha256};await assert.rejects(service.quoteMonitorDocument(wrong,f.actor),/quote_monitor_changed|quote_monitor_mismatch/);
  assert.equal(await digest(),before,'Existing contract/estimate/invoice/payment/outbox rows remain byte-equivalent');assert.equal(f.state.sendCount,providerBefore);
  for(const t of ['pa_quote_monitor_scans','pa_quote_monitor_blobs','pa_quote_monitor_decisions']){assert.equal((await f.db.query("select has_table_privilege('authenticated',$1,'SELECT') allowed",[t])).rows[0].allowed,false);assert.equal((await f.db.query("select has_table_privilege('service_role',$1,'UPDATE') allowed",[t])).rows[0].allowed,false);}
  for(const t of ['pa_quote_monitor_blobs','pa_quote_monitor_decisions'])await assert.rejects(f.db.exec('delete from '+t),/quote_monitor_immutable/);
  assert.equal((await f.db.query("select has_function_privilege('authenticated','pa_quote_monitor_apply(uuid,uuid,uuid,text,jsonb)','EXECUTE') allowed")).rows[0].allowed,false);
  const handler=createHandler({service,admin:async()=>f.actor,rate:async()=>({allowed:true})});const invoke=async(origin,admin=true)=>{const res={setHeader(){},status(n){this.code=n;return this;},json(v){this.value=v;return this;}};await createHandler({service,admin:async()=>{if(!admin)throw Error('not_authorized');return f.actor;},rate:async()=>({allowed:true})})({method:'POST',headers:{origin,authorization:'Bearer fixture'},body:{action:'quote_monitor_list',case_ids:[f.inquiryId]}},res);return res;};assert(handler);assert.equal((await invoke('https://other.invalid')).code,403);assert.equal((await invoke('https://fixture.invalid',false)).code,401);
  assert(network.filter(n=>n.host==='gmail.googleapis.com').every(n=>n.method==='GET'));
  console.log(JSON.stringify({status:'PASS',persistent_cached_cursor:true,bounded_resumable_originals:true,deferred_failure_preserved:true,original_ttl:true,paged_history_and_light_metadata:true,session_and_concurrent_lease:true,mime_rotation:true,next_revision_preserves_adopted:true,exclude_restore_defer_idempotency_stale:true,pending_manual_not_adopted:true,provider_error_cooldown:true,saved_pdf_sha:true,original_business_rows_unchanged:true,service_role_limited_rls:true,auth_origin:true,real_provider_sends:0,production_business_writes:0}));
 }finally{await f.db.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
