'use strict';
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const {createReadHandler}=require('../api/_pa-workspace-read.cjs');
const {createProvider}=require('../api/_pa-workspace-gmail.cjs');
const {canonicalAssetKey}=require('../api/_pa-portal-candidates.cjs');
const A='11111111-1111-4111-8111-111111111111',P='22222222-2222-4222-8222-222222222222',D='33333333-3333-4333-8333-333333333333',B='44444444-4444-4444-8444-444444444444';
const auth='Bearer '+'fixture-only-'.repeat(4),sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const files=[['台本.pdf','application/pdf',Buffer.from('%PDF-1.4\nfixture\n%%EOF')],['日本語の音源.mp3','audio/mpeg',Buffer.from('ID3\x04\0\0synthetic audio')],['効果音.wav','audio/wav',Buffer.from('RIFF0000WAVEfixture')],...['zip','xlsx','docx','pptx'].map(x=>['資料.'+x,({zip:'application/zip',xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',pptx:'application/vnd.openxmlformats-officedocument.presentationml.presentation'})[x],Buffer.from('PK\x03\x04opaque-'+x)]),['一覧.csv','text/csv',Buffer.from('名前,値\n架空,1\n')],['画像.png','image/png',Buffer.from([137,80,78,71,13,10,26,10,0])],['安全確認.html','text/html',Buffer.from('<script>globalThis.pwned=true</script>')],['その他.bin','application/octet-stream',Buffer.from([0,255,20,1])]];
let mode='',calls=[],reads=0,active=0;
function meta(i){const [filename,mime_type,bytes]=files[i];return {id:'att'+i,part_id:String(i+1),gmail_attachment_id:'att'+i,filename,mime_type,size:bytes.length,sha256:sha(bytes)};}
function raw(id){return {id,threadId:mode==='wrong-thread'?'other':'thread1',labelIds:id==='sent'?['SENT']:['INBOX'],payload:{parts:files.map((f,i)=>({filename:f[0],mimeType:f[1],partId:String(i+1),body:{attachmentId:'att'+i,size:f[2].length}}))}};}
const provider=createProvider(async(url,options={})=>{calls.push({url,method:options.method||'GET'});if(url==='https://oauth2.googleapis.com/token')return Response.json({access_token:'fixture'});if(url.endsWith('/profile'))return Response.json({emailAddress:'aratechsound@gmail.com'});if(url.includes('/attachments/')){const i=Number(url.split('/').at(-1).slice(3));return Response.json({data:files[i][2].toString('base64url')});}return Response.json(raw(url.includes('/messages/sent')?'sent':'received'));});
async function fetchImpl(url,options){calls.push({url,method:options.method||'GET'});const q=new URL(url),t=q.pathname.split('/').at(-1);let result=[];
 if(q.pathname==='/auth/v1/user'){if(mode==='expired'&&++reads>1)return new Response('{}',{status:401});result={id:A};}
 else if(t==='work_admins')result=mode==='not-owner'?[]:[{user_id:A}];
 else if(t==='pa_inquiries')result=q.searchParams.get('id')==='eq.'+A?[{id:A}]:[];
 else if(t==='pa_gmail_thread_links')result=[{inquiry_id:mode==='other-case'?B:A,gmail_thread_id:'thread1'}];
 else if(t==='pa_gmail_message_index'){const id=q.searchParams.get('gmail_message_id')?.slice(3)||'received';result=[{inquiry_id:A,gmail_message_id:id,gmail_thread_id:'thread1',direction:id==='sent'?'outbound':'inbound',attachment_metadata:files.map((_,i)=>meta(i))}];}
 else if(t==='pa_portals')result=[{id:P,case_id:A}];
 else if(t==='pa_portal_document_cards')result=[{id:P,portal_id:P}];
 else if(t==='pa_portal_document_versions')result=[{id:D,card_id:P,source_type:mode==='storage'?'portal_upload':'gmail_attachment',display_filename:files[active][0],mime_type:files[active][1],source_ref:mode==='storage'?{storage_path:'cases/'+A+'/'+D+'/'+sha(files[active][2]),sha256:sha(files[active][2]),size:files[active][2].length}:{gmail_message_id:'received',gmail_attachment_id:'att'+active},gmail_part_id:String(active+1),canonical_attachment_key:canonicalAssetKey('received',String(active+1)),source_content_sha256:sha(files[active][2]),source_byte_size:files[active][2].length}];
 else if(q.pathname.startsWith('/storage/'))return new Response(files[active][2]);
 else if(t==='pa_commercial_documents')result=[{id:D,inquiry_id:mode==='foreign-document'?B:A,original_filename:files[active][0],mime_type:files[active][1],content:'\\x'+files[active][2].toString('hex'),sha256:mode==='bad-sha'?'0'.repeat(64):sha(files[active][2])}];
 else if(t==='pa_contracts')result=mode==='missing-receipt'?[]:[{id:D,inquiry_id:A}];
 else if(t==='pa_contract_receipts')result=[{contract_id:D,pdf:'\\x'+files[0][2].toString('hex'),sha256:sha(files[0][2])}];
 return Response.json(result);
}
const handler=createReadHandler({key:'sb_publishable_fixture',fetchImpl,provider});
async function read(path,headers={}){const res={statusCode:200,headers:{},setHeader(k,v){this.headers[k]=v;},write(b){(this.parts||=[]).push(b);return true;},end(b){this.body=this.parts?Buffer.concat([...this.parts,...(b?[Buffer.from(b)]:[])]):b;}};await handler({method:'GET',url:'/api/pa-workspace-read?path='+encodeURIComponent(path),headers:{authorization:auth,...headers}},res);return res;}
const route=(kind,extra='')=>'/data/download/'+kind+'/'+A+extra;
function verify(r,i){assert.equal(r.statusCode,200,String(r.body));assert.deepEqual(r.body,files[i][2]);assert.equal(r.headers['Content-Length'],String(files[i][2].length));assert.equal(r.headers['X-PA-Original-SHA256'],sha(files[i][2]));assert.match(r.headers['Content-Disposition'],/^attachment;/);assert.equal(decodeURIComponent(r.headers['Content-Disposition'].match(/filename\*=UTF-8''([^;]+)/)[1]),files[i][0]);assert.equal(r.headers['X-Content-Type-Options'],'nosniff');assert.match(r.headers['Content-Security-Policy'],/sandbox/);}
module.exports={A,B,D,files,handler,auth,configure(v={}){mode=v.mode||'';active=v.active||0;reads=0;calls=[];},calls:()=>calls};
if(require.main===module)(async()=>{const keys=['GMAIL_CLIENT_ID','GMAIL_CLIENT_SECRET','GMAIL_REFRESH_TOKEN','GMAIL_SENDER_ADDRESS','GMAIL_REPLY_TO'],saved=keys.map(k=>process.env[k]);keys.forEach(k=>process.env[k]=k.endsWith('ADDRESS')||k.endsWith('TO')?'fixture@example.invalid':'fixture-only');
 try{
  for(const message of ['received','sent'])for(let i=0;i<files.length;i++)verify(await read(route('mail-attachment','/'+message+'/att'+i)),i);
  for(active=0;active<files.length;active++){verify(await read(route('document','/'+D)),active);verify(await read(route('material','/version/'+D)),active);mode='storage';verify(await read(route('material','/version/'+D)),active);mode='';}
  active=1;assert.equal((await read('/data/mail-attachment/'+A+'/received/att1')).statusCode,415,'Preview allowance must remain unchanged');
  for(const [m,status,path] of [['other-case',403,route('mail-attachment','/received/att1')],['wrong-thread',403,route('mail-attachment','/received/att1')],['foreign-document',403,route('document','/'+D)],['bad-sha',409,route('document','/'+D)],['not-owner',403,route('mail-attachment','/received/att1')],['expired',401,route('mail-attachment','/received/att1')]]){mode=m;reads=0;const r=await read(path);assert.equal(r.statusCode,status,m);assert(!r.headers['Content-Disposition'],m);}
  mode='';assert.equal((await read(route('mail-attachment','/received/not-indexed'))).statusCode,403);
  assert.equal((await read(route('mail-attachment','/received/att1'),{'sec-fetch-site':'cross-site'})).statusCode,403);
  assert.equal((await read(route('cases'))).statusCode,403);
  let r=await read(route('contract-receipt','/'+D));assert.equal(r.statusCode,200);assert.deepEqual(r.body,files[0][2]);mode='missing-receipt';assert.equal((await read(route('contract-receipt','/'+D))).statusCode,404);mode='';
  active=1;const old=files[1][2];files[1][2]=Buffer.alloc(20*1024*1024+1);assert.equal((await read(route('mail-attachment','/received/att1'))).statusCode,413);files[1][2]=old;
  const {sendOriginal}=require('../api/_pa-original-download.cjs');r={headers:{},setHeader(k,v){this.headers[k]=v;},write(){return true;},end(){}};await sendOriginal(r,{bytes:Buffer.from('ok'),mime:'text/plain\r\nX-Evil: yes',filename:'日本語/../\r\n音源.mp3'});assert.equal(r.headers['Content-Type'],'application/octet-stream');assert(!/[\r\n]/.test(r.headers['Content-Disposition']));
  assert(calls.filter(c=>!c.url.includes('oauth2.googleapis.com/token')).every(c=>c.method==='GET'),'No DB/Gmail mutation, RPC, sync, labels or send');
  console.log(JSON.stringify({status:'PASS',formats:files.length,inbound_outbound:true,portal_versions_storage:true,commercial_originals:true,accepted_receipt_only:true,preview_limits_preserved:true,japanese_filename:true,byte_size_sha:true,acl_origin_expiry_denials:true,business_mutations:0,real_sends:0}));
 }finally{keys.forEach((k,i)=>saved[i]===undefined?delete process.env[k]:process.env[k]=saved[i]);}
})().catch(e=>{console.error(e);process.exitCode=1;});
