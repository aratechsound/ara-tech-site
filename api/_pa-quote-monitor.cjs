'use strict';
const crypto=require('node:crypto'),pdf=require('./_pa-contract-pdf.cjs');
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const id=v=>{if(!UUID.test(String(v||'')))throw Error('invalid_quote_monitor');return v;};
const canonical=v=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))):x);
const hash=v=>crypto.createHash('sha256').update(typeof v==='string'||Buffer.isBuffer(v)?v:canonical(v)).digest('hex');
const partKey=(m,a)=>hash([m.gmail_message_id,m.gmail_thread_id,a.part_id||a.id,a.filename||a.original_filename||'',a.mime_type,a.size||null,a.sha256||null,m.sent_at]);
// Exclusion concerns this original PDF in this case/contract, not a transient
// Gmail resource ID or a resend of identical bytes. Provenance remains stored
// and verified separately; a new original SHA is always a different candidate.
const candidateKey=e=>hash([e.case_id,e.contract_id,e.quote.sha256]);
const selectQuote=q=>Object.fromEntries(['source','estimate_id','message_id','thread_id','attachment_id','part_id','sha256','amount_minor','tax_basis','issued_at'].filter(k=>q[k]!=null).map(k=>[k,q[k]]));
const bytes=v=>Buffer.isBuffer(v)?v:Buffer.from(String(v||'').replace(/^\\x/u,''),'hex');
const MAX_MESSAGES=20,MAX_PDFS=3,MAX_PARTS=30,MAX_INDEX=100;
function createQuoteMonitor({rows,one,rpc,context,history,message,quote,preview,savedBinary,contractSha,renderMail}){
 async function listRows(caseIds,actor,detail=false){
  if(!Array.isArray(caseIds)||caseIds.length<1||caseIds.length>20||new Set(caseIds).size!==caseIds.length)throw Error('invalid_quote_monitor');caseIds.forEach(id);
  try{const result=await rpc('pa_quote_monitor_list',{p_actor:actor.id,p_cases:caseIds,p_detail:detail});if(!Array.isArray(result))throw Error('quote_monitor_storage_unavailable');
   if(result.some(r=>!caseIds.includes(r.case_id)))throw Error('quote_monitor_mismatch');return result;
  }catch(e){if(['invalid_quote_monitor','quote_monitor_mismatch','not_authorized'].includes(e.message))throw e;throw Error('quote_monitor_storage_unavailable');}
 }
 function projection(record,full=false){
  const scan=record.scan,decisions=new Map((record.decisions||[]).map(d=>[d.candidate_key,d]));
  const known=(scan?.candidates||[]).filter(c=>!c.already_adopted&&!c.not_change),candidates=known.map(c=>({...c,decision:decisions.get(c.key)||null}));
  const active=candidates.filter(c=>c.decision?.event_kind!=='excluded'),current=scan?.cursor_sha256===record.cursor;
  const remoteFresh=record.mail_sync?.complete===true&&!record.mail_sync?.last_error&&Date.parse(record.mail_sync.last_completed_at)>Date.now()-5*60000;
  const complete=current&&scan?.state==='ready'&&remoteFresh;
  const continuation=current&&scan?.state==='partial';
  const waiting=active.some(c=>c.evidence.approval?.status!=='verified');
  const approved=active.some(c=>c.evidence.approval?.status==='verified');
  const deferred=active.length>0&&active.every(c=>c.decision?.event_kind==='deferred');
  const state=!record.eligible?'not_applicable':!complete?'incomplete':approved?'approval_found':waiting?'waiting_approval':active.length?'quote_changed':'checked';
  return {case_id:record.case_id,generation:scan?.generation||0,eligible:record.eligible,state,label:({not_applicable:'',incomplete:'確認未完了',approval_found:'変更承認あり',waiting_approval:'顧客承認待ち',quote_changed:'見積変更あり',checked:''})[state],deferred,checked_at:scan?.checked_at||null,
   needs_check:record.eligible&&(!complete||Date.parse(scan.checked_at)<Date.now()-6*3600000||(scan.candidates||[]).some(c=>!c.source_event_id&&Date.parse(c.verified_at)<Date.now()-6*3600000)),cursor:record.cursor,storage_available:true,
   continue_inspection:continuation&&scan.attempts<2,partial:continuation,automatic_blocked:current&&scan?.attempts>=2&&scan?.state!=='ready',remote_fresh:remoteFresh,remote_checked_at:record.mail_sync?.last_completed_at||null,checking:scan?.state==='checking'&&Date.parse(scan.lease_until)>Date.now(),retry_after:scan?.retry_after||null,index_truncated:record.index_count>MAX_INDEX,
   ...(full?{candidates,errors:scan?.errors||[],decisions:record.decisions||[],scan}:{candidate_count:active.length})};
 }
 async function quoteMonitorList(input,actor){return {cases:(await listRows(input.case_ids,actor)).map(r=>projection(r)),limits:{batch:20,automatic_cases:4,concurrency:1,pdfs_per_scan:MAX_PDFS,index_per_case:MAX_INDEX}};}
 async function state(caseId,actor){const list=await listRows([id(caseId)],actor,true);if(list.length!==1)throw Error('quote_monitor_mismatch');return {raw:list[0],view:projection(list[0],true)};}
 async function quoteMonitorStatus(input,actor){return (await state(input.case_id,actor)).view;}
 async function quoteMonitorHistory(input,actor){
  await state(id(input.case_id),actor);
  if(input.before_event!=null&&(!Number.isSafeInteger(input.before_event)||input.before_event<1))throw Error('invalid_quote_monitor');
  const events=await rows('pa_quote_monitor_decisions',{inquiry_id:'eq.'+input.case_id,select:'*',order:'event_number.desc',limit:'21',...(input.before_event?{event_number:'lt.'+input.before_event}:{})});
  if(events.some(e=>e.inquiry_id!==input.case_id))throw Error('quote_monitor_mismatch');
  return {case_id:input.case_id,events:events.slice(0,20),next_before:events.length>20?Number(events[19].event_number):null};
 }
 async function quoteMonitorCheck(input,actor){
  const caseId=id(input.case_id),initial=await state(caseId,actor);if(!initial.raw.eligible)return initial.view;
  if(input.resume===true&&initial.raw.scan?.state!=='partial')throw Error('quote_monitor_changed');
  const operation=id(input.operation_id),claim=await rpc('pa_quote_monitor_apply',{p_actor:actor.id,p_case:caseId,p_operation:operation,p_action:'claim',p_data:{cursor:initial.raw.cursor,force:input.force===true}});
  if(!claim.claimed)return (await state(caseId,actor)).view;
  const errors=[],found=[],blobs=[],messages=[],previous=initial.raw.scan;let pending=false,downloads=0;const refresh=input.force===true&&input.resume!==true;
  try{
   const ctx=await context(caseId),stored=await history(caseId);if(!stored.available)throw Error('change_evidence_storage_unavailable');
   const contracts=ctx.contracts.filter(c=>Number.isFinite(Date.parse(c.confirmed_at))).sort((a,b)=>Date.parse(a.confirmed_at)-Date.parse(b.confirmed_at));
   const original=contracts[0];if(!original)throw Error('quote_monitor_mismatch');
   const indexed=await rows('pa_gmail_message_index',{inquiry_id:'eq.'+caseId,select:'gmail_message_id,gmail_thread_id,direction,subject,from_address,to_addresses,sent_at,received_at,attachment_metadata',order:'indexed_at.desc',limit:String(MAX_INDEX+1)});
   if(indexed.length>MAX_INDEX||initial.raw.index_count>MAX_INDEX)errors.push({code:'index_scope_incomplete'});
   const inbox=indexed.filter(m=>m.direction==='inbound'&&Date.parse(m.received_at)>=Date.parse(original.confirmed_at));
   if(inbox.length>MAX_MESSAGES)errors.push({code:'approval_scope_incomplete'});
   const inbound=[];for(const m of inbox.slice(0,MAX_MESSAGES))try{const signature=hash(m),cached=previous?.messages?.find(v=>v.signature===signature&&Date.parse(v.verified_at)>Date.now()-6*3600000),value=cached&&!refresh?cached.value:await message(caseId,m.gmail_message_id);inbound.push(value);messages.push({signature,value,verified_at:cached&&!refresh?cached.verified_at:new Date().toISOString()});}catch{errors.push({message_id:m.gmail_message_id,code:'approval_original_unavailable'});}
   const parts=[];for(const m of indexed.filter(m=>m.direction==='outbound'&&Date.parse(m.sent_at)>=Date.parse(original.confirmed_at)))for(const a of m.attachment_metadata||[])if(a.mime_type==='application/pdf'&&/見積|estimate|quote/iu.test((a.filename||a.original_filename||'')+' '+m.subject))parts.push({m,a});
   if(parts.length>MAX_PARTS)errors.push({code:'pdf_scope_incomplete'});
   for(const {m,a}of parts.slice(0,MAX_PARTS))try{
    const signature=partKey(m,a),cached=previous?.candidates?.find(c=>c.index_signature===signature||c.inspections?.some(v=>v.index_signature===signature));
    const inspection=cached?.inspections?.find(v=>v.index_signature===signature)||cached&&{quote:cached.evidence.quote,verified_at:cached.verified_at};
    let q,verifiedAt=new Date().toISOString();
    if(cached&&Date.parse(inspection.verified_at)>Date.now()-6*3600000&&!refresh){
     const blob=await one('pa_quote_monitor_blobs',{inquiry_id:'eq.'+caseId,sha256:'eq.'+cached.evidence.quote.sha256,select:'sha256,content,filename'});
     if(blob){const content=bytes(blob.content);if(hash(content)!==blob.sha256)throw Error('quote_monitor_mismatch');q={binary:{bytes:content,filename:blob.filename,mime_type:'application/pdf'},metadata:{...inspection.quote,attachment_id:a.id,part_id:a.part_id||''}};verifiedAt=inspection.verified_at;}
    }
    if(!q){if(downloads>=MAX_PDFS){pending=true;continue;}if(Number(a.size)>1500000)throw Error('quote_monitor_pdf_too_large');++downloads;q=await quote(caseId,{source:'gmail',message_id:m.gmail_message_id,thread_id:m.gmail_thread_id,attachment_id:a.id,part_id:a.part_id||''},true);if(q.binary.bytes.length>1500000)throw Error('quote_monitor_pdf_too_large');blobs.push({sha256:q.metadata.sha256,filename:q.binary.filename,content_base64:q.binary.bytes.toString('base64')});}
    const unchanged=q.metadata.sha256===(original.snapshot.quote?.sha256||original.snapshot.estimate?.sha256);
    const roots=inbound.filter(a=>a.in_reply_to===q.metadata.rfc_message_id||a.references.split(/\s+/u).includes(q.metadata.rfc_message_id));
    if(roots.length>1)errors.push({message_id:m.gmail_message_id,code:'multiple_approvals'});
    const payload={case_id:caseId,contract_id:original.id,quote:selectQuote(q.metadata),approval:roots.length===1?{source:'gmail',message_id:roots[0].id,thread_id:roots[0].thread_id}:null,owner_confirmed:false,owner_case_relation_confirmed:false,change_description:'',reason:''};
    const verified=await preview(payload,actor,q),e=verified.model.evidence;
    if(e.case_id!==caseId||e.contract_sha256!==contractSha(original)||e.quote.sha256!==q.metadata.sha256)throw Error('quote_monitor_mismatch');
    const alreadyAdopted=stored.authority?.event_kind==='adopted'&&stored.authority.evidence.quote.sha256===e.quote.sha256;
    const candidate={key:candidateKey(e),case_id:caseId,index_signature:signature,inspections:[{index_signature:signature,quote:e.quote,verified_at:verifiedAt}],evidence:e,payload:{contract_id:original.id,quote:payload.quote,approval:payload.approval},verified_at:verifiedAt,source_event_id:null,already_adopted:alreadyAdopted,not_change:unchanged};
    const same=found.find(c=>c.key===candidate.key);
    if(same){same.origins ||= [same.evidence.quote];same.origins.push(e.quote);same.inspections.push(...candidate.inspections);same.verified_at=new Date(Math.min(Date.parse(same.verified_at),Date.parse(verifiedAt))).toISOString();errors.push({message_id:m.gmail_message_id,code:'multiple_quote_origins_require_owner'});}
    else found.push(candidate);

   }catch(e){errors.push({message_id:m.gmail_message_id,code:['quote_monitor_mismatch','change_evidence_mismatch'].includes(e.message)?'original_identity_mismatch':'quote_original_unavailable'});}
   // Saved manual/registered evidence already passed PAUI-051 validation and
   // immutable storage. It may wait for approval, but never becomes adopted here.
   for(const event of stored.events.filter(e=>e.event_kind==='saved').slice(0,20)){
    const e=event.evidence;if(e?.case_id!==caseId||!contracts.some(c=>c.id===e.contract_id&&contractSha(c)===e.contract_sha256)||!e.quote?.sha256)continue;
    if(stored.authority?.event_kind==='adopted'&&stored.authority.evidence.quote.sha256===e.quote.sha256)continue;
    const key=candidateKey(e),same=found.find(c=>c.key===key);if(same){same.manual_sources ||= [];same.manual_sources.push({source_event_id:event.id,quote:e.quote,approval_source:e.approval?.source});continue;}
    found.push({key,case_id:caseId,index_signature:null,evidence:e,payload:null,source_event_id:event.id,verified_at:event.created_at});
   }
   for(const old of previous?.candidates||[]){if(found.some(c=>c.key===old.key)||old.case_id!==caseId||old.evidence?.contract_id!==original.id||old.evidence?.contract_sha256!==contractSha(original))continue;found.push({...old,stale:true,...(refresh&&pending?{verified_at:null,inspections:(old.inspections||[]).map(i=>({...i,verified_at:null}))}:{}),already_adopted:stored.authority?.event_kind==='adopted'&&stored.authority.evidence.quote.sha256===old.evidence.quote.sha256});if(!pending)errors.push({code:'previous_candidate_unconfirmed'});}
   if(found.length>30){found.splice(30);errors.push({code:'candidate_scope_incomplete'});}
  }catch(e){errors.push({code:e.message==='quote_monitor_mismatch'?'original_identity_mismatch':'inspection_unavailable'});}
  if(!found.length&&previous?.candidates?.length){for(const c of previous.candidates)if(c.case_id===caseId)found.push({...c,stale:true});errors.push({code:'previous_candidate_unconfirmed'});}
  const newState=errors.length?'incomplete':pending?'partial':'ready';
  await rpc('pa_quote_monitor_apply',{p_actor:actor.id,p_case:caseId,p_operation:operation,p_action:'finish',p_data:{cursor:initial.raw.cursor,state:newState,candidates:found,messages,errors:errors.slice(0,30),blobs:blobs.filter(b=>found.some(c=>c.evidence.quote.sha256===b.sha256)).slice(0,MAX_PDFS)}});
  return (await state(caseId,actor)).view;
 }
 async function candidate(input,actor,allowExcluded=false){
  const current=await state(input.case_id,actor);if(current.view.cursor!==current.raw.scan?.cursor_sha256)throw Error('quote_monitor_changed');
  const matches=current.view.candidates.filter(c=>c.key===input.candidate_key);if(matches.length!==1||matches[0].case_id!==input.case_id||matches[0].evidence.quote.sha256!==input.quote_sha256)throw Error('quote_monitor_mismatch');
  if(!allowExcluded&&matches[0].decision?.event_kind==='excluded')throw Error('quote_monitor_changed');return matches[0];
 }
 async function quoteMonitorDecision(input,actor){
  if(!['excluded','deferred','restored'].includes(input.event_kind)||typeof input.reason!=='string'||!input.reason.trim()||input.reason.length>2000)throw Error('invalid_quote_monitor');
  id(input.operation_id);id(input.case_id);
  // Restore can use the immutable excluded snapshot even after a later scan no
  // longer lists that old candidate. It cannot alter the adopted agreement.
  return rpc('pa_quote_monitor_apply',{p_actor:actor.id,p_case:input.case_id,p_operation:input.operation_id,p_action:input.event_kind,p_data:{candidate_key:input.candidate_key,quote_sha256:input.quote_sha256,previous_event_id:input.previous_event_id||null,reason:input.reason.trim()}});
 }
 async function quoteMonitorDocument(input,actor){
  const c=await candidate(input,actor),e=c.evidence;
  if(input.kind==='approval'){
   if(e.approval?.source==='gmail'&&e.approval.status==='verified'&&e.approval.exact_quote_reference&&e.approval.linked)return renderMail(e);
   if(e.approval?.source!=='manual_pdf'||!e.approval.manual_pdf_sha256)throw Error('quote_monitor_mismatch');
   return savedBinary(input.case_id,e.approval.manual_pdf_sha256,e.approval.filename);
  }
  let original;if(c.source_event_id)original=await savedBinary(input.case_id,e.quote.sha256,e.quote.filename);
  else{const b=await one('pa_quote_monitor_blobs',{inquiry_id:'eq.'+input.case_id,sha256:'eq.'+e.quote.sha256,select:'sha256,content,filename'});if(!b)throw Error('change_evidence_original_unavailable');original={bytes:bytes(b.content),filename:b.filename,mime_type:'application/pdf'};}
  await pdf.validatePdf(original.bytes,e.quote.sha256);return original;
 }
 return {quoteMonitorList,quoteMonitorStatus,quoteMonitorCheck,quoteMonitorDecision,quoteMonitorDocument,quoteMonitorHistory};
}
module.exports={createQuoteMonitor,candidateKey,partKey,canonical,hash};
