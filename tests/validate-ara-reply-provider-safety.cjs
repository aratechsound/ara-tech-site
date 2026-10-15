'use strict';
const assert=require('node:assert/strict'),gmail=require('../api/_pa-gmail.cjs');
Object.assign(process.env,{GMAIL_CLIENT_ID:'fixture-client',GMAIL_CLIENT_SECRET:'fixture-secret',GMAIL_REFRESH_TOKEN:'fixture-refresh',GMAIL_SENDER_ADDRESS:'aratechsound@gmail.com',GMAIL_REPLY_TO:'aratechsound@gmail.com',SUPABASE_URL:'https://fixture.invalid',SUPABASE_SERVICE_ROLE_KEY:'fixture-only'});
const inquiryId='11111111-1111-4111-8111-111111111111',actorId='22222222-2222-4222-8222-222222222222',threadId='fixture_thread';
const input={inquiryId,actorId,body:'Synthetic reply',replySourceMessageId:'fixture_message',replySourceThreadId:threadId,attachments:[{filename:'fixture.pdf',mime_type:'application/pdf',data:Buffer.from('synthetic original bytes').toString('base64url')}]};
const source={id:'fixture_message',threadId,internalDate:'1000',payload:{mimeType:'text/plain',headers:[{name:'From',value:'fixture@example.test'},{name:'To',value:'aratechsound@gmail.com'},{name:'Subject',value:'Fixture'},{name:'Message-ID',value:'<fixture@example.test>'}],body:{data:Buffer.from('Fixture').toString('base64url')}}};
const json=(payload,status=200)=>({ok:status<300,status,json:async()=>payload});
let mode='success',sendCount=0,indexWrites=0,recipient='fixture@example.test';const audit=[];
const mock=async(url,options={})=>{const u=new URL(url);
 if(u.hostname==='oauth2.googleapis.com')return json({access_token:'fixture-only'});
 if(u.hostname==='gmail.googleapis.com'){
  if(u.pathname.endsWith('/profile'))return json({emailAddress:'aratechsound@gmail.com'});
  if(u.pathname.includes('/threads/'))return json({messages:[{...source,payload:{...source.payload,headers:source.payload.headers.map(h=>h.name==='From'?{...h,value:recipient}:h)}}]});
  if(u.pathname.endsWith('/messages/send')){sendCount++;const p=JSON.parse(options.body);assert.equal(p.threadId,threadId);const raw=Buffer.from(p.raw,'base64url').toString();assert.match(raw,/To: fixture@example\.test/u);assert.match(raw,/In-Reply-To: <fixture@example\.test>/u);assert.match(raw,/filename\*=UTF-8''fixture\.pdf/u);if(mode==='unknown')throw Error('fixture_provider_response_unknown');return json({id:'sent_fixture',threadId});}
  throw Error('unexpected mock Gmail route');
 }
 assert.equal(u.hostname,'fixture.invalid');const name=u.pathname.split('/').at(-1);
 if(name==='pa_inquiries')return json([{id:inquiryId,inquiry_number:'FIXTURE',email:'fixture@example.test',case_type:'GENERAL'}]);
 if(name==='pa_gmail_thread_links')return json([{inquiry_id:inquiryId,gmail_thread_id:threadId,conversation_role:'primary_conversation'}]);
 if(name==='pa_gmail_message_index'){
  if((options.method||'GET')==='GET')return json([{inquiry_id:inquiryId,gmail_message_id:'fixture_message',gmail_thread_id:threadId}]);
  indexWrites++;if(mode==='indexFailure')return json({message:'fixture write failure'},503);return json([]);
 }
 if(name==='pa_inquiry_audit'&&options.method==='POST')audit.push(JSON.parse(options.body).action);
 return json([]);
};
(async()=>{
 const p=await gmail.replyPreview(input,mock);const approved={...input,confirmationToken:p.confirmation_token};
 const trace={};const sent=await gmail.sendReply({...approved,deliveryTrace:trace},mock);assert.equal(sent.gmail_message_id,'sent_fixture');assert.equal(sendCount,1);assert.equal(indexWrites,1);assert(audit.includes('gmail_case_reply_sent'));assert(audit.includes('gmail_threads_synced'));assert.equal(trace.provider_response_received,true);
 mode='unknown';const unknownTrace={};await assert.rejects(gmail.sendReply({...approved,deliveryTrace:unknownTrace},mock),/fixture_provider_response_unknown/);assert.equal(sendCount,2);assert.equal(unknownTrace.provider_request_started,true);assert.notEqual(unknownTrace.provider_response_received,true);
 mode='indexFailure';const failureTrace={};await assert.rejects(gmail.sendReply({...approved,deliveryTrace:failureTrace},mock),/supabase_503/);assert.equal(sendCount,3);assert.equal(failureTrace.provider_response_received,true);assert.equal(failureTrace.provider_http_status,200);
 const before=sendCount;mode='success';await assert.rejects(gmail.sendReply({...approved,attachments:[{...input.attachments[0],data:Buffer.from('tampered same length!!!!').toString('base64url')}]},mock),/preview|confirmation/u);assert.equal(sendCount,before);
 await assert.rejects(gmail.sendReply({...approved,replySourceThreadId:'wrong_thread'},mock));assert.equal(sendCount,before);
 recipient='changed@example.test';await assert.rejects(gmail.sendReply(approved,mock));assert.equal(sendCount,before);
 console.log(JSON.stringify({status:'PASS',provider_mock_only:true,success_sync_and_history:true,unknown_provider_trace:true,success_then_index_failure_trace:true,attachment_content_binding:true,thread_and_recipient_protected:true,mocked_provider_sends:sendCount,real_provider_sends:0,durable_idempotency_not_added:true}));
})().catch(e=>{console.error(e);process.exitCode=1;});
