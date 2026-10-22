'use strict';
// Actual CASE DESK/composer modules, loopback-only fabricated responses. No DB or provider.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),out=process.env.PAUI083_EVIDENCE;
const PA='11111111-1111-4111-8111-111111111111',OTHER='22222222-2222-4222-8222-222222222222';
const cases=[PA,OTHER].map((id,i)=>({id,case_type:i?'OTHER':'PA_EVENT',inquiry_number:'SYNTHETIC-083-'+i,event_name:'架空PAUI-083案件',customer_name:'架空の担当者',email:'customer@example.invalid',status:'new_inquiry',updated_at:'2026-10-22T00:00:00Z',revision:1,request_summary:'隔離試験・実メール送信なし'}));
const mail=(id,direction)=>({inquiry_id:id,gmail_message_id:direction==='inbound'?'in001':'out001',gmail_thread_id:'thread001',direction,subject:'Synthetic mail',from_address:direction==='inbound'?'customer@example.invalid':'aratechsound@gmail.com',to_addresses:direction==='inbound'?['aratechsound@gmail.com']:['customer@example.invalid'],cc_addresses:[],received_at:'2026-10-22T00:00:00Z',body_text:'架空メール・外部通信なし',attachment_metadata:[]});
let fixture,origin;const results=[],external=[];
const integration=`export const workspaceAuth={restore:async()=>({access_token:'synthetic-only',expires_at:9999999999}),current:async()=>({access_token:'synthetic-only',expires_at:9999999999}),logout:async()=>{},subscribe:()=>{}};
export const readUrl=p=>'/fixture-read?path='+encodeURIComponent(p);
export const legacyUrl=()=>{throw Error('LEGACY_FORBIDDEN')};
export const readPaCompletion=async c=>({inquiry:c,progress:{inquiry_id:c.id},commercial:{case_status:c.status,state:{},offers:[],billings:[],payments:[],adjustments:[],outbox:[],change_orders:[]}});
export const savePaCompletion=async()=>{throw Error('WRITE_FORBIDDEN')};export const readPaCompletionStatus=async()=>null;export const saveGeneralCompletion=async()=>{throw Error('WRITE_FORBIDDEN')};`;
const json=(res,data,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(data));};
const operation=(input,state)=>({operation_id:input.operation_id||'operation083',inquiry_id:input.inquiry_id,state,history_sync:fixture.history});
const server=http.createServer(async(req,res)=>{try{
 const u=new URL(req.url,'http://fixture');
 if(u.pathname==='/fixture'){
  const galleryProbe=`export * from '${origin}/pa-ui/js/gallery.mjs?probe-original';import {createGallery as actual} from '${origin}/pa-ui/js/gallery.mjs?probe-original';export function createGallery(...args){const g=actual(...args);if(new Error().stack.includes('case-mail-compose.mjs')){const probe={disposed:false};window.__composeGalleries.push(probe);const dispose=g.dispose.bind(g);g.dispose=()=>{probe.disposed=true;return dispose();};}return g;}`;
  const map=JSON.stringify({imports:{[origin+'/pa-ui/js/integration.mjs']:'data:text/javascript,'+encodeURIComponent(integration),[origin+'/pa-ui/js/gallery.mjs']:'data:text/javascript,'+encodeURIComponent(galleryProbe)}});
  let html=fs.readFileSync(path.join(root,'pa-admin.html'),'utf8').replace('<head>','<head><base href="/"><script type="importmap">'+map+'</scr'+'ipt>');
  return res.end(html);
 }
 if(u.pathname==='/fixture-read'){
  const p=u.searchParams.get('path');fixture.reads.push(p);
  if(fixture.sends&&fixture.mode==='history-fail'&&p==='/data/attention')return json(res,{ok:false,code:'synthetic_history_error'},503);
  if(fixture.sends&&fixture.mode==='surface-fail'&&p.startsWith('/data/mail/'))return json(res,{ok:false,code:'synthetic_history_error'},503);
  if(fixture.sends&&['pending-history','switch-history','logout-history'].includes(fixture.mode)&&p==='/data/attention'&&!fixture.releaseHistory){fixture.historyPending=true;await new Promise(r=>fixture.historyResolve=r);}
  if(fixture.mode==='switch-history'&&fixture.sends&&p==='/data/attention')return json(res,{ok:false,code:'synthetic_history_error'},503);
  const id=p.split('/').at(-1),data=p==='/data/cases'?{cases,progress:[]}:p.startsWith('/data/mail/')?[mail(id,'inbound'),mail(id,'outbound')]:p.startsWith('/data/materials/')?{items:[]}:p.startsWith('/data/commercial/')?{offers:[],billings:[],estimates:[],documents:[]}:[];
  return json(res,{ok:true,result:data});
 }
 if(u.pathname.startsWith('/api/')){
  let b='';for await(const chunk of req)b+=chunk;const input=b?JSON.parse(b):Object.fromEntries(u.searchParams),action=input.action;fixture.actions.push(action);
  if(u.pathname==='/api/pa-gmail'&&u.searchParams.has('case_mail')){
   if(action==='context')return json(res,{ok:true,result:{to:'customer@example.invalid',cc:[],subject:'Synthetic outgoing',allowed_recipients:['customer@example.invalid'],source_id:input.source_id||null,...(input.purpose==='invoice'?{invoice:{context_unavailable:true}}:{})}});
   if(action==='status')return json(res,{ok:true,result:{operation:fixture.sends?operation(input,fixture.mode==='send-reject-status-sent'?'SENT':fixture.state):null}});
   if(action==='preview')return json(res,{ok:true,result:{...input,source_id:input.source_id||null,thread_id:input.thread_id||null,operation:operation(input,'PREPARED'),operation_id:'operation083',confirmation_token:'synthetic-confirmation',expires_at:new Date(Date.now()+60000).toISOString(),html:'<p>Synthetic preview</p>',attachments:(input.attachments||[]).map(a=>({filename:a.filename,size:Buffer.from(a.data,'base64url').length,document_kind:a.document_kind||'normal',sha256:'a'.repeat(64)})),recipient_confirmation_needed:false}});
   if(action==='send'){
    fixture.sends++;fixture.sendInputs.push(input);if(fixture.mode==='pending-send')await new Promise(r=>fixture.sendResolve=r);
    if(fixture.mode.startsWith('send-reject'))return json(res,{ok:false,code:'reply_operation_unknown'},503);
    const op=operation(input,fixture.state);if(fixture.mode==='wrong-case')op.inquiry_id=OTHER;if(fixture.mode==='wrong-operation')op.operation_id='other-operation';
    return json(res,{ok:true,result:{operation:fixture.mode==='missing-state'?null:op,history_sync:fixture.history}});
   }
   if(action==='reconcile')return json(res,{ok:true,result:{operation:operation(input,fixture.state),verified:false}});
   throw Error('UNEXPECTED_CASE_MAIL_ACTION');
  }
  // Existing automatic/metadata clients receive inert fixture responses; never a provider.
  if(action==='quote_monitor_list')return json(res,{ok:true,result:{enabled:false,cases:[]}});
  if(action==='case_discovery_sync')return json(res,{ok:true,result:{enabled:false,complete:true,candidates:[],has_more:false}});
  if(action==='billing_index'||action==='original_index')return json(res,{ok:true,result:{case_id:input.case_id,read_projection:true,billings:[],documents:[],contracts:[]}});
  if(action==='invoice_history')return json(res,{ok:true,result:{inquiry_id:input.inquiry_id,read_only:true,records:[]}});
  return json(res,{ok:false,code:'synthetic_unavailable'},503);
 }
 const target=path.resolve(root,u.pathname.slice(1));if(!target.startsWith(root+path.sep))return res.writeHead(403).end();
 res.setHeader('content-type',target.endsWith('.css')?'text/css':/\.(mjs|js)$/.test(target)?'text/javascript':'text/html; charset=utf-8');res.end(fs.readFileSync(target));
 }catch(e){json(res,{error:e.message},500);}});
