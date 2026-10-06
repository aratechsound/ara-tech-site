const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {createStaffFixture}=require('./helpers/emp001-staff-fixture.cjs');
const envelopeCrypto=require('../api/_pa-staff-link-crypto.cjs');
const hash=s=>crypto.createHash('sha256').update(s).digest('hex'),secret=()=>crypto.randomBytes(32).toString('hex');
const root=path.resolve(__dirname,'..'),checks=[];
async function main(){const{db,actor,outsider,caseA,caseB,q}=await createStaffFixture();try{
 const admin=(grade,action,token=null,caseId=caseA)=>q('select pa_portal_staff_manage_link($1,$2,$3,$4,null,null,null) result',[caseId,grade,action,token?hash(token):null]);
 const legacy=secret(),technical=secret();await admin('GENERAL','create',legacy);await admin('TECHNICAL','create',technical);
 const gSession=secret(),tSession=secret();await q('select pa_portal_staff_exchange($1,$2) result',[hash(legacy),hash(gSession)]);await q('select pa_portal_staff_exchange($1,$2) result',[hash(technical),hash(tSession)]);
 const portalA=(await db.query('select id,public_ref from pa_portals where case_id=$1',[caseA])).rows[0],portalB=(await db.query('select id,public_ref from pa_portals where case_id=$1',[caseB])).rows[0];
 const references={};
 for(const category of ['timetable','script','layout','other','performer']){
  let card=(await db.query('select id from pa_portal_document_cards where portal_id=$1 and category=$2',[portalA.id,category])).rows[0];
  if(!card)card=(await db.query("insert into pa_portal_document_cards(portal_id,category,title,card_kind,owner_kind) values($1,$2,'misleading title timetable','collection','shared') returning id",[portalA.id,category])).rows[0];
  const v=(await db.query("insert into pa_portal_document_versions(card_id,source_type,source_key,source_ref,display_filename,mime_type,contributor_kind) values($1,'portal_upload',$2,'{}','misleading-script.pdf','application/pdf','shared') returning id,public_ref",[card.id,crypto.randomUUID()])).rows[0];
  await db.query('update pa_portal_document_cards set current_version_id=$1 where id=$2',[v.id,card.id]);references[category]=v.public_ref;
 }
 await db.query("insert into pa_portal_photo_items(portal_id,source_type,source_key,source_ref,display_filename,mime_type,contributor_kind) values($1,'portal_upload','photo','{}','misleading-other.png','image/png','shared')",[portalA.id]);
 const read=raw=>q('select pa_portal_staff_read($1) result',[hash(raw)]),beforeG=await read(gSession),beforeT=await read(tSession);
 const migrationNames=['20261007010000_emp014_staff_link_redisplay.sql','20261007020000_emp014_staff_category_projection.sql','20261007030000_emp014_organizer_staff_authorization.sql'];
 for(const name of migrationNames)await db.exec(fs.readFileSync(path.join(root,'supabase/migrations',name),'utf8'));
 const strip=model=>({...model,portal:{...model.portal,documents:model.portal.documents.map(({category,...rest})=>rest)}});
 const afterG=await read(gSession),afterT=await read(tSession);assert.deepEqual(strip(afterG),beforeG);assert.deepEqual(strip(afterT),beforeT);
 assert.deepEqual(new Set(afterT.portal.documents.map(d=>d.category)),new Set(['timetable','script','layout','photo','other','performer']));
 assert(!afterG.portal.documents.some(d=>d.category==='performer'));assert.equal((await q('select pa_portal_staff_asset($1,$2,$3) result',[hash(gSession),references.performer,'version'])).ok,false);assert.equal((await q('select pa_portal_staff_asset($1,$2,$3) result',[hash(tSession),references.performer,'version'])).ok,true);checks.push('B canonical categories and exact backward projection; GENERAL performer DENY; TECHNICAL VIEW');
 assert.equal((await q('select pa_portal_staff_link_envelope($1,$2,null,null) result',[caseA,'GENERAL'])).ciphertext,null);assert.equal((await db.query('select token_hash from pa_portal_staff_links where portal_id=$1 and grade=$2 and revoked_at is null',[portalA.id,'GENERAL'])).rows[0].token_hash,hash(legacy));checks.push('legacy hash-only ACTIVE identity preserved');
 const oToken=secret(),oSession=secret();await q("select pa_portal_manage_link($1,'create',$2,null) result",[caseA,hash(oToken)]);await q("select pa_portal_exchange($1,$2,now()+interval '12 hours') result",[hash(oToken),hash(oSession)]);
 const org=(action,grade='GENERAL',extra={})=>q('select pa_portal_organizer_staff_manage_link($1,$2,$3,$4,$5,$6,$7,$8,$9) result',[hash(oSession),grade,action,extra.caseId||null,extra.portalRef||null,extra.tokenHash||null,extra.envelope||null,extra.expectedLinkId||null,extra.expectedTokenHash||null]);
 await db.query("select set_config('request.jwt.claim.sub',$1,false)",[outsider]);
 assert.equal((await org('status')).ok,true);assert.equal((await org('status','GENERAL',{caseId:caseA,portalRef:portalA.public_ref})).ok,true);
 for(const action of ['status','envelope','create','rotate','revoke']){assert.equal((await org(action,'GENERAL',{caseId:caseB})).ok,false);assert.equal((await org(action,'GENERAL',{portalRef:portalB.public_ref})).ok,false);}
 assert.equal((await org('status','GENERAL',{portalRef:'tampered'})).ok,false);assert.equal((await q('select count(*) result from work_admins where user_id=$1',[outsider])),0);checks.push('A own event PASS without admin authority; cross event/case/tampered portal DENY for every management action');
 await assert.rejects(q("select pa_portal_staff_manage_link_v2($1,'GENERAL','status',null,null,null,null,null) result",[caseA]),/not_authorized/);
 await assert.rejects(q("select pa_portal_staff_link_envelope($1,'GENERAL',null,null) result",[caseA]),/not_authorized/);
 const env={PA_STAFF_LINK_ACTIVE_KEY_ID:'test_v1',PA_STAFF_LINK_KEYRING_JSON:JSON.stringify({test_v1:crypto.randomBytes(32).toString('base64')})};
 const issue=async(action,grade)=>{const raw=secret(),bound={link_id:crypto.randomUUID(),case_id:caseA,grade,token_hash:hash(raw)},sealed=envelopeCrypto.seal(raw,bound,env);assert.equal((await org(action,grade,{tokenHash:hash(raw),envelope:sealed})).ok,true);return{raw,bound,sealed};};
 const issued=await issue('rotate','GENERAL');let envelope=await org('envelope');assert.equal(envelopeCrypto.open(envelope,env),issued.raw);
 for(const altered of [{...envelope,case_id:caseB},{...envelope,grade:'TECHNICAL'},{...envelope,token_hash:'a'.repeat(64)},{...envelope,link_id:crypto.randomUUID()},{...envelope,iv:'0'.repeat(24)},{...envelope,ciphertext:envelope.ciphertext.replace(/^./,envelope.ciphertext[0]==='a'?'b':'a')}])assert.throws(()=>envelopeCrypto.open(altered,env),/staff_url_unavailable/);
 assert.throws(()=>envelopeCrypto.open(envelope,{}),/staff_url_unavailable/);assert.throws(()=>envelopeCrypto.seal(secret(),issued.bound,env),/staff_url_unavailable/);checks.push('C reused AES-GCM: roundtrip, event/grade/hash/link/IV/ciphertext tamper and missing-key DENY');
 assert.equal((await org('envelope','GENERAL',{expectedLinkId:issued.bound.link_id,expectedTokenHash:issued.bound.token_hash})).ok,true);
 const linkSession=secret();await q('select pa_portal_staff_exchange($1,$2) result',[issued.bound.token_hash,hash(linkSession)]);
 await issue('rotate','GENERAL');assert.equal((await org('envelope','GENERAL',{expectedLinkId:issued.bound.link_id,expectedTokenHash:issued.bound.token_hash})).ok,false);assert.equal((await read(linkSession)).ok,false);assert.equal((await read(gSession)).ok,false);assert.equal((await read(tSession)).ok,true);
 await org('revoke');assert.equal((await org('envelope')).ok,false);checks.push('rotate/revoke post-decrypt identity recheck and old staff session DENY; independent TECHNICAL unchanged');
 const expires=await issue('create','GENERAL'),expSession=secret();await q('select pa_portal_staff_exchange($1,$2) result',[expires.bound.token_hash,hash(expSession)]);
 await db.query("update pa_portal_staff_links set created_at=now()-interval '2 days',expires_at=now()-interval '1 day' where token_hash=$1",[expires.bound.token_hash]);assert.equal((await org('envelope')).ok,false);assert.equal((await read(expSession)).ok,false);checks.push('expired staff link redisplay/read DENY');
 await db.query('update pa_portal_sessions set revoked_at=now() where session_hash=$1',[hash(oSession)]);for(const a of ['status','envelope','create','rotate','revoke'])assert.equal((await org(a)).ok,false);
 await db.query("update pa_portal_sessions set revoked_at=null,created_at=now()-interval '2 days',expires_at=now()-interval '1 day' where session_hash=$1",[hash(oSession)]);assert.equal((await org('status')).ok,false);
 await db.query("update pa_portal_sessions set created_at=now(),expires_at=now()+interval '1 hour' where session_hash=$1",[hash(oSession)]);await db.query('update pa_portal_access_links set revoked_at=now() where token_hash=$1',[hash(oToken)]);assert.equal((await org('status')).ok,false);
 await db.query("update pa_portal_access_links set revoked_at=null,created_at=now()-interval '2 days',expires_at=now()-interval '1 day' where token_hash=$1",[hash(oToken)]);assert.equal((await org('status')).ok,false);checks.push('expired/revoked organizer session and access link DENY');
 await db.query("update pa_portal_access_links set created_at=now(),expires_at=null where token_hash=$1",[hash(oToken)]);await db.query("update pa_inquiries set case_type='AUDIO_INSTALL' where id=$1",[caseA]);assert.equal((await org('status')).ok,false);await db.query("update pa_inquiries set case_type='PA_EVENT',deleted_at=now() where id=$1",[caseA]);assert.equal((await org('status')).ok,false);await db.query('update pa_inquiries set deleted_at=null where id=$1',[caseA]);checks.push('non-event/deleted case DENY');
 await db.query("select set_config('request.jwt.claim.sub',$1,false)",[actor]);
 const adminRaw=secret(),adminBound={link_id:crypto.randomUUID(),case_id:caseB,grade:'TECHNICAL',token_hash:hash(adminRaw)};
 const adminSealed=envelopeCrypto.seal(adminRaw,adminBound,env);
 await q("select pa_portal_staff_manage_link_v2($1,'TECHNICAL','create',$2,null,null,null,$3) result",[caseB,adminBound.token_hash,adminSealed]);
 const adminEnvelope=await q("select pa_portal_staff_link_envelope($1,'TECHNICAL',$2,$3) result",[caseB,adminBound.link_id,adminBound.token_hash]);assert.equal(envelopeCrypto.open(adminEnvelope,env),adminRaw);
 const adminSession=secret();await q('select pa_portal_staff_exchange($1,$2) result',[adminBound.token_hash,hash(adminSession)]);
 await q("select pa_portal_staff_manage_link_v2($1,'TECHNICAL','revoke',null,null,null,null,null) result",[caseB]);assert.equal((await read(adminSession)).ok,false);assert.equal((await q("select pa_portal_staff_link_envelope($1,'TECHNICAL',null,null) result",[caseB])).ok,false);checks.push('admin v2 SQL encrypted issuance/redisplay/revoke PASS; non-admin v2/envelope DENY');
 for(const role of ['anon','authenticated']){assert.equal((await q("select has_function_privilege($1,'pa_portal_organizer_staff_manage_link(text,text,text,uuid,text,text,jsonb,uuid,text)','execute') result",[role])),false);}
 assert.equal((await q("select has_function_privilege('service_role','pa_portal_organizer_staff_manage_link(text,text,text,uuid,text,text,jsonb,uuid,text)','execute') result")),true);
 await db.exec('set role anon');await assert.rejects(db.query('update pa_portal_staff_links set revoked_at=now()'),/permission denied/);await db.exec('reset role');checks.push('organizer RPC service-only; staff direct write DENY');
 const stored=JSON.stringify((await db.query('select * from pa_portal_staff_links')).rows);assert(!stored.includes(issued.raw));const audited=JSON.stringify((await db.query('select * from pa_portal_collaboration_audit')).rows);assert(!audited.includes(issued.raw));assert((await q("select count(*) result from pa_portal_collaboration_audit where actor_kind='organizer' and action like 'staff_link_%' and success"))>=3);checks.push('encrypted DB envelope only; existing organizer audit records lifecycle without plaintext');
 console.log(JSON.stringify({pass:true,checks,production_requests:0},null,2));
}finally{await db.close();}}
main().catch(e=>{console.error('EMP014 boundary failed:',e.message);process.exitCode=1;});
