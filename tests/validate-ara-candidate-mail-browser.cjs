'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),C='11111111-1111-4111-8111-111111111111',D='22222222-2222-4222-8222-222222222222';
async function main(){
 const server=http.createServer((req,res)=>{const f=path.resolve(root,new URL(req.url,'http://fixture').pathname.slice(1));if(!f.startsWith(root+path.sep))return res.writeHead(403).end();try{res.setHeader('Content-Type',/\.(mjs|js)$/.test(f)?'text/javascript':f.endsWith('.css')?'text/css':'text/html; charset=utf-8');res.end(fs.readFileSync(f));}catch{res.writeHead(404).end();}});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({headless:true,...(process.env.PAUI079_CHROMIUM?{executablePath:process.env.PAUI079_CHROMIUM}:{})}),page=await browser.newPage({viewport:{width:1440,height:1050}}),origin='http://127.0.0.1:'+server.address().port;
 const calls=[],writes=[],syncCalls=[],errors=[],external=[],waiters=[];let hold=false,decided=false;
 const fp='a'.repeat(64),candidates=()=>[1,2,3,4,5].map(n=>({inquiry_id:C,gmail_message_id:'candidate-'+n,gmail_thread_id:n<3?'same-thread':'thread-'+n,fingerprint:fp,direction:n===2?'outbound':'inbound',occurred_at:'2026-10-17T00:00:00Z',subject:'候補 '+n,status:'RELATED_CANDIDATE'})).filter(c=>!decided||c.gmail_thread_id!=='same-thread');
 const data=id=>({inquiry_id:C,gmail_message_id:id,gmail_thread_id:Number(id.at(-1))<3?'same-thread':'thread-'+id.at(-1),fingerprint:fp,direction:id==='candidate-2'?'outbound':'inbound',occurred_at:'2026-10-17T00:00:00Z',from_address:id==='candidate-2'?'aratechsound@gmail.com':'sender@example.invalid',to_addresses:id==='candidate-2'?['sender@example.invalid']:['aratechsound@gmail.com'],cc_addresses:id==='candidate-1'?['copy@example.invalid']:[],subject:'候補 '+id.at(-1)+' <特殊 & 文字>',body_text:id==='candidate-3'?'':'第一行 '+id+'\n第二行\n第三行\n第四行の原文\n> 引用の原文',body_html:id==='candidate-3'?'<div>HTML原文 &amp; 特殊文字</div><script>window.UNSAFE=true</script><img src="https://forbidden.invalid/pixel" onerror="window.UNSAFE=true"><blockquote>引用HTML</blockquote>':''});
 try{
  page.on('pageerror',e=>errors.push(e.message));await page.route(/^https?:\/\/(?!127\.0\.0\.1:)/,r=>{external.push(r.request().url());return r.abort();});
  await page.route('**/pa-ui/js/integration.mjs',r=>r.fulfill({contentType:'text/javascript',body:"const s={access_token:'fixture',user:{id:'fixture'},expires_at:9999999999};export const workspaceAuth={restore:async()=>s,current:async()=>s,login:async()=>s,logout:async()=>{},subscribe:fn=>window.fixtureAuth=fn};export const readUrl=p=>'/api/pa-workspace-read?path='+encodeURIComponent(p);export const legacyUrl=()=>{throw Error('LEGACY_FORBIDDEN')};"}));
  await page.route('**/api/pa-workspace-read?**',async r=>{
   assert.equal(r.request().method(),'GET');const p=new URL(r.request().url()).searchParams.get('path');calls.push(p);let value=[];
   if(p==='/data/cases')value={cases:[{id:C,event_name:'隔離候補案件A',status:'new'},{id:D,event_name:'隔離候補案件B',status:'new'}],progress:[]};
   else if(p.startsWith('/data/mail-discovery/'))value={enabled:true,complete:true,last_completed_at:'2026-10-17T00:00:00Z',candidates:p.endsWith(C)?candidates():[]};
   else if(p.startsWith('/data/mail-candidate-body/')){
    const segments=p.split('/'),id=segments[5];assert.equal(segments[3],C);assert.equal(segments[6],fp);
    if(hold){await new Promise(resolve=>{waiters.push(resolve);});}
    if(id==='candidate-4')return r.fulfill({status:503,json:{ok:false,code:'provider_read_failed'}});
    value=data(id);if(id==='candidate-5')value.fingerprint='b'.repeat(64);
   }else if(p==='/data/mail/'+C)value=[{inquiry_id:C,gmail_message_id:'regular',gmail_thread_id:'regular-thread',direction:'inbound',received_at:'2026-10-16',subject:'通常メール',from_address:'normal@example.invalid',to_addresses:['aratechsound@gmail.com'],cc_addresses:[],body_text:'通常本文\n> 通常引用',attachment_metadata:[]}];
   else if(p.startsWith('/data/materials/'))value={cards:[],photos:[]};
   else if(p.startsWith('/data/commercial/'))value={estimates:[],offers:[],documents:[],billings:[]};
   try{return await r.fulfill({json:{ok:true,result:value}});}catch{}
  });
  await page.route('**/api/pa-gmail',async r=>{const b=r.request().postDataJSON();if(b.action==='case_discovery_sync'){syncCalls.push(b);assert.equal(b.inquiry_id,C);return r.fulfill({json:{ok:true,result:{complete:true,has_more:false,last_completed_at:'2026-10-17T00:00:00Z'}}});}writes.push(b);assert.equal(b.action,'case_discovery_decide');assert.equal(b.inquiry_id,C);assert.equal(b.gmail_thread_id,'same-thread');assert.equal(b.fingerprint,fp);decided=true;return r.fulfill({json:{ok:true,result:{}}});});
  await page.route('**/api/pa-mail?**',r=>{throw Error('UNRELATED_COMMERCIAL_WRITE');});
  await page.goto(origin+'/pa-admin.html');await page.locator('[data-case="'+C+'"]').click();await page.getByRole('button',{name:'やり取り',exact:true}).click();
  const summary=page.getByText('関連付け判断待ち 5件',{exact:true});await summary.waitFor();await page.locator('#mail-discovery [role=status]').getByText(/Gmailの最新確認はこの閲覧では実行していません/).waitFor();assert.equal(syncCalls.length,0);assert.equal(calls.filter(p=>p.startsWith('/data/mail-candidate-body/')).length,0);assert.deepEqual(writes,[]);
  await summary.click();const card=n=>page.locator('#mail-discovery [data-candidate-message="candidate-'+n+'"]');
  await card(1).getByRole('button',{name:'全文を表示',exact:true}).waitFor();await card(1).locator('.mail-excerpt').getByText('第一行 candidate-1',{exact:false}).waitFor();
  assert.equal(await page.locator('#mail-discovery .mail-row').count(),5);assert.equal(await card(1).locator('.mail-direction').innerText(),'↓ 受信');assert.equal(await card(2).locator('.mail-direction').innerText(),'↑ 送信');assert((await card(1).locator('.mail-address').innerText()).includes('CC copy@example.invalid'));assert(!(await card(2).locator('.mail-address').innerText()).includes('CC'));
  assert.equal(await card(1).locator('.mail-excerpt').innerText(),'第一行 candidate-1\n第二行\n第三行');assert((await card(2).locator('.mail-excerpt').innerText()).includes('candidate-2'));assert(!(await card(2).locator('.mail-excerpt').innerText()).includes('candidate-1'));
  assert.equal(await page.locator('#mail-discovery a[href*="mail.google.com"]').count(),0);assert.equal(await card(1).locator('.mail-heading .mail-review-actions button').count(),2);
  await card(1).getByRole('button',{name:'全文を表示',exact:true}).click();assert((await card(1).locator('.mail-excerpt').innerText()).includes('第四行の原文'));assert.equal(await card(1).locator('[data-quoted-body]').isVisible(),true);await card(1).locator('[data-quoted-body] summary').click();assert.equal(await card(1).locator('[data-quoted-body] pre').innerText(),'> 引用の原文');await card(1).getByRole('button',{name:'閉じる',exact:true}).click();assert.equal(await card(1).locator('[data-quoted-body]').isVisible(),false);
  await card(3).scrollIntoViewIfNeeded();await card(3).locator('.mail-excerpt').getByText('HTML原文 & 特殊文字',{exact:false}).waitFor();assert.equal(await card(3).locator('img,script,iframe').count(),0);assert.equal(await page.evaluate(()=>window.UNSAFE),undefined);assert.deepEqual(external,[]);
  await card(4).scrollIntoViewIfNeeded();await card(4).getByText('本文を取得できません',{exact:true}).waitFor();await card(5).scrollIntoViewIfNeeded();await card(5).getByText('本文を取得できません / 認証・ACL拒否',{exact:true}).waitFor();assert(!(await card(5).innerText()).includes('第一行 candidate-5'));assert.deepEqual(writes,[]);
  const normal=page.locator('[data-message="regular"]');await normal.getByRole('button',{name:'全文を表示',exact:true}).click();assert.equal(await normal.locator('.mail-excerpt').innerText(),'通常本文');await normal.getByRole('button',{name:'閉じる',exact:true}).click();
  const styles=await page.evaluate(()=>{const p=document.querySelector('#mail-discovery .mail-row'),n=document.querySelector('[data-message="regular"]');return [p,n].map(x=>{const s=getComputedStyle(x);return [s.backgroundColor,s.borderRadius,s.fontFamily];});});assert.deepEqual(styles[0],styles[1]);
  if(process.env.PAUI055_SCREENSHOT_DIR){fs.mkdirSync(process.env.PAUI055_SCREENSHOT_DIR,{recursive:true});await card(1).scrollIntoViewIfNeeded();await page.screenshot({path:path.join(process.env.PAUI055_SCREENSHOT_DIR,'ISOLATED_CANDIDATE_PC.png')});}
  await page.setViewportSize({width:390,height:844});await card(1).scrollIntoViewIfNeeded();assert(await card(1).evaluate(e=>e.scrollWidth<=e.clientWidth+2));const bounds=await card(1).evaluate(e=>{const c=e.getBoundingClientRect(),a=e.querySelector('.mail-review-actions').getBoundingClientRect();return {cardRight:c.right,actionsRight:a.right};});assert(bounds.actionsRight<=bounds.cardRight+2);
  if(process.env.PAUI055_SCREENSHOT_DIR)await page.screenshot({path:path.join(process.env.PAUI055_SCREENSHOT_DIR,'ISOLATED_CANDIDATE_MOBILE.png')});
  console.log('PASS shared mail cards, two same-thread messages, directions, envelope, exact three-line prefix, full/quoted text, HTML safety, read failures, PC/mobile and normal mail');
  await page.setViewportSize({width:1440,height:1050});await card(1).getByRole('button',{name:'この案件に関連付ける',exact:true}).click();await page.getByRole('group',{name:'関連付け判断の確認'}).waitFor();assert.deepEqual(writes,[]);await page.getByRole('button',{name:'キャンセル',exact:true}).click();assert.deepEqual(writes,[]);await summary.click();
  await card(2).getByRole('button',{name:'候補から除外',exact:true}).click();await page.getByRole('group',{name:'関連付け判断の確認'}).waitFor();assert.deepEqual(writes,[]);await page.getByRole('button',{name:'キャンセル',exact:true}).click();assert.deepEqual(writes,[]);await summary.click();
  assert.equal(syncCalls.length,0,'Card rendering, body/quote/full/close and cancelled decisions never initiate additional sync');
  const before=calls.filter(p=>p.includes('/mail-candidate-body/')&&p.includes('/candidate-1/')).length;await page.locator('[data-case="'+D+'"]').click();assert.equal(await page.locator('[data-candidate-message]').count(),0);await page.locator('[data-case="'+C+'"]').click();await page.getByRole('button',{name:'やり取り',exact:true}).click();await summary.click();await card(1).locator('.mail-excerpt').getByText('第一行 candidate-1',{exact:false}).waitFor();assert.equal(calls.filter(p=>p.includes('/mail-candidate-body/')&&p.includes('/candidate-1/')).length,before+1);
  hold=true;await page.locator('[data-case="'+D+'"]').click();await page.locator('[data-case="'+C+'"]').click();await page.getByRole('button',{name:'やり取り',exact:true}).click();await summary.click();
  for(let n=0;n<100&&!waiters.length;n++)await new Promise(resolve=>setTimeout(resolve,10));assert(waiters.length>0);
  await page.locator('[data-case="'+D+'"]').click();hold=false;for(const resolve of waiters.splice(0))resolve();await page.waitForLoadState('networkidle');assert.equal(await page.locator('[data-candidate-message]').count(),0);assert(!(await page.locator('#detail-card').innerText()).includes('第一行 candidate-1'));
  await page.locator('[data-case="'+C+'"]').click();await page.getByRole('button',{name:'やり取り',exact:true}).click();await summary.click();await card(1).locator('.mail-excerpt').getByText('第一行 candidate-1',{exact:false}).waitFor();
  hold=true;await page.locator('[data-case="'+D+'"]').click();await page.locator('[data-case="'+C+'"]').click();await page.getByRole('button',{name:'やり取り',exact:true}).click();await summary.click();
  for(let n=0;n<100&&!waiters.length;n++)await new Promise(resolve=>setTimeout(resolve,10));assert(waiters.length>0);
  await page.getByRole('button',{name:'概要',exact:true}).click();hold=false;for(const resolve of waiters.splice(0))resolve();await page.waitForLoadState('networkidle');
  await page.getByRole('button',{name:'やり取り',exact:true}).click();await summary.click();await card(1).locator('.mail-excerpt').getByText('第一行 candidate-1',{exact:false}).waitFor({timeout:3000});
  const beforeLogout=calls.filter(p=>p.includes('/mail-candidate-body/')&&p.includes('/candidate-1/')).length;
  await page.locator('#sign-out').click();await page.getByText('ログアウトしました。',{exact:true}).waitFor();assert.equal(await page.locator('[data-candidate-message]').count(),0);
  await page.locator('#login-form input[name="email"]').fill('fixture@example.invalid');await page.locator('#login-form input[name="password"]').fill('fixture-only');await page.locator('#login-form button').click();await page.locator('[data-case="'+C+'"]').click();await page.getByRole('button',{name:'やり取り',exact:true}).click();await summary.click();await card(1).locator('.mail-excerpt').getByText('第一行 candidate-1',{exact:false}).waitFor();assert.equal(calls.filter(p=>p.includes('/mail-candidate-body/')&&p.includes('/candidate-1/')).length,beforeLogout+1);
  assert.deepEqual(writes,[]);assert.deepEqual(errors,[]);
  for(const decision of ['link','exclude']){
   decided=false;
   await page.locator('[data-case="'+D+'"]').click();await page.locator('[data-case="'+C+'"]').click();await page.getByRole('button',{name:'やり取り',exact:true}).click();await summary.click();
   await card(2).getByRole('button',{name:decision==='link'?'この案件に関連付ける':'候補から除外',exact:true}).click();
   assert.equal(writes.length,decision==='link'?0:1);
   await page.getByRole('button',{name:decision==='link'?'確定して関連付ける':'確定して除外する',exact:true}).click();
   await page.getByText('関連付け判断待ち 3件',{exact:true}).waitFor();
   assert.equal(writes.at(-1).decision,decision);assert.equal(await page.locator('[data-candidate-message="candidate-1"],[data-candidate-message="candidate-2"]').count(),0);
  }
  assert.equal(writes.length,2);assert.deepEqual(errors,[]);
  console.log('PASS explicit confirmation alone uses the unchanged thread/fingerprint decision API for link and exclude');
  console.log(JSON.stringify({status:'PASS',read_only_body_phase_writes:0,entry_sync_calls:syncCalls.length,body_or_card_sync_calls:0,mocked_confirmed_decisions:2,real_sends:0,real_business_decisions:0,case_logout_cleanup:true,normal_mail_preserved:true}));
 }finally{await browser.close();await new Promise(r=>server.close(r));}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
