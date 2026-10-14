'use strict';
const assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright');
(async()=>{
 const {A,B,values}=await import('./paui027-fixture.mjs');
 const root=path.resolve(__dirname,'..'),calls=[],writes=[],errors=[];let mode='unlinked',delay=false;
 const messages=['late','early'].map((id,i)=>({gmail_message_id:id,gmail_thread_id:'selected-thread',inquiry_id:A,direction:'inbound',from_address:'fixture@example.invalid',to_addresses:['aratechsound@gmail.com'],subject:'架空の案件確認 '+id,occurred_at:i?'2026-10-13T13:55:26+09:00':'2026-10-13T21:36:01+09:00',received_at:i?'2026-10-13T13:55:26+09:00':'2026-10-13T21:36:01+09:00',read_route:'live',index_state:'not_indexed',attachment_metadata:[],snippet:'架空のメール本文'}));
 const server=http.createServer((req,res)=>{const f=path.join(root,new URL(req.url,'http://localhost').pathname);if(!f.startsWith(root+path.sep))return res.writeHead(403).end();try{res.setHeader('content-type',f.endsWith('.mjs')?'text/javascript':f.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(f));}catch{res.writeHead(404).end();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
 try{
  browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:950}});page.on('pageerror',e=>errors.push(e.message));
  await page.route(/^https?:\/\/(?!127\.0\.0\.1:)/,r=>r.abort());
  await page.route('**/pa-ui/js/integration.mjs',r=>r.fulfill({contentType:'text/javascript',body:"export const workspaceAuth={restore:async()=>({access_token:'fixture-only',expires_at:9999999999}),current:async()=>({access_token:'fixture-only',expires_at:9999999999}),logout:async()=>{},subscribe:()=>{}};export const readUrl=p=>'/api/pa-workspace-read?path='+encodeURIComponent(p);export const legacyUrl=()=>{throw Error('forbidden_legacy')};"}));
  await page.route('**/api/pa-gmail',async r=>{assert.equal(r.request().method(),'POST');const body=r.request().postDataJSON();writes.push(body);assert.equal(body.action,'manual_link');assert.equal(body.inquiry_id,A);assert.equal(body.gmail_thread_id,'selected-thread');if(mode==='unknown')return r.fulfill({status:503,json:{ok:false,code:'service_unavailable'}});return r.fulfill({json:{ok:true,result:{linked:true}}});});
  await page.route('**/api/pa-workspace-read?**',async r=>{
   assert.equal(r.request().method(),'GET');const p=new URL(r.request().url()).searchParams.get('path');calls.push(p);
   if(p.startsWith('/data/mail-candidates/'))return r.fulfill({json:{ok:true,result:{customer_email:'fixture@example.invalid',matching_case_count:mode==='multiple'?2:1,candidates:[{gmail_thread_id:'selected-thread',subject:'架空の案件確認',latest_at:messages[0].occurred_at,address_match:true,related:true,already_linked:mode==='linked'}],auto_selected_thread_id:mode==='multiple'?null:'selected-thread',writes:false}}});
   if(p.startsWith('/data/mail-thread-preview/')){if(delay)await new Promise(resolve=>setTimeout(resolve,250));return r.fulfill({json:{ok:true,result:{gmail_thread_id:'selected-thread',already_linked:mode==='linked',messages,target_indexed_count:0,target_missing_ids:['late','early'],sync_thread_ids:['old-thread','selected-thread'],sync_message_count:4,sync_attachment_count:0,preflight_complete:mode!=='partial'}}});}
   if(p.startsWith('/data/mail-live/'))return r.fulfill({json:{ok:true,result:{messages,checks:[],status:'index_gap',checked_at:'2026-10-14T00:00:00Z'}}});
   if(p.startsWith('/data/mail-live-body/'))return r.fulfill({json:{ok:true,result:{gmail_message_id:p.split('/').at(-1),inquiry_id:A,body_text:'架空の新着メール本文',body_state:'ready'}}});
   return r.fulfill({json:{ok:true,result:values[p]??[]}});
  });
  const open=async()=>{await page.getByRole('button',{name:'顧客メールを関連付け',exact:true}).click();};
  const close=async()=>{await page.locator('#modal-close-top').click();};
  await page.goto('http://127.0.0.1:'+server.address().port+'/pa-admin.html');await page.locator('[data-case="'+A+'"]').click();await page.locator('[data-case="'+A+'"][aria-pressed="true"]').waitFor();await page.locator('[data-tab=conversation]').click();
  await page.getByText(/顧客メール候補 1スレッド/).waitFor();assert(calls.includes('/data/mail-candidates/'+A));assert.equal(writes.length,0);
  await open();await page.locator('#thread-link-confirm').waitFor();assert.equal(await page.locator('#thread-id').count(),0,'No thread-ID input');assert(await page.locator('#thread-link-confirm').isDisabled());assert.equal(writes.length,0,'Automatic selection and preview are read-only');
  assert((await page.locator('#thread-preview').innerText()).includes('全2スレッド・現在4メール'));if(process.env.PAUI031_SHOTS)await page.screenshot({path:path.join(process.env.PAUI031_SHOTS,'PAUI031_LINK_APPROVAL_FIXTURE.png')});
  await page.locator('#thread-owner-approved').check();await page.locator('#thread-link-confirm').dblclick();await page.getByText('操作結果を取得しました。案件の最新メールを読取確認しています。',{exact:true}).waitFor();assert.equal(writes.length,1,'Double click sends only one approved operation');await close();
  await page.locator('[data-message="late"]').waitFor();assert.equal(await page.locator('.mail-row').first().getAttribute('data-message'),'late');
  mode='linked';await open();await page.locator('#thread-reload').click();await page.locator('#thread-read-latest').waitFor();assert.equal(await page.locator('#thread-link-confirm').count(),0);await page.locator('#thread-read-latest').click();assert.equal(writes.length,1,'Already linked only reads');
  await page.getByRole('button',{name:'最新メールを取得',exact:true}).click();await page.locator('[data-message="late"]').waitFor();if(process.env.PAUI031_SHOTS)await page.screenshot({path:path.join(process.env.PAUI031_SHOTS,'PAUI031_MAIL_FIXTURE.png')});
  mode='multiple';await open();await page.locator('#thread-reload').click();await page.getByText(/同じ顧客の複数案件/).waitFor();assert.equal(await page.locator('#thread-link-confirm').count(),0,'Multiple cases do not auto-select');await page.locator('[data-choose-thread]').click();await page.locator('#thread-link-confirm').waitFor();assert(await page.locator('#thread-link-confirm').isDisabled());await close();
  mode='partial';await open();await page.locator('#thread-reload').click();await page.locator('#thread-owner-approved').check();assert(await page.locator('#thread-link-confirm').isDisabled(),'Incomplete preflight refuses submission');await close();
  // A fresh document/session tests an uncertain first write without the prior
  // successful attempt lock. No network operation can escape the fixture.
  mode='unknown';await page.reload();await page.locator('[data-case="'+A+'"]').click();await page.locator('[data-case="'+A+'"][aria-pressed="true"]').waitFor();await page.locator('[data-tab=conversation]').click();await open();await page.locator('#thread-owner-approved').check();await page.locator('#thread-link-confirm').click();await page.locator('#thread-results').filter({hasText:/結果UNKNOWN/}).waitFor();assert.equal(writes.length,2);await close();await open();await page.locator('#thread-owner-approved').check();assert(await page.locator('#thread-link-confirm').isDisabled(),'UNKNOWN cannot re-submit in same session');await close();
  delay=true;await open();await close();await page.locator('[data-case="'+B+'"]').click();await new Promise(resolve=>setTimeout(resolve,350));assert(!await page.locator('#modal-wrap').evaluate(e=>e.classList.contains('open')));assert.equal(writes.length,2,'Stale case never writes');
  assert.deepEqual(errors,[]);console.log(JSON.stringify({status:'PASS',scope:'LOCAL_FIXTURE_ONLY',customer_address_discovery:true,no_thread_id_input:true,owner_gate:true,multiple_cases_require_selection:true,already_linked_no_write:true,unknown_no_retry:true,stale_case_rejected:true,newest_first:true,production_writes:0}));
 }finally{if(browser)await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
