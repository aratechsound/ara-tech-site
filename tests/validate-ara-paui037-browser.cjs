'use strict';
const assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright'),fixtures=require('./paui037-fixture.cjs');
(async()=>{
 const {A,B,values}=await import('./paui027-fixture.mjs'),root=path.resolve(__dirname,'..');
 const rows=fixtures.map(f=>({gmail_message_id:f.id,gmail_thread_id:'fixture-thread',inquiry_id:A,direction:f.direction||'inbound',subject:'架空 '+f.id,received_at:'2026-10-14T00:00:00Z',body_text:f.body,attachment_metadata:[]}));
 const server=http.createServer((req,res)=>{const f=path.join(root,new URL(req.url,'http://localhost').pathname);if(!f.startsWith(root+path.sep))return res.writeHead(403).end();try{res.setHeader('content-type',f.endsWith('.mjs')?'text/javascript':f.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(f));}catch{res.writeHead(404).end();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
 try{
  browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[],posts=[],external=[],pending=[];let hold=true;
  page.on('pageerror',e=>errors.push(e.message));
  await page.route(/^https?:\/\/(?!127\.0\.0\.1:)/,r=>{external.push(r.request().url());return r.abort();});
  await page.route('**/pa-ui/js/integration.mjs',r=>r.fulfill({contentType:'text/javascript',body:"export const workspaceAuth={restore:async()=>({access_token:'fixture-only',expires_at:9999999999}),current:async()=>({access_token:'fixture-only',expires_at:9999999999}),logout:async()=>{},subscribe:()=>{}};export const readUrl=p=>'/api/pa-workspace-read?path='+encodeURIComponent(p);export const legacyUrl=()=>{throw Error('forbidden_legacy')};"}));
  await page.route('**/api/**',async r=>{
   const url=new URL(r.request().url());
   if(url.searchParams.get('mail_summary')==='1'){
    const id=url.searchParams.get('message'),f=fixtures.find(f=>f.id===id),generate=r.request().method()==='POST';
    if(generate)posts.push(id);else assert.equal(r.request().method(),'GET');
    if(hold)await new Promise(resolve=>pending.push(resolve));
    return r.fulfill({json:{ok:true,result:{inquiry_id:A,gmail_thread_id:'fixture-thread',gmail_message_id:id,
      ...(generate?{state:'ready',lines:f.lines}:{state:'not_generated',reason:'not_requested',can_generate:true})}}}).catch(()=>{});
   }
   assert.equal(r.request().method(),'GET');const p=url.searchParams.get('path');
   return r.fulfill({json:{ok:true,result:p==='/data/mail/'+A?rows:p==='/data/mail/'+B?[]:values[p]??[]}});
  });
  await page.goto('http://127.0.0.1:'+server.address().port+'/pa-admin.html');await page.locator('[data-case="'+A+'"]').click();await page.locator('[data-tab=conversation]').click();
  await page.locator('[data-message=A] .mail-summary').waitFor();assert.equal(await page.locator('.mail-row').count(),10);
  await page.waitForFunction(()=>document.querySelector('.mail-summary-lines')?.textContent.includes('取得・生成中'));
  assert(pending.length<=2,'summary reads limited to two while list and original are rendered');assert.equal(posts.length,0);
  hold=false;for(const resolve of pending.splice(0))resolve();
  const a=page.locator('[data-message=A]');await a.getByRole('button',{name:'AI要約を生成',exact:true}).click();
  await a.getByText(fixtures[0].lines[0],{exact:true}).waitFor();assert.deepEqual(posts,['A']);
  assert((await a.innerText()).includes('原文（抜粋・AI要約ではありません）'));
  await a.locator('[data-body-read]').click();assert((await a.locator('.mail-excerpt').textContent()).includes(fixtures[0].body));
  await a.locator('[data-body-read]').click();assert.equal(posts.length,1);
  if(fs.existsSync('/workspace/outputs'))await page.screenshot({path:'/workspace/outputs/PAUI037_FIXTURE_UI.png',fullPage:false});
  await page.locator('[data-case="'+B+'"]').click();await page.locator('[data-tab=conversation]').click();assert.equal(await page.locator('.mail-summary').count(),0);
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  // Direct view stress harness: 500 rows, delayed responses, detach/case change,
  // wrong identity, failure states, no automatic POST, and cache cleared at logout.
  const stress=await browser.newPage();await stress.goto('http://127.0.0.1:'+server.address().port+'/pa-admin.html');
  const result=await stress.evaluate(async()=>{
   const {createMailSummaryView}=await import('/pa-ui/js/mail-summary-view.mjs');
   document.body.replaceChildren();let current=true,authed=true,active=0,max=0,calls=0,releases=[];
   const view=createMailSummaryView({isAuthenticated:()=>authed,request:async(id,row,{generate})=>{if(generate)throw Error('unexpected_paid_request');calls++;active++;max=Math.max(max,active);await new Promise(r=>releases.push(r));active--;return {inquiry_id:id,gmail_thread_id:row.gmail_thread_id,gmail_message_id:row.gmail_message_id,state:'ready',lines:['架空の意味的要約']};}});
   for(let i=0;i<500;i++){const c=document.createElement('article');c.innerHTML='<p class="mail-excerpt">架空原文</p>';document.body.append(c);view.mount(c,'case-a',{gmail_thread_id:'t',gmail_message_id:'m'+i},()=>current);}
   await new Promise(r=>setTimeout(r,200));const before={calls,max,count:document.querySelectorAll('.mail-summary').length};
   current=false;view.detach();document.body.replaceChildren();for(const r of releases.splice(0))r();await new Promise(r=>setTimeout(r,100));
   const after=document.body.textContent;authed=false;view.clear();return {...before,after};
  });
  assert.equal(result.count,500);assert(result.calls<=2);assert(result.max<=2);assert.equal(result.after,'');
  // Isolated errors and injected HTML must remain text, never execute.
  const negative=await stress.evaluate(async()=>{
   const {createMailSummaryView}=await import('/pa-ui/js/mail-summary-view.mjs');document.body.replaceChildren();const panels=[];
   for(const state of ['failed','not_generated','mismatch','ready']){
    const c=document.createElement('article');c.innerHTML='<p class="mail-excerpt">original</p>';document.body.append(c);
    const v=createMailSummaryView({isAuthenticated:()=>true,request:async()=>({inquiry_id:state==='mismatch'?'wrong':'c',gmail_thread_id:'t',gmail_message_id:'m',state:state==='mismatch'?'ready':state,reason:'approval_required',lines:['<img src=x onerror="window.summaryInjection=true">']})});
    v.mount(c,'c',{gmail_thread_id:'t',gmail_message_id:'m'},()=>true);panels.push(c);
   }
   await new Promise(r=>setTimeout(r,200));return {text:panels.map(p=>p.textContent),images:document.querySelectorAll('img').length,injected:window.summaryInjection===true};
  });
  assert(negative.text[0].includes('失敗'));assert(negative.text[1].includes('未生成'));assert(negative.text[2].includes('失敗'));assert.equal(negative.images,0);assert.equal(negative.injected,false);
  console.log(JSON.stringify({status:'PASS',actual_desk_render:true,summary_get_concurrency:2,explicit_fixture_generation_posts:posts.length,automatic_generation_posts:0,stress_rows:500,late_case_result_suppressed:true,original_preserved:true,semantic_AI_quality:'HOLD_NOT_RUN',real_external_requests:0}));
 }finally{if(browser)await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
