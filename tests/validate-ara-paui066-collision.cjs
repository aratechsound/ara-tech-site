'use strict';
// PAUI-066: synthetic-only, no network, no production DB, no Gmail providers.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.join(__dirname,'..');
const C='11111111-1111-4111-8111-111111111111';
const D='22222222-2222-4222-8222-222222222222';
const official='aratechsound@gmail.com';
const now='2026-10-14T12:00:00Z';
const notificationSubject='New submission from ARA-TECH お問い合わせ';
let reads=0,writes=0;
let getLink=async()=>null;
const authority={cases:[{id:C,email:'alice@example.invalid',event_name:'2026秋祭り',inquiry_number:'PA-1',received_at:'2026-10-01',event_date:'2026-10-22'},
 {id:D,email:'bob@example.invalid',event_name:'2026式典',inquiry_number:'PA-2',received_at:'2026-10-01',event_date:'2026-10-22'}],messages:[],links:[]};
// Match actual normalizeMessage contract: no synthesized labels/direction.
const normalized=m=>({id:m.id,thread_id:m.threadId,direction:m.from===official?'outbound':'inbound',from_address:m.from,reply_to:null,
 to_addresses:m.to||[official],cc_addresses:[],subject:m.subject,occurred_at:m.occurred_at||now,attachments:[]});
const source=(filename,requires)=>{const code=fs.readFileSync(path.join(root,filename),'utf8');const module={exports:{}};
  vm.runInNewContext(`(function(require,module,exports){${code}\n})`,{Buffer,URL,URLSearchParams,AbortSignal,Date,Set,Map,fetch:async()=>{throw Error('LIVE_NETWORK_FORBIDDEN');},process:{env:{PAUI041_DISCOVERY_ENABLED:'true'}},console}, {filename})(name=>{
    if(name==='node:crypto')return require('node:crypto');
    if(requires[name])return requires[name];
    throw Error('Unexpected dependency '+name);
  },module,module.exports);return module.exports;};
