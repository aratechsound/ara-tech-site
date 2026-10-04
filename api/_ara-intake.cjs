const {createHash}=require('node:crypto');
const {CASE_TYPES}=require('./_ara-case.cjs');
const {supabaseRequest,sendGmail,OFFICIAL_EMAIL}=require('./_pa-mail.cjs');
const clean=(v,max,required=false)=>{if(typeof v!=='string' || v.length>max || /\u0000/.test(v))throw Error('invalid_input');const s=v.trim().replace(/\r\n?/g,'\n');if(required&&!s)throw Error('invalid_input');return s;};
function policy(){
 if(process.env.ARA_GENERAL_INQUIRY_ENABLED!=='true')throw Error('general_intake_disabled');
 let p;try{p=JSON.parse(process.env.ARA_GENERAL_NOTIFICATION_POLICY||'');}catch{throw Error('CONFIG_REQUIRED');}
 if(p.verified!==true || p.notification_recipient!==OFFICIAL_EMAIL || typeof p.receipt_enabled!=='boolean'
 || (p.receipt_enabled&&(!p.receipt_subject||!p.receipt_body))
 || !['turnstile','fixture'].includes(p.spam_adapter) || (p.spam_adapter==='fixture'&&process.env.ARA_GENERAL_FIXTURE!=='true')
 || (p.spam_adapter==='turnstile'&&(!process.env.ARA_TURNSTILE_SECRET||!p.captcha_site_key||!p.captcha_hostname)))throw Error('CONFIG_REQUIRED');
 return p;
}
function normalize(input){
 if(!input||!CASE_TYPES[input.case_type]||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.submission_key||''))throw Error('invalid_input');
 const fields={case_type:input.case_type,customer_name:clean(input.customer_name,160,true),email:clean(input.email,320,true).toLowerCase(),subject:clean(input.subject,240,true),body:clean(input.body,20000,true)};
 for(const [k,max] of [['organization_name',200],['phone',60],['venue',300],['desired_period',500],['inquiry_category',160]])fields[k]=clean(input[k]||'',max);
 if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fields.email)||/[\r\n]/.test(fields.subject+fields.email+fields.customer_name)||input.website)throw Error('invalid_input');
 return {key:input.submission_key,fields,hash:createHash('sha256').update(JSON.stringify(fields)).digest('hex')};
}
async function accept(input,fetchImpl=fetch){
 const p=policy(),r=normalize(input);
 if(p.spam_adapter==='turnstile'){
  const token=clean(input.captcha_token||'',2048,true);
  const response=await fetchImpl('https://challenges.cloudflare.com/turnstile/v0/siteverify',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({secret:process.env.ARA_TURNSTILE_SECRET,response:token})});
  const proof=await response.json();if(!proof.success||proof.hostname!==p.captcha_hostname||proof.action!=='general-inquiry')throw Error('spam_verification_failed');
 }
 const notifications=[{message_type:'internal_new_inquiry',recipient:p.notification_recipient,subject:'【ARA-TECH】一般お問い合わせ／{number}',body:`一般フォーム受付番号：{number}\n種別：${r.fields.case_type}\n顧客：${r.fields.customer_name}\n顧客email：${r.fields.email}\n件名：${r.fields.subject}\n\n${r.fields.body}`}];
 if(p.receipt_enabled)notifications.push({message_type:'customer_receipt',recipient:r.fields.email,subject:p.receipt_subject,body:p.receipt_body});
 const result=await supabaseRequest('/rest/v1/rpc/ara_register_general',{method:'POST',body:JSON.stringify({p_key:r.key,p_hash:r.hash,p_input:r.fields,p_notifications:notifications})},fetchImpl);
 // Intake is committed already. Queue/provider failures never negate acceptance.
 let notification_status='queued';
 try{
  const rows=await supabaseRequest(`/rest/v1/pa_email_deliveries?inquiry_id=eq.${result.id}&dedupe_key=like.ara-intake:*&select=*&order=requested_at.asc`,{},fetchImpl);
  for(const row of rows){
   const claimed=await supabaseRequest('/rest/v1/rpc/ara_claim_intake_delivery',{method:'POST',body:JSON.stringify({p_id:row.id})},fetchImpl);
   if(!claimed?.[0])continue;
   let update;
   try{await require('./_ara-unlinked-mail.cjs').assertBusinessMailbox(fetchImpl);const sent=await sendGmail({to:row.recipient,subject:row.subject,body:row.body,messageType:row.message_type},fetchImpl);update={status:'sent',sent_at:new Date().toISOString(),gmail_message_id:sent.id,gmail_thread_id:sent.threadId};}
   catch(e){const code=/^gmail_(?:oauth|send)_\d{3}$|^gmail_not_configured$/.test(e.message)?e.message:'provider_result_unknown';update={status:'unknown',error_summary:code};}
   await supabaseRequest(`/rest/v1/pa_email_deliveries?id=eq.${row.id}`,{method:'PATCH',body:JSON.stringify(update)},fetchImpl);
  }
  notification_status='recorded';
 }catch{notification_status='queue_check_required';}
 return {...result,notification_status};
}
module.exports={policy,normalize,accept};
