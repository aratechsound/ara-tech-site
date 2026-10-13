'use strict';
const assert=require('node:assert/strict'),http=require('node:http'),crypto=require('node:crypto'),fs=require('node:fs');
const {createReadHandler}=require('../api/_pa-workspace-read.cjs');
const C='11111111-1111-4111-8111-111111111111',A='22222222-2222-4222-8222-222222222222',P='33333333-3333-4333-8333-333333333333',D='44444444-4444-4444-8444-444444444444';
const token='Bearer '+'fixture-only-'.repeat(4),bytes=Buffer.from('%PDF-1.4\nfixture\n%%EOF'),sha=crypto.createHash('sha256').update(bytes).digest('hex');
let mode='',calls=[],tests=[];
const json=(v,status=200)=>new Response(JSON.stringify(v),{status,headers:{'content-type':'application/json'}});
async function mocked(url,opts){
 calls.push({url,method:opts.method,token:opts.headers.authorization,key:opts.headers.apikey});const q=new URL(url),table=q.pathname.split('/').at(-1);
 if(q.pathname==='/auth/v1/user')return mode==='expired'?json({},401):json({id:C});
 if(table==='work_admins')return json(mode==='not-admin'?[]:[{user_id:C}]);
 if(table==='pa_inquiries')return json(q.searchParams.get('id')&&q.searchParams.get('id')!=='eq.'+C?[]:[{id:C}]);
 if(table==='pa_case_progress'||table==='pa_case_mail_attention')return json([]);
 if(table==='pa_gmail_thread_links')return json([{inquiry_id:C,gmail_thread_id:'thread1'}]);
 if(table==='pa_gmail_message_index')return json([{inquiry_id:mode==='foreign-case'?A:C,gmail_thread_id:mode==='foreign-thread'?'thread2':'thread1',gmail_message_id:'message1',body_text:mode==='no-body'?'':'保存済み本文',attachment_metadata:[{id:'attach1',filename:'日本語.pdf',mime_type:'application/pdf',size:bytes.length}]}]);
 if(table==='pa_portals')return mode==='portal-acl'?json({},403):json([{id:P,case_id:mode==='foreign-portal'?A:C}]);
 if(table==='pa_portal_document_cards')return json([{id:D,portal_id:P,current_version_id:A}]);
 if(table==='pa_portal_document_versions')return json([{id:A,card_id:D,source_type:'portal_upload',mime_type:'application/pdf',source_ref:{storage_path:`cases/${C}/${A}/${sha}`,sha256:sha,size:bytes.length}}]);
 if(q.pathname.startsWith('/storage/'))return mode==='storage-acl'?json({},403):new Response(mode==='bad-storage'?Buffer.from('bad'):bytes);
 if(table==='pa_commercial_documents')return mode==='commercial-acl'?json({},403):json([{id:D,inquiry_id:mode==='foreign-document'?A:C,mime_type:'application/pdf',content:'\\x'+bytes.toString('hex'),sha256:mode==='bad-hash'?'0'.repeat(64):sha}]);
 if(['pa_estimate_revisions','pa_contract_offers','pa_billings'].includes(table))return json([]);
 return json([]);
}
(async()=>{
 const server=http.createServer(createReadHandler({fetchImpl:mocked}));await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;
 const send=(p,options={})=>fetch(`http://127.0.0.1:${port}/api/pa-workspace-read?path=`+encodeURIComponent(p),{...options,headers:{authorization:token,...options.headers}});
 const check=async(name,fn)=>{mode='';await fn();tests.push({name,status:'PASS'});};
 try{
  await check('No bearer has zero upstream calls',async()=>{const n=calls.length;assert.equal((await send('/data/cases',{headers:{authorization:''}})).status,401);assert.equal(calls.length,n);});
  await check('Every write verb stopped before upstream',async()=>{for(const method of ['POST','PUT','PATCH','DELETE']){const n=calls.length;assert.equal((await send('/data/cases',{method})).status,405);assert.equal(calls.length,n);}});
  await check('Expired auth and revoked administrator fail closed',async()=>{mode='expired';assert.equal((await send('/data/cases')).status,401);mode='not-admin';const r=await send('/data/cases');assert.equal(r.status,403);assert.equal((await r.json()).code,'admin_required');});
  await check('Same-origin and route allowlist enforced',async()=>{assert.equal((await send('/data/cases',{headers:{'sec-fetch-site':'cross-site'}})).status,403);assert.equal((await send('/data/cases',{headers:{origin:'https://outside.invalid'}})).status,403);assert.equal((await send('/rest/v1/rpc/send')).status,403);});
  await check('Cases use existing tables and Owner JWT',async()=>{assert.equal((await send('/data/cases')).status,200);});
  await check('Foreign case refused before document read',async()=>{assert.equal((await send('/data/document/'+A+'/'+D)).status,403);});
  await check('Case to mail to thread attribution',async()=>{assert.equal((await send('/data/mail/'+C)).status,200);mode='foreign-case';assert.equal((await send('/data/mail/'+C)).status,403);mode='foreign-thread';assert.equal((await send('/data/mail/'+C)).status,403);});
  await check('Saved body works; missing body is 503',async()=>{assert.equal((await send('/data/mail-body/'+C+'/message1')).status,200);mode='no-body';assert.equal((await send('/data/mail-body/'+C+'/message1')).status,503);});
  await check('Missing Gmail configuration returns explicit 503 without Provider fallback',async()=>{const r=await send('/data/mail-attachment/'+C+'/message1/attach1');assert.equal(r.status,503);assert.equal((await r.json()).code,'gmail_not_configured');assert(!calls.some(c=>/gmail.googleapis|oauth2/.test(c.url)));});
  await check('Foreign message and attachment rejected',async()=>{assert.equal((await send('/data/mail-attachment/'+C+'/message2/attach1')).status,403);assert.equal((await send('/data/mail-attachment/'+C+'/message1/attach2')).status,403);});
  await check('Commercial metadata ACL denial remains 403',async()=>{mode='commercial-acl';assert.equal((await send('/data/commercial/'+C)).status,403);});
  await check('Commercial projection does not infer sent or accepted',async()=>{const r=await(await send('/data/commercial/'+C)).json();assert.equal(r.result.read_projection,true);assert(!calls.some(c=>/pa_contract_tokens|pa_commercial_outbox/.test(c.url)));});
  await check('Commercial original exact case hash and magic',async()=>{const r=await send('/data/document/'+C+'/'+D);assert.equal(r.status,200);assert(Buffer.from(await r.arrayBuffer()).equals(bytes));mode='bad-hash';assert.equal((await send('/data/document/'+C+'/'+D)).status,409);mode='foreign-document';assert.equal((await send('/data/document/'+C+'/'+D)).status,403);});
  await check('Portal ACL and parent binding',async()=>{mode='portal-acl';assert.equal((await send('/data/materials/'+C)).status,403);mode='foreign-portal';assert.equal((await send('/data/materials/'+C)).status,403);});
  await check('Private storage Owner JWT and SHA256',async()=>{assert.equal((await send('/data/material/'+C+'/version/'+A)).status,200);mode='bad-storage';assert.equal((await send('/data/material/'+C+'/version/'+A)).status,409);});
  await check('Storage ACL denial makes one attempt with no fallback',async()=>{mode='storage-acl';const n=calls.filter(x=>x.url.includes('/storage/')).length;assert.equal((await send('/data/material/'+C+'/version/'+A)).status,403);assert.equal(calls.filter(x=>x.url.includes('/storage/')).length,n+1);});
  await check('No business RPC, privileged key or mutation upstream',async()=>{assert(calls.every(c=>c.method==='GET'&&c.token===token&&c.key.startsWith('sb_publishable_')));assert(!calls.some(c=>c.url.includes('/rpc/')));});
 }finally{await new Promise(r=>server.close(r));}
 fs.writeFileSync(process.env.PAUI015_TEST_OUTPUT||'paui015-read-results.json',JSON.stringify({scope:'ANONYMOUS_FIXTURE',tests,passed:tests.length,upstream_business_writes:0},null,2));console.log(`PASS ${tests.length}/${tests.length}`);
})().catch(e=>{console.error(e);process.exitCode=1;});
