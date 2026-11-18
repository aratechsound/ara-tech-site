// Full new desk + real syncCase + local PGlite schema. Provider/Auth are fakes.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium}=require('playwright'),{createFixture}=require('../helpers/ara-case-fixture.cjs');
const root=path.resolve(__dirname,'../..'),A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
(async()=>{const f=await createFixture();await f.db.exec(fs.readFileSync(path.join(root,'supabase/migrations/20261106090000_paui088_linked_mail_sync.sql'),'utf8'));
 const {values,pdf}=await import('../paui027-fixture.mjs');
 const {syncCase,replyContext,normalizeMessage}=require('../../api/_pa-gmail.cjs');
 await f.db.query("insert into pa_inquiries(id,inquiry_number,customer_name,email,case_type,status) values($1,'PA-AUTO-A','Fixture A','customer@example.invalid','PA_EVENT','new_inquiry'),($2,'PA-AUTO-B','Fixture B','other@example.invalid','AV_INSTALL','new_inquiry')",[A,B]);
 await f.db.query("insert into pa_gmail_thread_links(inquiry_id,gmail_thread_id,link_source,conversation_role) values($1,'thread_1','manual','primary_conversation'),($1,'thread_2','manual','secondary_conversation')",[A]);
 await f.db.query("insert into pa_case_mail_attention(inquiry_id,attention_state) values($1,'waiting_customer')",[A]);
 const old=f.raw('old_sent','thread_1','aratechsound@gmail.com','previous outbound'),older=f.raw('older_received','thread_2'),first=f.raw('new_received_1','thread_1','customer@example.invalid','First new reply body.');
 old.labelIds=['SENT'];old.payload.headers.find(h=>h.name==='To').value='customer@example.invalid';older.internalDate=String(Number(old.internalDate)-10000);first.internalDate=String(Number(old.internalDate)+10000);first.labelIds=['UNREAD','INBOX'];
 let fail=false,paused=false,releaseSync,startSync;const started=new Promise(r=>{startSync=r;}),posts=[],providerCalls=[];
 let heldLive,heldIndex,providerOnlyMail;
 const readsWhileRestoring=[];
 f.state.threadMessages.set('thread_1',[old]);f.state.threadMessages.set('thread_2',[older]);for(const m of [old,older,first])f.state.messages.set(m.id,m);
 const transport=async(url,opts={})=>{providerCalls.push({url,method:opts.method||'GET'});if(fail&&url.includes('/threads/thread_1?'))throw Error('fixture_provider_failure');if(url.includes('/rpc/paui041_record_linked_sync')){const x=JSON.parse(opts.body);await f.db.query('select paui041_record_linked_sync($1,$2,$3,$4)',[x.p_case,x.p_actor,JSON.stringify(x.p_threads),JSON.stringify(x.p_messages)]);return {ok:true,json:async()=>null};}return f.fetchImpl(url,opts);};
 await syncCase({inquiryId:A,actorId:f.actor,linkedOnly:true},transport);assert.equal((await f.db.query('select attention_state from pa_case_mail_attention where inquiry_id=$1',[A])).rows[0].attention_state,'waiting_customer');
 const protectedBefore=await f.db.query('select to_jsonb(i) row from pa_inquiries i order by id');const linkedBefore=await f.db.query('select to_jsonb(t) row from pa_gmail_thread_links t order by id');
 f.state.threadMessages.set('thread_1',[old,first]);paused=true;
 const integration=`let active=true;export const workspaceAuth={async restore(){if(!active)throw Error('admin_required');return {user:{id:'fixture-owner'},access_token:'fixture-only',expires_at:9999999999};},async current(){return this.restore();},subscribe(){},async logout(){active=false;}};window.revokeAutoFixture=()=>{active=false;};export const readUrl=p=>'/fixture-read?path='+encodeURIComponent(p);export const legacyUrl=id=>'/forbidden-legacy';`;
 const metadata=async id=>{const rows=(await f.db.query('select state from paui041_mail_sync_state where inquiry_id=$1',[id])).rows,s=rows[0]?.state?.linked_sync;return {inquiry_id:id,scope:'existing_linked_threads',complete:Boolean(s?.complete),last_success_at:s?.checked_at||null,thread_ids:s?.thread_ids||[],message_count:s?.message_count||0};};
 const server=http.createServer(async(req,res)=>{try{const u=new URL(req.url,'http://localhost'),json=(value,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};
  if(u.pathname==='/pa-ui/js/integration.mjs'){res.writeHead(200,{'content-type':'text/javascript'});return res.end(integration);}
  if(u.pathname==='/api/pa-gmail'){let raw='';for await(const c of req)raw+=c;const p=JSON.parse(raw);assert.equal(req.headers.authorization,'Bearer fixture-only');posts.push(p);assert.equal(p.inquiry_id,A,'only selected linked fixture may write');
   if(p.action==='sync'){assert.equal(p.linked_only,true);startSync();if(paused)await new Promise(r=>{releaseSync=r;});try{return json({ok:true,result:await syncCase({inquiryId:p.inquiry_id,actorId:f.actor,linkedOnly:p.linked_only},transport)});}catch{return json({ok:false,code:'service_unavailable'},503);}}
   if(p.action==='reply_context')return json({ok:true,context:await replyContext({inquiryId:p.inquiry_id,replySourceMessageId:p.reply_source_message_id,replySourceThreadId:p.reply_source_thread_id},transport)});
   throw Error('FORBIDDEN_ACTION '+p.action);
  }
  if(u.pathname==='/fixture-read'){const route=u.searchParams.get('path'),parts=route.split('/');let result=[];
   if(route==='/data/cases')result={cases:(await f.db.query('select * from pa_inquiries order by id')).rows,progress:[]};
   else if(route==='/data/attention')result=(await f.db.query('select * from pa_case_mail_attention')).rows;
   else if(parts[2]==='case'){const id=parts[3];if(parts[4]==='links')result=(await f.db.query('select * from pa_gmail_thread_links where inquiry_id=$1',[id])).rows;else if(parts[4]==='attention')result=(await f.db.query('select * from pa_case_mail_attention where inquiry_id=$1',[id])).rows;else if(parts[4]==='mail-sync')result=await metadata(id);}
   else if(parts[2]==='mail'){
    result=(await f.db.query('select * from pa_gmail_message_index where inquiry_id=$1 order by greatest(received_at,sent_at) desc',[parts[3]])).rows;
    const hold=heldIndex;
    if(hold){
     heldIndex=null;
     await new Promise(resolve=>hold(resolve));
     readsWhileRestoring.push('index_response');
    }
   }
   else if(parts[2]==='mail-live'){
    const hold=heldLive;
    heldLive=null;
    const messages=(await f.db.query('select * from pa_gmail_message_index where inquiry_id=$1',[parts[3]])).rows;
    if(providerOnlyMail){
     readsWhileRestoring.push('live_read');
     messages.push(providerOnlyMail);
    }
    if(hold)await new Promise(resolve=>hold.started(resolve));
    if(hold?.fail)return json({ok:false,code:'fixture_live_read_failed'},503);
    result={messages,status:'linked_threads_current'};
   }
   else if(parts[2]==='mail-body'){const raw=f.state.messages.get(parts[4]),m=normalizeMessage(raw);result={gmail_message_id:m.id,inquiry_id:parts[3],body_text:m.body_text,body_state:'ready'};}
   else if(route==='/data/sent-estimates/'+A)result=values[route];
   else if(route==='/data/sent-estimate-attachment/'+A+'/quote/quote1'){
    res.writeHead(200,{'content-type':'application/pdf'});return res.end(pdf());
   }
   else if(parts[2]==='mail-candidates')result={candidates:[],matching_case_count:1};else if(parts[2]==='commercial')result={estimates:[],documents:[],offers:[],billings:[]};else if(parts[2]==='materials')result={cards:[],photos:[]};return json({ok:true,result});
  }
  const file=path.resolve(root,'.'+(u.pathname==='/'?'/pa-admin.html':u.pathname));if(!file.startsWith(root+path.sep)||!fs.existsSync(file)){res.writeHead(404);return res.end();}res.writeHead(200,{'content-type':file.endsWith('.mjs')||file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.json')?'application/json':'text/html; charset=utf-8'});res.end(fs.readFileSync(file));
 }catch(e){console.error(e);res.writeHead(500);res.end(String(e));}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({headless:true,...(process.env.PA_CHROME_EXECUTABLE?{executablePath:process.env.PA_CHROME_EXECUTABLE}:{})});
 try{const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.route('**/*',r=>new URL(r.request().url()).hostname==='127.0.0.1'?r.continue():r.abort());
  await page.goto('http://127.0.0.1:'+server.address().port+'/?case='+A);await page.locator('[data-case="'+A+'"].selected').waitFor();assert.equal(posts.length,0,'overview performs no sync');
  await page.locator('[data-tab="conversation"]').click();await started;assert.equal(posts.filter(p=>p.action==='sync').length,1);assert.equal(await page.locator('[data-action="mail-sync"]').isDisabled(),true);
  await page.locator('[data-tab="conversation"]').click();await page.locator('[data-case="'+B+'"]').click();await page.locator('[data-tab="conversation"]').click();await page.locator('[data-case="'+A+'"]').click();await page.locator('[data-tab="conversation"]').click();assert.equal(posts.filter(p=>p.action==='sync').length,1);paused=false;releaseSync();
  await page.locator('[data-mail-sync-state="success"]').waitFor();await page.locator('[data-message="new_received_1"]').waitFor();assert((await page.locator('[data-message="new_received_1"]').innerText()).includes('NEW'));await page.waitForFunction(()=>document.querySelector('[data-message="new_received_1"]').textContent.includes('First new reply body.'));
  await page.locator('[data-reply-message="new_received_1"]').click();await page.waitForFunction(()=>document.querySelector('[data-reply-to]').value==='customer@example.invalid');await page.locator('[data-reply-body]').fill('Unsent draft retained during refresh');
  const second=f.raw('new_received_2','thread_1','customer@example.invalid','Next arrival body.');second.internalDate=String(Number(first.internalDate)+10000);second.labelIds=['UNREAD','INBOX'];f.state.messages.set(second.id,second);f.state.threadMessages.set('thread_1',[old,first,second]);
  await page.locator('[data-tab="overview"]').click();await page.locator('[data-tab="conversation"]').click();await page.locator('[data-message="new_received_2"]').waitFor();await page.locator('[data-mail-sync-state="success"]').waitFor();assert.equal(await page.locator('[data-reply-body]').inputValue(),'Unsent draft retained during refresh');
  await page.locator('[data-reply-message="new_received_2"]').click();await page.waitForFunction(()=>document.querySelector('[data-reply-source]').textContent.includes('new_received_2'));await page.locator('[data-reply-body]').fill('');
  await page.reload();await page.locator('[data-mail-sync-state="success"]').waitFor();assert.equal(new URL(page.url()).searchParams.get('tab'),'conversation');assert.equal((await f.db.query('select count(*)::int n from pa_gmail_message_index')).rows[0].n,4);
  const priorSuccess=await page.locator('[data-mail-sync-success]').innerText();fail=true;await page.locator('[data-action="mail-sync"]').click();await page.locator('[data-mail-sync-state="error"]').waitFor();assert.equal(await page.locator('[data-message="new_received_2"]').count(),1);assert.equal(await page.locator('[data-mail-sync-success]').innerText(),priorSuccess);const failedPosts=posts.length;await page.waitForTimeout(150);assert.equal(posts.length,failedPosts,'no retry loop');
  fail=false;await page.locator('[data-action="mail-sync"]').click();await page.locator('[data-mail-sync-state="success"]').waitFor();
  for(const deferredFailure of [false,true]){
   const liveStarted=new Promise(started=>{heldLive={started,fail:deferredFailure};});
   await page.getByRole('button',{name:'取込せず原本を確認',exact:true}).click();
   const finishLive=await liveStarted;
   try{
    const messageId=deferredFailure?'during_failed_live_read':'during_slow_live_read';
    const arriving=f.raw(messageId,'thread_1','customer@example.invalid','Customer reply during an earlier live read');
    arriving.internalDate=String(Number(second.internalDate)+(deferredFailure?20000:10000));
    arriving.labelIds=['INBOX','UNREAD'];
    f.state.messages.set(arriving.id,arriving);
    f.state.threadMessages.get('thread_1').push(arriving);
    const beforeSync=posts.filter(p=>p.action==='sync').length;
    await page.locator('[data-action="mail-sync"]').click();
    await page.locator('[data-mail-sync-state="success"]').waitFor();
    const currentRow=page.locator('[data-message="'+messageId+'"]');
    await currentRow.waitFor();
    const response=page.waitForResponse(r=>new URL(r.url()).searchParams.get('path')==='/data/mail-live/'+A);
    finishLive();
    await response;
    await page.waitForLoadState('networkidle');
    assert.equal(await currentRow.count(),1,'late Gmail read cannot remove a newer indexed reply');
    assert.equal(await page.getByText('Gmail取得失敗 / 最新は未確認',{exact:true}).count(),0,'obsolete read errors must not overwrite current status');
    assert.equal(posts.filter(p=>p.action==='sync').length,beforeSync+1);
    console.log(JSON.stringify({lateOriginalRead:deferredFailure?'failure':'success',indexedReplyPreserved:true,unneededSyncPosts:0}));
   }finally{finishLive();}
  }
  const backgroundReply=f.raw('during_estimate_preview','thread_1','customer@example.invalid','Reply arrives while reading the estimate');
  backgroundReply.labelIds=['INBOX','UNREAD'];
  f.state.messages.set(backgroundReply.id,backgroundReply);
  f.state.threadMessages.get('thread_1').push(backgroundReply);
  const backgroundSyncStarted=new Promise(resolve=>{startSync=resolve;});
  const beforeEstimateSync=posts.filter(p=>p.action==='sync').length;
  paused=true;
  await page.locator('[data-action="mail-sync"]').click();
  await backgroundSyncStarted;
  try{
   await page.locator('[data-tab="estimate"]').click();
   await page.getByRole('button',{name:'見積書_Gmail.pdf の拡大プレビュー',exact:true}).click();
   const preview=page.locator('dialog[open].pa-material-preview-dialog');
   await preview.getByRole('button',{name:'次のページ',exact:true}).click();
   await preview.locator('canvas[aria-label="PDF 2ページ"]').waitFor();
   const readback=page.waitForResponse(r=>new URL(r.url()).searchParams.get('path')==='/data/case/'+A+'/attention');
   paused=false;
   releaseSync();
   await readback;
   await page.waitForLoadState('networkidle');
   assert(await preview.locator('canvas[aria-label="PDF 2ページ"]').isVisible(),'Background sync replaced the open estimate preview');
   assert(await preview.getByRole('link',{name:'原本をダウンロード',exact:true}).isVisible());
   assert.equal(posts.filter(p=>p.action==='sync').length,beforeEstimateSync+1);
   await preview.getByRole('button',{name:'閉じる',exact:true}).click();
   await page.locator('[data-tab="conversation"]').click();
   await page.locator('[data-message="during_estimate_preview"]').waitFor();
   await page.locator('[data-mail-sync-state="success"]').waitFor();
   assert.equal(await page.locator('[data-message="during_estimate_preview"]').count(),1);
   console.log('PASS completed case sync preserves open estimate preview and applies the new reply once');
  }finally{paused=false;releaseSync();}
  const readonly=await browser.newPage({viewport:{width:390,height:844}});
  await readonly.route('**/*',r=>new URL(r.request().url()).hostname==='127.0.0.1'?r.continue():r.abort());
  const indexedReadStarted=new Promise(started=>{heldIndex=started;});
  providerOnlyMail={inquiry_id:A,gmail_message_id:'live_only_after_restore',gmail_thread_id:'thread_1',
   direction:'inbound',received_at:new Date().toISOString(),subject:'Read-only Gmail original',body_text:'Fresh original',index_state:'not_indexed'};
  const preRestorePosts=posts.length;
  await readonly.goto('http://127.0.0.1:'+server.address().port+'/?case='+A+'&tab=conversation&mail-view=readonly');
  const finishIndex=await indexedReadStarted;
  try{
   const liveButton=readonly.getByRole('button',{name:'取込せず原本を確認',exact:true});
   await liveButton.click();
   assert.equal(await liveButton.isDisabled(),true);
   finishIndex();
   await readonly.locator('[data-message="live_only_after_restore"]').waitFor();
   await readonly.locator('[data-message="during_slow_live_read"]').waitFor();
   assert.deepEqual(readsWhileRestoring,['index_response','live_read']);
   assert.equal(posts.length,preRestorePosts,'readonly restoration and original read are GET only');
   console.log('PASS CASE DESK opens the Gmail original after its initial index read, with no write');
  }finally{finishIndex();await readonly.close();providerOnlyMail=null;}
  await page.setViewportSize({width:390,height:844});await page.reload();await page.locator('[data-mail-sync-state="success"]').waitFor();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),390);await page.locator('[data-reply-message="new_received_2"]').click();await page.waitForFunction(()=>document.querySelector('[data-reply-to]').value==='customer@example.invalid');
  const beforeRevoke=posts.length;await page.evaluate(()=>window.revokeAutoFixture());await page.locator('[data-action="mail-sync"]').click();await page.locator('#login-screen').waitFor({state:'visible'});assert.equal(posts.length,beforeRevoke);
  assert.deepEqual(errors,[]);assert.deepEqual((await f.db.query('select to_jsonb(i) row from pa_inquiries i order by id')).rows,protectedBefore.rows);assert.deepEqual((await f.db.query('select to_jsonb(t) row from pa_gmail_thread_links t order by id')).rows,linkedBefore.rows);assert.equal((await f.db.query('select count(*)::int n from pa_gmail_message_index where inquiry_id=$1',[B])).rows[0].n,0);assert.equal(f.state.sendCount,0);
  assert(providerCalls.filter(c=>c.url.includes('gmail.googleapis.com')).every(c=>c.method==='GET'&&!c.url.includes('/messages?')));assert.equal((await f.db.query('select count(*)::int n from pa_gmail_message_index where gmail_message_id=$1',['new_received_2'])).rows[0].n,1);
  console.log(JSON.stringify({scope:'PAUI090_REAL_DESK_REAL_LOCAL_DB_FAKE_PROVIDER',desktop:'PASS',mobile:'PASS',first_and_next_arrival:'PASS',reload_no_duplicates:true,single_flight_navigation:true,failure_cache_and_success_date_preserved:true,auth_revoke_before_POST:true,other_case_updates:0,commercial_updates:0,real_gmail_mutations:0,posts:posts.map(p=>({action:p.action,case:p.inquiry_id,linked_only:p.linked_only}))}));
 }finally{await browser.close();server.close();await f.db.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
