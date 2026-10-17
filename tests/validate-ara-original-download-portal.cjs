'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
// Only the browser needs UTF-8 filenames; keep the CI/DB locale unchanged.
const {chromium}=require('playwright');
(async()=>{
 const data=await import('./paui027-fixture.mjs'),root=path.resolve(__dirname,'..'),pdf=Buffer.from(data.pdf()),image=Buffer.from(data.image,'base64'),audio=Buffer.from('ID3fixture-original-audio');
 const dialog=fs.readFileSync(path.join(root,'pa-case-portal.html'),'utf8').match(/<dialog id="preview-dialog"[\s\S]*?<\/dialog>/)[0];
 const html='<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/pa-case-portal.css"><main><section id="documents"></section><section id="photos"></section><section id="performers"></section></main>'+dialog+`<script type="module">
 import {createPortalDocumentView} from '/pa-ui/js/portal-document-view.mjs';
 import * as pdfjs from '/pa-ui/vendor/pdf.mjs';pdfjs.GlobalWorkerOptions.workerSrc='/pa-ui/vendor/pdf.worker.mjs';
 const items=[{key:'pdf',asset_id:'pdf',filename:'過去版の台本.pdf',mime_type:'application/pdf'},{key:'audio',asset_id:'audio',filename:'音源.mp3',mime_type:'audio/mpeg'},{key:'image',asset_id:'image',filename:'写真.png',mime_type:'image/png'}];
 let expired=false;const view=createPortalDocumentView({getAttachmentRecord:async(item)=>{if(expired)throw Error('link_expired');const blob=await(await fetch('/original/'+item.asset_id)).blob();return {blob,url:URL.createObjectURL(blob)};},getPdfjs:async()=>pdfjs,orgText:(k,p)=>({download:'ダウンロード',orgLargePreview:'大きく見る',orgOriginalError:'原本を取得できません',orgPage:'PDFページ'}[k]||k),sourceLabel:()=>'',documentTime:()=>'',showToast:message=>document.body.dataset.error=message});
 document.querySelector('#documents').append(view.makeDocumentCard(items[0]),view.makeDocumentCard(items[1]));document.querySelector('#photos').append(view.makePhotoTile(items[2]));document.querySelector('#performers').append(view.makePerformerDocument(items[1]));
 document.querySelector('#preview-close').onclick=()=>view.closePreview();window.expire=()=>{expired=true;view.clear();};
 </script>`;
 const requests=[];const server=http.createServer((req,res)=>{requests.push({url:req.url,method:req.method});if(req.url==='/test'){res.setHeader('Content-Type','text/html');return res.end(html);}if(req.url.startsWith('/original/')){const key=req.url.split('/').at(-1),bytes=key==='pdf'?pdf:key==='image'?image:audio;res.setHeader('Content-Type',key==='pdf'?'application/pdf':key==='image'?'image/png':'audio/mpeg');return res.end(bytes);}const p=path.join(root,decodeURIComponent(req.url));if(!p.startsWith(root+path.sep)||!fs.existsSync(p)){res.writeHead(404);return res.end();}res.setHeader('Content-Type',p.endsWith('.mjs')?'text/javascript':p.endsWith('.css')?'text/css':'application/octet-stream');res.end(fs.readFileSync(p));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({headless:true,env:{...process.env,LANG:'C.UTF-8',LC_ALL:'C.UTF-8'}}),page=await browser.newPage({acceptDownloads:true,viewport:{width:1280,height:900}}),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.route(/^https?:\/\/(?!127\.0\.0\.1:)/,r=>r.abort());
 async function save(button,name,bytes){const [d]=await Promise.all([page.waitForEvent('download'),button.click()]);assert.equal(d.suggestedFilename(),name);assert.deepEqual(fs.readFileSync(await d.path()),bytes);}
 try{
  await page.goto('http://127.0.0.1:'+server.address().port+'/test');await page.locator('#documents .document-card').first().waitFor();
  await save(page.locator('#documents .document-card').nth(1).locator('.document-download'),'音源.mp3',audio);
  await page.locator('#documents .document-card').first().getByRole('button',{name:'大きく見る',exact:true}).click();await page.locator('#preview-dialog-body canvas').first().waitFor();await save(page.locator('dialog [data-original-download]'),'過去版の台本.pdf',pdf);await page.locator('#preview-close').click();
  await save(page.locator('#photos .document-download'),'写真.png',image);await save(page.locator('#performers .document-download'),'音源.mp3',audio);
  await page.setViewportSize({width:390,height:844});await save(page.locator('#documents .document-card').nth(1).locator('.document-download'),'音源.mp3',audio);
  let saves=0;page.on('download',()=>saves++);await page.evaluate(()=>window.expire());await page.locator('#documents .document-card').nth(1).locator('.document-download').click();await page.waitForFunction(()=>document.body.dataset.error==='原本を取得できません');assert.equal(saves,0);assert.equal(await page.locator('dialog[open]').count(),0);assert.deepEqual(errors,[]);assert(requests.every(r=>r.method==='GET'));
  console.log(JSON.stringify({status:'PASS',actual_shared_portal_source:true,actual_nested_dialog:true,cards_photos_performer:true,pdf_preview_original:true,nonpreview_audio:true,desktop_mobile:true,expired_scope_refuses:true,network_writes:0}));
 }finally{await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
