// All production boundaries are injected fakes. An accidental real fetch fails.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
global.fetch = async () => { throw Error('LIVE_NETWORK_FORBIDDEN'); };
Object.assign(process.env, {
  SUPABASE_URL: 'https://local-fixture.invalid', SUPABASE_SERVICE_ROLE_KEY: 'pam024-fake-signing-key',
  GMAIL_CLIENT_ID: 'fake-client', GMAIL_CLIENT_SECRET: 'fake-secret', GMAIL_REFRESH_TOKEN: 'fake-refresh',
  GMAIL_SENDER_ADDRESS: 'aratechsound@gmail.com', GMAIL_REPLY_TO: 'aratechsound@gmail.com',
  ARA_GENERAL_INQUIRY_ENABLED: 'true', ARA_GENERAL_FIXTURE: 'true',
  ARA_GENERAL_NOTIFICATION_POLICY: JSON.stringify({verified:true,notification_recipient:'aratechsound@gmail.com',receipt_enabled:false,spam_adapter:'fixture'})
});
const gmail = require('../api/_pa-gmail.cjs');
const intake = require('../api/_ara-intake.cjs');
const Y = '516bed8d-ff81-4a52-b53b-fc89161088ec';
const ACTOR = '123e4567-e89b-42d3-a456-426614174001';
const T = '1a1074e34ef4b6a9', M = T, K = '1a109d9b5c652662';
const OWNER = {id:Y,email:'tyjan17th@gmail.com',case_type:'AV_INSTALL',first_form_data:{import_source:'gmail_owner_confirmed',gmail_message_id:M,gmail_thread_id:T}};
const checks=[];
const check = async (name,fn) => { await fn(); checks.push({name,result:'PASS'}); };
const json = data => ({ok:true,status:200,json:async()=>structuredClone(data)});
function raw(id, from='tyjan17th@gmail.com', opts={}) {
  const headers = {From:from,To:opts.to||'aratechsound@gmail.com',Subject:'fixture conversation','Message-ID':`<${id}@fixture.invalid>`,...opts.headers};
  return {id,threadId:opts.thread||T,internalDate:opts.date||'1791220000000',payload:{mimeType:'text/plain',headers:Object.entries(headers).map(([name,value])=>({name,value})),body:{data:Buffer.from('local fixture only').toString('base64url')}}};
}
const yRaw = () => raw(M,'noreply@formspree.io',{headers:{'Reply-To':OWNER.email}});
const kRaw = () => raw(K,'noreply@formspree.io',{date:'1791221000000',headers:{'Reply-To':'kishimotodenko.nakagawa@gmail.com'}});
function replyFixture({inquiry=OWNER,messages=[yRaw(),kRaw()], mutate}={}) {
  const state={inquiry:structuredClone(inquiry),messages:structuredClone(messages),sends:[],writes:[],threadReads:0,rootReads:0,indexReads:0,indexFailure:false,indexMalformed:false,index:messages.map(m=>({gmail_message_id:m.id,gmail_thread_id:m.threadId,inquiry_id:inquiry.id})),links:[{inquiry_id:inquiry.id,gmail_thread_id:T,conversation_role:'primary_conversation'}]};
  const fetchImpl=async (url,opts={})=>{
    const u=new URL(url); const method=opts.method||'GET';
    if(url==='https://oauth2.googleapis.com/token')return json({access_token:'fake-access'});
    if(u.pathname.endsWith('/profile'))return json({emailAddress:'aratechsound@gmail.com'});
    if(u.pathname.includes('/threads/')) {state.threadReads++;if(mutate)mutate(state,'thread');return json({messages:state.messages});}
    if(u.pathname.endsWith('/pa_inquiries')) {state.rootReads++;if(mutate)mutate(state,'root');return json([state.inquiry]);}
    if(u.pathname.endsWith('/pa_gmail_thread_links'))return json(state.links);
    if(method==='GET'&&u.pathname.endsWith('/pa_gmail_message_index')) {
      state.indexReads++;if(mutate)mutate(state,'index');
      assert.equal(u.searchParams.has('inquiry_id'),false,'case filter must never hide other-case attribution');
      assert.equal(u.searchParams.get('select'),'gmail_message_id,gmail_thread_id,inquiry_id');
      if(state.indexFailure)throw Error('fake_index_read_failure');
      if(state.indexMalformed)return json({});
      const ids=u.searchParams.get('gmail_message_id').slice(4,-1).split(',');
      return json(state.index.filter(r=>ids.includes(r.gmail_message_id)));
    }
    if(method==='GET'&&u.pathname.endsWith('/pa_email_deliveries'))return json([]);
    if(method==='GET'&&u.pathname.endsWith('/pa_inquiry_audit'))return json([]);
    if(method==='POST'&&u.pathname.endsWith('/messages/send')) {state.sends.push(JSON.parse(opts.body));return json({id:'fake-sent',threadId:T});}
    if(method==='POST'&&['/pa_inquiry_audit','/pa_case_mail_attention','/pa_gmail_message_index'].some(p=>u.pathname.endsWith(p))) {const data=JSON.parse(opts.body);state.writes.push({table:u.pathname.split('/').at(-1),data});return json([data]);}
    throw Error('UNEXPECTED_FAKE_BOUNDARY '+method+' '+u.pathname);
  };
  return {state,fetchImpl};
}
const request={inquiryId:Y,actorId:ACTOR,body:'Local reply fixture.',replySourceMessageId:M,replySourceThreadId:T};
async function blocked(f,input=request,pattern=/reply_target_unavailable|invalid_reply_source|gmail_thread_not_linked/) {
  await assert.rejects(()=>gmail.replyPreview(input,f.fetchImpl),pattern);
  await assert.rejects(()=>gmail.replyContentPreview(input,f.fetchImpl),pattern);
  await assert.rejects(()=>gmail.sendReply({...input,confirmationToken:'unused'},f.fetchImpl),pattern);
  assert.equal(f.state.sends.length,0);
}
function generalFixture(options={}) {
  const state={roots:new Map(),rows:[],sends:[],events:[],registerCount:0,sequence:0};
  const fetchImpl=async(url,opts={})=>{
    const u=new URL(url),method=opts.method||'GET';state.events.push(method+' '+u.pathname);
    if(url==='https://oauth2.googleapis.com/token')return json({access_token:'fake-access'});
    if(u.pathname.endsWith('/profile'))return json({emailAddress:'aratechsound@gmail.com'});
    if(u.pathname.endsWith('/ara_register_general')) {
      state.registerCount++; const b=JSON.parse(opts.body);let root=state.roots.get(b.p_key);
      if(root) {if(root.hash!==b.p_hash)throw Error('submission_content_conflict');return json({...root.result,duplicate:true});}
      const result={id:randomUUID(),inquiry_number:`PA-20261006-${String(++state.sequence).padStart(5,'0')}`,duplicate:false};
      root={hash:b.p_hash,result};state.roots.set(b.p_key,root);
      for(const n of b.p_notifications)state.rows.push({id:randomUUID(),inquiry_id:result.id,recipient:n.recipient,subject:n.subject.replaceAll('{number}',result.inquiry_number),body:n.body.replaceAll('{number}',result.inquiry_number),status:'queued',message_type:n.message_type});
      if(options.registerTimeout) {options.registerTimeout=false;throw Error('timeout_after_commit');}
      return json(options.badReceipt?{duplicate:false}:result);
    }
    if(method==='GET'&&u.pathname.endsWith('/pa_email_deliveries'))return json(state.rows.filter(r=>r.inquiry_id===u.searchParams.get('inquiry_id').slice(3)));
    if(u.pathname.endsWith('/ara_claim_intake_delivery')) {
      const row=state.rows.find(r=>r.id===JSON.parse(opts.body).p_id);if(row.status!=='queued')return json([]);
      row.status='sending'; if(options.claimTimeout){options.claimTimeout=false;throw Error('claim_timeout');}return json([row]);
    }
    if(u.pathname.endsWith('/messages/send')) {assert.ok(state.roots.size);state.sends.push(JSON.parse(opts.body));if(options.sendTimeout)throw Error('timeout_after_provider');return json({id:'fake-send-'+state.sends.length,threadId:'fake-thread-'+state.sends.length});}
    if(method==='PATCH'&&u.pathname.endsWith('/pa_email_deliveries')) {if(options.patchTimeout)throw Error('patch_timeout');Object.assign(state.rows.find(r=>r.id===u.searchParams.get('id').slice(3)),JSON.parse(opts.body));return json([]);}
    throw Error('UNEXPECTED_FAKE_BOUNDARY '+method+' '+u.pathname);
  };
  return {state,fetchImpl};
}
const input=()=>({submission_key:randomUUID(),case_type:'AV_INSTALL',customer_name:'COMMON fixture',email:'customer@example.invalid',subject:'local only',body:'test body'});
const decode=b=>Buffer.from(b,'base64url').toString('utf8');
(async()=>{
  await check('COMMON commit and case number precede notification; receipt disabled; no thread inheritance',async()=>{
    const f=generalFixture(),r=await intake.accept(input(),f.fetchImpl);
    assert.match(r.inquiry_number,/^PA-/);assert.equal(f.state.rows.length,1);assert.equal(f.state.sends.length,1);
    assert.ok(f.state.rows[0].subject.includes(r.inquiry_number));assert.ok(f.state.rows[0].body.includes(r.inquiry_number));
    assert.ok(f.state.events.findIndex(x=>x.includes('ara_register_general'))<f.state.events.findIndex(x=>x.includes('messages/send')));
    assert.equal(f.state.sends[0].threadId,undefined);assert.doesNotMatch(decode(f.state.sends[0].raw),/^(?:In-Reply-To|References):/m);
  });
  await check('distinct cases get distinct numbered notification subjects',async()=>{const f=generalFixture();await intake.accept(input(),f.fetchImpl);await intake.accept(input(),f.fetchImpl);assert.notEqual(f.state.rows[0].subject,f.state.rows[1].subject);assert.equal(f.state.roots.size,2);});
  await check('duplicate/concurrent acceptance claims once; fingerprint conflict sends nothing extra',async()=>{const f=generalFixture(),i=input();await Promise.all([intake.accept(i,f.fetchImpl),intake.accept(i,f.fetchImpl)]);await intake.accept(i,f.fetchImpl);assert.equal(f.state.roots.size,1);assert.equal(f.state.sends.length,1);await assert.rejects(()=>intake.accept({...i,body:'changed'},f.fetchImpl),/submission_content_conflict/);assert.equal(f.state.sends.length,1);});
  await check('commit response timeout uses same key, preserves one root',async()=>{const f=generalFixture({registerTimeout:true}),i=input();await assert.rejects(()=>intake.accept(i,f.fetchImpl),/timeout_after_commit/);assert.equal(f.state.sends.length,0);const r=await intake.accept(i,f.fetchImpl);assert.equal(r.duplicate,true);assert.equal(f.state.roots.size,1);assert.equal(f.state.sends.length,1);});
  for(const [flag,status]of [['sendTimeout','unknown'],['claimTimeout','sending'],['patchTimeout','sending']])await check('notification '+flag+' keeps acceptance; duplicate never retries unknown/sending',async()=>{const f=generalFixture({[flag]:true}),i=input();const r=await intake.accept(i,f.fetchImpl);assert.ok(r.id);const sends=f.state.sends.length;await intake.accept(i,f.fetchImpl);assert.equal(f.state.sends.length,sends);assert.equal(f.state.rows[0].status,status);});
  await check('durable receipt UNKNOWN prevents every notification attempt',async()=>{const f=generalFixture({badReceipt:true});await assert.rejects(()=>intake.accept(input(),f.fetchImpl),/intake_result_unknown/);assert.equal(f.state.sends.length,0);assert.equal(f.state.events.length,1);});
  await check('flag=false refuses COMMON before any transport; Formspree LEGACY path retained',async()=>{process.env.ARA_GENERAL_INQUIRY_ENABLED='false';const f=generalFixture();await assert.rejects(()=>intake.accept(input(),f.fetchImpl),/general_intake_disabled/);assert.equal(f.state.events.length,0);process.env.ARA_GENERAL_INQUIRY_ENABLED='true';const html=fs.readFileSync(path.join(__dirname,'../general-inquiry.html'),'utf8'),ui=fs.readFileSync(path.join(__dirname,'../js/ara-general-inquiry.js'),'utf8');assert.match(html,/formspree\.io\/f\/mojqjwnr/);assert.match(ui,/LEGACY/);assert.match(ui,/formspree/i);});
  await check('mixed thread accepts explicit original Owner message; CC excludes relay',async()=>{const f=replyFixture(),p=await gmail.replyPreview(request,f.fetchImpl),c=await gmail.replyContentPreview(request,f.fetchImpl);assert.equal(p.reply_source_message_id,M);assert.equal(p.recipient,OWNER.email);assert.deepEqual(p.cc_addresses,[]);assert.equal(c.reply_source_authority_hash,p.reply_source_authority_hash);await gmail.sendReply({...request,confirmationToken:p.confirmation_token},f.fetchImpl);assert.equal(f.state.sends.length,1);assert.match(decode(f.state.sends[0].raw),new RegExp('In-Reply-To: <'+M+'@fixture.invalid>'));});
  await check('mixed Owner thread latest fallback refused at preview/content/send',()=>blocked(replyFixture(),{...request,replySourceMessageId:undefined,replySourceThreadId:undefined}));
  await check('foreign Formspree message refused at preview/content/send',()=>blocked(replyFixture(),{...request,replySourceMessageId:K}));
  await check('UNKNOWN Reply-To in mixed thread refused',()=>blocked(replyFixture({messages:[yRaw(),raw(K,'noreply@formspree.io')]}),{...request,replySourceMessageId:K}));
  await check('unlinked or wrong message/thread refused',()=>blocked(replyFixture(),{...request,replySourceThreadId:'other-thread'}));
  const pa={id:Y,email:OWNER.email,case_type:'PA_EVENT'};
  await check('PA mixed foreign customer cannot use implicit latest',()=>blocked(replyFixture({inquiry:pa,messages:[raw(M),raw(K,'foreign@example.invalid')]}),{...request,replySourceMessageId:undefined,replySourceThreadId:undefined}));
  for(const [name,message]of [
    ['contradictory customer Reply-To',raw(M,OWNER.email,{headers:{'Reply-To':'other@example.invalid'}})],
    ['malformed Reply-To',raw(M,OWNER.email,{headers:{'Reply-To':'not-an-email'}})],
    ['multiple Reply-To addresses',raw(M,OWNER.email,{headers:{'Reply-To':OWNER.email+', other@example.invalid'}})],
    ['missing RFC source message',raw(M,OWNER.email,{headers:{'Message-ID':''}})],
    ['unknown sender',raw(M,'unknown@invalid.local')]
  ])await check(name+' refuses preview/content/send',()=>blocked(replyFixture({inquiry:pa,messages:[message]})));
  await check('normal PA round trip and legitimate To/CC participants preserved',async()=>{
    const messages=[raw(M,OWNER.email,{headers:{Cc:'peer@example.invalid'}}),raw(K,'aratechsound@gmail.com',{to:OWNER.email,headers:{Cc:'peer@example.invalid','Reply-To':'aratechsound@gmail.com'}})];
    const f=replyFixture({inquiry:pa,messages}),p=await gmail.replyPreview(request,f.fetchImpl);assert.deepEqual(p.cc_addresses,['peer@example.invalid']);await gmail.sendReply({...request,confirmationToken:p.confirmation_token},f.fetchImpl);assert.match(decode(f.state.sends[0].raw),/^Cc: peer@example\.invalid$/m);
    const implicit=await gmail.replyPreview({...request,replySourceMessageId:undefined,replySourceThreadId:undefined},f.fetchImpl);assert.equal(implicit.recipient,OWNER.email);
    const peer=replyFixture({inquiry:pa,messages:[raw(M,'peer@example.invalid',{to:'aratechsound@gmail.com, '+OWNER.email})]});assert.equal((await gmail.replyPreview(request,peer.fetchImpl)).recipient,'peer@example.invalid');
  });
  await check('foreign CC addition refused',()=>blocked(replyFixture({inquiry:pa,messages:[raw(M)]}),{...request,ccAddresses:['foreign@example.invalid']},/invalid_reply_cc/));
  await check('normal PA estimate/invoice/confirmation modes preserve explicit source and CC',async()=>{
    for(const mode of ['estimate_submission','invoice','confirmation']) {
      const f=replyFixture({inquiry:pa,messages:[raw(M,OWNER.email,{headers:{Cc:'peer@example.invalid'}})]});
      const p=await gmail.replyPreview({...request,mode},f.fetchImpl);
      await gmail.sendReply({...request,mode,confirmationToken:p.confirmation_token},f.fetchImpl);
      assert.equal(p.mode,mode);assert.equal(f.state.sends.length,1);assert.match(decode(f.state.sends[0].raw),/^Cc: peer@example\.invalid$/m);
    }
  });
  await check('returned link belongs to another case: preview/content/send refuse',async()=>{const f=replyFixture();f.state.links[0].inquiry_id=ACTOR;await blocked(f);});
  await check('returned root belongs to another case: preview/content/send refuse',async()=>{const f=replyFixture();f.state.inquiry.id=ACTOR;await blocked(f);});
  const automatic={...request,replySourceMessageId:undefined,replySourceThreadId:undefined};
  const attributionErrors=/reply_attribution_(?:conflict|unknown|unavailable)/;
  await check('A01 explicit other-case message index rejected by preview/content/send',async()=>{const f=replyFixture();f.state.index[0].inquiry_id=ACTOR;await blocked(f,request,/reply_attribution_conflict/);});
  await check('A02 implicit other-case member rejected despite matching thread/root/customer',async()=>{const f=replyFixture({inquiry:pa,messages:[raw(M),raw(K)]});f.state.index[0].inquiry_id=ACTOR;await blocked(f,automatic,/reply_attribution_conflict/);});
  await check('A03 explicit missing index rejected; Owner original root cannot bypass UNKNOWN',async()=>{const f=replyFixture();f.state.index=[];await blocked(f,request,/reply_attribution_unknown/);});
  await check('A04 implicit missing member index rejected as UNKNOWN',async()=>{const f=replyFixture({inquiry:pa,messages:[raw(M),raw(K)]});f.state.index.pop();await blocked(f,automatic,/reply_attribution_unknown/);});
  await check('A05 null/invalid case attribution rejected as UNKNOWN',async()=>{for(const auto of [false,true]){const f=replyFixture({inquiry:pa,messages:[raw(M)]});f.state.index[0].inquiry_id=null;await blocked(f,auto?automatic:request,/reply_attribution_unknown/);}});
  await check('A06 index read failure rejected by preview/content/send',async()=>{for(const auto of [false,true]){const f=replyFixture({inquiry:pa,messages:[raw(M)]});f.state.indexFailure=true;await blocked(f,auto?automatic:request,/reply_attribution_unavailable/);}});
  await check('A07 malformed index response rejected as UNKNOWN',async()=>{for(const auto of [false,true]){const f=replyFixture({inquiry:pa,messages:[raw(M)]});f.state.indexMalformed=true;await blocked(f,auto?automatic:request,/reply_attribution_unknown/);}});
  await check('A08 index thread contradiction rejected',async()=>{const f=replyFixture();f.state.index[0].gmail_thread_id='another-thread';await blocked(f,request,/reply_attribution_conflict/);});
  await check('A09 duplicate index rows rejected as UNKNOWN',async()=>{const f=replyFixture();f.state.index.push({...f.state.index[0]});await blocked(f,request,/reply_attribution_unknown/);});
  await check('A10 same-case homogeneous PA auto preview to explicit send preserves CC',async()=>{
    const f=replyFixture({inquiry:pa,messages:[raw(M,OWNER.email,{headers:{Cc:'peer@example.invalid'}})]});
    const p=await gmail.replyPreview(automatic,f.fetchImpl);assert.equal(p.reply_source_explicit,false);
    assert.equal(JSON.parse(Buffer.from(p.confirmation_token.split('.')[0],'base64url')).replySourceExplicit,false);
    await gmail.sendReply({...request,confirmationToken:p.confirmation_token},f.fetchImpl);assert.equal(f.state.sends.length,1);assert.match(decode(f.state.sends[0].raw),/^Cc: peer@example\.invalid$/m);
  });
  await check('A11 preview to send selected attribution change rejected',async()=>{const f=replyFixture(),p=await gmail.replyPreview(request,f.fetchImpl);f.state.index[0].inquiry_id=ACTOR;await assert.rejects(()=>gmail.sendReply({...request,confirmationToken:p.confirmation_token},f.fetchImpl),/reply_attribution_conflict/);assert.equal(f.state.sends.length,0);});
  await check('A12 last awaited attribution reread detects change before provider send',async()=>{const f=replyFixture({mutate:(s,phase)=>{if(phase==='index'&&s.indexReads===3)s.index[0].inquiry_id=ACTOR;}}),p=await gmail.replyPreview(request,f.fetchImpl);await assert.rejects(()=>gmail.sendReply({...request,confirmationToken:p.confirmation_token},f.fetchImpl),/reply_attribution_conflict/);assert.equal(f.state.indexReads,3);assert.equal(f.state.sends.length,0);});
  await check('A13 last attribution reread failure forbids provider send',async()=>{const f=replyFixture({mutate:(s,phase)=>{if(phase==='index'&&s.indexReads===3)s.indexFailure=true;}}),p=await gmail.replyPreview(request,f.fetchImpl);await assert.rejects(()=>gmail.sendReply({...request,confirmationToken:p.confirmation_token},f.fetchImpl),/reply_attribution_unavailable/);assert.equal(f.state.sends.length,0);});
  for(const missing of [false,true])await check(missing?'A15 automatic approval with unselected UNKNOWN cannot become explicit bypass':'A14 automatic approval with unselected conflicting member cannot become explicit bypass',async()=>{
    const f=replyFixture({inquiry:pa,messages:[raw(M),raw(K,OWNER.email,{date:'1791221000000'})]}),p=await gmail.replyPreview(automatic,f.fetchImpl);
    assert.equal(p.reply_source_message_id,K);if(missing)f.state.index.shift();else f.state.index[0].inquiry_id=ACTOR;
    await assert.rejects(()=>gmail.sendReply({...request,replySourceMessageId:K,confirmationToken:p.confirmation_token},f.fetchImpl),attributionErrors);assert.equal(f.state.sends.length,0);
  });
  await check('A16 explicit rightful original allowed in mixed thread only with its own same-case index',async()=>{const f=replyFixture();f.state.index[1].inquiry_id=ACTOR;const p=await gmail.replyPreview(request,f.fetchImpl);await gmail.sendReply({...request,confirmationToken:p.confirmation_token},f.fetchImpl);assert.equal(f.state.sends.length,1);});
  await check('A17 PA participant different from root customer requires explicit selection; legitimate CC remains',async()=>{const f=replyFixture({inquiry:pa,messages:[raw(M,'peer@example.invalid',{to:'aratechsound@gmail.com, '+OWNER.email})]});await blocked(f,automatic,/invalid_reply_source/);const p=await gmail.replyPreview(request,f.fetchImpl);await gmail.sendReply({...request,confirmationToken:p.confirmation_token},f.fetchImpl);assert.equal(p.recipient,'peer@example.invalid');assert.deepEqual(p.cc_addresses,[OWNER.email]);assert.equal(f.state.sends.length,1);});
  await check('A18 UNKNOWN thread link case rejected',async()=>{const f=replyFixture();delete f.state.links[0].inquiry_id;await blocked(f);});
  for(const field of ['email','Reply-To','Message-ID','References','Cc'])await check('send revalidation rejects changed '+field,async()=>{
    const f=replyFixture(),p=await gmail.replyPreview(request,f.fetchImpl);
    if(field==='email')f.state.inquiry.email='changed@example.invalid';
    else {const h=f.state.messages[0].payload.headers;const values={'Reply-To':'changed@example.invalid','Message-ID':'<changed@fixture.invalid>',References:'<foreign@fixture.invalid>',Cc:'foreign@example.invalid'};const old=h.find(x=>x.name===field);if(old)old.value=values[field];else h.push({name:field,value:values[field]});}
    await assert.rejects(()=>gmail.sendReply({...request,confirmationToken:p.confirmation_token},f.fetchImpl),/reply_target_unavailable|invalid_confirmation/);assert.equal(f.state.sends.length,0);
  });
  await check('last thread reread mutation rejected before provider',async()=>{const f=replyFixture({mutate:(s,phase)=>{if(phase==='thread'&&s.threadReads===3)s.messages[0].payload.headers.find(h=>h.name==='Reply-To').value='changed@example.invalid';}}),p=await gmail.replyPreview(request,f.fetchImpl);await assert.rejects(()=>gmail.sendReply({...request,confirmationToken:p.confirmation_token},f.fetchImpl),/reply_target_unavailable|invalid_reply_source/);assert.equal(f.state.sends.length,0);});
  await check('last root reread/link removal rejected before provider',async()=>{const f=replyFixture({mutate:(s,phase)=>{if(phase==='root'&&s.rootReads===3)s.links=[];}}),p=await gmail.replyPreview(request,f.fetchImpl);await assert.rejects(()=>gmail.sendReply({...request,confirmationToken:p.confirmation_token},f.fetchImpl),/gmail_thread_not_linked/);assert.equal(f.state.sends.length,0);});
  await check('limited correction fixture excludes only foreign index/derived attention; resync never reintroduces it',async()=>{
    const f=replyFixture(),rootBefore=structuredClone(f.state.inquiry),historical=[{action:'gmail_threads_synced',message_count:2}],historyBefore=structuredClone(historical);
    // Local dry-run data projection only; no executable SQL correction.
    const oldIndex=[{gmail_message_id:M,inquiry_id:Y,gmail_thread_id:T},{gmail_message_id:K,inquiry_id:Y,gmail_thread_id:T}];
    const projected=oldIndex.filter(row=>!(row.inquiry_id===Y&&row.gmail_thread_id===T&&row.gmail_message_id===K));assert.equal(projected.length,1);
    for(let i=0;i<2;i++) {const r=await gmail.syncCase({inquiryId:Y,actorId:ACTOR},f.fetchImpl);assert.deepEqual(r.messages.map(m=>m.id),[M]);}
    assert.ok(f.state.writes.filter(w=>w.table==='pa_gmail_message_index').every(w=>w.data.gmail_message_id===M));
    const attention=f.state.writes.filter(w=>w.table==='pa_case_mail_attention').at(-1).data;assert.equal(attention.last_seen_inbound_at,new Date(Number(yRaw().internalDate)).toISOString());
    assert.deepEqual(f.state.inquiry,rootBefore);assert.deepEqual(historical,historyBefore);assert.equal(f.state.sends.length,0);assert.equal(f.state.writes.some(w=>w.table==='pa_inquiries'),false);
  });
  const sql=fs.readFileSync(path.join(__dirname,'../supabase/migrations/20261005160000_ara_case_r2_intake_coverage.sql'),'utf8');
  await check('existing durable transaction/number substitution/atomic queued claim retained (source contract)',async()=>{assert.match(sql,/pg_advisory_xact_lock\(hashtextextended\('ara-intake:'/);assert.match(sql,/intake_fingerprint is distinct from p_hash/);assert.match(sql,/returning \* into c/);assert.match(sql,/replace\(n->>'subject','\{number\}',c\.inquiry_number\)/);assert.match(sql,/set status='sending' where id=p_id and status='queued'/);});
  console.log(JSON.stringify({task:'PAM-024',result:'PASS',checks,check_count:checks.length,scope:'injected fake transport and local dry-run projections; source contract assertions; no live DB or provider',real_email_send:0,production_mutation:0},null,2));
})().catch(e=>{console.error(e);process.exitCode=1;});
