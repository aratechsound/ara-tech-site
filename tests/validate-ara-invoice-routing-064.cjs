'use strict';
const assert=require('node:assert/strict'),s=require('../api/_pa-case-mail.cjs'),{createHandler}=require('../api/_pa-case-mail-handler.cjs');
const A='11111111-1111-4111-8111-111111111111',U='22222222-2222-4222-8222-222222222222',O='33333333-3333-4333-8333-333333333333';
Object.assign(process.env,{SUPABASE_URL:'https://fixture.invalid',SUPABASE_SERVICE_ROLE_KEY:'fixture-only',GMAIL_CLIENT_ID:'fixture',GMAIL_CLIENT_SECRET:'fixture',GMAIL_REFRESH_TOKEN:'fixture',GMAIL_SENDER_ADDRESS:'aratechsound@gmail.com',GMAIL_REPLY_TO:'aratechsound@gmail.com'});
let writes=0,providerSends=0,prepared=null;
const json=(v,status=200)=>({ok:status<300,status,json:async()=>v});
const f=async(url,opt={})=>{const u=new URL(url),table=u.pathname.split('/').at(-1);
 if(u.hostname==='oauth2.googleapis.com')return json({access_token:'fixture'});
 if(u.hostname==='gmail.googleapis.com'){if(table==='send'){providerSends++;throw Error('must not send');}assert.equal(table,'profile');return json({emailAddress:'aratechsound@gmail.com'});}
 assert.equal(u.hostname,'fixture.invalid');
 if(table==='pa_case_mail_operation_v1'){const p=JSON.parse(opt.body);assert.equal(p.p_action,'prepare');writes++;prepared={operation_id:O,inquiry_id:A,binding:p.p_payload.binding,binding_hash:p.p_payload.binding_hash,state:'PREPARED',expires_at:new Date(Date.now()+300000).toISOString()};return json({ok:true,operation:prepared});}
 assert.equal(opt.method||'GET','GET');if(table==='pa_inquiries')return json([{id:A,inquiry_number:'FIXTURE',email:'customer@example.invalid'}]);
 assert(['pa_inquiry_audit','pa_contracts','pa_billings','pa_change_evidence_events'].includes(table));return json([]);
};
(async()=>{
 const input={inquiry_id:A,kind:'new',purpose:'invoice',to:'customer@example.invalid',cc:[],subject:'Synthetic',body:'Synthetic only',attachments:[]};
 const p=await s.preview(input,U,f);assert.equal(p.purpose,'invoice');assert.equal(p.attachments.length,0);assert.equal(prepared.binding.purpose,undefined,'Entry context must not change the established duplicate-send binding');const count=writes;
 await assert.rejects(s.send({...input,purpose:'general',operation_id:O,confirmation_token:p.confirmation_token,owner_confirmed:true},U,f),/invalid_confirmation/);assert.equal(writes,count);assert.equal(providerSends,0);
 const handler=createHandler({fetchImpl:f,verifyAdmin:async()=>({id:U}),checkRateLimit:async()=>({allowed:true}),applyOriginPolicy:()=>false});
 const res=()=>({statusCode:null,body:null,setHeader(){},status(v){this.statusCode=v;return this;},json(v){this.body=v;return this;}});
 const req={method:'GET',url:'/api/pa-gmail?case_mail=1&action=invoice_history&inquiry_id='+A,headers:{authorization:'Bearer fixture-only'}};
 let r=res();await handler(req,r);assert.equal(r.statusCode,200);assert.equal(r.body.result.read_only,true);assert.deepEqual(r.body.result.records,[]);
 r=res();await handler({...req,headers:{}},r);assert.equal(r.statusCode,403);
 r=res();await handler({...req,method:'POST',url:'/api/pa-gmail?case_mail=1',body:{action:'invoice_history',inquiry_id:A}},r);assert.equal(r.statusCode,403);assert.equal(r.body.code,'invalid_origin');
 r=res();await handler({...req,url:req.url.replace(A,'invalid')},r);assert.equal(r.statusCode,409);assert.equal(r.body.code,'invalid_case_mail');
 assert.equal(writes,count);assert.equal(providerSends,0);console.log(JSON.stringify({status:'PASS',get_only_authenticated_history:true,origin_protected_mutations:true,invoice_entry_confirmation_binding:true,unchanged_operation_content_identity:true,optional_zero_attachments:true,provider_sends:0}));
})().catch(e=>{console.error(e);process.exitCode=1;});
