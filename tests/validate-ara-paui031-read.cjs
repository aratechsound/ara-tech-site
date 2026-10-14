'use strict';
const assert=require('node:assert/strict');
const {createReadHandler}=require('../api/_pa-workspace-read.cjs');
const {normalizeMessage,manualLink}=require('../api/_pa-gmail.cjs');
const {customerQuery,chooseCandidate,relatedToCase}=require('../api/_pa-mail-candidates.cjs');
const C='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
let mode='',calls=[],providerCalls=[],queries=[];
const inquiry={id:C,email:'customer@example.invalid',event_name:'2026架空まつり',inquiry_number:'PA-20261001-00001'};
const raw=id=>({id:id+'-message',threadId:id,internalDate:'1791894961000',labelIds:mode==='draft'?['DRAFT']:['INBOX','UNREAD'],snippet:'架空まつりの連絡',payload:{headers:[{name:'From',value:mode==='wrong-participant'?'other@example.invalid':inquiry.email},{name:'To',value:'aratechsound@gmail.com'},{name:'Subject',value:mode==='unrelated'?'別件の連絡':'架空まつりについて'}],body:{}}});
const handler=createReadHandler({key:'sb_publishable_fixture',provider:{normalize:normalizeMessage,
  searchThreads:async query=>{providerCalls.push('search');queries.push(query);return {threads:[{gmail_thread_id:'candidate',snippet:'架空の候補'}],truncated:mode==='truncated'};},
  thread:async id=>{providerCalls.push(id);if(mode==='provider-fail')throw Error('gmail_read_403');return {id,messages:[raw(id)]};}
},fetchImpl:async(url,options)=>{
  calls.push({url,options});assert.equal(options.method,'GET');const q=new URL(url),table=q.pathname.split('/').at(-1);let data=[];
  if(q.pathname==='/auth/v1/user')data={id:C};
  if(table==='work_admins')data=mode==='no-admin'?[]:[{user_id:C}];
  if(table==='pa_inquiries')data=q.searchParams.has('id')?(q.searchParams.get('id')==='eq.'+C?[{id:C}]:[]):[inquiry,...(mode==='multiple-cases'?[{...inquiry,id:B}]:[])];
  if(table==='pa_gmail_thread_links'){
    if(q.searchParams.has('gmail_thread_id'))data=mode==='foreign'?[{inquiry_id:B,gmail_thread_id:'candidate'}]:mode==='linked'?[{inquiry_id:C,gmail_thread_id:'candidate'}]:[];
    else data=mode==='linked'?[{inquiry_id:C,gmail_thread_id:'candidate'}]:[];
  }
  if(table==='pa_gmail_message_index')data=mode==='foreign-index'?[{inquiry_id:B,gmail_thread_id:'candidate',gmail_message_id:'candidate-message'}]:[];
  return new Response(JSON.stringify(data));
}});
async function read(route,method='GET',token='Bearer fixture-only-owner-token-000000'){
 const res={headers:{},statusCode:200,setHeader(k,v){this.headers[k]=v;},end(v){this.body=v;}};
 await handler({method,url:'/api/pa-workspace-read?path='+encodeURIComponent(route),headers:{authorization:token}},res);return res;
}
const result=r=>JSON.parse(r.body).result;let count=0;
async function check(name,fn){mode='';calls=[];providerCalls=[];queries=[];await fn();count++;console.log('PASS '+name);}
(async()=>{
 await check('Customer address searches both sender and recipient',async()=>{const r=await read('/data/mail-candidates/'+C);assert.equal(r.statusCode,200);assert.equal(queries[0],'{from:customer@example.invalid to:customer@example.invalid}');assert.equal(result(r).auto_selected_thread_id,'candidate');assert.equal(result(r).writes,false);assert(r.headers['Cache-Control'].includes('no-store'));});
 await check('Same customer multiple cases requires Owner selection',async()=>{mode='multiple-cases';const v=result(await read('/data/mail-candidates/'+C));assert.equal(v.matching_case_count,2);assert.equal(v.auto_selected_thread_id,null);});
 for(const m of ['unrelated','wrong-participant','truncated','provider-fail'])await check(m+' never auto-selects',async()=>{mode=m;assert.equal(result(await read('/data/mail-candidates/'+C)).auto_selected_thread_id,null);});
 await check('Foreign linked candidate never reads Provider thread',async()=>{mode='foreign';const v=result(await read('/data/mail-candidates/'+C));assert.equal(v.candidates[0].conflict,true);assert.deepEqual(providerCalls,['search']);});
 await check('Unknown thread preview is read-only and shows all sync inputs',async()=>{const r=await read('/data/mail-thread-preview/'+C+'/candidate');assert.equal(r.statusCode,200);const v=result(r);assert.equal(v.already_linked,false);assert.deepEqual(v.target_missing_ids,['candidate-message']);assert.equal(v.sync_message_count,1);assert.equal(v.preflight_complete,true);assert.equal(v.writes,false);});
 await check('Already linked preview does not duplicate links',async()=>{mode='linked';const v=result(await read('/data/mail-thread-preview/'+C+'/candidate'));assert.equal(v.already_linked,true);assert.equal(v.target_indexed_count,0);assert.equal(v.sync_message_count,1);});
 for(const m of ['foreign','foreign-index','draft'])await check(m+' refuses preview',async()=>{mode=m;assert.equal((await read('/data/mail-thread-preview/'+C+'/candidate')).statusCode,403);if(m==='foreign')assert.equal(providerCalls.length,0);});
 await check('Anonymous, revoked admin, foreign case and POST refuse reads',async()=>{assert.equal((await read('/data/mail-candidates/'+C,'GET','')).statusCode,401);mode='no-admin';assert.equal((await read('/data/mail-candidates/'+C)).statusCode,403);mode='';assert.equal((await read('/data/mail-candidates/'+B)).statusCode,403);assert.equal((await read('/data/mail-candidates/'+C,'POST')).statusCode,405);assert.equal(providerCalls.length,0);});
 await check('Search cannot inject Gmail query operators through email',async()=>{assert.throws(()=>customerQuery('x@example.invalid OR from:anyone'),/customer_email_unavailable/);assert.equal(relatedToCase(inquiry,[{subject:'2026架空まつりの確認'}]),true);assert.equal(relatedToCase(inquiry,[{subject:'別案件'}]),false);assert.equal(chooseCandidate({inquiry,caseIds:[C],candidates:[{gmail_thread_id:'x',related:true,address_match:true,latest_at:'invalid'}]}),null);});
 await check('Existing manualLink performs only one DB read and preserves role',async()=>{
   process.env.SUPABASE_URL='https://fixture.invalid';process.env.SUPABASE_SERVICE_ROLE_KEY='fixture-key-not-a-secret';let reads=0;
   const original={inquiry_id:C,gmail_thread_id:'candidate',conversation_role:'primary_conversation',link_source:'manual',linked_by:C};
   const value=await manualLink({inquiryId:C,gmailThreadId:'candidate',actorId:C},async(url,options)=>{reads++;assert(url.includes('/rest/v1/pa_gmail_thread_links?'));assert.equal(options.method,undefined);return new Response(JSON.stringify([original]));});
   assert.equal(reads,1);assert.equal(value.already_linked,true);assert.deepEqual(value.links,[original]);
   await assert.rejects(()=>manualLink({inquiryId:B,gmailThreadId:'candidate',actorId:B},async()=>new Response(JSON.stringify([original]))),/ambiguous_thread_link/);
 });
 console.log(`PASS ${count}/${count} LOCAL_FIXTURE_ONLY; no Production writes`);
})().catch(e=>{console.error(e);process.exitCode=1;});
