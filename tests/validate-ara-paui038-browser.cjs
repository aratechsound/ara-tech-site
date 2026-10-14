'use strict';
const assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright'),fixtures=require('./paui038-fixture.cjs');
(async()=>{
 const {A,B,values}=await import('./paui027-fixture.mjs'),root=path.resolve(__dirname,'..');
 values['/data/cases'].cases=values['/data/cases'].cases.map(c=>({...c,event_name:c.id===A?'架空の抜粋検証案件':'架空の切替先案件'}));
 const rows=fixtures.map(f=>({gmail_message_id:f.id,inquiry_id:A,direction:f.id==='C'?'outbound':'inbound',subject:'架空メール '+f.id,received_at:'2026-10-14T00:00:00Z',attachment_metadata:[],...(f.body?{body_text:f.body}:{}),...(f.html?{body_html:f.html}:{}),...(f.snippet?{snippet:f.snippet}:{})}));
 const server=http.createServer((req,res)=>{const f=path.join(root,new URL(req.url,'http://localhost').pathname);if(!f.startsWith(root+path.sep))return res.writeHead(403).end();try{res.setHeader('content-type',f.endsWith('.mjs')?'text/javascript':f.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(f));}catch{res.writeHead(404).end();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser,release;
 try{
  browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[],outside=[],calls=[],writes=[];let delay=true;
  page.on('pageerror',e=>errors.push(e.message));await page.route(/^https?:\/\/(?!127\.0\.0\.1:)/,r=>{outside.push(r.request().url());return r.abort();});
  await page.route('**/pa-ui/js/integration.mjs',r=>r.fulfill({contentType:'text/javascript',body:"export const workspaceAuth={restore:async()=>({access_token:'fixture-only',expires_at:9999999999}),current:async()=>({access_token:'fixture-only',expires_at:9999999999}),logout:async()=>{},subscribe:()=>{}};export const readUrl=p=>'/api/pa-workspace-read?path='+encodeURIComponent(p);export const legacyUrl=()=>{throw Error('forbidden_legacy')};"}));
  await page.route('**/api/**',async r=>{
   if(r.request().method()!=='GET'){writes.push(r.request().method());return r.abort();}
   const p=new URL(r.request().url()).searchParams.get('path');calls.push(p);let value=values[p]??[];
   if(p==='/data/mail/'+A)value=rows;else if(p==='/data/mail/'+B)value=[];
   else if(p?.startsWith('/data/mail-body/')){assert.equal(p.split('/').at(-1),'L');if(delay)await new Promise(resolve=>{release=resolve;});value={inquiry_id:A,gmail_message_id:'L',body_text:'本文取得後の用件です。\nマイクは6本に変更を希望します。'};}
   return r.fulfill({json:{ok:true,result:value}}).catch(()=>{});
  });
  await page.goto('http://127.0.0.1:'+server.address().port+'/pa-admin.html');await page.locator('[data-case="'+A+'"]').click();await page.locator('[data-tab=conversation]').click();
  await page.locator('[data-message=N] [data-excerpt-source]').waitFor();await page.waitForLoadState('networkidle');assert.equal(await page.locator('.mail-row').count(),14);
  for(const f of fixtures){
   const c=page.locator('[data-message='+f.id+']'),text=await c.locator('.mail-excerpt').textContent();
   if(f.exact!==undefined)assert.equal(text,f.exact,f.id);
   for(const s of f.expected||[])assert(text.includes(s),f.id+' '+s);for(const s of f.reject||[])assert(!text.includes(s),f.id+' excludes '+s);
  }
  assert.equal(await page.locator('[data-message=C] .mail-direction').textContent(),'↑ 送信');
  assert.equal(await page.evaluate(()=>window.excerptDanger),undefined);assert.equal(await page.locator('.mail-row img,.mail-row script').count(),0);
  const snippet=page.locator('[data-message=L]');assert((await snippet.locator('[data-excerpt-source]').textContent()).includes('snippetのみ・本文未取得'));
  assert.equal(calls.filter(p=>p?.startsWith('/data/mail-body/')).length,0,'no extra body fetch for already provided text/HTML');
  if(fs.existsSync('/workspace/outputs'))await page.screenshot({path:'/workspace/outputs/PAUI038_FIXTURE_UI.png'});
  const a=page.locator('[data-message=A]');await a.locator('[data-body-read]').click();assert.equal(await a.locator('.mail-excerpt').textContent(),fixtures[0].body);await a.locator('[data-body-read]').click();assert.equal(await a.locator('.mail-excerpt').textContent(),fixtures[0].expected[0]);
  const h=page.locator('[data-message=H]');await h.locator('[data-body-read]').click();assert.equal(await h.locator('.mail-excerpt').textContent(),'今回はマイク6本を希望します。');
  assert.equal(await h.locator('[data-quoted-body]').getAttribute('hidden'),null);await h.locator('[data-quoted-body] summary').click();assert((await h.locator('[data-quoted-body] pre').textContent()).includes('前回は10本で確定です。'));await h.locator('[data-body-read]').click();
  // L remains labelled partial while normal existing lazy GET is pending.
  await snippet.scrollIntoViewIfNeeded();await page.waitForFunction(()=>document.querySelector('[data-message=L] [data-body-read]').disabled);
  assert((await snippet.locator('[data-excerpt-source]').textContent()).includes('本文未取得'));assert.equal(calls.filter(p=>p?.startsWith('/data/mail-body/')).length,1);
  await page.locator('[data-case="'+B+'"]').click();await page.locator('[data-tab=conversation]').click();release();delay=false;await page.getByText('メール索引を取得中…',{exact:true}).waitFor({state:'detached'});assert.equal(await page.locator('.mail-row').count(),0);
  await page.locator('[data-case="'+A+'"]').click();await page.locator('[data-tab=conversation]').click();await page.waitForLoadState('networkidle');await page.locator('[data-message=L]').scrollIntoViewIfNeeded();
  // selectCase aborts the old GET by design. Recovery stays an explicit action.
  await page.locator('[data-message=L]').getByRole('button',{name:'本文を再取得',exact:true}).click();
  await page.getByText('用件抜粋（保存済みsnippetのみ・本文未取得）',{exact:true}).waitFor({state:'detached'});
  assert((await page.locator('[data-message=L] .mail-excerpt').textContent()).includes('マイクは6本'));
  await page.locator('[data-message=L] [data-body-read]').click();await page.locator('[data-message=L] [data-body-read]').click();
  assert.equal(calls.filter(p=>p?.startsWith('/data/mail-body/')).length,2,'only cancelled read plus explicit recovery, no toggle/reopen GET');
  // Browser-local processing of 500 long fictitious mail bodies, no network.
  const performanceResult=await page.evaluate(async()=>{const {purposeExcerpt}=await import('/pa-ui/js/mail-purpose.mjs');const text='平素より大変お世話になっております。\n'+ '背景説明です。\n'.repeat(80)+'\nマイクは4本から6本に変更を希望します。\nただし未確定です。';const at=performance.now();let count=0;for(let i=0;i<500;i++)if(purposeExcerpt(text).includes('未確定'))count++;return {count,ms:performance.now()-at};});
  assert.equal(performanceResult.count,500);assert(performanceResult.ms<5000);assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);assert.deepEqual(outside,[]);
  console.log(JSON.stringify({status:'PASS',cases:fixtures.map(f=>f.id),actual_desk_render:true,good_C_unchanged:true,full_original_and_quotes_preserved:true,html_inert_and_preferred_over_snippet:true,snippet_not_full_body_claimed:true,body_GETs:2,cancelled_case_switch_GETs:1,explicit_recovery_GETs:1,extra_GETs:0,case_switch_late_result_suppressed:true,local_500_excerpts_ms:Math.round(performanceResult.ms),external_AI_calls:0,business_writes:0}));
 }finally{release?.();if(browser)await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
