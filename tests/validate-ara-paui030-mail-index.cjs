'use strict';
const assert=require('node:assert/strict');
const {createReadHandler}=require('../api/_pa-workspace-read.cjs');
const {normalizeMessage}=require('../api/_pa-gmail.cjs');
const C='11111111-1111-4111-8111-111111111111',OTHER='22222222-2222-4222-8222-222222222222';
const bytes=Buffer.from('%PDF-1.4 fixture'),token='Bearer fixture-only-long-token-000000';
let mode='',calls=[],reads=0;
const saved=[{inquiry_id:C,gmail_thread_id:'thread1',gmail_message_id:'old',direction:'inbound',received_at:'2026-09-17T00:00:00Z',indexed_at:'2026-10-14T00:00:00Z'},
 {inquiry_id:C,gmail_thread_id:'thread1',gmail_message_id:'recent',direction:'outbound',sent_at:'2026-10-10T00:00:00Z',indexed_at:'2026-10-10T00:00:00Z'}];
function raw(id){return {id,threadId:mode==='wrong-thread'?'foreign':'thread1',internalDate:String(Date.parse(id==='late'?'2026-10-13T21:36:01+09:00':'2026-10-13T13:55:26+09:00')),labelIds:['INBOX','UNREAD'],payload:{headers:[{name:'From',value:'fixture@example.invalid'},{name:'Subject',value:'架空の確認'}],parts:[{mimeType:'text/plain',body:{data:Buffer.from('<script>fixture</script>本文').toString('base64url')}},{partId:'1',filename:'fixture.pdf',mimeType:'application/pdf',body:{attachmentId:'current-id',size:bytes.length}}]}};}
const handler=createReadHandler({key:'sb_publishable_fixture',provider:{normalize:normalizeMessage,message:async id=>{reads++;return raw(id);},thread:async id=>{reads++;if(mode==='denied')throw Error('gmail_read_403');if(mode==='failed')throw Error('gmail_read_500');return {id,messages:mode==='empty'?[]:mode==='duplicate-raw'?[raw('early'),raw('early')]:[raw('early'),raw('late')]};},attachment:async({metadata})=>{reads++;assert.equal(metadata.id,'current-id');return {bytes:mode==='bad-file'?Buffer.from('bad'):bytes,mime:'application/pdf'};}},fetchImpl:async(url,options)=>{
 calls.push({url,options});assert.equal(options.method,'GET');const q=new URL(url),table=q.pathname.split('/').at(-1);let data=[];
 if(q.pathname==='/auth/v1/user')data={id:C};else if(table==='work_admins')data=mode==='no-admin'?[]:[{user_id:C}];
 else if(table==='pa_inquiries')data=q.searchParams.get('id')==='eq.'+C?[{id:C}]:[];
 else if(table==='pa_gmail_thread_links')data=mode==='no-links'?[]:[{inquiry_id:mode==='foreign-owner'&&q.searchParams.has('gmail_thread_id')?OTHER:C,gmail_thread_id:'thread1'}];
 else if(table==='pa_gmail_message_index'){
   if(q.searchParams.has('inquiry_id'))data=mode==='no-links'||mode==='empty'?[]:saved;
   else if(mode==='foreign-index')data=[{inquiry_id:OTHER,gmail_thread_id:'thread1',gmail_message_id:'early'}];
   else if(mode==='duplicate-index')data=[1,2].map(()=>({inquiry_id:C,gmail_thread_id:'thread1',gmail_message_id:'early'}));
   else if(mode==='all-indexed')data=['early','late'].map(gmail_message_id=>({inquiry_id:C,gmail_thread_id:'thread1',gmail_message_id}));
 }
 return new Response(JSON.stringify(data));
}});
async function read(path,method='GET',authorization=token){const res={statusCode:200,headers:{},setHeader(k,v){this.headers[k]=v;},end(body){this.body=body;}};await handler({method,url:'/api/pa-workspace-read?path='+encodeURIComponent(path),headers:{authorization}},res);return res;}
const result=r=>JSON.parse(r.body).result;let passed=0;
async function check(name,fn){mode='';reads=0;calls=[];await fn();passed++;console.log('PASS '+name);}
(async()=>{
 await check('Saved mail sorts by occurrence, never reindex time',async()=>assert.deepEqual(result(await read('/data/mail/'+C)).map(m=>m.gmail_message_id),['recent','old']));
 await check('Linked unindexed incoming messages display newest first, without persistence',async()=>{const r=await read('/data/mail-live/'+C);assert.equal(r.statusCode,200);const v=result(r);assert.equal(v.status,'index_gap');assert.deepEqual(v.messages.slice(0,2).map(m=>m.gmail_message_id),['late','early']);assert(v.messages.slice(0,2).every(m=>m.index_state==='not_indexed'&&m.read_route==='live'&&m.indexed_at===null));assert.equal(v.messages[0].attachment_metadata[0].id,'1');assert.equal(v.unlinked_status,'not_checked');assert.equal(v.writes,false);});
 await check('No approved links never calls Gmail or claims no new mail',async()=>{mode='no-links';const v=result(await read('/data/mail-live/'+C));assert.equal(v.status,'no_thread_links');assert.equal(reads,0);assert.equal(v.unlinked_status,'not_checked');});
 await check('Foreign thread ownership refuses Provider reads',async()=>{mode='foreign-owner';const v=result(await read('/data/mail-live/'+C));assert.equal(v.status,'partial_unknown');assert.equal(v.checks[0].code,'mail_binding_mismatch');assert.equal(reads,0);assert.equal(v.messages.length,2);});
 for(const m of ['foreign-index','duplicate-index','duplicate-raw','wrong-thread'])await check(m+' rejects fresh projection',async()=>{mode=m;const v=result(await read('/data/mail-live/'+C));assert.equal(v.status,'partial_unknown');assert(!v.messages.some(m=>m.read_route==='live'));});
 for(const m of ['denied','failed'])await check(m+' preserves saved rows and UNKNOWN',async()=>{mode=m;const v=result(await read('/data/mail-live/'+C));assert.equal(v.status,'partial_unknown');assert.equal(v.checks[0].code,m==='denied'?'provider_read_denied':'provider_read_failed');assert.equal(v.messages.length,2);});
 await check('Complete linked check distinguished from mailbox latest',async()=>{mode='all-indexed';const v=result(await read('/data/mail-live/'+C));assert.equal(v.status,'linked_threads_current');assert.equal(v.unlinked_status,'not_checked');});
 await check('Successful empty linked thread distinct from failure',async()=>{mode='empty';const v=result(await read('/data/mail-live/'+C));assert.equal(v.status,'linked_threads_current');assert.equal(v.checks[0].provider_count,0);});
 await check('Unindexed full body uses exclusive DB thread and fresh Provider identity',async()=>{const r=await read('/data/mail-live-body/'+C+'/thread1/early');assert.equal(r.statusCode,200);assert.equal(result(r).body_text,'<script>fixture</script>本文');assert.equal(result(r).source,'gmail');});
 await check('Fresh stable MIME part retrieves exact unindexed PDF',async()=>{const r=await read('/data/mail-live-attachment/'+C+'/thread1/early/1');assert.equal(r.statusCode,200);assert(r.body.equals(bytes));});
 await check('Corrupt live PDF fails magic/size verification',async()=>{mode='bad-file';assert.equal((await read('/data/mail-live-attachment/'+C+'/thread1/early/1')).statusCode,409);});
 await check('Unknown attachment never reads binary',async()=>{assert.equal((await read('/data/mail-live-attachment/'+C+'/thread1/early/unknown')).statusCode,403);assert.equal(reads,1);});
 await check('Unlinked arbitrary body has no Provider access',async()=>{mode='no-links';assert.equal((await read('/data/mail-live-body/'+C+'/thread1/early')).statusCode,403);assert.equal(reads,0);});
 await check('Foreign case and revoked Owner never read Provider',async()=>{assert.equal((await read('/data/mail-live/'+OTHER)).statusCode,403);mode='no-admin';assert.equal((await read('/data/mail-live/'+C)).statusCode,403);assert.equal(reads,0);});
 await check('Live body index collision denied before Provider',async()=>{mode='foreign-index';assert.equal((await read('/data/mail-live-body/'+C+'/thread1/early')).statusCode,403);assert.equal(reads,0);});
 await check('POST and anonymous request rejected',async()=>{assert.equal((await read('/data/mail-live/'+C,'POST')).statusCode,405);assert.equal((await read('/data/mail-live/'+C,'GET','')).statusCode,401);assert.equal(reads,0);});
 await check('JWT/RLS/GET boundary and private no-store headers',async()=>{const r=await read('/data/mail-live/'+C);assert(calls.every(c=>c.options.method==='GET'&&c.options.headers.authorization===token&&!c.url.includes('/rpc/')));assert(r.headers['Cache-Control'].includes('no-store'));});
 await check('Unindexed mail cannot infer NEW from case flag',async()=>{const {messageAttention}=await import('../pa-ui/js/mail-model.mjs');const row={direction:'inbound',received_at:'2026-10-13T00:00:00Z',index_state:'not_indexed'};assert.equal(messageAttention(row,{attention_state:'new_customer_reply',last_seen_inbound_at:row.received_at},[row]),false);});
 console.log(`PASS ${passed}/${passed} LOCAL_FIXTURE_ONLY`);
})().catch(e=>{console.error(e);process.exitCode=1;});
