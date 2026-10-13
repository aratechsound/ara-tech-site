'use strict';
const assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..');
(async()=>{
 const server=http.createServer((req,res)=>{const name=path.join(root,new URL(req.url,'http://localhost').pathname);if(!name.startsWith(root+path.sep)){res.writeHead(403).end();return;}try{res.setHeader('content-type',name.endsWith('.mjs')?'text/javascript':name.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(name));}catch{res.writeHead(404).end();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({headless:true,...(process.env.PAUI021_BROWSER?{executablePath:process.env.PAUI021_BROWSER}:{})});
 try{
 const origin=process.env.PAUI023_PREVIEW||'http://127.0.0.1:'+server.address().port;
 const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[],counts={},methods=[];let active=0,maxActive=0,retry=false;
 page.on('pageerror',e=>errors.push(e.message));
 const C='11111111-1111-4111-8111-111111111111',D='22222222-2222-4222-8222-222222222222';
 await page.route('**/pa-ui/js/integration.mjs',r=>r.fulfill({contentType:'text/javascript',body:"let session={access_token:'fixture-only',expires_at:9999999999};export const workspaceAuth={restore:async()=>session,current:async()=>session,logout:async()=>{session=null;},login:async()=>{session={access_token:'fixture-only'};return session;},subscribe:()=>{}};export const readUrl=p=>'/api/pa-workspace-read?path='+encodeURIComponent(p);export const legacyUrl=id=>'/pa-admin-legacy.html?case='+id;"}));
 await page.route('**/api/pa-workspace-read?**',async r=>{
 const p=new URL(r.request().url()).searchParams.get('path');methods.push(r.request().method());let value=[];
 if(p==='/data/cases')value={cases:[{id:C,event_name:'第8回広島都市学園大学みやこ祭',status:'new',case_type:'PA_EVENT',event_date:'2026-10-20'},{id:D,event_name:'短名',status:'on_hold',case_type:'OTHER',event_date:'2027-01-01'},{id:'closed',event_name:'完了fixture',status:'closed'}],progress:[{inquiry_id:C,current_step:2},{inquiry_id:D,current_step:3}]};
 else if(p.startsWith('/data/commercial/'))value={estimates:[],offers:[],documents:[],billings:[]};
 else if(p.startsWith('/data/materials/'))value={cards:[],photos:[]};
 else if(p==='/data/mail/'+C)value=Array.from({length:18},(_,i)=>({gmail_message_id:'m'+i,inquiry_id:C,direction:'inbound',subject:'Fixture '+i,snippet:i===0?'保存済み抜粋':null,attachment_metadata:[]}));
 else if(p==='/data/mail/'+D)value=[{gmail_message_id:'other',inquiry_id:D,subject:'別案件fixture',body_text:'別案件本文',attachment_metadata:[]}];
 else if(p.startsWith('/data/mail-body/')){
 const id=p.split('/').pop();counts[id]=(counts[id]||0)+1;active++;maxActive=Math.max(maxActive,active);
 await new Promise(resolve=>setTimeout(resolve,id==='m6'?1200:100));active--;
 if(id==='m3'&&!retry){await r.fulfill({status:503,contentType:'application/json',body:JSON.stringify({ok:false,code:'provider_failed'})});return;}
 if(id==='m4'){await r.fulfill({status:403,contentType:'application/json',body:JSON.stringify({ok:false,code:'mail_binding_mismatch'})});return;}
 value={gmail_message_id:id,inquiry_id:C,body_text:id==='m5'?'':('本文 '+id+'\n').repeat(400)+'\n> 引用履歴 '+id};
 }
 try{await r.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,result:value})});}catch{}
 });
 await page.goto(origin+'/pa-admin.html');
 const caseC=page.locator('[data-case="'+C+'"]'),caseD=page.locator('[data-case="'+D+'"]');await caseC.waitFor();
 assert.equal(await page.locator('#advanced-filters').isVisible(),false);assert.equal(await page.locator('#order').inputValue(),'event');assert.equal(await page.locator('#filter').inputValue(),'active');
 assert.equal(await page.locator('.case').count(),2);
 const long=caseC.locator('.casename'),short=caseD.locator('.casename');
 await page.waitForFunction(()=>document.querySelector('.casename').classList.contains('scrolling'));
 assert.equal(await short.evaluate(n=>n.classList.contains('scrolling')),false);
 assert.equal(await long.getAttribute('title'),'第8回広島都市学園大学みやこ祭');
 assert.equal(await long.locator('[aria-hidden="true"]').count(),1);
 await page.mouse.move(1000,700);
 const moving=await long.evaluate(n=>{const a=n.firstElementChild.getAnimations()[0];a.currentTime=0;const start=n.firstElementChild.firstElementChild.getBoundingClientRect().x;a.currentTime=Number.parseFloat(getComputedStyle(n.firstElementChild).animationDuration)*1000-0.01;const end=n.firstElementChild.lastElementChild.getBoundingClientRect().x;return {state:getComputedStyle(n.firstElementChild).animationPlayState,difference:Math.abs(start-end)};});
 assert.equal(moving.state,'running');assert(moving.difference<1);
 await caseC.hover();assert.equal(await long.evaluate(n=>getComputedStyle(n.firstElementChild).animationPlayState),'paused');
 await page.mouse.move(1000,700);assert.equal(await long.evaluate(n=>getComputedStyle(n.firstElementChild).animationPlayState),'running');
 await caseC.focus();assert.equal(await long.evaluate(n=>getComputedStyle(n.firstElementChild).animationName),'none');
 await page.emulateMedia({reducedMotion:'reduce'});assert.equal(await long.evaluate(n=>getComputedStyle(n.firstElementChild).animationName),'none');await page.emulateMedia({reducedMotion:'no-preference'});
 const badge=await caseC.locator('.rightbadges').boundingBox(),box=await caseC.boundingBox();assert(badge.x+badge.width<=box.x+box.width);
 await page.setViewportSize({width:1000,height:800});await page.setViewportSize({width:1440,height:900});
 console.log('PASS names: accurate overflow, short static, seamless cycle, 24px/s, hover, keyboard, reduced-motion, badge and resize');
 await caseC.click();await page.getByRole('button',{name:'やり取り',exact:true}).click();
 const card=i=>page.locator('[data-message="m'+i+'"]');
 await page.getByText('保存済み抜粋',{exact:true}).waitFor();assert.equal(counts.m0,undefined);
 await card(1).getByRole('button',{name:'全文を表示',exact:true}).waitFor();await page.waitForFunction(()=>document.querySelector('[data-message="m1"] .mail-excerpt').textContent.includes('本文 m1'));
 assert(maxActive<=2);assert.equal(counts.m17,undefined);
 await card(0).getByRole('button',{name:'全文を表示',exact:true}).click();await card(0).getByRole('button',{name:'閉じる',exact:true}).waitFor();
 assert((await card(0).locator('.mail-excerpt').innerText()).length>650);await card(0).locator('[data-quoted-body] summary').click();assert(await card(0).locator('[data-quoted-body]').evaluate(n=>n.open));
 await card(0).getByRole('button',{name:'閉じる',exact:true}).click();assert.equal(await card(0).locator('[data-quoted-body]').evaluate(n=>n.open),false);
 const before=counts.m0;await card(0).getByRole('button',{name:'全文を表示',exact:true}).click();await card(0).getByRole('button',{name:'閉じる',exact:true}).click();assert.equal(counts.m0,before);
 assert.equal(await card(1).getByRole('button',{name:'全文を表示',exact:true}).count(),1);
 await page.getByRole('button',{name:'概要',exact:true}).click();await page.getByRole('button',{name:'やり取り',exact:true}).click();assert.equal(counts.m0,before);
 await card(3).scrollIntoViewIfNeeded();await card(3).getByRole('button',{name:'本文を再取得',exact:true}).waitFor();assert.equal(counts.m3,1);retry=true;await card(3).getByRole('button',{name:'本文を再取得',exact:true}).click();await card(3).getByRole('button',{name:'全文を表示',exact:true}).waitFor();assert.equal(counts.m3,2);
 await card(4).scrollIntoViewIfNeeded();await card(4).getByText('認証・ACL拒否 / 403 / 本文を取得できません',{exact:true}).waitFor();assert.equal(counts.m4,1);
 await card(5).scrollIntoViewIfNeeded();await card(5).getByText('取得成功 / 空本文',{exact:true}).waitFor();
 await card(6).scrollIntoViewIfNeeded();await caseD.click();await page.getByRole('button',{name:'やり取り',exact:true}).click();await page.getByText('別案件本文',{exact:true}).waitFor();await page.waitForTimeout(1300);assert.equal(await page.locator('[data-message="m6"]').count(),0);
 console.log('PASS mail: saved/auto preview, lazy limit 2, per-card toggle, long body, quotation close, zero toggle requests, tab/case race, retry, empty and ACL distinction');
 const title=await page.locator('#title').innerText();await page.locator('#toggle-filters').click();assert.equal(await page.locator('#toggle-filters').getAttribute('aria-expanded'),'true');
 await page.locator('#order').selectOption('received');await page.locator('#filter').selectOption('all');assert.equal(await page.locator('.case').count(),3);
 for(const [id,value] of [['type-filter','OTHER'],['status-filter','on_hold'],['year-filter','2027'],['step-filter','3']]){await page.locator('#'+id).selectOption(value);assert.equal(await page.locator('.case').count(),1);await page.locator('#'+id).selectOption('');}
 await page.locator('#filter').selectOption('completed');assert.equal(await page.locator('.case').count(),1);await page.locator('#filter').selectOption('action');assert.equal(await page.locator('.case').count(),1);
 await page.getByRole('button',{name:'詳細条件を閉じる ▲',exact:true}).click();assert.equal(await page.locator('#filter').inputValue(),'action');assert((await page.locator('#filter-summary').innerText()).includes('要対応'));assert.equal(await page.locator('#title').innerText(),title);
 await page.locator('#toggle-filters').focus();await page.keyboard.press('Enter');await page.getByRole('button',{name:'条件をリセット',exact:true}).click();assert.equal(await page.locator('#filter').inputValue(),'active');assert.equal(await page.locator('#order').inputValue(),'event');assert.equal(await page.locator('#title').innerText(),title);
 await page.locator('#search').fill('みやこ祭');assert.equal(await page.locator('.case').count(),1);assert((await page.locator('.asidebottom').innerText()).includes('表示 1 / 3件'));
 console.log('PASS search: collapsed defaults, all filters immediate, persistence, explicit reset, counts, keyboard and selection unchanged');
 const mismatch=await page.evaluate(async()=>{
  const {createMailBodyView}=await import('/pa-ui/js/mail-body-view.mjs');
  const host=document.createElement('article');host.innerHTML='<p class="mail-excerpt"></p><button data-body-read></button>';document.body.append(host);
  const view=createMailBodyView({isAuthenticated:()=>true,request:async()=>({gmail_message_id:'wrong',body_text:'MUST NOT DISPLAY'})});
  view.mount(host,'case',{gmail_message_id:'expected',snippet:'saved'},()=>true);host.querySelector('button').click();
  await new Promise(r=>setTimeout(r,30));const value=host.textContent;view.clear();host.remove();return value;
 });assert(mismatch.includes('403'));assert(!mismatch.includes('MUST NOT DISPLAY'));
 const touch=await browser.newPage({hasTouch:true,viewport:{width:390,height:844}});
 await touch.route('**/pa-ui/js/integration.mjs',r=>r.fulfill({contentType:'text/javascript',body:"export const workspaceAuth={restore:async()=>null,subscribe:()=>{}};export const readUrl=p=>p;export const legacyUrl=p=>p;"}));
 await touch.goto(origin+'/pa-admin.html');
 const touchState=await touch.evaluate(async()=>{
  const host=document.createElement('div');host.style.width='150px';host.innerHTML='<button class="case"><span class="casename"><span class="case-name-track"><span>第8回広島都市学園大学みやこ祭</span><span aria-hidden="true" hidden>第8回広島都市学園大学みやこ祭</span></span></span></button>';document.body.append(host);
  const {createCaseNameView}=await import('/pa-ui/js/case-name-view.mjs');createCaseNameView().mount(host);
  const track=host.querySelector('.case-name-track');return {animation:getComputedStyle(track).animationName,whiteSpace:getComputedStyle(track.firstElementChild).whiteSpace};
 });assert.equal(touchState.animation,'none');assert.equal(touchState.whiteSpace,'normal');await touch.close();
 console.log('PASS binding mismatch rejected without body exposure; touch full name; 60000-character body regression');
 assert.deepEqual(errors,[]);assert(methods.every(m=>m==='GET'));
 if(process.env.PAUI023_SCREENSHOT)await page.screenshot({path:process.env.PAUI023_SCREENSHOT,fullPage:true});
 await page.locator('#sign-out').click();await page.getByText('ログアウトしました。',{exact:true}).waitFor();assert.equal(await page.locator('[data-message]').count(),0);
 await page.locator('#login-form input[name="email"]').fill('fixture@example.invalid');await page.locator('#login-form input[name="password"]').fill('fixture-only');await page.locator('#login-form button').click();await page.locator('[data-case="'+C+'"]').click();await page.getByRole('button',{name:'やり取り',exact:true}).click();await card(0).getByRole('button',{name:'全文を表示',exact:true}).click();await card(0).getByRole('button',{name:'閉じる',exact:true}).waitFor();assert.equal(counts.m0,before+1);
 console.log('PASS logout clears private cache; reauthentication fetches fresh body; GET only; no browser errors');
 const fixture=await browser.newPage({viewport:{width:1440,height:900}});const fixtureErrors=[],apiCalls=[];
 fixture.on('pageerror',e=>fixtureErrors.push(e.message));await fixture.route('**/api/**',r=>{apiCalls.push(r.request().url());return r.abort();});
 await fixture.goto(origin+'/tests/paui023-preview.html');await fixture.locator('[data-case="'+C+'"]').click();await fixture.getByRole('button',{name:'やり取り',exact:true}).click();
 await fixture.getByText('自動取得した架空の本文です。',{exact:false}).waitFor();
 const saved=fixture.locator('[data-message="fixture-saved"]');await saved.getByRole('button',{name:'全文を表示',exact:true}).click();await saved.getByRole('button',{name:'閉じる',exact:true}).waitFor();
 await saved.locator('[data-quoted-body] summary').click();await saved.getByRole('button',{name:'閉じる',exact:true}).click();assert.equal(await saved.locator('[data-quoted-body]').evaluate(n=>n.open),false);
 await saved.locator('.material-thumb').click();await fixture.locator('dialog canvas').waitFor();await fixture.locator('dialog').getByRole('button',{name:'閉じる',exact:true}).click();
 await fixture.locator('#toggle-filters').click();await fixture.locator('#type-filter').selectOption('PA_EVENT');assert.equal(await fixture.locator('.case').count(),1);await fixture.getByRole('button',{name:'詳細条件を閉じる ▲',exact:true}).click();
 assert.deepEqual(apiCalls,[]);assert.deepEqual(fixtureErrors,[]);console.log('PASS deployable Preview fixture uses real UI, lazy bodies, toggles, PDF coexistence and filters without any authenticated API');
 if(process.env.PAUI023_SCREENSHOT)await fixture.screenshot({path:process.env.PAUI023_SCREENSHOT,fullPage:true});await fixture.close();
 }finally{await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