function reset(mode='success',state='SENT',history='COMPLETE'){fixture={mode,state,history,sends:0,sendInputs:[],actions:[],reads:[],releaseHistory:false};}
async function waitFor(fn){for(let i=0;i<100;i++){if(fn())return;await new Promise(r=>setTimeout(r,10));}throw Error('Synthetic condition timed out');}
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));origin='http://127.0.0.1:'+server.address().port;
 const browser=await chromium.launch({headless:true,...(process.env.PAUI083_CHROMIUM?{executablePath:process.env.PAUI083_CHROMIUM}:{})});
 try{
  for(const width of [1440,390]){
   async function pageFor(mode='success',state='SENT',history='COMPLETE'){
    reset(mode,state,history);const context=await browser.newContext({viewport:{width,height:900}}),page=await context.newPage();
    page.on('pageerror',e=>console.error('SYNTHETIC_PAGE_ERROR',e.message));
    await page.route(/^https?:\/\/(?!127\.0\.0\.1:)/,r=>{external.push(r.request().url());return r.abort();});
    await page.addInitScript(()=>{window.__composeGalleries=[];window.__composeTimers=[];const set=window.setInterval.bind(window),clear=window.clearInterval.bind(window);window.setInterval=(...args)=>{const id=set(...args);if(new Error().stack.includes('case-mail-compose.mjs'))window.__composeTimers.push({id,cleared:false});return id;};window.clearInterval=id=>{for(const p of window.__composeTimers)if(p.id===id)p.cleared=true;return clear(id);};});
    await page.goto(origin+'/fixture');await page.locator('[data-case="'+PA+'"]').waitFor();await page.locator('[data-case="'+PA+'"]').click();await page.getByRole('button',{name:'ゴミ箱へ移動',exact:true}).waitFor();return {page,context};
   }
   async function prepare(page,entry='new',attachment=false){
    if(entry!=='invoice')await page.locator('[data-tab=conversation]').click();
    if(['reply','contact'].includes(entry)){await page.locator(entry==='reply'?'[data-reply-message]':'[data-case-mail-message]').first().click();}
    else if(entry==='invoice'){await page.getByRole('button',{name:'請求・入金',exact:true}).click();await page.locator('[data-invoice-dispatch]').click();}
    else await page.locator('[data-action="case-mail-compose"]').click();
    const d=page.getByRole('dialog',{name:'CASE DESKメール作成',exact:true});await d.getByText(/照合済みの宛先候補/).waitFor();await d.getByLabel('本文',{exact:true}).fill('Synthetic owner mail');if(attachment)await d.getByLabel('添付ファイル（任意・複数可）',{exact:true}).setInputFiles({name:'synthetic.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-1.4 synthetic disposal fixture')});await d.getByRole('button',{name:'送信前プレビュー',exact:true}).click();await d.getByText('プレビュー確認済み。まだ送信していません。',{exact:true}).waitFor();await d.getByRole('checkbox').first().check();return d;
   }
   for(const entry of ['new','reply','contact','invoice']){
    const {page,context}=await pageFor();let discard=0;page.on('dialog',d=>{discard++;d.dismiss();});const d=await prepare(page,entry,entry==='new');
    await d.getByRole('button',{name:'最終確認してGmail送信',exact:true}).click();await d.waitFor({state:'detached'});await page.locator('[data-case-mail-status]').waitFor();
    assert.equal(fixture.sends,1);assert.equal(discard,0);assert(await page.evaluate(()=>window.__composeTimers.length>0&&window.__composeTimers.every(p=>p.cleared)));if(entry==='new')assert(await page.evaluate(()=>window.__composeGalleries.length>0&&window.__composeGalleries.every(p=>p.disposed)));assert.equal(fixture.sendInputs[0].inquiry_id,PA);assert.equal(fixture.sendInputs[0].kind,entry==='invoice'?'new':entry);assert.equal(fixture.sendInputs[0].purpose,entry==='invoice'?'invoice':'general');
    if(out&&entry==='new')await page.screenshot({path:path.join(out,'SENT_CLOSED_'+width+'.png')});
    results.push({width,scenario:entry+'_success_closes',status:'PASS',sends:1,duplicate_sends:0,guard_timers_cleared:true,...(entry==='new'?{attachment_gallery_disposed:true}:{})});await context.close();
   }
   for(const [mode,state]of [['success','FAILED'],['success','UNKNOWN'],['success','SENDING'],['missing-state','SENT'],['wrong-case','SENT'],['wrong-operation','SENT'],['send-reject-status-sent','SENT']]){
    const {page,context}=await pageFor(mode,state);const d=await prepare(page);await d.getByRole('button',{name:'最終確認してGmail送信',exact:true}).click();await d.getByRole('status').filter({hasText:/送信成功は未確認|結果未確認/}).waitFor();
    assert.equal(await d.isVisible(),true);assert.equal(await d.getByRole('button',{name:'最終確認してGmail送信',exact:true}).isDisabled(),true);assert.equal(fixture.sends,1);assert.equal(await page.locator('[data-case-mail-status]').count(),0);
    await d.getByRole('button',{name:'保存済み送信結果を照合',exact:true}).click();assert.equal(fixture.sends,1);results.push({width,scenario:mode+'_'+state+'_remains_open',status:'PASS',duplicate_sends:0});await context.close();
   }
   for(const mode of ['server-incomplete','history-fail','surface-fail']){
    const {page,context}=await pageFor(mode,'SENT',mode==='server-incomplete'?'INCOMPLETE':'COMPLETE');const d=await prepare(page);await d.getByRole('button',{name:'最終確認してGmail送信',exact:true}).click();await d.waitFor({state:'detached'});
    const warning=page.locator('[data-case-mail-status][role=alert]');await warning.waitFor();assert.match(await warning.innerText(),/Gmail送信済み.*履歴未更新.*再送不要.*照合/);assert.equal(fixture.sends,1);
    await page.getByRole('button',{name:'概要',exact:true}).click();await warning.waitFor();await page.locator('[data-case="'+OTHER+'"]').click();await page.locator('[data-action="case-mail-compose"]').waitFor();assert.equal(await warning.count(),0);await page.locator('[data-case="'+PA+'"]').click();await warning.waitFor();
    if(out&&mode==='history-fail')await page.screenshot({path:path.join(out,'HISTORY_WARNING_'+width+'.png')});results.push({width,scenario:mode+'_closes_warning_scoped_and_persistent',status:'PASS'});await context.close();
   }
   {
    const {page,context}=await pageFor('pending-send');const d=await prepare(page);await d.getByRole('button',{name:'最終確認してGmail送信',exact:true}).click();await waitFor(()=>fixture.sends===1);assert.equal(await d.isVisible(),true);
    await page.evaluate(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent==='最終確認してGmail送信');b.click();b.click();});assert.equal(fixture.sends,1);
    await d.getByRole('button',{name:'メール作成を閉じる',exact:true}).click();assert.equal(await d.isVisible(),true);fixture.sendResolve();await d.waitFor({state:'detached'});assert.equal(fixture.sends,1);results.push({width,scenario:'pending_send_stays_open_double_click_zero_duplicate',status:'PASS'});await context.close();
   }
   for(const mode of ['pending-history','switch-history','logout-history']){
    const {page,context}=await pageFor(mode);const d=await prepare(page);await d.getByRole('button',{name:'最終確認してGmail送信',exact:true}).click();await d.waitFor({state:'detached'});await waitFor(()=>fixture.historyPending);
    if(mode==='logout-history')await page.locator('#sign-out').click();else if(mode==='switch-history')await page.locator('[data-case="'+OTHER+'"]').click();
    fixture.releaseHistory=true;fixture.historyResolve();await page.waitForTimeout(100);
    if(mode!=='pending-history')assert.equal(await page.locator('[data-case-mail-status]').count(),0);assert.equal(fixture.sends,1);results.push({width,scenario:mode+'_no_late_cross_case_or_logout_notice',status:'PASS'});await context.close();
   }
  }
  assert.deepEqual(external,[]);
  const r={task_id:'PAUI-083',status:'PASS',actual_case_desk_and_composer:true,scenarios:results.length,results,duplicate_send_count:0,real_gmail_sends:0,production_db_writes:0,external_requests:0,production_changed:false};
  if(out)fs.writeFileSync(path.join(out,'TEST_RESULTS.json'),JSON.stringify(r,null,2)+'\n');console.log(JSON.stringify(r));
 }finally{await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
