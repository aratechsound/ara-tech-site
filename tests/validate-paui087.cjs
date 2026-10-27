'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=process.argv[2]||process.cwd();
const code=fs.readFileSync(path.join(root,'api/_pa-gmail.cjs'),'utf8');
const marker='const indexThread = ';
const a=code.indexOf(marker), b=code.indexOf('\nconst recordSync =',a);
assert(a>=0&&b>a,'indexThread boundary');
const source=code.slice(a+marker.length,b).trim().replace(/;\s*$/,'');
const wrote=[];
const build=new Function('gmailThread','isPaCase','normalizeMessage','validGmailId','guardReplySource','restoreManagedOriginalFilenames','writeRow','return '+source);
let messages=[];
const indexThread=build(
 async()=>({messages}),
 ()=>true,
 m=>({id:m.id,thread_id:m.threadId,direction:m.from==='aratechsound@gmail.com'?'outbound':'inbound',occurred_at:'2026-10-22T06:34:40Z',from_address:m.from,to_addresses:['customer@example.com'],cc_addresses:[],subject:'fixture',attachments:[]}),
 v=>/^fixture_[a-z]+$/.test(v),
 ()=>{},
 v=>v,
 async(table,row)=>{ assert.equal(table,'pa_gmail_message_index');wrote.push(row); }
);
const inquiry={case_type:'PA_EVENT',first_form_data:{}};
const one=(id,labels,from='aratechsound@gmail.com')=>({id,threadId:'fixture_thread',from,labelIds:labels});
(async()=>{
 messages=[one('fixture_draft',['DRAFT']),one('fixture_sent',['SENT']),one('fixture_received',['INBOX'],'customer@example.com')];
 let out=await indexThread({inquiry,inquiryId:'fixture_case',threadId:'fixture_thread'});
 assert.deepEqual(out.messages.map(m=>m.id),['fixture_sent','fixture_received']);
 assert.deepEqual(wrote.map(m=>m.gmail_message_id),['fixture_sent','fixture_received']);
 assert.equal(wrote[0].message_source,'gmail_direct');
 wrote.length=0;
 messages=[one('fixture_draft',['DRAFT','SENT']),one('fixture_sent',['SENT'])];
 out=await indexThread({inquiry,inquiryId:'fixture_case',threadId:'fixture_thread'});
 assert.deepEqual(out.messages.map(m=>m.id),['fixture_sent']);
 assert.deepEqual(wrote.map(m=>m.gmail_message_id),['fixture_sent']);
 wrote.length=0;
 messages=[one('fixture_legacy',undefined)];
 out=await indexThread({inquiry,inquiryId:'fixture_case',threadId:'fixture_thread'});
 assert.deepEqual(out.messages.map(m=>m.id),['fixture_legacy']);
 assert(!code.includes('gmail.messages.send'), 'no new gmail send route');
 console.log('PAUI-087 isolated draft filtering: PASS (4 scenarios)');
 // Exercise the exported sync against an isolated database and synthetic Gmail.
 // Replaying the same thread must not reintroduce a draft or change other cases.
 global.fetch=async()=>{throw Error('LIVE_NETWORK_FORBIDDEN');};
 const {createFixture}=require('./helpers/ara-case-fixture.cjs');
 const f=await createFixture();
 try {
  const C='11111111-1111-4111-8111-111111111111',D='22222222-2222-4222-8222-222222222222';
  await f.db.query("insert into pa_inquiries(id,created_by,status,customer_name,email,event_name,case_type) values($1,$3,'new_inquiry','Fixture','customer@example.invalid','Fixture event','PA_EVENT'),($2,$3,'new_inquiry','Other','other@example.invalid','Other event','PA_EVENT')",[C,D,f.actor]);
  await f.db.query("insert into pa_gmail_thread_links(inquiry_id,gmail_thread_id,link_source,conversation_role,linked_by) values($1,'thread_1','gmail_message_id','primary_conversation',$2)",[C,f.actor]);
  await f.db.query("insert into pa_inquiry_audit(inquiry_id,actor_user_id,action,details) values($1,$2,'gmail_case_reply_sent',$3)",[C,f.actor,JSON.stringify({gmail_message_id:'managed_sent',attachment_filenames:[]})]);
  await f.db.query("insert into pa_gmail_message_index(gmail_message_id,gmail_thread_id,inquiry_id,direction,message_source,from_address,to_addresses,subject) values('other_mail','other_thread',$1,'inbound','gmail_received','other@example.invalid','[]','Other')",[D]);
  const otherBefore=JSON.stringify((await f.db.query('select * from pa_gmail_message_index where inquiry_id=$1',[D])).rows);
  const make=(id,labels,outbound=false)=>{const m=f.raw(id);m.labelIds=labels;if(outbound){m.payload.headers.find(h=>h.name==='From').value='aratechsound@gmail.com';m.payload.headers.find(h=>h.name==='To').value='customer@example.invalid';}return m;};
  const originals=[make('draft_only',['DRAFT'],true),make('draft_sent',['DRAFT','SENT'],true),make('direct_sent',['SENT'],true),make('managed_sent',['SENT'],true),make('received',['INBOX'])];
  f.state.threadMessages.set('thread_1',originals);
  const originalBytes=JSON.stringify(originals);
  const sync=require('../api/_pa-gmail.cjs').syncCase;
  for(let replay=0;replay<2;replay++){
   const result=await sync({inquiryId:C,actorId:f.actor},f.fetchImpl);
   assert.deepEqual(result.messages.map(m=>m.id),['direct_sent','managed_sent','received']);
   const rows=(await f.db.query('select gmail_message_id,message_source from pa_gmail_message_index where inquiry_id=$1 order by gmail_message_id',[C])).rows;
   assert.deepEqual(rows,[{gmail_message_id:'direct_sent',message_source:'gmail_direct'},{gmail_message_id:'managed_sent',message_source:'pa_case_manager'},{gmail_message_id:'received',message_source:'gmail_received'}]);
  }
  assert.equal(JSON.stringify(originals),originalBytes,'Gmail originals unchanged');
  assert.equal(JSON.stringify((await f.db.query('select * from pa_gmail_message_index where inquiry_id=$1',[D])).rows),otherBefore,'other case unchanged');
  assert.equal(f.state.sendCount,0);
  assert(f.state.network.filter(n=>n.host==='gmail.googleapis.com').every(n=>n.method==='GET'),'Gmail GET only');
  console.log('PAUI-087 exported sync + DB replay: PASS; Gmail mutations=0; other case unchanged');
 } finally { await f.db.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
