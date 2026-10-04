// All transports fail closed to a local fake. No credentials or network used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const originalEnv = {...process.env}, originalFetch = global.fetch;
const actor = '11111111-1111-4111-8111-111111111111';
const checks = [];
Object.assign(process.env, {SUPABASE_URL:'https://db.example.invalid', SUPABASE_SERVICE_ROLE_KEY:'fixture-service',
    GMAIL_CLIENT_ID:'fixture-client', GMAIL_CLIENT_SECRET:'fixture-secret', GMAIL_REFRESH_TOKEN:'fixture-refresh',
    GMAIL_SENDER_ADDRESS:'aratechsound@gmail.com', GMAIL_REPLY_TO:'aratechsound@gmail.com',
    ALLOWED_ORIGINS:'https://ara-tech.cc'});
delete process.env.ARA_GENERAL_FIXTURE;
let scenario = {}, calls = [];
const json = (data, status=200) => ({ok:status>=200&&status<300, status, json:async()=>data});
global.fetch = async (url, options={}) => {
    const u = new URL(url), method=options.method||'GET';
    calls.push({host:u.hostname,path:u.pathname,method});
    if (u.hostname==='db.example.invalid' && u.pathname==='/auth/v1/user') return json({id:actor},scenario.authFail?401:200);
    if (u.hostname==='db.example.invalid' && u.pathname==='/rest/v1/work_admins') return json(scenario.nonAdmin?[]:[{user_id:actor}]);
    if (u.hostname==='db.example.invalid' && u.pathname==='/rest/v1/rpc/consume_rate_limit') {
        const p=JSON.parse(options.body); return json({allowed:false,remaining:0,retry_after_seconds:10,limit:p.p_limit});
    }
    if (u.hostname==='oauth2.googleapis.com' && u.pathname==='/token') return json(scenario.badToken?{}:{access_token:'fixture-access'},scenario.oauthFail?400:200);
    if (u.hostname==='gmail.googleapis.com' && u.pathname==='/gmail/v1/users/me/profile') {
        assert.equal(method,'GET');
        if(scenario.transportFail) throw Error('fixture-secret fixture-access');
        return json(scenario.profile ?? {emailAddress:'aratechsound@gmail.com',historyId:'forbidden-history',messagesTotal:99,threadsTotal:88},scenario.profileFail?403:200);
    }
    throw Error('UNEXPECTED_TRANSPORT');
};
const gmail = require('../api/_pa-gmail.cjs'), handler=require('../api/pa-gmail.js');
function response(){return {headers:{},setHeader(k,v){this.headers[k]=v;},status(n){this.code=n;return this;},json(b){this.body=b;return this;}};}
async function invoke(name, options={}, expected=200, gmailCount=1){
    scenario=options;calls=[];
    const req={method:options.method||'POST',headers:{origin:options.origin||'https://ara-tech.cc',authorization:'Bearer fixture-admin'},body:{action:Object.hasOwn(options,'action')?options.action:'mailbox_profile'}};
    if(options.noAuth)delete req.headers.authorization;
    const r=response();await handler(req,r);
    assert.equal(r.code,expected,name);
    const gc=calls.filter(c=>c.host==='gmail.googleapis.com');assert.equal(gc.length,gmailCount);
    gc.forEach(c=>assert.deepEqual(c,{host:'gmail.googleapis.com',path:'/gmail/v1/users/me/profile',method:'GET'}));
    const db=calls.filter(c=>c.path.startsWith('/rest/'));
    const authBlocked=options.noAuth||options.authFail||options.method==='GET'||options.origin==='https://evil.example.invalid';
    assert.equal(db.length,authBlocked?0:1,'mandatory admin SELECT count');
    assert.equal(db.filter(c=>c.method!=='GET').length,0);
    assert.equal(db.filter(c=>c.path!=='/rest/v1/work_admins').length,0);
    assert.equal(/fixture-|historyId|messagesTotal|threadsTotal|forbidden-history|authorization|cookie/i.test(JSON.stringify(r.body)),false);
    checks.push({name,status:r.code,result:r.body,db_reads:db.length,db_mutations:0,post_auth_db_calls:0,gmail_profile_get:gc.length,gmail_other:0,oauth_refresh:calls.filter(c=>c.host==='oauth2.googleapis.com').length});
    return r;
}
async function browserConfig(body, ok){
    const loads=[]; const fields=[{disabled:false}], handlers={};
    const el=()=>({hidden:false,disabled:false,style:{},setAttribute(){},addEventListener(){},remove(){}});
    const button=el(), extra={...el(),querySelectorAll:()=>fields};
    const form={action:'https://formspree.io/f/mojqjwnr',dataset:{},querySelector:()=>button,append(){},submit(){},requestSubmit(){},addEventListener(k,v){handlers[k]=v;}};
    const document={getElementById:id=>id==='contact-form'?form:extra,querySelector:()=>el(),createElement:()=>el(),head:{append(s){loads.push(s.src);s.onload();}}};
    const context={document,URLSearchParams,crypto:{randomUUID:()=>actor},fetch:async()=>({ok,json:async()=>body}),window:{},location:{search:'',assign(){throw Error('navigation_forbidden');}},setTimeout,clearTimeout,console};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../js/ara-general-inquiry.js'),'utf8'),context);
    for(let n=0;n<5;n++)await new Promise(setImmediate);
    return {form,button,loads};
}
(async()=>{
    const good=await invoke('official mailbox');assert.deepEqual(good.body,{ok:true,result:{emailAddress:'aratechsound@gmail.com',matchesOfficialMailbox:true}});
    const wrong=await invoke('wrong mailbox',{profile:{emailAddress:'tonokun@gmail.com'}});assert.equal(wrong.body.result.matchesOfficialMailbox,false);
    await invoke('no auth',{noAuth:true},401,0);
    await invoke('invalid user token',{authFail:true},401,0);
    await invoke('not admin',{nonAdmin:true},401,0);
    await invoke('invalid Origin',{origin:'https://evil.example.invalid'},403,0);
    await invoke('GET rejected',{method:'GET'},405,0);
    await invoke('invalid action',{action:'unknown'},400,0);
    await invoke('inherited action rejected',{action:'__proto__'},400,0);
    await invoke('constructor action rejected',{action:'constructor'},400,0);
    await invoke('non-string action rejected',{action:{}},400,0);
    await invoke('missing action rejected',{action:undefined},400,0);
    await invoke('OAuth failure',{oauthFail:true},503,0);
    await invoke('OAuth missing token',{badToken:true},503,0);
    await invoke('profile upstream error',{profileFail:true},503,1);
    await invoke('missing email',{profile:{}},503,1);
    await invoke('non-string email',{profile:{emailAddress:42}},503,1);
    await invoke('malformed email',{profile:{emailAddress:'aratechsound@gmail.com\nsecret'}},503,1);
    await invoke('profile transport failure',{transportFail:true},503,1);
    // Helper alone has zero DB calls. The complete authenticated API has one
    // mandatory work_admins SELECT; do not hide this by mocking verifyAdmin.
    calls=[];scenario={};await gmail.mailboxProfile();assert.equal(calls.filter(c=>c.path.startsWith('/rest/')).length,0);
    checks.push({name:'profile helper zero DB',db_calls:0,gmail_get:1,result:'PASS'});
    const source=fs.readFileSync(path.join(__dirname,'../api/pa-gmail.js'),'utf8');
    const policies=[...source.slice(source.indexOf('const ACTION_POLICY'),source.indexOf('const parseBody')).matchAll(/\s+(\w+): "(PA_[A-Z_]+)"/g)];
    assert.equal(policies.length,12);
    for(const [,action,policy] of policies){
        scenario={};calls=[];const r=response();await handler({method:'POST',headers:{origin:'https://ara-tech.cc',authorization:'Bearer fixture-admin'},body:{action}},r);
        assert.equal(r.code,429,action);assert.equal(calls.filter(c=>c.path==='/rest/v1/rpc/consume_rate_limit').length,1);assert.equal(calls.filter(c=>c.host==='gmail.googleapis.com').length,0);
        checks.push({name:'existing rate limit '+action,policy,result:'PASS'});
    }
    const inquiry=require('../api/pa-inquiry.js');
    for(const [gate,mode,status] of [['false','LEGACY',200],['true','UNAVAILABLE',503],[undefined,'UNAVAILABLE',503]]){
        if(gate===undefined)delete process.env.ARA_GENERAL_INQUIRY_ENABLED;else process.env.ARA_GENERAL_INQUIRY_ENABLED=gate;
        delete process.env.ARA_GENERAL_NOTIFICATION_POLICY;delete process.env.ARA_TURNSTILE_SECRET;
        calls=[];const r=response();await inquiry({method:'GET',url:'/api/pa-inquiry?general_config=1'},r);
        assert.equal(r.code,status);assert.equal(r.body.mode,mode);assert.equal(calls.length,0);
        const browser=await browserConfig(r.body,r.code===200);
        assert.equal(browser.form.dataset.intakeMode,mode);
        assert.equal(browser.form.action,'https://formspree.io/f/mojqjwnr');
        assert.equal(browser.loads.length,mode==='LEGACY'?1:0);assert.equal(browser.button.disabled,mode!=='LEGACY');
        checks.push({name:'API and client gate '+String(gate),mode,formspree_loads:browser.loads.length,result:'PASS'});
    }
    console.log(JSON.stringify({result:'PASS',checks,network:'fake-only; unexpected destinations rejected',auth_boundary:'verifyAdmin retains 1 work_admins SELECT; zero DB mutation, zero post-auth DB calls',real_send:0},null,2));
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{global.fetch=originalFetch;for(const k of Object.keys(process.env))if(!(k in originalEnv))delete process.env[k];Object.assign(process.env,originalEnv);});
