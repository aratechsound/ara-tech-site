const {createService,SAFE}=require('./_pa-contract.cjs');
const {verifyAdmin}=require('./_pa-mail.cjs');
const {streamAttachmentResponse}=require('./_pa-gmail.cjs');
const {applyOriginPolicy,checkRateLimit}=require('./_request-security.cjs');
const PUBLIC={view:['action','token'],quote:['action','token'],accept:['action','token','offer_id','snapshot_sha256','confirmer_name','agree']};
const ADMIN=new Set(['list','inspect_quote','issue','receipt','mail_preview','send','mark_uncertain']);
const headers=res=>{
 for(const [k,v] of Object.entries({'Cache-Control':'private, no-store, max-age=0','X-Robots-Tag':'noindex, nofollow, noarchive, nosnippet','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'}))res.setHeader(k,v);
};
function createHandler({service=createService(),admin=verifyAdmin,rate=checkRateLimit}={}){
 return async(req,res)=>{
  headers(res);const json=(status,data)=>res.status(status).json(data);
  if(req.method!=='POST'){res.setHeader('Allow','POST');return json(405,{ok:false,code:'method_not_allowed'});}
  if(!applyOriginPolicy(req,res))return json(403,{ok:false,code:'invalid_origin'});
  try{
   let input;try{input=typeof req.body==='object'&&!Buffer.isBuffer(req.body)?req.body:JSON.parse(String(req.body||''));}catch{throw Error('invalid_contract');}
   if(!input||Array.isArray(input)||Buffer.byteLength(JSON.stringify(input))>40000)throw Error('invalid_contract');
   let actor;const isPublic=Object.hasOwn(PUBLIC,input.action);
   if(isPublic){if(Object.keys(input).some(k=>!PUBLIC[input.action].includes(k)))throw Error('invalid_contract');}
   else{
    if(!ADMIN.has(input.action))throw Error('invalid_contract');
    const token=String(req.headers?.authorization||'').match(/^Bearer (\S+)$/)?.[1];
    actor=await admin(token);
   }
   const limit=await rate({request:req,policyName:isPublic?'PA_CONTRACT_PUBLIC':'PA_CONTRACT_ADMIN',scope:actor?.id});
   if(!limit.allowed){res.setHeader('Retry-After',String(limit.retryAfter||60));return json(429,{ok:false,code:'rate_limited'});}
   let result;
   switch(input.action){
    case 'view':result=await service.view(input.token);break;
    case 'quote':return streamAttachmentResponse(res,await service.customerQuote(input.token));
    case 'accept':result=await service.accept(input);break;
    case 'list':result=await service.offers(input.case_id);break;
    case 'inspect_quote':{const q=await service.quoteSource(input.case_id,input.gmail_message_id,input.gmail_attachment_id);result={identity:q.identity};break;}
    case 'issue':result=await service.issue(input,actor);break;
    case 'receipt':return streamAttachmentResponse(res,await service.ensureReceipt(input.case_id,input.contract_id));
    case 'mail_preview':result=await service.mailPreview(input,actor);break;
    case 'send':result=await service.send(input,actor);break;
    case 'mark_uncertain':result=await service.markUncertain(input,actor);break;
   }
   return json(200,{ok:true,result});
  }catch(e){
   const code=String(e?.message||'');
   const allowed=SAFE.has(code)||['invalid_pdf','unsafe_pdf','quote_missing','receipt_identity_mismatch','recipient_changed','receipt_too_large'].includes(code);
   return json(code==='not_authorized'?401:allowed?400:503,{ok:false,code:allowed?code:'service_unavailable'});
  }
 };
}
module.exports=createHandler();module.exports.createHandler=createHandler;
