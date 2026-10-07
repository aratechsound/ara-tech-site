const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {createStaffFixture}=require('./helpers/emp001-staff-fixture.cjs');
const hash=s=>crypto.createHash('sha256').update(s).digest('hex'),secret=()=>crypto.randomBytes(32).toString('hex');
const checks=[];
async function main(){const{db,actor,outsider,caseA,caseB,q}=await createStaffFixture();try{
 await db.exec("alter table pa_inquiries add column status text default 'schedule_confirmed'");
 const legacy=secret();await q("select pa_portal_staff_manage_link($1,'GENERAL','create',$2,null,null,null) result",[caseA,hash(legacy)]);
 const before=(await db.query('select * from pa_portal_staff_links')).rows[0];
 for(const name of ['20261008010000_emp017_staff_link_redisplay.sql','20261008020000_emp017_staff_category_projection.sql','20261008030000_emp017_organizer_staff_authorization.sql'])await db.exec(fs.readFileSync(path.resolve(__dirname,'../supabase/migrations',name),'utf8'));
 const after=(await db.query('select * from pa_portal_staff_links')).rows[0];assert.deepEqual({...after,token_plaintext:undefined},{...before,token_plaintext:undefined});assert.equal(after.token_plaintext,null);
 const admin=(action,raw=null,caseId=caseA,grade='GENERAL')=>q('select pa_portal_staff_manage_link_v2($1,$2,$3,$4,null,null,null,$5) result',[caseId,grade,action,raw?hash(raw):null,raw]);
 const token=(caseId=caseA,grade='GENERAL',id=null,digest=null)=>q('select pa_portal_staff_link_token($1,$2,$3,$4) result',[caseId,grade,id,digest]);
 assert.equal((await token()).token_plaintext,null);checks.push('legacy ACTIVE/hash/expiry/identity unchanged; plaintext null');
 const oToken=secret(),oSession=secret();await q("select pa_portal_manage_link($1,'create',$2,null) result",[caseA,hash(oToken)]);await q("select pa_portal_exchange($1,$2,now()+interval '12 hours') result",[hash(oToken),hash(oSession)]);
 const portalA=(await db.query('select public_ref from pa_portals where case_id=$1',[caseA])).rows[0].public_ref;
 const org=(action,raw=null,caseId=null,ref=null,grade='GENERAL',id=null,digest=null)=>q('select pa_portal_organizer_staff_manage_link($1,$2,$3,$4,$5,$6,$7,$8,$9) result',[hash(oSession),grade,action,caseId,ref,raw?hash(raw):null,raw,id,digest]);
 await db.query("select set_config('request.jwt.claim.sub',$1,false)",[outsider]);
 for(const action of ['status','stored_token','create','rotate','revoke']){assert.equal((await org(action,null,caseB)).ok,false);assert.equal((await org(action,null,null,'tampered')).ok,false);}
 assert.equal((await org('status',null,caseA,portalA)).ok,true);assert.equal((await q('select count(*) result from work_admins where user_id=$1',[outsider])),0);
 await assert.rejects(token(),/not_authorized/);await assert.rejects(admin('status'),/not_authorized/);checks.push('organizer same-event only; cross case/portal and non-admin token RPC DENY');
 const raw=secret();assert.equal((await org('rotate',raw)).ok,true);const stored=await org('stored_token');assert.equal(stored.token_plaintext,raw);assert.equal(stored.token_hash,hash(raw));
 assert.equal((await org('stored_token',null,null,null,'GENERAL',stored.link_id,stored.token_hash)).ok,true);
 assert.equal((await org('stored_token',null,null,null,'TECHNICAL')).ok,false);
 const publicSession=secret();assert.equal((await q('select pa_portal_staff_exchange($1,$2) result',[hash(raw),hash(publicSession)])).ok,true);
 const read=await q('select pa_portal_staff_read($1) result',[hash(publicSession)]);assert.equal(read.ok,true);assert(!JSON.stringify(read).includes(raw));assert(!JSON.stringify(await org('status')).includes(raw));
 assert(!JSON.stringify((await db.query('select * from pa_portal_collaboration_audit')).rows).includes(raw));checks.push('plaintext persisted and redisplayed; auth uses hash; status/staff read/audit omit raw');
 const next=secret();await org('rotate',next);assert.equal((await org('stored_token')).token_plaintext,next);
 assert.equal((await org('stored_token',null,null,null,'GENERAL',stored.link_id,stored.token_hash)).ok,false);
 assert.equal((await q('select pa_portal_staff_exchange($1,$2) result',[hash(raw),hash(secret())])).ok,false);
 assert.equal((await q('select pa_portal_staff_read($1) result',[hash(publicSession)])).ok,false);
 await org('revoke');assert.equal((await org('stored_token')).ok,false);checks.push('rotate old URL/session DENY; same-identity recheck; revoke DENY');
 const expired=secret();await org('create',expired);await db.query("update pa_portal_staff_links set created_at=now()-interval '2 days',expires_at=now()-interval '1 day' where token_hash=$1",[hash(expired)]);assert.equal((await org('stored_token')).ok,false);
 await db.query('update pa_portal_sessions set revoked_at=now() where session_hash=$1',[hash(oSession)]);assert.equal((await org('stored_token')).ok,false);
 await db.query("update pa_portal_sessions set revoked_at=null,created_at=now()-interval '2 days',expires_at=now()-interval '1 day' where session_hash=$1",[hash(oSession)]);assert.equal((await org('stored_token')).ok,false);
 await db.query("update pa_portal_sessions set created_at=now(),expires_at=now()+interval '1 hour' where session_hash=$1",[hash(oSession)]);await assert.rejects(db.query("update pa_portal_access_links set role='viewer' where token_hash=$1",[hash(oToken)]),/check constraint/);await db.query('update pa_portal_access_links set revoked_at=now() where token_hash=$1',[hash(oToken)]);assert.equal((await org('stored_token')).ok,false);await db.query('update pa_portal_access_links set revoked_at=null where token_hash=$1',[hash(oToken)]);checks.push('expired staff link/organizer session, revoked session/access link and wrong organizer role DENY');
 await db.query("select set_config('request.jwt.claim.sub',$1,false)",[actor]);
 const adminRaw=secret();await admin('create',adminRaw,caseB,'TECHNICAL');assert.equal((await token(caseB,'TECHNICAL')).token_plaintext,adminRaw);
 await assert.rejects(q("select pa_portal_staff_manage_link_v2($1,'GENERAL','rotate',$2,null,null,null,$3) result",[caseA,hash(secret()),secret()]),/invalid_token/);
 await assert.rejects(db.query('update pa_portal_staff_links set token_plaintext=$1 where token_hash=$2',[secret(),hash(adminRaw)]),/check constraint/);checks.push('admin issuance/redisplay without keys; SQL plaintext/hash mismatch DENY');
 for(const role of ['anon','authenticated'])assert.equal(await q("select has_function_privilege($1,'pa_portal_organizer_staff_manage_link(text,text,text,uuid,text,text,text,uuid,text)','execute') result",[role]),false);
 for(const role of ['anon','authenticated']){await db.exec('set role '+role);await assert.rejects(db.query('select token_plaintext from pa_portal_staff_links'),/permission denied/);await assert.rejects(db.query('update pa_portal_staff_links set revoked_at=now()'),/permission denied/);await db.exec('reset role');}
 assert.equal(await q("select has_function_privilege('anon','pa_portal_staff_link_token(uuid,text,uuid,text)','execute') result"),false);checks.push('plaintext table SELECT/write DENY; organizer RPC service-only; public token RPC DENY');
 // Both grades are revoked by the direct dependency on CASE status=closed.
 const closing=secret();await org('rotate',closing);const closeSession=secret();await q('select pa_portal_staff_exchange($1,$2) result',[hash(closing),hash(closeSession)]);
 await db.query("update pa_inquiries set status='closed' where id=$1",[caseA]);assert.equal((await org('stored_token')).ok,false);assert.equal((await token()).ok,false);
 assert.equal((await q('select pa_portal_staff_exchange($1,$2) result',[hash(closing),hash(secret())])).ok,false);assert.equal((await q('select pa_portal_staff_read($1) result',[hash(closeSession)])).ok,false);
 assert.equal(await q('select count(*) result from pa_portal_staff_links l join pa_portals p on p.id=l.portal_id where p.case_id=$1 and l.revoked_at is null',[caseA]),0);
 await assert.rejects(admin('create',secret()),/portal_not_found/);assert.equal((await token(caseB,'TECHNICAL')).token_plaintext,adminRaw);checks.push('CASE close revokes target staff URL/session; exchange/read/redisplay/create DENY; other case retained');
 console.log(JSON.stringify({pass:true,checks,production_requests:0},null,2));
}finally{await db.close();}}
main().catch(e=>{console.error(JSON.stringify({failed:true,completed:checks,location:e.stack?.split('\n').slice(1,3)}));process.exitCode=1;});
