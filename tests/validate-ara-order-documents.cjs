'use strict';
const assert=require('node:assert/strict');
async function main(){
 const {resolveOrderDocuments}=await import('../pa-ui/js/order-document-model.mjs');
 const c='case-a',contract={id:'contract-a',confirmed_at:'2026-09-17'},quote={source:'gmail',sha256:'a'.repeat(64),filename:'changed.pdf',message_id:'sent',thread_id:'thread',attachment_id:'att',part_id:'1',amount_minor:20,tax_basis:'tax_included'},approval={message_id:'reply',thread_id:'thread'};
 let mode='candidate',calls=[];
 const state=()=>({case_id:c,contracts:[contract],history:[],detected:mode==='multiple'?[{contract_id:contract.id,quote,approval},{contract_id:contract.id,quote,approval}]:mode==='empty'?[]:[{contract_id:contract.id,quote,approval}],detection_errors:mode==='incomplete'?[{code:'unavailable'}]:[],detection_state:mode==='incomplete'?'incomplete':'candidate_found',current_agreement:mode==='adopted'?{id:'event',contract_id:contract.id,evidence:{case_id:c,contract_id:contract.id,quote,approval:{source:'gmail',...approval}}}:null});
 const request=async(action,input)=>{calls.push({action,input});if(action==='change_evidence_candidates')return state();if(action==='change_evidence_preview')return {evidence:{case_id:c,contract_id:contract.id,quote,approval:{...approval,status:'verified',exact_quote_reference:mode!=='mismatch',linked:true}}};throw Error('mutation forbidden');};
 let v=await resolveOrderDocuments(request,c);assert.equal(v.label,'送信済み・Owner未採用');assert.equal(v.evidence.quote.sha256,quote.sha256);assert.equal(calls.at(-1).input.owner_confirmed,false);assert(!calls.at(-1).input.reason);
 for(mode of ['multiple','incomplete','empty','mismatch']){calls=[];v=await resolveOrderDocuments(request,c);assert(!v.evidence);if(mode!=='mismatch')assert(!calls.some(x=>x.action==='change_evidence_preview'));}
 mode='adopted';calls=[];v=await resolveOrderDocuments(request,c);assert.equal(v.event_id,'event');assert.equal(v.label,'Owner採用済み・現行合意見積');assert.equal(calls.length,1);
 await assert.rejects(resolveOrderDocuments(request,'case-b'),/change_evidence_mismatch/);
 assert(calls.every(x=>['change_evidence_candidates','change_evidence_preview'].includes(x.action)));
 console.log(JSON.stringify({status:'PASS',candidate_adopted_fallback:true,ambiguity_and_mismatch_fail_closed:true,case_identity:true,no_business_mutations:true}));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
