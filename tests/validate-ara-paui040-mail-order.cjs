'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),http=require('node:http');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),source=fs.readFileSync(path.join(root,'pa-ui/js/desk.mjs'),'utf8');
const helpers=source.slice(source.indexOf('function mailDateValue('),source.indexOf('const shortDate='));
const context=vm.createContext({});vm.runInContext(helpers,context);
const fixtures=[
 {gmail_message_id:'old',direction:'inbound',received_at:'2026-10-13T23:00:00Z',indexed_at:'2099-01-01T00:00:00Z'},
 {gmail_message_id:'unknown-a',direction:'inbound',received_at:null,indexed_at:'2099-12-31T00:00:00Z'},
 {gmail_message_id:'tie-a',direction:'inbound',received_at:'2026-10-14T17:52:00+09:00'},
 {gmail_message_id:'sent',direction:'outbound',sent_at:'2026-10-14T09:00:00Z',received_at:'2020-01-01T00:00:00Z'},
 {gmail_message_id:'unknown-b',direction:'outbound',sent_at:'invalid',indexed_at:'2100-01-01T00:00:00Z'},
 {gmail_message_id:'newest',direction:'inbound',received_at:'2026-10-14T20:57:00+09:00',sent_at:'2027-01-01T00:00:00Z'},
 {gmail_message_id:'tie-b',direction:'outbound',sent_at:'2026-10-14T01:52:00-07:00'},
 {gmail_message_id:'fallback',direction:'inbound',received_at:'invalid',sent_at:'2026-10-14T08:50:00Z'},
 {gmail_message_id:'early',direction:'inbound',received_at:'2026-10-14T17:48:00+09:00'},
 {gmail_message_id:'epoch',direction:'outbound',sent_at:'1970-01-01T00:00:00Z'}
].map(row=>({...row,subject:'Synthetic '+row.gmail_message_id,body_text:'Fixture body\nOriginal next line\n> Quoted fixture',attachment_metadata:row.gmail_message_id==='newest'?[{id:'fixture-pdf',filename:'synthetic.pdf',mime_type:'application/pdf',size:0}]:[]}));
const expected=['newest','sent','tie-a','tie-b','fallback','early','old','epoch','unknown-a','unknown-b'];
const frozen=Object.freeze(fixtures.map(row=>Object.freeze({...row}))),before=JSON.stringify(frozen),sorted=context.newestMessages(frozen);
assert.deepEqual(Array.from(sorted,row=>row.gmail_message_id),expected);
assert.equal(JSON.stringify(frozen),before);assert.notEqual(sorted,frozen);
for(const row of sorted)assert(frozen.includes(row),'Original row objects must be retained');
assert.equal(context.mailDateValue(fixtures[3]),fixtures[3].sent_at);assert.equal(context.mailDateValue(fixtures[5]),fixtures[5].received_at);
assert.equal(context.mailDateValue(fixtures[1]),null);assert.equal(context.mailDateValue(fixtures[4]),null);
assert.deepEqual(Array.from(context.newestMessages([])),[]);
assert.match(source,/mail-list[\s\S]*newestMessages\(rows\)\.map/);
assert.match(source,/date\(mailDateValue\(r\)\)/);
(async()=>{
 const C='11111111-1111-4111-8111-111111111111',D='22222222-2222-4222-8222-222222222222';
 const server=http.createServer((req,res)=>{const file=path.join(root,new URL(req.url,'http://localhost').pathname);if(!file.startsWith(root+path.sep)){res.writeHead(403).end();return;}try{res.setHeader('content-type',file.endsWith('.mjs')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(file));}catch{res.writeHead(404).end();}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const browser=await chromium.launch({headless:true,...(process.env.PAUI021_BROWSER?{executablePath:process.env.PAUI021_BROWSER}:{})});
 try{
  for(const timezoneId of ['UTC','Asia/Tokyo','America/Los_Angeles']){
   const page=await browser.newPage({timezoneId,viewport:{width:1440,height:900}}),errors=[],requests=[];
   page.on('pageerror',e=>errors.push(e.message));
   await page.route('**/pa-ui/js/integration.mjs',r=>r.fulfill({contentType:'text/javascript',body:"export const workspaceAuth={restore:async()=>({access_token:'fixture-only',expires_at:9999999999}),subscribe:()=>{}};export const readUrl=p=>'/api/pa-workspace-read?path='+encodeURIComponent(p);export const legacyUrl=()=>{throw Error('NO_BUSINESS_ACTION');};"}));
   await page.route('**/api/pa-workspace-read?**',async r=>{
    const p=new URL(r.request().url()).searchParams.get('path');requests.push({path:p,method:r.request().method()});let result=[];
    if(p==='/data/cases')result={cases:[{id:C,event_name:'Synthetic festival',status:'new',case_type:'PA_EVENT'},{id:D,event_name:'Common mail case',status:'new',case_type:'OTHER'}],progress:[]};
    else if(p.startsWith('/data/mail/'))result=fixtures.map(row=>({...row,inquiry_id:p.endsWith(C)?C:D}));
    else if(p.startsWith('/data/mail-body/'))result={gmail_message_id:p.split('/').pop(),body_text:'Fixture body\nOriginal next line\n> Quoted fixture'};
    else if(p.endsWith('/deliveries'))result=[{id:'delivery-original',subject:'Synthetic delivery',status:'mail_outcome_unknown',requested_at:'2026-01-01T00:00:00Z'}];
    else if(p.startsWith('/data/commercial/'))result={estimates:[],offers:[],documents:[],billings:[]};
    else if(p.startsWith('/data/materials/'))result={cards:[],photos:[]};
    await r.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,result})});
   });
   await page.goto('http://127.0.0.1:'+server.address().port+'/pa-admin.html');
   for(const id of [C,D]){
    await page.locator('[data-case="'+id+'"]').click();await page.getByRole('button',{name:'やり取り',exact:true}).click();
    await page.locator('[data-message="newest"]').waitFor();
    assert.deepEqual(await page.locator('.mail-list > [data-message]').evaluateAll(nodes=>nodes.map(n=>n.dataset.message)),expected);
    const card=page.locator('[data-message="newest"]');await card.getByRole('button',{name:'全文を表示',exact:true}).click();
    await card.getByRole('button',{name:'閉じる',exact:true}).waitFor();assert((await card.locator('.mail-excerpt').innerText()).includes('Original next line'));
    await card.locator('[data-quoted-body] summary').click();assert.equal(await card.locator('[data-quoted-body]').evaluate(n=>n.open),true);
    assert.equal(await card.locator('[data-attachments="newest"]').count(),1);assert((await card.innerText()).includes('添付 1件'));
    await page.getByText('案内・配送記録',{exact:true}).click();assert((await page.locator('#detail-card').innerText()).includes('UNKNOWN / 再送停止'));
    assert.equal(await page.locator('.mail-list > [data-message]').count(),fixtures.length);
    assert.equal(await page.locator('[data-message="unknown-a"] time').innerText(),'未提供');
    assert.equal(await page.locator('[data-message="unknown-b"] time').innerText(),'未提供');
   }
   assert.deepEqual(errors,[]);assert(requests.every(r=>r.method==='GET'));
   assert(!requests.some(r=>/inbox_sync|manual_link|mail-live|send|mark-read/.test(r.path)));
   await page.close();
  }
  assert.equal(JSON.stringify(frozen),before);
  console.log('PASS PAUI-040: 2 cases x 3 timezones; received/sent priority, mixed newest-first, stable ties, unknown last, epoch, index excluded, array/IDs/count retained, body/quote/attachments and delivery UNKNOWN retained; GET-only fixtures');
 }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(e=>{console.error(e);process.exitCode=1;});
