'use strict';
// Same invented 29-file fixture against the supplied source snapshot. No live
// provider, customer identifiers, bodies, bytes, tokens, or URL logs are saved.
const assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {chromium}=require('playwright');
const root=process.env.PAUI029_SOURCE||path.resolve(__dirname,'..'),before=!!process.env.PAUI029_BASELINE;
const {createReadHandler}=require(path.join(root,'api/_pa-workspace-read.cjs'));
const C='11111111-1111-4111-8111-111111111111',P='22222222-2222-4222-8222-222222222222',D='33333333-3333-4333-8333-333333333333';
const sleep=ms=>new Promise(r=>setTimeout(r,ms)),stamp=()=>performance.now(),dur={db:20,message:80,original:180};
const stages={},counts={db_get:0,full_material_scans:0,full_mail_scans:0,provider_message:0,provider_original:0};
let networkActive=0,maxActive=0;const apiTimes=[],apiStages=[];
async function measured(name,fn){const start=stamp();try{return await fn();}finally{(stages[name]||=([])).push(stamp()-start);}}
function response(value){return new Response(JSON.stringify(value));}
(async()=>{
 const {pdf}=await import('./paui027-fixture.mjs');
 // Reuse only the wholly invented JPEG fixture, without recording its bytes.
 const fixtureText=fs.readFileSync(path.join(__dirname,'validate-ara-paui028-browser.cjs'),'utf8');
 const jpeg=Buffer.from(fixtureText.match(/const jpeg=Buffer.from\('([^']+)'/)[1],'base64');
 const files=Array.from({length:29},(_,i)=>i<15?Buffer.from(pdf()+'\n% invented fixture '+i):jpeg);
 const ids=files.map((_,i)=>`44444444-4444-4444-8444-${String(i+1).padStart(12,'0')}`);
 const attachments=files.map((bytes,i)=>({id:'indexed-'+i,part_id:String(i+1),filename:'fixture-'+i+(i<15?'.pdf':'.jpg'),mime_type:i<15?'application/pdf':'image/jpeg',size:bytes.length}));
 const assets=attachments.map((a,i)=>({id:ids[i],card_id:D,portal_id:P,source_type:'gmail_attachment',source_ref:{gmail_message_id:'mail1',gmail_attachment_id:'historical-'+i},display_filename:a.filename,mime_type:a.mime_type,source_byte_size:a.size,source_content_sha256:crypto.createHash('sha256').update(files[i]).digest('hex'),...(i===12||i===14?{}:{gmail_part_id:a.part_id}),created_at:'2026-10-01T00:00:00Z'}));
 const provider={message:async()=>measured('provider_message',async()=>{counts.provider_message++;await sleep(dur.message);return {id:'mail1',threadId:'thread1'};}),attachment:async({metadata})=>measured('provider_original',async()=>{counts.provider_original++;await sleep(dur.original);return {bytes:files[Number(metadata.id.slice(8))],mime:metadata.mime_type};})};
 const handler=createReadHandler({key:'sb_publishable_fixture',provider,fetchImpl:async(url,options)=>measured('supabase',async()=>{
  assert.equal(options.method,'GET');assert(!url.includes('/rpc/'));counts.db_get++;await sleep(dur.db);const q=new URL(url),table=q.pathname.split('/').at(-1);let data=[];
  if(q.pathname==='/auth/v1/user')data={id:C};else if(table==='work_admins')data=[{user_id:C}];else if(table==='pa_inquiries')data=[{id:C}];
  else if(table==='pa_portals')data=[{id:P,case_id:C}];else if(table==='pa_portal_document_cards')data=[{id:D,portal_id:P,current_version_id:ids[0]}];
  else if(table==='pa_portal_document_versions'){if(!q.searchParams.has('id'))counts.full_material_scans++;data=assets.filter(a=>!q.searchParams.has('id')||'eq.'+a.id===q.searchParams.get('id'));}
  else if(table==='pa_gmail_thread_links')data=[{inquiry_id:C,gmail_thread_id:'thread1'}];else if(table==='pa_gmail_message_index'){if(!q.searchParams.has('gmail_message_id'))counts.full_mail_scans++;data=[{inquiry_id:C,gmail_message_id:'mail1',gmail_thread_id:'thread1',attachment_metadata:attachments}];}
  return response(data);
 })});
 const server=http.createServer(async(req,res)=>{
  const q=new URL(req.url,'http://localhost');
  if(q.pathname==='/api/pa-workspace-read'){
    const file=q.searchParams.get('path').startsWith('/data/material/');const start=stamp();if(file){networkActive++;maxActive=Math.max(maxActive,networkActive);}
    res.on('finish',()=>{if(file){networkActive--;apiTimes.push(stamp()-start);const h=res.getHeader('Server-Timing');if(h)apiStages.push(Object.fromEntries(h.split(', ').map(v=>{const [k,d]=v.split(';dur=');return [k,Number(d)];})));}});
    return handler(req,res);
  }
  if(q.pathname==='/fixture')return res.end('<!doctype html><html><head><link rel="stylesheet" href="/pa-ui/styles.css"><style>body{margin:0;background:#111;color:white}#grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.material-thumb{width:100%;height:150px}.material-card{height:220px;overflow:hidden}</style></head><body><input id="filter" aria-label="fixture filter"><div id="grid"></div></body></html>');
  const f=path.join(root,q.pathname);if(!f.startsWith(root+path.sep))return res.writeHead(403).end();try{res.setHeader('content-type',f.endsWith('.mjs')?'text/javascript':f.endsWith('.css')?'text/css':'application/octet-stream');let data=fs.readFileSync(f);if(q.pathname==='/pa-ui/vendor/pdf.mjs')data=Buffer.concat([data,Buffer.from(`\nconst fixtureGetDocument=getDocument;getDocument=function(...args){const start=performance.now(),task=fixtureGetDocument(...args);task.promise.then(doc=>{window.stats.pdf_parse.push(performance.now()-start);const get=doc.getPage.bind(doc);doc.getPage=async n=>{const p=await get(n),render=p.render.bind(p);p.render=(...args)=>{const start=performance.now(),task=render(...args);task.promise.then(()=>window.stats.pdf_draw.push(performance.now()-start),()=>{});return task;};return p;};});return task;};\n`)]);res.end(data);}catch{res.writeHead(404).end();}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
 try{
  browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:760}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));await page.route(/^https?:\/\/(?!127\.0\.0\.1:)/,r=>r.abort());
  await page.goto('http://127.0.0.1:'+server.address().port+'/fixture');
  const metadataMs=await page.evaluate(async({C,before})=>{
   window.stats={starts:[],completions:[],render:[],pdf_parse:[],pdf_draw:[],jpeg_decode:[],cache:0};window.t0=performance.now();
   const decode=HTMLImageElement.prototype.decode;HTMLImageElement.prototype.decode=async function(){const start=performance.now();try{return await decode.call(this);}finally{stats.jpeg_decode.push(performance.now()-start);}};
   const lib=await import('/pa-ui/js/gallery.mjs');
   const request=async item=>{stats.starts.push(performance.now()-t0);const response=await fetch('/api/pa-workspace-read?path='+encodeURIComponent('/data/material/'+C+'/version/'+item.asset_id),{headers:{authorization:'Bearer fixture-only-long-token-0123456789'}});if(!response.ok){const e=await response.json();throw Object.assign(Error(e.code),{code:e.code,status:response.status});}const blob=await response.blob();const proof=response.headers.get('X-PA-Attachment-Identity');if(proof)blob.identityProof=JSON.parse(proof);stats.completions.push(performance.now()-t0);return blob;};
   const start=performance.now(),meta=await(await fetch('/api/pa-workspace-read?path='+encodeURIComponent('/data/materials/'+C),{headers:{authorization:'Bearer fixture-only-long-token-0123456789'}})).json();const metadataMs=performance.now()-start;
   window.items=meta.result.cards.flatMap(c=>c.versions).map(v=>({key:'version:'+v.id,asset_kind:'version',asset_id:v.id,filename:v.display_filename,mime_type:v.mime_type,current:v}));
   if(!before){const {createPrivateAssets}=await import('/pa-ui/js/private-assets.mjs');window.assets=createPrivateAssets({requestBlob:request,authorize:async()=>{},onMetric:(stage,ms)=>{if(stage==='thumbnail_render')stats.render.push(ms);if(stage.endsWith('cache_hit'))stats.cache++;}});}
   window.mount=()=>{window.gallery?.dispose();window.gallery=lib.createGallery({assets:window.assets,requestBlob:request,isCurrent:()=>true});const start=performance.now();gallery.mount(document.querySelector('#grid'),items);window.domMs=performance.now()-start;};
   window.t0=performance.now();mount();window.initialDomMs=domMs;
   window.firstThumb=null;new MutationObserver(()=>{if(firstThumb===null&&document.querySelector('.material-thumb canvas,.material-thumb img'))window.firstThumb=performance.now()-t0;}).observe(document.querySelector('#grid'),{childList:true,subtree:true});
   return metadataMs;
  },{C,before});
  assert.equal(await page.locator('.material-card').count(),29);assert(await page.locator('#filter').isEnabled());
  // Reproduce one ordinary metadata-driven remount while originals are pending.
  await sleep(100);await page.evaluate(()=>mount());
  const visible=await page.locator('.material-thumb').evaluateAll(buttons=>buttons.map((b,i)=>b.getBoundingClientRect().top<innerHeight?i:null).filter(i=>i!==null));
  await page.waitForFunction(indices=>indices.every(i=>document.querySelectorAll('.material-thumb')[i].querySelector('canvas,img')),visible,{timeout:60000});
  const initial=await page.evaluate(()=>({dom:initialDomMs,first:firstThumb,visible:performance.now()-t0,starts:stats.starts.length,completed:stats.completions.length}));
  if(!before)assert(initial.starts<29,'Offscreen originals must remain lazy');
  for(let i=0;i<29;i+=4){await page.locator('.material-thumb').nth(i).scrollIntoViewIfNeeded();await page.waitForFunction(()=>[...document.querySelectorAll('.material-thumb')].filter(b=>b.getBoundingClientRect().top>=0&&b.getBoundingClientRect().top<innerHeight).every(b=>b.querySelector('canvas,img')),null,{timeout:60000});}
  await page.waitForFunction(()=>[...document.querySelectorAll('.material-thumb')].every(b=>b.querySelector('canvas,img')),null,{timeout:60000});
  const allMs=await page.evaluate(()=>performance.now()-t0),warmBefore=counts.provider_original;
  await page.evaluate(()=>{scrollTo(0,0);mount();});await page.waitForFunction(indices=>indices.every(i=>document.querySelectorAll('.material-thumb')[i].querySelector('canvas,img')),visible,{timeout:60000});
  const warmOriginals=counts.provider_original-warmBefore;
  const previewStart=stamp(),apiCount=apiTimes.length;await page.locator('.material-thumb').first().click();await page.locator('dialog[open] canvas').waitFor({timeout:60000});const previewMs=stamp()-previewStart;
  if(!before)assert(apiTimes.length>apiCount,'Full preview must freshly verify canonical original');
  await page.getByRole('button',{name:'閉じる',exact:true}).click();
  const stats=await page.evaluate(()=>({starts:stats.starts,completions:stats.completions,render:stats.render,pdf_parse:stats.pdf_parse,pdf_draw:stats.pdf_draw,jpeg_decode:stats.jpeg_decode,cache:stats.cache}));
  assert.deepEqual(errors,[]);if(!before){assert(maxActive<=2);assert.equal(warmOriginals,0);}
  const summary=values=>({count:values.length,min_ms:Math.min(...values),mean_ms:values.reduce((a,b)=>a+b,0)/values.length,max_ms:Math.max(...values)});
  const result={status:'PASS',scope:'LOCAL_INVENTED_FIXTURE_ONLY',source:before?'PAUI028':'PAUI029',fixture_files:29,pdf:15,jpeg:14,sha_fallback_files:2,environment:{browser:'Chromium headless Linux Docker',viewport:'1440x760',simulated_latency_ms:dur,network:'none except local fixture'},metrics:{metadata_ms:metadataMs,initial_list_ms:metadataMs+initial.dom,dom_ms:initial.dom,first_visible_thumbnail_ms:metadataMs+initial.first,visible_thumbnails_ms:metadataMs+initial.visible,all29_with_scroll_ms:metadataMs+allMs,full_preview_ms:previewMs,visible_count:visible.length,visible_phase_gets:initial.starts,warm_remount_provider_gets:warmOriginals,max_simultaneous_original_api:maxActive,original_api:summary(apiTimes),pdf_parse:summary(stats.pdf_parse),pdf_draw:summary(stats.pdf_draw),jpeg_decode:summary(stats.jpeg_decode),thumbnail_render:stats.render.length?summary(stats.render):'UNINSTRUMENTED_BASELINE'},counts,stages:Object.fromEntries(Object.entries(stages).map(([k,v])=>[k,summary(v)])),api_stages:apiStages,thumbnail_start_ms:stats.starts,thumbnail_complete_ms:stats.completions,page_errors:0};
  if(process.env.PAUI029_OUTPUT)fs.writeFileSync(process.env.PAUI029_OUTPUT,JSON.stringify(result,null,2));console.log(JSON.stringify({...result,api_stages:undefined,thumbnail_start_ms:undefined,thumbnail_complete_ms:undefined}));
 }finally{if(browser)await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
