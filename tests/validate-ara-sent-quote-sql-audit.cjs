'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {setup}=require('./validate-pam-025-direct-confirmation.cjs');
const read=n=>fs.readFileSync(path.join(__dirname,'../ops',n),'utf8');
async function main({overlay}={}){global.fetch=async()=>{throw Error('LIVE_NETWORK_FORBIDDEN');};const checks={};
 for(const [name,file,hash,signature,object] of [
  ['A','PAUI-057-sent-quote-adoption.sql','e36ab87ad98dd867e694178976f2fbe3409f9e4212799be58687236ecc795779','pa_sent_quote_adopt_v1(uuid,uuid,uuid,jsonb,jsonb,text)','pa_sent_quote_adoptions_v1'],
  ['B','PAUI-056-document-read.sql','913cf91d88b404f641f5825752f110e864a1a4e8f566655a83b4710cb29f475b','pa_reply_document_list_v1(uuid,uuid)',null]]){
  const f=await setup();try{
   await f.db.exec(read('PAUI-051-change-evidence.sql'));if(overlay)await f.db.exec(overlay);const text=read(file);assert.equal(crypto.createHash('sha256').update(text).digest('hex'),hash);
   const digest=async()=>JSON.stringify((await f.db.query("select (select jsonb_agg(to_jsonb(c) order by id) from pa_contracts c) contracts,(select jsonb_agg(to_jsonb(e) order by id) from pa_estimate_revisions e) estimates,(select jsonb_agg(to_jsonb(x) order by id) from pa_change_evidence_events x) adoption,(select jsonb_agg(to_jsonb(b) order by id) from pa_billings b) billing,(select jsonb_agg(to_jsonb(p) order by id) from pa_payment_records p) payments,(select jsonb_agg(to_jsonb(j) order by id) from pa_commercial_outbox j) outbox")).rows);
   const before=await digest();
   await assert.rejects(f.db.exec(text.replace(/commit;\s*$/u,"select public.fixture_058_install_failure();commit;")),err=>err.code==='42883');await f.db.exec('rollback');
   assert.equal((await f.db.query('select to_regprocedure($1) v',[signature])).rows[0].v,null,'failed install has no callable residue');
   if(object)assert.equal((await f.db.query('select to_regclass($1) v',[object])).rows[0].v,null,'table creation rolled back');
   await f.db.exec(text);assert.equal(await digest(),before);
   const def=(await f.db.query('select pg_get_functiondef(to_regprocedure($1)) v',[signature])).rows[0].v;
   await assert.rejects(f.db.exec(text),err=>['42P07','42723'].includes(err.code));await f.db.exec('rollback');assert.equal((await f.db.query('select pg_get_functiondef(to_regprocedure($1)) v',[signature])).rows[0].v,def,'repeat install safely refuses rather than replaces');assert.equal(await digest(),before);
   const rights=(await f.db.query("select p.prosecdef,p.proconfig,p.provolatile,has_function_privilege('service_role',p.oid,'EXECUTE') service,has_function_privilege('anon',p.oid,'EXECUTE') anon,has_function_privilege('authenticated',p.oid,'EXECUTE') authenticated,exists(select 1 from aclexplode(p.proacl) a where a.grantee=0 and a.privilege_type='EXECUTE') public from pg_proc p where p.oid=to_regprocedure($1)",[signature])).rows[0];
   assert.equal(rights.prosecdef,true);assert(rights.proconfig.includes('search_path=""'));assert.equal(rights.service,true);assert.equal(rights.anon,false);assert.equal(rights.authenticated,false);assert.equal(rights.public,false);
   const call=name==='A'?"select pa_sent_quote_adopt_v1(null,null,null,'{}','{}','')":"select pa_reply_document_list_v1(null,null)";
   await assert.rejects(f.db.exec(call),/not_authorized/);
   for(const role of ['anon','authenticated']){await f.db.exec('begin;set local role '+role);try{await assert.rejects(f.db.exec(call),err=>err.code==='42501');}finally{await f.db.exec('rollback');}}
   if(name==='A'){
    const table=(await f.db.query("select relrowsecurity,has_table_privilege('service_role',oid,'SELECT') sel,has_table_privilege('service_role',oid,'INSERT,UPDATE,DELETE') write,has_table_privilege('anon',oid,'SELECT') anon,has_table_privilege('authenticated',oid,'SELECT') authenticated from pg_class where oid='pa_sent_quote_adoptions_v1'::regclass")).rows[0];assert.deepEqual(table,{relrowsecurity:true,sel:true,write:false,anon:false,authenticated:false});
   }else{
    assert.equal(rights.provolatile,'s');const other=crypto.randomUUID();await f.db.query('insert into work_admins(user_id) values($1)',[other]);
    async function seed(actor,caseId,kind,state='SENT'){
     const id=crypto.randomUUID(),binding={attachments:[{document_kind:kind}],marker:'Synthetic classification only'};
     await f.db.query("insert into pa_reply_operations_v1(operation_id,inquiry_id,actor_id,account,binding,binding_hash,rfc_message_id) values($1,$2,$3,'aratechsound@gmail.com',$4,repeat('a',64),$5)",[id,caseId,actor,binding,'<'+id+'@fixture.invalid>']);
     await f.db.query('insert into pa_reply_operation_events_v1(operation_id,state,evidence) values($1,$2,$3)',[id,state,{gmail_message_id:'synthetic_sent',history_sync:'COMPLETE'}]);return id;
    }
    const quote=await seed(f.actor.id,f.inquiryId,'estimate'),invoice=await seed(f.actor.id,f.inquiryId,'invoice','UNKNOWN');
    await seed(f.actor.id,f.inquiryId,'normal');await seed(other,f.inquiryId,'estimate');
    const otherCase=(await f.db.query('select id from pa_inquiries where id<>$1 limit 1',[f.inquiryId])).rows[0].id;await seed(f.actor.id,otherCase,'estimate');
    const opBefore=JSON.stringify((await f.db.query('select to_jsonb(o) from pa_reply_operations_v1 o order by operation_id')).rows),evBefore=JSON.stringify((await f.db.query('select to_jsonb(e) from pa_reply_operation_events_v1 e order by seq')).rows);
    await f.db.exec('begin transaction read only;set local role service_role');let result;try{result=(await f.db.query('select pa_reply_document_list_v1($1,$2) v',[f.actor.id,f.inquiryId])).rows[0].v;}finally{await f.db.exec('rollback');}
    assert.deepEqual(new Set(result.operations.map(o=>o.operation_id)),new Set([quote,invoice]));assert.equal(result.operations.find(o=>o.operation_id===invoice).state,'UNKNOWN','reader never reports UNKNOWN as sent');
    assert.equal(JSON.stringify((await f.db.query('select to_jsonb(o) from pa_reply_operations_v1 o order by operation_id')).rows),opBefore);assert.equal(JSON.stringify((await f.db.query('select to_jsonb(e) from pa_reply_operation_events_v1 e order by seq')).rows),evBefore);
    await f.db.query('update pa_inquiries set deleted_at=now() where id=$1',[otherCase]);await assert.rejects(f.db.query('select pa_reply_document_list_v1($1,$2)',[f.actor.id,otherCase]),/inquiry_not_found/);
    for(let i=0;i<22;i++)await seed(f.actor.id,f.inquiryId,'estimate');assert.equal((await f.db.query('select pa_reply_document_list_v1($1,$2) v',[f.actor.id,f.inquiryId])).rows[0].v.operations.length,21);
   }
   checks[name]={hash_match:true,atomic_install:true,repeated_install_refuses_without_change:true,existing_business_rows_unchanged:true,service_role_only:true,empty_search_path:true,...(name==='B'?{stable_read_only_execution:true,case_actor_kind_filter:true,unknown_preserved:true,limit_21:true}:{rls:true,direct_writes_revoked:true})};
  }finally{await f.db.close();}
 }
 console.log(JSON.stringify({status:'PASS',independent_sql_audits:checks,production_apply:0,real_sends:0}));
}
if(require.main===module)main().catch(e=>{console.error(e);process.exitCode=1;});
module.exports={main};
