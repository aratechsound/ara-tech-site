'use strict';
// PAUI-015: same-origin Owner JWT read adapter, derived from accepted R2 binding guards.
// All upstream requests are GET. No privileged credential, rate bucket, sync or business RPC.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
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
function publicKey(){
  const config=fs.readFileSync(path.join(__dirname,'../js/supabase-config.js'),'utf8');
  if(config.match(/SUPABASE_URL\s*=\s*'([^']+)'/)?.[1]!==SUPABASE)throw Error('target_identity_refused');
  return config.match(/SUPABASE_ANON_KEY\s*=\s*'([^']+)'/)?.[1];
}
function createReadHandler({fetchImpl=fetch,key=publicKey(),readMailAttachment}={}){
  if(!key.startsWith('sb_publishable_'))throw Error('public_key_required');
  async function request(url,{token}={}){
    const q=new URL(url);
    if(q.origin!==SUPABASE || !['/auth/v1/user','/rest/v1/','/storage/v1/object/'].some(p=>q.pathname.startsWith(p)) || q.pathname.includes('/rpc/'))throw new ReadError('destination_refused',403);
    const response=await fetchImpl(url,{method:'GET',redirect:'error',signal:AbortSignal.timeout(20000),headers:{apikey:key,authorization:token,accept:'application/json'}});
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
    const versions=cards.length?await allDirect('pa_portal_document_versions',{card_id:`in.(${cards.map(c=>c.id).join(',')})`,archived_at:'is.null',select:'id,card_id,source_type,source_ref,display_filename,mime_type,version_label,contributor_kind,source_created_at,created_at',order:'created_at.desc,id.asc'},token):[];
    const photos=await allDirect('pa_portal_photo_items',{portal_id:'eq.'+portalId,archived_at:'is.null',select:'id,portal_id,source_type,source_ref,display_filename,mime_type,caption,contributor_kind,owner_kind,source_created_at,sort_order,created_at',order:'sort_order.asc,id.asc'},token);
    if(versions.some(v=>!cards.some(c=>c.id===v.card_id))||photos.some(p=>p.portal_id!==portalId))throw new ReadError('case_binding_mismatch',403);
    return {portal_exists:true,cards:cards.map(c=>({...c,versions:versions.filter(v=>v.card_id===c.id)})),photos};
  }
  async function allDirect(table,params,token){
    const result=[];
    for(let offset=0;offset<10000;offset+=500){const batch=await rows(table,{...params,limit:500,offset},token,true);result.push(...batch);if(batch.length<500)return result;}
    throw new ReadError('incomplete_result',503);
  }
  async function asset(id,kind,assetId,token){
    const model=await materials(id,token);assertId(assetId);
    const item=kind==='version'?model.cards.flatMap(c=>c.versions).find(v=>v.id===assetId):kind==='photo'?model.photos.find(v=>v.id===assetId):null;
    if(!item)throw new ReadError('asset_case_mismatch',403);
    // Gmail attachment retrieval requires the existing canonical Provider module and
    // credential/session path; never get a refresh token or use an alternate path here.
    if(['gmail_attachment','pa_attachment'].includes(item.source_type)){
      const ref=item.source_ref||{};
      const original=await mailAttachment(id,ref.gmail_message_id,ref.gmail_attachment_id,token);
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
  const ATTACH_ID=/^[A-Za-z0-9_.-]{1,2048}$/;
  async function mail(id,token){
    await readableCase(id,token);
    const [messages,links]=await Promise.all([
      allRows('pa_gmail_message_index',{inquiry_id:'eq.'+id,select:'*',order:'indexed_at.desc,gmail_message_id.asc'},token),
      allRows('pa_gmail_thread_links',{inquiry_id:'eq.'+id,select:'*'},token)
    ]);
    if(links.some(l=>l.inquiry_id!==id)||messages.some(m=>m.inquiry_id!==id||!MAIL_ID.test(m.gmail_message_id||'')||!links.some(l=>l.gmail_thread_id===m.gmail_thread_id))||new Set(messages.map(m=>m.gmail_message_id)).size!==messages.length)throw new ReadError('mail_binding_mismatch',403);
    return messages.map(m=>Object.fromEntries(['gmail_message_id','gmail_thread_id','inquiry_id','direction','from_address','to_addresses','cc_addresses','subject','sent_at','received_at','indexed_at','message_source','attachment_metadata','body_text','body_html','snippet'].filter(k=>m[k]!==undefined).map(k=>[k,m[k]])));
  }
  async function mailMessage(id,messageId,token){
    if(!MAIL_ID.test(messageId||''))throw new ReadError('invalid_mail_identity',400);
    const messages=await mail(id,token),message=messages.find(m=>m.gmail_message_id===messageId);
    if(!message)throw new ReadError('mail_binding_mismatch',403);
    return message;
  }
  async function mailAttachment(id,messageId,attachmentId,token){
    if(!ATTACH_ID.test(attachmentId||''))throw new ReadError('invalid_attachment_identity',400);
    const message=await mailMessage(id,messageId,token);
    const matches=(Array.isArray(message.attachment_metadata)?message.attachment_metadata:[]).filter(a=>String(a.id||a.gmail_attachment_id||a.part_id||'')===attachmentId);
    if(matches.length!==1)throw new ReadError('attachment_mail_mismatch',403);
    // The canonical module requires a privileged server credential and OAuth POST;
    // the deployed handler also updates a DB rate bucket. None are allowed here.
    if(!readMailAttachment)throw new ReadError('canonical_attachment_path_unavailable',503);
    // Test/dependency adapter is never configured by the live process or HTTP input.
    const item=await readMailAttachment({caseId:id,messageId,attachmentId,metadata:matches[0],token});
    const mime=contentType(matches[0].mime_type),bytes=item.bytes;
    if(!MIME.has(mime))throw new ReadError('preview_type_refused',415);
    if(!Buffer.isBuffer(bytes)||bytes.length>MAX_BYTES)throw new ReadError('file_too_large',413);
    if(contentType(item.mime)!==mime||!validMagic(bytes,mime)||matches[0].size!==undefined&&Number(matches[0].size)!==bytes.length)throw new ReadError('asset_identity_mismatch',409);
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
  return async(req,res)=>{
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
      const token=req.headers.authorization;await admin(token);let result;
        if(u.pathname==='/data/cases'){
          const [cases,progress]=await Promise.all([allRows('pa_inquiries',{select:'*',deleted_at:'is.null',order:'id.asc'},token),allRows('pa_case_progress',{select:'*',order:'inquiry_id.asc'},token)]);
          result={cases,progress};
        }else if(u.pathname==='/data/attention')result=await allRows('pa_case_mail_attention',{select:'*',order:'inquiry_id.asc'},token);
        else if(segments.length===3&&segments[1]==='mail')result=await mail(assertId(segments[2]),token);
        else if(segments.length===4&&segments[1]==='mail-body'){
          const message=await mailMessage(assertId(segments[2]),segments[3],token);
          if(!message.body_text&&!message.body_html&&!message.snippet)throw new ReadError('body_read_path_unavailable',503);
          result={gmail_message_id:message.gmail_message_id,body_text:message.body_text||'',body_html:message.body_html||'',snippet:message.snippet||''};
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
          res.setHeader('Content-Type',item.mime);return res.end(item.bytes);
        }else if(segments.length===4&&segments[1]==='document'){
          const item=await document(assertId(segments[2]),segments[3],token);
          res.setHeader('Content-Type',item.mime);return res.end(item.bytes);
        }else throw new ReadError('route_refused',403);
      return send({ok:true,result});
    }catch(e){const error=e instanceof ReadError?e:new ReadError('read_unavailable',503);return send({ok:false,code:error.code},error.status);}
  };
}
module.exports={createReadHandler,ReadError};
