const assert=require('node:assert/strict');
global.fetch=async()=>{throw Error('LIVE_NETWORK_FORBIDDEN');};
Object.assign(process.env,{SUPABASE_URL:'https://fixture.invalid',SUPABASE_SERVICE_ROLE_KEY:'fixture-only',GMAIL_CLIENT_ID:'fixture',GMAIL_CLIENT_SECRET:'fixture',GMAIL_REFRESH_TOKEN:'fixture',GMAIL_SENDER_ADDRESS:'aratechsound@gmail.com',GMAIL_REPLY_TO:'aratechsound@gmail.com'});
const {replyContext,replyPreview}=require('../api/_pa-gmail.cjs');
const A='123e4567-e89b-42d3-a456-426614174001',B='123e4567-e89b-42d3-a456-426614174002';
function fixture(){const state={caseId:A,linkCase:A,indexCase:A,thread:'thread1',from:'customer@example.invalid',reply:'customer@example.invalid',writes:[]};
 const json=value=>({ok:true,status:200,json:async()=>value});
 const fetchImpl=async(url,opts={})=>{const u=new URL(url),method=opts.method||'GET';if(u.pathname==='/token')return json({access_token:'fixture'});if(method!=='GET'){state.writes.push(url);throw Error('WRITE_FORBIDDEN');}
 if(u.pathname.endsWith('/profile'))return json({emailAddress:'aratechsound@gmail.com'});
 if(u.pathname.endsWith('/pa_inquiries'))return json([{id:state.caseId,email:'customer@example.invalid',case_type:'PA_EVENT'}]);
 if(u.pathname.endsWith('/pa_gmail_thread_links'))return json([{inquiry_id:state.linkCase,gmail_thread_id:state.thread,conversation_role:'secondary_conversation'}]);
 if(u.pathname.includes('/threads/'))return json({messages:[{id:'message1',threadId:state.thread,internalDate:'1791000000000',payload:{mimeType:'text/plain',headers:Object.entries({From:state.from,...(state.reply===null?{}:{'Reply-To':state.reply}),To:'aratechsound@gmail.com',Cc:'peer@example.invalid',Subject:'Fixture','Message-ID':'<fixture@invalid>'}).map(([name,value])=>({name,value})),body:{data:'Zml4dHVyZQ'}}}]});
 if(u.pathname.endsWith('/pa_gmail_message_index'))return json([{inquiry_id:state.indexCase,gmail_thread_id:state.thread,gmail_message_id:'message1'}]);
 throw Error('UNEXPECTED_BOUNDARY '+url);
 };return {state,fetchImpl};}
const input={inquiryId:A,actorId:B,replySourceMessageId:'message1',replySourceThreadId:'thread1',body:'Fixture'};
(async()=>{let passed=0;const f=fixture(),c=await replyContext(input,f.fetchImpl),p=await replyPreview(input,f.fetchImpl);assert.equal(c.recipient,'customer@example.invalid');assert.equal(c.subject,'Re: Fixture');assert.deepEqual(c.cc_addresses,['peer@example.invalid']);assert.equal(c.reply_source_authority_hash,p.reply_source_authority_hash);assert.equal(c.confirmation_token,undefined);assert.equal(c.html,undefined);assert.equal(f.state.writes.length,0);passed++;
 for(const key of ['caseId','linkCase','indexCase']){const f=fixture();f.state[key]=B;await assert.rejects(()=>replyContext(input,f.fetchImpl));assert.equal(f.state.writes.length,0);passed++;}
 for(const reply of ['foreign@example.invalid','bad','one@example.invalid, two@example.invalid']){const f=fixture();f.state.reply=reply;await assert.rejects(()=>replyContext(input,f.fetchImpl));passed++;}
 const fallback=fixture();fallback.state.reply=null;assert.equal((await replyContext(input,fallback.fetchImpl)).recipient,'customer@example.invalid');passed++;
 for(const field of ['replySourceMessageId','replySourceThreadId']){const f=fixture();await assert.rejects(()=>replyContext({...input,[field]:undefined},f.fetchImpl));passed++;}
 const other=fixture();other.state.thread='thread2';const bound=await replyContext({...input,replySourceThreadId:'thread2'},other.fetchImpl);assert.equal(bound.gmail_thread_id,'thread2');passed++;
 console.log(JSON.stringify({scope:'PAUI089_ISOLATED_CONTEXT',passed,real_sends:0,writes:0}));
})().catch(e=>{console.error(e);process.exitCode=1;});
