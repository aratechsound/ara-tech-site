'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
(async()=>{
 const server=http.createServer((req,res)=>{const f=path.join(root,new URL(req.url,'http://localhost').pathname);if(!f.startsWith(root+path.sep))return res.writeHead(403).end();try{res.setHeader('content-type',f.endsWith('.mjs')?'text/javascript':f.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(f));}catch{res.writeHead(404).end();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[],calls=[];let failed=true,historyFailure=false,sendMode='success',sends=0;
  page.on('pageerror',e=>errors.push(e.message));await page.route(/^https?:\/\/(?!127\.0\.0\.1:)/,r=>r.abort());
  await page.route('**/pa-ui/js/integration.mjs',r=>r.fulfill({contentType:'text/javascript',body:"const s={access_token:'fixture-only',expires_at:9999999999};export const workspaceAuth={restore:async()=>s,current:async()=>s,logout:async()=>{},subscribe:()=>{}};export const readUrl=p=>'/api/pa-workspace-read?path='+encodeURIComponent(p);export const legacyUrl=()=>{throw Error('forbidden legacy');};"}));
  const rows=['first','second'].map(id=>({inquiry_id:A,gmail_message_id:id,gmail_thread_id:'thread',direction:'inbound',from_address:'fixture@example.test',to_addresses:['aratechsound@gmail.com'],cc_addresses:[],subject:'Fixture',body_text:'Synthetic only',received_at:'2026-10-15T00:00:00Z',attachment_metadata:[{id:'attachment',part_id:'1',filename:'fixture.pdf',mime_type:'application/pdf',size:20}]}));
  await page.route('**/api/pa-workspace-read?**',r=>{const p=new URL(r.request().url()).searchParams.get('path');let result=[];
   if(p==='/data/cases')result={cases:[{id:A,event_name:'Fixture A',status:'new',case_type:'PA_EVENT'},{id:B,event_name:'Fixture B',status:'new',case_type:'PA_EVENT'}],progress:[]};
   else if(p==='/data/mail/'+A){if(historyFailure)return r.fulfill({status:503,json:{ok:false,code:'fixture_history_failure'}});result=rows;}
   else if(p.startsWith('/data/mail-discovery/'))result={enabled:false};
   else if(p.startsWith('/data/commercial/'))result={estimates:[],offers:[],documents:[],billings:[]};
   else if(p.startsWith('/data/materials/'))result={cards:[],photos:[]};
   else if(p.startsWith('/data/mail-attachment/'))return r.fulfill({status:403,json:{ok:false,code:'fixture_no_original'}});
   return r.fulfill({json:{ok:true,result}});
  });
  await page.route('**/api/pa-portal',r=>{const p=r.request().postDataJSON();assert.equal(p.preserve_existing,true);assert.equal(p.gmail_thread_id,'thread');assert.equal(p.inquiry_id,A);calls.push(p.gmail_message_id);return r.fulfill(failed&&p.gmail_message_id==='first'?{status:503,json:{ok:false,code:'service_unavailable'}}:{json:{ok:true,result:{detected:0,pending:3}}});});
  await page.route('**/api/pa-gmail',r=>{const p=r.request().postDataJSON();assert.equal(p.inquiry_id,A);assert.equal(p.reply_source_message_id,'first');assert.equal(p.reply_source_thread_id,'thread');
   if(p.action==='send_reply'){sends++;if(sendMode==='unknown')return r.abort();if(sendMode==='historyFailure')historyFailure=true;return r.fulfill({json:{ok:true,result:{gmail_message_id:'sentFixture',gmail_thread_id:'thread'}}});}
   assert.equal(p.action,'reply_preview');return r.fulfill({json:{ok:true,preview:{inquiry_id:A,gmail_thread_id:'thread',reply_source_message_id:'first',reply_source_explicit:true,mode:'normal',recipient:'fixture@example.test',cc_addresses:[],subject:'Re: Fixture',body:p.body,html:'<p>Fixture</p>',attachments:[],confirmation_token:'fixture-only',expires_at:new Date(Date.now()+300000).toISOString()}}});
  });
  await page.goto('http://127.0.0.1:'+server.address().port+'/pa-admin.html');await page.locator('[data-case="'+A+'"]').click();await page.getByRole('button',{name:'やり取り',exact:true}).click();
  await page.getByRole('button',{name:'索引済み添付を再照合（最大20通）',exact:true}).click();await page.locator('#portal-candidate-status').getByText(/一部未確認.*first/).waitFor();assert.deepEqual(calls,['first','second']);assert.doesNotMatch(await page.locator('#portal-candidate-status').textContent(),/連携済み/);
  failed=false;await page.locator('[data-portal-message=first]').click();await page.locator('#portal-candidate-status').getByText(/連携済み/).waitFor();assert.deepEqual(calls,['first','second','first']);
  const open=async text=>{await page.locator('[data-reply-message=first]').click();const d=page.getByRole('dialog',{name:'Gmail返信作成'});await d.getByLabel('本文',{exact:true}).fill(text);await d.getByRole('button',{name:'返信プレビュー',exact:true}).click();return d;};
  const send=async d=>{await d.getByRole('button',{name:'送信内容を最終確認',exact:true}).click();await d.getByRole('checkbox').check();await d.getByRole('button',{name:'最終確認して送信',exact:true}).click();};
  const close=async d=>{await d.getByRole('button',{name:'返信を閉じる',exact:true}).click();const discard=d.getByRole('button',{name:'下書きを破棄',exact:true});if(await discard.count())await discard.click();};
  let d=await open('Success fixture');await send(d);await d.getByRole('status').getByText('送信済み。履歴を更新しました。',{exact:true}).waitFor();assert.equal(sends,1);await close(d);
  d=await open('Success fixture');await d.getByRole('status').getByText(/同じ返信の送信操作を実行済み/).waitFor();assert.equal(await d.getByRole('button',{name:'送信内容を最終確認',exact:true}).count(),0);assert.equal(sends,1);await close(d);
  sendMode='historyFailure';d=await open('History failure fixture');await send(d);await d.getByRole('status').getByText(/送信済み。履歴更新は未確認/).waitFor();assert.equal(sends,2);assert.equal(await d.getByRole('button',{name:'最終確認して送信',exact:true}).isDisabled(),true);await close(d);
  historyFailure=false;await page.reload();await page.locator('[data-case="'+A+'"]').click();await page.getByRole('button',{name:'やり取り',exact:true}).click();sendMode='unknown';d=await open('Unknown provider fixture');await send(d);await d.getByRole('status').getByText(/送信結果は未確認/).waitFor();assert.equal(sends,3);await close(d);
  d=await open('Unknown provider fixture');await d.getByRole('status').getByText(/同じ返信の送信操作を実行済み/).waitFor();assert.equal(sends,3);await close(d);
  await page.locator('[data-case="'+B+'"]').click();await page.getByRole('heading',{name:'Fixture B',exact:true}).waitFor();assert.equal(await page.locator('[data-portal-message]').count(),0);
  await page.evaluate(async()=>{
   const {createGallery,createPreviewScope}=await import('/pa-ui/js/gallery.mjs');let drawing=0;
   window.fixtureZoom={};const pdf={numPages:2,getPage:async()=>({getViewport:({scale})=>({width:100*scale,height:100*scale}),render:()=>({promise:++drawing===2?new Promise(resolve=>{fixtureZoom.release=resolve;}):Promise.resolve()})})};
   const assets={record:async()=>({blob:new Blob(['fixture'])}),openPdf:async()=>pdf,release:()=>{},destroyPdf:async()=>{},thumbnail:async()=>{throw Error('fixture thumbnail omitted');}};
   const host=document.createElement('div');document.body.append(host);fixtureZoom.scope=createPreviewScope({isCurrent:()=>true});fixtureZoom.gallery=createGallery({isCurrent:()=>true,assets,previewScope:fixtureZoom.scope});fixtureZoom.gallery.mount(host,[{key:'zoom-fixture',asset_id:'fixture',filename:'zoom-fixture.pdf',mime_type:'application/pdf'}]);
  });
  await page.getByRole('button',{name:'zoom-fixture.pdf の拡大プレビュー',exact:true}).click();await page.getByText('1 / 2ページ · 100%',{exact:true}).waitFor();await page.getByRole('button',{name:'拡大',exact:true}).click();await page.waitForFunction(()=>!!fixtureZoom.release);assert.equal(await page.getByText('1 / 2ページ · 125%',{exact:true}).count(),0,'zoom label must not commit before its rendered canvas');
  await page.evaluate(()=>fixtureZoom.release());await page.getByText('1 / 2ページ · 125%',{exact:true}).waitFor();await page.evaluate(()=>{fixtureZoom.scope.dispose();fixtureZoom.gallery.dispose();});assert.equal(await page.locator('dialog').count(),0);assert.deepEqual(errors,[]);
  console.log(JSON.stringify({status:'PASS',existing_index_recheck:true,individual_failure_visible:true,later_message_continues:true,explicit_retry_recovers:true,reply_success_history:true,known_sent_history_unknown:true,provider_unknown_no_retry:true,reopen_duplicate_blocked:true,case_switch_no_stale_data:true,mocked_send_count:sends,real_provider_sends:0}));
 }finally{await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
