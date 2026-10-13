'use strict';
const assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright');
(async()=>{
 const {A,B,values,pdf}=await import('./paui027-fixture.mjs');
 const row={inquiry_id:A,gmail_message_id:'estimate-mail',gmail_thread_id:'estimate-thread',direction:'outbound',sent_at:'2026-10-01T00:00:00Z',subject:'架空の見積送信',to_addresses:['fixture@example.invalid'],attachment_metadata:[1,2].map(n=>({id:'indexed-'+n,part_id:String(n),filename:'見積_fixture_'+n+'.pdf',mime_type:'application/pdf',size:71000}))};
 values['/data/mail/'+A]=[row,{...row,gmail_message_id:'resend-mail',sent_at:'2026-10-02T00:00:00Z',attachment_metadata:[row.attachment_metadata[0]]}];
 values['/data/sent-estimates/'+A]={messages:[{...row,attachment_metadata:row.attachment_metadata.map(a=>({...a,id:a.part_id}))}],unknown:[]};
 const root=path.resolve(__dirname,'..'),calls=[];
 const server=http.createServer((req,res)=>{const f=path.join(root,new URL(req.url,'http://localhost').pathname);if(!f.startsWith(root+path.sep))return res.writeHead(403).end();try{res.setHeader('content-type',f.endsWith('.mjs')?'text/javascript':f.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(f));}catch{res.writeHead(404).end();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
 try{
  browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));await page.route(/^https?:\/\/(?!127\.0\.0\.1:)/,r=>r.abort());
  await page.route('**/pa-ui/js/integration.mjs',r=>r.fulfill({contentType:'text/javascript',body:"let valid=true;window.fixtureExpire=()=>{valid=false;};export const workspaceAuth={restore:async()=>({access_token:'fixture-only',expires_at:9999999999}),current:async()=>{if(!valid)throw Error('login_required');return {access_token:'fixture-only',expires_at:9999999999};},logout:async()=>{},subscribe:()=>{}};export const readUrl=p=>'/api/pa-workspace-read?path='+encodeURIComponent(p);export const legacyUrl=()=>{throw Error('forbidden_legacy')};"}));
  await page.route('**/api/pa-workspace-read?**',async r=>{const p=new URL(r.request().url()).searchParams.get('path');calls.push(p);if(/\/data\/(material|document|mail-attachment|sent-estimate-attachment)\//.test(p))return r.fulfill({contentType:'application/pdf',body:pdf()});return r.fulfill({json:{ok:true,result:values[p]??[]}});});
  await page.goto('http://127.0.0.1:'+server.address().port+'/pa-admin.html');await page.locator('[data-case="'+A+'"]').click();await page.locator('.request-original').first().waitFor();
  await page.getByRole('button',{name:'資料',exact:true}).last().click();await page.locator('#material-source').selectOption('gmail');
  await page.waitForFunction(()=>document.querySelectorAll('#material-grid .material-card').length===3);
  assert.equal(await page.locator('#material-grid .material-card').count(),3,'Two unique attachments plus distinct resend preserved');
  assert.equal(await page.locator('#material-grid summary').filter({hasText:'統合元・送信履歴 2件'}).count(),2);
  await page.locator('#material-grid .material-thumb canvas').first().waitFor();
  const originals=()=>calls.filter(p=>/\/data\/(material|document|mail-attachment|sent-estimate-attachment)\//.test(p)).length;
  await page.waitForFunction(()=>[...document.querySelectorAll('#material-grid .material-thumb')].every(b=>b.querySelector('canvas')));
  const warm=originals();await page.locator('#material-search').fill('見積_fixture');await page.waitForFunction(()=>[...document.querySelectorAll('#material-grid .material-thumb')].every(b=>b.querySelector('canvas')));assert.equal(originals(),warm);
  await page.getByRole('button',{name:'見積・受注',exact:true}).click();await page.locator('#sent-estimate-grid .material-card').first().waitFor();
  assert.equal(await page.locator('#sent-estimate-grid .material-card').count(),3);assert.equal(await page.locator('#sent-estimate-grid summary').filter({hasText:'統合元・送信履歴 2件'}).count(),2);
  assert.equal(await page.locator('#estimate-history-grid .material-card').count(),3,'Commercial estimate revisions preserved');
  const merged=page.locator('#sent-estimate-grid .material-card').filter({hasText:'統合元・送信履歴 2件'}).first();await merged.locator('summary').filter({hasText:'統合元・送信履歴'}).click();const history=await merged.innerText();assert(history.includes('Gmail送信添付')&&history.includes('Gmail送信済み見積')&&history.includes('indexed-1')&&history.includes('MIME part 1'));
  const beforeFull=originals();await merged.locator('.material-thumb').click();await page.locator('dialog[open] canvas').waitFor();assert(originals()>beforeFull);await page.getByRole('button',{name:'閉じる',exact:true}).click();
  if(process.env.PAUI029_SHOTS)for(const width of [1440,390]){await page.setViewportSize({width,height:900});await page.screenshot({path:path.join(process.env.PAUI029_SHOTS,'dedupe-estimate-'+width+'.png')});}
  await page.locator('[data-case="'+B+'"]').click();await page.locator('.request-original').first().waitFor();await page.locator('[data-case="'+A+'"]').click();await page.locator('.request-original').first().waitFor();await page.getByRole('button',{name:'資料',exact:true}).last().click();await page.locator('#material-source').selectOption('gmail');await page.locator('#material-grid .material-thumb canvas').first().waitFor();assert(originals()>beforeFull+1,'Case switch cannot reuse prior private originals');
  await page.evaluate(()=>fixtureExpire());await page.locator('#material-grid .material-thumb').first().click();await page.locator('#login-screen').waitFor({state:'visible'});assert.equal(await page.locator('dialog[open]').count(),0);
  assert.deepEqual(errors,[]);console.log(JSON.stringify({status:'PASS',scope:'LOCAL_FIXTURE_ONLY',warehouse_cards:3,estimate_cards:3,merged_cards:2,preserved_resend:1,preserved_commercial_revisions:3,source_records_per_merge:2,filter_gets:0,full_preview_fresh:true,case_switch_clear:true,expired_auth_clear:true,page_errors:0}));
 }finally{if(browser)await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
