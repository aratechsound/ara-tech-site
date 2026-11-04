#!/usr/bin/env node
// ARA-TECH WORKS: authenticated, idempotent user-context publish CLI.
// No service-role, browser-token extraction, raw SQL updates, or new server endpoints.
import { readFile, writeFile, mkdir, rm, mkdtemp, rename } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const TOKEN_PATH = join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'ARA-TECH', 'works-publish-refresh.dpapi');
const HEX64 = /^[a-f0-9]{64}$/;
const args = process.argv.slice(2);
const cmd = args.shift();
function option(k) { const i=args.indexOf(`--${k}`); return i<0 ? undefined : args[i+1]; }
function required(k) { const v=option(k); if(!v || v.startsWith('--')) throw new Error(`missing_${k}`);return v; }
function safeError(e) { const code=String(e?.message||e).replace(/[^a-zA-Z0-9_.:-]/g,'_').slice(0,120); return {result:'HOLD',reason:code}; }
function output(data) { process.stdout.write(JSON.stringify(data,null,2)+'\n'); }

async function configuration() {
  // Import the already-public client configuration; do not embed user secrets.
  const text=await readFile(new URL('../../../../js/supabase-config.js',import.meta.url),'utf8');
  const field=(name)=>text.match(new RegExp('export const '+name+'\\s*=\\s*[\\"\\\']([^\\"\\\']+)[\\"\\\']'))?.[1];
  const url=field('SUPABASE_URL'),key=field('SUPABASE_ANON_KEY'),bucket=field('WORKS_BUCKET');
  if(!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(url) || !key?.startsWith('sb_publishable_') || !/^[a-z0-9-]+$/.test(bucket)) throw new Error('invalid_public_config');
  return {url,key,bucket};
}
async function runPS(script,input='') {
  if(process.platform !== 'win32') throw new Error('windows_dpapi_required');
  return await new Promise((resolve,reject)=>{
    const encoded=Buffer.from(`$ErrorActionPreference='Stop'; ${script}`,'utf16le').toString('base64');
    const child=spawn('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',encoded],{stdio:['pipe','pipe','pipe'],windowsHide:true});
    let stdout='',stderr='';
    child.stdout.on('data',b=>stdout+=b.toString());
    child.stderr.on('data',b=>stderr+=b.toString());
    child.on('error',()=>reject(new Error('powershell_unavailable')));
    child.on('close',code=>code===0?resolve(stdout.trim()):reject(new Error('windows_secret_operation_failed')));
    child.stdin.end(input);
  });
}
async function protect(secret) {
  return await runPS(`$t=[Console]::In.ReadToEnd(); $s=ConvertTo-SecureString -String $t -AsPlainText -Force; ConvertFrom-SecureString -SecureString $s`,secret);
}
async function unprotect(blob) {
  return await runPS(`$s=ConvertTo-SecureString -String ([Console]::In.ReadToEnd()); $p=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s); try{[Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($p))}finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p)}`,blob);
}
async function saveRefresh(refresh) {
  if(!refresh) throw new Error('no_refresh_token');
  const enc=await protect(refresh);
  await mkdir(dirname(TOKEN_PATH),{recursive:true});
  const staged=TOKEN_PATH+'.'+randomUUID()+'.tmp';
  try {
    await writeFile(staged,enc,{mode:0o600});
    await rename(staged,TOKEN_PATH);
  } finally { await rm(staged,{force:true}); }
}
async function readRefresh() {
  let blob;
  try { blob=await readFile(TOKEN_PATH,'utf8'); }
  catch { throw new Error('one_time_login_required'); }
  return await unprotect(blob);
}
async function api(cfg,path,{jwt,method='GET',body,headers={}}={}) {
  const opts={method,headers:{'apikey':cfg.key,...headers}};
  if(jwt) opts.headers.Authorization=`Bearer ${jwt}`;
  if(body!==undefined){opts.headers['content-type']='application/json';opts.body=JSON.stringify(body);}
  const response=await fetch(cfg.url+path,opts);
  if(!response.ok) throw new Error(`api_http_${response.status}`);
  return await response.json();
}
async function getSession(cfg) {
  const refresh=await readRefresh();
  const s=await api(cfg,'/auth/v1/token?grant_type=refresh_token',{method:'POST',body:{refresh_token:refresh}});
  if(!s.access_token||!s.refresh_token) throw new Error('refresh_failed');
  await saveRefresh(s.refresh_token); // rotated refresh tokens must be persisted immediately
  return s;
}
async function userContext(cfg,s) {
  const user=await api(cfg,'/auth/v1/user',{jwt:s.access_token});
  if(!user?.id) throw new Error('authenticated_user_missing');
  const arr=await api(cfg,`/rest/v1/work_admins?select=user_id&user_id=eq.${encodeURIComponent(user.id)}&limit=1`,{jwt:s.access_token,headers:{Accept:'application/json'}});
  if(!Array.isArray(arr)||arr.length!==1||arr[0].user_id!==user.id) throw new Error('work_admins_membership_missing');
  return user;
}
async function getWork(cfg,s,id) {
  const arr=await api(cfg,`/rest/v1/work_posts?select=*&id=eq.${id}&limit=1`,{jwt:s.access_token,headers:{Accept:'application/json'}});
  if(!Array.isArray(arr)||arr.length!==1) throw new Error('work_post_not_found');
  return arr[0];
}
export function isPublished(p) {return p.is_published===true && p.publication_review_status===null && p.approved_hash===p.candidate_hash && Boolean(p.approved_at&&p.approved_by);}
export function imageOmitted(p) {return p.use_image_on_public_page===false && p.image_usage_status==='not_permitted';}
export function imageAllowed(p) { return p.use_image_on_public_page===true && p.image_usage_status==='confirmed' && Boolean(p.flyer_path&&p.image_publication_confirmed_at&&p.image_publication_confirmed_by)&&HEX64.test(p.public_image_sha256||''); }
export function imageSignature(bytes,contentType) {
  if(bytes.length<32) return false;
  const jpg=bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
  const png=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  const webp=bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP';
  return (contentType==='image/jpeg'&&jpg)||(contentType==='image/png'&&png)||(contentType==='image/webp'&&webp);
}
async function imageVerified(cfg,post) {
  if(!imageAllowed(post)) throw new Error('image_confirmation_incomplete');
  if(!/^[a-zA-Z0-9/_-]+\.(jpg|jpeg|png|webp)$/.test(post.flyer_path) || post.flyer_path.includes('..')) throw new Error('invalid_storage_path');
  const p=`/storage/v1/object/public/${encodeURIComponent(cfg.bucket)}/${post.flyer_path.split('/').map(encodeURIComponent).join('/')}`;
  const res=await fetch(cfg.url+p,{headers:{apikey:cfg.key}});
  if(!res.ok) throw new Error(`stored_image_http_${res.status}`);
  const length=Number(res.headers.get('content-length')||0);
  if(length>10*1024*1024) throw new Error('image_over_10mb');
  const bytes=Buffer.from(await res.arrayBuffer());
  if(bytes.length>10*1024*1024||bytes.length===0) throw new Error('invalid_image_size');
  const contentType=String(res.headers.get('content-type')||'').split(';')[0].trim().toLowerCase();
  if(!imageSignature(bytes,contentType)) throw new Error('image_signature_invalid');
  const hash=createHash('sha256').update(bytes).digest('hex');
  if(hash!==post.public_image_sha256) throw new Error('image_sha256_mismatch');
  // Verify real decoding using Windows' native image decoder; hold for unsupported formats.
  const temp=await mkdtemp(join(tmpdir(),'ara-work-img-'));
  try {
    const imageFile=join(temp,'verify'+(contentType==='image/jpeg'?'.jpg':contentType==='image/png'?'.png':'.webp'));
    await writeFile(imageFile,bytes,{mode:0o600});
    const fileb64=Buffer.from(imageFile,'utf8').toString('base64');
    const result=await runPS(`$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${fileb64}')); Add-Type -AssemblyName System.Drawing; $i=[System.Drawing.Image]::FromFile($p); try { if($i.Width -le 0 -or $i.Height -le 0){throw 'invalid_dimensions'}; [Console]::Out.Write('DECODE_OK') } finally {$i.Dispose()}`);
    if(result!=='DECODE_OK') throw new Error('image_decode_failed');
  } finally { await rm(temp,{recursive:true,force:true}); }
  return {sha256:hash,decoded:true,bytes:bytes.length,contentType};
}
async function securePassword() {
  if(!process.stdin.isTTY||typeof process.stdin.setRawMode!=='function') throw new Error('direct_interactive_terminal_required');
  process.stdout.write('Supabase password (hidden): ');
  return await new Promise((resolve,reject)=>{
    const bytes=[];const input=process.stdin;input.setRawMode(true);input.resume();
    const end=(error)=>{input.removeListener('data',onData);input.setRawMode(false);input.pause();process.stdout.write('\n'); error?reject(error):resolve(Buffer.from(bytes).toString('utf8'));};
    function onData(buf){for(const c of buf){if(c===3){end(new Error('cancelled'));return;} if(c===13||c===10){end();return;}if(c===8||c===127)bytes.pop();else bytes.push(c);}}
    input.on('data',onData);
  });
}
async function login(cfg) {
  const email=required('email');
  const password=await securePassword();
  try {
    const session=await api(cfg,'/auth/v1/token?grant_type=password',{method:'POST',body:{email,password}});
    if(!session?.access_token||!session?.refresh_token) throw new Error('login_failed');
    const user=await userContext(cfg,session);
    await saveRefresh(session.refresh_token);
    output({result:'LOGIN_READY',user:user.email||email,session_storage:'Windows CurrentUser DPAPI',password_saved:false});
  } finally { /* password only in process memory; process exits after login */ }
}
async function inspect(cfg) {
  const id=Number(required('id'));
  if(!Number.isSafeInteger(id)||id<1) throw new Error('invalid_work_id');
  const s=await getSession(cfg); await userContext(cfg,s);
  const p=await getWork(cfg,s,id);
  output({result:'INSPECTED',id:p.id,title:p.title,event_date:p.event_date,
    venue:p.venue,performer_name:p.performer_name,description:p.description,
    is_published:p.is_published,publication_review_status:p.publication_review_status,
    candidate_hash:p.candidate_hash,approved_hash:p.approved_hash,approved_at:p.approved_at,
    image_usage_status:p.image_usage_status,use_image_on_public_page:p.use_image_on_public_page,
    flyer_path:p.flyer_path,public_image_sha256:p.public_image_sha256,
    image_publication_confirmed_at:p.image_publication_confirmed_at,
    official_announcement_url:p.official_announcement_url});
}
export async function publishWithRuntime({id,expected,owner,authorize,readWork,verifyImage,callRpc}) {
  if(!Number.isSafeInteger(id)||id<1||!HEX64.test(expected)||!owner?.trim()||owner.length>200) throw new Error('invalid_review_pin');
  const user=await authorize();
  if(!user?.id) throw new Error('authenticated_user_missing');
  const before=await readWork(id);
  if(before.candidate_hash!==expected) throw new Error('candidate_changed');
  if(isPublished(before)) return {result:'ALREADY_PUBLISHED',workId:id,slug:before.slug,ownerRef:owner};
  if(before.is_published||before.publication_review_status!=='publication_pending_approval') throw new Error('invalid_publication_state');
  const image=imageOmitted(before)?{sha256:null,decoded:true,omitted:true}:await verifyImage(before);
  if(!image.omitted && (image.decoded!==true || image.sha256!==before.public_image_sha256)) throw new Error('image_sha256_mismatch');
  const latest=await readWork(id);
  const unchanged=['flyer_path','public_image_sha256','public_image_source_url','image_usage_status','use_image_on_public_page'].every(k=>latest[k]===before[k]);
  if(latest.candidate_hash!==expected||!unchanged||!(imageAllowed(latest)||imageOmitted(latest))||latest.is_published||latest.publication_review_status!=='publication_pending_approval') throw new Error('candidate_changed_after_image_verification');
  let callResult='UNKNOWN';
  try { const data=await callRpc({p_work_id:id,p_candidate_hash:expected}); const item=Array.isArray(data)?data[0]:data;callResult=item?.result||'UNKNOWN'; } catch { /* read back; never retry */ }
  let after;
  try { after=await readWork(id); } catch { return {result:'HOLD',workId:id,reason:'post_rpc_readback_failed',rpcResult:callResult,rpcAttempts:1}; }
  const sameImage=['flyer_path','public_image_sha256','public_image_source_url','image_usage_status','use_image_on_public_page'].every(k=>after[k]===latest[k]);
  if(isPublished(after)&&after.approved_by===user.id&&sameImage&&(image.omitted||after.public_image_sha256===image.sha256)) return {result:'PUBLISHED',workId:id,slug:after.slug,approvedAt:after.approved_at,ownerRef:owner,imageSha256:image.sha256,dbReadback:'PASS',rpcResult:callResult};
  return {result:'HOLD',workId:id,reason:'publication_not_confirmed',rpcResult:callResult,rpcAttempts:1,isPublished:after.is_published,reviewStatus:after.publication_review_status};
}
async function publish(cfg) {
  const id=Number(required('id'));const expected=required('hash');const owner=required('owner-ref');
  let session;
  const result=await publishWithRuntime({id,expected,owner,
    authorize:async()=>{session=await getSession(cfg);return await userContext(cfg,session);},
    readWork:(workId)=>getWork(cfg,session,workId),verifyImage:(p)=>imageVerified(cfg,p),
    callRpc:(body)=>api(cfg,'/rest/v1/rpc/publish_work_candidate',{jwt:session.access_token,method:'POST',body})});
  output(result);if(result.result==='HOLD')process.exitCode=2;
}
async function main() {
  const cfg=await configuration();
  if(cmd==='login') return await login(cfg);
  if(cmd==='logout'){await rm(TOKEN_PATH,{force:true});output({result:'LOGGED_OUT'});return;}
  if(cmd==='status'){const s=await getSession(cfg);const u=await userContext(cfg,s);output({result:'AUTHORIZED',user:u.email,admin:true});return;}
  if(cmd==='inspect') return await inspect(cfg);
  if(cmd==='publish') return await publish(cfg);
  output({usage:[
    'node scripts/works-publish-cli.mjs login --email user@example.com',
    'node scripts/works-publish-cli.mjs status',
    'node scripts/works-publish-cli.mjs inspect --id 99',
    'node scripts/works-publish-cli.mjs publish --id 99 --hash <64-char-hash> --owner-ref <explicit-owner-instruction>',
    'node scripts/works-publish-cli.mjs logout'
  ]});
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  main().catch(e=>{output(safeError(e));process.exitCode=1;});
}
