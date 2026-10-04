const http=require('node:http');const fs=require('node:fs');const path=require('node:path');
const {createFixture}=require('./helpers/ara-case-fixture.cjs');
const root=path.resolve(__dirname,'..');const port=Number(process.env.ARA_CASE_PREVIEW_PORT||8871);let fixture;
const mime={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.png':'image/png','.ico':'image/x-icon','.svg':'image/svg+xml'};
(async()=>{
 fixture=await createFixture();global.fetch=fixture.fetchImpl;
 await fixture.db.query("insert into pa_inquiries(created_by,status,customer_name,email,event_name,event_date,case_type) values($1,'new_inquiry','PA隔離試験顧客','pa@example.invalid','PA回帰確認','2026-11-01','PA_EVENT')",[fixture.actor]);
 fixture.state.messages.set('preview_mail',fixture.raw('preview_mail','preview_thread'));
 fixture.state.threadMessages.set('preview_thread',[fixture.state.messages.get('preview_mail')]);fixture.state.pages=[['preview_mail']];
 const handler=require('../api/pa-gmail.js');
 const server=http.createServer(async(req,res)=>{
  try {
   const u=new URL(req.url,`http://127.0.0.1:${port}`);let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>4500000)throw Error('body too large');}
   res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','application/json');
   const body=raw?JSON.parse(raw):null;
   if(u.pathname==='/api/pa-gmail'){req.body=body;res.status=n=>{res.statusCode=n;return res;};res.json=data=>{res.end(JSON.stringify(data));return data;};return await handler(req,res);}
   if(u.pathname==='/auth/v1/token'){return res.end(JSON.stringify({access_token:'fixture-admin',refresh_token:'fixture-refresh',token_type:'bearer',expires_in:3600,user:{id:fixture.actor,email:'owner@example.invalid',app_metadata:{provider:'email'},user_metadata:{},aud:'authenticated',role:'authenticated'}}));}
   if(u.pathname==='/auth/v1/logout'){return res.end('{}');}
   if(u.pathname==='/auth/v1/user'){return res.end(JSON.stringify({id:fixture.actor,email:'owner@example.invalid'}));}
   if(u.pathname.startsWith('/rest/v1/')){
    const r=await fixture.fetchImpl('https://fixture.invalid'+u.pathname+u.search,{method:req.method,headers:req.headers,...(body?{body:JSON.stringify(body)}:{})});let data=await r.json();
    if(String(req.headers.accept||'').includes('vnd.pgrst.object')){if(Array.isArray(data)&&data.length===1)data=data[0];else if(Array.isArray(data)&&data.length===0){res.statusCode=406;return res.end(JSON.stringify({code:'PGRST116',details:'The result contains 0 rows',message:'JSON object requested, multiple (or no) rows returned'}));}}
    res.statusCode=r.status;return res.end(JSON.stringify(data));
   }
   if(u.pathname==='/fixture-control'){fixture.state.mailbox=body?.mailbox||'aratechsound@gmail.com';return res.end('{}');}
   if(u.pathname==='/fixture-supabase.js'){res.setHeader('Content-Type','text/javascript');return res.end(fs.readFileSync(path.resolve(root,'../fixture-supabase.js')));}
   if(u.pathname==='/js/supabase-config.js'){res.setHeader('Content-Type','text/javascript');return res.end(`export const SUPABASE_URL='http://127.0.0.1:${port}';export const SUPABASE_ANON_KEY='fixture-anon';export const isSupabaseConfigured=true;`);}
   const relative=decodeURIComponent(u.pathname==='/'?'/pa-admin.html':u.pathname).slice(1);const file=path.resolve(root,relative);if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||fs.statSync(file).isDirectory()){res.statusCode=404;return res.end('{}');}
   let bytes=fs.readFileSync(file);
   if(relative==='pa-admin.html'){let s=bytes.toString('utf8');s=s.replace('</head>','<script src="/fixture-supabase.js"></script></head>').replace('<main>','<main><p class="alert">LOCAL隔離試験：実UI／実handler／実migration PGlite。REST adapter・fake Gmail。本番未接続。</p>');bytes=Buffer.from(s);}
   if(relative==='js/pa-admin.js')bytes=Buffer.from(bytes.toString('utf8').replace('import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";','const { createClient } = window.supabase;'));
   res.setHeader('Content-Type',mime[path.extname(file)]||'application/octet-stream');res.end(bytes);
  }catch(e){res.statusCode=500;res.end(JSON.stringify({error:'local_fixture_error',message:e.message}));}
 });server.listen(port,'127.0.0.1',()=>console.log(`LOCAL_PREVIEW=http://127.0.0.1:${port}/pa-admin.html; fixture login owner@example.invalid / fixture-only`));
})().catch(e=>{console.error(e);process.exit(1);});
