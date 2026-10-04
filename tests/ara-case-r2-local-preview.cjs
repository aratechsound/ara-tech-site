const http=require('node:http'),fs=require('node:fs'),path=require('node:path');const {fixture}=require('./helpers/ara-case-real-fixture.cjs');
const f=fixture();global.fetch=f.fetchImpl;const root=path.resolve(__dirname,'..'),port=8872;
f.sql('delete from ara_mail_sync_state;');
const resetFixtureRateWindow=()=>f.sql("update api_rate_limit_buckets set window_expires_at=now()-interval '1 second';");
resetFixtureRateWindow();
const PA=f.sql(`insert into pa_inquiries(created_by,status,customer_name,email,event_name,event_date,case_type) values('${f.actor}','new_inquiry','R2 PA維持','pa@example.invalid','PA fixture','2026-11-01','PA_EVENT') returning id;`).split('\n')[0];
const legacyPA=f.sql(`insert into pa_inquiries(created_by,status,customer_name,email,event_name,event_date) values('${f.actor}','new_inquiry','Legacy PA保存試験','pa@example.invalid','Legacy PA','2026-11-01') returning id;`,'ara_case_r2_legacy').split('\n')[0];
const unknown=f.sql("select id from pa_inquiries where customer_name='CLASS_UNKNOWN';").split('\n')[0];const seed=[];
for(const name of ['A','B']){
 const id=f.sql(`insert into pa_inquiries(created_by,status,customer_name,email,case_type,case_subject) values('${f.actor}','new_inquiry','R2 race ${name}','customer@example.invalid','AUDIO_INSTALL','race ${name}') returning id;`).split('\n')[0];const message=f.raw('r2_'+name+'_'+Date.now());f.state.messages.set(message.id,message);const previous=f.raw(message.id+'_previous',message.threadId,Date.now()-20000);f.state.messages.set(previous.id,previous);
 f.sql(`insert into pa_gmail_thread_links(inquiry_id,gmail_thread_id,link_source,conversation_role,linked_by) values('${id}','${message.threadId}','manual','primary_conversation','${f.actor}');`);seed.push({name,id,number:f.sql(`select inquiry_number from pa_inquiries where id='${id}';`),message:message.id,attachment:'att_'+message.id});
}
const formMessage=f.raw('r2_form_'+Date.now());formMessage.payload.headers.find(h=>h.name==='From').value='form@example.invalid';formMessage.payload.headers.find(h=>h.name==='Subject').value='R2 フォーム顧客の返信会話';f.state.messages.set(formMessage.id,formMessage);
const candidate=f.raw('r2_review_'+Date.now());candidate.payload.headers.find(h=>h.name==='Subject').value='R2 案件化前レビュー';f.state.messages.set(candidate.id,candidate);
const handlers={'/api/pa-gmail':require('../api/pa-gmail.js'),'/api/pa-inquiry':require('../api/pa-inquiry.js')};
const mime={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml'};
const live=fetch; // fixture fetch already captured network implementation before assignment
const server=http.createServer(async(req,res)=>{
 try{
  const u=new URL(req.url,`http://127.0.0.1:${port}`);let raw='';for await(const b of req){raw+=b;if(raw.length>4500000)throw Error('body limit');}const body=raw?JSON.parse(raw):null;res.setHeader('Cache-Control','no-store');
  if(handlers[u.pathname]){req.body=body;res.status=n=>{res.statusCode=n;return res;};res.json=data=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(data));};return handlers[u.pathname](req,res);}
  if(u.pathname==='/fixture-info'){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({PA,legacyPA,unknown,seed,candidate:candidate.id}));}
  if(u.pathname==='/fixture-control'){if(body?.resetRate)resetFixtureRateWindow();f.state.failSend=body?.failSend===true;f.state.restPort=body?.legacy?55439:55442;process.env.SUPABASE_URL=`http://127.0.0.1:${f.state.restPort}`;process.env.ARA_GENERAL_INQUIRY_ENABLED=body?.enabled===false?'false':'true';return res.end('{}');}
  if(u.pathname==='/auth/v1/token'){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({access_token:f.jwt('authenticated'),refresh_token:'fixture-only',token_type:'bearer',expires_in:86400,user:{id:f.actor,email:'owner@example.invalid',app_metadata:{provider:'email'},user_metadata:{},aud:'authenticated',role:'authenticated'}}));}
  if(u.pathname==='/auth/v1/user'){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({id:f.actor,email:'owner@example.invalid'}));}
  if(u.pathname==='/auth/v1/logout')return res.end('{}');
  if(u.pathname.startsWith('/rest/v1/')){const r=await f.fetchImpl(`http://127.0.0.1:${f.state.restPort}`+u.pathname+u.search,{method:req.method,headers:req.headers,...(body?{body:JSON.stringify(body)}:{})});res.statusCode=r.status;r.headers.forEach((v,k)=>{if(!['transfer-encoding','content-encoding','content-length'].includes(k))res.setHeader(k,v);});return res.end(Buffer.from(await r.arrayBuffer()));}
  if(u.pathname==='/fixture-supabase.js'){res.setHeader('Content-Type','text/javascript');return res.end(fs.readFileSync(path.resolve(root,'tests/fixtures/ara-case-supabase.umd.js')));}
  if(u.pathname==='/js/supabase-config.js'){res.setHeader('Content-Type','text/javascript');return res.end(`export const SUPABASE_URL='http://127.0.0.1:${port}';export const SUPABASE_ANON_KEY='${f.jwt('anon')}';export const isSupabaseConfigured=true;`);}
  const relative=decodeURIComponent(u.pathname==='/'?'/pa-admin.html':u.pathname).slice(1),file=path.resolve(root,relative);if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||fs.statSync(file).isDirectory()){res.statusCode=404;return res.end('{}');}let bytes=fs.readFileSync(file);
  if(relative==='pa-admin.html')bytes=Buffer.from(bytes.toString('utf8').replace('</head>','<script src="/fixture-supabase.js"></script></head>').replace('<main>','<main><p class="alert">LOCAL ONLY：実PostgreSQL/PostgREST、実UI/API。Gmail・ログインはfixture。本番未接続。</p>'));
  if(relative==='js/pa-admin.js')bytes=Buffer.from(bytes.toString('utf8').replace('import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";','const { createClient } = window.supabase;'));
  res.setHeader('Content-Type',mime[path.extname(file)]||'application/octet-stream');res.end(bytes);
 }catch(e){res.statusCode=500;res.end(JSON.stringify({code:'local_fixture_error',message:e.message}));}
});server.listen(port,'127.0.0.1',()=>console.log('R2 Preview http://127.0.0.1:8872/pa-admin.html'));
