'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {PGlite}=require('@electric-sql/pglite');
const gmail=require('../api/_pa-gmail.cjs'),ops=require('../api/_pa-reply-operations.cjs');
const inquiryId='11111111-1111-4111-8111-111111111111',actorId='22222222-2222-4222-8222-222222222222',otherOwner='33333333-3333-4333-8333-333333333333';
const sourceId='source_fixture',threadId='thread_fixture',input={inquiryId,actorId,body:'Durable synthetic reply',replySourceMessageId:sourceId,replySourceThreadId:threadId};
Object.assign(process.env,{GMAIL_CLIENT_ID:'fixture-client',GMAIL_CLIENT_SECRET:'fixture-secret',GMAIL_REFRESH_TOKEN:'fixture-refresh',GMAIL_SENDER_ADDRESS:'aratechsound@gmail.com',GMAIL_REPLY_TO:'aratechsound@gmail.com',SUPABASE_URL:'https://fixture.invalid',SUPABASE_SERVICE_ROLE_KEY:'fixture-only'});
let db,sendCount=0,mode='success',boundLoaded=false,auditFailure=false,indexFailure=false,mailbox='aratechsound@gmail.com',searchMessages=[],proofMessage=null;
const json=(body,status=200)=>({ok:status<300,status,json:async()=>body});
const source={id:sourceId,threadId,internalDate:'1000',payload:{mimeType:'text/plain',headers:[{name:'From',value:'fixture@example.test'},{name:'To',value:'aratechsound@gmail.com'},{name:'Subject',value:'Fixture'},{name:'Message-ID',value:'<source@example.test>'}],body:{data:Buffer.from('Fixture').toString('base64url')}}};
const provider=async(url,options={})=>{const u=new URL(url);
 if(u.hostname==='oauth2.googleapis.com'){if(mode==='before'&&boundLoaded)throw Error('fixture_oauth_unavailable');return json({access_token:'fixture-only'});}
 if(u.hostname==='gmail.googleapis.com'){
  assert(['GET','POST',undefined].includes(options.method));
  if(u.pathname.endsWith('/profile'))return json({emailAddress:mailbox});
  if(u.pathname.includes('/threads/'))return json({messages:[source]});
  if(u.pathname.endsWith('/messages/send')){sendCount++;const payload=JSON.parse(options.body);const raw=Buffer.from(payload.raw,'base64url').toString();assert.match(raw,/<pa-reply-[a-f0-9-]{36}@ara-tech\.cc>/);assert.equal(payload.threadId,threadId);if(mode==='unknown')throw Error('fixture_response_lost_after_send');return json({id:'sent_'+sendCount,threadId});}
  if(u.pathname.endsWith('/messages')){assert.equal(options.method,'GET');assert(u.searchParams.get('q').includes('rfc822msgid:<pa-reply-'));return json({messages:searchMessages});}
  if(u.pathname.includes('/messages/'))return json(proofMessage);
  throw Error('unexpected mock Gmail route');
 }
 assert.equal(u.hostname,'fixture.invalid');const table=u.pathname.split('/').at(-1);
 if(table==='pa_reply_operation_v1'){
  const p=JSON.parse(options.body);const result=await db.query('select public.pa_reply_operation_v1($1::uuid,$2::text,$3::jsonb) result',[p.p_actor,p.p_action,JSON.stringify(p.p_payload)]);if(p.p_action==='get'&&mode==='before')boundLoaded=true;return json(result.rows[0].result);
 }
 if(table==='pa_inquiries')return json([{id:inquiryId,inquiry_number:'FIXTURE',email:'fixture@example.test',case_type:'GENERAL'}]);
 if(table==='pa_gmail_thread_links')return json([{inquiry_id:inquiryId,gmail_thread_id:threadId,conversation_role:'primary_conversation'}]);
 if(table==='pa_gmail_message_index'){if((options.method||'GET')==='GET')return json([{inquiry_id:inquiryId,gmail_message_id:sourceId,gmail_thread_id:threadId}]);if(indexFailure)return json({},503);return json([]);}
 if(table==='pa_inquiry_audit'&&auditFailure)return json({},503);
 return json([]);
};
const pre=body=>gmail.replyPreview({...input,body},provider);
const send=(body,p)=>gmail.sendReply({...input,body,operationId:p.operation_id,confirmationToken:p.confirmation_token},provider);
const state=id=>gmail.replyOperationStatus({actorId,inquiryId,operationId:id},provider);
async function expectState(id,s){assert.equal((await state(id)).operation.state,s);}
(async()=>{
 db=new PGlite();await db.exec(`create role anon;create role authenticated;create role service_role;create table work_admins(user_id uuid);insert into work_admins values('${actorId}'),('${otherOwner}');create table pa_inquiries(id uuid primary key,deleted_at timestamptz);insert into pa_inquiries values('${inquiryId}',null);create table pa_gmail_thread_links(inquiry_id uuid,gmail_thread_id text);insert into pa_gmail_thread_links values('${inquiryId}','${threadId}');create table pa_gmail_message_index(inquiry_id uuid,gmail_thread_id text,gmail_message_id text);insert into pa_gmail_message_index values('${inquiryId}','${threadId}','${sourceId}');`);
 await db.exec(fs.readFileSync(path.join(__dirname,'../ops/PAUI-046-reply-operations.sql'),'utf8'));
 const p=await pre('A same operation');await expectState(p.operation_id,'PREPARED');
 const [a,b]=await Promise.allSettled([send('A same operation',p),send('A same operation',p)]);assert.equal(sendCount,1);assert([a,b].some(r=>r.status==='fulfilled'));await expectState(p.operation_id,'SENT');
 // Re-import is a second server caller, not a shared in-memory fence.
 delete require.cache[require.resolve('../api/_pa-gmail.cjs')];const fresh=require('../api/_pa-gmail.cjs');
 await fresh.sendReply({...input,body:'A same operation',operationId:p.operation_id,confirmationToken:p.confirmation_token},provider);assert.equal(sendCount,1);
 assert.equal((await pre('A same operation')).operation_id,p.operation_id);
 const distinct=await gmail.replyPreview({...input,body:'A same operation',newOperation:true,previousOperationId:p.operation_id},provider);assert.notEqual(distinct.operation_id,p.operation_id);await send('A same operation',distinct);assert.equal(sendCount,2);
 // A pre-provider failure is terminal for that operation; no provider call.
 const before=await pre('D before provider');mode='before';await assert.rejects(send('D before provider',before),/fixture_oauth/);mode='success';await expectState(before.operation_id,'FAILED_BEFORE_SEND');assert.equal(sendCount,2);
 const unknown=await pre('E response lost');mode='unknown';await assert.rejects(send('E response lost',unknown),/reply_operation_unknown/);mode='success';await expectState(unknown.operation_id,'UNKNOWN');assert.equal(sendCount,3);
 await assert.rejects(send('E response lost',unknown),/reply_operation_blocked/);assert.equal(sendCount,3);
 const reconcile=()=>gmail.reconcileReplyOperation({actorId,inquiryId,operationId:unknown.operation_id},provider);
 assert.equal((await reconcile()).operation.state,'UNKNOWN');
 searchMessages=[{id:'similar_one'},{id:'similar_two'}];assert.equal((await reconcile()).operation.state,'UNKNOWN');
 const record=(await ops.status({actorId,inquiryId,operationId:unknown.operation_id},provider)).operation;
 searchMessages=[{id:'proof_fixture'}];proofMessage={id:'proof_fixture',threadId,labelIds:['SENT'],internalDate:String(Date.now()),payload:{mimeType:'text/plain',headers:[{name:'From',value:'aratechsound@gmail.com'},{name:'To',value:'fixture@example.test'},{name:'Subject',value:record.binding.subject},{name:'Message-ID',value:ops.rfcId(record.operation_id)},{name:'In-Reply-To',value:record.binding.source_rfc}],body:{data:Buffer.from(require('../api/_pa-mail.cjs').normalizeCustomerBody('E response lost')).toString('base64url')}}};
 proofMessage.threadId='wrong';assert.equal((await reconcile()).operation.state,'UNKNOWN');proofMessage.threadId=threadId;
 assert.equal((await reconcile()).operation.state,'SENT');assert.equal(sendCount,3);
 for(const kind of ['audit','index']){const body='F/G '+kind,pr=await pre(body);auditFailure=kind==='audit';indexFailure=kind==='index';const sent=await send(body,pr);assert.equal(sent.history_sync,'INCOMPLETE');await expectState(pr.operation_id,'SENT');auditFailure=indexFailure=false;const count=sendCount;await send(body,pr);assert.equal(sendCount,count);}
 const bound=await pre('L bound content');await assert.rejects(gmail.sendReply({...input,body:'L changed content',operationId:bound.operation_id,confirmationToken:bound.confirmation_token},provider),/invalid_confirmation/);
 await assert.rejects(gmail.sendReply({...input,actorId:otherOwner,body:'L bound content',operationId:bound.operation_id,confirmationToken:bound.confirmation_token},provider),/invalid_confirmation/);
 await assert.rejects(gmail.replyOperationStatus({actorId:otherOwner,inquiryId,operationId:bound.operation_id},provider),/reply_operation_mismatch/);
 mailbox='foreign@example.test';await assert.rejects(pre('foreign account'),/gmail_mailbox_mismatch/);mailbox='aratechsound@gmail.com';
 const permissions=(await db.query("select has_function_privilege('service_role','public.pa_reply_operation_v1(uuid,text,jsonb)','EXECUTE') service, has_function_privilege('anon','public.pa_reply_operation_v1(uuid,text,jsonb)','EXECUTE') anon,has_function_privilege('authenticated','public.pa_reply_operation_v1(uuid,text,jsonb)','EXECUTE') authenticated,has_table_privilege('service_role','public.pa_reply_operations_v1','UPDATE') direct_update")).rows[0];assert.deepEqual(permissions,{service:true,anon:false,authenticated:false,direct_update:false});
 console.log(JSON.stringify({status:'PASS',same_operation_twice:true,two_server_callers:true,server_reload_retry:true,prepared_reuse:true,explicit_distinct_operation:true,before_send_failure:true,provider_response_unknown:true,unknown_never_retried:true,search_empty_unknown:true,multiple_similar_unknown:true,strict_rfc_identity_reconciliation:true,audit_failure_sent_sync_pending:true,index_failure_sent_sync_pending:true,owner_content_account_protection:true,service_only_rpc:true,append_only:true,mocked_provider_sends:sendCount,real_provider_sends:0}));
 await db.close();
})().catch(async e=>{console.error(e);process.exitCode=1;if(db)await db.close();});
