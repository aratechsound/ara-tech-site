'use strict';
const assert=require('node:assert/strict');
const service=require('../api/_pa-portal-candidates.cjs');
const A='11111111-1111-4111-8111-111111111111',ACTOR='22222222-2222-4222-8222-222222222222',P='33333333-3333-4333-8333-333333333333';
(async()=>{
 const {documentKind}=await import('../pa-ui/js/document-warehouse.mjs');assert.equal(documentKind({filename:'【音響用】R8イベントシナリオ.pdf',mime_type:'application/pdf'}),'台本');assert.equal(documentKind({filename:'関係者駐車券.pdf',mime_type:'application/pdf'}),'その他');
 const expected=[['【音響用】R8イベントシナリオ.pdf','script'],['駐車場位置図.pdf','layout'],['関係者駐車券.pdf','other'],['【音響用】連絡事項.pdf','other'],['音響用_連絡事項.pdf','other']];
 for(const [filename,category]of expected)assert.equal(service.suggestionFor({filename,mime_type:'application/pdf',subject:''}).suggested_category,category,filename);
 assert.equal(service.suggestionFor({filename:'関係者駐車券.pdf',mime_type:'application/pdf',subject:'配置図・進行台本'}).suggested_category,'other');
 const parts=expected.slice(0,3).map(([filename],index)=>({id:'attachment'+index,part_id:String(index+1),filename,mime_type:'application/pdf',size:123}));
 const proposals=service.buildProposals([{gmail_message_id:'target',direction:'inbound',subject:'資料',attachment_metadata:parts}]).proposals;
 assert.deepEqual(proposals.map(x=>x.suggested_category),['script','layout','other']);
 assert.equal(new Set(proposals.map(x=>x.canonical_attachment_key)).size,3);assert.deepEqual(proposals.map(x=>x.display_filename),parts.map(x=>x.filename));
 assert.deepEqual(proposals.map(x=>x.gmail_part_id),['1','2','3']);
 process.env.SUPABASE_URL='https://fixture.invalid';process.env.SUPABASE_SERVICE_ROLE_KEY='fixture-only';
 const calls=[];let missing=false,wrongThread=false;
 const fetchMock=async(url,options={})=>{
  const u=new URL(url);assert.equal(u.origin,'https://fixture.invalid');calls.push({path:u.pathname,query:u.searchParams,body:options.body&&JSON.parse(options.body)});
  let result;
  if(u.pathname.endsWith('/pa_gmail_thread_links'))result=[{gmail_thread_id:'thread'}];
  else if(u.pathname.endsWith('/pa_gmail_message_index')){assert.equal(u.searchParams.get('inquiry_id'),'eq.'+A);assert.equal(u.searchParams.get('gmail_message_id'),'eq.target');result=missing?[]:[{gmail_message_id:'target',gmail_thread_id:wrongThread?'other':'thread',direction:'inbound',attachment_metadata:parts}];}
  else if(u.pathname.endsWith('/pa_portals'))result=[{id:P}];
  else if(u.pathname.endsWith('/pa_portal_document_cards'))result=[];
  else if(u.pathname.endsWith('/pa_portal_candidate_identity_context'))result={registered:[],pending_candidates:[]};
  else if(u.pathname.endsWith('/pa_portal_candidate_detect')){const body=JSON.parse(options.body);assert.equal(body.p_case_id,A);assert.equal(body.p_actor_id,ACTOR);assert.deepEqual(body.p_items.map(x=>x.gmail_message_id),['target','target','target']);result={detected:3,pending:3};}
  else throw Error('unexpected route '+u.pathname);
  return {ok:true,json:async()=>result};
 };
 await service.backfillCandidates({caseId:A,actorId:ACTOR,messageId:'target'},fetchMock);
 for(const condition of ['missing','wrongThread']){
  missing=condition==='missing';wrongThread=condition==='wrongThread';const count=calls.length;
  await assert.rejects(service.backfillCandidates({caseId:A,actorId:ACTOR,messageId:'target'},fetchMock),/candidate_message_binding_mismatch/);
  assert(!calls.slice(count).some(x=>x.path.includes('/rpc/')),'unknown attribution must stop before candidate writes');
 }
 const count=calls.length;await assert.rejects(service.backfillCandidates({caseId:A,actorId:ACTOR,messageId:'bad/id'},fetchMock),/invalid_candidate_message/);assert.equal(calls.length,count);
 const {createWorkflowRequest,createPortalCandidateBridge}=await import('../pa-ui/js/case-workflows.mjs');
 await assert.rejects(createWorkflowRequest(async()=>null)('reply_preview',{}),/login_required/);
 await assert.rejects(createWorkflowRequest(async()=>({access_token:'fixture-only'}))('candidate_accept',{}),/workflow_action_refused/);
 let writes=0,release;const bridge=createPortalCandidateBridge({request:async()=>{writes++;await new Promise(r=>{release=r;});return {ok:true,result:{detected:3,pending:3}};},isCurrent:()=>true,onStatus:()=>{}});
 const first=bridge.link(A,'target'),second=bridge.link(A,'target');assert.equal(writes,1);release();await Promise.all([first,second]);
 await bridge.newlyIndexed(A,new Set(['old']),[{gmail_message_id:'old',attachment_metadata:parts}]);assert.equal(writes,1,'old indexed messages must not cause automatic backfill');
 const selected=[];const automatic=createPortalCandidateBridge({request:async(action,payload)=>{selected.push(payload.gmail_message_id);return {result:{detected:0,pending:3}};},isCurrent:id=>id===A,onStatus:()=>{}});await automatic.newlyIndexed(A,new Set(['old']),[{gmail_message_id:'old',attachment_metadata:parts},{gmail_message_id:'new',attachment_metadata:parts},{gmail_message_id:'empty',attachment_metadata:[]}]);assert.deepEqual(selected,['new']);await automatic.newlyIndexed(P,new Set(),[{gmail_message_id:'other-case',attachment_metadata:parts}]);assert.deepEqual(selected,['new']);
 console.log(JSON.stringify({status:'PASS',classification_cases:6,stable_distinct_parts:3,scoped_backfill:true,unknown_attribution_no_writes:true,concurrent_dedup:true,no_candidate_adoption:true}));
})().catch(e=>{console.error(e);process.exitCode=1;});
