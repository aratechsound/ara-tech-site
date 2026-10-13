'use strict';
// PAUI-015: same-origin Owner JWT read adapter, derived from accepted R2 binding guards.
// All upstream requests are GET. No privileged credential, rate bucket, sync or business RPC.
const crypto = require('node:crypto');
const {AsyncLocalStorage}=require('node:async_hooks');
const {performance}=require('node:perf_hooks');
const fs = require('node:fs');
const path = require('node:path');
const {resolveRegistered} = require('./_pa-attachment-identity.cjs');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SUPABASE = 'https://kogbnremsouajxxsgxro.supabase.co';

const MAX_BYTES = 20 * 1024 * 1024;
const MIME = new Set(['application/pdf','image/png','image/jpeg','image/webp']);
const BASIC = Object.freeze({
  tokens: ['pa_schedule_tokens','id,issued_at,expires_at,revoked_at,answered_at','issued_at.desc'],
  responses: ['pa_schedule_responses','*',null],
  audit: ['pa_inquiry_audit','occurred_at,action,details','occurred_at.desc'],
  deliveries: ['pa_email_deliveries','id,message_type,subject,status,requested_at,sent_at,failed_at,error_summary,is_retry,attempt_number','requested_at.desc'],
  payments: ['pa_payment_records','*','confirmed_at.desc'],
  links: ['pa_gmail_thread_links','*',null],
  attention: ['pa_case_mail_attention','*',null]
});
class ReadError extends Error {
  constructor(code,status=503){super(code);this.code=code;this.status=status;}
}
function assertId(value){if(!UUID.test(value||''))throw new ReadError('invalid_identity',400);return value;}
function contentType(mime){return String(mime||'').split(';')[0].trim().toLowerCase();}
function validMagic(bytes,mime){
  if(mime==='application/pdf')return bytes.subarray(0,5).toString()==='%PDF-';
  if(mime==='image/png')return bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  if(mime==='image/jpeg')return bytes[0]===255&&bytes[1]===216&&bytes.at(-2)===255&&bytes.at(-1)===217;
  if(mime==='image/webp')return bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP';
  return false;
}
async function boundedBytes(response){
  if(Number(response.headers.get('content-length'))>MAX_BYTES)throw new ReadError('file_too_large',413);
  const reader=response.body.getReader(),parts=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>MAX_BYTES)throw new ReadError('file_too_large',413);parts.push(Buffer.from(value));}}
  finally{await reader.cancel().catch(()=>{});}
  return Buffer.concat(parts);
}
function parsePublicConfig(config){
  // Vercel compiles the included ESM asset to CommonJS and may normalize quote
  // style. The pinned target and public-key requirement remain identical.
  const literal=name=>config.match(new RegExp('\\b'+name+'\\s*=\\s*(["\\\'])([^"\\\']+)\\1'))?.[2];
  if(literal('SUPABASE_URL')!==SUPABASE)throw Error('target_identity_refused');
  const key=literal('SUPABASE_ANON_KEY');
  if(!key?.startsWith('sb_publishable_'))throw Error('public_key_required');
  return key;
}
function publicKey(){
  return parsePublicConfig(fs.readFileSync(path.join(__dirname,'../js/supabase-config.js'),'utf8'));
}
function createReadHandler({fetchImpl=fetch,key=publicKey(),readMailAttachment,provider=require("./_pa-workspace-gmail.cjs")}={}){
  if(!key.startsWith('sb_publishable_'))throw Error('public_key_required');
  const timings=new AsyncLocalStorage();
  function addTime(name,ms){const values=timings.getStore();if(values)values[name]=(values[name]||0)+ms;}
  async function timed(name,fn){const start=performance.now();try{return await fn();}finally{addTime(name,performance.now()-start);}}
  async function request(url,{token}={}){
    const q=new URL(url);
    if(q.origin!==SUPABASE || !['/auth/v1/user','/rest/v1/','/storage/v1/object/'].some(p=>q.pathname.startsWith(p)) || q.pathname.includes('/rpc/'))throw new ReadError('destination_refused',403);
    const response=await timed('supabase',()=>fetchImpl(url,{method:'GET',redirect:'error',signal:AbortSignal.timeout(20000),headers:{apikey:key,authorization:token,accept:'application/json'}}));
    if(!response.ok)throw new ReadError(response.status===403?'acl_denied':response.status===401?'login_required':response.status===404?'not_found':'read_unavailable',[401,403,404].includes(response.status)?response.status:503);
    return response;
  }
  async function admin(token){
    if(!/^Bearer [A-Za-z0-9_.-]{20,8000}$/.test(token||''))throw new ReadError('login_required',401);
    const user=await(await request(SUPABASE+'/auth/v1/user',{token})).json();assertId(user.id);
    let admins;
    try{admins=await rows('work_admins',{user_id:'eq.'+user.id,select:'user_id',limit:2},token);}catch(error){if(error.status===403)throw new ReadError('admin_required',403);throw error;}
    if(admins.length!==1||admins[0].user_id!==user.id)throw new ReadError('admin_required',403);
  }
  async function rows(table,params,token,direct=false){
    const url=new URL(SUPABASE+'/rest/v1/'+table);
    for(const [k,v]of Object.entries(params))if(v!==null&&v!==undefined)url.searchParams.set(k,v);
    const result=await(await request(url.href,{token})).json();
    if(!Array.isArray(result))throw new ReadError('invalid_read_response',503);
    return result;
  }
  async function allRows(table,params,token){
    const result=[];
    for(let offset=0;offset<100000;offset+=500){const batch=await rows(table,{...params,limit:500,offset},token);result.push(...batch);if(batch.length<500)return result;}
    throw new ReadError('incomplete_result',503);
  }
  async function readableCase(id,token){
    const list=await rows('pa_inquiries',{id:'eq.'+assertId(id),select:'id',deleted_at:'is.null',limit:2},token);
    if(list.length!==1||list[0].id!==id)throw new ReadError('case_not_readable',403);
  }
  async function materials(id,token){
    await readableCase(id,token);
    const portal=await rows('pa_portals',{case_id:'eq.'+id,select:'id,case_id',limit:2},token,true);
    if(portal.length>1||portal.some(p=>p.case_id!==id))throw new ReadError('case_binding_mismatch',403);
    if(!portal.length)return {cards:[],photos:[],portal_exists:false};
    const portalId=assertId(portal[0].id);
    const cards=await allDirect('pa_portal_document_cards',{portal_id:'eq.'+portalId,archived_at:'is.null',select:'id,portal_id,category,title,owner_kind,sort_order,current_version_id,created_at',order:'sort_order.asc,id.asc'},token);
    if(cards.some(c=>c.portal_id!==portalId||!UUID.test(c.id)))throw new ReadError('case_binding_mismatch',403);
    const identityFields=',gmail_part_id,canonical_attachment_key,source_content_sha256,source_byte_size';
    const versions=cards.length?await allDirect('pa_portal_document_versions',{card_id:`in.(${cards.map(c=>c.id).join(',')})`,archived_at:'is.null',select:'id,card_id,source_type,source_ref,display_filename,mime_type,version_label,contributor_kind,source_created_at,created_at'+identityFields,order:'created_at.desc,id.asc'},token):[];
    const photos=await allDirect('pa_portal_photo_items',{portal_id:'eq.'+portalId,archived_at:'is.null',select:'id,portal_id,source_type,source_ref,display_filename,mime_type,caption,contributor_kind,owner_kind,source_created_at,sort_order,created_at'+identityFields,order:'sort_order.asc,id.asc'},token);
    if(versions.some(v=>!cards.some(c=>c.id===v.card_id))||photos.some(p=>p.portal_id!==portalId))throw new ReadError('case_binding_mismatch',403);
    return {portal_exists:true,cards:cards.map(c=>({...c,versions:versions.filter(v=>v.card_id===c.id)})),photos};
  }
  async function allDirect(table,params,token){
    const result=[];
    for(let offset=0;offset<10000;offset+=500){const batch=await rows(table,{...params,limit:500,offset},token,true);result.push(...batch);if(batch.length<500)return result;}
    throw new ReadError('incomplete_result',503);
  }
  async function registeredAsset(id,kind,assetId,token){
    assertId(assetId);
    const [,portal]=await Promise.all([readableCase(id,token),rows('pa_portals',{case_id:'eq.'+id,select:'id,case_id',limit:2},token)]);
    if(portal.length!==1||portal[0].case_id!==id)throw new ReadError('asset_case_mismatch',403);
    const portalId=assertId(portal[0].id);
    const fields='id,source_type,source_ref,mime_type,gmail_part_id,canonical_attachment_key,source_content_sha256,source_byte_size';
    let found;
    if(kind==='version'){
      found=await rows('pa_portal_document_versions',{id:'eq.'+assetId,archived_at:'is.null',select:fields+',card_id',limit:2},token);
      if(found.length!==1||found[0].id!==assetId)throw new ReadError('asset_case_mismatch',403);
      const parent=await rows('pa_portal_document_cards',{id:'eq.'+assertId(found[0].card_id),portal_id:'eq.'+portalId,archived_at:'is.null',select:'id,portal_id',limit:2},token);
      if(parent.length!==1||parent[0].id!==found[0].card_id||parent[0].portal_id!==portalId)throw new ReadError('case_binding_mismatch',403);
    }else if(kind==='photo'){
      found=await rows('pa_portal_photo_items',{id:'eq.'+assetId,portal_id:'eq.'+portalId,archived_at:'is.null',select:fields+',portal_id',limit:2},token);
      if(found.length!==1||found[0].id!==assetId||found[0].portal_id!==portalId)throw new ReadError('asset_case_mismatch',403);
    }else throw new ReadError('asset_case_mismatch',403);
    return found[0];
  }
  async function asset(id,kind,assetId,token){
    const item=await timed('material_index',()=>registeredAsset(id,kind,assetId,token));
    // Gmail attachment retrieval requires the existing canonical Provider module and
    // credential/session path; never get a refresh token or use an alternate path here.
    if(['gmail_attachment','pa_attachment'].includes(item.source_type)){
      const ref=item.source_ref||{};
      const message=await mailMessage(id,ref.gmail_message_id,token);
      const raw=await boundProviderMessage(message),cache=new Map();
      const loadCurrent=metadata=>{
        if(!cache.has(metadata))cache.set(metadata,readMailAttachment
          ? readMailAttachment({caseId:id,messageId:ref.gmail_message_id,attachmentId:metadata.id,metadata,token})
          : timed('provider_original',()=>providerRead(()=>provider.attachment({messageId:ref.gmail_message_id,metadata,raw}))));
        return cache.get(metadata).then(file=>validateMailFile(metadata,file));
      };
      const original=await timed('identity_total',()=>providerRead(()=>resolveRegistered({asset:item,messageId:ref.gmail_message_id,measure:addTime,
        attachments:Array.isArray(message.attachment_metadata)?message.attachment_metadata:[],loadCurrent,
        loadHistorical:attachmentId=>timed('provider_original',()=>providerRead(()=>provider.registeredVariant({messageId:ref.gmail_message_id,attachmentId,raw})))})));
      if(original.mime!==contentType(item.mime_type))throw new ReadError('asset_identity_mismatch',409);
      return original;
    }
    if(item.source_type!=='portal_upload')throw new ReadError('canonical_attachment_path_unavailable',503);
    const ref=item.source_ref||{},parts=String(ref.storage_path||'').split('/');
    if(parts.length!==4||parts[0]!=='cases'||parts[1]!==id||!UUID.test(parts[2])||!/^[a-f0-9]{64}$/i.test(parts[3])||parts[3]!==ref.sha256)throw new ReadError('asset_identity_mismatch',403);
    const mime=contentType(item.mime_type);if(!MIME.has(mime))throw new ReadError('preview_type_refused',415);
    // Same private bucket/path as _pa-portal.cjs. Owner JWT/RLS only: no public URL,
    // signed URL issuance, service role, or fallback after an ACL denial.
    const response=await request(SUPABASE+'/storage/v1/object/pa-portal-assets/'+parts.map(encodeURIComponent).join('/'),{token});
    const bytes=await boundedBytes(response);
    if(!validMagic(bytes,mime)||crypto.createHash('sha256').update(bytes).digest('hex')!==ref.sha256||ref.size!==undefined&&Number(ref.size)!==bytes.length)throw new ReadError('asset_identity_mismatch',409);
    return {bytes,mime};
  }
  const MAIL_ID=/^[A-Za-z0-9_-]{1,256}$/;
  const ATTACH_ID=/^[^\s\u0000-\u001f\\/]{1,1000}$/;
  async function mail(id,token){
    await readableCase(id,token);
    const [messages,links]=await Promise.all([
      allRows('pa_gmail_message_index',{inquiry_id:'eq.'+id,select:'*',order:'indexed_at.desc,gmail_message_id.asc'},token),
      allRows('pa_gmail_thread_links',{inquiry_id:'eq.'+id,select:'*'},token)
    ]);
    if(links.some(l=>l.inquiry_id!==id)||messages.some(m=>m.inquiry_id!==id||!MAIL_ID.test(m.gmail_message_id||'')||!links.some(l=>l.gmail_thread_id===m.gmail_thread_id))||new Set(messages.map(m=>m.gmail_message_id)).size!==messages.length)throw new ReadError('mail_binding_mismatch',403);
    messages.sort((a,b)=>mailTime(b)-mailTime(a)||a.gmail_message_id.localeCompare(b.gmail_message_id));
    return messages.map(m=>Object.fromEntries(['gmail_message_id','gmail_thread_id','inquiry_id','direction','from_address','to_addresses','cc_addresses','subject','sent_at','received_at','indexed_at','message_source','attachment_metadata','body_text','body_html','snippet'].filter(k=>m[k]!==undefined).map(k=>[k,m[k]])));
  }
  // PAUI-030: explicit read-through of approved links, never discovery or indexing.
  const mailTime=m=>{const value=Date.parse(m.received_at||m.sent_at||'');return Number.isFinite(value)?value:0;};
  async function approvedThread(id,threadId,token){
    if(!MAIL_ID.test(threadId||''))throw new ReadError('invalid_mail_identity',400);
    await readableCase(id,token);
    const owners=await allRows('pa_gmail_thread_links',{gmail_thread_id:'eq.'+threadId,select:'inquiry_id,gmail_thread_id'},token);
    if(!owners.length||owners.some(l=>l.inquiry_id!==id||l.gmail_thread_id!==threadId))throw new ReadError('mail_binding_mismatch',403);
  }
  async function liveMessage(id,threadId,messageId,token){
    if(!MAIL_ID.test(messageId||''))throw new ReadError('invalid_mail_identity',400);
    await approvedThread(id,threadId,token);
    const indexes=await rows('pa_gmail_message_index',{gmail_message_id:'eq.'+messageId,select:'inquiry_id,gmail_thread_id,gmail_message_id',limit:2},token);
    if(indexes.length>1||indexes.some(m=>m.inquiry_id!==id||m.gmail_thread_id!==threadId||m.gmail_message_id!==messageId))throw new ReadError('mail_binding_mismatch',403);
    const raw=await boundProviderMessage({gmail_message_id:messageId,gmail_thread_id:threadId});
    return {raw,fresh:provider.normalize(raw)};
  }
  async function liveMail(id,token){
    const saved=await mail(id,token);
    const links=await allRows('pa_gmail_thread_links',{inquiry_id:'eq.'+id,select:'inquiry_id,gmail_thread_id'},token);
    if(links.some(l=>l.inquiry_id!==id||!MAIL_ID.test(l.gmail_thread_id||'')))throw new ReadError('mail_binding_mismatch',403);
    const threads=[...new Set(links.map(l=>l.gmail_thread_id))],messages=[],checks=[];
    if(threads.length>30)throw new ReadError('incomplete_result',503);
    let total=0;
    for(const threadId of threads){
      try{
        await approvedThread(id,threadId,token);
        const thread=await timed('provider_thread',()=>providerRead(()=>provider.thread(threadId)));
        if(thread.id!==threadId||!Array.isArray(thread.messages)||thread.messages.some(m=>m.threadId!==threadId||!MAIL_ID.test(m.id||''))||new Set(thread.messages.map(m=>m.id)).size!==thread.messages.length)throw new ReadError('mail_binding_mismatch',403);
        total+=thread.messages.length;if(total>500)throw new ReadError('incomplete_result',503);
        const indexes=thread.messages.length?await allRows('pa_gmail_message_index',{gmail_message_id:'in.('+thread.messages.map(m=>m.id).join(',')+')',select:'inquiry_id,gmail_thread_id,gmail_message_id'},token):[];
        if(indexes.some(m=>m.inquiry_id!==id||m.gmail_thread_id!==threadId||!thread.messages.some(r=>r.id===m.gmail_message_id))||new Set(indexes.map(m=>m.gmail_message_id)).size!==indexes.length)throw new ReadError('mail_binding_mismatch',403);
        const fresh=thread.messages.map(raw=>{
          const m=provider.normalize(raw),old=saved.find(r=>r.gmail_message_id===raw.id),indexed=indexes.some(r=>r.gmail_message_id===raw.id);
          return {gmail_message_id:raw.id,gmail_thread_id:threadId,inquiry_id:id,direction:m.direction,from_address:m.from_address,to_addresses:m.to_addresses,cc_addresses:m.cc_addresses,subject:m.subject,
            received_at:m.direction==='inbound'?m.occurred_at:null,sent_at:m.direction==='outbound'?m.occurred_at:null,indexed_at:old?.indexed_at||null,
            attachment_metadata:m.attachments.map(a=>({...a,id:a.part_id||a.id})),snippet:raw.snippet||'',read_route:'live',index_state:indexed?'indexed':'not_indexed',provider_checked:true};
        });
        messages.push(...fresh);checks.push({gmail_thread_id:threadId,status:fresh.some(m=>m.index_state==='not_indexed')?'index_gap':'current',provider_count:fresh.length,indexed_count:indexes.length});
      }catch(e){if(!(e instanceof ReadError))throw e;checks.push({gmail_thread_id:threadId,status:'unknown',code:e.code});}
    }
    // Retain saved rows from failed threads; never present partial reads as empty/latest.
    const ids=new Set(messages.map(m=>m.gmail_message_id));messages.push(...saved.filter(m=>!ids.has(m.gmail_message_id)));
    messages.sort((a,b)=>mailTime(b)-mailTime(a)||a.gmail_message_id.localeCompare(b.gmail_message_id));
    return {messages,checks,checked_at:new Date().toISOString(),status:!threads.length?'no_thread_links':checks.some(c=>c.status==='unknown')?'partial_unknown':checks.some(c=>c.status==='index_gap')?'index_gap':'linked_threads_current',unlinked_status:'not_checked',writes:false};
  }
  async function mailMessage(id,messageId,token){
    if(!MAIL_ID.test(messageId||''))throw new ReadError('invalid_mail_identity',400);
    return timed('mail_index',async()=>{
    // Query the exact message, retaining uniqueness across all Owner-visible
    // index rows. No cross-request metadata or authorization cache.
    const [,indexes]=await Promise.all([readableCase(id,token),rows('pa_gmail_message_index',{gmail_message_id:'eq.'+messageId,select:'*',limit:2},token)]);
    if(indexes.length!==1||indexes[0].gmail_message_id!==messageId||indexes[0].inquiry_id!==id||!MAIL_ID.test(indexes[0].gmail_thread_id||''))throw new ReadError('mail_binding_mismatch',403);
    const message=indexes[0];
    const owners=await allRows('pa_gmail_thread_links',{gmail_thread_id:'eq.'+message.gmail_thread_id,select:'inquiry_id,gmail_thread_id'},token);
    if(!owners.length||owners.some(l=>l.inquiry_id!==id||l.gmail_thread_id!==message.gmail_thread_id))throw new ReadError('mail_binding_mismatch',403);
    return message;
    });
  }
  async function providerRead(fn){
    try{return await fn();}catch(e){
      if(e instanceof ReadError)throw e;
      const code=String(e.message||'');
      if(['mail_binding_mismatch','attachment_mail_mismatch'].includes(code))throw new ReadError(code,403);
      if(code==='asset_identity_mismatch')throw new ReadError(code,409);
      if(code==='attachment_identity_ambiguous')throw new ReadError(code,409);
      if(code==='attachment_identity_unavailable')throw new ReadError(code,503);
      if(code==='gmail_read_404')throw new ReadError('not_found',404);
      if(code==='gmail_read_403')throw new ReadError('provider_read_denied',403);
      throw new ReadError(code==='gmail_not_configured'?'gmail_not_configured':'provider_read_failed',503);
    }
  }
  async function boundProviderMessage(message){
    const raw=await timed('provider_message',()=>providerRead(()=>provider.message(message.gmail_message_id)));
    if(raw.id!==message.gmail_message_id||raw.threadId!==message.gmail_thread_id)throw new ReadError('mail_binding_mismatch',403);
    return raw;
  }
  async function sentEstimates(id,token){
    await readableCase(id,token);
    const links=await allRows('pa_gmail_thread_links',{inquiry_id:'eq.'+id,select:'*'},token);
    if(links.some(l=>l.inquiry_id!==id||!MAIL_ID.test(l.gmail_thread_id||'')))throw new ReadError('mail_binding_mismatch',403);
    const threads=[...new Set(links.map(l=>l.gmail_thread_id))],messages=[],unknown=[];
    if(threads.length>30)throw new ReadError('incomplete_result',503);
    for(const threadId of threads){
      // Check all ownership rows with the same Owner JWT, before Provider reads.
      const owners=await allRows('pa_gmail_thread_links',{gmail_thread_id:'eq.'+threadId,select:'inquiry_id,gmail_thread_id'},token);
      if(!owners.length||owners.some(l=>l.inquiry_id!==id||l.gmail_thread_id!==threadId)){unknown.push({gmail_thread_id:threadId,code:'ambiguous_thread_binding'});continue;}
      const thread=await timed('provider_thread',()=>providerRead(()=>provider.thread(threadId)));
      if(thread.id!==threadId||!Array.isArray(thread.messages)||thread.messages.length>500)throw new ReadError('mail_binding_mismatch',403);
      for(const raw of thread.messages){
        if(raw.threadId!==threadId||!MAIL_ID.test(raw.id||''))throw new ReadError('mail_binding_mismatch',403);
        if(!raw.labelIds?.includes('SENT'))continue;
        const m=provider.normalize(raw);
        if(m.direction!=='outbound')continue;
        // Gmail attachment resource tokens can change between threads.get and
        // messages.get. A MIME part ID is stable inside the exact bound message.
        const pdfs=m.attachments.filter(a=>a.mime_type==='application/pdf'&&/\u898b\u7a4d|estimate|quotation|quote/iu.test(a.original_filename||a.filename||''))
          .map(a=>({...a,id:a.part_id||a.id}));
        if(!pdfs.length)continue;
        const indexed=await allRows('pa_gmail_message_index',{gmail_message_id:'eq.'+raw.id,select:'inquiry_id,gmail_thread_id,gmail_message_id'},token);
        if(indexed.length>1||indexed.some(r=>r.inquiry_id!==id||r.gmail_thread_id!==threadId)){unknown.push({gmail_thread_id:threadId,code:'mail_index_conflict'});continue;}
        messages.push({gmail_message_id:raw.id,gmail_thread_id:threadId,inquiry_id:id,direction:'outbound',subject:m.subject,sent_at:m.occurred_at,to_addresses:m.to_addresses,attachment_metadata:pdfs,history_only:true,validity:'unknown',registration:'unverified'});
      }
    }
    if(new Set(messages.map(m=>m.gmail_message_id)).size!==messages.length)throw new ReadError('mail_binding_mismatch',403);
    return {messages,unknown,history_only:true};
  }
  async function mailAttachment(id,messageId,attachmentId,token){
    if(!ATTACH_ID.test(attachmentId||''))throw new ReadError('invalid_attachment_identity',400);
    const message=await mailMessage(id,messageId,token);
    const matches=(Array.isArray(message.attachment_metadata)?message.attachment_metadata:[]).filter(a=>String(a.id||a.gmail_attachment_id||a.part_id||'')===attachmentId);
    if(matches.length!==1)throw new ReadError('attachment_mail_mismatch',403);
    let item;
    if(readMailAttachment)item=await timed('provider_original',()=>readMailAttachment({caseId:id,messageId,attachmentId,metadata:matches[0],token}));
    else {const raw=await boundProviderMessage(message);item=await timed('provider_original',()=>providerRead(()=>provider.attachment({messageId,metadata:matches[0],raw})));}
    return validateMailFile(matches[0],item);
  }
  function validateMailFile(metadata,item){
    const mime=contentType(metadata.mime_type),bytes=item.bytes;
    if(!MIME.has(mime))throw new ReadError('preview_type_refused',415);
    if(!Buffer.isBuffer(bytes)||bytes.length>MAX_BYTES)throw new ReadError('file_too_large',413);
    if(contentType(item.mime)!==mime||!validMagic(bytes,mime)||metadata.size!==undefined&&Number(metadata.size)!==bytes.length)throw new ReadError('asset_identity_mismatch',409);
    return {bytes,mime};
  }
  async function commercial(id,token){
    await readableCase(id,token);
    const read=(table,select,order)=>allRows(table,{inquiry_id:'eq.'+id,select,order},token);
    const [estimates,documents,offers,billings]=await Promise.all([
      read('pa_estimate_revisions','id,inquiry_id,revision_number,issued_at,amount_minor,currency,document_id','issued_at.desc,id.asc'),
      read('pa_commercial_documents','id,inquiry_id,original_filename,mime_type,sha256,created_at','created_at.desc,id.asc'),
      read('pa_contract_offers','id,inquiry_id,version,issued_at,expires_at','version.desc,id.asc'),
      read('pa_billings','id,inquiry_id,invoice_policy,invoice_delivery_state,due_date,customer_planned_payment_on,created_at','created_at.desc,id.asc')
    ]);
    if([...estimates,...documents,...offers,...billings].some(r=>r.inquiry_id!==id))throw new ReadError('case_binding_mismatch',403);
    // Metadata projection only. No inferred contract state or delivery authority.
    return {estimates,documents,offers,billings,read_projection:true};
  }
  async function document(id,documentId,token){
    await readableCase(id,token);assertId(documentId);
    const found=await rows('pa_commercial_documents',{id:'eq.'+documentId,inquiry_id:'eq.'+id,select:'id,inquiry_id,mime_type,content,sha256',limit:2},token);
    if(found.length!==1||found[0].id!==documentId||found[0].inquiry_id!==id)throw new ReadError('asset_case_mismatch',403);
    const item=found[0],mime=contentType(item.mime_type);
    if(!MIME.has(mime))throw new ReadError('preview_type_refused',415);
    if(typeof item.content!=='string'||!/^\\x(?:[a-f0-9]{2})+$/i.test(item.content)||item.content.length>MAX_BYTES*2+2)throw new ReadError('asset_identity_mismatch',409);
    const bytes=Buffer.from(item.content.slice(2),'hex');
    if(!validMagic(bytes,mime)||crypto.createHash('sha256').update(bytes).digest('hex')!==item.sha256)throw new ReadError('asset_identity_mismatch',409);
    return {bytes,mime};
  }
  return async(req,res)=>timings.run(Object.create(null),async()=>{
    const start=performance.now(),end=res.end.bind(res);
    res.end=body=>{addTime('api_total',performance.now()-start);const values=timings.getStore();res.setHeader('Server-Timing',Object.entries(values).map(([name,ms])=>name+';dur='+ms.toFixed(2)).join(', '));return end(body);};
    res.setHeader('Cache-Control','private, no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    const send=(value,status=200)=>{res.statusCode=status;res.setHeader('Content-Type','application/json; charset=utf-8');return res.end(JSON.stringify(value));};
    try{
      if(req.method!=='GET')throw new ReadError('read_only',405);
      const q=new URL(req.url,'https://ara-tech.cc');
      if([...q.searchParams.keys()].some(k=>k!=='path')||q.searchParams.getAll('path').length!==1)throw new ReadError('query_refused',400);
      const route=q.searchParams.get('path');
      if(!route?.startsWith('/data/')||route.includes('?')||route.includes('#'))throw new ReadError('route_refused',403);
      const u={pathname:route},segments=route.split('/').filter(Boolean).map(decodeURIComponent);
      if(req.headers['sec-fetch-site']==='cross-site')throw new ReadError('origin_refused',403);
      if(req.headers.origin&&req.headers.origin!=='https://'+req.headers.host)throw new ReadError('origin_refused',403);
      const token=req.headers.authorization;await timed('auth',()=>admin(token));let result;
        if(u.pathname==='/data/cases'){
          const [cases,progress]=await Promise.all([allRows('pa_inquiries',{select:'*',deleted_at:'is.null',order:'id.asc'},token),allRows('pa_case_progress',{select:'*',order:'inquiry_id.asc'},token)]);
          result={cases,progress};
        }else if(u.pathname==='/data/attention')result=await allRows('pa_case_mail_attention',{select:'*',order:'inquiry_id.asc'},token);
        else if(segments.length===3&&segments[1]==='mail')result=await mail(assertId(segments[2]),token);
        else if(segments.length===3&&segments[1]==='mail-live')result=await liveMail(assertId(segments[2]),token);
        else if(segments.length===5&&segments[1]==='mail-live-body'){
          const {fresh}=await liveMessage(assertId(segments[2]),segments[3],segments[4],token);
          result={gmail_message_id:segments[4],inquiry_id:segments[2],body_text:fresh.body_text,body_html:fresh.body_html,body_state:fresh.body_text||fresh.body_html?'ready':'empty',source:'gmail'};
        }
        else if(segments.length===6&&segments[1]==='mail-live-attachment'){
          if(!ATTACH_ID.test(segments[5]||''))throw new ReadError('invalid_attachment_identity',400);
          const {raw,fresh}=await liveMessage(assertId(segments[2]),segments[3],segments[4],token);
          const matches=fresh.attachments.filter(a=>(a.part_id||a.id)===segments[5]);
          if(matches.length!==1)throw new ReadError('attachment_mail_mismatch',403);
          const item=validateMailFile(matches[0],await providerRead(()=>provider.attachment({messageId:segments[4],metadata:matches[0],raw})));
          res.setHeader('Content-Type',item.mime);return res.end(item.bytes);
        }
        else if(segments.length===4&&segments[1]==='mail-body'){
          const message=await mailMessage(assertId(segments[2]),segments[3],token);
          if(message.body_text||message.body_html){
            result={gmail_message_id:message.gmail_message_id,body_text:message.body_text||'',body_html:message.body_html||'',body_state:message.body_text||message.body_html?'ready':'empty',source:'saved'};
          }else{
            const fresh=provider.normalize(await boundProviderMessage(message));
            result={gmail_message_id:message.gmail_message_id,body_text:fresh.body_text,body_html:fresh.body_html,body_state:fresh.body_text||fresh.body_html?'ready':'empty',source:'gmail'};
          }
        }
        else if(segments.length===3&&segments[1]==='sent-estimates')result=await sentEstimates(assertId(segments[2]),token);
        else if(segments.length===5&&segments[1]==='sent-estimate-attachment'){
          const id=assertId(segments[2]);
          if(!MAIL_ID.test(segments[3])||!ATTACH_ID.test(segments[4]))throw new ReadError('invalid_attachment_identity',400);
          const history=await sentEstimates(id,token),message=history.messages.find(m=>m.gmail_message_id===segments[3]);
          const matches=message?.attachment_metadata.filter(a=>a.id===segments[4])||[];
          if(matches.length!==1)throw new ReadError('attachment_mail_mismatch',403);
          const raw=await boundProviderMessage(message);
          if(!raw.labelIds?.includes('SENT'))throw new ReadError('mail_binding_mismatch',403);
          const item=await timed('provider_original',()=>providerRead(()=>provider.attachment({messageId:message.gmail_message_id,metadata:matches[0],raw})));
          if(!Buffer.isBuffer(item.bytes)||item.bytes.length>MAX_BYTES||item.mime!=='application/pdf'||!validMagic(item.bytes,item.mime)||item.bytes.length!==Number(matches[0].size))throw new ReadError('asset_identity_mismatch',409);
          res.setHeader('Content-Type',item.mime);return res.end(item.bytes);
        }
        else if(segments.length===5&&segments[1]==='mail-attachment'){
          const item=await mailAttachment(assertId(segments[2]),segments[3],segments[4],token);
          res.setHeader('Content-Type',item.mime);return res.end(item.bytes);
        }
        else if(segments.length===4&&segments[1]==='case'&&BASIC[segments[3]]){
          const id=assertId(segments[2]),[table,select,order]=BASIC[segments[3]];
          await readableCase(id,token);result=await allRows(table,{select,inquiry_id:'eq.'+id,order},token);
        }else if(segments.length===3&&segments[1]==='commercial'){result=await commercial(assertId(segments[2]),token);
        }else if(segments.length===3&&segments[1]==='materials')result=await materials(assertId(segments[2]),token);
        else if(segments.length===5&&segments[1]==='material'){
          const item=await asset(assertId(segments[2]),segments[3],segments[4],token);
          if(item.identityProof)res.setHeader('X-PA-Attachment-Identity',JSON.stringify(item.identityProof));
          res.setHeader('Content-Type',item.mime);return res.end(item.bytes);
        }else if(segments.length===4&&segments[1]==='document'){
          const item=await document(assertId(segments[2]),segments[3],token);
          res.setHeader('Content-Type',item.mime);return res.end(item.bytes);
        }else throw new ReadError('route_refused',403);
      return send({ok:true,result});
    }catch(e){const error=e instanceof ReadError?e:new ReadError('read_unavailable',503);return send({ok:false,code:error.code},error.status);}
  });
}
module.exports={createReadHandler,ReadError,publicKey,parsePublicConfig};
