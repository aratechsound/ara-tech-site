'use strict';
const assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path');
const {PDFDocument}=require('pdf-lib'),{setup,MODE}=require('./validate-pam-025-direct-confirmation.cjs');
const {createService,decryptSecret}=require('../api/_pa-commercial.cjs'),mail=require('../api/_pa-mail.cjs'),ops=require('../api/_pa-reply-operations.cjs'),documents=require('../api/_pa-reply-documents.cjs');
const {sha}=require('../api/_pa-contract-pdf.cjs');
const json=(body,status=200)=>({ok:status<300,status,json:async()=>body});
(async()=>{
 global.fetch=async()=>{throw Error('LIVE_NETWORK_FORBIDDEN');};
 const f=await setup({transport:async()=>({gmail_message_id:'mock_sent',gmail_thread_id:'thread_123'})});
 try{
  for(const file of ['PAUI-051-change-evidence.sql','PAUI-056-document-read.sql'])await f.db.exec(fs.readFileSync(path.join(__dirname,'../ops',file),'utf8'));
  await f.createEstimate();const c=await f.service.confirmationPreview({case_id:f.inquiryId,confirmation_mode:MODE},f.actor);
  const offer=await f.service.issueDirectConfirmationAndSend({case_id:f.inquiryId,confirmation_mode:MODE,preview_fingerprint:c.fingerprint,operation_id:crypto.randomUUID()},f.actor);
  const job=(await f.db.query('select * from pa_commercial_outbox where id=$1',[offer.outbox_id])).rows[0],o=(await f.db.query('select * from pa_contract_offers where id=$1',[offer.id])).rows[0];
  await f.contract.accept({token:decryptSecret(job.secret_envelope).split('#')[1],offer_id:offer.id,snapshot_sha256:o.snapshot_sha256,confirmer_name:'Synthetic Owner',agree:true});
  const pdf=await PDFDocument.create();pdf.addPage().drawText('TOTAL JPY 200,000');const bytes=Buffer.from(await pdf.save());
  const input=[{filename:'a.txt',mime_type:'text/plain',data:Buffer.from('normal').toString('base64url')},{filename:'b.pdf',mime_type:'application/pdf',data:bytes.toString('base64url'),document_kind:'estimate'},{filename:'c.pdf',mime_type:'application/pdf',data:f.quote.toString('base64url'),document_kind:'invoice'}];
  const attachments=mail.normalizeReplyAttachments(input);assert.deepEqual(attachments.map(a=>a.document_kind||'normal'),['normal','estimate','invoice']);
  assert.equal(mail.replyAttachmentsHash(mail.normalizeReplyAttachments([{...input[0],document_kind:'normal'}])),mail.replyAttachmentsHash(mail.normalizeReplyAttachments([input[0]])),'normal/legacy hashes stay compatible');
  for(const value of [{...input[0],document_kind:'estimate'},{...input[1],document_kind:'guess'},{...input[1],data:Buffer.from('not PDF').toString('base64url')}])assert.throws(()=>mail.normalizeReplyAttachments([value]),/invalid_reply_attachment/);
  const now=Date.now()+10000,body=mail.normalizeCustomerBody('Typed isolated reply'),source='typed_source',sent='typed_sent',thread='thread_123';
  const preview={inquiry_id:f.inquiryId,gmail_thread_id:thread,reply_source_message_id:source,reply_source_rfc_message_id:'<typed_source@fixture.invalid>',reply_source_authority_hash:'fixture_hash',recipient:'customer@example.invalid',cc_addresses:[],subject:'Re: Typed fixture',body};
  const messages=new Map();
  const raw=(id,outbound,when,replyBody,replyTo)=>({id,threadId:thread,labelIds:[outbound?'SENT':'INBOX'],internalDate:String(when),payload:{mimeType:'multipart/mixed',headers:[{name:'From',value:outbound?'aratechsound@gmail.com':'customer@example.invalid'},{name:'To',value:outbound?'customer@example.invalid':'aratechsound@gmail.com'},{name:'Subject',value:outbound?preview.subject:'Re: Typed fixture'},{name:'Message-ID',value:'<'+id+'@fixture.invalid>'},...(replyTo?[{name:'In-Reply-To',value:replyTo},{name:'References',value:replyTo}]:[])],parts:[{mimeType:'text/plain',body:{data:Buffer.from(replyBody).toString('base64url')}},...(outbound?attachments.map((a,i)=>({partId:String(i+1),mimeType:a.mime_type,filename:a.filename,body:{attachmentId:'typed_att_'+i,size:a.size}})):[])]}});
  messages.set(source,raw(source,false,now-1000,'Synthetic source',null));messages.set(sent,raw(sent,true,now,body,preview.reply_source_rfc_message_id));messages.set('typed_approval',raw('typed_approval',false,now+1000,'見積書を確認し承認します。','<typed_sent@fixture.invalid>'));
  for(const [id,m]of messages)await f.db.query('insert into pa_gmail_message_index(gmail_message_id,gmail_thread_id,inquiry_id,direction,from_address,to_addresses,cc_addresses,subject,message_source,sent_at,received_at,attachment_metadata) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',[id,thread,f.inquiryId,id===sent?'outbound':'inbound',id===sent?'aratechsound@gmail.com':'customer@example.invalid',id===sent?['customer@example.invalid']:['aratechsound@gmail.com'],[],m.payload.headers.find(h=>h.name==='Subject').value,'gmail_direct',id===sent?new Date(Number(m.internalDate)).toISOString():null,id===sent?null:new Date(Number(m.internalDate)).toISOString(),id===sent?attachments.map((a,i)=>({id:'typed_att_'+i,part_id:String(i+1),filename:a.filename,mime_type:a.mime_type,size:a.size})):[]]);
  let unavailable=false,wrong=false,providerWrites=0;const requests=[];
  const fetchImpl=async(url,options={})=>{const u=new URL(url);requests.push({path:u.pathname,method:options.method||'GET'});
   if(u.pathname.endsWith('/rpc/pa_change_evidence_append')){const p=JSON.parse(options.body),keys=Object.keys(p);return json((await f.db.query('select pa_change_evidence_append('+keys.map((k,i)=>k+'=> $'+(i+1)).join(',')+') value',Object.values(p))).rows[0].value);}
   if(u.pathname.endsWith('/rpc/pa_reply_document_list_v1')){if(unavailable)return json({},404);const p=JSON.parse(options.body);try{return json((await f.db.query('select pa_reply_document_list_v1($1,$2) value',[p.p_actor,p.p_case])).rows[0].value);}catch(e){return json({message:e.message},403);}}
   if(u.host==='gmail.googleapis.com'){
    assert.equal(options.method||'GET','GET','document reads cannot send or modify Gmail');
    if(u.pathname.includes('/threads/'))return json({id:thread,messages:[...messages.values()]});
    if(u.pathname.includes('/attachments/')){const i=Number(u.pathname.split('_').at(-1));return json({data:(wrong?Buffer.from('wrong'):Buffer.from(attachments[i].data,'base64url')).toString('base64url')});}
    if(u.pathname.includes('/messages/'))return json(messages.get(u.pathname.split('/').at(-1))||{},messages.has(u.pathname.split('/').at(-1))?200:404);
   }return f.fetchImpl(url,options);
  };
  const prepared=await ops.prepare({actorId:f.actor.id,preview,attachments},fetchImpl),operation=prepared.operation;
  const normalBinding=ops.binding(preview,mail.normalizeReplyAttachments(input.map(a=>({...a,document_kind:'normal'}))));assert.notEqual(ops.digest(normalBinding),operation.binding_hash);
  await assert.rejects(ops.bound({actorId:f.actor.id,preview,attachments:mail.normalizeReplyAttachments(input.map(a=>({...a,document_kind:'normal'}))),operationId:operation.operation_id},fetchImpl),/reply_operation_mismatch/);
  await ops.act(f.actor.id,'claim',operation,{},fetchImpl);await ops.act(f.actor.id,'sent',operation,{gmail_message_id:sent,gmail_thread_id:thread},fetchImpl);
  const list=await documents.list({actorId:f.actor.id,inquiryId:f.inquiryId},fetchImpl);assert.equal(list.operations.length,1);assert.deepEqual(list.operations[0].attachments.map(a=>a.document_kind),['normal','estimate','invoice']);
  const verified=await documents.verify({actorId:f.actor.id,inquiryId:f.inquiryId,operationId:operation.operation_id,messageId:sent},fetchImpl);assert.equal(verified.verification,'VERIFIED');assert.equal(verified.attachments[1].part_id,'2');assert.equal(verified.attachments[1].sha256,sha(bytes));
  const protectedTables=['pa_case_commercial_state','pa_estimate_revisions','pa_commercial_documents','pa_contracts','pa_billings','pa_payment_records','pa_commercial_outbox','pa_change_evidence_events'];
  const digest=async()=>JSON.stringify(await Promise.all(protectedTables.map(async t=>(await f.db.query('select to_jsonb(t) v from '+t+' t order by to_jsonb(t)::text')).rows)));
  const before=await digest(),service=createService({fetchImpl}),reviewInput={case_id:f.inquiryId,operation_id:operation.operation_id,gmail_message_id:sent,part_id:'2',sha256:sha(bytes)};
  const review=await service.replyDocumentReview(reviewInput,f.actor);assert.equal(review.approval_matches,1);assert.equal(review.registration_state,'ESTIMATE_REGISTRATION_UNCONFIRMED');assert.equal(review.can_complete,false);
  await assert.rejects(service.replyDocumentAdopt({...reviewInput,adoption_operation_id:crypto.randomUUID()},f.actor),/change_evidence_incomplete/);
  const invoice=await service.replyDocumentReview({...reviewInput,part_id:'3',sha256:sha(f.quote)},f.actor);assert.equal(invoice.invoice_state,'SENT_DOCUMENT_REGISTRATION_UNCONFIRMED');assert.equal(invoice.commercial_write,false);
  await assert.rejects(service.replyDocumentReview({...reviewInput,part_id:'1',sha256:sha(Buffer.from('normal'))},f.actor),/change_evidence_mismatch/);
  await assert.rejects(service.replyDocumentReview({...reviewInput,approval_message_id:'foreign',approval_thread_id:thread},f.actor),/change_evidence_mismatch/);
  messages.set('typed_approval2',raw('typed_approval2',false,now+2000,'見積書を確認し承認します。','<typed_sent@fixture.invalid>'));
  await f.db.query("insert into pa_gmail_message_index(gmail_message_id,gmail_thread_id,inquiry_id,direction,from_address,to_addresses,received_at,subject,message_source,attachment_metadata) values('typed_approval2',$1,$2,'inbound','customer@example.invalid','[\"aratechsound@gmail.com\"]',$3,'Re: Typed fixture','gmail_direct','[]')",[thread,f.inquiryId,new Date(now+2000).toISOString()]);
  assert.equal((await service.replyDocumentReview(reviewInput,f.actor)).approval_matches,2);
  const manual=await service.replyDocumentReview({...reviewInput,approval_message_id:'typed_approval2',approval_thread_id:thread},f.actor);assert.equal(manual.selection.preview.evidence.approval.message_id,'typed_approval2');assert.equal(manual.can_complete,false,'manual approval cannot bypass missing V5 registration');
  assert.equal(await digest(),before);
  wrong=true;await assert.rejects(documents.verify({actorId:f.actor.id,inquiryId:f.inquiryId,operationId:operation.operation_id,messageId:sent},fetchImpl),/reply_document_mismatch/);wrong=false;
  unavailable=true;await assert.rejects(documents.list({actorId:f.actor.id,inquiryId:f.inquiryId},fetchImpl),/reply_document_read_unavailable/);unavailable=false;
  const p2=await ops.prepare({actorId:f.actor.id,preview:{...preview,body:'Unknown synthetic operation'},attachments},fetchImpl);await ops.act(f.actor.id,'claim',p2.operation,{},fetchImpl);await ops.act(f.actor.id,'unknown',p2.operation,{},fetchImpl);
  await assert.rejects(documents.verify({actorId:f.actor.id,inquiryId:f.inquiryId,operationId:p2.operation.operation_id,messageId:sent},fetchImpl),/reply_document_unconfirmed/);
  const rights=(await f.db.query("select has_function_privilege('service_role','pa_reply_document_list_v1(uuid,uuid)','EXECUTE') service,has_function_privilege('anon','pa_reply_document_list_v1(uuid,uuid)','EXECUTE') anon,has_function_privilege('authenticated','pa_reply_document_list_v1(uuid,uuid)','EXECUTE') authenticated")).rows[0];assert.deepEqual(rights,{service:true,anon:false,authenticated:false});
  await assert.rejects(documents.list({actorId:crypto.randomUUID(),inquiryId:f.inquiryId},fetchImpl));
  const other=await documents.list({actorId:f.actor.id,inquiryId:f.otherId},fetchImpl);assert.equal(other.operations.length,0);
  const state=(await f.db.query('select revision,current_estimate_revision_id from pa_case_commercial_state where inquiry_id=$1',[f.inquiryId])).rows[0];
  await assert.rejects(service.recoverEstimate({case_id:f.inquiryId,gmail_message_id:sent,gmail_attachment_id:'typed_att_1',mode:'current',expected_revision:state.revision,expected_current:state.current_estimate_revision_id,operation_id:crypto.randomUUID(),document_id:crypto.randomUUID(),amount_minor:200000,currency:'JPY',tax_basis:'tax_included',conditions:{}},f.actor),/post_contract_change_required/);
  // A distinct fixture starts with a valid managed V5 change. This is not an
  // import route for the already-sent real-world PDF and never authorizes one.
  const proposal=await service.createChangeProposal({case_id:f.inquiryId,contract_id:offer.id,expected_revision:state.revision,operation_id:crypto.randomUUID(),estimate_revision_id:crypto.randomUUID(),document_id:crypto.randomUUID(),filename:'b.pdf',content_base64:bytes.toString('base64'),sha256:sha(bytes),amount_minor:200000,currency:'JPY',tax_basis:'tax_included',conditions:{fixture:true},body:'Separate isolated managed V5 proposal',reply_source:{message_id:source,thread_id:thread}},f.actor);
  const proposalState=(await f.db.query('select revision from pa_case_commercial_state where inquiry_id=$1',[f.inquiryId])).rows[0];
  const agreement={case_id:f.inquiryId,change_order_id:proposal.id,expected_revision:proposalState.revision,operation_id:crypto.randomUUID(),evidence:{source:'customer_email',reference:'synthetic_approved_managed_proposal'}};
  await assert.rejects(service.recordChangeAgreement(agreement,f.actor),/change_proposal_not_sent/);
  // Fixture-only Provider ACK setup; no transport and no Gmail POST occurs.
  await f.db.query("update pa_commercial_outbox set state='sent',provider_message_id='synthetic_managed_ack',provider_thread_id=$2 where id=$1",[proposal.outbox_id,thread]);
  await service.recordChangeAgreement(agreement,f.actor);
  const completeInput={...reviewInput,approval_message_id:'typed_approval2',approval_thread_id:thread};
  const complete=await service.replyDocumentReview(completeInput,f.actor);assert.equal(complete.registration_state,'REGISTERED_CHANGE_AGREED');assert.equal(complete.can_complete,true);
  const confirmed={...completeInput,adoption_operation_id:crypto.randomUUID(),fingerprint:complete.selection.preview.fingerprint,previous_event_id:complete.selection.preview.previous_event_id};
  await assert.rejects(service.replyDocumentAdopt({...confirmed,fingerprint:'changed'},f.actor),/change_evidence_changed/);
  const commercialBefore=await Promise.all(protectedTables.filter(t=>t!=='pa_change_evidence_events').map(async t=>(await f.db.query('select to_jsonb(t) v from '+t+' t order by to_jsonb(t)::text')).rows));
  const committed=await service.replyDocumentAdopt(confirmed,f.actor);assert.equal(committed.complete,true);
  const replay=await service.replyDocumentAdopt({...confirmed,adoption_operation_id:crypto.randomUUID()},f.actor);assert.equal(replay.id,committed.id);assert.equal(replay.already_committed,true);
  assert.equal((await f.db.query("select count(*)::int n from pa_change_evidence_events where event_kind='adopted'")).rows[0].n,1);
  const commercialAfter=await Promise.all(protectedTables.filter(t=>t!=='pa_change_evidence_events').map(async t=>(await f.db.query('select to_jsonb(t) v from '+t+' t order by to_jsonb(t)::text')).rows));assert.deepEqual(commercialAfter,commercialBefore);
  // Identical PDF/RFC content under another immutable Gmail API identity is
  // not the same previously adopted source, even if a reply reference matches.
  const copy=structuredClone(messages.get(sent));copy.id='typed_sent_copy';messages.set(copy.id,copy);
  await f.db.query("insert into pa_gmail_message_index(gmail_message_id,gmail_thread_id,inquiry_id,direction,from_address,to_addresses,cc_addresses,subject,message_source,sent_at,attachment_metadata) select 'typed_sent_copy',gmail_thread_id,inquiry_id,direction,from_address,to_addresses,cc_addresses,subject,message_source,sent_at,attachment_metadata from pa_gmail_message_index where gmail_message_id=$1",[sent]);
  const copied=await ops.prepare({actorId:f.actor.id,preview,attachments,newOperation:true,previousOperationId:operation.operation_id},fetchImpl);
  await ops.act(f.actor.id,'claim',copied.operation,{},fetchImpl);await ops.act(f.actor.id,'sent',copied.operation,{gmail_message_id:copy.id,gmail_thread_id:thread},fetchImpl);
  const copiedInput={...completeInput,operation_id:copied.operation.operation_id,gmail_message_id:copy.id};
  const copiedReview=await service.replyDocumentReview(copiedInput,f.actor);assert.equal(copiedReview.existing_adoption.identity_matches,false);assert.equal(copiedReview.can_complete,false);
  await assert.rejects(service.replyDocumentAdopt({...copiedInput,adoption_operation_id:crypto.randomUUID()},f.actor),/change_evidence_incomplete/);
  assert.equal((await f.db.query("select count(*)::int n from pa_change_evidence_events where event_kind='adopted'")).rows[0].n,1);
  assert.equal(providerWrites,0);assert(!requests.some(x=>x.path.endsWith('/messages/send')));
  console.log(JSON.stringify({status:'PASS',three_independent_types:true,legacy_normal_hash_preserved:true,classification_bound_to_operation:true,readonly_rpc_privileges:true,provider_index_part_sha_verified:true,unregistered_estimate_hold:true,invoice_unregistered_distinct:true,manual_approval_bounded:true,multiple_candidates_not_auto_selected:true,unknown_never_verified_or_resent:true,protected_business_rows_unchanged:true,real_sends:0}));
 }finally{await f.db.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
