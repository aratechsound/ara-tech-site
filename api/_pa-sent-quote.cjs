'use strict';
// Already-delivered quote registration. No transport, sync or Provider mutation.
const pdf=require('./_pa-contract-pdf.cjs');
const uuid=v=>/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(String(v||''));
const canonical=v=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))):x);
const identity=q=>Object.fromEntries(['message_id','thread_id','attachment_id','part_id','sha256'].map(k=>[k,q?.[k]||'']));
const number=v=>Number.isSafeInteger(Number(v))&&Number(v)>0&&Number(v)<=9999999999?Number(v):null;
const error=code=>{throw Error(code);};
const ERRORS=['invalid_sent_quote','sent_quote_identity_mismatch','sent_quote_amounts_unconfirmed','sent_quote_changed','sent_quote_storage_unavailable','sent_quote_commercial_hold','sent_quote_existing_registration_hold','sent_quote_already_registered'];
function createSentQuoteWorkflow({rows,one,rpc,context,history,message,quote,contractSha,fetchImpl}){
 async function saved(caseId){try{return await rows('pa_sent_quote_adoptions_v1',{inquiry_id:'eq.'+caseId,select:'*',order:'created_at.desc',limit:'101'});}catch{return null;}}
 async function source(input,actor){
  if(!uuid(input.case_id)||input.quote?.source!=='gmail'||!input.quote.part_id||!/^[a-f0-9]{64}$/u.test(input.quote.sha256||''))error('invalid_sent_quote');
  if(input.operation_id){
   const verified=await require('./_pa-reply-documents.cjs').verify({actorId:actor.id,inquiryId:input.case_id,operationId:input.operation_id,messageId:input.quote.message_id},fetchImpl);
   if(verified.gmail_thread_id!==input.quote.thread_id||verified.attachments.filter(a=>a.part_id===input.quote.part_id&&a.sha256===input.quote.sha256&&a.document_kind==='estimate').length!==1)error('sent_quote_identity_mismatch');
  }else{
   if(input.owner_original_selected!==true)error('sent_quote_identity_mismatch');
   const operations=await rows('pa_reply_operations_v1',{inquiry_id:'eq.'+input.case_id,select:'operation_id,binding',limit:'101'});
   if(operations.length>100)error('sent_quote_commercial_hold');
   for(const o of operations.filter(o=>o.binding?.thread_id===input.quote.thread_id)){
    const events=await rows('pa_reply_operation_events_v1',{operation_id:'eq.'+o.operation_id,select:'state',order:'seq.desc',limit:'1'});
    if(events.length!==1||['SENDING','UNKNOWN'].includes(events[0].state))error('sent_quote_commercial_hold');
   }
  }
  // Reuse PAUI-051/054's case/index admission, exact MIME-part binary reader,
  // PDF parser, original SHA and amount extraction (not a filename guess).
  const q=await quote(input.case_id,{...input.quote,amount_minor:input.values?.document_amount_minor||undefined,tax_basis:input.values?.tax_basis||undefined},true);
  if(q.binary.bytes.length>1500000)error('invalid_sent_quote');
  return q;
 }
 async function approval(caseId,q,m){
  const a=await message(caseId,m.gmail_message_id);
  if(a.direction!=='inbound'||a.thread_id!==m.gmail_thread_id||!a.linked||!Number.isFinite(Date.parse(a.occurred_at)))error('sent_quote_identity_mismatch');
  if(Date.parse(a.occurred_at)<Date.parse(q.sent_at))return null;
  const relation=!!q.rfc_message_id&&(a.in_reply_to===q.rfc_message_id||a.references.split(/\s+/u).includes(q.rfc_message_id));
  const negative=/(?:検討|未確認|できません|修正|変更希望|再見積)/u.test(a.reply_body);
  const explicit=/見積[\s\S]{0,100}(確認|了承|承認)|(?:こちら|この)(?:の)?内容で(?:お願い|承認)/u.test(a.reply_body)&&!negative;
  return {source:'gmail',status:negative?'rejected':relation&&explicit?'verified':'owner_reviewed',message_id:a.id,thread_id:a.thread_id,rfc_message_id:a.rfc_message_id,from:a.from_address,to:a.to_addresses,subject:a.subject,occurred_at:a.occurred_at,body:a.body_text,reply_body:a.reply_body,quoted_body:a.quoted_body,quote_boundary:a.quote_boundary,references:a.references,in_reply_to:a.in_reply_to,linked:true,exact_quote_reference:relation,approval_language:explicit?'candidate':'ambiguous'};
 }
 async function build(input,actor){
  const caseId=input.case_id,q=await source(input,actor),ctx=await context(caseId),h=await history(caseId),registrations=await saved(caseId),reasons=[];
  if(!q.metadata.sent_at)error('sent_quote_identity_mismatch');
  const pre=ctx.contracts.length===0,contract=ctx.contracts.length===1?ctx.contracts[0]:null;
  if(!pre&&(!contract||Date.parse(q.metadata.sent_at)<Date.parse(contract.confirmed_at)))reasons.push('CONTRACT_OR_CHRONOLOGY_UNCONFIRMED');
  const linked=await rows('pa_gmail_message_index',{inquiry_id:'eq.'+caseId,direction:'eq.inbound',select:'inquiry_id,gmail_message_id,gmail_thread_id,direction,subject,from_address,to_addresses,cc_addresses,received_at',order:'received_at.desc',limit:'21'});
  const manual=!!input.approval_message_id;
  if(manual&&!linked.some(m=>m.gmail_message_id===input.approval_message_id&&m.gmail_thread_id===input.approval_thread_id))error('sent_quote_identity_mismatch');
  const found=[];let failures=0;
  for(const m of manual?linked.filter(m=>m.gmail_message_id===input.approval_message_id):linked.slice(0,10)){
   try{const a=await approval(caseId,q.metadata,m);if(a?.status==='verified'||manual&&a?.status==='owner_reviewed')found.push(a);}catch{failures++;}
  }
  const selected=found.length===1?found[0]:null;
  if(!selected||!manual&&(linked.length>10||failures))reasons.push('APPROVAL_UNCONFIRMED');
  const values=input.values||{},amount=number(values.document_amount_minor||q.metadata.amount_minor),tax=values.tax_basis;
  // Tax-inclusive/exempt JPY only: no guessed tax conversion or negative change.
  if(!amount||!(pre?['tax_included','tax_excluded','tax_exempt']:['tax_included','tax_exempt']).includes(tax)||values.currency&&values.currency!=='JPY')reasons.push('AMOUNT_OR_TAX_REQUIRED');
  const manualReason=typeof values.owner_approval_reason==='string'?values.owner_approval_reason.trim():'';
  const manualConfirmed=manual&&values.owner_approval_confirmed===true&&manualReason.length>=10&&manualReason.length<=2000;
  if(selected?.status==='owner_reviewed'&&!manualConfirmed)reasons.push('MANUAL_APPROVAL_CONFIRMATION_REQUIRED');
  const changes=ctx.current.change_orders||[],baseline=contract?Number(contract.snapshot.amount_minor)+changes.filter(c=>c.state==='agreed').reduce((n,c)=>n+Number(c.agreed_amount_minor),0):null;
  const baseEstimate=contract?ctx.current.estimates.find(e=>e.id===contract.snapshot.estimate_revision_id):null;
  const total=pre?amount:number(values.revised_total_minor),delta=pre?0:number(values.additional_amount_minor),basis=pre?'initial_total':values.amount_basis;
  if(!pre&&(contract?.snapshot.currency!=='JPY'||!baseEstimate||baseEstimate.tax_basis!==tax||!number(baseline)||!total||!delta
    ||basis!=='revised_total'||total!==baseline+delta||amount!==total))reasons.push('TOTAL_AND_ADDITIONAL_AMOUNT_REQUIRED');
  if(values.owner_amounts_confirmed!==true)reasons.push('OWNER_AMOUNT_CONFIRMATION_REQUIRED');
  let deliveryGate=null,deliveryHold=false;
  if(ctx.current.outbox.some(j=>['unknown','processing'].includes(j.state)||j.delivery_state==='unknown_after_provider_start')){
   try{deliveryGate=await rpc('pa_sent_quote_delivery_gate_v1',{p_actor:actor.id,p_case:caseId,p_contract:contract?.id||null});
    deliveryHold=deliveryGate?.case_id!==caseId||deliveryGate?.contract_id!==(contract?.id||null)||deliveryGate?.read_only!==true||deliveryGate?.blocked!==false;
   }catch{deliveryHold=true;}
  }
  if(['closed','cancelled','declined','schedule_unavailable'].includes(ctx.inquiry.status)||deliveryHold
    ||!pre&&(ctx.current.billings.length||ctx.current.state.settlement_state!=='unsettled'||ctx.current.state.unresolved_changes||changes.some(c=>['proposal','customer_acknowledged'].includes(c.state))))reasons.push('COMMERCIAL_STATE_HOLD');
  if(!pre&&ctx.current.documents.some(d=>d.sha256===q.metadata.sha256))reasons.push('EXISTING_REGISTRATION_REQUIRES_REVIEW');
  if(!registrations||registrations.length>100||!h.available)reasons.push('STORAGE_UNAVAILABLE');
  const sameQuote=h.authority?.event_kind==='adopted'&&h.authority.evidence.quote.sha256===q.metadata.sha256?h.authority:null;
  const existing=sameQuote&&contract&&selected&&sameQuote.contract_id===contract.id&&sameQuote.evidence.case_id===caseId
    &&['message_id','thread_id','part_id','sha256'].every(k=>sameQuote.evidence.quote[k]===q.metadata[k])
    &&Number(sameQuote.evidence.quote.amount_minor)===amount&&sameQuote.evidence.quote.tax_basis===tax
    &&sameQuote.evidence.approval.message_id===selected.message_id&&sameQuote.evidence.approval.thread_id===selected.thread_id?sameQuote:null;
  if(sameQuote&&!existing)reasons.push('EXISTING_ADOPTION_IDENTITY_MISMATCH');
  if(registrations?.some(r=>r.gmail_message_id===q.metadata.message_id&&r.part_id===q.metadata.part_id&&r.quote_sha256===q.metadata.sha256))reasons.push('ALREADY_REGISTERED_READ_STATUS');
  const conditions=values.conditions??{};if(!conditions||typeof conditions!=='object'||Array.isArray(conditions)||Buffer.byteLength(JSON.stringify(conditions))>10000)error('invalid_sent_quote');
  const request={gmail_message_id:q.metadata.message_id,gmail_thread_id:q.metadata.thread_id,part_id:q.metadata.part_id,sha256:q.metadata.sha256,reply_operation_id:input.operation_id||null,
   approval_message_id:selected?.message_id||null,approval_thread_id:selected?.thread_id||null,expected_revision:Number(ctx.current.state.revision),expected_current:ctx.current.state.current_estimate_revision_id||null,
   previous_event_id:h.events[0]?.id||null,existing_adoption_id:existing?.id||null,contract_id:contract?.id||null,
   document_amount_minor:amount,revised_total_minor:total,additional_amount_minor:delta,base_amount_minor:baseline,amount_basis:basis||null,currency:'JPY',tax_basis:tax||null,conditions,owner_amounts_confirmed:values.owner_amounts_confirmed===true,owner_approval_confirmed:selected?.status==='owner_reviewed'&&manualConfirmed,owner_approval_reason:selected?.status==='owner_reviewed'?manualReason:''};
  const evidence={case_id:caseId,contract_id:contract?.id||null,contract_sha256:contract?contractSha(contract):null,quote:{...q.metadata,amount_minor:amount,tax_basis:tax||null},approval:selected||{source:'missing',status:'missing'},warnings:selected?.status==='owner_reviewed'?['quote_reply_relation_requires_owner_confirmation']:[],change_description:'既送付見積原本と顧客了承の正式登録',owner_confirmed:true,owner_case_relation_confirmed:true,owner_reason:selected?.status==='owner_reviewed'?manualReason:'Ownerが送付済みPDF・顧客了承・金額の意味と正式登録を確認'};
  const fingerprint=pdf.sha(canonical({actor:actor.id,request,evidence,commercial_state:ctx.current.state,contract_snapshot:contract?.snapshot,history_head:h.events[0]?.id||null,delivery_gate:deliveryGate}));
  request.preview_fingerprint=fingerprint;
  const recorded=registrations?.find(r=>r.gmail_message_id===q.metadata.message_id&&r.part_id===q.metadata.part_id&&r.quote_sha256===q.metadata.sha256);
  return {bytes:q.binary.bytes,request,evidence,model:{case_id:caseId,phase:pre?'PRE_CONTRACT':'POST_CONTRACT',quote:evidence.quote,approval:selected,approval_candidates:linked.slice(0,20),approval_list_truncated:linked.length>20,approval_matches:found.length,automatic_search_incomplete:!manual&&(linked.length>10||!!failures),base_amount_minor:baseline,existing_adoption_id:existing?.id||null,existing_registration_operation_id:recorded?.created_by===actor.id?recorded.operation_id:null,values:request,can_complete:!reasons.length,reasons:[...new Set(reasons)],fingerprint,write:false,storage_available:!!registrations,delivery_gate:deliveryGate}};
 }
 async function sentQuotePreview(input,actor){return (await build(input,actor)).model;}
 async function sentQuoteStatus(input,actor){
  if(!uuid(input.case_id)||!uuid(input.adoption_operation_id))error('invalid_sent_quote');await context(input.case_id);
  const found=await saved(input.case_id);if(!found)error('sent_quote_storage_unavailable');
  const r=found.find(x=>x.operation_id===input.adoption_operation_id);if(!r)return {case_id:input.case_id,operation_state:'NOT_FOUND',complete:false,resubmit_allowed:false};
  if(r.created_by!==actor.id)error('sent_quote_identity_mismatch');
  const estimate=await one('pa_estimate_revisions',{id:'eq.'+r.estimate_revision_id,inquiry_id:'eq.'+input.case_id,select:'*'}),doc=estimate&&await one('pa_commercial_documents',{id:'eq.'+estimate.document_id,inquiry_id:'eq.'+input.case_id,select:'id,sha256,gmail_message_id'});
  if(!estimate||doc?.sha256!==r.quote_sha256||Number(estimate.amount_minor)!==Number(r.document_amount_minor))error('sent_quote_identity_mismatch');
  const delivered=await rows('pa_estimate_delivery_evidence',{inquiry_id:'eq.'+input.case_id,estimate_revision_id:'eq.'+estimate.id,gmail_message_id:'eq.'+r.gmail_message_id,gmail_attachment_id:'eq.'+r.evidence.quote.attachment_id,select:'id,source_sent_at',limit:'2'});
  if(delivered.length!==1||!delivered[0].source_sent_at)error('sent_quote_identity_mismatch');
  if(r.contract_id){
   const change=await one('pa_change_orders',{id:'eq.'+r.change_order_id,inquiry_id:'eq.'+input.case_id,select:'*'}),event=await one('pa_change_evidence_events',{id:'eq.'+r.adoption_event_id,inquiry_id:'eq.'+input.case_id,select:'*'});
   if(change?.state!=='agreed'||change.contract_id!==r.contract_id||change.estimate_revision_id!==estimate.id||Number(change.agreed_amount_minor)!==Number(r.additional_amount_minor)||event?.event_kind!=='adopted'||event.evidence.quote.sha256!==r.quote_sha256||event.evidence.approval.message_id!==r.approval_message_id)error('sent_quote_identity_mismatch');
  }
  return {case_id:input.case_id,id:r.id,operation_state:'COMPLETED',complete:true,estimate_revision_id:estimate.id,change_order_id:r.change_order_id,adoption_event_id:r.adoption_event_id,quote_sha256:r.quote_sha256,gmail_message_id:r.gmail_message_id,part_id:r.part_id,approval_message_id:r.approval_message_id,document_amount_minor:Number(r.document_amount_minor),revised_total_minor:Number(r.revised_total_minor),additional_amount_minor:Number(r.additional_amount_minor),amount_basis:r.amount_basis,no_send:true};
 }
 async function sentQuoteAdopt(input,actor){
  if(!uuid(input.case_id)||!uuid(input.adoption_operation_id)||input.owner_confirmed!==true)error('invalid_sent_quote');
  // A committed operation can only be observed again with its original binding.
  const prior=(await saved(input.case_id))?.find(r=>r.operation_id===input.adoption_operation_id);
  if(prior){
   const v=input.values||{},r=prior.request;
   if(prior.created_by!==actor.id||r.preview_fingerprint!==input.fingerprint||prior.gmail_message_id!==input.quote?.message_id||prior.gmail_thread_id!==input.quote?.thread_id||prior.part_id!==input.quote?.part_id||prior.quote_sha256!==input.quote?.sha256
    ||input.approval_message_id&&input.approval_message_id!==r.approval_message_id||input.approval_thread_id&&input.approval_thread_id!==r.approval_thread_id
    ||['document_amount_minor','revised_total_minor','additional_amount_minor','amount_basis','tax_basis','currency'].some(k=>v[k]!=null&&v[k]!==''&&String(v[k])!==String(r[k]))
    ||v.owner_amounts_confirmed!==r.owner_amounts_confirmed||r.owner_approval_confirmed&&(v.owner_approval_confirmed!==true||String(v.owner_approval_reason||'').trim()!==r.owner_approval_reason)
    ||canonical(v.conditions||{})!==canonical(r.conditions))error('idempotency_payload_mismatch');
   return {...await sentQuoteStatus(input,actor),already_committed:true};
  }
  const p=await build(input,actor);if(!p.model.can_complete)error(p.model.reasons.includes('STORAGE_UNAVAILABLE')?'sent_quote_storage_unavailable':'sent_quote_commercial_hold');
  if(input.fingerprint!==p.model.fingerprint)error('sent_quote_changed');
  await rpc('pa_sent_quote_adopt_v1',{p_actor:actor.id,p_case:input.case_id,p_operation:input.adoption_operation_id,p_request:p.request,p_evidence:p.evidence,p_content_base64:p.bytes.toString('base64')});
  // Both ledgers must independently read back; a missing read is never success.
  return sentQuoteStatus(input,actor);
 }
 return {sentQuotePreview,sentQuoteAdopt,sentQuoteStatus};
}
module.exports={createSentQuoteWorkflow,ERRORS};
