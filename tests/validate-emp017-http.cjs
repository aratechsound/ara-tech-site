const assert=require('node:assert/strict'),crypto=require('node:crypto');
const hash=s=>crypto.createHash('sha256').update(s).digest('hex'),caseId='20000000-0000-4000-8000-000000000001';
const fakeSession='b'.repeat(64),calls=[],cache=new Map();let stored=null,legacy=false,revoked=false,race=false,fault=false;
const mock=(p,exports)=>{const id=require.resolve(p);cache.set(id,require.cache[id]);require.cache[id]={id,filename:id,loaded:true,exports};};
delete process.env.PA_STAFF_LINK_KEYRING_JSON;delete process.env.PA_STAFF_LINK_ACTIVE_KEY_ID;
mock('../api/_pa-portal.cjs',{bearerConfig:()=>({key:'TEST_SERVICE'}),rpc:async(token,name,input)=>{
 if(fault)throw Error(stored.token_plaintext);
 calls.push({token,name,input});
 if(name==='pa_portal_organizer_staff_manage_link'){
  assert.equal(token,'TEST_SERVICE');assert.equal(input.p_session_hash,hash(fakeSession));
  if(input.p_case_id&&input.p_case_id!==caseId)return{ok:false};
 }else assert.equal(token,'TEST_ADMIN');
 const action=name==='pa_portal_staff_link_token'?'stored_token':input.p_action;
 if(action==='status')return{ok:true,case_id:caseId,active:!revoked,exists:true,grade:input.p_grade};
 if(action==='stored_token'){
  if(revoked)return{ok:false};
  if(input.p_expected_link_id){if(race)return{ok:false};assert.equal(input.p_expected_link_id,stored.link_id);assert.equal(input.p_expected_token_hash,stored.token_hash);}
  return legacy?{ok:true,token_plaintext:null}:{ok:true,...stored};
 }
 if(action==='revoke'){revoked=true;return{ok:true,active:false};}
 if(['create','rotate'].includes(action)){stored={link_id:crypto.randomUUID(),token_plaintext:input.p_plain_token,case_id:caseId,grade:input.p_grade,token_hash:input.p_token_hash};assert.equal(hash(stored.token_plaintext),stored.token_hash);revoked=false;return{ok:true,active:true};}
 throw Error('unexpected fixture RPC');
}});
mock('../api/_request-security.cjs',{applyOriginPolicy:()=>true,checkRateLimit:async()=>({allowed:true}),isRateLimitUnavailable:()=>false});
const staff=require('../api/_pa-portal-staff.cjs'),handler=require('../api/_pa-portal-organizer-handler.cjs').handleOrganizerPortal;
const staffHandler=require('../api/_pa-portal-staff-handler.cjs').handleStaffPortal;
const res=()=>({statusCode:0,headers:{},setHeader(k,v){this.headers[k]=v;},status(n){this.statusCode=n;return this;},json(body){this.body=body;return body;}});
const call=async body=>{const r=res();await handler({method:'POST',headers:{cookie:'ara_pa_portal_session='+fakeSession},body},r);return r;};
async function main(){try{
 const issued=await staff.manageLink({accessToken:'TEST_ADMIN',caseId,grade:'GENERAL',action:'create'});assert(/^\/staff-portal#[a-f0-9]{64}$/.test(issued.share_url));assert.equal(stored.token_plaintext,issued.share_url.split('#')[1]);assert.equal(issued.token_plaintext,undefined);
 assert.equal((await staff.manageLink({accessToken:'TEST_ADMIN',caseId,grade:'GENERAL',action:'status'})).share_url,issued.share_url);assert.equal(calls.at(-1).name,'pa_portal_staff_link_token');assert(calls.at(-1).input.p_expected_link_id);
 legacy=true;const legacyStatus=await staff.manageLink({accessToken:'TEST_ADMIN',caseId,grade:'GENERAL',action:'status'});assert.equal(legacyStatus.active,true);assert.equal(legacyStatus.url_redisplay,false);assert.equal(legacyStatus.share_url,undefined);legacy=false;
 race=true;await assert.rejects(staff.manageLink({accessToken:'TEST_ADMIN',caseId,grade:'GENERAL',action:'redisplay'}),/link_unavailable/);race=false;
 const intact={...stored};for(const altered of [{case_id:'wrong-case'},{grade:'TECHNICAL'},{token_hash:'a'.repeat(64)},{token_plaintext:'invalid'}]){stored={...intact,...altered};await assert.rejects(staff.manageLink({accessToken:'TEST_ADMIN',caseId,grade:'GENERAL',action:'redisplay'}),/link_unavailable/);}stored=intact;
 const organizerIssued=await call({action:'staff_link_rotate',grade:'GENERAL'});assert.equal(organizerIssued.statusCode,200);assert(organizerIssued.body.result.share_url);
 const redisplayed=await call({action:'staff_link_redisplay',grade:'GENERAL'});assert.equal(redisplayed.statusCode,200);assert.equal(redisplayed.body.result.share_url,organizerIssued.body.result.share_url);
 assert(/no-store/.test(redisplayed.headers['Cache-Control']));assert.equal(redisplayed.headers['Referrer-Policy'],'no-referrer');
 const wrong=await call({action:'staff_link_status',grade:'GENERAL',inquiry_id:'20000000-0000-4000-8000-000000000002'});assert.equal(wrong.statusCode,401);
 const tampered=await call({action:'staff_link_status',grade:'GENERAL',portal_id:'untrusted'});assert.equal(tampered.statusCode,400);assert.equal((await call({action:'staff_link_expiry',grade:'GENERAL',expires_at:'2099-01-01'})).statusCode,400);
 for(const action of ['upload','delete','staff_link_create','staff_link_rotate','staff_link_revoke','staff_link_expiry','organizer_create_card']){
  const denied=res(),before=calls.length;await staffHandler({method:'POST',headers:{cookie:'ara_pa_staff_session='+fakeSession},body:{action}},denied);assert.equal(denied.statusCode,403);assert.equal(calls.length,before,'staff write must not reach RPC');
 }
 const count=calls.length;const rotated=await staff.manageLink({accessToken:'TEST_ADMIN',caseId,grade:'GENERAL',action:'rotate'});assert(rotated.share_url);assert(calls.length>count,'issuance works without key settings');assert.notEqual(rotated.share_url,issued.share_url);
 const logged=[],originalError=console.error;fault=true;console.error=(...args)=>logged.push(args);let failure;try{failure=await call({action:'staff_link_redisplay',grade:'GENERAL'});}finally{console.error=originalError;fault=false;}assert.equal(failure.statusCode,503);assert(!JSON.stringify([failure.body,logged]).includes(stored.token_plaintext));
 console.log('EMP017 HTTP PASS: key-free admin/organizer issuance and redisplay; identity/hash/grade tamper and rotation race DENY; legacy unavailable; cookie event binding; staff write DENY; no-store; raw absent from errors/logs; no live requests');
}finally{for(const[id,value]of cache){if(value)require.cache[id]=value;else delete require.cache[id];}delete process.env.PA_STAFF_LINK_KEYRING_JSON;delete process.env.PA_STAFF_LINK_ACTIVE_KEY_ID;}}
main().catch(e=>{console.error(JSON.stringify({failed:true,location:e.stack?.split('\n').slice(1,3)}));process.exitCode=1;});
