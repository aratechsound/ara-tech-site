const assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path');
const {createStaffFixture}=require('./helpers/emp001-staff-fixture.cjs'),staff=require('../api/_pa-portal-staff.cjs');
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
async function main(){
 delete process.env.PA_STAFF_LINK_KEYRING_JSON;delete process.env.PA_STAFF_LINK_ACTIVE_KEY_ID;process.env.SUPABASE_URL='https://fixture.invalid';process.env.SUPABASE_SERVICE_ROLE_KEY='FIXTURE_ONLY_NOT_A_CREDENTIAL';
 const {db,actor,outsider,caseA,q}=await createStaffFixture();const calls=[];
 try{
  const fetchFixture=async(url,options)=>{const name=new URL(url).pathname.split('/').at(-1);assert.equal(name,'pa_portal_staff_manage_link');assert(options.headers.authorization==='Bearer FAKE_ADMIN_JWT');const input=JSON.parse(options.body);assert(!('p_envelope'in input));calls.push(Object.keys(input));const keys=Object.keys(input),result=await q(`select public.${name}(${keys.map((k,i)=>`${k}=>$${i+1}`).join(',')}) result`,keys.map(k=>input[k]));return new Response(JSON.stringify(result),{status:200,headers:{'content-type':'application/json'}});};
  const manage=(grade,action)=>staff.manageLink({accessToken:'FAKE_ADMIN_JWT',caseId:caseA,grade,action},fetchFixture);
  const initial=await manage('GENERAL','status');assert(!initial.active);assert(!('share_url'in initial));
  const issued=await manage('GENERAL','create');assert(issued.active&&/^\/staff-portal#[a-f0-9]{64}$/.test(issued.share_url),'create returns one-time URL with no encryption env');
  const raw=issued.share_url.split('#')[1],row=(await db.query('select * from pa_portal_staff_links where token_hash=$1',[hash(raw)])).rows[0];assert(row&&row.grade==='GENERAL');assert(!JSON.stringify(row).includes(raw));assert(!Object.keys(row).some(k=>/^token_(ciphertext|iv|key_id|encryption_version)$/.test(k)));
  const status=await manage('GENERAL','status');assert(status.active&&!('share_url'in status),'status exposes metadata only');assert(!('share_url'in await manage('GENERAL','status')),'independent request cannot recover URL');
  await db.exec('set role authenticated');assert((await manage('GENERAL','status')).active,'M1 admin RPC remains executable');await db.exec('reset role');
  const rotated=await manage('GENERAL','rotate');assert(rotated.active&&rotated.share_url!==issued.share_url);assert((await db.query('select revoked_at from pa_portal_staff_links where token_hash=$1',[hash(raw)])).rows[0].revoked_at);
  await manage('GENERAL','revoke');assert(!(await manage('GENERAL','status')).active);
  await db.exec(`select set_config('request.jwt.claim.sub','${outsider}',false)`);await assert.rejects(manage('GENERAL','status'),/not_authorized/);await db.exec(`select set_config('request.jwt.claim.sub','${actor}',false)`);
  assert.equal((await db.query("select count(*) n from pg_proc where proname in ('pa_portal_staff_manage_link_v2','pa_portal_staff_link_envelope')")).rows[0].n,0);
  const root=path.resolve(__dirname,'..');assert(!fs.existsSync(path.join(root,'supabase/migrations/20261006020000_emp001_staff_link_redisplay.sql')));assert(!fs.existsSync(path.join(root,'api/_pa-staff-link-crypto.cjs')));assert(!fs.existsSync(path.join(root,'js/portal-qr.mjs')));
  console.log('EMP001 URL MVP PASS: key-free M1 creation/rotation/status, one-time URL, hash-only DB, authenticated work-admin guard, no M2/envelope/cipher/QR runtime');
 }finally{await db.close();}
}
main().catch(e=>{console.error('EMP001 URL MVP FAIL: '+String(e.message).replace(/[a-f0-9]{36,}/gi,'[REDACTED]').replace(/https?:\/\/\S+/g,'[URL]'));console.error(String(e.stack).split('\n').filter(l=>l.includes('validate-emp001-url-mvp')).join('\n'));process.exitCode=1;});

