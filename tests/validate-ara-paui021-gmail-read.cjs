'use strict';
const assert=require('node:assert/strict');
const {createReadHandler}=require('../api/_pa-workspace-read.cjs');
const {normalizeMessage}=require('../api/_pa-gmail.cjs');
const C='11111111-1111-4111-8111-111111111111',OTHER='22222222-2222-4222-8222-222222222222';
const bytes=Buffer.from('%PDF-1.4\nfixture\n%%EOF'),token='Bearer '+'fixture-only-'.repeat(4);
let mode='',calls=[],providerCalls=0;
const attachment={id:'attachment+=',part_id:'1',filename:'見積書 日本語.pdf',mime_type:'application/pdf',size:bytes.length};
function raw(){return {id:'mail1',threadId:mode==='provider-thread'?'foreign':'thread1',labelIds:mode==='not-sent'?[]:['SENT'],internalDate:'1791500000000',payload:{headers:[{name:'From',value:'aratechsound@gmail.com'},{name:'To',value:'fixture@example.invalid'},{name:'Subject',value:'見積履歴'}],parts:[{mimeType:'text/plain',body:{data:Buffer.from(mode==='empty'?'':'新規本文\n> 引用').toString('base64url')}},{mimeType:'application/pdf',filename:'見積書 日本語.pdf',partId:'1',body:{attachmentId:'attachment+=',size:bytes.length}}]}};}
const provider={normalize:normalizeMessage,message:async()=>{providerCalls++;if(mode==='provider-denied')throw Error('gmail_read_403');if(mode==='provider-missing')throw Error('gmail_read_404');return raw();},thread:async()=>{providerCalls++;return {id:'thread1',messages:[raw()]};},attachment:async()=>{providerCalls++;return {bytes:mode==='bad-file'?Buffer.from('bad'):bytes,mime:'application/pdf'};}};
async function fetchImpl(url,options){calls.push({url,options});const q=new URL(url),table=q.pathname.split('/').at(-1);let data=[];
 if(q.pathname==='/auth/v1/user')data={id:C};
 else if(table==='work_admins')data=mode==='no-admin'?[]:[{user_id:C}];
 else if(table==='pa_inquiries')data=q.searchParams.get('id')==='eq.'+C?[{id:C}]:[];
 else if(table==='pa_gmail_thread_links')data=[{inquiry_id:mode==='ambiguous'&&q.searchParams.has('gmail_thread_id')?OTHER:C,gmail_thread_id:'thread1'}];
 else if(table==='pa_gmail_message_index')data=mode==='unindexed'?[]:[{inquiry_id:mode==='index-conflict'?OTHER:C,gmail_message_id:'mail1',gmail_thread_id:'thread1',snippet:'抜粋のみ',attachment_metadata:mode==='no-attachments'?[]:[attachment]}];
 return new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}});
}
const handler=createReadHandler({key:'sb_publishable_fixture',fetchImpl,provider});
async function read(path,headers={}){const res={statusCode:200,headers:{},setHeader(k,v){this.headers[k]=v;},end(v){this.body=v;}};await handler({method:'GET',url:'/api/pa-workspace-read?path='+encodeURIComponent(path),headers:{authorization:token,...headers}},res);return res;}
let passed=0;
async function check(name,fn){mode='';const before=providerCalls;await fn(before);passed++;console.log('PASS '+name);}
(async()=>{
 await check('Owner read-through returns full body, not snippet',async()=>{const r=await read('/data/mail-body/'+C+'/mail1');assert.equal(r.statusCode,200);const b=JSON.parse(r.body).result;assert.equal(b.source,'gmail');assert.equal(b.body_text,'新規本文\n> 引用');});
 await check('Empty Provider body is successful empty, not unavailable',async()=>{mode='empty';const r=await read('/data/mail-body/'+C+'/mail1');assert.equal(JSON.parse(r.body).result.body_state,'empty');});
 await check('Provider refusal and missing original remain distinct',async()=>{mode='provider-denied';assert.equal((await read('/data/mail-body/'+C+'/mail1')).statusCode,403);mode='provider-missing';assert.equal((await read('/data/mail-body/'+C+'/mail1')).statusCode,404);});
 await check('Foreign case has no Provider reads',async before=>{assert.equal((await read('/data/mail-body/'+OTHER+'/mail1')).statusCode,403);assert.equal(providerCalls,before);});
 await check('Revoked Owner has no Provider reads',async before=>{mode='no-admin';assert.equal((await read('/data/mail-body/'+C+'/mail1')).statusCode,403);assert.equal(providerCalls,before);});
 await check('Ambiguous thread denied before Provider',async before=>{mode='ambiguous';assert.equal((await read('/data/mail-body/'+C+'/mail1')).statusCode,403);assert.equal(providerCalls,before);});
 await check('Fresh message/thread mismatch denied',async()=>{mode='provider-thread';assert.equal((await read('/data/mail-body/'+C+'/mail1')).statusCode,403);});
 await check('Opaque attachment ID and Japanese filename retained',async()=>{const r=await read('/data/mail-attachment/'+C+'/mail1/attachment%2B%3D');assert.equal(r.statusCode,200);assert(r.body.equals(bytes));});
 await check('No attachments and wrong ID cannot access Provider',async before=>{mode='no-attachments';assert.equal((await read('/data/mail-attachment/'+C+'/mail1/attachment%2B%3D')).statusCode,403);assert.equal(providerCalls,before);});
 await check('Corrupt PDF refused',async()=>{mode='bad-file';assert.equal((await read('/data/mail-attachment/'+C+'/mail1/attachment%2B%3D')).statusCode,409);});
 await check('Unindexed Gmail SENT estimates included as history only',async()=>{mode='unindexed';const r=await read('/data/sent-estimates/'+C);assert.equal(r.statusCode,200);const s=JSON.parse(r.body).result;assert.equal(s.messages.length,1);assert.equal(s.messages[0].registration,'unverified');assert.equal(s.messages[0].validity,'unknown');assert.equal(s.messages[0].attachment_metadata[0].filename,'見積書 日本語.pdf');});
 await check('Non-SENT mail excluded',async()=>{mode='not-sent';assert.equal(JSON.parse((await read('/data/sent-estimates/'+C)).body).result.messages.length,0);});
 await check('Index conflict stays explicitly unknown',async()=>{mode='index-conflict';const s=JSON.parse((await read('/data/sent-estimates/'+C)).body).result;assert.equal(s.messages.length,0);assert.equal(s.unknown[0].code,'mail_index_conflict');});
 await check('Unindexed history PDF uses exact bound Provider original',async()=>{mode='unindexed';const r=await read('/data/sent-estimate-attachment/'+C+'/mail1/attachment%2B%3D');assert.equal(r.statusCode,200);assert(r.body.equals(bytes));});
 await check('Ambiguous history has zero Provider access',async before=>{mode='ambiguous';const s=JSON.parse((await read('/data/sent-estimates/'+C)).body).result;assert.equal(s.messages.length,0);assert.equal(s.unknown[0].code,'ambiguous_thread_binding');assert.equal(providerCalls,before);});
 await check('All DB requests retain Owner JWT, public key and GET; no DML/RPC',async()=>{assert(calls.every(c=>c.options.method==='GET'&&c.options.headers.authorization===token&&c.options.headers.apikey==='sb_publishable_fixture'&&!c.url.includes('/rpc/')));});
 console.log('PASS '+passed+'/'+passed+' LOCAL_FIXTURE_ONLY');
})().catch(e=>{console.error(e);process.exitCode=1;});


