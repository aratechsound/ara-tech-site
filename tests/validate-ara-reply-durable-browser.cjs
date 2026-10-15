'use strict';
// Isolated Chromium contexts -> real authenticated handler -> localhost
// PostgREST / independent PostgreSQL connections -> synthetic Gmail only.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium}=require('playwright'),{randomUUID}=require('node:crypto');
const {fixture}=require('./helpers/ara-case-real-fixture.cjs');
const root=path.resolve(__dirname,'..'),f=fixture(),caseId=randomUUID(),messageId='durable_browser_'+Date.now(),threadId=messageId;
const gmail=require('../api/_pa-gmail.cjs');
(async()=>{
 f.sql(`insert into pa_inquiries(id,created_by,customer_name,email,event_name,case_type) values('${caseId}','${f.actor}','Durable synthetic','customer@example.invalid','Durable synthetic','PA_EVENT');`);
 const raw=f.raw(messageId,threadId);raw.payload.parts=raw.payload.parts.slice(0,1);f.state.messages.set(messageId,raw);
 await gmail.manualLink({inquiryId:caseId,actorId:f.actor,gmailThreadId:threadId},f.fetchImpl);
 const handler=require('../api/pa-gmail.js');global.fetch=f.fetchImpl;
 const server=http.createServer(async(req,res)=>{try{
  const u=new URL(req.url,'http://localhost');
  if(u.pathname==='/api/pa-gmail'){let b='';for await(const c of req)b+=c;req.body=JSON.parse(b);res.status=n=>{res.statusCode=n;return res;};res.json=d=>res.end(JSON.stringify(d));return await handler(req,res);}
  if(u.pathname==='/')return res.end(`<!doctype html><button id="open">Reply fixture</button><script type="module">import {createReplyComposer} from '/pa-ui/js/case-workflows.mjs';const request=async(action,payload)=>{const r=await fetch('/api/pa-gmail',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer ${f.jwt('authenticated')}'},body:JSON.stringify({action,...payload})});const d=await r.json();if(!r.ok||!d.ok)throw Error(d.code);return d;};const composer=createReplyComposer({request,getCase:()=>({id:'${caseId}',inquiry_number:'FIXTURE',event_name:'Synthetic fixture'}),onSent:async()=>{}});document.querySelector('#open').onclick=()=>composer.open({inquiry_id:'${caseId}',gmail_message_id:'${messageId}',gmail_thread_id:'${threadId}',direction:'inbound',from_address:'customer@example.invalid',subject:'設備施工相談',cc_addresses:[]});</script>`);
  const file=path.resolve(root,u.pathname.slice(1));if(!file.startsWith(root+path.sep))return res.writeHead(403).end();res.setHeader('Content-Type','text/javascript');res.end(fs.readFileSync(file));
 }catch(e){res.statusCode=500;res.end(JSON.stringify({code:'fixture_error',name:e.name}));}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+server.address().port;process.env.ALLOWED_ORIGINS=url;
 const browser=await chromium.launch({headless:true});const contexts=[];
 const page=async()=>{const c=await browser.newContext();contexts.push(c);const p=await c.newPage();p.on('pageerror',e=>console.error('fixture page error',e.message));p.on('response',async r=>{if(r.url().endsWith('/api/pa-gmail')&&r.status()>=400)console.error('fixture API rejection',r.status(),await r.text());});await p.route(/^https?:\/\/(?!127\.0\.0\.1:)/,r=>r.abort());await p.goto(url);await p.locator('#open').click();return p;};
 const preview=async(p,body)=>{const d=p.getByRole('dialog',{name:'Gmail返信作成'});await d.getByLabel('本文',{exact:true}).fill(body);await d.getByRole('button',{name:'返信プレビュー',exact:true}).click();try{await d.getByText('プレビュー確認済み。まだ送信していません。',{exact:true}).waitFor();}catch(e){console.error('isolated fixture composer',await d.innerText());throw e;}return d;};
 const arm=async d=>{await d.getByRole('button',{name:'送信内容を最終確認',exact:true}).click();await d.getByRole('checkbox').check();};
 try{
  const [p1,p2]=await Promise.all([page(),page()]);const [d1,d2]=await Promise.all([preview(p1,'Concurrent same operation'),preview(p2,'Concurrent same operation')]);
  const texts=await Promise.all([d1,d2].map(d=>d.getByRole('region',{name:'永続送信操作'}).count().then(()=>d.locator('[aria-label="永続送信操作"]').textContent())));
  assert.equal(texts[0],texts[1]);await Promise.all([arm(d1),arm(d2)]);await Promise.all([d1,d2].map(d=>d.getByRole('button',{name:'最終確認して送信',exact:true}).click()));
  await d1.getByText(/送信済み/).first().waitFor();await d2.getByText(/送信済み|送信結果を確定できるまで/).first().waitFor();assert.equal(f.state.sends,1);
  await contexts[0].close();await contexts[1].close();const p3=await page();const d3=p3.getByRole('dialog');await d3.locator('[aria-label="永続送信操作"]').getByText(/SENT/).waitFor();
  await d3.getByLabel('本文',{exact:true}).fill('Concurrent same operation');await d3.getByRole('button',{name:'返信プレビュー',exact:true}).click();await d3.getByText(/この送信操作は送信済み/).waitFor();assert.equal(await d3.getByRole('button',{name:'最終確認して送信',exact:true}).count(),0);assert.equal(f.state.sends,1);
  await contexts[2].close();const p4=await page(),d4=await preview(p4,'Separate unknown operation');await arm(d4);f.state.failSend=true;await d4.getByRole('button',{name:'最終確認して送信',exact:true}).click();await d4.locator('[aria-label="永続送信操作"]').getByText(/UNKNOWN/).waitFor();assert.equal(f.state.sends,2);
  await contexts[3].close();const p5=await page(),d5=p5.getByRole('dialog');await d5.getByText(/送信結果を確定できるまで再送できません/).waitFor();assert.equal(await d5.getByRole('button',{name:'返信プレビュー',exact:true}).isDisabled(),true);
  await d5.getByRole('button',{name:'Gmailの送信結果を照合（読取専用）',exact:true}).click();await d5.locator('[aria-label="永続送信操作"]').getByText(/UNKNOWN/).waitFor();assert.equal(f.state.sends,2);
  // HTTP authentication/Origin gates on the same real handler: no provider call.
  const live=f.fetchImpl;const denied=await new Promise(resolve=>{const q=http.request(url+'/api/pa-gmail',{method:'POST',headers:{Origin:'https://foreign.invalid','content-type':'application/json'}},r=>{r.resume();r.on('end',()=>resolve(r.statusCode));});q.end(JSON.stringify({action:'reply_operation_status',inquiry_id:caseId}));});assert.equal(denied,403);assert.equal(f.state.sends,2);
  console.log(JSON.stringify({status:'PASS',two_browser_contexts:true,independent_postgres_claims:true,browser_close_and_new_login_context:true,unknown_survives_restart:true,readonly_lookup_never_resends:true,origin_rejected:true,mocked_provider_sends:f.state.sends,real_provider_sends:0}));
 }finally{await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
