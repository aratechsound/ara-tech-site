'use strict';
const assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),os=require('node:os');
const {chromium}=require('playwright'),f=require('./validate-ara-original-download.cjs');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
(async()=>{
 const fixture=await import('./paui027-fixture.mjs'),values=structuredClone(fixture.values),A=f.A,B=fixture.B;
 f.files[0][2]=Buffer.from(fixture.pdf());f.files[8][2]=Buffer.from(fixture.image,'base64');
 const metadata=()=>f.files.map(([filename,mime_type,b],i)=>({id:'att'+i,part_id:String(i+1),filename,mime_type,size:b.length,sha256:sha(b)}));
 values['/data/cases'].quote_monitor=false;
 values['/data/mail/'+A]=['received','sent'].map((id,i)=>({inquiry_id:A,gmail_message_id:id,gmail_thread_id:'thread1',direction:i?'outbound':'inbound',subject:i?'送信添付（隔離）':'受信音源と資料（隔離）',from_address:'fixture@example.invalid',to_addresses:['fixture@example.invalid'],received_at:'2026-10-16T00:00:00Z',body_text:'実際のCASE DESKを使う隔離試験です。',attachment_metadata:metadata()}));
 values['/data/materials/'+A]={cards:[{id:f.D,title:'各版の保存資料',current_version_id:f.D,versions:[{id:f.D,display_filename:'台本.pdf',mime_type:'application/pdf',version_label:'v1',source_type:'portal_upload',source_ref:{sha256:sha(f.files[0][2])}}]}],photos:[]};
 values['/data/commercial/'+A]={documents:[{id:f.D,original_filename:'台本.pdf',mime_type:'application/pdf',sha256:sha(f.files[0][2])}],estimates:[],offers:[{id:f.D,version:7}],billings:[]};
 const keys=['GMAIL_CLIENT_ID','GMAIL_CLIENT_SECRET','GMAIL_REFRESH_TOKEN','GMAIL_SENDER_ADDRESS','GMAIL_REPLY_TO'],saved=keys.map(k=>process.env[k]);keys.forEach(k=>process.env[k]=k.endsWith('ADDRESS')||k.endsWith('TO')?'fixture@example.invalid':'fixture-only');
 const root=path.resolve(__dirname,'..'),calls=[],errors=[];let hold=false,release,corruptDigest=false;
 const server=http.createServer(async(req,res)=>{
  try{const q=new URL(req.url,'http://localhost');
   if(q.pathname==='/api/pa-workspace-read'){
    const p=q.searchParams.get('path');calls.push({path:p,method:req.method});
    if(p.startsWith('/data/download/')){const set=res.setHeader.bind(res);res.setHeader=(name,value)=>set(name,name==='X-PA-Original-SHA256'&&corruptDigest?'0'.repeat(64):value);if(hold)await new Promise(r=>release=r);return f.handler(req,res);}
    if(/\/data\/(mail-attachment|material|document)\//.test(p))return f.handler(req,res);
    res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({ok:true,result:values[p]??[]}));
   }
   if(q.pathname.startsWith('/api/')){calls.push({path:q.pathname,method:req.method});res.writeHead(403,{'Content-Type':'application/json'});return res.end('{"ok":false,"code":"invalid_origin"}');}
   if(q.pathname==='/pa-ui/js/integration.mjs'){res.setHeader('Content-Type','text/javascript');return res.end("let logged=true;const session={access_token:"+JSON.stringify(f.auth.slice(7))+"};export const workspaceAuth={restore:async()=>logged?session:null,current:async()=>logged?session:null,logout:async()=>{logged=false;},subscribe:()=>{}};export const readUrl=p=>'/api/pa-workspace-read?path='+encodeURIComponent(p);export const legacyUrl=()=>{throw Error('legacy_forbidden')};");}
   const target=path.join(root,q.pathname==='/'?'pa-admin.html':decodeURIComponent(q.pathname));if(!target.startsWith(root+path.sep)||!fs.statSync(target).isFile()){res.writeHead(404);return res.end();}
   res.setHeader('Content-Type',target.endsWith('.mjs')||target.endsWith('.js')?'text/javascript':target.endsWith('.css')?'text/css':target.endsWith('.html')?'text/html':'application/octet-stream');res.end(fs.readFileSync(target));
  }catch(e){res.writeHead(500);res.end('fixture_error');errors.push(e.message);}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({headless:true}),context=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true}),page=await context.newPage(),downloads=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='warning'&&/download/i.test(m.text()))console.error('BROWSER_DOWNLOAD_WARNING '+m.text());});page.on('download',d=>downloads.push(d));await page.route(/^https?:\/\/(?!127\.0\.0\.1:)/,r=>r.abort());
 const card=(host,filename)=>page.locator(host+' .material-card').filter({has:page.locator('.material-name').getByText(filename,{exact:true})}).first();
 async function save(control,index){await new Promise(r=>setTimeout(r,500));const before=calls.length;let pair;try{pair=await Promise.all([page.waitForEvent('download',{timeout:10000}),control.click()]);}catch(e){console.error(JSON.stringify({index,calls:calls.slice(-5),card:await control.evaluate(e=>e.closest('.material-card')?.innerText||e.closest('dialog')?.innerText)}));throw e;}const [d]=pair;assert.equal(d.suggestedFilename(),f.files[index][0]);const p=await d.path();assert.deepEqual(fs.readFileSync(p),f.files[index][2]);const added=calls.slice(before);assert(added.some(c=>c.path.startsWith('/data/download/')));assert(!added.some(c=>c.method!=='GET'),'Download must never synchronize, send, classify or adopt');}
 try{
  await page.goto('http://127.0.0.1:'+server.address().port+'/pa-admin.html');await page.locator('[data-case="'+A+'"]').click();await page.locator('[data-tab="conversation"]').click();await page.locator('.mail-row').first().waitFor();
  await save(card('.mail-row','日本語の音源.mp3').locator('.original-download'),1);
  const outbound=page.locator('.mail-row').filter({hasText:'送信添付（隔離）'});await save(outbound.locator('.material-card').filter({hasText:'資料.xlsx'}).locator('.original-download'),4);
  const mp3=card('.mail-row','日本語の音源.mp3');const n=downloads.length;await mp3.locator('.material-thumb').click();await page.getByRole('dialog').getByText(/内容プレビュー非対応/).waitFor();assert.equal(downloads.length,n);await save(page.getByRole('dialog').locator('.original-download'),1);await page.getByRole('dialog').getByRole('button',{name:'閉じる',exact:true}).click();
  await page.locator('[data-tab="documents"]').click();await page.locator('#material-grid .material-card').first().waitFor();
  for(let i=0;i<f.files.length;i++)await save(card('#material-grid',f.files[i][0]).locator('.original-download'),i);
  const pdf=card('#material-grid','台本.pdf');await pdf.locator('.material-thumb').click();await page.getByRole('dialog').getByText(/1 \/ 3ページ/).waitFor();await save(page.getByRole('dialog').locator('.original-download'),0);await page.getByRole('dialog').getByRole('button',{name:'次のページ'}).click();await page.getByRole('dialog').getByText(/2 \/ 3ページ/).waitFor();await page.getByRole('dialog').getByRole('button',{name:'閉じる',exact:true}).click();
  assert.equal(await page.evaluate(()=>globalThis.pwned),undefined);
  await page.setViewportSize({width:390,height:844});await save(card('#material-grid','日本語の音源.mp3').locator('.original-download'),1);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2));
  if(process.env.PAUI060_OUT){fs.mkdirSync(process.env.PAUI060_OUT,{recursive:true});await page.screenshot({path:path.join(process.env.PAUI060_OUT,'downloads-mobile.png')});await page.setViewportSize({width:1440,height:1000});await page.screenshot({path:path.join(process.env.PAUI060_OUT,'downloads-desktop.png')});}
  const prior=downloads.length;corruptDigest=true;await card('#material-grid','日本語の音源.mp3').locator('.original-download').click();await card('#material-grid','日本語の音源.mp3').getByText('原本の整合性検証に失敗',{exact:true}).waitFor();assert.equal(downloads.length,prior);corruptDigest=false;hold=true;await card('#material-grid','日本語の音源.mp3').locator('.original-download').click();for(let i=0;i<200&&!release;i++)await new Promise(r=>setTimeout(r,10));assert(release,'Held download started');await page.locator('[data-case="'+B+'"]').click();release();hold=false;await page.locator('#title').getByText('広島都市学園大学みやこ祭（匿名fixture）',{exact:true}).waitFor();await page.waitForTimeout(150);assert.equal(downloads.length,prior,'Stale case must not save');
  await page.locator('[data-case="'+A+'"]').click();await page.locator('[data-tab="documents"]').click();await card('#material-grid','日本語の音源.mp3').waitFor();hold=true;release=null;await card('#material-grid','日本語の音源.mp3').locator('.original-download').click();for(let i=0;i<200&&!release;i++)await new Promise(r=>setTimeout(r,10));assert(release,'Held logout download started');await page.getByRole('button',{name:'ログアウト',exact:true}).click();release();hold=false;await page.waitForTimeout(150);assert.equal(downloads.length,prior,'Logout must not save');assert.equal(await page.locator('dialog[open]').count(),0);
  assert.deepEqual(errors,[]);assert(!calls.some(c=>/sent_quote_adopt|send_reply|case_discovery_sync|dispatch|issue_confirmation/.test(c.path)));
  console.log(JSON.stringify({status:'PASS',actual_case_desk:true,desktop_mobile:true,inbound_mp3:true,outbound_office:true,warehouse_formats:f.files.length,pdf_preview_and_save:true,preview_page_preserved:true,japanese_filename_bytes_sha:true,unsupported_not_executed:true,case_logout_races:true,download_business_mutations:0,real_sends:0}));
 }finally{release?.();await browser.close();await new Promise(r=>server.close(r));keys.forEach((k,i)=>saved[i]===undefined?delete process.env[k]:process.env[k]=saved[i]);}
})().catch(e=>{console.error(e);process.exitCode=1;});
