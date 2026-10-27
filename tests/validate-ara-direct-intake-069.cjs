'use strict';
// Synthetic browser -> real intake API -> disposable PG16 -> CASE DESK ->
// existing durable composer/backend. All providers are local fakes, network=none.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium}=require('playwright'),{fixture}=require('./helpers/ara-case-real-fixture.cjs');
const root=path.resolve(__dirname,'..'),out=fs.existsSync('/evidence')?'/evidence':'/tmp',base='http://127.0.0.1:8876';
const f=fixture({database:'ara_case_r3_verify',restPort:55444}),trace=[],errors=[],checks=[];
const sql=f.sql,asJson=q=>JSON.parse(sql(q));
const quote=v=>"'"+String(v).replaceAll("'","''")+"'";
const operation=(inquiryId,id=null)=>asJson("select pa_case_mail_operation_v1('"+f.actor+"','get',jsonb_build_object('inquiry_id',"+quote(inquiryId)+",'operation_id',"+(id?quote(id):'null')+"))->'operation';");
const schemaBefore=sql("select md5(string_agg(proname||pg_get_functiondef(p.oid)||coalesce(proacl::text,''),'' order by p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind='f';");
const business=()=>sql("select json_build_array((select md5(coalesce(string_agg(to_jsonb(t)::text,'' order by to_jsonb(t)::text),''))from pa_contracts t),(select md5(coalesce(string_agg(to_jsonb(t)::text,'' order by to_jsonb(t)::text),''))from pa_estimate_revisions t),(select count(*)from pa_billings),(select count(*)from pa_payment_records));");
const businessBefore=business(),proofs=new Set();
Object.assign(process.env,{ALLOWED_ORIGINS:base,ARA_GENERAL_INQUIRY_ENABLED:'true',ARA_TURNSTILE_SECRET:'synthetic-secret',ARA_GENERAL_NOTIFICATION_POLICY:JSON.stringify({verified:true,notification_recipient:'aratechsound@gmail.com',receipt_enabled:false,spam_adapter:'turnstile',captcha_site_key:'fixture-site-key',captcha_hostname:'fixture.example.invalid'})});
global.fetch=async(target,options={})=>{
 const u=new URL(target);trace.push({host:u.hostname,path:u.pathname,method:options.method||'GET'});
 if(u.hostname==='challenges.cloudflare.com'){const token=new URLSearchParams(options.body).get('response'),success=!!token&&!proofs.has(token);proofs.add(token);return new Response(JSON.stringify({success,hostname:'fixture.example.invalid',action:'general-inquiry'}));}
 if(u.hostname==='kogbnremsouajxxsgxro.supabase.co'){u.protocol='http:';u.hostname='127.0.0.1';u.port='55444';return f.fetchImpl(u,options);}
 return f.fetchImpl(u,options);
};
const intake=require('../api/pa-inquiry.js'),gmail=require('../api/pa-gmail.js'),{dispatchWorkspaceRead}=require('../api/_pa-workspace-handler.cjs');
const server=http.createServer(async(req,res)=>{try{
 const u=new URL(req.url,base);res.setHeader('Cache-Control','no-store');res.status=n=>{res.statusCode=n;return res;};res.json=v=>res.end(JSON.stringify(v));
 let body='';for await(const b of req)body+=b;req.body=body?JSON.parse(body):{};
 if(u.pathname==='/api/pa-inquiry')return intake(req,res);
 if(u.pathname==='/api/pa-gmail')return gmail(req,res);
 if(u.pathname==='/api/pa-workspace-read')return dispatchWorkspaceRead(req,res);
 const p=path.resolve(root,u.pathname.slice(1));if(!p.startsWith(root+path.sep)||!fs.existsSync(p))return res.status(404).end();res.setHeader('Content-Type',/\.(?:m?js)$/.test(p)?'text/javascript':p.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(p));
}catch(e){errors.push(e.message);if(!res.headersSent)res.statusCode=500;res.end('{"ok":false,"code":"fixture_failure"}');}});
const fake="window.turnstile={render:(n,o)=>(window.proof=o,'widget'),reset:()=>{}};window.solve=()=>window.proof.callback('single-use-'+crypto.randomUUID());";
(async()=>{await new Promise(r=>server.listen(8876,'127.0.0.1',r));const browser=await chromium.launch({headless:true});
 try{
 for(const width of [1440,390]){
  // Public registration is intentionally independent from the unapplied 9-arg
  // historical-mail import RPC. No inbox_decide or Gmail original is required.
  sql("update api_rate_limit_buckets set window_expires_at=now()-interval '1 second';");f.state.failSend=true;
  const customer='Synthetic Direct '+width,email='direct'+width+'@example.invalid',page=await browser.newPage({viewport:{width,height:950}});page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
  await page.route('**/*',r=>{const u=new URL(r.request().url());if(u.hostname==='challenges.cloudflare.com')return r.fulfill({contentType:'text/javascript',body:fake});if(u.hostname!=='127.0.0.1')return r.abort();return r.continue();});
  await page.goto(base+'/general-inquiry.html');await page.locator('#case-type').selectOption('OTHER');await page.locator('#inquiry-type').selectOption('設備導入');await page.locator('#name').fill(customer);await page.locator('#email').fill(email);await page.locator('#subject').fill('Synthetic direct inquiry');await page.locator('#message').fill('Synthetic inquiry body\nNo Gmail original exists.');await page.waitForFunction(()=>window.solve);await page.evaluate(()=>window.solve());await page.locator('[type=submit]').click();await page.waitForFunction(()=>!!document.querySelector('form').dataset.inquiryNumber);
  const number=await page.locator('form').getAttribute('data-inquiry-number');assert.match(number,/^PA-\d{8}-\d{5}$/);const c=asJson('select to_jsonb(i) from pa_inquiries i where inquiry_number='+quote(number)+';');assert.equal(c.customer_name,customer);assert.equal(c.case_type,'OTHER');assert.equal(c.email,email);assert.equal(c.first_form_data.import_source,'general_public_form');
  assert.equal(sql('select count(*)from pa_gmail_message_index where inquiry_id='+quote(c.id)),'0');assert.equal(sql('select count(*)from pa_gmail_thread_links where inquiry_id='+quote(c.id)),'0');checks.push({name:'direct_api_pg_no_gmail_source_'+width,pass:true});
  const before=f.state.sends;await page.route('**/pa-ui/js/integration.mjs',r=>r.fulfill({contentType:'text/javascript',body:`const s={access_token:${JSON.stringify(f.jwt('authenticated'))},expires_at:9999999999};export const workspaceAuth={restore:async()=>s,current:async()=>s,logout:async()=>{},subscribe:()=>{}};export const readUrl=p=>'/api/pa-workspace-read?path='+encodeURIComponent(p);export const legacyUrl=()=>{throw Error('legacy forbidden');};`}));
  await page.goto(base+'/pa-admin.html');await page.locator('[data-case="'+c.id+'"]').click();await page.locator('#title').filter({hasText:customer}).waitFor();assert.equal(await page.getByRole('button',{name:'請求・入金',exact:true}).isVisible(),false);assert.equal(await page.locator('#detail-card').getByText('イベント名未設定',{exact:true}).count(),0);await page.getByText('Synthetic inquiry body',{exact:false}).first().waitFor();await page.screenshot({path:out+'/DIRECT_CASE_'+width+'.png'});checks.push({name:'real_workspace_api_general_case_display_'+width,pass:true});
  await page.locator('[data-action="case-mail-compose"]').click();const d=page.getByRole('dialog',{name:'CASE DESKメール作成'});await page.waitForFunction(e=>document.querySelector('.case-mail-compose input:not([type=file])')?.value===e,email);assert.equal(await d.getByLabel('起点メール',{exact:true}).inputValue(),'');await d.getByLabel('件名',{exact:true}).fill('Synthetic source-free reply');await d.getByLabel('本文',{exact:true}).fill('Synthetic Owner response '+width);await d.getByRole('button',{name:'送信前プレビュー'}).click();await d.getByText('プレビュー確認済み。まだ送信していません。').waitFor();assert.equal(f.state.sends,before);
  const op=operation(c.id);assert.equal(op.state,'PREPARED');assert.equal(op.binding.source_id,null);assert.equal(op.binding.thread_id,null);assert.equal(op.binding.to,email);assert.equal(op.binding.attachments.length,0);assert.equal(op.binding.kind,'new');await page.screenshot({path:out+'/DIRECT_PREVIEW_'+width+'.png'});checks.push({name:'real_backend_source_free_prepared_preview_'+width,pass:true});
  f.state.failSend=width===390;await d.getByRole('checkbox',{name:'対象案件・宛先・件名・本文・添付を最終確認しました'}).check();await d.getByRole('button',{name:'最終確認してGmail送信'}).click();
  if(width===1440){await require('./helpers/assert-case-mail-sent.cjs')(page,d);const sent=operation(c.id,op.operation_id);assert.equal(sent.state,'SENT');assert.equal(sent.history_sync,'COMPLETE');assert.equal(sql('select count(*)from pa_inquiry_audit where inquiry_id='+quote(c.id)+" and action='gmail_case_message_sent'"),'1');assert.equal(sql('select count(*)from pa_gmail_message_index where inquiry_id='+quote(c.id)),'1');checks.push({name:'mock_ack_sent_audit_index_history',pass:true});}
  else{try{await d.getByText('結果未確定の送信操作があります。再送せず結果照合を行ってください。').waitFor();}catch(e){console.error(JSON.stringify({stage:'mobile_unknown',dialog:await d.innerText(),operation:operation(c.id,op.operation_id),sends:f.state.sends,before,trace:trace.slice(-12),errors}));throw e;}const unknown=operation(c.id,op.operation_id);assert.equal(unknown.state,'UNKNOWN');assert.equal(await d.getByRole('button',{name:'最終確認してGmail送信'}).isEnabled(),false);assert.equal(sql('select count(*)from pa_gmail_message_index where inquiry_id='+quote(c.id)),'0');checks.push({name:'mock_unknown_persistent_no_resend_no_index',pass:true});}
  assert.equal(f.state.sends,before+1);if(width===390)await page.getByRole('button',{name:'メール作成を閉じる'}).click();await page.getByRole('button',{name:'ログアウト',exact:true}).click();await page.locator('#login-screen').waitFor();assert.equal(await page.getByText(customer,{exact:true}).count(),0);await page.close();
 }
 assert(!trace.some(t=>t.path.endsWith('/rpc/ara_decide_mail')));assert.equal(business(),businessBefore);assert.equal(sql("select md5(string_agg(proname||pg_get_functiondef(p.oid)||coalesce(proacl::text,''),'' order by p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind='f';"),schemaBefore);assert.deepEqual(errors,[]);
 const result={task_id:'PAUI-069',status:'PASS',checks,total:checks.length,postgres:'16',public_intake:'ara_register_general',past_mail_import_used:false,pc_mobile:true,real_case_desk_and_backend:true,provider:'mock_only',real_gmail_send:0,production_writes:0,business_records_preserved:true,functions_grants_preserved:true};fs.writeFileSync(out+'/DIRECT_INTEGRATION.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
 }finally{await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
