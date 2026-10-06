const assert=require('node:assert/strict'),crypto=require('node:crypto');
const hash=s=>crypto.createHash('sha256').update(s).digest('hex'),caseId='20000000-0000-4000-8000-000000000001';
const fakeSession='b'.repeat(64),calls=[],cache=new Map();let stored=null,legacy=false,revoked=false,race=false;
const mock=(p,exports)=>{const id=require.resolve(p);cache.set(id,require.cache[id]);require.cache[id]={id,filename:id,loaded:true,exports};};
process.env.PA_STAFF_LINK_KEYRING_JSON=JSON.stringify({local_test:crypto.randomBytes(32).toString('base64')});process.env.PA_STAFF_LINK_ACTIVE_KEY_ID='local_test';
mock('../api/_pa-portal.cjs',{bearerConfig:()=>({key:'TEST_SERVICE'}),rpc:async(token,name,input)=>{
 calls.push({token,name,input});
 if(name==='pa_portal_organizer_staff_manage_link'){
  assert.equal(token,'TEST_SERVICE');assert.equal(input.p_session_hash,hash(fakeSession));
  if(input.p_case_id&&input.p_case_id!==caseId)return{ok:false};
 }else assert.equal(token,'TEST_ADMIN');
 const action=name==='pa_portal_staff_link_envelope'?'envelope':input.p_action;
 if(action==='status')return{ok:true,case_id:caseId,active:!revoked,exists:true,grade:input.p_grade};
 if(action==='envelope'){
  if(revoked)return{ok:false};
  if(input.p_expected_link_id){if(race)return{ok:false};assert.equal(input.p_expected_link_id,stored.link_id);assert.equal(input.p_expected_token_hash,stored.token_hash);}
  return legacy?{ok:true,ciphertext:null}:{ok:true,...stored};
 }
 if(action==='revoke'){revoked=true;return{ok:true,active:false};}
 if(['create','rotate'].includes(action)){stored={...input.p_envelope,case_id:caseId,grade:input.p_grade,token_hash:input.p_token_hash};revoked=false;return{ok:true,active:true};}
 throw Error('unexpected fixture RPC');
}});
mock('../api/_request-security.cjs',{applyOriginPolicy:()=>true,checkRateLimit:async()=>({allowed:true}),isRateLimitUnavailable:()=>false});
const staff=require('../api/_pa-portal-staff.cjs'),handler=require('../api/_pa-portal-organizer-handler.cjs').handleOrganizerPortal;
const staffHandler=require('../api/_pa-portal-staff-handler.cjs').handleStaffPortal;
const res=()=>({statusCode:0,headers:{},setHeader(k,v){this.headers[k]=v;},status(n){this.statusCode=n;return this;},json(body){this.body=body;return body;}});
const call=async body=>{const r=res();await handler({method:'POST',headers:{cookie:'ara_pa_portal_session='+fakeSession},body},r);return r;};
async function main(){try{
 const issued=await staff.manageLink({accessToken:'TEST_ADMIN',caseId,grade:'GENERAL',action:'create'});assert(/^\/staff-portal#[a-f0-9]{64}$/.test(issued.share_url));assert(!JSON.stringify(calls).includes(issued.share_url.split('#')[1]));
 assert.equal((await staff.manageLink({accessToken:'TEST_ADMIN',caseId,grade:'GENERAL',action:'status'})).share_url,issued.share_url);assert.equal(calls.at(-1).name,'pa_portal_staff_link_envelope');assert(calls.at(-1).input.p_expected_link_id);
 legacy=true;const legacyStatus=await staff.manageLink({accessToken:'TEST_ADMIN',caseId,grade:'GENERAL',action:'status'});assert.equal(legacyStatus.active,true);assert.equal(legacyStatus.url_redisplay,false);assert.equal(legacyStatus.share_url,undefined);legacy=false;
 race=true;await assert.rejects(staff.manageLink({accessToken:'TEST_ADMIN',caseId,grade:'GENERAL',action:'redisplay'}),/link_unavailable/);race=false;
 const organizerIssued=await call({action:'staff_link_rotate',grade:'GENERAL'});assert.equal(organizerIssued.statusCode,200);assert(organizerIssued.body.result.share_url);
 const redisplayed=await call({action:'staff_link_redisplay',grade:'GENERAL'});assert.equal(redisplayed.statusCode,200);assert.equal(redisplayed.body.result.share_url,organizerIssued.body.result.share_url);
 assert(/no-store/.test(redisplayed.headers['Cache-Control']));assert.equal(redisplayed.headers['Referrer-Policy'],'no-referrer');
 const wrong=await call({action:'staff_link_status',grade:'GENERAL',inquiry_id:'20000000-0000-4000-8000-000000000002'});assert.equal(wrong.statusCode,401);
 const tampered=await call({action:'staff_link_status',grade:'GENERAL',portal_id:'untrusted'});assert.equal(tampered.statusCode,400);assert.equal((await call({action:'staff_link_expiry',grade:'GENERAL',expires_at:'2099-01-01'})).statusCode,400);
 for(const action of ['upload','delete','staff_link_create','staff_link_rotate','staff_link_revoke','staff_link_expiry','organizer_create_card']){
  const denied=res(),before=calls.length;await staffHandler({method:'POST',headers:{cookie:'ara_pa_staff_session='+fakeSession},body:{action}},denied);assert.equal(denied.statusCode,403);assert.equal(calls.length,before,'staff write must not reach RPC');
 }
 const count=calls.length;delete process.env.PA_STAFF_LINK_KEYRING_JSON;await assert.rejects(staff.manageLink({accessToken:'TEST_ADMIN',caseId,grade:'GENERAL',action:'rotate'}),/staff_url_unavailable/);assert.equal(calls.length,count,'missing key prevents mutation');
 console.log('EMP014 HTTP PASS: encrypted issuance, admin/organizer redisplay recheck, legacy unavailable, cookie event binding, strict organizer keys, staff write DENY, no-store, missing-key mutation DENY; no live requests');
}finally{for(const[id,value]of cache){if(value)require.cache[id]=value;else delete require.cache[id];}delete process.env.PA_STAFF_LINK_KEYRING_JSON;delete process.env.PA_STAFF_LINK_ACTIVE_KEY_ID;}}
main().catch(e=>{console.error('EMP014 HTTP failed:',e.message);process.exitCode=1;});
