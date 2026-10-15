'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {PGlite}=require('@electric-sql/pglite');
const service=require('../api/_pa-portal-candidates.cjs');
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222',ACTOR='33333333-3333-4333-8333-333333333333';
const att=(id,part=id)=>({id,part_id:part,filename:id+'.pdf',mime_type:'application/pdf',size:10000});
const row=id=>({inquiry_id:A,gmail_message_id:id,gmail_thread_id:'thread',direction:'inbound',attachment_metadata:[att(id)]});
(async()=>{
 const {createPortalCandidateBridge}=await import('../pa-ui/js/case-workflows.mjs');
 let fail=true,current=A;const calls=[],statuses=[];
 const bridge=createPortalCandidateBridge({request:async(action,p)=>{assert.equal(action,'candidate_backfill');assert.equal(p.preserve_existing,true);assert.equal(p.gmail_thread_id,'thread');calls.push(p.gmail_message_id);if(p.gmail_message_id==='first'&&fail)throw Error('fixture_failure');return {result:{detected:0,pending:2}};},isCurrent:id=>current===id,onStatus:(id,text)=>statuses.push(text)});
 const rows=[row('first'),row('second')];await bridge.newlyIndexed(A,new Set(),rows);assert.deepEqual(calls,['first','second']);assert.match(statuses.at(-1),/一部未確認.*first.*取得・連携失敗/);assert.doesNotMatch(statuses.at(-1),/連携済み/);
 await bridge.newlyIndexed(A,new Set(['first','second']),rows);assert.deepEqual(calls,['first','second','first']);assert.match(statuses.at(-1),/自動回復上限/);
 fail=false;await bridge.newlyIndexed(A,new Set(['first','second']),rows);assert.equal(calls.length,3,'automatic cap must survive repeated sync');await bridge.link(A,'first');assert.equal(bridge.records(A).find(s=>s.messageId==='first').state,'success');
 await bridge.newlyIndexed(A,new Set(['old']),[row('old')]);assert(!calls.includes('old'));await bridge.recheck(A,[row('old')]);assert(calls.includes('old'));
 const before=calls.length;await bridge.newlyIndexed(A,new Set(),rows);assert.equal(calls.length,before,'duplicate sync is skipped after success');await bridge.recheck(A,[{...row('cross'),inquiry_id:B}]);assert.equal(calls.length,before);
 let releases=[],delayedCalls=0;const delayed=createPortalCandidateBridge({request:async()=>{delayedCalls++;return new Promise(resolve=>releases.push(resolve));},isCurrent:id=>current===id,onStatus:()=>{}});
 const p=delayed.link(A,'race'),q=delayed.link(A,'race');assert.equal(delayedCalls,1);delayed.cancel();current=B;releases[0]({result:{detected:1,pending:1}});await Promise.all([p,q]);assert.equal(delayed.records(A)[0].state,'failed','stale completion cannot become success');current=A;
 const authCalls=[];const auth=createPortalCandidateBridge({request:async(a,p)=>{authCalls.push(p.gmail_message_id);throw Object.assign(Error('not_authorized'),{status:401});},isCurrent:()=>true,onStatus:()=>{}});await auth.newlyIndexed(A,new Set(),rows);assert.deepEqual(authCalls,['first']);await auth.recheck(A,rows);assert.equal(authCalls.length,1,'no writes after authentication loss');auth.clear();
 const boundedCalls=[];const bounded=createPortalCandidateBridge({request:async(a,p)=>{boundedCalls.push(p.gmail_message_id);return {result:{detected:0,pending:0}};},isCurrent:()=>true,onStatus:()=>{}});const many=Array.from({length:23},(_,i)=>row('mail'+i));await bounded.newlyIndexed(A,new Set(),many);assert.equal(boundedCalls.length,20);await bounded.newlyIndexed(A,new Set(many.map(r=>r.gmail_message_id)),many);assert.equal(boundedCalls.length,23,'queued overflow remains recoverable');
 process.env.SUPABASE_URL='https://fixture.invalid';process.env.SUPABASE_SERVICE_ROLE_KEY='fixture-only';const network=[];let wrong=false;
 const fetchMock=async(url,options={})=>{const u=new URL(url);network.push(u.pathname);let data;
  if(u.pathname.endsWith('/pa_gmail_thread_links'))data=[{gmail_thread_id:'thread'}];
  else if(u.pathname.endsWith('/pa_gmail_message_index'))data=[{...row('first'),gmail_thread_id:wrong?'wrong':'thread'}];
  else if(u.pathname.endsWith('/pa_portals'))data=[];
  else if(u.pathname.endsWith('/pa_portal_candidate_ensure')){const p=JSON.parse(options.body);assert.deepEqual([p.p_case_id,p.p_actor_id,p.p_message_id,p.p_thread_id],[A,ACTOR,'first','thread']);data={detected:1,pending:1};}
  else throw Error('unexpected mutation '+u.pathname);return {ok:true,json:async()=>data};};
 await service.backfillCandidates({caseId:A,actorId:ACTOR,messageId:'first',threadId:'thread',preserveExisting:true},fetchMock);assert(!network.some(x=>/reconcile|candidate_detect/u.test(x)));
 wrong=true;const n=network.length;await assert.rejects(service.backfillCandidates({caseId:A,actorId:ACTOR,messageId:'first',preserveExisting:true},fetchMock),/binding_mismatch/);assert(!network.slice(n).some(x=>x.includes('/rpc/')));
 await assert.rejects(service.backfillCandidates({caseId:A,actorId:ACTOR,preserveExisting:true},fetchMock),/invalid_candidate_binding/);
 wrong=false;
 for(const [code,message,expected]of [['P0001','candidate_legacy_identity_unresolved','candidate_legacy_identity_unresolved'],['P0001','untrusted sensitive detail','supabase_400']]){
  const errorFetch=async(url,options)=>url.includes('/rpc/pa_portal_candidate_ensure')?{ok:false,status:400,json:async()=>({code,message})}:fetchMock(url,options);
  await assert.rejects(service.backfillCandidates({caseId:A,actorId:ACTOR,messageId:'first',preserveExisting:true},errorFetch),error=>error.message===expected);
 }
 const db=new PGlite();try{
  await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;create table auth.users(id uuid primary key);
   create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
   create table public.work_admins(user_id uuid primary key references auth.users(id));create function public.is_work_admin() returns boolean language sql stable security definer set search_path='' as $$select exists(select 1 from public.work_admins where user_id=auth.uid())$$;
   create table public.pa_inquiries(id uuid primary key,deleted_at timestamptz,event_name text,event_date date,venue text);
   create table public.pa_gmail_thread_links(id uuid primary key default gen_random_uuid(),inquiry_id uuid not null references public.pa_inquiries(id),gmail_thread_id text not null unique);
   create table public.pa_gmail_message_index(gmail_message_id text primary key,gmail_thread_id text not null,inquiry_id uuid not null references public.pa_inquiries(id),message_source text,direction text not null,from_address text not null,to_addresses jsonb not null default '[]',cc_addresses jsonb not null default '[]',subject text not null default '',sent_at timestamptz,received_at timestamptz,indexed_at timestamptz not null default now(),attachment_metadata jsonb not null default '[]');
   insert into auth.users values('${ACTOR}');insert into public.work_admins values('${ACTOR}');insert into public.pa_inquiries values('${A}',null,'Fixture','2026-10-18','Fixture'),('${B}',null,'Other','2026-10-19','Other');select set_config('request.jwt.claim.sub','${ACTOR}',false);`);
  for(const name of ['20260908143000_pa_portal_document_management.sql','20260909060000_pa_portal_document_candidates.sql','20260909093000_pa_portal_candidate_canonical_identity.sql','20260909110000_pa_portal_candidate_variant_reconcile.sql'])await db.exec(fs.readFileSync(path.join(__dirname,'../supabase/migrations',name),'utf8'));
  await db.exec(fs.readFileSync(path.join(__dirname,'../ops/PAUI-045-candidate-ensure.sql'),'utf8'));
  await db.query("insert into public.pa_gmail_thread_links(inquiry_id,gmail_thread_id) values($1,'thread'),($2,'other')",[A,B]);
  const attachments=['one','two','three','four'].map(id=>att(id));await db.query("insert into public.pa_gmail_message_index(gmail_message_id,gmail_thread_id,inquiry_id,direction,from_address,attachment_metadata) values('mail','thread',$1,'inbound','fixture@example.test',$2::jsonb)",[A,JSON.stringify(attachments)]);
  const proposals=service.buildProposals([{...row('mail'),attachment_metadata:attachments}]).proposals;
  const ensure=async(items=proposals,caseId=A,message='mail',thread='thread',actor=ACTOR)=>(await db.query('select public.pa_portal_candidate_ensure($1,$2,$3,$4,$5::jsonb) result',[caseId,actor,message,thread,JSON.stringify(items)])).rows[0].result;
  assert.equal((await ensure()).detected,4);const ids=(await db.query('select id from public.pa_portal_document_candidates order by gmail_attachment_id')).rows;
  for(let i=0;i<4;i++)await db.query('update public.pa_portal_document_candidates set status=$1,suggested_title=$2 where id=$3',[['pending','accepted','ignored','dismissed'][i],'Owner decision '+i,ids[i].id]);
  await db.exec("insert into public.pa_portal_document_versions(card_id,source_type,source_key,source_ref,display_filename,mime_type,contributor_kind,version_label) select id,'portal_upload','fixture_version','{}','fixture.pdf','application/pdf','organizer','Owner current' from public.pa_portal_document_cards where category='script' limit 1;update public.pa_portal_document_cards c set current_version_id=v.id from public.pa_portal_document_versions v where v.card_id=c.id;insert into public.pa_portal_photo_items(portal_id,source_type,source_key,source_ref,display_filename,mime_type,contributor_kind) select id,'portal_upload','fixture_photo','{}','fixture.jpg','image/jpeg','organizer' from public.pa_portals limit 1;");
  const snapshot=async()=>JSON.stringify((await db.query('select to_jsonb(c) data from public.pa_portal_document_candidates c order by id')).rows);
  const existing=await snapshot(),audit=(await db.query('select count(*)::int n from public.pa_portal_candidate_audit')).rows[0].n;
  const versions=JSON.stringify((await db.query('select to_jsonb(c) data from public.pa_portal_document_cards c order by id')).rows);
  const protectedAssets=JSON.stringify((await db.query('select to_jsonb(v) data from public.pa_portal_document_versions v union all select to_jsonb(p) data from public.pa_portal_photo_items p')).rows);
  const concurrent=await Promise.all([ensure(proposals.map(p=>({...p,suggested_title:'Must not overwrite',suggested_category:'layout'}))),ensure()]);assert(concurrent.every(x=>x.detected===0));assert.equal(await snapshot(),existing,'all statuses, suggestions, identities and timestamps must be byte-equivalent');
  assert.equal((await db.query('select count(*)::int n from public.pa_portal_candidate_audit')).rows[0].n,audit);assert.equal(JSON.stringify((await db.query('select to_jsonb(c) data from public.pa_portal_document_cards c order by id')).rows),versions);
  assert.equal(JSON.stringify((await db.query('select to_jsonb(v) data from public.pa_portal_document_versions v union all select to_jsonb(p) data from public.pa_portal_photo_items p')).rows),protectedAssets,'current versions and photos are unchanged');
  for(const args of [[proposals,B],[proposals,A,'mail','other'],[proposals,A,'other','thread'],[proposals,A,'mail','thread',B],[[{...proposals[0],gmail_part_id:'wrong'}]],[[{...proposals[0],gmail_attachment_id:'unknown'}]]])await assert.rejects(ensure(...args));
  await db.query("update public.pa_gmail_message_index set attachment_metadata=$1::jsonb where gmail_message_id='mail'",[JSON.stringify(attachments.map(a=>({...a,id:a.id+'_variant'})))]);
  assert.equal((await ensure(proposals.map(p=>({...p,gmail_attachment_id:p.gmail_attachment_id+'_variant'})))).detected,0,'opaque variants retain canonical identity');assert.equal(await snapshot(),existing);
  await db.exec("update public.pa_portal_document_candidates set canonical_attachment_key=null,gmail_part_id=null,source_provider=null where gmail_attachment_id='one'");
  await assert.rejects(ensure(proposals.map(p=>({...p,gmail_attachment_id:p.gmail_attachment_id+'_variant'}))),/candidate_legacy_identity_unresolved/,'unknown legacy variants fail closed without guessed duplicates');
  assert.equal((await db.query("select has_function_privilege('authenticated','public.pa_portal_candidate_ensure(uuid,uuid,text,text,jsonb)','execute') allowed")).rows[0].allowed,false);
 }finally{await db.close();}
 console.log(JSON.stringify({status:'PASS',baseline_first_failure_previously_stopped_second:true,independent_continue:true,one_later_automatic_recovery:true,manual_existing_index:true,cap_and_queue:true,authentication_and_stale_guards:true,insert_only_rpc:true,all_candidate_statuses_unchanged:true,canonical_variant_dedup:true,unknown_legacy_refused:true,real_provider_sends:0}));
})().catch(e=>{console.error(e);process.exitCode=1;});
