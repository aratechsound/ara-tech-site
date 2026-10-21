'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),PA='11111111-1111-4111-8111-111111111111',OTHER='22222222-2222-4222-8222-222222222222';
(async()=>{
 const server=http.createServer((req,res)=>{const p=path.resolve(root,new URL(req.url,'http://fixture').pathname.slice(1));if(!p.startsWith(root+path.sep))return res.writeHead(403).end();try{res.setHeader('content-type',/\.(mjs|js)$/.test(p)?'text/javascript':p.endsWith('.css')?'text/css':'text/html; charset=utf-8');res.end(fs.readFileSync(p));}catch{res.writeHead(404).end();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 const browser=await chromium.launch({headless:true,...(process.env.PAUI079_CHROMIUM?{executablePath:process.env.PAUI079_CHROMIUM}:{})});
 const checks=[],observations=[];
 try{
  for(const width of [1440,390]){
   const context=await browser.newContext({viewport:{width,height:1000},timezoneId:'Asia/Tokyo'}),page=await context.newPage(),errors=[],external=[];
   page.on('pageerror',e=>errors.push(e.message));await page.route(/^https?:\/\/(?!127\.0\.0\.1:)/,r=>{external.push(r.request().url());return r.abort();});
   const probe=async label=>{
    const calls=await page.evaluate(()=>window.PAUI079_NETWORK||[]);
    assert.equal(calls.filter(c=>c.action==='case_discovery_sync'||c.path==='/api/pa-gmail').length,0,label);
    assert.equal(calls.filter(c=>c.action==='quote_monitor_check').length,0,'Passive original inspection '+label);
    assert(calls.every(c=>c.method==='GET'||['quote_monitor_list','quote_monitor_status','snapshot','change_evidence_candidates','original_index','billing_index'].includes(c.action)),label);
    assert.deepEqual(errors,[]);assert.deepEqual(external,[]);observations.push({width,scenario:label,request_intents:calls.length,sync:0,send:0,business_writes:0});
   };
   const select=async id=>{await page.locator('[data-case="'+id+'"]').click();await page.getByRole('button',{name:'ゴミ箱へ移動',exact:true}).waitFor();};
   await page.goto(origin+'/tests/paui079-preview.html');await page.locator('[data-case="'+PA+'"]').waitFor();await probe('login_restore');
   await page.reload();await page.locator('[data-case="'+PA+'"]').waitFor();await probe('reload');
   await page.locator('#refresh-cases').click();await page.locator('[data-case="'+PA+'"]').waitFor();await probe('refresh_list');
   await select(PA);await probe('select_pa_overview');
   await page.getByRole('button',{name:'やり取り',exact:true}).click();await page.locator('#mail-discovery [role=status]').getByText(/Gmailの最新確認はこの閲覧では実行していません/).waitFor();await page.getByText('保存済み合成メール',{exact:true}).waitFor();assert(!(await page.locator('#mail-discovery').innerText()).includes('最新確認済み'));await probe('pa_conversation_saved_mail');
   await page.getByRole('button',{name:'見積・受注',exact:true}).click();await page.locator('#order-documents').waitFor();await probe('pa_estimate_passive_quote_monitor');
   await page.getByRole('button',{name:'概要',exact:true}).click();await probe('overview_return');
   await select(OTHER);await page.getByRole('button',{name:'やり取り',exact:true}).click();await page.getByText('保存済み合成メール',{exact:true}).waitFor();await probe('general_conversation');
   await page.evaluate(()=>{window.dispatchEvent(new Event('focus'));document.dispatchEvent(new Event('visibilitychange'));});await probe('focus_visibility_return');
   await page.locator('#sign-out').click();await page.getByText('ログアウトしました。',{exact:true}).waitFor();
   await page.locator('#login-form input[name=email]').fill('fixture@example.invalid');await page.locator('#login-form input[name=password]').fill('fixture-only');await page.locator('#login-form button').click();await page.locator('[data-case="'+PA+'"]').waitFor();await probe('explicit_login');
   await select(PA);await page.getByRole('button',{name:'やり取り',exact:true}).click();await page.locator('#mail-discovery [role=status]').getByText(/Gmailの最新確認はこの閲覧では実行していません/).waitFor();
   const out=process.env.PAUI079_EVIDENCE;if(out){fs.mkdirSync(out,{recursive:true});await page.screenshot({path:path.join(out,'SAVED_MAIL_'+width+'.png')});}
   assert((await page.evaluate(()=>window.PAUI079_NETWORK)).some(c=>c.action==='quote_monitor_list'),'Enabled stale Quote Monitor was exercised');checks.push('passive_lifecycle_zero_sync_'+width);await context.close();
  }
  // The retained legacy discovery module must also be GET-only, even for enabled partial state.
  const page=await browser.newPage();await page.goto(origin+'/tests/paui079-preview.html');await page.locator('[data-case="'+PA+'"]').waitFor();
  const legacy=await page.evaluate(async origin=>{const {createMailDiscovery}=await import(origin+'/pa-ui/js/mail-discovery.mjs');const host=document.createElement('div');host.id='mail-discovery';document.body.append(host);let reads=0,indexed=0;const d=createMailDiscovery({read:async()=>{reads++;return {enabled:true,complete:false,has_more:true,candidates:[]}},getSession:async()=>({access_token:'fixture-only'}),isCurrent:()=>true,onIndexed:async()=>indexed++});await d.check('legacy-fixture');const text=host.textContent;d.cancel();return {reads,indexed,text,calls:window.PAUI079_NETWORK};},origin);
  assert.equal(legacy.reads,1);assert.equal(legacy.indexed,0);assert(legacy.text.includes('最新確認はこの閲覧では実行していません'));assert(!legacy.calls.some(c=>c.action==='case_discovery_sync'));checks.push('legacy_discovery_saved_get_only');await page.close();
  const result={task_id:'PAUI-079',status:'PASS',checks,observations,auto_gmail_sync_calls:0,customer_mail_sent:0,business_data_writes:0,db_changed:false,production_changed:false};
  if(process.env.PAUI079_EVIDENCE)fs.writeFileSync(path.join(process.env.PAUI079_EVIDENCE,'PASSIVE_VIEW_RESULTS.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
 }finally{await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
