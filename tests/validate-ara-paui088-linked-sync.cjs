'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {createFixture}=require('./helpers/ara-case-fixture.cjs');
const {syncUnlinkedMail}=require('../api/_ara-unlinked-mail.cjs');
const {syncCase}=require('../api/_pa-gmail.cjs');
const migration=fs.readFileSync(path.join(__dirname,'../supabase/migrations/20261106090000_paui088_linked_mail_sync.sql'),'utf8');
(async()=>{
 const f=await createFixture();
 await f.db.exec(migration);
 const C='11111111-1111-4111-8111-111111111111',D='22222222-2222-4222-8222-222222222222';
 await f.db.query("insert into pa_inquiries(id,inquiry_number,customer_name,email,case_type,status,first_form_data) values($1,'FIXTURE-088','Fixture','customer@example.invalid','AV_INSTALL','new_inquiry','{}'),($2,'FIXTURE-OTHER','Other','other@example.invalid','AV_INSTALL','new_inquiry','{}')",[C,D]);
 await f.db.query("insert into pa_gmail_thread_links(inquiry_id,gmail_thread_id,link_source,conversation_role) values($1,'thread_1','manual','primary_conversation'),($1,'thread_2','manual','secondary_conversation'),($2,'other_thread','manual','primary_conversation')",[C,D]);
 await f.db.query("insert into pa_case_mail_attention(inquiry_id,attention_state) values($1,'waiting_customer')",[C]);
 await f.db.query("insert into paui041_mail_sync_state(inquiry_id,state) values($1,$2)",[C,JSON.stringify({complete:true,window_end:'2026-10-19T00:00:00Z',last_completed_at:'2026-10-19T00:00:00Z'})]);
 const mail=f.raw('new_reply'),old=f.raw('old_reply','thread_2'),draft=f.raw('draft');draft.labelIds=['DRAFT'];
 old.internalDate=String(Number(mail.internalDate)-86400000);
 f.state.messages.set(mail.id,mail);f.state.pages=[[mail.id]];
 let fail=false,commits=0;const calls=[];
 const fetchImpl=async(url,opts={})=>{
  calls.push({url,method:opts.method||'GET'});
  if(url.includes('/threads/thread_1?')){if(fail)throw Error('fixture_provider_failure');return {ok:true,json:async()=>({messages:[mail,draft]})};}
  if(url.includes('/threads/thread_2?'))return {ok:true,json:async()=>({messages:[old]})};
  if(url.includes('/rpc/paui041_record_linked_sync')){
   const x=JSON.parse(opts.body);await f.db.query('select paui041_record_linked_sync($1,$2,$3,$4)',[x.p_case,x.p_actor,JSON.stringify(x.p_threads),JSON.stringify(x.p_messages)]);return {ok:true,json:async()=>null};
  }
  if(url.includes('/rpc/ara_commit_mail_page_v2'))commits++;
  return f.fetchImpl(url,opts);
 };
 const protectedBefore=await f.db.query('select to_jsonb(i) i from pa_inquiries i order by id');
 let checks=0;const pass=s=>{checks++;console.log('PASS '+s);};
 const result=await syncUnlinkedMail({actorId:f.actor},fetchImpl);
 assert.equal(result.has_more,false);assert.equal(commits,1);
 assert.deepEqual((await f.db.query('select gmail_message_id from pa_gmail_message_index order by gmail_message_id')).rows,[{gmail_message_id:'new_reply'},{gmail_message_id:'old_reply'}]);
 assert.equal((await f.db.query('select attention_state from pa_case_mail_attention where inquiry_id=$1',[C])).rows[0].attention_state,'new_customer_reply');pass('global page indexes linked reply through existing case sync before coverage; draft excluded');
 const state=(await f.db.query('select state from paui041_mail_sync_state where inquiry_id=$1',[C])).rows[0].state;
 assert.equal(state.last_completed_at,'2026-10-19T00:00:00Z');assert.equal(state.linked_sync.message_count,2);assert.equal(state.linked_sync.scope,'existing_linked_threads');pass('linked sync records fresh telemetry without forging discovery coverage');
 await syncCase({inquiryId:C,actorId:f.actor},fetchImpl);assert.equal((await f.db.query('select count(*)::int n from pa_gmail_message_index')).rows[0].n,2);pass('case replay is duplicate free and reconciles both threads');
 const version=(await f.db.query('select cursor_version from ara_mail_sync_state')).rows[0].cursor_version;
 fail=true;await assert.rejects(syncUnlinkedMail({actorId:f.actor},fetchImpl),/fixture_provider_failure/);fail=false;
 assert.equal((await f.db.query('select cursor_version from ara_mail_sync_state')).rows[0].cursor_version,version);pass('linked provider failure preserves global cursor for retry');
 await assert.rejects(f.db.query("select ara_commit_mail_page_v2($1,now()-interval '1 day',now(),$2,'',$3)",[f.actor,version,JSON.stringify([{gmail_message_id:mail.id,gmail_thread_id:'thread_1'}])]),/mail_link_conflict/);
 assert.equal((await f.db.query('select cursor_version from ara_mail_sync_state')).rows[0].cursor_version,version);pass('concurrent link at DB page commit rejects without advancing coverage');
 await f.db.query("update pa_gmail_message_index set inquiry_id=$1,gmail_thread_id='other_thread' where gmail_message_id=$2",[D,mail.id]);
 await assert.rejects(syncCase({inquiryId:C,actorId:f.actor},fetchImpl),/mail_link_conflict/);
 assert.equal((await f.db.query('select inquiry_id from pa_gmail_message_index where gmail_message_id=$1',[mail.id])).rows[0].inquiry_id,D);pass('foreign message attribution cannot be overwritten');
 await assert.rejects(f.db.query('select paui041_record_linked_sync($1,$2,$3,$4)',[C,D,'[]','[]']),/not_authorized/);
 await f.db.exec('set role authenticated');await assert.rejects(f.db.query('select paui041_record_linked_sync($1,$2,$3,$4)',[C,f.actor,'[]','[]']),/permission denied/);await f.db.exec('reset role');pass('nonadmin and browser role cannot call backend telemetry RPC');
 assert.deepEqual((await f.db.query('select to_jsonb(i) i from pa_inquiries i order by id')).rows,protectedBefore.rows);
 assert(calls.filter(c=>c.url.includes('gmail.googleapis.com')).every(c=>c.method==='GET'));assert.equal(f.state.sendCount,0);pass('business states and other case remain unchanged; Gmail reads only');
 const client=fs.readFileSync(path.join(__dirname,'../js/pa-admin.js'),'utf8');
 const dashboard=client.split('const showDashboard = async (user) => {')[1].split('const restoreSession')[0];
 assert(!dashboard.includes('refresh(true)'));assert(dashboard.includes('refresh(false)'));pass('opening legacy case loads saved inbox without starting global synchronization');
 console.log(`PAUI088_LOCAL_REGRESSION_PASS ${checks}/${checks}`);await f.db.close();
})().catch(e=>{console.error(e);process.exitCode=1;});
