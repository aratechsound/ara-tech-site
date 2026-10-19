'use strict';
const mail=require('./_pa-mail.cjs'),service=require('./_pa-case-mail.cjs'),security=require('./_request-security.cjs');
const reply=(res,status,value)=>{res.setHeader('Cache-Control','private, no-store, max-age=0');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Content-Type','application/json; charset=utf-8');return res.status(status).json(value);};
function createHandler({fetchImpl=fetch,verifyAdmin=mail.verifyAdmin,checkRateLimit=security.checkRateLimit,applyOriginPolicy=security.applyOriginPolicy}={}){return async(req,res)=>{
 try{
  const route=new URL(req.url,'https://ara-tech.cc');if(route.pathname!=='/api/pa-gmail'||route.searchParams.getAll('case_mail').length!==1||route.searchParams.get('case_mail')!=='1'||route.searchParams.has('workspace_read')||route.searchParams.has('path')||req.method==='POST'&&[...route.searchParams.keys()].some(k=>k!=='case_mail'))throw Error('invalid_case_mail');
  if(!['GET','POST'].includes(req.method))return reply(res,405,{ok:false,code:'method_not_allowed'});
  if(req.method==='POST'&&!applyOriginPolicy(req,res))return reply(res,403,{ok:false,code:'invalid_origin'});
  const match=String(req.headers?.authorization||'').match(/^Bearer ([^\s]+)$/u);if(!match)throw Error('not_authorized');const actor=await verifyAdmin(match[1],fetchImpl);
  let input;
  if(req.method==='GET'){
   const url=new URL(req.url,'https://ara-tech.cc');const allowed=['case_mail','action','inquiry_id','kind','purpose','source_id','thread_id','operation_id'];
   for(const key of url.searchParams.keys())if(!allowed.includes(key)||url.searchParams.getAll(key).length!==1)throw Error('invalid_case_mail');input=Object.fromEntries(url.searchParams);
   if(!['context','status'].includes(input.action))throw Error('invalid_action');
  }else{input=typeof req.body==='object'&&!Buffer.isBuffer(req.body)?req.body:JSON.parse(String(req.body||''));if(!input||Array.isArray(input)||Buffer.byteLength(JSON.stringify(input))>4500000)throw Error('invalid_case_mail');}
  if(!['context','preview','send','status','reconcile'].includes(input.action))throw Error('invalid_action');
  const rate=await checkRateLimit({request:req,policyName:input.action==='send'?'PA_GMAIL_SEND_REPLY':'PA_GMAIL_REPLY_PREVIEW',scope:actor.id,fetchImpl});if(!rate.allowed){res.setHeader('Retry-After',String(Math.max(1,rate.retryAfter)));return reply(res,429,{ok:false,code:'rate_limited'});}
  const result=input.action==='context'?await service.authority(input,fetchImpl):await service[input.action](input,actor.id,fetchImpl);
  return reply(res,200,{ok:true,result});
 }catch(error){const code=String(error?.message||'');const safe=/^(?:invalid_[a-z_]+|case_mail_[a-z_]+|reply_operation_[a-z_]+|invoice_amount_unverified|gmail_mailbox_mismatch|not_authorized|inquiry_not_found)$/u.test(code)?code:'case_mail_unavailable';return reply(res,safe==='not_authorized'?403:safe==='case_mail_unavailable'?503:409,{ok:false,code:safe});}
};}
module.exports={createHandler};
