'use strict';
const assert=require('node:assert/strict');
const ops=require('../api/_pa-reply-operations.cjs'),gmail=require('../api/_pa-gmail.cjs');
const mail=require('../api/_pa-mail.cjs'),proof=require('../api/_pa-reply-proof.cjs');
const inquiryId='11111111-1111-4111-8111-111111111111',actorId='22222222-2222-4222-8222-222222222222',operationId='33333333-3333-4333-8333-333333333333';
Object.assign(process.env,{SUPABASE_URL:'https://fixture.invalid',SUPABASE_SERVICE_ROLE_KEY:'fixture-only'});
const body=mail.normalizeCustomerBody('一意な操作の検証本文'),subject='Re: 【TEST】返信照合';
let op,writes,reads,contextMismatch=false,unavailable=false,sourceMoved=false,search=[],threadMessages=[];
const original=()=>({operation_id:operationId,inquiry_id:inquiryId,state:'SENT',gmail_message_id:'ack_message',history_sync:'COMPLETE',created_at:new Date().toISOString(),expires_at:new Date(Date.now()+600000).toISOString(),binding:{inquiry_id:inquiryId,account:'aratechsound@gmail.com',source_id:'source_message',thread_id:'thread_fixture',source_rfc:'<source@example.test>',to:'recipient@example.test',cc:[],subject,body_sha256:ops.hash(body),attachments:[]}});
const message=(id='ack_message',rfc='<gmail-generated@example.test>')=>({id,threadId:'thread_fixture',labelIds:['SENT'],internalDate:String(Date.now()),payload:{mimeType:'text/plain',headers:[{name:'From',value:'ARA-TECH <aratechsound@gmail.com>'},{name:'To',value:'recipient@example.test'},{name:'Subject',value:subject},{name:'Message-ID',value:rfc},{name:'In-Reply-To',value:'<source@example.test>'},{name:'References',value:'<source@example.test>'}],body:{data:Buffer.from(body).toString('base64url')}}});
let acknowledged=message();
const db=async(url,options={})=>{
 const u=new URL(url);assert.equal(u.origin,'https://fixture.invalid');
 if(u.pathname.endsWith('/rpc/pa_reply_operation_v1')){
  const p=JSON.parse(options.body);assert.equal(p.p_actor,actorId);assert.equal(p.p_payload.inquiry_id,inquiryId);
  if(p.p_action==='get')return {ok:true,json:async()=>({ok:true,operation:structuredClone(op)})};
  writes.push(p.p_action);assert(['unknown','sent'].includes(p.p_action));
  assert.notEqual(op.state,'SENT','existing SENT must never receive a ledger mutation');
  if(p.p_action==='sent'){op.state='SENT';op.gmail_message_id=p.p_payload.gmail_message_id;}else op.state='UNKNOWN';
  return {ok:true,json:async()=>({ok:true,operation:structuredClone(op)})};
 }
 assert.equal(options.method||'GET','GET');
 if(u.pathname.endsWith('/pa_gmail_thread_links'))return {ok:true,json:async()=>[{inquiry_id:contextMismatch?'other-case':inquiryId}]};
 if(u.pathname.endsWith('/pa_gmail_message_index'))return {ok:true,json:async()=>[{inquiry_id:inquiryId,gmail_thread_id:sourceMoved?'other-thread':'thread_fixture'}]};
 throw Error('unexpected database request');
};
const read=async(path,options)=>{
 assert.equal(options.method,'GET');assert(!/send|modify|trash|draft/iu.test(path),'all Gmail operations must be read-only');reads.push(path);if(unavailable)throw Error('fixture_read_error');
 if(path.startsWith('/messages?'))return {messages:search};
 if(path.startsWith('/threads/'))return {id:'thread_fixture',messages:threadMessages};
 if(path.startsWith('/messages/'))return structuredClone(acknowledged);
 throw Error('unexpected Gmail request');
};
const reset=()=>{op=original();writes=[];reads=[];contextMismatch=false;sourceMoved=false;unavailable=false;search=[];threadMessages=[];acknowledged=message();};
const reconcile=()=>ops.reconcile({actorId,inquiryId,operationId},read,gmail.normalizeMessage,db);
(async()=>{
 reset();const saved=JSON.stringify(op);let r=await reconcile();
 assert.equal(r.matched,true);assert.equal(r.verification.basis,'PERSISTED_PROVIDER_ACK_GMAIL_ID');assert.equal(r.verification.generated_rfc_preserved,false);
 assert.equal(r.operation.gmail_message_id,'ack_message');assert.equal(r.operation.history_sync,'COMPLETE');assert.equal(JSON.stringify(op),saved);assert.deepEqual(writes,[]);assert.equal(reads.length,1);assert(reads[0].startsWith('/messages/ack_message?'));
 // Subject representation changes are decoded; no raw MIME/HTML byte equality claim.
 acknowledged.payload.headers.find(h=>h.name==='Subject').value='=?UTF-8?B?'+Buffer.from(subject).toString('base64')+'?=';
 assert.equal((await reconcile()).matched,true);
 const q=Buffer.from(subject).toString('hex').match(/../gu).map(v=>'='+v.toUpperCase()).join('');assert.equal(proof.subject('=?UTF-8?Q?'+q+'?='),subject);
 assert.throws(()=>proof.subject('=?UTF-8?B?////?='));assert.throws(()=>proof.subject('=?UTF-8?B?!!!!?='));
 for(const field of ['thread','to','cc','account','reply_source','body','subject','duplicate_message_id','ack_id']){
  reset();const h=name=>acknowledged.payload.headers.find(x=>x.name===name);
  if(field==='thread')acknowledged.threadId='other';
  if(field==='to')h('To').value='other@example.test';
  if(field==='cc')acknowledged.payload.headers.push({name:'Cc',value:'other@example.test'});
  if(field==='account')h('From').value='other@example.test';
  if(field==='reply_source')h('In-Reply-To').value='<other@example.test>';
  if(field==='body')acknowledged.payload.body.data=Buffer.from('different').toString('base64url');
  if(field==='subject')h('Subject').value='similar subject';
  if(field==='duplicate_message_id')acknowledged.payload.headers.push({name:'Message-ID',value:'<other@example.test>'});
  if(field==='ack_id')acknowledged.id='other_id';
  assert.equal((await reconcile()).matched,false,field);assert.equal(op.state,'SENT');assert.deepEqual(writes,[]);
 }
 reset();unavailable=true;r=await reconcile();assert.equal(r.matched,false);assert.equal(r.verification.status,'UNAVAILABLE');assert.equal(op.state,'SENT');assert.deepEqual(writes,[]);
 for(const moving of ['case','source']){
  reset();contextMismatch=moving==='case';sourceMoved=moving==='source';await assert.rejects(reconcile(),/reply_operation_mismatch/);assert.deepEqual(reads,[]);assert.deepEqual(writes,[]);
 }
 // A rewritten-ID candidate, even if it is the only exact content match, is
 // not unique evidence of this operation after a lost ACK.
 reset();op.state='UNKNOWN';delete op.gmail_message_id;threadMessages=[message('candidate_one')];r=await reconcile();assert.equal(r.operation.state,'UNKNOWN');assert.equal(r.matched,false);assert.equal(r.review.candidates.length,1);assert.equal(r.review.candidates[0].binding_matches,true);assert.equal(r.review.automatic_sent,false);assert.deepEqual(writes,['unknown']);
 threadMessages=[message('candidate_one'),message('candidate_two')];r=await reconcile();assert.equal(r.operation.state,'UNKNOWN');assert.equal(r.review.candidates.length,2);assert(!writes.includes('sent'));
 threadMessages=[];r=await reconcile();assert.equal(r.operation.state,'UNKNOWN');assert.equal(r.review.candidates.length,0);
 threadMessages=Array.from({length:12},(_,i)=>message('candidate_'+i));r=await reconcile();assert.equal(r.review.candidates.length,10);assert.equal(r.review.truncated,true);
 unavailable=true;r=await reconcile();assert.equal(r.operation.state,'UNKNOWN');assert.equal(r.review.reason,'GMAIL_READ_UNAVAILABLE');
 // Positive exact generated-RFC evidence remains compatible with PAUI-046,
 // but is not assumed to be retained or replaced with similarity matching.
 reset();op.state='UNKNOWN';delete op.gmail_message_id;search=[{id:'proof_id'}];acknowledged=message('proof_id',ops.rfcId(operationId));r=await reconcile();assert.equal(r.matched,true);assert.equal(op.state,'SENT');assert.equal(r.verification.basis,'EXACT_GENERATED_RFC_AND_FULL_BINDING');
 console.log(JSON.stringify({status:'PASS',ack_rewritten_rfc_direct_get:true,sent_immutable:true,unknown_single_or_multiple_candidate_never_promoted:true,unknown_no_retry:true,bounded_manual_review:true,subject_rfc2047:true,account_case_thread_recipient_body_protected:true,positive_unique_rfc_compatibility:true,real_provider_sends:0}));
})().catch(e=>{console.error(e);process.exitCode=1;});
