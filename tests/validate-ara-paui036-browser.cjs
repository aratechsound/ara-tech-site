'use strict';
const assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright');
(async()=>{
 const {A,B,values}=await import('./paui027-fixture.mjs');
 const root=path.resolve(__dirname,'..'),passed=[];
 const normal={subject:'fixture normal delivery',status:'sent'},unknown={subject:'fixture unknown delivery',status:'sent',error_summary:'MAIL_OUTCOME_UNKNOWN'};
 const indexed={gmail_message_id:'indexed',gmail_thread_id:'fixture-thread',inquiry_id:A,direction:'inbound',subject:'fixture indexed',received_at:'2026-10-01T00:00:00Z',snippet:'fixture saved excerpt',attachment_metadata:[]};
 const latest={...indexed,gmail_message_id:'latest',subject:'fixture latest',read_route:'live',index_state:'not_indexed'};
 const server=http.createServer((req,res)=>{const f=path.join(root,new URL(req.url,'http://localhost').pathname);if(!f.startsWith(root+path.sep))return res.writeHead(403).end();try{res.setHeader('content-type',f.endsWith('.mjs')?'text/javascript':f.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(f));}catch{res.writeHead(404).end();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
 try{
  browser=await chromium.launch({headless:true});
  async function scenario(name,deliveries,exercise){
   const page=await browser.newPage(),errors=[],calls=[],writes=[],outside=[];let mode='ready',releaseLive,liveEntered;
   page.on('pageerror',e=>errors.push(e.message));
   await page.route(/^https?:\/\/(?!127\.0\.0\.1:)/,r=>{outside.push(r.request().url());return r.abort();});
   await page.route('**/pa-ui/js/integration.mjs',r=>r.fulfill({contentType:'text/javascript',body:"export const workspaceAuth={restore:async()=>({access_token:'fixture-only',expires_at:9999999999}),current:async()=>({access_token:'fixture-only',expires_at:9999999999}),logout:async()=>{},subscribe:()=>{}};export const readUrl=p=>'/api/pa-workspace-read?path='+encodeURIComponent(p);export const legacyUrl=()=>{throw Error('forbidden_legacy')};"}));
   await page.route('**/api/**',async r=>{
    if(r.request().method()!=='GET'){writes.push(r.request().method());return r.abort();}
    const p=new URL(r.request().url()).searchParams.get('path');calls.push(p);
    if(p==='/data/case/'+A+'/deliveries')return r.fulfill({json:{ok:true,result:deliveries}});
    if(p==='/data/mail/'+A)return r.fulfill({json:{ok:true,result:[indexed]}});
    if(p?.startsWith('/data/mail-candidates/'))return r.fulfill({json:{ok:true,result:{customer_email:'fixture@example.invalid',matching_case_count:1,candidates:[{gmail_thread_id:'fixture-thread',subject:'fixture candidate',address_match:true,already_linked:true}],auto_selected_thread_id:null}}});
    if(p?.startsWith('/data/mail-thread-preview/'))return r.fulfill({json:{ok:true,result:{gmail_thread_id:'fixture-thread',already_linked:true,messages:[indexed],target_indexed_count:1,target_missing_ids:[],sync_thread_ids:['fixture-thread'],sync_message_count:1,sync_attachment_count:0,preflight_complete:true}}});
    if(p==='/data/mail-live/'+A){
     liveEntered?.();if(mode==='deferred')await new Promise(resolve=>{releaseLive=resolve;});
     if(mode==='failure')return r.fulfill({status:503,json:{ok:false,code:'provider_read_failed'}});
     return r.fulfill({json:{ok:true,result:{messages:[latest,indexed],status:'index_gap',checked_at:'2026-10-14T00:00:00Z'}}}).catch(e=>{if(!/closed|cancel|abort/i.test(e.message))throw e;});
    }
    if(p?.startsWith('/data/mail-live-body/')||p?.startsWith('/data/mail-body/'))return r.fulfill({json:{ok:true,result:{gmail_message_id:p.split('/').at(-1),inquiry_id:A,body_state:'ready',body_text:'fixture full body\n<script>window.fixtureExecuted=true</script>\n> fixture quote'}}});
    return r.fulfill({json:{ok:true,result:values[p]??[]}});
   });
   try{
    await page.goto('http://127.0.0.1:'+server.address().port+'/pa-admin.html');
    await page.locator('[data-case="'+A+'"]').click();
    await page.locator('[data-tab=conversation]').click();
    await page.locator('#detail-card details.group').filter({hasText:'案内・配送記録'}).getByText('配送記録を取得中…',{exact:true}).waitFor({state:'detached'});
    const records=page.locator('#detail-card details.group .record');assert.equal(await records.count(),deliveries.length);
    await exercise({page,calls,records,setMode:v=>{mode=v;},defer:()=>new Promise(resolve=>{mode='deferred';liveEntered=resolve;}),release:()=>{assert(releaseLive);releaseLive();}});
    assert.deepEqual(errors,[],name+' must traverse render without page errors');assert.deepEqual(writes,[]);assert.deepEqual(outside,[]);passed.push(name);
   }catch(error){console.error(JSON.stringify({scenario:name,page_errors:errors}));throw error;}finally{releaseLive?.();await page.close();}
  }
  await scenario('A_zero_deliveries',[],async({page})=>{assert((await page.locator('#detail-card details.group').textContent()).includes('保存済み記録なし'));});
  await scenario('B_normal_delivery',[normal],async({records})=>{assert((await records.textContent()).includes('sent'));assert(!(await records.textContent()).includes('UNKNOWN / 再送停止'));});
  await scenario('C_unknown_deliveries',[unknown,{subject:'fixture uppercase status',status:'UNKNOWN'},{subject:'fixture lowercase summary',status:'failed',error_summary:'outcome unknown'}],async({records})=>{for(const text of await records.allTextContents())assert(text.includes('UNKNOWN / 再送停止'));});
  await scenario('D_multiple_deliveries',[normal,unknown,{subject:'fixture failed delivery',status:'failed'}],async({records})=>{const t=await records.allTextContents();assert(t[0].includes('sent'));assert(t[1].includes('UNKNOWN / 再送停止'));assert(t[2].includes('failed'));});
  await scenario('E_render_before_live_get',[unknown],async({page,calls,defer,release})=>{const entered=defer();await page.getByRole('button',{name:'最新メールを取得',exact:true}).click();await entered;assert((await page.locator('#detail-card').innerText()).includes('Gmailを読取確認中'));assert.equal(await page.locator('[data-message=indexed]').count(),1);assert.equal(await page.locator('[data-message=latest]').count(),0);assert.equal(calls.filter(p=>p==='/data/mail-live/'+A).length,1);release();await page.locator('[data-message=latest]').waitFor();});
  await scenario('F_render_after_live_get',[normal,unknown],async({page,records})=>{await page.getByRole('button',{name:'最新メールを取得',exact:true}).click();await page.locator('[data-message=latest]').waitFor();assert((await page.locator('#detail-card').innerText()).includes('索引未更新あり'));assert.equal(await records.count(),2);assert((await records.nth(1).textContent()).includes('UNKNOWN / 再送停止'));});
  await scenario('G_repeated_live_get',[unknown],async({page,calls})=>{for(let i=0;i<3;i++){await page.getByRole('button',{name:'最新メールを取得',exact:true}).click();await page.getByText('Gmailを読取確認中…',{exact:true}).waitFor({state:'detached'});assert.equal(await page.locator('[data-message=latest]').count(),1);assert.equal(await page.locator('[data-message=indexed]').count(),1);}assert.equal(calls.filter(p=>p==='/data/mail-live/'+A).length,3);});
  await scenario('H_switch_case_during_live_get',[unknown],async({page,defer,release})=>{const entered=defer();await page.getByRole('button',{name:'最新メールを取得',exact:true}).click();await entered;await page.locator('[data-case="'+B+'"]').click();await page.locator('[data-case="'+B+'"][aria-pressed=true]').waitFor();release();await page.locator('[data-tab=conversation]').click();await page.getByText('メール索引を取得中…',{exact:true}).waitFor({state:'detached'});assert.equal(await page.locator('[data-message=latest]').count(),0);assert.equal(await page.locator('[data-message=indexed]').count(),0);});
  await scenario('I_provider_failure',[unknown],async({page,setMode})=>{setMode('failure');await page.getByRole('button',{name:'最新メールを取得',exact:true}).click();await page.getByText('Gmail取得失敗 / 最新は未確認',{exact:true}).waitFor();assert.equal(await page.locator('[data-message=indexed]').count(),1);assert((await page.locator('#detail-card details.group').textContent()).includes('UNKNOWN / 再送停止'));});
  await scenario('J_mail_body',[unknown],async({page,calls})=>{await page.locator('[data-message=indexed] [data-body-read]').click();await page.getByText(/fixture full body/).waitFor();await page.getByRole('button',{name:'最新メールを取得',exact:true}).click();await page.locator('[data-message=latest]').waitFor();await page.locator('[data-message=latest] [data-body-read]').click();assert((await page.locator('[data-message=latest]').innerText()).includes('fixture full body'));assert.equal(await page.locator('#detail-card script').count(),0);assert.equal(await page.evaluate(()=>window.fixtureExecuted),undefined);assert(calls.includes('/data/mail-body/'+A+'/indexed'));assert(calls.includes('/data/mail-live-body/'+A+'/fixture-thread/latest'));});
  await scenario('K_all_surfaces_and_link_preview',[normal,unknown],async({page})=>{for(const tab of ['overview','estimate','documents','invoice','history','conversation']){await page.locator('[data-tab='+tab+']').click();assert(await page.locator('#detail-card').innerText());}await page.locator('#open-schedule').click();assert((await page.locator('#detail-card').innerText()).includes('日程調整'));await page.locator('[data-tab=conversation]').click();await page.getByRole('button',{name:'顧客メールを関連付け',exact:true}).click();await page.locator('[data-choose-thread]').click();await page.locator('#thread-read-latest').waitFor();assert.equal(await page.locator('#thread-link-confirm').count(),0);});
  console.log(JSON.stringify({status:'PASS',scope:'LOCAL_FIXTURE_ACTUAL_DESK_RENDER',scenarios:passed,scenario_count:passed.length,business_writes:0,external_requests:0,page_errors:0}));
 }finally{if(browser)await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
