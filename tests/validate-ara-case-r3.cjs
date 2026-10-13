const {chromium}=require('playwright'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),out=path.resolve(root,'../../outputs/ARA-CASE-001R3-audit'),base='http://127.0.0.1:8875';
const before=execFileSync('git',['show','cac44214dba8f273377ab66fc95b2aad7e4fc38d:js/ara-general-inquiry.js'],{cwd:root,encoding:'utf8'});
const fake=`window.__widget={renders:0,resets:0};window.turnstile={render(node,options){window.__widget.renders++;window.__proofOptions=options;return 'fixture-widget';},reset(id){if(id!=='fixture-widget')throw Error('wrong widget');window.__widget.resets++;},};window.__solve=()=>{const t='single-use-'+crypto.randomUUID();if(window.__proofOptions)window.__proofOptions.callback(t);else{let i=document.querySelector('[name="cf-turnstile-response"]');if(!i){i=document.createElement('input');i.type='hidden';i.name='cf-turnstile-response';document.querySelector('#contact-form').append(i);}i.value=t;}};if(!document.querySelector('script[src*="render=explicit"]'))window.__solve();`;
(async()=>{
 const browser=await chromium.launch({headless:true});const records=[],beforeRecords=[];
 async function pageFor(scenario,old=false){
  const page=await browser.newPage();page.posts=[];page.configNetwork=scenario==='network';page.legacy=[];page.errors=[];page.on('pageerror',e=>page.errors.push(e.message));
  await page.request.post(base+'/fixture-control',{data:{scenario}});
  await page.route('**/*',async route=>{
   const request=route.request(),url=new URL(request.url());
   if(url.hostname==='challenges.cloudflare.com')return route.fulfill({contentType:'text/javascript',body:fake});
   if(url.hostname==='unpkg.com')return route.fulfill({contentType:'text/javascript',body:`window.__legacyInitializations=(window.formspree.q||[]).length;document.querySelector('#contact-form').addEventListener('submit',e=>{e.preventDefault();fetch('https://formspree.io/f/mojqjwnr',{method:'POST',body:'fixture-only'});});`});
   if(url.hostname==='formspree.io'){page.legacy.push(request.method());return route.fulfill({contentType:'application/json',body:'{}'});}
   if(url.hostname!=='127.0.0.1')return route.abort();if(url.pathname==='/api/pa-inquiry'&&request.method()==='GET'&&page.configNetwork)return route.abort();
   if(old&&url.pathname==='/api/pa-inquiry'&&request.method()==='GET'){const response=await route.fetch({headers:{...request.headers(),'x-ara-fixture-baseline-config':'true'}});page.beforeConfig={status:response.status(),body:await response.json()};return route.fulfill({response});}
   if(old&&url.pathname==='/js/ara-general-inquiry.js')return route.fulfill({contentType:'text/javascript',body:before});
   if(url.pathname==='/api/pa-inquiry'&&request.method()==='POST'){
    const input=request.postDataJSON();const response=await route.fetch();const body=await response.json();
    page.posts.push({key:input.submission_key,proof:input.captcha_token,body,status:response.status()});
    if(page.lose){page.lose=false;return route.abort('failed');}
    return route.fulfill({response});
   }
   return route.continue();
  });
  await page.goto(base+'/general-inquiry.html');
  await page.locator('#inquiry-type').selectOption('設備導入');await page.locator('#name').fill('R3 顧客');await page.locator('#email').fill('r3@example.invalid');await page.locator('#message').fill('再試行でも入力を保持する');
  if(!old){await page.waitForFunction(()=>document.querySelector('#contact-form').dataset.intakeMode);}
  return page;
 }
 async function fillCommon(p){await p.locator('#general-case-fields').waitFor({state:'visible'});await p.locator('#case-type').selectOption('AUDIO_INSTALL');await p.locator('#subject').fill('R3施工相談');}
 async function solve(p){await p.waitForFunction(()=>window.__solve);await p.evaluate(()=>window.__solve());await p.waitForFunction(()=>!document.querySelector('[type=submit]').disabled);}
 async function send(p){const n=p.posts.length;await p.locator('[type=submit]').click();for(let i=0;p.posts.length===n&&i<1000;i++)await new Promise(r=>setTimeout(r,20));assert.equal(p.posts.length,n+1,'POST dispatched');await p.waitForFunction(()=>document.querySelector('[data-fs-error]').textContent.includes('保存しました')||document.querySelector('[data-fs-error]').textContent.includes('確認できません')).catch(async e=>{console.log(JSON.stringify({errors:p.errors,posts:p.posts.map(x=>({key:x.key,status:x.status,body:x.body})),message:await p.locator('[data-fs-error]').innerText()}));throw e;});assert.equal(p.posts.length,n+1);}
 async function state(p){return (await p.request.get(base+'/fixture-state?key='+p.posts[0].key)).json();}
 // Before: real baseline client, the same single-use fake and real DB/API.
 for(const scenario of ['db_once','lost_response']){
  const p=await pageFor(scenario,true);await fillCommon(p);await p.waitForFunction(()=>!document.querySelector('[type=submit]').disabled);p.lose=scenario==='lost_response';await send(p);await send(p);const s=await state(p);
  assert.equal(p.posts[1].body.code,'spam_verification_failed');assert.equal(await p.evaluate(()=>window.__widget.resets),0);
  beforeRecords.push({scenario,result:'REPRODUCED',statuses:p.posts.map(x=>x.status),same_key:p.posts[0].key===p.posts[1].key,roots:s.rows.length,resets:0});await p.close();
 }
 for(const scenario of ['config503','misconfig']){const p=await pageFor(scenario,true);await p.waitForFunction(()=>window.__legacyInitializations===1&&!document.querySelector('[type=submit]').disabled);beforeRecords.push({scenario,result:'REPRODUCED',config:p.beforeConfig,silent_legacy:true,common_posts:p.posts.length});await p.close();}
 fs.writeFileSync(path.join(out,'R3_BEFORE_REPRODUCTION.json'),JSON.stringify(beforeRecords,null,2));
 for(const scenario of ['db_once','lost_response']){
  const p=await pageFor(scenario);await fillCommon(p);await solve(p);p.lose=scenario==='lost_response';await send(p);
  assert.equal(await p.locator('[type=submit]').isEnabled(),false);assert.equal(await p.locator('#message').inputValue(),'再試行でも入力を保持する');const first=await state(p);
  await solve(p);await send(p);const second=await state(p);
  assert.equal(p.posts[0].key,p.posts[1].key);assert.notEqual(p.posts[0].proof,p.posts[1].proof);assert.equal(p.posts[1].body.ok,true);assert.equal(second.rows.length,1);assert.equal(second.rows[0].jobs,1);assert.equal(second.rows[0].status,'unknown');
  if(scenario==='lost_response'){assert.equal(p.posts[0].body.id,p.posts[1].body.id);assert.equal(p.posts[0].body.inquiry_number,p.posts[1].body.inquiry_number);assert.equal(second.sends,first.sends);assert.equal(p.posts[1].body.duplicate,true);}
  // Replay the consumed proof through the actual API: verification remains mandatory.
  const replay=await p.request.post(base+'/api/pa-inquiry',{data:{form_kind:'general',submission_key:p.posts[0].key,case_type:'PA_EVENT',customer_name:'R3 顧客',email:'r3@example.invalid',subject:'R3施工相談',body:'再試行でも入力を保持する',inquiry_category:'設備導入',captcha_token:p.posts[1].proof}});
  assert.equal((await replay.json()).code,'spam_verification_failed');
  records.push({scenario,result:'PASS',same_key:true,new_proof:true,roots:second.rows,jobs:1,duplicate:p.posts[1].body.duplicate,reused_proof_rejected:true,unknown_not_resent:scenario==='lost_response',widget:await p.evaluate(()=>window.__widget)});
  await p.screenshot({path:path.join(out,'R3_'+scenario+'.png'),fullPage:true});await p.close();
 }
 const p=await pageFor('ok');await fillCommon(p);await solve(p);
 for(const event of ['expired-callback','error-callback','timeout-callback']){
  await p.evaluate(event=>window.__proofOptions[event](),event);assert.equal(await p.locator('[type=submit]').isEnabled(),false);assert.equal(await p.locator('#message').inputValue(),'再試行でも入力を保持する');assert.match(await p.locator('[role=status]').innerText(),/期限|エラー|時間切れ/);await solve(p);records.push({scenario:event,result:'PASS',input_preserved:true});
 }
 await send(p);assert.equal(p.posts.length,1);assert.equal(await p.evaluate(()=>window.__widget.renders),1);records.push({scenario:'widget recovery -> COMMON single submit',result:'PASS'});await p.close();
 for(const scenario of ['config503','bad_json','missing_fields','misconfig','missing_policy','bad_gate','bad_site_key','bad_hostname','unset_gate','empty_gate','network']){
  const p=await pageFor(scenario);
  await p.locator('button').filter({hasText:'受付方法を再確認'}).waitFor({state:'visible'});
  assert.equal(await p.locator('[type=submit]').isEnabled(),false);assert.equal(p.legacy.length,0);assert.equal(await p.locator('script[src*="unpkg.com/@formspree"]').count(),0);
  await p.evaluate(()=>{document.querySelector('#contact-form').requestSubmit();document.querySelector('#contact-form').submit();});await p.locator('#name').press('Enter');assert.equal(p.posts.length,0);assert.equal(p.legacy.length,0);
  await p.request.post(base+'/fixture-control',{data:{scenario:'ok'}});p.configNetwork=false;
  await p.locator('button').filter({hasText:'受付方法を再確認'}).click();await fillCommon(p);assert.equal(await p.locator('#message').inputValue(),'再試行でも入力を保持する');await solve(p);await send(p);assert.equal(p.posts.length,1);assert.equal(p.legacy.length,0);assert.equal(await p.evaluate(()=>window.__widget.renders),1);
  records.push({scenario,result:'PASS',unavailable_blocks_native:true,no_legacy:true,recovered_single_submit:true});await p.close();
 }
 const legacy=await pageFor('off');await legacy.waitForFunction(()=>!document.querySelector('[type=submit]').disabled);await legacy.locator('[type=submit]').click();await legacy.waitForFunction(()=>window.__legacyInitializations===1);assert.equal(legacy.posts.length,0);assert.equal(legacy.legacy.length,1);records.push({scenario:'explicit OFF -> LEGACY',result:'PASS',loader:1,legacy_posts:1,common_posts:0});await legacy.close();
 await browser.close();fs.writeFileSync(path.join(out,'R3_BROWSER_API_PG.json'),JSON.stringify({recorded_at:new Date().toISOString(),scope:'actual browser/client/API/PostgREST/PostgreSQL; single-use Turnstile and Gmail providers fake; fake Formspree submit only; no external requests',before:beforeRecords,checks:records,result:'PASS'},null,2));console.log('R3 before 4 and after '+records.length+' PASS');
})().catch(e=>{console.error(e);process.exit(1);});
