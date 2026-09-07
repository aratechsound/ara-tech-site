const assert=require('node:assert/strict');
const {PDFDocument}=require('pdf-lib');
const {createDatabase,read,inquiryId,otherId,actorId}=require('./pa-estimate-fixture.cjs');
const {createService}=require('../../api/_pa-contract.cjs');
const {createHandler}=require('../../api/pa-contract.js');
const {checkRateLimit}=require('../../api/_request-security.cjs');
const {verifyAdmin}=require('../../api/_pa-mail.cjs');
const json=(data,status=200)=>({ok:status>=200&&status<300,status,json:async()=>data});
async function createFixture(){
 Object.assign(process.env,{SUPABASE_URL:'https://fixture.invalid',SUPABASE_SERVICE_ROLE_KEY:'fixture-service',GMAIL_CLIENT_ID:'fixture-id',GMAIL_CLIENT_SECRET:'fixture-secret',GMAIL_REFRESH_TOKEN:'fixture-refresh',GMAIL_SENDER_ADDRESS:'aratechsound@gmail.com',GMAIL_REPLY_TO:'aratechsound@gmail.com',RATE_LIMIT_HASH_SECRET:'fixture-secret-for-rate-limits',ALLOWED_ORIGINS:'https://fixture.invalid,http://127.0.0.1:4317'});
 const db=await createDatabase();
 await db.exec(`create role service_role bypassrls; create table public.work_admins(user_id uuid primary key); insert into public.work_admins values('${actorId}');
 alter table public.pa_email_deliveries add column inquiry_id uuid, add column status text, add column gmail_thread_id text, add column gmail_message_id text, add column message_type text, add column sent_at timestamptz, add column recipient text, add column subject text;
 alter table public.pa_inquiries add column email text, add column customer_name text, add column contact_name text, add column organization_name text, add column event_name text, add column event_date date, add column inquiry_number text, add column request_summary text;
 update public.pa_inquiries set email='customer@example.invalid',customer_name='管理下テスト担当者',contact_name='管理下テスト担当者',organization_name='テスト実行委員会',event_name='龍姫湖まつり2026（検証用）',event_date='2026-10-18',inquiry_number='PA-20260907-00001',request_summary='屋外イベントPA・設営・本番対応';
 update public.pa_gmail_message_index set to_addresses='["customer@example.invalid"]',attachment_metadata='[{"id":"attachment_1","filename":"final-estimate.pdf","mime_type":"application/pdf"}]';`);
 await db.exec(read('20260907130000_pa_formal_contract.sql'));
 const original=await PDFDocument.create();const page=original.addPage([595,842]);page.drawText('CONTROLLED FIXTURE - FINAL ESTIMATE', {x:45,y:770,size:16});page.drawText('PA test case / JPY 110,000 including tax',{x:45,y:735,size:12});page.drawRectangle({x:45,y:620,width:505,height:60});
 const quote=Buffer.from(await original.save());
 const state={sendCount:0,transport:'ok',quote,corruptStored:false,missingStored:false,rateAllowed:true,network:[],receipts:[],lastRaw:null};
 const rawMessage=(id='direct_sent_001')=>({id,threadId:'thread_123',labelIds:['SENT'],internalDate:'1788254400000',payload:{mimeType:'multipart/mixed',headers:[{name:'From',value:'aratechsound@gmail.com'},{name:'To',value:'customer@example.invalid'},{name:'Subject',value:'PA-20260907-00001 / Event estimate'},{name:'Message-ID',value:'<fixture@example.invalid>'}],parts:[{mimeType:'text/plain',body:{data:Buffer.from('Fixture estimate message').toString('base64url')}},{mimeType:'application/pdf',filename:'final-estimate.pdf',partId:'1',body:{attachmentId:'attachment_1',size:state.quote.length}}]}});
 const fetchImpl=async(target,options={})=>{
  const u=new URL(target);state.network.push({host:u.host,path:u.pathname,method:options.method||'GET'});
  if(state.failPostSendRead&&state.sendCount>state.failPostSendReadAfter&&u.host==='gmail.googleapis.com'&&u.pathname.includes('/threads/'))return json({},503);
  if(u.host==='oauth2.googleapis.com')return json({access_token:'fixture-access',expires_in:3600});
  if(u.host==='gmail.googleapis.com'){
   if(u.pathname.endsWith('/messages/send')){state.sendCount++;state.lastRaw=JSON.parse(options.body);if(state.transport==='uncertain')throw Error('network_response_lost');if(state.transport==='fail')return json({},400);return json({id:'sent_contract_1',threadId:'thread_123'});}
   if(u.pathname.includes('/attachments/'))return json({data:state.quote.toString('base64url'),size:state.quote.length});
   if(u.pathname.includes('/threads/'))return json({id:'thread_123',messages:[rawMessage()]});
   if(u.pathname.includes('/messages/'))return json(rawMessage());
   return json({messages:[]});
  }
  assert.equal(u.origin,'https://fixture.invalid','Live network forbidden');
  if(u.pathname==='/auth/v1/user')return options.headers.authorization==='Bearer fixture-admin'?json({id:actorId}):json({},401);
  assert.equal(u.pathname.split('/')[1],'rest');
  if(u.pathname.endsWith('/rpc/consume_rate_limit'))return json({allowed:state.rateAllowed,remaining:10,retry_after_seconds:600,limit:JSON.parse(options.body).p_limit});
  if(u.pathname.includes('/rpc/')){
   const name=u.pathname.split('/').at(-1);assert(/^pa_contract_[a-z0-9_]+$/.test(name));const input=JSON.parse(options.body),keys=Object.keys(input);keys.forEach(k=>assert(/^p_[a-z0-9_]+$/.test(k)));
   try{const r=await db.query(`select public.${name}(${keys.map((k,i)=>`${k} => $${i+1}`).join(',')}) result`,Object.values(input));return json(r.rows[0].result);}catch(e){return json({message:e.message},400);}
  }
  const table=u.pathname.split('/').at(-1);assert(/^(pa_[a-z0-9_]+|work_admins)$/.test(table));
  const values=[],where=[];
  for(const [key,value] of u.searchParams){if(['select','limit','order','on_conflict'].includes(key))continue;assert(/^[a-z0-9_]+$/.test(key));if(value==='is.null')where.push(`${key} is null`);else if(value.startsWith('eq.')){values.push(value.slice(3));where.push(`${key}=$${values.length}`);}else throw Error('Unexpected filter '+key);}
  const suffix=where.length?' where '+where.join(' and '):'';
  try{
   if((options.method||'GET')==='GET'){
    const selected=u.searchParams.get('select')||'*';assert(/^[a-z0-9_*,]+$/.test(selected));
    const order=u.searchParams.get('order')?.split(',').map(s=>{const [k,d]=s.split('.');assert(/^[a-z0-9_]+$/.test(k)&&['asc','desc'].includes(d));return k+' '+d;}).join(',');
    const rows=(await db.query(`select ${selected} from public.${table}${suffix}${order?' order by '+order:''} limit ${Number(u.searchParams.get('limit')||1000)}`,values)).rows;
    const mapped=rows.map(row=>Object.fromEntries(Object.entries(row).map(([k,v])=>[k, v instanceof Uint8Array?'\\x'+Buffer.from(v).toString('hex'):v instanceof Date?(k.endsWith('_date')||k.endsWith('_on')?v.toISOString().slice(0,10):v.toISOString()):v])));
    if(table==='pa_contract_offers')for(const row of mapped){if('quote_pdf'in row&&state.corruptStored)row.quote_pdf='\\x'+Buffer.from('broken').toString('hex');if('quote_pdf'in row&&state.missingStored)row.quote_pdf=null;}
    return json(mapped);
   }
   const input=JSON.parse(options.body);
   if(typeof input.pdf==='string'&&input.pdf.startsWith('\\x'))input.pdf=Buffer.from(input.pdf.slice(2),'hex');
   if(options.method==='PATCH'){
    const offset=values.length,keys=Object.keys(input);keys.forEach(k=>assert(/^[a-z0-9_]+$/.test(k)));const rows=(await db.query(`update public.${table} set ${keys.map((k,i)=>`${k}=$${i+offset+1}`).join(',')}${suffix} returning *`,[...values,...Object.values(input)])).rows;return json(rows);
   }
   assert.equal(options.method,'POST');const keys=Object.keys(input);keys.forEach(k=>assert(/^[a-z0-9_]+$/.test(k)));
   const upsert=options.headers?.prefer?.includes('resolution=merge-duplicates');
   const conflict=upsert?' on conflict ('+(u.searchParams.get('on_conflict')||keys[0])+') do update set '+keys.map(k=>`${k}=excluded.${k}`).join(','):'';
   const rows=(await db.query(`insert into public.${table}(${keys.join(',')}) values(${keys.map((_,i)=>'$'+(i+1)).join(',')})${conflict} returning *`,Object.values(input))).rows;
   return json(rows);
  }catch(e){return json({message:e.message},400);}
 };
 const service=createService({fetchImpl});
 const handler=createHandler({service,admin:token=>verifyAdmin(token,fetchImpl),rate:args=>checkRateLimit({...args,fetchImpl})});
 const call=async(input,{admin=true}={})=>{
  const res={headers:{},setHeader(k,v){this.headers[k]=v;},status(s){this.statusCode=s;return this;},json(b){this.body=b;return this;},write(b){this.bytes=Buffer.concat([this.bytes||Buffer.alloc(0),b]);return true;},end(){return this;}};
  await handler({method:'POST',headers:{origin:'https://fixture.invalid',...(admin?{authorization:'Bearer fixture-admin'}:{})},body:input,socket:{remoteAddress:'127.0.0.1'}},res);return res;
 };
 return {db,state,quote,service,handler,call,fetchImpl,inquiryId,otherId,actorId};
}
module.exports={createFixture};
