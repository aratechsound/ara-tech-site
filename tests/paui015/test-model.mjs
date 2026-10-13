import assert from 'node:assert/strict';
import fs from 'node:fs';
import {sortCases,reviewCounts,attention,filterCases,scheduleState,scheduleResponseLabel,displayStatus,documentChange,isClosedCase} from '../../pa-ui/js/model.mjs';
import {protectMoneyText} from '../../pa-ui/js/money-text.mjs';
const tests=[];function check(name,fn){fn();tests.push({name,status:'PASS'});}
const rows=[{id:'b',event_date:'2026-11-01',received_at:'2026-10-02',attentionLoaded:true,attention:{attention_state:'new_customer_reply'},case_type:'PA_EVENT',status:'needs_confirmation',progress:{current_step:5}},{id:'a',event_date:'2026-10-18',received_at:'2026-10-01',attentionLoaded:true,attention:{attention_state:'waiting_customer'},case_type:'PA_EVENT',status:'schedule_confirmed',progress:{formal_contract_id:'existing',confirmed_event_date:'2026-10-18'}},{id:'c',event_date:null,attentionLoaded:false,status:'new_inquiry'}];
check('Event ordering is stable, undated last',()=>assert.deepEqual(sortCases(rows).map(x=>x.id),['a','b','c']));
check('Receipt ordering is explicit',()=>assert.equal(sortCases(rows,'received')[0].id,'b'));
check('New customer reply counts cases only; unknown retained',()=>assert.deepEqual(reviewCounts(rows),{needsReview:1,unknown:1}));
check('Missing attention is unknown, never marked read',()=>assert.equal(attention({attentionLoaded:true,attention:null}).known,false));
check('Selecting/reading does not mutate attention',()=>{const before=JSON.stringify(rows);reviewCounts(rows);filterCases(rows,{review:'unread'});assert.equal(JSON.stringify(rows),before);});
check('Year/type/state/current_step filters',()=>assert.equal(filterCases(rows,{year:'2026',type:'PA_EVENT',status:'needs_confirmation',step:'5'}).length,1));
check('Saved formal authority projection only',()=>assert.equal(displayStatus(rows[1]),'formal_order_confirmed'));
check('Terminal cases do not gain formal confirmation',()=>assert.equal(displayStatus({...rows[1],status:'cancelled'}),'cancelled'));
check('URL expiry/revocation/answer states distinct',()=>{assert.equal(scheduleState({revoked_at:'2026-01-01'}),'失効');assert.equal(scheduleState({expires_at:'2026-01-01'},Date.parse('2026-10-12')),'期限切れ');assert.equal(scheduleState({answered_at:'2026-01-01',expires_at:'2027-01-01'},Date.parse('2026-10-12')),'回答済み');});
check('Missing review evidence never invents document NEW',()=>{assert.equal(documentChange({version_label:'v2'},[{},{}]),'更新あり');assert.equal(documentChange({},[{}]),'初版・確認状態未取得');assert.equal(documentChange({is_new:true},[{}]),'NEW');assert.equal(documentChange({},[]),'確認状態未取得');});
check('Canonical customer decision values render',()=>{assert.equal(scheduleResponseLabel({decision:'agree'}),'条件に同意し、日程調整を依頼');assert.equal(scheduleResponseLabel({decision:'question'}),'ARA-TECHへ確認したい');assert.equal(scheduleResponseLabel({decision:'decline'}),'条件に同意せず、日程調整を依頼しない');});
check('Money text covers scales and ranges',()=>{assert.equal(protectMoneyText('予算 25万円 / 1,000〜2,000円',()=>'<hidden>'),'予算 <hidden> / <hidden>');});
check('Money text covers currency symbols/codes and labelled amounts',()=>{assert.equal(protectMoneyText('USD 1,250 / $400 / 費用：198550',()=>'<hidden>'),'<hidden> / <hidden> / 費用：<hidden>');});
check('Money masking preserves event dates, counts and phones',()=>{const value='2026-10-18 / 103件 / 0826-28-1961';assert.equal(protectMoneyText(value,()=>'<hidden>'),value);});
check('Default includes past events awaiting billing/payment',()=>{
 const pending={id:'past',event_date:'2020-01-01',status:'schedule_confirmed',progress:{event_completed_on:'2020-01-01',current_step:12},commercial:{fulfillment_state:'confirmed',settlement_state:'unsettled'}};
 assert.equal(filterCases([pending]).length,1);assert.equal(isClosedCase(pending),false);
});
check('Inquiry, quote, formal/preparation and unknown states stay active',()=>{
 assert.equal(filterCases(['new_inquiry','reviewing','rough_estimate','waiting_customer_reply','schedule_confirmed','on_hold','undefined_state'].map(status=>({status}))).length,7);
});
check('Only recorded close/decline/cancellation/completion excluded',()=>{
 const terminal=[{status:'closed'},{status:'declined'},{status:'cancelled'},{status:'schedule_unavailable'},{status:'schedule_confirmed',progress:{closed_at:'2026-10-01'}}];
 assert.equal(filterCases(terminal).length,0);assert.equal(filterCases(terminal,{review:'completed'}).length,5);assert.equal(filterCases(terminal,{review:'all'}).length,5);
});
check('Paid/settled alone never invents completion',()=>assert.equal(filterCases([{status:'schedule_confirmed',commercial:{settlement_state:'confirmed',balance:0},progress:{current_step:14}}]).length,1));
check('Display filter preserves dates, attention and all source rows',()=>{
 const source=[...rows,{id:'closed',status:'closed',attentionLoaded:true,attention:{attention_state:'new_customer_reply'}}],before=JSON.stringify(source);
 for(const review of ['active','action','all','completed'])filterCases(source,{review});assert.equal(JSON.stringify(source),before);assert.equal(reviewCounts(source).needsReview,2);
});
const features=JSON.parse(fs.readFileSync(new URL('../../pa-ui/features.json',import.meta.url)));
check('103 unique features preserve input identities',()=>{assert.equal(features.length,103);assert.equal(new Set(features.map(x=>x.id)).size,103);});
fs.writeFileSync(new URL('./MODEL_TESTS.local.json',import.meta.url),JSON.stringify({task_id:'PAUI-012',mode:'LOCAL_PURE_LOGIC',total:tests.length,tests},null,2));console.log(JSON.stringify({passed:tests.length,total:tests.length}));