const discovery=source('api/_pa-mail-discovery.cjs',{
 './_pa-mail.cjs':{OFFICIAL_EMAIL:official,getInquiry:async()=>({id:C}),getGmailAccessToken:async()=>{throw Error('no_provider');},mailConfig:()=>({}),supabaseRequest:async(url)=>{
   reads++;if(url.endsWith('/paui041_context'))return {authority,state:{}};writes++;throw Error('Unexpected DB write');},isUuid:s=>s===C||s===D},
 './_pa-gmail.cjs':{normalizeMessage:normalized,validGmailId:id=>/^[A-Za-z0-9_-]+$/.test(id)}
});
const linkCase={gmail_thread_id:'collision',inquiry_id:C};
const alice={id:'alice_notice',threadId:'collision',from:'notification@formspree.invalid',subject:notificationSubject};
const bob={id:'bob_notice',threadId:'collision',from:'notification@formspree.invalid',subject:notificationSubject};
const validReply={id:'alice_reply',threadId:'collision',from:'alice@example.invalid',subject:'秋祭りのお返事'};
const alienReply={id:'bob_reply',threadId:'collision',from:'bob@example.invalid',subject:'別のご相談'};
const sent={id:'alice_sent',threadId:'collision',from:official,to:['alice@example.invalid'],subject:'秋祭り資料',labelIds:['SENT']};
const msg=(...messages)=>({id:'collision',messages});
const ctx={authority:{...authority,links:[linkCase]}};
let n=0;const check=(name,fn)=>{fn();n++;console.log('PASS',name)};
const flags=rows=>rows.map(r=>[r.gmail_message_id,r.status,r.reason]);
check('Formspree notice recognized; unrelated ordinary mail not',()=>{
 assert(discovery.isGenericIntakeNotice(normalized(alice)));
 assert(discovery.isGenericIntakeNotice({subject:'Re: New submission from ARA-TECH お問い合わせ'}));
 assert(!discovery.isGenericIntakeNotice(normalized(validReply)));
});
check('Linked thread cannot adopt two independently submitted Formspree notices',()=>{
 const rows=discovery.threadRows(msg(alice,bob),'collision',ctx,C);
 assert.deepEqual([...rows].map(x=>x.status),['RELATED_CANDIDATE','RELATED_CANDIDATE']);
 assert(rows.every(x=>x.index===null&&x.reason==='generic_intake_message_identity_required'));
});
check('Without linked thread, generic notices also stay candidates',()=>{
 const rows=discovery.threadRows(msg(alice,bob),'collision',{authority},C);
 assert(rows.every(x=>x.status==='RELATED_CANDIDATE'&&x.index===null));
});
check('Owner thread-wide confirmation cannot bypass per-form identity',()=>{
 const rows=discovery.threadRows(msg(alice,bob),'collision',{authority},C,true);
 assert(rows.every(x=>x.status==='RELATED_CANDIDATE'));
});
check('Genuine customer reply is indexable and cross-customer reply is candidate',()=>{
 const rows=discovery.threadRows(msg(validReply,alienReply),'collision',ctx,C);
 assert.equal(rows[0].status,'INDEXED');assert.equal(rows[1].status,'RELATED_CANDIDATE');
 assert.equal(rows[1].reason,'linked_thread_participant_unverified');
});
check('Outbound official mail explicitly to case customer is indexable',()=>{
 const rows=discovery.threadRows(msg(sent),'collision',ctx,C);
 assert.equal(rows[0].status,'INDEXED');assert.equal(rows[0].index.direction,'outbound');
});
check('No destructive mutation of existing indexed notice; mark for review',()=>{
 const existing={...authority,messages:[{gmail_message_id:'bob_notice',gmail_thread_id:'collision',inquiry_id:C}]};
 const rows=discovery.threadRows(msg(bob),'collision',{authority:{...existing,links:[linkCase]}},C);
 assert.equal(rows[0].status,'RELATED_CANDIDATE');assert.equal(rows[0].index,null);
});
let originalWrites=writes;
const unlinked=source('api/_ara-unlinked-mail.cjs',{
 './_pa-mail.cjs':{OFFICIAL_EMAIL:official,getInquiry:async()=>({id:C}),isUuid:x=>x===C,supabaseRequest:async(url,options={})=>{
  if(url.startsWith('/rest/v1/ara_unlinked_mail')){reads++;return [{gmail_message_id:'bob_notice',gmail_thread_id:'collision',subject:notificationSubject,decision:'pending'}];}
  if(url.startsWith('/rest/v1/rpc/')){writes++;return {ok:true};}
  if(url.startsWith('/rest/v1/ara_mail_sync_state'))return [{window_start:now,window_end:now,cursor_version:0,covered_until:now}];
  throw Error('Unexpected fake database URL '+url);
 }},
 './_pa-gmail.cjs':{gmailJson:async()=>({emailAddress:official}),gmailMessage:async()=>bob,normalizeMessage:normalized,validGmailId:id=>/^[A-Za-z0-9_-]+$/.test(id),getGlobalThreadLink:async t=>getLink(t)},
 './_ara-case.cjs':{CASE_TYPES:{OTHER:'Other'}},
 './_pa-mail-discovery.cjs':{isGenericIntakeNotice:discovery.isGenericIntakeNotice}
});
async function asyncChecks(){
 const checkAsync=async(name,fn)=>{await fn();n++;console.log('PASS',name)};
 await checkAsync('Thread-wide Owner action refuses Formspree collision before any DB commit',async()=>{
  await assert.rejects(discovery.decideDiscovery({inquiryId:C,actorId:C,threadId:'collision',fingerprint:'a'.repeat(64),decision:'link'},async()=>{throw Error('LIVE_NETWORK_FORBIDDEN')},async()=>({thread:async()=>msg(alice,bob)})),/mail_identity_review_required/);
 });
 await checkAsync('Thread-wide Owner action refuses unrelated inbound senders',async()=>{
  await assert.rejects(discovery.decideDiscovery({inquiryId:C,actorId:C,threadId:'collision',fingerprint:'a'.repeat(64),decision:'link'},async()=>{throw Error('LIVE_NETWORK_FORBIDDEN')},async()=>({thread:async()=>msg(validReply,alienReply)})),/mail_identity_review_required/);
 });
 await checkAsync('Cannot create an entire case/thread from one generic Formspree notification',async()=>{
  await assert.rejects(unlinked.decideUnlinkedMail({actorId:C,messageId:'bob_notice',action:'create',customerName:'Bob',customerEmail:'bob@example.invalid',caseType:'OTHER'}),/mail_identity_review_required/);
 });
 await checkAsync('Cannot link generic notification to existing case through legacy thread RPC',async()=>{
  await assert.rejects(unlinked.decideUnlinkedMail({actorId:C,messageId:'bob_notice',action:'link',caseId:C}),/mail_identity_review_required/);
 });
 await checkAsync('Can review linked-thread generic notification without treating notifier as recipient',async()=>{
  getLink=async()=>({inquiry_id:C});
  const reviewed=await unlinked.reviewUnlinkedMail({messageId:'bob_notice'});
  assert.equal(reviewed.customer_candidate,null);assert.equal(reviewed.customer_confirmed,false);
 });
 await checkAsync('No mutation reached fake service and no provider call was made',async()=>{assert.equal(writes,0);assert.equal(originalWrites,0);});
 const sql=fs.readFileSync(path.join(root,'ops/PAUI-066-thread-identity-guard-CANDIDATE.sql'),'utf8');
 await checkAsync('Migration candidate preserves function signatures and blocks stale clients',async()=>{
  assert.equal((sql.match(/create or replace function public\./g)||[]).length,4);
  assert.equal((sql.match(/mail_identity_review_required/g)||[]).length,3);
  assert(sql.includes("coalesce(m->>'subject','') ~*"),'persisted inner subject must be gated');
  assert(sql.includes("coalesce(r->>'subject','') is distinct from coalesce(m->>'subject','')"),'outer/inner subjects must agree');
  assert(sql.includes("where gmail_message_id=m.gmail_message_id and decision='pending'"),'Owner decision must update exactly one message');
  assert(!sql.includes("where gmail_thread_id=m.gmail_thread_id and decision='pending'"),'No sibling bulk link allowed');
  assert(sql.includes("public.paui041_commit(uuid,uuid,bigint,jsonb,jsonb,jsonb,boolean)"));
  assert(sql.includes('DO NOT APPLY TO PRODUCTION'));
  assert(!/grant\s+(?:all|insert|update|delete|select)\s+on\s+public\./i.test(sql));
 });
 console.log('PAUI-066 synthetic offline tests:',n,'PASS, no network/DB writes');
}
asyncChecks().catch(err=>{console.error(err);process.exitCode=1});
