'use strict';
const assert=require('node:assert/strict'),{createService}=require('../api/_pa-commercial.cjs');
Object.assign(process.env,{SUPABASE_URL:'https://fixture.invalid',SUPABASE_SERVICE_ROLE_KEY:'fixture-only'});
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';let mode='empty',tables=[];
const service=createService({fetchImpl:async(url,opt={})=>{const u=new URL(url),table=u.pathname.split('/').at(-1);assert.equal(opt.method||'GET','GET');tables.push(table);let body;
 if(table==='pa_inquiries')body=[{id:A,email:'customer@example.invalid'}];
 else{assert.equal(table,'pa_billings');assert.equal(u.searchParams.get('inquiry_id'),'eq.'+A);if(mode==='fail')return {ok:false,status:503,json:async()=>({})};body=mode==='foreign'?[{id:B,inquiry_id:B}]:mode==='present'?[{id:B,inquiry_id:A,invoice_policy:'separate_invoice',invoice_delivery_state:'not_sent'}]:[];}
 return {ok:true,status:200,json:async()=>body};}});
(async()=>{let r=await service.billingIndex(A);assert.deepEqual(r,{case_id:A,billings:[],read_projection:true});assert.deepEqual(tables,['pa_inquiries','pa_billings']);mode='present';r=await service.billingIndex(A);assert.equal(r.billings.length,1);mode='foreign';await assert.rejects(service.billingIndex(A),/document_identity_mismatch/);mode='fail';await assert.rejects(service.billingIndex(A),/service_unavailable/);console.log(JSON.stringify({status:'PASS',zero_records_confirmed:true,independent_of_other_commercial_tables:true,error_not_unbilled:true,case_binding:true,writes:0}));})().catch(e=>{console.error(e);process.exitCode=1;});
