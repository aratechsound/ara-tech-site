'use strict';
const assert=require('node:assert/strict');
const {createSummaryService,createOpenAIProvider,completeSource,sourceDocument,validateOutput,POLICY}=require('../api/_pa-mail-summary.cjs');
const fixtures=require('./paui037-fixture.cjs');
const approval={enabled:true,ownerApproved:true,budgetApproved:true,externalTransferApproved:true,provider:'fixture',model:'fixture-only'};
function fixtureCache(){const map=new Map();return {durable:true,map,async get(k){return map.get(k);},async claim(k){if(map.has(k))return false;map.set(k,{state:'loading'});return true;},async complete(k,v){map.set(k,v);}};}
const source=f=>({inquiry_id:'case-fixture',gmail_message_id:f.id,gmail_thread_id:'thread-fixture',direction:f.direction||'inbound',subject:'架空の検証用件名',body_text:f.body,attachment_metadata:f.attachments||[]});
(async()=>{
 let calls=0,last;const cache=fixtureCache();
 const provider={id:'fixture',model:'fixture-only',async generate(input){calls++;last=input;const f=fixtures.find(f=>f.body===input.document.body);assert(f);return {lines:f.lines.map((text,i)=>({text,evidence:f.evidence[i]}))};}};
 const service=createSummaryService({approval,provider,cache});
 for(const f of fixtures){
  const input={owner:'owner-fixture',source:source(f)};
  assert.equal((await service.run(input)).state,'not_generated');
  const n=calls,result=await service.run({...input,generate:true});assert.equal(result.state,'ready',f.id);assert.deepEqual(result.lines,f.lines);
  assert.equal(last.document.body,f.body,'Entire body, including late requests and long quotes, must reach semantic provider');
  assert.equal(last.document.direction,f.direction||'inbound');assert.deepEqual(last.document.attachments,(f.attachments||[]).map(a=>a.filename));
  assert.deepEqual((await service.run({...input,generate:true})).lines,f.lines);assert.equal(calls,n+1);
 }
 const n=calls;const input={owner:'owner-fixture',source:source(fixtures[0]),generate:true};
 for(const key of ['ownerApproved','budgetApproved','externalTransferApproved','enabled'])assert.equal((await createSummaryService({approval:{...approval,[key]:false},provider,cache}).run(input)).state,'not_generated');
 assert.equal((await createSummaryService({approval,provider,cache:{...cache,durable:false}}).run(input)).state,'not_generated');
 assert.equal((await createSummaryService().run(input)).state,'not_generated');assert.equal(calls,n);assert.equal(POLICY.enabled,false);
 const otherOwner=await service.run({...input,owner:'different-owner',generate:false});assert.equal(otherOwner.state,'not_generated');
 assert.equal((await service.run({...input,source:{...input.source,inquiry_id:'other-case'},generate:false})).state,'not_generated');
 assert.equal((await service.run({...input,source:{...input.source,body_text:input.source.body_text+'後半に追加依頼'},generate:false})).state,'not_generated');
 // Failure/timeout remains terminal across service instances, not automatically retried.
 let failedCalls=0;const failedCache=fixtureCache(),bad={...provider,generate:async()=>{failedCalls++;throw Error('private provider diagnostic');}};
 const failure=createSummaryService({approval,provider:bad,cache:failedCache});assert.equal((await failure.run(input)).state,'failed');
 assert.equal((await createSummaryService({approval,provider:bad,cache:failedCache}).run(input)).state,'failed');assert.equal(failedCalls,1);
 let release;const concurrentCache=fixtureCache(),slow={...provider,generate:()=>new Promise(r=>{release=r;})},a=createSummaryService({approval,provider:slow,cache:concurrentCache});
 const pending=a.run(input);while(!release)await new Promise(r=>setImmediate(r));
 assert.equal((await createSummaryService({approval,provider:slow,cache:concurrentCache}).run(input)).state,'loading');
 release({lines:[{text:'搬入は11月8日9時。',evidence:'搬入は11月8日9時です。'}]});assert.equal((await pending).state,'ready');
 const doc=sourceDocument(source(fixtures[0]));
 const tail='末尾の依頼も全文処理すること。',long='x'.repeat(55000)+tail,raw={payload:{mimeType:'text/plain',headers:[{name:'Subject',value:'全文'}],body:{data:Buffer.from(long).toString('base64url')}}};
 const full=completeSource(raw,{direction:'inbound',body_text:long.slice(0,50000)});assert.equal(full.body_text,long);assert(full.body_text.endsWith(tail));
 assert.equal(completeSource({payload:{...raw.payload,body:{data:Buffer.from('x'.repeat(120001)).toString('base64url')}}},{direction:'inbound'}).source_reason,'source_too_large');
 assert.equal(completeSource({payload:{mimeType:'text/plain',body:{attachmentId:'missing'}}},{direction:'inbound'}).source_reason,'source_incomplete');
 assert.equal(completeSource(raw,{direction:'inbound',reply_identity_invalid:true}).direction,'unknown');
 for(const output of [{lines:[]},{lines:Array(4).fill({text:'x',evidence:doc.body})},{lines:[{text:'1\n2',evidence:doc.body}]},{lines:[{text:'車両99台を確定。',evidence:doc.body}]},{lines:[{text:'創作',evidence:'原文にない根拠'}]}])assert.throws(()=>validateOutput(output,doc));
 for(const body of [{body_text:'',body_html:'<p>HTML</p>'},{body_text:'',snippet:'先頭抜粋'},{body_text:'あ'.repeat(120001)}])assert.throws(()=>sourceDocument({...source(fixtures[0]),...body}));
 // Test transport without network, paid model or customer data.
 let wire;const transport=createOpenAIProvider({apiKey:'fixture-only',model:'owner-must-select',fetchImpl:async(url,options)=>{
  wire={url,options,body:JSON.parse(options.body)};return {ok:true,text:async()=>JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({lines:[{text:'fixture',evidence:'fixture'}]})}]}]})};}});
 await transport.generate({instructions:'fixture',document:doc,schema:{type:'object'}});
 assert.equal(wire.url,'https://api.openai.com/v1/responses');assert.equal(wire.body.store,false);assert.equal(wire.body.truncation,'disabled');assert.equal(wire.options.redirect,'error');assert(!wire.body.tools);assert(!wire.body.previous_response_id);
 console.log(JSON.stringify({status:'PASS',fixture_cases:fixtures.map(f=>f.id),failure_case:'K',mock_contract_checks:'PASS',semantic_model_quality:'HOLD_NOT_RUN',real_ai_requests:0,external_customer_data_transfer:0}));
})().catch(e=>{console.error(e);process.exitCode=1;});
