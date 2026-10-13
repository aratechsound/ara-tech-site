'use strict';
const assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {chromium}=require('playwright');
const {createReadHandler}=require('../api/_pa-workspace-read.cjs');
const {canonicalAssetKey}=require('../api/_pa-portal-candidates.cjs');
(async()=>{
 const {A,values,pdf}=await import('./paui027-fixture.mjs');
 const P='33333333-3333-4333-8333-333333333333',ids=[1,2,3,4].map(n=>`44444444-4444-4444-8444-${String(n).padStart(12,'0')}`);
 const jpeg=Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAAEAAQDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDxyiiiv3E8w//Z','base64');
 const bytes=[Buffer.from(pdf()),Buffer.from(pdf()),jpeg,jpeg],names=['会場図_fixture.pdf','配置図_fixture.pdf','撮影_fixture.JPG','参考_fixture.JPG'];
 const attachments=bytes.map((b,i)=>({id:'indexed-'+i,part_id:String(i+1),filename:names[i],mime_type:i<2?'application/pdf':'image/jpeg',size:b.length}));
 const assets=attachments.map((a,i)=>({id:ids[i],card_id:P,portal_id:P,source_type:'gmail_attachment',source_ref:{gmail_message_id:'mail1',gmail_attachment_id:'historical-'+i},display_filename:a.filename,mime_type:a.mime_type,gmail_part_id:a.part_id,canonical_attachment_key:canonicalAssetKey('mail1',a.part_id),source_byte_size:a.size,source_content_sha256:crypto.createHash('sha256').update(bytes[i]).digest('hex'),created_at:'2026-10-01T00:00:00Z'}));
 let missing=false;const upstream=[];
 const provider={message:async()=>({id:'mail1',threadId:'thread1'}),attachment:async({metadata})=>{if(missing)throw Error('gmail_read_404');return {bytes:bytes[Number(metadata.id.split('-')[1])],mime:metadata.mime_type};}};
 const handler=createReadHandler({key:'sb_publishable_fixture',provider,fetchImpl:async(url,options)=>{
  upstream.push({url,options});const q=new URL(url),table=q.pathname.split('/').at(-1);let data=[];
  if(q.pathname==='/auth/v1/user')data={id:A};else if(table==='work_admins')data=[{user_id:A}];else if(table==='pa_inquiries')data=[{id:A}];
  else if(table==='pa_portals')data=[{id:P,case_id:A}];else if(table==='pa_portal_document_cards')data=[{id:P,portal_id:P,title:'原本照合_fixture',current_version_id:ids[0]}];
  else if(table==='pa_portal_document_versions')data=assets.slice(0,2);else if(table==='pa_portal_photo_items')data=assets.slice(2);
  else if(table==='pa_gmail_thread_links')data=[{inquiry_id:A,gmail_thread_id:'thread1'}];else if(table==='pa_gmail_message_index')data=[{inquiry_id:A,gmail_message_id:'mail1',gmail_thread_id:'thread1',attachment_metadata:attachments}];
  return new Response(JSON.stringify(data));
 }});
 const root=path.resolve(__dirname,'..');
 const server=http.createServer((req,res)=>{const f=path.join(root,new URL(req.url,'http://localhost').pathname);if(!f.startsWith(root+path.sep))return res.writeHead(403).end();try{res.setHeader('content-type',f.endsWith('.mjs')?'text/javascript':f.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(f));}catch{res.writeHead(404).end();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
 try{
  browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));await page.route(/^https?:\/\/(?!127\.0\.0\.1:)/,r=>r.abort());
  await page.route('**/pa-ui/js/integration.mjs',r=>r.fulfill({contentType:'text/javascript',body:"export const workspaceAuth={restore:async()=>({access_token:'fixture-only-long-token-0123456789'}),current:async()=>({access_token:'fixture-only-long-token-0123456789'}),logout:async()=>{},subscribe:()=>{}};export const readUrl=p=>'/api/pa-workspace-read?path='+encodeURIComponent(p);export const legacyUrl=()=>{throw Error('forbidden_legacy')};"}));
  await page.route('**/api/pa-workspace-read?**',async r=>{
   const route=new URL(r.request().url()).searchParams.get('path');
   if(route.startsWith('/data/materials/')||route.startsWith('/data/material/')){
    const res={statusCode:200,headers:{},setHeader(k,v){this.headers[k]=v;},end(body){this.body=body;}};
    await handler({method:'GET',url:r.request().url(),headers:{authorization:'Bearer fixture-only-long-token-0123456789'}},res);
    return r.fulfill({status:res.statusCode,headers:res.headers,body:res.body});
   }
   return r.fulfill({json:{ok:true,result:values[route]??[]}});
  });
  await page.goto('http://127.0.0.1:'+server.address().port+'/pa-admin.html');await page.locator('[data-case="'+A+'"]').click();await page.locator('.request-original').first().waitFor();
  await page.getByRole('button',{name:'資料',exact:true}).last().click();await page.locator('#material-source').selectOption('portal');
  for(const filename of names){
   const card=page.locator('#material-grid .material-card').filter({hasText:filename});await card.locator('.material-thumb').click();
   const dialog=page.locator('dialog[open]');
   if(filename.endsWith('.pdf')){await dialog.locator('canvas').waitFor();assert(await dialog.locator('canvas').evaluate(c=>c.width>0&&c.height>0));}
   else{await dialog.locator('img').waitFor();await dialog.locator('img').evaluate(i=>i.decode());assert(await dialog.locator('img').evaluate(i=>i.naturalWidth===4&&i.naturalHeight===4));}
   const proof=JSON.parse(await card.locator('.material-thumb').getAttribute('data-identity-proof'));assert.equal(proof.indexed_id_equal,false);assert.equal(proof.method,'registered_message_part');assert.equal(proof.sha256_verified,true);
   await dialog.getByRole('button',{name:'閉じる',exact:true}).click();
  }
  const errorsShown=await page.evaluate(async()=>{const {previewError}=await import('/pa-ui/js/gallery.mjs');return [previewError({code:'attachment_identity_ambiguous'}),previewError({code:'attachment_identity_unavailable'})];});assert(errorsShown[0].includes('複数'));assert(errorsShown[1].includes('未取得'));
  missing=true;await page.reload();await page.locator('[data-case="'+A+'"]').click();await page.locator('.request-original').first().waitFor();await page.getByRole('button',{name:'資料',exact:true}).last().click();await page.locator('#material-source').selectOption('portal');
  await page.getByRole('button',{name:names[0]+' の拡大プレビュー',exact:true}).click();await page.locator('dialog[open]').getByText('原本未取得 / 404（削除・期限切れ・対応不明）',{exact:true}).waitFor();
  assert(upstream.every(c=>c.options.method==='GET'&&!c.url.includes('/rpc/')));assert.deepEqual(errors,[]);
  console.log(JSON.stringify({result:'PASS',scope:'LOCAL_FIXTURE_ONLY',registeredOriginals:4,pdf:2,jpeg:2,identityProofs:4,missingOriginal404:true,pageErrors:0,dbWrites:0}));
 }finally{if(browser)await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
