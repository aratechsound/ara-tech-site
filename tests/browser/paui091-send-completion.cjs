// Real CASE DESK, reply state/composer, reply API implementation and PGlite.
// OAuth/Gmail and HTTP authentication are isolated fakes; live network forbidden.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium}=require('playwright'),{createFixture}=require('../helpers/ara-case-fixture.cjs');
const root=path.resolve(__dirname,'../..'),A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
(async()=>{
 const f=await createFixture(),{syncCase,replyContext,replyPreview,sendReply,normalizeMessage}=require('../../api/_pa-gmail.cjs');
 await f.db.query("insert into pa_inquiries(id,inquiry_number,customer_name,email,case_type,status) values($1,'PA-FIXTURE-A','Fixture A','customer@example.invalid','AV_INSTALL','new_inquiry'),($2,'PA-FIXTURE-B','Fixture B','other@example.invalid','AV_INSTALL','new_inquiry')",[A,B]);
 await f.db.query("insert into pa_gmail_thread_links(inquiry_id,gmail_thread_id,link_source,conversation_role) values($1,'thread_1','manual','primary_conversation')",[A]);
 await f.db.query("update pa_inquiries set submission_source='public_form', submission_key=id, venue='Fixture Park', request_summary='PA timeline fixture' where id=$1",[B]);
 const inbound=f.raw('source','thread_1');f.state.messages.set(inbound.id,inbound);f.state.threadMessages.set('thread_1',[inbound]);
 let outgoingBody='',latestSent=null,failRead=false,duplicateRead=false,loseReply=false,holdSend=false,releaseSend,holdSync=false,releaseSync;
 const posts=[],provider=[],checks=[];
 const transport=async(url,opts={})=>{
  const u=new URL(url);provider.push({host:u.host,path:u.pathname,method:opts.method||'GET'});
  if(u.host==='gmail.googleapis.com'&&u.pathname.endsWith('/messages/send')){
   assert.equal(opts.method,'POST');const data=JSON.parse(opts.body);assert.equal(data.threadId,'thread_1');f.state.sendCount++;
   const raw=f.raw('sent_'+f.state.sendCount,'thread_1','aratechsound@gmail.com',outgoingBody);raw.labelIds=['SENT'];raw.internalDate=String(Date.now()+f.state.sendCount*1000);raw.payload.headers.find(h=>h.name==='To').value='customer@example.invalid';
   f.state.messages.set(raw.id,raw);f.state.threadMessages.get('thread_1').push(raw);latestSent=raw.id;return {ok:true,json:async()=>({id:raw.id,threadId:raw.threadId})};
  }
  return f.fetchImpl(url,opts);
 };
 await syncCase({inquiryId:A,actorId:f.actor,linkedOnly:true},transport);
 const protectedBefore=(await f.db.query('select to_jsonb(i) row from pa_inquiries i order by id')).rows;
 const linksBefore=(await f.db.query('select to_jsonb(l) row from pa_gmail_thread_links l order by id')).rows;
 const metadata=async id=>{const row=(await f.db.query('select state from paui041_mail_sync_state where inquiry_id=$1',[id])).rows[0],s=row?.state?.linked_sync;return {inquiry_id:id,scope:'existing_linked_threads',complete:Boolean(s?.complete),last_success_at:s?.checked_at||null,thread_ids:s?.thread_ids||[],message_count:s?.message_count||0};};
 const integration=`let active=true;export const workspaceAuth={async restore(){if(!active)throw Error('login_required');return {user:{id:'fixture-owner'},access_token:'fixture-only',expires_at:9999999999};},async current(){return this.restore();},subscribe(){},async logout(){active=false;}};window.revokeSendFixture=()=>{active=false;};export const readUrl=p=>'/fixture-read?path='+encodeURIComponent(p);export const legacyUrl=id=>'/pa-admin-legacy.html?case='+encodeURIComponent(id);`;
 const server=http.createServer(async(req,res)=>{try{
  const u=new URL(req.url,'http://localhost'),json=(v,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(v));};
  if(u.pathname==='/pa-ui/js/integration.mjs'){res.writeHead(200,{'content-type':'text/javascript'});return res.end(integration);}
  if(u.pathname==='/api/pa-gmail'){
   let raw='';for await(const c of req)raw+=c;const p=JSON.parse(raw);posts.push(p);assert.equal(req.headers.authorization,'Bearer fixture-only');assert.equal(p.inquiry_id,A,'only fixture A can issue a mail request');
   const args={inquiryId:p.inquiry_id,actorId:f.actor,replySourceMessageId:p.reply_source_message_id,replySourceThreadId:p.reply_source_thread_id};
   if(p.action==='sync'){assert.equal(p.linked_only,true);const result=await syncCase({...args,linkedOnly:true},transport);if(holdSync)await new Promise(r=>{releaseSync=r;});return json({ok:true,result});}
   if(p.action==='reply_context')return json({ok:true,context:await replyContext(args,transport)});
   if(p.action==='reply_preview')return json({ok:true,preview:await replyPreview({...args,body:p.body,ccAddresses:p.cc_addresses,attachments:p.attachments,mode:p.mode},transport)});
   if(p.action==='send_reply'){
    outgoingBody=p.body;const result=await sendReply({...args,body:p.body,ccAddresses:p.cc_addresses,attachments:p.attachments,mode:p.mode,confirmationToken:p.confirmation_token},transport);
    if(holdSend)await new Promise(r=>{releaseSend=r;});if(loseReply)return json({ok:false,code:'send_outcome_unknown'},502);return json({ok:true,result});
   }
   throw Error('FORBIDDEN_ACTION '+p.action);
  }
  if(u.pathname==='/fixture-read'){
   const route=u.searchParams.get('path'),parts=route.split('/');let result=[];
   if(route==='/data/cases')result={cases:(await f.db.query('select * from pa_inquiries order by id')).rows,progress:[]};
   else if(route==='/data/attention')result=(await f.db.query('select * from pa_case_mail_attention')).rows;
   else if(parts[2]==='case'&&parts[4]==='deliveries'&&parts[3]===B){
    const receipt={inquiry_id:B,recipient:'other@example.invalid',subject:'Fixture receipt',body:'Fixture body',status:'sent',sent_at:'2026-11-13T01:58:51Z'};
    result=[
      {...receipt,id:'receipt',message_type:'customer_receipt',gmail_message_id:'receipt'},
      {...receipt,id:'internal',message_type:'internal_new_inquiry',gmail_message_id:'internal'},
      {...receipt,id:'unknown',message_type:'schedule_request',status:'sending',gmail_message_id:null},
      {...receipt,id:'failed',message_type:'schedule_request',status:'failed',gmail_message_id:null}
    ];
   }
   else if(parts[2]==='case'){const id=parts[3];if(parts[4]==='links')result=(await f.db.query('select * from pa_gmail_thread_links where inquiry_id=$1',[id])).rows;else if(parts[4]==='mail-sync')result=await metadata(id);else if(parts[4]==='attention')result=(await f.db.query('select * from pa_case_mail_attention where inquiry_id=$1',[id])).rows;}
   else if(parts[2]==='mail'){if(failRead&&latestSent&&parts[3]===A)return json({ok:false,code:'fixture_read_failed'},503);result=(await f.db.query('select * from pa_gmail_message_index where inquiry_id=$1 order by greatest(received_at,sent_at) desc',[parts[3]])).rows;if(duplicateRead&&result[0])result.push({...result[0]});}
   else if(parts[2]==='mail-live'){
    if(parts[3]===B)return json({ok:false,code:'fixture_gmail_unavailable'},503);
    result={messages:(await f.db.query('select * from pa_gmail_message_index where inquiry_id=$1',[parts[3]])).rows,status:'linked_threads_current'};
   }
   else if(parts[2]==='mail-body'){const m=normalizeMessage(f.state.messages.get(parts[4]));result={gmail_message_id:m.id,inquiry_id:parts[3],body_text:m.body_text,body_html:m.body_html||'',body_state:'ready',attachments:[]};}
   else if(parts[2]==='mail-candidates')result={candidates:[],matching_case_count:1};
   else if(parts[2]==='sent-estimates')result={messages:[],unknown:[]};
   else if(parts[2]==='commercial')result={estimates:[],offers:[],billings:[]};else if(parts[2]==='materials')result={cards:[],photos:[]};return json({ok:true,result});
  }
  const file=path.resolve(root,'.'+(u.pathname==='/'?'/pa-admin.html':u.pathname));if(!file.startsWith(root+path.sep)||!fs.existsSync(file)){res.writeHead(404);return res.end();}
  res.writeHead(200,{'content-type':file.endsWith('.mjs')||file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.json')?'application/json':'text/html; charset=utf-8'});res.end(fs.readFileSync(file));
 }catch(e){console.error(e);res.writeHead(500);res.end(String(e));}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 const browser=await chromium.launch({headless:true,...(process.env.PA_CHROME_EXECUTABLE?{executablePath:process.env.PA_CHROME_EXECUTABLE}:{})});
 const sendCount=()=>posts.filter(p=>p.action==='send_reply').length;
 async function pageAt(viewport,readonly=false){const page=await browser.newPage({viewport});page.errors=[];page.on('pageerror',e=>page.errors.push(e.message));await page.route('**/*',r=>new URL(r.request().url()).hostname==='127.0.0.1'?r.continue():r.abort());await page.goto(base+'/?case='+A+'&tab=conversation'+(readonly?'&mail-view=readonly':''));await page.locator('[data-mail-sync-state="'+(readonly?'readonly':'success')+'"]').waitFor();return page;}
 async function draft(page,body){await page.locator('[data-reply-message="source"]').click();await page.waitForFunction(()=>document.querySelector('[data-reply-to]').value==='customer@example.invalid');await page.locator('[data-reply-body]').fill(body);}
 async function approve(page){await page.locator('[data-reply-preview]').click();await page.locator('[data-reply-preview-box]').waitFor({state:'visible'});await page.locator('[data-reply-confirm]').check();}
 async function waitForRelease(kind){for(let i=0;i<200;i++){if(kind==='send'?releaseSend:releaseSync)return;await new Promise(r=>setTimeout(r,10));}throw Error('Fixture did not reach held '+kind);}
 try{
  for(const viewport of [{width:1440,height:1000},{width:390,height:844}]){
   const page=await pageAt(viewport);await draft(page,'Unsent draft '+viewport.width);await page.locator('[data-reply-close]').click();await page.locator('[data-reply-message="source"]').click();assert.equal(await page.locator('[data-reply-body]').inputValue(),'Unsent draft '+viewport.width);
   await page.locator('[data-reply-files]').setInputFiles({name:'fixture.txt',mimeType:'text/plain',buffer:Buffer.from('abc')});await page.waitForFunction(()=>document.querySelector('[data-reply-files-list]').textContent.includes('fixture.txt'));await approve(page);
   duplicateRead=true;const before=sendCount();await page.locator('[data-reply-send]').dblclick();await page.locator('.reply-composer').waitFor({state:'hidden'});assert.equal(sendCount(),before+1);assert.equal(await page.locator('[data-reply-notice-text]').innerText(),'送信しました');assert.equal(await page.locator('[data-message="'+latestSent+'"]').count(),1);
   assert.equal(await page.locator('.mail-list article').first().getAttribute('data-message'),latestSent);assert.equal(await page.locator('[data-reply-body]').inputValue(),'');assert.equal(await page.locator('[data-reply-files-list]').innerText(),'');assert.equal(await page.locator('[data-reply-frame]').getAttribute('srcdoc'),null);
   await page.waitForLoadState('networkidle');await page.waitForFunction(id=>{const row=document.querySelector('[data-message="'+id+'"]')?.getBoundingClientRect(),notice=document.querySelector('[data-reply-notice]')?.getBoundingClientRect();return row&&notice&&row.top>=0&&row.top<innerHeight&&notice.top>=0&&notice.bottom<=innerHeight;},latestSent);
   assert((await page.locator('[data-message="'+latestSent+'"]').innerText()).includes('Unsent draft '+viewport.width),'sent body rendered through regular read projection');
   if(process.env.PAUI091_EVIDENCE_DIR){fs.mkdirSync(process.env.PAUI091_EVIDENCE_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.PAUI091_EVIDENCE_DIR,'MOCK_SEND_'+viewport.width+'.png')});}
   await page.locator('[data-reply-message="source"]').click();assert.equal(await page.locator('[data-reply-body]').inputValue(),'');assert.equal(await page.locator('[data-reply-preview-box]').isHidden(),true);await page.locator('[data-reply-close]').click();duplicateRead=false;
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),viewport.width);assert.deepEqual(page.errors,[]);checks.push({viewport,normal_auto_close:true,immediate_sorted_unique_sent:true,submitted_draft_cleared:true,unsent_draft_retained:true});await page.close();
  }
  {
   const page=await pageAt({width:390,height:844});await draft(page,'Known receipt survives reload');await approve(page);const before=sendCount();failRead=true;await page.locator('[data-reply-send]').click();await page.getByText('送信済み・履歴更新未確認',{exact:true}).waitFor();await page.reload();await page.waitForLoadState('networkidle');await page.getByText('送信済み・履歴更新未確認',{exact:true}).waitFor();failRead=false;await page.locator('[data-reply-recheck]').click();await page.getByText('送信しました',{exact:true}).waitFor();assert.equal(sendCount(),before+1);assert.equal(await page.locator('[data-message="'+latestSent+'"]').count(),1);await page.locator('[data-reply-message="source"]').click();assert.equal(await page.locator('[data-reply-body]').inputValue(),'');assert.deepEqual(page.errors,[]);checks.push({known_sent_reload_recovers_by_reads_only:true});await page.close();
  }
  {
   const page=await pageAt({width:1440,height:1000});await draft(page,'Auth lost while waiting for response');await approve(page);const before=sendCount();holdSend=true;releaseSend=null;await page.locator('[data-reply-send]').click();await waitForRelease('send');await page.evaluate(()=>window.revokeSendFixture());holdSend=false;releaseSend();await page.getByText('送信済み・履歴更新未確認',{exact:true}).waitFor();assert.equal(await page.locator('.reply-composer').isVisible(),true);assert.equal(sendCount(),before+1);assert.equal(await page.locator('[data-reply-preview]').isDisabled(),true);assert.deepEqual(page.errors,[]);checks.push({auth_lost_after_known_send_stays_unverified:true,no_resend:true});await page.close();
  }
  // Reproduce Owner's old close/tab-switch workaround, now on a forced read failure.
  {
   const page=await pageAt({width:1440,height:1000});await draft(page,'Known sent read unavailable');await approve(page);failRead=true;const before=sendCount();await page.locator('[data-reply-send]').click();await page.getByText('送信済み・履歴更新未確認',{exact:true}).waitFor();assert.equal(await page.locator('.reply-composer').isVisible(),true);await page.locator('[data-reply-close]').click();await page.locator('[data-tab="estimate"]').click();await page.locator('[data-tab="conversation"]').click();assert.equal(sendCount(),before+1);failRead=false;await page.locator('[data-reply-recheck]').click();await page.getByText('送信しました',{exact:true}).waitFor();assert.equal(await page.locator('[data-message="'+latestSent+'"]').count(),1);assert.equal(sendCount(),before+1);await page.locator('[data-reply-message="source"]').click();assert.equal(await page.locator('[data-reply-body]').inputValue(),'');assert.deepEqual(page.errors,[]);checks.push({readback_failure:'sent-unverified',safe_read_retry:true,old_close_tab_workaround_regression:true});await page.close();
  }
  {
   const page=await pageAt({width:1440,height:1000});holdSync=true;releaseSync=null;await page.locator('[data-action="mail-sync"]').click();await waitForRelease('sync');await draft(page,'Send during old auto sync');await approve(page);await page.locator('[data-reply-send]').click();await page.getByText('送信済みです。履歴を確認中…',{exact:true}).first().waitFor();assert.equal(await page.locator('.reply-composer').isVisible(),true);holdSync=false;releaseSync();await page.getByText('送信しました',{exact:true}).waitFor();assert.equal(await page.locator('[data-message="'+latestSent+'"]').count(),1);assert.deepEqual(page.errors,[]);checks.push({old_auto_sync_flight_waited:true,no_stale_overwrite:true});await page.close();
  }
  {
   const page=await pageAt({width:390,height:844});
   await draft(page,'Send while switching cases');await approve(page);
   holdSend=true;releaseSend=null;
   await page.locator('[data-reply-send]').click();await waitForRelease('send');
   await page.locator('[data-case="'+B+'"]').press('Enter');
   await page.locator('[data-case="'+B+'"][aria-pressed="true"]').waitFor();
   await page.locator('[data-tab="conversation"]').click();
   await page.getByText('受付確認メール・送信済み', {exact:false}).first().waitFor();
   await page.getByText('お問い合わせ受付',{exact:true}).waitFor();
   const followUp = page.locator('[data-timeline-kind="form"]').getByRole('link', {name:'お客様に返信 ↗'});
   assert.equal(await followUp.getAttribute('href'),'/pa-admin-legacy.html?case='+B+'&compose=follow-up');
   assert.equal(await followUp.getAttribute('target'),'_blank');
   assert.equal(await page.locator('[data-timeline-kind="delivery"] .intake-reply').count(),0);
   await page.getByText('内部通知・送信済み',{exact:false}).first().waitFor();
   await page.getByText('業務案内・配送・配送結果未確定',{exact:false}).first().waitFor();
   await page.getByText('業務案内・配送・送信失敗',{exact:false}).first().waitFor();
   await page.locator('[data-customer-mail-empty]').waitFor();
   assert.equal(await page.locator('[data-reply-message]').count(),0);
   await page.getByRole('button',{name:'取込せず原本を確認'}).click();
   await page.getByText('Gmail取得失敗 / 最新は未確認',{exact:true}).waitFor();
   assert.equal(await page.getByText('お問い合わせ受付',{exact:true}).isVisible(),true);
   await page.locator('[data-timeline-kind="delivery"] .mail-heading').filter({hasText:'受付確認メール・送信済み'}).waitFor();
   holdSend=false;releaseSend();
   assert.equal(await page.locator('[data-message="'+latestSent+'"]').count(),0);
   assert.equal(await page.locator('[data-reply-notice]').isHidden(),true);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),390);
   await page.locator('[data-case="'+A+'"]').click();
   await page.locator('[data-tab="conversation"]').click();
   assert.equal(await page.locator('.intake-reply').count(),0);
   await page.locator('[data-message="'+latestSent+'"]').waitFor();
   await page.locator('[data-reply-message="source"]').click();
   assert.equal(await page.locator('[data-reply-body]').inputValue(),'');
   assert.deepEqual(page.errors,[]);
   checks.push({case_switch_late_send_isolated:true,mobile:true,form_delivery_timeline:true,gmail_read_failure_preserves_timeline:true});
   await page.close();
  }
  {
   const page=await pageAt({width:390,height:844});await draft(page,'Lost send response');await approve(page);loseReply=true;const before=sendCount();await page.locator('[data-reply-send]').click();await page.waitForFunction(()=>document.querySelector('[data-reply-status]').textContent.includes('UNKNOWN'));assert.equal(await page.locator('.reply-composer').isVisible(),true);assert.equal(await page.locator('[data-reply-notice]').isHidden(),true);await page.locator('[data-reply-history]').click();assert.equal(sendCount(),before+1);loseReply=false;await page.reload();await page.locator('[data-mail-sync-state="success"]').waitFor();await draft(page,'Do not resend after reload');assert.equal(await page.locator('[data-reply-preview]').isDisabled(),true);assert.equal(sendCount(),before+1);assert.deepEqual(page.errors,[]);checks.push({unknown_stays_open:true,unknown_reload_no_resend:true});await page.close();
  }
  {
   const page=await pageAt({width:1440,height:1000});await draft(page,'Reload while send response is held');await approve(page);holdSend=true;releaseSend=null;const before=sendCount();await page.locator('[data-reply-send]').click();await waitForRelease('send');await page.reload();holdSend=false;releaseSend();await page.locator('[data-mail-sync-state="success"]').waitFor();await draft(page,'Never replay after interrupted send');assert.equal(await page.locator('[data-reply-preview]').isDisabled(),true);assert.equal(sendCount(),before+1);assert.deepEqual(page.errors,[]);checks.push({send_in_flight_reload_lock_survives:true,no_automatic_resend:true});await page.close();
  }
  {
   const before=posts.length,page=await pageAt({width:390,height:844},true);assert.equal(posts.length,before);await page.locator('[data-reply-message="source"]').click();assert.equal(posts.length,before);assert.equal(await page.locator('.reply-composer').isHidden(),true);checks.push({passive_production_verification_mode_no_posts:true});await page.close();
  }
  assert.deepEqual((await f.db.query('select to_jsonb(i) row from pa_inquiries i order by id')).rows,protectedBefore);assert.deepEqual((await f.db.query('select to_jsonb(l) row from pa_gmail_thread_links l order by id')).rows,linksBefore);
  assert.equal((await f.db.query('select count(*)::int n from pa_gmail_message_index where inquiry_id=$1',[B])).rows[0].n,0);
  assert(provider.filter(c=>c.host==='gmail.googleapis.com'&&c.method!=='GET').every(c=>c.path.endsWith('/messages/send')));
  assert(posts.filter(p=>p.action==='sync').every(p=>p.linked_only===true));
  console.log(JSON.stringify({scope:'PAUI091_REAL_DESK_REAL_REPLY_API_PGLITE_FAKE_GMAIL',checks,fake_provider_send_count:f.state.sendCount,real_gmail_sends:0,other_case_changes:0,commercial_changes:0}));
 }finally{await browser.close();server.close();await f.db.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
