const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),audit=path.resolve(root,'../../outputs/ARA-CASE-001R3-audit');
const {fixture}=require(path.resolve(root,'../r3-regression/tests/helpers/ara-case-real-fixture.cjs'));
const f=fixture();process.env.ALLOWED_ORIGINS='http://127.0.0.1:8875';
process.env.ARA_TURNSTILE_SECRET='fixture-only-no-real-secret';
const policy={verified:true,notification_recipient:'aratechsound@gmail.com',receipt_enabled:false,spam_adapter:'turnstile',captcha_site_key:'fixture-public-key',captcha_hostname:'fixture.example.invalid'};
const tokens=new Set();let scenario='ok',failDb=false,failConfig=false;const trace=[];
function configure(next){scenario=next;failDb=next==='db_once';process.env.ARA_GENERAL_INQUIRY_ENABLED=next==='off'?'false':next==='bad_gate'?'invalid':'true';process.env.ARA_GENERAL_NOTIFICATION_POLICY=next==='misconfig'?'{bad':next==='missing_policy'?'':JSON.stringify(policy);if(next==='bad_site_key')process.env.ARA_GENERAL_NOTIFICATION_POLICY=JSON.stringify({...policy,captcha_site_key:7});if(next==='bad_hostname')process.env.ARA_GENERAL_NOTIFICATION_POLICY=JSON.stringify({...policy,captcha_hostname:7});if(next==='unset_gate')delete process.env.ARA_GENERAL_INQUIRY_ENABLED;if(next==='empty_gate')process.env.ARA_GENERAL_INQUIRY_ENABLED='';f.state.failSend=true;f.sql("update api_rate_limit_buckets set window_expires_at=now()-interval '1 second';");}
configure('ok');
global.fetch=async(url,opts={})=>{
 const u=new URL(url);
 if(u.hostname==='challenges.cloudflare.com'){
  const proof=new URLSearchParams(opts.body).get('response');const success=!!proof&&!tokens.has(proof);tokens.add(proof);
  trace.push({event:'siteverify',success});
  return new Response(JSON.stringify({success,hostname:policy.captcha_hostname,action:'general-inquiry'}),{headers:{'content-type':'application/json'}});
 }
 if(u.pathname.endsWith('/rpc/ara_register_general')){
  const body=JSON.parse(opts.body);trace.push({event:'register',key:body.p_key});
  if(failDb){failDb=false;return new Response(JSON.stringify({code:'fixture_db_unavailable'}),{status:503});}
 }
 return f.fetchImpl(url,opts);
};
const handler=require('../api/pa-inquiry.js');
const baselineSource=require('node:child_process').execFileSync('git',['show','cac44214dba8f273377ab66fc95b2aad7e4fc38d:api/pa-inquiry.js'],{cwd:root,encoding:'utf8'});
const baselineModule={exports:{}};
require('node:vm').runInNewContext(baselineSource,{module:baselineModule,exports:baselineModule.exports,require:require('node:module').createRequire(path.resolve(root,'api/pa-inquiry.js')),process,Buffer,URL,URLSearchParams,fetch:global.fetch,console,Date,setTimeout,clearTimeout});
const baselineHandler=baselineModule.exports;
http.createServer(async(req,res)=>{
 try{
  const u=new URL(req.url,'http://127.0.0.1:8875');let raw='';for await(const b of req)raw+=b;const body=raw?JSON.parse(raw):{};
  res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','application/json');
  if(u.pathname==='/fixture-control'){configure(body.scenario||'ok');return res.end('{}');}
  if(u.pathname==='/fixture-state'){
   const key=u.searchParams.get('key');if(key&&!/^[0-9a-f-]{36}$/i.test(key))throw Error('key');
   const rows=key?JSON.parse(f.sql(`select coalesce(json_agg(json_build_object('id',i.id,'number',i.inquiry_number,'jobs',(select count(*) from pa_email_deliveries d where d.inquiry_id=i.id),'status',(select status from pa_email_deliveries d where d.inquiry_id=i.id limit 1))),'[]') from pa_inquiries i where submission_key='${key}';`)):[];
   return res.end(JSON.stringify({trace,sends:f.state.sends,rows}));
  }
  if(u.pathname==='/api/pa-inquiry'){
   if(req.method==='GET'&&scenario==='config503'){res.statusCode=503;return res.end('{}');}
   if(req.method==='GET'&&scenario==='bad_json')return res.end('{bad');
   if(req.method==='GET'&&scenario==='missing_fields')return res.end('{"enabled":true,"mode":"COMMON"}');
   req.body=body;res.status=n=>{res.statusCode=n;return res;};res.json=data=>res.end(JSON.stringify(data));return (req.method==='GET'&&req.headers['x-ara-fixture-baseline-config']==='true'?baselineHandler:handler)(req,res);
  }
  const file=path.resolve(root,u.pathname.slice(1));if(!file.startsWith(root+path.sep)||!fs.existsSync(file)){res.statusCode=404;return res.end('{}');}
  res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(file));
 }catch{res.statusCode=500;res.end('{"code":"fixture_failure"}');}
}).listen(8875,'127.0.0.1',()=>console.log('R3 single-use provider fake, actual API/REST/PG localhost 8875'));
