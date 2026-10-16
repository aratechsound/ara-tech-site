'use strict';
const assert=require('node:assert/strict');
const {createReadHandler}=require('../api/_pa-workspace-read.cjs');
const {reviewThreadIdentity}=require('../api/_pa-mail-candidate-identity.cjs');
const {threadRows}=require('../api/_pa-mail-discovery.cjs');
const {normalizeMessage}=require('../api/_pa-gmail.cjs');
const C='11111111-1111-4111-8111-111111111111',D='22222222-2222-4222-8222-222222222222',T='candidate-thread',token='Bearer '+'fixture-only-'.repeat(4);
let mode='',calls=[],providerCalls=[],adminReads=0,pendingReads=0;
const raw=(id,sent=false)=>({id,threadId:T,labelIds:sent?['SENT']:['INBOX'],internalDate:'1791500000000',payload:{headers:[{name:'From',value:sent?'aratechsound@gmail.com':'fixture@example.invalid'},{name:'To',value:sent?'fixture@example.invalid':'aratechsound@gmail.com'},{name:'Cc',value:'copy@example.invalid'},{name:'Subject',value:'Candidate '+id}],parts:[{mimeType:'text/plain',body:{data:Buffer.from('実本文 '+id+'\n二行目\n三行目\n四行目\n> 引用 '+id).toString('base64url')}}]}});
const original={id:T,messages:[raw('candidate-1'),raw('candidate-2',true)]},fingerprint=reviewThreadIdentity(original,T).fingerprint;
const provider={normalize:normalizeMessage,thread:async id=>{providerCalls.push(['thread',id]);const t=structuredClone(original);if(mode==='stale-thread')t.messages[1].payload.headers.find(h=>h.name==='Subject').value='Changed';if(mode==='new-message')t.messages.push(raw('later'));if(mode==='duplicate')t.messages.push(raw('candidate-1'));return t;},message:async id=>{providerCalls.push(['message',id]);const m=structuredClone(original.messages.find(m=>m.id===id));if(mode==='provider-denied')throw Error('gmail_read_403');if(mode==='message-thread')m.threadId='wrong';if(mode==='changed-message')m.payload.headers.find(h=>h.name==='Subject').value='Changed';if(mode==='nonregular')m.labelIds.push('TRASH');if(mode==='empty')m.payload.parts=[];return m;}};
async function fetchImpl(url,options){
 calls.push({url,options});const u=new URL(url),table=u.pathname.split('/').at(-1);let value=[];
 if(u.pathname==='/auth/v1/user'){if(mode==='expired')return new Response('{}',{status:401});value={id:C};}
 else if(table==='work_admins'){adminReads++;value=mode==='not-owner'||mode==='revoked'&&adminReads>1?[]:[{user_id:C}];}
 else if(table==='pa_inquiries')value=u.searchParams.get('id')==='eq.'+C?[{id:C}]:[];
 else if(table==='paui041_mail_outcomes'){
  pendingReads++;value=mode==='not-candidate'||mode==='decided'&&pendingReads>1?[]:[{inquiry_id:mode==='wrong-case'?D:C,gmail_message_id:mode==='wrong-message'?'foreign':mode==='outbound'?'candidate-2':'candidate-1',gmail_thread_id:T,status:mode==='excluded'?'EXCLUDED_WITH_REASON':'RELATED_CANDIDATE',fingerprint}];
 }else if(table==='pa_gmail_message_index')value=mode==='foreign-index'?[{inquiry_id:D,gmail_thread_id:T,gmail_message_id:'candidate-1'}]:[];
 else if(table==='pa_gmail_thread_links')value=mode==='foreign-link'||mode==='linked-during-read'&&pendingReads>1?[{inquiry_id:D,gmail_thread_id:T}]:[];
 return new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
}
const handler=createReadHandler({key:'sb_publishable_fixture',fetchImpl,provider});
async function read({caseId=C,thread=T,message='candidate-1',fp=fingerprint,method='GET',headers={}}={}){
 const res={statusCode:200,headers:{},setHeader(k,v){this.headers[k]=v;},end(v){this.body=v;}};
 await handler({method,url:'/api/pa-workspace-read?path='+encodeURIComponent('/data/mail-candidate-body/'+[caseId,thread,message,fp].join('/')),headers:{host:'fixture.invalid',authorization:token,...headers}},res);return res;
}
let checks=0;
async function check(name,fn){mode='';calls=[];providerCalls=[];adminReads=0;pendingReads=0;await fn();checks++;console.log('PASS '+name);}
(async()=>{
 global.fetch=async()=>{throw Error('LIVE_NETWORK_FORBIDDEN');};
 await check('Read fingerprint exactly matches the unchanged PAUI-041 decision fingerprint',async()=>{assert(threadRows(original,T,{authority:{cases:[],links:[],messages:[]}},C).every(r=>r.fingerprint===fingerprint));mode='outbound';const r=await read({message:'candidate-2'});assert.equal(r.statusCode,200);const m=JSON.parse(r.body).result;assert.equal(m.direction,'outbound');assert.equal(m.from_address,'aratechsound@gmail.com');assert(m.body_text.includes('candidate-2'));});
 await check('Pending exact tuple returns only the selected actual message and envelope',async()=>{const r=await read();assert.equal(r.statusCode,200);const m=JSON.parse(r.body).result;assert.equal(m.gmail_message_id,'candidate-1');assert.equal(m.gmail_thread_id,T);assert.equal(m.fingerprint,fingerprint);assert.equal(m.from_address,'fixture@example.invalid');assert.deepEqual(m.cc_addresses,['copy@example.invalid']);assert(m.body_text.includes('実本文 candidate-1'));assert(!m.body_text.includes('実本文 candidate-2'));assert.deepEqual(providerCalls,[['thread',T],['message','candidate-1']]);assert.equal(pendingReads,2);assert.equal(adminReads,2);});
 await check('No arbitrary Gmail ID, wrong case/thread/fingerprint, or excluded outcome access',async()=>{for(const input of [{caseId:D},{thread:'foreign'},{message:'foreign'},{fp:'0'.repeat(64)}]){const before=providerCalls.length;assert.equal((await read(input)).statusCode,403);assert.equal(providerCalls.length,before);}for(mode of ['not-candidate','wrong-case','wrong-message','excluded','foreign-index','foreign-link']){const before=providerCalls.length;assert.equal((await read()).statusCode,403);assert.equal(providerCalls.length,before);}});
 await check('Owner authentication, ACL, same-origin and GET-only guards precede Provider access',async()=>{for(mode of ['not-owner','expired']){const r=await read();assert([401,403].includes(r.statusCode));}mode='';assert.equal((await read({method:'POST'})).statusCode,405);assert.equal((await read({headers:{origin:'https://foreign.invalid'}})).statusCode,403);assert.equal((await read({headers:{'sec-fetch-site':'cross-site'}})).statusCode,403);assert.equal(providerCalls.length,0);});
 await check('Changed full-thread fingerprint, appended mail and duplicate identities fail closed',async()=>{for(mode of ['stale-thread','new-message','duplicate']){providerCalls=[];assert.equal((await read()).statusCode,403);assert(!providerCalls.some(c=>c[0]==='message'));}});
 await check('Changed selected message/thread and non-regular labels fail closed',async()=>{for(mode of ['message-thread','changed-message','nonregular'])assert.equal((await read()).statusCode,403);});
 await check('Decision/link/admin revocation during the read discards the body',async()=>{for(mode of ['decided','linked-during-read','revoked']){pendingReads=0;adminReads=0;assert.equal((await read()).statusCode,403);}});
 await check('Provider refusal is not success and empty actual body stays empty',async()=>{mode='provider-denied';assert.equal((await read()).statusCode,403);mode='empty';const r=await read();assert.equal(r.statusCode,200);assert.equal(JSON.parse(r.body).result.body_state,'empty');assert.equal(JSON.parse(r.body).result.body_text,'');});
 await check('All DB calls retain Owner JWT, publishable key and GET, with no RPC or mutation',async()=>{await read();assert(calls.length>0);assert(calls.every(c=>c.options.method==='GET'&&c.options.headers.authorization===token&&c.options.headers.apikey==='sb_publishable_fixture'&&!c.url.includes('/rpc/')));assert.equal(process.env.PAUI041_DISCOVERY_ENABLED,undefined);});
 console.log(JSON.stringify({status:'PASS',checks,provider_mock_only:true,db_writes:0,gmail_mutations:0,sends:0}));
})().catch(e=>{console.error(e);process.exitCode=1;});
