'use strict';
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const {createReadHandler}=require('../api/_pa-workspace-read.cjs');
const {createProvider}=require('../api/_pa-workspace-gmail.cjs');
const {canonicalAssetKey}=require('../api/_pa-portal-candidates.cjs');
const C='11111111-1111-4111-8111-111111111111',P='22222222-2222-4222-8222-222222222222',OTHER='33333333-3333-4333-8333-333333333333';
const ids=[1,2,3,4].map(n=>`44444444-4444-4444-8444-${String(n).padStart(12,'0')}`);
const token='Bearer '+'fixture-only-'.repeat(4),hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const files=[Buffer.from('%PDF-1.4\nplan-A\n%%EOF'),Buffer.from('%PDF-1.4\nplan-B\n%%EOF'),Buffer.from([255,216,1,2,255,217]),Buffer.from([255,216,3,4,255,217])];
const names=['venue.pdf','power.pdf','camera.jpg','reference.jpg'];
const fields=['gmail_part_id','canonical_attachment_key','source_content_sha256','source_byte_size'];
let mode='',dbCalls=[],gmailCalls=[],assets,attachments;
function reset(){
  mode='';dbCalls=[];gmailCalls=[];
  attachments=files.map((bytes,i)=>({id:'indexed-'+i,gmail_attachment_id:'indexed-'+i,part_id:String(i+1),filename:names[i],mime_type:i<2?'application/pdf':'image/jpeg',size:bytes.length}));
  assets=attachments.map((a,i)=>({id:ids[i],card_id:P,portal_id:P,source_type:'gmail_attachment',source_ref:{gmail_message_id:'mail1',gmail_attachment_id:'historical-'+i},display_filename:a.filename,mime_type:a.mime_type,gmail_part_id:a.part_id,canonical_attachment_key:canonicalAssetKey('mail1',a.part_id),source_byte_size:a.size,source_content_sha256:hash(files[i])}));
}
function raw(){return {id:mode==='foreign-raw-id'?'mail2':'mail1',threadId:mode==='foreign-raw-thread'?'thread2':'thread1',payload:{parts:attachments.map((a,i)=>({partId:a.part_id,filename:a.filename,mimeType:a.mime_type,body:{attachmentId:'fresh-'+i,size:a.size}}))}};}
const provider=createProvider(async(url,options={})=>{
  gmailCalls.push({url,method:options.method||'GET'});
  let result;
  if(url==='https://oauth2.googleapis.com/token')result={access_token:'fixture-only'};
  else if(url.endsWith('/profile'))result={emailAddress:'aratechsound@gmail.com'};
  else if(url.includes('/attachments/')){
    if(mode==='original-denied')return new Response('{}',{status:403});
    if(mode==='original-missing')return new Response('{}',{status:404});
    const id=decodeURIComponent(url.split('/').at(-1)),n=Number(id.split('-').at(-1));
    result={data:(mode==='wrong-bytes'&&id.startsWith('fresh-')?Buffer.from('%PDF-1.4\nwrong!\n%%EOF'):files[n]||files[0]).toString('base64url')};
  }else result=raw();
  return new Response(JSON.stringify(result));
});
async function fetchImpl(url,options){
  dbCalls.push({url,options});const q=new URL(url),table=q.pathname.split('/').at(-1);let data=[];
  if(mode==='acl-denied'&&table==='pa_portal_document_versions')return new Response('{}',{status:403});
  if(q.pathname==='/auth/v1/user')data={id:C};
  else if(table==='work_admins')data=mode==='no-admin'?[]:[{user_id:C}];
  else if(table==='pa_inquiries')data=q.searchParams.get('id')==='eq.'+C?[{id:C}]:[];
  else if(table==='pa_portals')data=[{id:P,case_id:C}];
  else if(table==='pa_portal_document_cards')data=[{id:P,portal_id:P}];
  else if(table==='pa_portal_document_versions'||table==='pa_portal_photo_items'){
    const selected=q.searchParams.get('select').split(',');
    // Model SELECT accurately: omitted identity fields must not reach resolver.
    data=assets.slice(table.endsWith('versions')?0:2,table.endsWith('versions')?2:4).map(a=>Object.fromEntries(Object.entries(a).filter(([k])=>selected.includes(k))));
  }else if(table==='pa_gmail_thread_links')data=[{inquiry_id:mode==='foreign-owner'&&q.searchParams.has('gmail_thread_id')?OTHER:C,gmail_thread_id:'thread1'}];
  else if(table==='pa_gmail_message_index')data=[{inquiry_id:C,gmail_message_id:'mail1',gmail_thread_id:'thread1',attachment_metadata:attachments}];
  return new Response(JSON.stringify(data));
}
const handler=createReadHandler({key:'sb_publishable_fixture',fetchImpl,provider});
async function read(index=0,{caseId=C,route='material',auth=token,attachmentId='unknown'}={}){
  const path=route==='material'?`/data/material/${caseId}/${index<2?'version':'photo'}/${ids[index]}`:`/data/mail-attachment/${caseId}/mail1/${attachmentId}`;
  const res={statusCode:200,headers:{},setHeader(k,v){this.headers[k]=v;},end(body){this.body=body;}};
  await handler({method:'GET',url:'/api/pa-workspace-read?path='+encodeURIComponent(path),headers:{authorization:auth}},res);return res;
}
function legacy(){for(const f of fields)delete assets[0][f];}
let passed=0;
async function test(name,fn){reset();await fn();passed++;console.log('PASS '+name);}
async function status(expected,index=0,options){const r=await read(index,options);assert.equal(r.statusCode,expected,String(r.body));return r;}
(async()=>{
 const keys=['GMAIL_CLIENT_ID','GMAIL_CLIENT_SECRET','GMAIL_REFRESH_TOKEN','GMAIL_SENDER_ADDRESS','GMAIL_REPLY_TO'];const saved=keys.map(k=>process.env[k]);keys.forEach(k=>process.env[k]=k.endsWith('ADDRESS')||k.endsWith('TO')?'fixture@example.invalid':'fixture-only');
 try{
  await test('Four independent registered originals: PDF x2 JPEG x2, stale IDs resolved without writes',async()=>{for(let i=0;i<4;i++){const r=await status(200,i);assert(r.body.equals(files[i]));const proof=JSON.parse(r.headers['X-PA-Attachment-Identity']);assert.equal(proof.method,'registered_message_part');assert.equal(proof.indexed_id_equal,false);assert.equal(proof.sha256_verified,true);}assert(dbCalls.filter(c=>/versions|photo_items/.test(c.url)).every(c=>fields.every(f=>new URL(c.url).searchParams.get('select').includes(f))));});
  await test('Exact indexed ID retains all part canonical size and hash guards',async()=>{assets[0].source_ref.gmail_attachment_id=attachments[0].id;assert.equal(JSON.parse((await status(200)).headers['X-PA-Attachment-Identity']).method,'indexed_attachment');});
  await test('Stored part alone resolves changed ID',async()=>{delete assets[0].canonical_attachment_key;delete assets[0].source_content_sha256;await status(200);});
  await test('Stored canonical key alone resolves exact message part',async()=>{delete assets[0].gmail_part_id;await status(200);});
  await test('Registered historical bytes plus SHA resolve legacy row',async()=>{legacy();const r=await status(200);assert.equal(JSON.parse(r.headers['X-PA-Attachment-Identity']).method,'same_message_sha256');assert(gmailCalls.some(c=>c.url.endsWith('/historical-0')));});
  await test('Stored SHA resolves legacy ID without loading historical alias',async()=>{legacy();assets[0].source_content_sha256=hash(files[0]);await status(200);assert(!gmailCalls.some(c=>c.url.includes('/historical-')));});
  await test('Names never participate in selection',async()=>{attachments[0].filename='different-name.pdf';await status(200);});
  await test('Same name and size different bytes are rejected',async()=>{legacy();attachments[0].filename=attachments[1].filename;mode='wrong-bytes';await status(409);});
  await test('Same-name multiple attachments cannot be arbitrarily adopted',async()=>{legacy();attachments[1]={...attachments[0],id:'indexed-1',part_id:'2'};files[1]=Buffer.from(files[0]);try{const r=await status(409);assert.equal(JSON.parse(r.body).code,'attachment_identity_ambiguous');}finally{files[1]=Buffer.from('%PDF-1.4\nplan-B\n%%EOF');}});
  await test('Distinct same-name files require one exact content hash',async()=>{legacy();attachments[1].filename=attachments[0].filename;await status(200);});
  await test('Conflicting stored part and canonical key rejected',async()=>{assets[0].gmail_part_id='2';await status(403);});
  await test('Exact ID cannot override a conflicting part',async()=>{assets[0].source_ref.gmail_attachment_id=attachments[0].id;assets[0].gmail_part_id='2';await status(409);});
  await test('Wrong canonical key from another message rejected',async()=>{assets[0].canonical_attachment_key=canonicalAssetKey('mail2','1');await status(403);});
  await test('Stored SHA mismatch rejected even with exact part',async()=>{assets[0].source_content_sha256='0'.repeat(64);await status(409);});
  await test('Malformed stored SHA cannot be ignored',async()=>{assets[0].source_content_sha256='invalid';await status(409);});
  await test('Stored size mismatch rejected',async()=>{assets[0].source_byte_size++;await status(409);});
  await test('Stored MIME mismatch rejected',async()=>{assets[0].mime_type='image/jpeg';await status(409);});
  await test('Duplicate indexed part is ambiguous',async()=>{attachments[1].part_id='1';delete assets[0].source_content_sha256;await status(409);});
  await test('Duplicate exact attachment ID is ambiguous',async()=>{assets[0].source_ref.gmail_attachment_id=attachments[0].id;attachments[1].id=attachments[0].id;await status(409);});
  await test('Provider ID pointing to different part rejected',async()=>{attachments[0].id='fresh-1';await status(409);});
  await test('Foreign case denied before Provider',async()=>{await status(403,0,{caseId:OTHER});assert.equal(gmailCalls.length,0);});
  await test('Foreign registered message denied before Provider',async()=>{assets[0].source_ref.gmail_message_id='mail2';await status(403);assert.equal(gmailCalls.length,0);});
  await test('Thread owned by different case denied before Provider',async()=>{mode='foreign-owner';await status(403);assert.equal(gmailCalls.length,0);});
  await test('Fresh Provider message mismatch denied',async()=>{mode='foreign-raw-id';await status(403);assert(!gmailCalls.some(c=>c.url.includes('/attachments/')));});
  await test('Fresh Provider thread mismatch denied',async()=>{mode='foreign-raw-thread';await status(403);assert(!gmailCalls.some(c=>c.url.includes('/attachments/')));});
  await test('Anonymous 401 retains boundary',async()=>{await status(401,0,{auth:''});assert.equal(dbCalls.length,0);assert.equal(gmailCalls.length,0);});
  await test('Revoked admin 403 retains boundary',async()=>{mode='no-admin';await status(403);assert.equal(gmailCalls.length,0);});
  await test('DB ACL 403 never triggers alternate credentials',async()=>{mode='acl-denied';await status(403);assert.equal(gmailCalls.length,0);});
  await test('Gmail original denied is 403',async()=>{mode='original-denied';await status(403);});
  await test('Gmail original unavailable is 404',async()=>{mode='original-missing';await status(404);});
  await test('Public arbitrary historical ID remains rejected',async()=>{await status(403,0,{route:'mail',attachmentId:'historical-0'});assert.equal(gmailCalls.length,0);});
  await test('All DB operations remain Owner JWT GET, no RPC or DML',async()=>{legacy();await status(200);assert(dbCalls.every(c=>c.options.method==='GET'&&c.options.headers.authorization===token&&c.options.headers.apikey==='sb_publishable_fixture'&&!c.url.includes('/rpc/')));assert(gmailCalls.every(c=>c.url==='https://oauth2.googleapis.com/token'?c.method==='POST':c.method==='GET'&&c.url.startsWith('https://gmail.googleapis.com/')));});
 }finally{keys.forEach((k,i)=>saved[i]===undefined?delete process.env[k]:process.env[k]=saved[i]);}
 console.log(`PASS ${passed}/${passed} LOCAL_FIXTURE_ONLY; REAL_ORIGINALS_SEPARATE`);
})().catch(e=>{console.error(e);process.exitCode=1;});
