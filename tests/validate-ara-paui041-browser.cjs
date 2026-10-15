'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),C='11111111-1111-4111-8111-111111111111',D='22222222-2222-4222-8222-222222222222';
(async()=>{
 const server=http.createServer((req,res)=>{const file=path.join(root,new URL(req.url,'http://localhost').pathname);if(!file.startsWith(root+path.sep))return res.writeHead(403).end();try{res.setHeader('content-type',file.endsWith('.mjs')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(file));}catch{res.writeHead(404).end();}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage({timezoneId:'Asia/Tokyo',viewport:{width:1440,height:900}}),errors=[],writes=[];let pages=0,fail=false;
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/pa-ui/js/integration.mjs',r=>r.fulfill({contentType:'text/javascript',body:"const s={access_token:'fixture-only',expires_at:9999999999};export const workspaceAuth={restore:async()=>s,current:async()=>s,subscribe:()=>{}};export const readUrl=p=>'/api/pa-workspace-read?path='+encodeURIComponent(p);export const legacyUrl=()=>{throw Error('NO_BUSINESS_ACTION');};"}));
  const row=(id,time)=>({gmail_message_id:id,direction:'inbound',subject:'Fixture mail',from_address:'fixture@example.invalid',to_addresses:['owner@example.invalid'],received_at:time,attachment_metadata:[]});
  await page.route('**/api/pa-workspace-read?**',async r=>{
   const p=new URL(r.request().url()).searchParams.get('path');let result=[];
   if(p==='/data/cases')result={cases:[{id:C,event_name:'Fixture case',status:'new',case_type:'PA_EVENT'},{id:D,event_name:'Other case',status:'new',case_type:'PA_EVENT'}],progress:[]};
   else if(p.startsWith('/data/mail-discovery/'))result={enabled:true,complete:pages>=3,last_completed_at:'2026-10-15T00:00:00Z',candidates:[{gmail_thread_id:'ambiguous',gmail_message_id:'candidate',subject:'<img src=x onerror=alert(1)>',occurred_at:'2026-10-14T00:00:00Z',fingerprint:'a'.repeat(64)}]};
   else if(p.startsWith('/data/mail/'))result=[row('old','2026-10-14T08:52:52Z'),...(pages>=3?[row('new','2026-10-14T11:57:08Z')]:[])];
   else if(p.startsWith('/data/commercial/'))result={estimates:[],offers:[],documents:[],billings:[]};
   else if(p.startsWith('/data/materials/'))result={cards:[],photos:[]};
   await r.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,result})});
  });
  await page.route('**/api/pa-gmail',async r=>{const body=r.request().postDataJSON();assert.equal(r.request().method(),'POST');assert.equal(r.request().headers().authorization,'Bearer fixture-only');writes.push(body);if(fail)return r.fulfill({status:503,contentType:'application/json',body:'{"ok":false}'});pages++;return r.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,result:{complete:pages>=3,has_more:pages<3,last_completed_at:'2026-10-15T00:00:00Z'}})});});
  await page.goto('http://127.0.0.1:'+server.address().port+'/pa-admin.html');await page.locator('[data-case="'+C+'"]').click();assert.equal(writes.length,0,'Overview must not initiate mail writes');
  await page.getByRole('button',{name:'やり取り',exact:true}).click();await page.locator('#mail-discovery').getByText(/最新確認済み/).waitFor();
  assert.equal(writes.length,3);assert(writes.every(w=>w.action==='case_discovery_sync'&&w.inquiry_id===C));assert.deepEqual(await page.locator('.mail-list > [data-message]').evaluateAll(n=>n.map(x=>x.dataset.message)),['new','old']);
  await page.locator('#mail-discovery summary').click();assert.equal(await page.locator('#mail-discovery img').count(),0);assert((await page.locator('#mail-discovery').innerText()).includes('<img src=x onerror=alert(1)>'));assert.equal(writes.length,3,'Candidate render never auto-approves');
  await page.locator('[data-discovery-link="ambiguous"]').click();assert.equal(writes.length,3,'Opening confirmation is inert');await page.getByRole('button',{name:'キャンセル',exact:true}).click();assert.equal(writes.length,3,'Cancel is inert');
  await page.locator('#mail-discovery summary').click();await page.locator('[data-discovery-link="ambiguous"]').click();await page.getByRole('button',{name:'確定して関連付ける',exact:true}).click();await page.locator('#mail-discovery').getByText(/最新確認済み/).waitFor();assert.equal(writes.length,4);assert.deepEqual(writes.at(-1),{action:'case_discovery_decide',inquiry_id:C,gmail_thread_id:'ambiguous',fingerprint:'a'.repeat(64),decision:'link'});
  fail=true;await page.locator('[data-case="'+D+'"]').click();await page.getByRole('button',{name:'やり取り',exact:true}).click();await page.locator('#mail-discovery').getByText(/確認未完了/).waitFor();assert.equal(writes.length,5);assert.equal(writes.at(-1).inquiry_id,D);assert(!writes.some(w=>/send|mark|inbox_sync|manual_link/.test(w.action)));assert.deepEqual(errors,[]);
  console.log('PASS PAUI-041 browser: overview writes=0; auto pages=3; same-case index refresh/newest-first; candidate XSS inert/no auto-approval; API failure stays incomplete; normal Owner Bearer; no business action');
 }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(e=>{console.error(e);process.exitCode=1;});
