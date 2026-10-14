'use strict';
const assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright');
(async()=>{
 const {A,B,values,pdf}=await import('./paui027-fixture.mjs');
 const root=path.resolve(__dirname,'..'),calls=[],errors=[];let mode='gap';
 const rows=['late','early'].map((id,i)=>({gmail_message_id:id,gmail_thread_id:'linked-thread',inquiry_id:A,direction:'inbound',received_at:i?'2026-10-13T13:55:26+09:00':'2026-10-13T21:36:01+09:00',subject:'架空の最新メール '+id,index_state:'not_indexed',read_route:'live',attachment_metadata:i?[]:[{id:'1',part_id:'1',filename:'fixture.pdf',mime_type:'application/pdf'}]}));
 const server=http.createServer((req,res)=>{const f=path.join(root,new URL(req.url,'http://localhost').pathname);if(!f.startsWith(root+path.sep))return res.writeHead(403).end();try{res.setHeader('content-type',f.endsWith('.mjs')?'text/javascript':f.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(f));}catch{res.writeHead(404).end();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
 try{
  browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:900}});page.on('pageerror',e=>errors.push(e.message));
  await page.route(/^https?:\/\/(?!127\.0\.0\.1:)/,r=>r.abort());
  await page.route('**/pa-ui/js/integration.mjs',r=>r.fulfill({contentType:'text/javascript',body:"export const workspaceAuth={restore:async()=>({access_token:'fixture-only',expires_at:9999999999}),current:async()=>({access_token:'fixture-only',expires_at:9999999999}),logout:async()=>{},subscribe:()=>{}};export const readUrl=p=>'/api/pa-workspace-read?path='+encodeURIComponent(p);export const legacyUrl=()=>{throw Error('forbidden_legacy')};"}));
  await page.route('**/api/pa-workspace-read?**',async r=>{
   assert.equal(r.request().method(),'GET');const p=new URL(r.request().url()).searchParams.get('path');calls.push(p);
   if(p.startsWith('/data/mail-live/'+A)){
    if(mode==='failure')return r.fulfill({status:503,json:{ok:false,code:'provider_read_failed'}});
    if(mode==='slow')await new Promise(resolve=>setTimeout(resolve,250));
    return r.fulfill({json:{ok:true,result:{messages:rows,checks:[],status:'index_gap',unlinked_status:'not_checked',checked_at:'2026-10-14T00:00:00Z'}}});
   }
   if(p.startsWith('/data/mail-live-body/'))return r.fulfill({json:{ok:true,result:{gmail_message_id:p.split('/').at(-1),inquiry_id:A,body_text:'架空の最新本文\n<script>fixture</script>\n> 引用',body_state:'ready'}}});
   if(/\/data\/(material|document|mail-attachment|mail-live-attachment|sent-estimate-attachment)\//.test(p))return r.fulfill({contentType:'application/pdf',body:pdf()});
   return r.fulfill({json:{ok:true,result:values[p]??[]}});
  });
  await page.goto('http://127.0.0.1:'+server.address().port+'/pa-admin.html');await page.locator('[data-case="'+A+'"]').click();await page.locator('[data-case="'+A+'"][aria-pressed="true"]').waitFor();
  await page.locator('[data-tab=conversation]').click();
  assert.equal(calls.filter(p=>p.startsWith('/data/mail-live/')).length,0,'Case selection and conversation never check/sync Gmail implicitly');
  assert((await page.locator('#detail-card').innerText()).includes('Gmail最新は未確認'));
  await page.getByRole('button',{name:'最新メールを取得',exact:true}).click();
  await page.locator('[data-message="late"]').waitFor();assert.equal(await page.locator('.mail-row').first().getAttribute('data-message'),'late');
  assert.equal(await page.locator('[data-message="late"] .tiny.new').count(),0);assert((await page.locator('#detail-card').innerText()).includes('索引未更新あり'));
  await page.locator('[data-message="late"] [data-body-read]').click();assert((await page.locator('[data-message="late"]').innerText()).includes('架空の最新本文'));assert.equal(await page.locator('[data-message="late"] script').count(),0);
  await page.locator('[data-message="late"] .material-thumb').click();await page.locator('dialog[open] canvas').waitFor();assert(calls.includes('/data/mail-live-attachment/'+A+'/linked-thread/late/1'));await page.locator('dialog[open]').getByRole('button',{name:'閉じる',exact:true}).click();
  if(process.env.PAUI030_SHOTS)await page.screenshot({path:path.join(process.env.PAUI030_SHOTS,'PAUI030_FIXTURE_1440.png')});
  await page.setViewportSize({width:390,height:900});if(process.env.PAUI030_SHOTS)await page.screenshot({path:path.join(process.env.PAUI030_SHOTS,'PAUI030_FIXTURE_390.png')});
  mode='failure';await page.getByRole('button',{name:'最新メールを取得',exact:true}).click();await page.getByText('Gmail取得失敗 / 最新は未確認',{exact:true}).waitFor();assert.equal(await page.locator('[data-message="late"]').count(),1,'Failed recheck retains prior rows with explicit UNKNOWN');
  await page.setViewportSize({width:1440,height:900});mode='slow';await page.getByRole('button',{name:'最新メールを取得',exact:true}).click();await page.locator('[data-case="'+B+'"]').click();await page.locator('[data-case="'+B+'"][aria-pressed="true"]').waitFor();await new Promise(r=>setTimeout(r,350));await page.locator('[data-tab=conversation]').click();assert.equal(await page.locator('[data-message="late"]').count(),0,'Stale case response must not mount foreign mail');
  assert(calls.every(p=>!p.includes('/rpc/')&&!p.includes('sync')));assert.deepEqual(errors,[]);
  console.log(JSON.stringify({status:'PASS',scope:'ANONYMOUS_FIXTURE_ONLY',explicit_get:true,no_implicit_check:true,newest_first:true,body_inert:true,unindexed_pdf:true,no_inferred_new:true,failed_read_unknown:true,stale_case_rejected:true,business_writes:0,legacy_launches:0,page_errors:0}));
 }finally{if(browser)await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
