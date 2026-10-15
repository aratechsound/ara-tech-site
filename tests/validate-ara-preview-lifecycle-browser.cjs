'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222',baseline=process.argv.includes('--reproduce-baseline');
function pdfBytes(){
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Count 2 /Kids [3 0 R 4 0 R] >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Contents 5 0 R >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Contents 6 0 R >>','<< /Length 0 >>\nstream\n\nendstream','<< /Length 0 >>\nstream\n\nendstream'];
 let pdf='%PDF-1.4\n',offsets=[];for(let i=0;i<objects.length;i++){offsets.push(pdf.length);pdf+=(i+1)+' 0 obj\n'+objects[i]+'\nendobj\n';}const at=pdf.length;pdf+='xref\n0 7\n0000000000 65535 f \n'+offsets.map(o=>String(o).padStart(10,'0')+' 00000 n \n').join('')+'trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n'+at+'\n%%EOF';return Buffer.from(pdf);
}
(async()=>{
 const server=http.createServer((req,res)=>{const f=path.join(root,new URL(req.url,'http://localhost').pathname);if(!f.startsWith(root+path.sep))return res.writeHead(403).end();try{res.setHeader('content-type',f.endsWith('.mjs')?'text/javascript':f.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(f));}catch{res.writeHead(404).end();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({headless:true});let pending=[];
 try{
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[],reads=[];let delayed=true,deny=false,holdOriginal=false,releaseOriginal;
  page.on('pageerror',e=>errors.push(e.message));await page.route(/^https?:\/\/(?!127\.0\.0\.1:)/,r=>r.abort());
  await page.route('**/pa-ui/js/integration.mjs',r=>r.fulfill({contentType:'text/javascript',body:"const s={access_token:'fixture-only',expires_at:9999999999};export const workspaceAuth={restore:async()=>s,current:async()=>s,logout:async()=>{window.fixtureLogout=(window.fixtureLogout||0)+1;},subscribe:cb=>{window.fixtureAuthChange=cb;}};export const readUrl=p=>'/api/pa-workspace-read?path='+encodeURIComponent(p);export const legacyUrl=()=>{throw Error('legacy forbidden');};"}));
  await page.addInitScript(()=>{const make=URL.createObjectURL.bind(URL),drop=URL.revokeObjectURL.bind(URL);window.fixtureURLs={made:[],released:[]};URL.createObjectURL=b=>{const u=make(b);fixtureURLs.made.push(u);return u;};URL.revokeObjectURL=u=>{fixtureURLs.released.push(u);drop(u);};});
  const mail={inquiry_id:A,gmail_message_id:'incoming',gmail_thread_id:'thread',direction:'inbound',subject:'Fixture PDF',received_at:'2026-10-14T00:00:00Z',attachment_metadata:[{id:'attachment',part_id:'1',filename:'fixture-scenario.pdf',mime_type:'application/pdf',size:900}]};
  await page.route('**/api/pa-workspace-read?**',async r=>{
   const p=new URL(r.request().url()).searchParams.get('path');reads.push(p);assert.equal(r.request().method(),'GET');let result=[];
   if(p==='/data/cases')result={cases:[{id:A,event_name:'Fixture A',status:'new',case_type:'PA_EVENT'},{id:B,event_name:'Fixture B',status:'new',case_type:'PA_EVENT'}],progress:[]};
   else if(p.startsWith('/data/mail-discovery/'))result={enabled:false};
   else if(p==='/data/mail/'+A)result=[mail];
   else if(p.startsWith('/data/commercial/'))result={estimates:[],offers:[],documents:[],billings:[]};
   else if(p.startsWith('/data/materials/'))result={cards:[],photos:[]};
   else if(p.startsWith('/data/sent-estimates/'))result={messages:[{...mail,gmail_message_id:'sent',direction:'outbound',subject:'Fixture sent PDF',attachment_metadata:[{...mail.attachment_metadata[0],filename:'見積書-fixture.pdf'}]}],unknown:[]};
   else if(p.startsWith('/data/mail-body/'))result={body_text:'Fixture body',body_state:'ready'};
   else if(p.startsWith('/data/mail-attachment/')||p.startsWith('/data/sent-estimate-attachment/')){
    if(deny)return r.fulfill({status:403,json:{ok:false,code:'attachment_mail_mismatch'}});
    if(holdOriginal)await new Promise(resolve=>{releaseOriginal=resolve;});
    return r.fulfill({contentType:'application/pdf',headers:{'X-PA-Attachment-Identity':JSON.stringify({verified:true,part_id:'1'})},body:pdfBytes()});
   }
   if(delayed&&p.startsWith('/data/case/'+A+'/')&&['audit','responses','deliveries'].some(n=>p.endsWith('/'+n)))await new Promise(resolve=>pending.push({p,resolve}));
   return r.fulfill({json:{ok:true,result}});
  });
  const start=async()=>{await page.goto('http://127.0.0.1:'+server.address().port+'/pa-admin.html');await page.locator('[data-case="'+A+'"]').click();await page.getByRole('button',{name:'資料',exact:true}).last().click();await page.getByRole('button',{name:'fixture-scenario.pdf の拡大プレビュー',exact:true}).waitFor();};
  const open=async(name='fixture-scenario.pdf の拡大プレビュー')=>{await page.getByRole('button',{name,exact:true}).click();await page.getByText('1 / 2ページ · 100%',{exact:true}).waitFor();await page.locator('dialog canvas').waitFor();};
  await start();await open();await page.getByRole('button',{name:'次のページ',exact:true}).click();await page.getByRole('button',{name:'拡大',exact:true}).click();await page.getByText('2 / 2ページ · 125%',{exact:true}).waitFor();await page.locator('dialog canvas[aria-label="PDF 2ページ"]').waitFor();
  await page.evaluate(()=>{window.fixtureDialog=document.querySelector('dialog');window.fixtureCanvas=fixtureDialog.querySelector('canvas');});
  await page.evaluate(()=>{window.fixtureRenderCount=0;new MutationObserver(()=>fixtureRenderCount++).observe(document.querySelector('#detail-card'),{childList:true});});
  const originalCount=reads.filter(p=>p.includes('/incoming/')).length;assert.equal(pending.length,3);
  for(const job of pending.splice(0)){
   const count=await page.evaluate(()=>fixtureRenderCount),response=page.waitForResponse(r=>new URL(r.url()).searchParams.get('path')===job.p);job.resolve();await response;await page.waitForFunction(count=>fixtureRenderCount>count,count);
   if(baseline){await page.locator('dialog').waitFor({state:'detached'});console.log('BASELINE_REPRODUCED: delayed loadSurface render disposes the open PDF');pending.forEach(x=>x.resolve());return;}
   await page.waitForFunction(()=>document.querySelector('#material-grid')?.children.length>0);assert.equal(await page.locator('dialog[open]').count(),1,'index update must preserve preview');
   assert.equal(await page.evaluate(()=>document.querySelector('dialog')===fixtureDialog&&fixtureDialog.querySelector('canvas')===fixtureCanvas),true,'same dialog and rendered page survive');
   await page.getByText('2 / 2ページ · 125%',{exact:true}).waitFor();
  }
  assert.equal(reads.filter(p=>p.includes('/incoming/')).length,originalCount,'no original refetch on index updates');
  await page.getByRole('button',{name:'閉じる',exact:true}).click();await page.locator('dialog').waitFor({state:'detached'});
  const released=await page.evaluate(()=>fixtureURLs.released.length);assert(released>0,'explicit close releases private URL');
  await open();await page.locator('[data-case="'+B+'"]').dispatchEvent('click');await page.getByRole('heading',{name:'Fixture B',exact:true}).waitFor();assert.equal(await page.locator('dialog').count(),0,'different case closes old PDF');
  delayed=false;await page.locator('[data-case="'+A+'"]').click();await page.getByRole('button',{name:'やり取り',exact:true}).click();await open();await page.getByRole('button',{name:'資料',exact:true}).last().dispatchEvent('click');await page.locator('dialog').waitFor({state:'detached'});
  await page.getByRole('button',{name:'見積・受注',exact:true}).click();await open('見積書-fixture.pdf の拡大プレビュー');await page.getByRole('button',{name:'閉じる',exact:true}).click();
  await page.getByRole('button',{name:'資料',exact:true}).last().click();await open();await page.locator('#sign-out').dispatchEvent('click');await page.locator('dialog').waitFor({state:'detached'});assert.equal(await page.evaluate(()=>fixtureLogout),1);
  await start();await open();await page.evaluate(()=>fixtureAuthChange('SIGNED_OUT',null));await page.locator('dialog').waitFor({state:'detached'});assert.equal(await page.locator('#login-screen').isVisible(),true);
  await start();await open();await page.evaluate(()=>fixtureAuthChange('TOKEN_REFRESHED',{access_token:'changed-fixture',expires_at:9999999999}));await page.locator('dialog').waitFor({state:'detached'});
  await start();deny=true;await page.getByRole('button',{name:'fixture-scenario.pdf の拡大プレビュー',exact:true}).click();await page.getByRole('dialog').getByText(/対応不明/).waitFor();assert.equal(await page.locator('dialog canvas').count(),0,'identity refusal has no rendered document');await page.getByRole('button',{name:'閉じる',exact:true}).click();deny=false;
  const idempotent=await page.evaluate(async()=>{const {createPrivateAssets}=await import('/pa-ui/js/private-assets.mjs');let destroys=0;const doc={destroy:async()=>{destroys++;}};class PDFWorker{constructor(){this.promise=Promise.resolve();}destroy(){}}const assets=createPrivateAssets({requestBlob:async()=>new Blob(['fixture']),authorize:async()=>{}});await assets.openPdf(new Blob(['fixture']),async()=>({PDFWorker,getDocument:()=>({promise:Promise.resolve(doc)})}));await assets.destroyPdf(doc);await assets.destroyPdf(doc);assets.clear();assets.clear();return destroys;});assert.equal(idempotent,1,'PDF destruction is exactly once');
  const expired=await page.evaluate(async()=>{const {createPreviewScope}=await import('/pa-ui/js/gallery.mjs');let closes=0;const scope=createPreviewScope({isCurrent:()=>true,expiresAt:Date.now()+30});scope.attach(()=>closes++);await new Promise(r=>setTimeout(r,60));scope.dispose();return {closes,current:scope.current()};});assert.deepEqual(expired,{closes:1,current:false},'auth expiry closes once without waiting for index refresh');
  holdOriginal=true;await page.getByRole('button',{name:'fixture-scenario.pdf の拡大プレビュー',exact:true}).click();await page.getByRole('dialog').getByText('原本を取得中…',{exact:true}).waitFor();await page.getByRole('button',{name:'閉じる',exact:true}).click();while(!releaseOriginal)await new Promise(r=>setTimeout(r,10));releaseOriginal();holdOriginal=false;await page.locator('dialog').waitFor({state:'detached'});
  assert.deepEqual(errors,[]);console.log(JSON.stringify({status:'PASS',late_index_updates:3,page_zoom_retained:true,same_dialog_and_canvas:true,no_refetch:true,mail_estimate_PDF:true,case_tab_logout_auth_close:true,identity_denied:true,explicit_and_pending_close:true,double_destroy_refused:true,writes:0}));
 }finally{pending.forEach(x=>x.resolve());await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
