'use strict';
// PAUI-041: deterministic discovery. Gmail GETs only; writes are committed by
// one narrow, versioned DB transaction. No portal, delivery or workflow calls.
const crypto=require('node:crypto');
const {OFFICIAL_EMAIL,getInquiry,getGmailAccessToken,mailConfig,supabaseRequest,isUuid}=require('./_pa-mail.cjs');
const {normalizeMessage,validGmailId}=require('./_pa-gmail.cjs');
const hash=x=>crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
const norm=x=>String(x||'').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu,'');
const address=x=>String(x||'').trim().toLowerCase();
const official=address(OFFICIAL_EMAIL);
const enabled=()=>process.env.PAUI041_DISCOVERY_ENABLED==='true';
const rpc=(name,input,fetchImpl)=>supabaseRequest('/rest/v1/rpc/'+name,{method:'POST',body:JSON.stringify(input)},fetchImpl);
function signals(authority){
  return authority.cases.map(c=>{
    const indexed=authority.messages.filter(m=>m.inquiry_id===c.id);
    const addresses=new Set([c.email,...indexed.flatMap(m=>[m.from_address,...(m.to_addresses||[]),...(m.cc_addresses||[])])].map(address).filter(x=>x&&x!==official));
    // A year prefix is presentation, not the event's identifying name. Same
    // event names in another case remain competitors and require Owner review.
    const names=[c.event_name,c.case_subject,c.public_event_name].map(norm).flatMap(x=>[x,x.replace(/^(?:19|20)\d{2}年?/, '')]).filter(x=>x.length>=4);
    return {id:c.id,deleted:!!c.deleted_at,addresses,names:[...new Set(names)],reference:norm(c.inquiry_number),date:c.event_date,start:c.received_at};
  });
}
function matchThread(messages,authority){
  const cases=signals(authority),choices=[];
  for(const m of messages){
    const subject=norm(m.subject),participants=m.direction==='outbound'?m.to_addresses:[m.from_address];
    const named=cases.filter(c=>c.names.some(n=>subject.includes(n))||(c.reference&&subject.includes(c.reference)));
    const supported=named.filter(c=>participants.some(a=>c.addresses.has(address(a))));
    const possible=cases.filter(c=>participants.some(a=>c.addresses.has(address(a))));
    // A title matching another case, a forward, an invalid sender, or dates
    // outside the case's work period cannot silently establish a new link.
    const selected=supported.length===1&&named.length===1?supported[0]:null;
    const t=Date.parse(m.occurred_at),start=Date.parse(selected?.start),end=Date.parse(selected?.date);
    const timeSafe=selected&&Number.isFinite(t)&&Number.isFinite(start)&&Number.isFinite(end)&&t>=start-30*86400000&&t<=end+91*86400000;
    const mailboxParty=m.direction==='outbound'?address(m.from_address)===official:[...m.to_addresses,...m.cc_addresses].some(a=>address(a)===official);
    choices.push({selected:timeSafe&&mailboxParty&&!selected.deleted&&!m.reply_identity_invalid&&!/^\s*(?:fw|fwd|転送)\s*[:：]/iu.test(m.subject)?selected.id:null,possible:[...new Set([...named,...possible].map(c=>c.id))]});
  }
  const ids=[...new Set(choices.map(c=>c.selected))];
  return {caseId:ids.length===1&&ids[0]?ids[0]:null,candidates:[...new Set(choices.flatMap(c=>c.possible))],reason:ids.length===1&&ids[0]?'participant_and_unique_case_identity':'owner_review_required'};
}
function buildQuery(authority,inquiryId,start,end){
  const s=signals(authority).find(c=>c.id===inquiryId);if(!s)throw Error('inquiry_not_found');
  const quote=x=>'"'+String(x).replace(/["\\\r\n]/gu,' ')+'"';
  const terms=[...s.addresses].flatMap(x=>['from:'+quote(x),'to:'+quote(x),'cc:'+quote(x)]);
  terms.push(...s.names.map(x=>quote(x)),...authority.cases.filter(c=>c.id===inquiryId&&c.inquiry_number).map(c=>quote(c.inquiry_number)));
  if(!terms.length)throw Error('discovery_no_search_basis');
  const q='{'+terms.join(' ')+'} -in:spam -in:trash -in:drafts before:'+Math.floor(Date.parse(end)/1000)+(start?' after:'+Math.floor(Date.parse(start)/1000):'');
  if(q.length>12000)throw Error('discovery_search_basis_too_large');
  return q;
}
async function createProvider(fetchImpl=fetch){
  const token=await getGmailAccessToken(mailConfig(),fetchImpl);
  async function get(path){
    if(!/^\/(?:profile$|messages\?|threads\/[A-Za-z0-9_-]+\?format=full$)/u.test(path))throw Error('discovery_provider_path_refused');
    const response=await fetchImpl('https://gmail.googleapis.com/gmail/v1/users/me'+path,{method:'GET',redirect:'error',signal:AbortSignal.timeout(15000),headers:{authorization:'Bearer '+token,accept:'application/json'}});
    if(!response.ok)throw Error('gmail_read_'+response.status);return response.json();
  }
  if(address((await get('/profile')).emailAddress)!==official)throw Error('gmail_mailbox_mismatch');
  return {list:(q,page)=>get('/messages?'+new URLSearchParams({q,maxResults:'20',includeSpamTrash:'false',...(page?{pageToken:page}:{})})),thread:id=>get('/threads/'+encodeURIComponent(id)+'?format=full')};
}
function threadRows(raw,threadId,context,inquiryId,ownerConfirmed=false){
  if(raw.id!==threadId||!Array.isArray(raw.messages)||!raw.messages.length||raw.messages.length>2000)throw Error('discovery_thread_invalid');
  const messages=raw.messages.map(m=>{if(!validGmailId(m.id)||m.threadId!==threadId)throw Error('discovery_message_identity');return {...normalizeMessage(m),labels:m.labelIds||[]};});
  if(new Set(messages.map(m=>m.id)).size!==messages.length)throw Error('discovery_duplicate_message');
  const regular=messages.filter(m=>!m.labels.some(l=>['SPAM','TRASH','DRAFT'].includes(l)));
  if(regular.some(m=>!Number.isFinite(Date.parse(m.occurred_at))))throw Error('discovery_timestamp_invalid');
  const linked=context.authority.links.find(l=>l.gmail_thread_id===threadId);
  const match=matchThread(regular,context.authority);
  const belongs=linked?linked.inquiry_id===inquiryId:ownerConfirmed||match.caseId===inquiryId;
  const fingerprint=hash(messages.map(m=>[m.id,m.thread_id,m.direction,m.from_address,m.to_addresses,m.cc_addresses,m.subject,m.occurred_at,m.attachments.map(a=>[a.part_id,a.original_filename,a.mime_type,a.size])]));
  return messages.map(m=>{
    const excluded=m.labels.some(l=>['SPAM','TRASH','DRAFT'].includes(l));
    const conflict=context.authority.messages.find(i=>i.gmail_message_id===m.id&&(i.inquiry_id!==inquiryId||i.gmail_thread_id!==threadId));
    const status=excluded||linked&&linked.inquiry_id!==inquiryId?'EXCLUDED_WITH_REASON':conflict?'RELATED_CANDIDATE':belongs?'INDEXED':'RELATED_CANDIDATE';
    return {gmail_message_id:m.id,gmail_thread_id:threadId,status,reason:excluded?'non_regular_label':linked&&linked.inquiry_id!==inquiryId?'linked_to_other_case':conflict?'index_attribution_conflict':linked?'approved_thread':ownerConfirmed?'owner_confirmed':match.reason,candidate_case_ids:match.candidates,fingerprint,subject:m.subject,direction:m.direction,occurred_at:m.occurred_at,
      index:status==='INDEXED'?{gmail_message_id:m.id,gmail_thread_id:threadId,inquiry_id:inquiryId,direction:m.direction,message_source:m.direction==='inbound'?'gmail_received':'gmail_direct',from_address:m.from_address,to_addresses:m.to_addresses,cc_addresses:m.cc_addresses,subject:m.subject,sent_at:m.direction==='outbound'?m.occurred_at:null,received_at:m.direction==='inbound'?m.occurred_at:null,attachment_metadata:m.attachments}:null};
  });
}
async function syncDiscovery({inquiryId,actorId,now=new Date()},fetchImpl=fetch,providerFactory=createProvider){
  if(!enabled())throw Error('discovery_disabled');
  const originalFetch=fetchImpl,deadline=Date.now()+40000;
  fetchImpl=(url,options={})=>originalFetch(url,{...options,redirect:'error',signal:AbortSignal.timeout(Math.max(1,Math.min(10000,deadline-Date.now())))});
  if(!isUuid(inquiryId))throw Error('invalid_inquiry');await getInquiry(inquiryId,fetchImpl);
  const context=await rpc('paui041_context',{p_case:inquiryId,p_actor:actorId},fetchImpl),old=context.state||{};
  const cutoff=new Date(Math.floor(now.getTime()/1000)*1000).toISOString();
  const basis=hash(signals(context.authority).map(c=>({...c,addresses:[...c.addresses].sort()}))),full=!old.last_completed_at||!old.last_full_at||now-Date.parse(old.last_full_at)>7*86400000||old.basis!==basis;
  const continuing=!!old.window_end&&!old.complete&&old.basis===basis;
  const state={window_start:continuing?old.window_start:full?null:new Date(Date.parse(old.last_completed_at)-7*86400000).toISOString(),window_end:continuing?old.window_end:cutoff,page_token:continuing?old.page_token||'':'',basis,full:continuing?old.full:full,complete:false,attempted_at:now.toISOString(),last_error:null,recovered_cursor:false};
  state.linked_threads=continuing?old.linked_threads||[]:context.authority.links.filter(l=>l.inquiry_id===inquiryId).map(l=>l.gmail_thread_id);
  state.link_offset=continuing?old.link_offset||0:0;
  const q=buildQuery(context.authority,inquiryId,state.window_start,state.window_end);let rows=[],page;
  state.search_scope='all_regular_received_sent_archived; registered_participants_or_case_identity';
  try{
    const provider=await providerFactory(fetchImpl);
    const linkBatch=state.linked_threads.slice(state.link_offset,state.link_offset+5);
    for(const id of linkBatch){if(Date.now()>=deadline)throw Error('discovery_time_budget');rows.push(...threadRows(await provider.thread(id),id,context,inquiryId));}
    state.link_offset+=linkBatch.length;
    if(state.link_offset>=state.linked_threads.length){
    try{page=await provider.list(q,state.page_token);}catch(error){
      if(state.page_token&&['gmail_read_400','gmail_read_404'].includes(error.message)){state.page_token='';state.recovered_cursor=true;page=await provider.list(q,'');}else throw error;
    }
    if(!Array.isArray(page.messages||[])||page.nextPageToken&&typeof page.nextPageToken!=='string')throw Error('discovery_page_invalid');
    const entries=page.messages||[];
    state.listed_this_page=entries.length;state.result_size_estimate=Number.isSafeInteger(page.resultSizeEstimate)?page.resultSizeEstimate:null;
    if(entries.some(e=>!validGmailId(e.id)||!validGmailId(e.threadId)))throw Error('discovery_page_invalid');
    const threads=[...new Set(entries.map(e=>e.threadId))];
    for(const id of threads){
      if(Date.now()>=deadline)throw Error('discovery_time_budget');
      try{const batch=threadRows(await provider.thread(id),id,context,inquiryId);if(entries.some(e=>e.threadId===id&&!batch.some(r=>r.gmail_message_id===e.id)))throw Error('discovery_list_thread_mismatch');rows.push(...batch);}
      catch(error){for(const entry of entries.filter(e=>e.threadId===id))rows.push({gmail_message_id:entry.id,gmail_thread_id:id,status:'RETRIEVAL_ERROR',reason:'thread_retrieval_failed'});throw error;}
    }
    if(page.nextPageToken&&page.nextPageToken===state.page_token)throw Error('discovery_repeated_cursor');
    state.page_token=page.nextPageToken||'';state.complete=!state.page_token;state.last_error=null;
    }
  }catch(error){state.last_error=/^(gmail_read_\d{3}|discovery_[a-z_]+)$/.test(error.message)?error.message:'retrieval_unavailable';state.complete=false;state.page_token=continuing?old.page_token||'':'';state.link_offset=continuing?old.link_offset||0:0;}
  // Successful rows may be retained after a partial error; the page cursor is
  // never advanced until every listed item has a durable classification.
  const commitFetch=(url,options={})=>originalFetch(url,{...options,redirect:'error',signal:AbortSignal.timeout(10000)});
  const result=await rpc('paui041_commit',{p_case:inquiryId,p_actor:actorId,p_version:old.version||0,p_authority:context.authority,p_state:state,p_rows:rows,p_owner:false},commitFetch);
  return result;
}
async function decideDiscovery({inquiryId,actorId,threadId,fingerprint,decision},fetchImpl=fetch,providerFactory=createProvider){
  if(!enabled()||!isUuid(inquiryId)||!validGmailId(threadId)||!['link','exclude'].includes(decision)||!/^[a-f0-9]{64}$/.test(fingerprint||''))throw Error('invalid_mail_decision');
  await getInquiry(inquiryId,fetchImpl);
  const context=await rpc('paui041_context',{p_case:inquiryId,p_actor:actorId},fetchImpl),provider=await providerFactory(fetchImpl);
  let rows=threadRows(await provider.thread(threadId),threadId,context,inquiryId,decision==='link');
  if(rows.some(r=>r.fingerprint!==fingerprint))throw Error('mail_link_conflict');
  if(decision==='exclude')rows=rows.map(r=>({...r,index:null,status:'EXCLUDED_WITH_REASON',reason:'owner_excluded'}));
  return rpc('paui041_commit',{p_case:inquiryId,p_actor:actorId,p_version:context.state?.version||0,p_authority:context.authority,p_state:null,p_rows:rows,p_owner:true},fetchImpl);
}
module.exports={enabled,signals,matchThread,buildQuery,threadRows,createProvider,syncDiscovery,decideDiscovery};
