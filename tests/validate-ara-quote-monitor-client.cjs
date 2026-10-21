'use strict';
const assert=require('node:assert/strict');
async function main(){
 const {createQuoteMonitor}=await import('../pa-ui/js/quote-monitor.mjs'),{resolveMonitoredOrderDocuments}=await import('../pa-ui/js/order-document-model.mjs');
 let session={access_token:'fixture-token',user:{id:'owner-a'}},active=0,maximum=0,probes=0,block=null,fail=null,foreign=false;
 const states=new Map(),calls=[],updates=[];const cases=Array.from({length:106},(_,i)=>({id:'case-'+i,monitorActive:i!==0}));
 const record=id=>states.get(id)||{case_id:id,eligible:true,state:'incomplete',label:'確認未完了',needs_check:true,candidates:[],scan:null};
 const request=async(url,options)=>{
  const b=JSON.parse(options.body);calls.push({url,...b});
  if(b.action==='case_discovery_sync'){++probes;return {ok:true,status:200,json:async()=>({ok:true,result:{complete:true,has_more:false}})};}
  if(b.action==='quote_monitor_check'){
   ++active;maximum=Math.max(maximum,active);try{if(block)await block;await new Promise(r=>setTimeout(r,5));if(fail)return {ok:false,status:fail===429?429:503,json:async()=>({ok:false,code:fail===429?'rate_limited':'quote_monitor_storage_unavailable'})};
    const v={case_id:foreign?'foreign-case':b.case_id,eligible:true,state:'checked',label:'',needs_check:false,candidates:[],scan:{state:'ready',started_at:new Date().toISOString()}};states.set(b.case_id,v);return {ok:true,status:200,json:async()=>({ok:true,result:v})};
   }finally{--active;}
  }
  const result=b.action==='quote_monitor_list'?{cases:b.case_ids.map(record)}:record(b.case_id);return {ok:true,status:200,json:async()=>({ok:true,result})};
 };
 const monitor=createQuoteMonitor({getSession:async()=>session,fetchImpl:request,read:async()=>({enabled:true,complete:false}),onUpdate:(id,v)=>updates.push({id,v})});
 await monitor.start(cases);assert.equal(monitor.stats().automatic,0);assert.equal(monitor.stats().tracked,100);assert(calls.filter(c=>c.action==='quote_monitor_list').every(c=>c.case_ids.length<=20));assert.equal(probes,0);assert(!calls.some(c=>c.action==='quote_monitor_check'),'Passive list never inspects');
 const before=calls.filter(c=>c.action==='quote_monitor_check').length;await Promise.all([monitor.ensure('same-case'),monitor.ensure('other-case')]);assert.equal(calls.filter(c=>c.action==='quote_monitor_check').length,before,'Passive ensure never inspects stale saved results');
 await Promise.all([monitor.check('same-case'),monitor.check('same-case'),monitor.check('other-case')]);assert.equal(calls.filter(c=>c.action==='quote_monitor_check').length-before,2);assert.equal(maximum,1,'Explicit inspections retain one lane and same-case dedup');
 await assert.rejects(monitor.check('same-case',{force:true}),/quote_monitor_cooldown/);
 const count=calls.length;await monitor.ensure('same-case');assert.equal(calls.length,count,'An already-ready selected case reuses memory and persistent result');
 let release;block=new Promise(r=>{release=r;});const pending=monitor.check('late-case');await new Promise(r=>setTimeout(r,10));const updatesBefore=updates.length;monitor.clear();release();await assert.rejects(pending,/case_changed/);assert.equal(updates.length,updatesBefore);assert.equal(monitor.get('late-case'),null);block=null;
 fail=429;await monitor.start(cases.slice(0,8));assert.equal(monitor.stats().automatic,0);const failuresBefore=calls.length;await assert.rejects(monitor.check('case-5'),/rate_limited/);assert.equal(calls.length,failuresBefore+1,'Explicit failure is not retried');assert.equal(monitor.get('case-5').state,'incomplete');fail=null;
 foreign=true;await assert.rejects(monitor.check('identity-case'),/case_changed/);assert(!monitor.get('foreign-case'));foreign=false;
 const old=session;session={access_token:'different',user:{id:'owner-b'}};await assert.rejects(monitor.read('case-1'),/case_changed/);assert.equal(monitor.get('case-1'),null);session=old;
 monitor.clear();session=null;await assert.rejects(monitor.read('case-1'),/case_changed/);session=old;
 const e={case_id:'a',contract_id:'c',quote:{sha256:'a'.repeat(64)},approval:{source:'gmail'}},adopted={id:'adopted-2',contract_id:'c',evidence:e};
 const baseline={case_id:'a',contracts:[{id:'c',confirmed_at:'2026-09-01'}],current_agreement:adopted,history:[adopted]};let reads=0;
 const authority=await resolveMonitoredOrderDocuments(async(action,input)=>{++reads;assert.equal(action,'change_evidence_candidates');assert.equal(input,undefined);return baseline;},'a');assert.equal(authority.event_id,'adopted-2');assert.equal(reads,1,'Initial adopted authority needs neither discovery nor original PDF acquisition');
 await assert.rejects(resolveMonitoredOrderDocuments(async()=>baseline,'b'),/change_evidence_mismatch/);
 // Bounded automatic continuation is distinct from retries on failures.
 let pages=0,discoveries=0;const partial=createQuoteMonitor({getSession:async()=>old,read:async()=>({enabled:true,complete:true,last_completed_at:new Date().toISOString()}),fetchImpl:async(_url,o)=>{const b=JSON.parse(o.body);if(b.action==='case_discovery_sync')++discoveries;const value={case_id:b.case_id,eligible:true,state:'incomplete',needs_check:true,candidates:[],partial:true,continue_inspection:true,scan:{state:'partial'}};if(b.action==='quote_monitor_check')++pages;return {ok:true,status:200,json:async()=>({ok:true,result:value})};}});
 await partial.check('bounded');assert.equal(pages,2);assert.equal(discoveries,0);partial.dispose();
 // A delayed aggregate read cannot replace a more recent selected-case result.
 let releaseList,startedList;const listStarted=new Promise(r=>startedList=r),listGate=new Promise(r=>releaseList=r),race=createQuoteMonitor({getSession:async()=>old,fetchImpl:async(_url,o)=>{const b=JSON.parse(o.body);if(b.action==='quote_monitor_list'){startedList();await listGate;return {ok:true,status:200,json:async()=>({ok:true,result:{cases:[{case_id:'race',eligible:true,state:'incomplete',needs_check:true,generation:0}]}})};}return {ok:true,status:200,json:async()=>({ok:true,result:{case_id:'race',eligible:true,state:'checked',needs_check:false,generation:2,candidates:[],scan:{state:'ready'}}})};}});
 const listTask=race.start([{id:'race'}]);await listStarted;await race.check('race');releaseList();await listTask;assert.equal(race.get('race').state,'checked');race.dispose();
 // Failure notifications remain visible even when a previous full cache exists.
 let failure=false,seen;const errors=createQuoteMonitor({getSession:async()=>old,fetchImpl:async()=>({ok:!failure,status:failure?503:200,json:async()=>failure?{ok:false,code:'quote_monitor_storage_unavailable'}:{ok:true,result:{case_id:'err',state:'checked',needs_check:false,candidates:[],scan:{state:'ready'}}}})});await errors.read('err');errors.subscribe('err',v=>seen=v);failure=true;await assert.rejects(errors.check('err'));assert.equal(seen.state,'incomplete');assert.equal(seen.error,'quote_monitor_storage_unavailable');errors.dispose();
 assert(calls.every(c=>['quote_monitor_list','quote_monitor_status','quote_monitor_check'].includes(c.action)));monitor.dispose();
 console.log(JSON.stringify({status:'PASS',list_nonblocking_bounded_100_metadata_zero_inspections:true,passive_ensure_zero_inspections:true,gmail_sync_calls:0,single_lane_and_same_case_dedup:true,bounded_two_pages:true,late_aggregate_guard:true,full_cache_error_visible:true,closed_case_skip:true,no_auto_retry_429:true,auth_owner_and_late_result_guards:true,adopted_initial_authority_without_pdf:true,no_send_or_business_action:true}));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
