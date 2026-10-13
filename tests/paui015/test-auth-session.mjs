import assert from 'node:assert/strict';
import {AUTH_OPTIONS,createWorkspaceAuth,requiresReauthentication} from '../../pa-ui/js/auth-session.mjs';
const now=()=>1000000,valid={access_token:'fixture-only',expires_at:2000,user:{id:'fixture-user'}};
let session=valid,admin=true,user=true,getUserCalls=0,signOutCalls=0,lastScope,authEvent;
const sdk={auth:{
  async getSession(){return {data:{session}};},
  async signInWithPassword(){return {data:{session}};},
  async getUser(){getUserCalls++;return user?{data:{user:{id:'fixture-user'}}}:{data:{user:null},error:Error('invalid')};},
  async signOut(options){signOutCalls++;lastScope=options.scope;session=null;return {error:null};},
  onAuthStateChange(callback){authEvent=callback;return {data:{subscription:{unsubscribe(){}}}};}
},from(table){assert.equal(table,'work_admins');return {select(){return this;},eq(){return this;},async maybeSingle(){return {data:admin?{user_id:'fixture-user'}:null};}};}};
const auth=createWorkspaceAuth(sdk,now),tests=[];
async function check(name,fn){await fn();tests.push({name,status:'PASS'});}
await check('Supabase standard session persistence and refresh enabled',()=>{assert.deepEqual(AUTH_OPTIONS,{persistSession:true,autoRefreshToken:true});});
await check('Restore validates Auth user and administrator',async()=>{assert.equal(await auth.restore(),valid);assert.equal(getUserCalls,1);});
await check('New page instance restores same SDK persisted session without password',async()=>{assert.equal(await createWorkspaceAuth(sdk,now).restore(),valid);});
await check('Absent session shows login without ACL call',async()=>{session=null;const n=getUserCalls;assert.equal(await auth.restore(),null);assert.equal(getUserCalls,n);session=valid;});
await check('Login without an SDK session cannot open workspace',async()=>{session=null;await assert.rejects(auth.login('fixture','fixture'),/login_required/);session=valid;});
await check('Invalid remote Auth user refuses restored session',async()=>{user=false;await assert.rejects(auth.restore(),/login_required/);user=true;});
await check('Revoked administrator refuses restored session',async()=>{admin=false;await assert.rejects(auth.restore(),/admin_required/);admin=true;});
await check('Expired unrefreshable SDK session refuses use',async()=>{session={...valid,expires_at:999};await assert.rejects(auth.current(),/login_required/);await assert.rejects(auth.restore(),/login_required/);session=valid;});
await check('SDK refreshed session is used before next API call',async()=>{session={...valid,expires_at:3000};assert.equal((await auth.current()).expires_at,3000);session=valid;});
await check('Missing expiry is not accepted',async()=>{session={...valid,expires_at:undefined};await assert.rejects(auth.current(),/login_required/);session=valid;});
await check('Commercial ACL denial stays local; global revocation requires login',()=>{assert.equal(requiresReauthentication('acl_denied',403),false);assert.equal(requiresReauthentication('admin_required',403),true);assert.equal(requiresReauthentication('login_required',401),true);});
await check('Auth subscription leaves SDK callback stack before async work',async()=>{let called=false;auth.subscribe(()=>{called=true;});authEvent('SIGNED_OUT',null);assert.equal(called,false);await Promise.resolve();assert.equal(called,true);});
await check('Logout uses normal local SDK signout and prevents restoration',async()=>{await auth.logout();assert.equal(signOutCalls,1);assert.equal(lastScope,'local');assert.equal(await auth.restore(),null);});
console.log(JSON.stringify({scope:'ANONYMOUS_SDK_FIXTURE',passed:tests.length,tests,real_auth_or_acl_mutations:0},null,2));
