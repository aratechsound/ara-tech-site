'use strict';
const crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path');
const gmail=require('./_pa-gmail.cjs'),mail=require('./_pa-mail.cjs'),pdf=require('./_pa-contract-pdf.cjs');
const {PDFDocument,rgb}=require('pdf-lib'),fontkit=require('@pdf-lib/fontkit');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ERRORS=['invalid_change_evidence','change_evidence_mismatch','change_evidence_changed','change_evidence_incomplete','change_evidence_storage_unavailable','change_evidence_original_unavailable'];
const fail=()=>{throw Error('change_evidence_mismatch');};
const id=v=>{if(!UUID.test(String(v||'')))throw Error('invalid_change_evidence');return v;};
const text=(v,n=2000)=>{if(typeof v!=='string'||v.length>n||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(v))throw Error('invalid_change_evidence');return v;};
const canonical=v=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))):x);
const fromBytea=v=>Buffer.isBuffer(v)?v:Buffer.from(String(v||'').replace(/^\\x/u,''),'hex');
const lower=v=>String(v||'').toLowerCase();
const decodeSubject=value=>String(value||'').replace(/\?=\s+=\?/gu,'?==?').replace(/=\?([^?\s]+)\?([bq])\?([^?]*)\?=/giu,(_all,charset,encoding,data)=>{
 try{const bytes=lower(encoding)==='b'?Buffer.from(data,'base64'):Buffer.from(data.replace(/_/gu,' ').replace(/=([0-9a-f]{2})/giu,(_m,h)=>String.fromCharCode(parseInt(h,16))),'latin1');return new (require('node:util').TextDecoder)(charset,{fatal:true}).decode(bytes);}catch{throw Error('change_evidence_original_unavailable');}
});
const stripQuotes=body=>{
 const lines=body.split('\n');const cut=lines.findIndex(l=>/^\s*(?:>|On .+wrote:|.+さんは書きました[：:]|[-_]{3,}\s*(?:Original Message|元のメッセージ))/iu.test(l));
 return {reply_body:cut<0?body:lines.slice(0,cut).join('\n'),quoted_body:cut<0?'':lines.slice(cut).join('\n'),quote_boundary:cut<0?'not_identified':'detected'};
};
function createEvidenceService({rows,one,rpc,snapshot,document,fetchImpl,postgresJsonbText}){
 const contractSha=c=>pdf.sha(postgresJsonbText(c.snapshot));
 async function history(caseId){try{const fields='id,contract_id,previous_event_id,event_kind,evidence,reason,created_at,event_number';const [events,adopted,revoked]=await Promise.all([
  rows('pa_change_evidence_events',{inquiry_id:'eq.'+caseId,select:fields,order:'event_number.desc',limit:'100'}),
  rows('pa_change_evidence_events',{inquiry_id:'eq.'+caseId,event_kind:'eq.adopted',select:fields,order:'event_number.desc',limit:'1'}),
  rows('pa_change_evidence_events',{inquiry_id:'eq.'+caseId,event_kind:'eq.revoked',select:fields,order:'event_number.desc',limit:'1'})]);
  const authority=[...adopted,...revoked].sort((a,b)=>Number(b.event_number)-Number(a.event_number))[0]||null;return {available:true,events,authority};
 }catch{return {available:false,events:[],authority:null,code:'change_evidence_storage_unavailable'};}}
 async function context(caseId){
  id(caseId);const inquiry=await mail.getInquiry(caseId,fetchImpl),current=await snapshot(caseId);
  const contracts=await rows('pa_contracts',{inquiry_id:'eq.'+caseId,select:'id,version,confirmed_at,snapshot',order:'version.desc',limit:'100'});
  return {inquiry,current,contracts};
 }
 async function message(caseId,messageId){
  if(!gmail.validGmailId(messageId))throw Error('invalid_change_evidence');
  const raw=await gmail.gmailMessage(messageId,fetchImpl),m=gmail.normalizeMessage(raw);
  if(m.id!==messageId||!gmail.validGmailId(m.thread_id)||m.reply_identity_invalid)fail();
  if(m.direction==='outbound'&&!(raw.labelIds||[]).includes('SENT'))fail();
  if(m.body_text.length>=50000||m.subject.length>=500||/[\ufffd\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(m.body_text))throw Error('change_evidence_original_unavailable');
  const links=await rows('pa_gmail_thread_links',{gmail_thread_id:'eq.'+m.thread_id,select:'inquiry_id',limit:'100'});
  const indexed=await rows('pa_gmail_message_index',{gmail_message_id:'eq.'+m.id,select:'inquiry_id,gmail_thread_id',limit:'100'});
  if(links.some(l=>l.inquiry_id!==caseId)||indexed.some(l=>l.inquiry_id!==caseId||l.gmail_thread_id!==m.thread_id))fail();
  const inquiry=await mail.getInquiry(caseId,fetchImpl),customer=lower(inquiry.email),official=lower(mail.OFFICIAL_EMAIL);
  if(!customer||!m.occurred_at||!/^<[^<>\s]{1,998}>$/u.test(m.rfc_message_id))fail();
  if(m.direction==='outbound'?(lower(m.from_address)!==official||!m.to_addresses.some(a=>lower(a)===customer)):
   (lower(m.from_address)!==customer||!m.to_addresses.some(a=>lower(a)===official)))fail();
  const heads=(raw.payload?.headers||[]);const header=name=>heads.filter(h=>lower(h.name)===name);
  if(header('message-id').length!==1||header('in-reply-to').length>1||header('references').length>1)fail();
  return {...m,subject_raw:m.subject,subject:decodeSubject(m.subject),body_html:undefined,...stripQuotes(m.body_text),in_reply_to:header('in-reply-to')[0]?.value||'',linked:links.length>0||indexed.length>0};
 }
 async function candidates(input){
  const caseId=id(input.case_id),ctx=await context(caseId),stored=await history(caseId);
  const indexed=await rows('pa_gmail_message_index',{inquiry_id:'eq.'+caseId,select:'gmail_message_id,gmail_thread_id,direction,subject,from_address,to_addresses,sent_at,received_at,attachment_metadata',order:'indexed_at.desc',limit:'100'});
  const messages=indexed.map(m=>({...m,linked:true}));let search_state='linked_candidates';
  if(input.search){
   const s=input.search;let q='';const customer=String(ctx.inquiry.email||'');if(!/^[^\s<>@"{}]+@[^\s<>@"{}]+$/u.test(customer))throw Error('invalid_change_evidence');
   // User filters narrow the fixed customer correspondence scope; never expand it.
   const terms=text(s.keywords||'',300).replace(/["{}\\()\r\n]/gu,' '),subject=text(s.subject||'',200).replace(/["{}\\()\r\n]/gu,' ');
   if(s.sender&&lower(s.sender)!==lower(customer)&&lower(s.sender)!==lower(mail.OFFICIAL_EMAIL))throw Error('invalid_change_evidence');
   q=`{from:${customer} to:${customer}}`+(s.sender?' from:'+s.sender:'')+(subject?' subject:"'+subject+'"':'')+(terms?' "'+terms+'"':'');
   for(const [field,op]of [['after','after'],['before','before']])if(s[field]){if(!/^\d{4}-\d{2}-\d{2}$/u.test(s[field]))throw Error('invalid_change_evidence');q+=' '+op+':'+s[field];}
   try{
    const found=await gmail.gmailJson('/messages?'+new URLSearchParams({q,maxResults:'20'}),{method:'GET'},fetchImpl);
    for(const item of found.messages||[])if(!messages.some(m=>m.gmail_message_id===item.id)){
     try{const m=await message(caseId,item.id);messages.push({gmail_message_id:m.id,gmail_thread_id:m.thread_id,direction:m.direction,subject:m.subject,from_address:m.from_address,to_addresses:m.to_addresses,sent_at:m.direction==='outbound'?m.occurred_at:null,received_at:m.direction==='inbound'?m.occurred_at:null,attachment_metadata:m.attachments,linked:m.linked});}
     catch(e){if(e.message!=='change_evidence_mismatch')throw e;}
    }search_state=found.nextPageToken?'bounded_more_results':'searched';
   }catch(e){search_state='search_unavailable';}
  }
  const detected=[],detection_errors=[];
  if(input.detect===true){
   const inbound=[],outbound=[];
   for(const item of messages.filter(m=>m.direction==='inbound').slice(0,20))try{inbound.push(await message(caseId,item.gmail_message_id));}catch{detection_errors.push({message_id:item.gmail_message_id,code:'original_unavailable'});}
   for(const item of messages.filter(m=>m.direction==='outbound').slice(0,20))for(const part of (item.attachment_metadata||[]).filter(p=>p.mime_type==='application/pdf'&&/見積|estimate|quote/iu.test((p.filename||p.original_filename||'')+' '+(item.subject||''))).slice(0,3)){
    try{const q=await quote(caseId,{source:'gmail',message_id:item.gmail_message_id,thread_id:item.gmail_thread_id,attachment_id:part.id,part_id:part.part_id||''},true);outbound.push(q.metadata);}catch{detection_errors.push({message_id:item.gmail_message_id,code:'quote_original_unavailable'});}
   }
   for(const q of outbound)for(const a of inbound)if(a.in_reply_to===q.rfc_message_id||a.references.split(/\s+/u).includes(q.rfc_message_id)){
    for(const c of ctx.contracts)if(Date.parse(c.confirmed_at)<=Date.parse(q.sent_at)&&Date.parse(q.sent_at)<=Date.parse(a.occurred_at))detected.push({contract_id:c.id,quote:q,approval:{message_id:a.id,thread_id:a.thread_id},status:'candidate_requires_owner_review'});
   }
  }
  return {case_id:caseId,contracts:ctx.contracts.map(c=>({...c,sha256:contractSha(c)})),estimates:ctx.current.estimates,documents:ctx.current.documents,
   delivery_evidence:ctx.current.estimate_delivery_evidence||[],outbox:ctx.current.outbox,messages,search_state,history:stored.events,storage_available:stored.available,
   current_agreement:stored.authority?.event_kind==='adopted'?stored.authority:null,
   detected,detection_errors,detection_state:!input.detect?'not_requested':detection_errors.length?'incomplete':detected.length>1?'multiple_candidates':detected.length===1?'candidate_found':'evidence_unidentified',
   candidate_state:messages.filter(m=>m.direction==='inbound').length>1?'multiple_candidates':'evidence_unidentified'};
 }
 async function quote(caseId,selection,allowUnknownAmount=false){
  if(!selection||!['registered','gmail','local'].includes(selection.source))throw Error('invalid_change_evidence');
  let binary,source=selection.source,m=null,estimate=null;
  if(source==='registered'){
   estimate=await one('pa_estimate_revisions',{id:'eq.'+id(selection.estimate_id),inquiry_id:'eq.'+caseId,select:'*'});if(!estimate)fail();
   binary=await document(caseId,estimate.document_id);
  }else if(source==='gmail'){
   m=await message(caseId,selection.message_id);if(m.direction!=='outbound'||!m.linked||m.thread_id!==selection.thread_id)fail();
   // Gmail attachment resource IDs can change between full-message reads.
   // Admit the persisted case/message/id/part pair first, then resolve that
   // exact MIME part in the fresh original through the existing binary reader.
   const indexed=await rows('pa_gmail_message_index',{inquiry_id:'eq.'+caseId,gmail_message_id:'eq.'+m.id,select:'attachment_metadata',limit:'1'});
   const admitted=(indexed[0]?.attachment_metadata||[]).filter(a=>a.id===selection.attachment_id&&(!selection.part_id||a.part_id===selection.part_id));
   if(admitted.length!==1)fail();
   const partId=admitted[0].part_id||'';
   if(partId&&m.attachments.some(a=>a.id===selection.attachment_id&&a.part_id!==partId))fail();
   const parts=m.attachments.filter(a=>partId?a.part_id===partId:a.id===selection.attachment_id);
   if(parts.length!==1||parts[0].mime_type!=='application/pdf')fail();
   binary=await gmail.getAttachmentBinary({inquiryId:caseId,gmailMessageId:m.id,gmailAttachmentId:selection.attachment_id,gmailPartId:partId},fetchImpl);
  }else binary={bytes:Buffer.from(text(selection.content_base64,2000000),'base64'),filename:text(selection.filename,500),mime_type:'application/pdf'};
  if(binary.mime_type!=='application/pdf')fail();await pdf.validatePdf(binary.bytes,selection.sha256||pdf.sha(binary.bytes));const sha=pdf.sha(binary.bytes);
  if(selection.sha256&&sha!==selection.sha256)fail();
  const duplicates=await rows('pa_commercial_documents',{inquiry_id:'eq.'+caseId,sha256:'eq.'+sha,select:'id',limit:'100'});
  const matched=await rows('pa_estimate_revisions',{inquiry_id:'eq.'+caseId,select:'id,document_id,revision_number,amount_minor,tax_basis,issued_at',limit:'100'});
  const match=estimate||matched.find(e=>duplicates.some(d=>d.id===e.document_id));
  const extracted=await require('./_pa-estimate-amount.cjs').extractEstimateAmount(binary.bytes);
  const amount=Number(selection.amount_minor||match?.amount_minor||extracted.amount_minor||0),tax=selection.tax_basis||match?.tax_basis||'tax_included';
  const unknownAmount=allowUnknownAmount&&amount===0&&!match&&extracted.status!=='HIGH_CONFIDENCE';
  if(!unknownAmount&&(!Number.isSafeInteger(amount)||amount<1||amount>9999999999)||!['tax_included','tax_excluded','tax_exempt'].includes(tax))throw Error('invalid_change_evidence');
  if(match&&(Number(match.amount_minor)!==amount||match.tax_basis!==tax)||extracted.status==='HIGH_CONFIDENCE'&&extracted.amount_minor!==amount)fail();
  if(selection.compare_estimate_id){const compare=matched.find(e=>e.id===selection.compare_estimate_id);if(!compare||!duplicates.some(d=>d.id===compare.document_id))fail();}
  return {binary,metadata:{source,filename:binary.filename,sha256:sha,estimate_id:match?.id||null,document_id:match?.document_id||null,revision_number:match?.revision_number||null,amount_minor:unknownAmount?null:amount,tax_basis:tax,
   issued_at:match?.issued_at||selection.issued_at||null,sent_at:m?.occurred_at||null,message_id:m?.id||null,thread_id:m?.thread_id||null,rfc_message_id:m?.rfc_message_id||null,recipients:m?.to_addresses||[],attachment_id:selection.attachment_id||null,part_id:selection.part_id||null,
   registered_sha_match:!!match,amount_extraction:extracted.status}};
 }
 async function preview(input,actor){
  const caseId=id(input.case_id),ctx=await context(caseId),contract=ctx.contracts.find(c=>c.id===input.contract_id);if(!contract)throw Error('contract_not_found');
  const q=await quote(caseId,input.quote),warnings=[],blobs=[{filename:q.binary.filename,sha256:q.metadata.sha256,content_base64:q.binary.bytes.toString('base64')}];
  if(q.metadata.sent_at&&Date.parse(q.metadata.sent_at)<Date.parse(contract.confirmed_at))fail();
  let approval={source:'missing',status:'missing'},relation=false;
  if(input.approval?.source==='gmail'){
   const a=await message(caseId,input.approval.message_id);if(a.direction!=='inbound'||a.thread_id!==input.approval.thread_id)fail();
   if(Date.parse(a.occurred_at)<Date.parse(q.metadata.sent_at||contract.confirmed_at))fail();
   const root=q.metadata.rfc_message_id;
   relation=!!root&&(a.in_reply_to===root||a.references.split(/\s+/u).includes(root));
   const explicit=/見積[\s\S]{0,100}(確認|了承|承認)|(?:こちら|この)(?:の)?内容で(?:お願い|承認)/u.test(a.reply_body)&&!/(?:検討|未確認|できません|修正|変更希望|再見積)/u.test(a.reply_body);
   approval={source:'gmail',status:relation&&explicit&&a.linked?'verified':'owner_reviewed',message_id:a.id,thread_id:a.thread_id,rfc_message_id:a.rfc_message_id,from:a.from_address,to:a.to_addresses,subject:a.subject,occurred_at:a.occurred_at,body:a.body_text,reply_body:a.reply_body,quoted_body:a.quoted_body,quote_boundary:a.quote_boundary,references:a.references,in_reply_to:a.in_reply_to,linked:a.linked,exact_quote_reference:relation,approval_language:explicit?'candidate':'ambiguous'};
   if(!a.linked)warnings.push('unlinked_thread_requires_owner_case_confirmation');if(!relation)warnings.push('quote_reply_relation_requires_owner_confirmation');if(!explicit)warnings.push('ambiguous_customer_approval_requires_owner_reason');
  }else if(input.approval?.source==='manual_pdf'){
   const a=input.approval,bytes=Buffer.from(text(a.content_base64,2000000),'base64');await pdf.validatePdf(bytes,a.sha256);const sha=pdf.sha(bytes);
   approval={source:'manual_pdf',status:'owner_reviewed',manual_pdf_sha256:sha,filename:text(a.filename,500),body:text(a.transcription||'',50000),gmail_original_verified:false};
   blobs.push({filename:approval.filename,sha256:sha,content_base64:bytes.toString('base64')});warnings.push('gmail_original_unverified_manual_copy');
  }else warnings.push('approval_evidence_missing');
  if(q.metadata.source==='local')warnings.push('local_original_delivery_unverified');
  if(!q.metadata.registered_sha_match)warnings.push('no_identical_registered_estimate');
  if(!q.metadata.registered_sha_match&&q.metadata.amount_extraction!=='HIGH_CONFIDENCE')warnings.push('amount_requires_owner_pdf_confirmation');
  const evidence={case_id:caseId,contract_id:contract.id,contract_sha256:contractSha(contract),quote:q.metadata,approval,warnings,
   change_description:text(input.change_description||'',5000),owner_confirmed:input.owner_confirmed===true,owner_case_relation_confirmed:input.owner_case_relation_confirmed===true,owner_reason:text(input.reason||'',2000)};
  const stored=await history(caseId),previous=stored.events[0]?.id||null;
  const canAdopt=approval.source!=='missing'&&evidence.change_description.trim().length>0&&evidence.owner_reason.trim().length>0&&evidence.owner_confirmed&&(!warnings.length||evidence.owner_case_relation_confirmed);
  const fingerprint=pdf.sha(canonical({actor:actor.id,evidence,previous}));
  return {model:{evidence,fingerprint,previous_event_id:previous,can_adopt:canAdopt,storage_available:stored.available,status:approval.status==='verified'?'customer_approval_evidence_verified':'owner_review_required',same_pdf_reused:q.metadata.registered_sha_match},blobs,bytes:q.binary.bytes};
 }
 async function changeEvidencePreview(input,actor){return (await preview(input,actor)).model;}
 async function changeEvidenceAppend(input,actor){
  const operation=id(input.operation_id),kind=input.event_kind;if(!['saved','adopted','revoked'].includes(kind))throw Error('invalid_change_evidence');
  // Replay exact normalized payload before touching Gmail. No mutable contract/state updates.
  const prior=await one('pa_change_evidence_events',{operation_id:'eq.'+operation,select:'*'});
  if(prior){if(prior.inquiry_id!==input.case_id||prior.contract_id!==input.contract_id||prior.created_by!==actor.id||prior.event_kind!==kind||prior.reason!==input.reason||pdf.sha(canonical(prior.evidence))!==input.evidence_sha256)throw Error('idempotency_payload_mismatch');return {id:prior.id,already_committed:true,event_kind:kind};}
  if(kind==='revoked'){
   const stored=await history(id(input.case_id)),last=stored.events[0],adopted=stored.authority;if(!last||last.id!==input.previous_event_id||adopted?.contract_id!==input.contract_id||adopted.event_kind!=='adopted')throw Error('change_evidence_changed');
   return rpc('pa_change_evidence_append',{p_actor:actor.id,p_case:input.case_id,p_contract:input.contract_id,p_operation:operation,p_previous:last.id,p_kind:kind,p_evidence:adopted.evidence,p_reason:text(input.reason),p_blobs:[]});
  }
  const p=await preview(input,actor);if(!p.model.storage_available)throw Error('change_evidence_storage_unavailable');
  if(p.model.fingerprint!==input.fingerprint||p.model.previous_event_id!==(input.previous_event_id||null))throw Error('change_evidence_changed');
  if(kind==='adopted'&&!p.model.can_adopt)throw Error('change_evidence_incomplete');
  return rpc('pa_change_evidence_append',{p_actor:actor.id,p_case:input.case_id,p_contract:input.contract_id,p_operation:operation,p_previous:p.model.previous_event_id,p_kind:kind,p_evidence:p.model.evidence,p_reason:text(input.reason),p_blobs:p.blobs});
 }
 async function changeEvidenceDocument(input,actor){const p=await preview(input,actor);return {bytes:p.bytes,filename:p.model.evidence.quote.filename,mime_type:'application/pdf'};}
 async function changeEvidenceContractPdf(input){
  const caseId=id(input.case_id);await mail.getInquiry(caseId,fetchImpl);
  const c=await one('pa_contracts',{id:'eq.'+id(input.contract_id),inquiry_id:'eq.'+caseId,select:'*'});if(!c)throw Error('contract_not_found');
  const r=await one('pa_contract_receipts',{contract_id:'eq.'+c.id,select:'pdf,sha256'});
  if(!r)throw Error('change_evidence_original_unavailable');const bytes=fromBytea(r.pdf);if(pdf.sha(bytes)!==r.sha256)fail();
  return {bytes,filename:'accepted-order-confirmation.pdf',mime_type:'application/pdf'};
 }
 async function changeEvidenceMailPdf(input,actor){
  const p=await preview(input,actor),e=p.model.evidence,a=e.approval;if(a.source!=='gmail')throw Error('change_evidence_original_unavailable');
  const ctx=await context(input.case_id),doc=await PDFDocument.create();doc.registerFontkit(fontkit);
  const font=await doc.embedFont(fs.readFileSync(path.join(__dirname,'contract-fonts','NotoSansJP.ttf')),{subset:true});let page,y;
  const lines=['ARA-TECH 変更承認メール控え','Gmail原本の閲覧用写し',ctx.inquiry.event_name||'',`対象見積: ${e.quote.estimate_id||'手動証拠原本'} / ${e.quote.filename}`,`見積SHA256: ${e.quote.sha256}`,`From: ${a.from}`,`To: ${a.to.join(', ')}`,`Subject: ${a.subject}`,`日時: ${a.occurred_at}`,`Gmail Message-ID: ${a.message_id}`,`RFC Message-ID: ${a.rfc_message_id}`,`原本確認: Gmail取得済み / 承認判断: ${a.status}`,`生成: ${new Date().toISOString()}`,'顧客返信部分（原文）',a.reply_body,'引用部分（原文）',a.quoted_body||'（引用境界未特定／返信部分に原文全体を表示）'];
  for(const block of lines)for(const line of String(block).replace(/\r\n?/gu,'\n').split('\n')){
   let rest=line;do{let part='';for(const c of rest){if(font.widthOfTextAtSize(part+c,9)>505)break;part+=c;}if(!part&&rest)part=rest[0];rest=rest.slice(part.length);
    if(!page||y<40){page=doc.addPage([595,842]);y=803;}page.drawText(part.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu,''),{x:45,y,size:9,font,color:rgb(.1,.16,.22)});y-=14;
   }while(rest);
  }
  return {bytes:Buffer.from(await doc.save()),filename:'change-approval-email-copy.pdf',mime_type:'application/pdf'};
 }
 return {changeEvidenceCandidates:candidates,changeEvidencePreview,changeEvidenceAppend,changeEvidenceDocument,changeEvidenceMailPdf,changeEvidenceContractPdf};
}
module.exports={createEvidenceService,ERRORS,stripQuotes,canonical};
