const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require(process.env.PA_PGLITE_MODULE || '@electric-sql/pglite');
const { pgcrypto } = require(process.env.PA_PGLITE_MODULE ? path.join(process.env.PA_PGLITE_MODULE,'dist/contrib/pgcrypto.cjs') : '@electric-sql/pglite/contrib/pgcrypto');
const root = path.resolve(__dirname,'../..');
const actor = '123e4567-e89b-42d3-a456-426614174001';
const migrations = ['2026-07-23-pa-inquiry-management.sql','2026-07-23-pa-public-inquiry-registration.sql','2026-07-23-pa-gmail-delivery.sql','2026-07-24-pa-schedule-response-workflow.sql','2026-07-24-pa-case-progress.sql','2026-07-26-pa-case-trash.sql','2026-07-24-pa-api-security-hardening.sql','20260901153000_pa_content_hearing_follow_up.sql','20260902103000_pam001_workflow_projection.sql','20260902130000_pam002_gmail_case_communication.sql','20260902143000_pam002_gmail_conversation_authority.sql','20260902170000_pam003_estimate_submission_projection.sql','20260903010000_pam004_gmail_direct_sent_reconciliation.sql','20260903020000_pam005_atomic_estimate_reconciliation.sql','20260907130000_pa_formal_contract.sql','20260908143000_pa_portal_document_management.sql','20260908213000_pa_portal_organizer_access.sql','20260909060000_pa_portal_document_candidates.sql','20260909093000_pa_portal_candidate_canonical_identity.sql','20260909110000_pa_portal_candidate_variant_reconcile.sql','20260909123000_pa_stage_plot_persistence.sql','20260913110000_pa_case_management_v5.sql','20260913130000_pa_case_management_v5_r1.sql','20260913170000_pa_case_management_v5_payment_race.sql','20260913190000_pa_estimate_recovery_ux.sql','20260914100000_pa_est_005a_confirmation_snapshot_compat.sql','20261005145900_ara_classification_archive_guard.sql','20261005150000_ara_case_common_mail.sql','20261005160000_ara_case_r2_intake_coverage.sql'];
const json = (data,status=200) => ({ok:status>=200&&status<300,status,json:async()=>data});
const ident = s => { if(!/^[a-z_][a-z0-9_]*$/.test(s)) throw Error('invalid fixture identifier'); return s; };
async function createFixture() {
 const db = new PGlite({extensions:{pgcrypto}});
 await db.exec('create role anon;create role authenticated;create role service_role bypassrls;');
 await db.exec(fs.readFileSync(path.join(root,'tests/fixtures/pa-est-007r1-postgres-prelude.sql'),'utf8'));
 await db.exec(`create function auth.jwt() returns jsonb language sql stable as $$ select jsonb_build_object('sub',auth.uid()) $$; select set_config('request.jwt.claim.sub','${actor}',false);`);
 for(const m of migrations) { try { await db.exec(fs.readFileSync(path.join(root,'supabase/migrations',m),'utf8')); } catch(e) { throw Error(`migration ${m}: ${e.message}`); } }
 const state={mailbox:'aratechsound@gmail.com',failPage:false,pageCount:0,sendCount:0,network:[],messages:new Map(),pages:[[]],threadMessages:new Map()};
 Object.assign(process.env,{SUPABASE_URL:'https://fixture.invalid',SUPABASE_SERVICE_ROLE_KEY:'fixture-service',GMAIL_CLIENT_ID:'fixture-id',GMAIL_CLIENT_SECRET:'fixture-secret',GMAIL_REFRESH_TOKEN:'fixture-refresh',GMAIL_SENDER_ADDRESS:'aratechsound@gmail.com',GMAIL_REPLY_TO:'aratechsound@gmail.com',GMAIL_NOTIFICATION_ADDRESS:'aratechsound@gmail.com',RATE_LIMIT_HASH_SECRET:'fixture-rate-secret',ALLOWED_ORIGINS:'http://127.0.0.1:8871,https://ara-tech.cc'});
 async function fetchImpl(target, options={}) {
  const u=new URL(target);state.network.push({host:u.host,path:u.pathname,method:options.method||'GET'});
  if(u.host==='oauth2.googleapis.com') return json({access_token:'fixture-access',expires_in:3600});
  if(u.host==='gmail.googleapis.com') {
   if(u.pathname.endsWith('/profile')) return json({emailAddress:state.mailbox});
   if(u.pathname.endsWith('/messages/send')) {state.sendCount++;return json({id:'fake_sent',threadId:'thread_1'});}
   if(u.pathname.includes('/attachments/')) return json({data:Buffer.from('test attachment').toString('base64url')});
   if(u.pathname.includes('/threads/')) return json({messages:state.threadMessages.get(u.pathname.split('/').at(-1))||[]});
   if(u.pathname.includes('/messages/')) return json(state.messages.get(u.pathname.split('/').at(-1))||{},state.messages.has(u.pathname.split('/').at(-1))?200:404);
   if(u.pathname.endsWith('/messages')) {const page=u.searchParams.get('pageToken')==='page2'?1:0;if(page===1&&state.failPage)return json({},503);state.pageCount++;return json({messages:state.pages[page].map(id=>({id})),...(page===0&&state.pages.length>1?{nextPageToken:'page2'}:{})});}
   throw Error('Unknown fake Gmail path');
  }
  if(u.origin!=='https://fixture.invalid') throw Error('Live network forbidden');
  if(u.pathname==='/auth/v1/user') return options.headers.authorization==='Bearer fixture-admin'?json({id:actor,email:'owner@example.invalid'}):json({},401);
  const input=options.body?JSON.parse(options.body):null;
  if(u.pathname.includes('/rpc/')) {const name=ident(u.pathname.split('/').at(-1));const keys=Object.keys(input).map(ident);try {if(name==='consume_rate_limit')return json((await db.query(`select * from public.${name}(${keys.map((k,i)=>`${k}=>$${i+1}`).join(',')})`,Object.values(input))).rows);const r=await db.query(`select public.${name}(${keys.map((k,i)=>`${k}=>$${i+1}`).join(',')}) result`,Object.values(input));return json(r.rows[0].result);}catch(e){return json({message:e.message},400);}}
  const table=ident(u.pathname.split('/').at(-1)), values=[],where=[];
  for(const [key,value] of u.searchParams){
   if(['select','limit','order','on_conflict'].includes(key))continue;
   ident(key);
   if(value==='is.null')where.push(`${key} is null`);
   else if(value==='not.is.null')where.push(`${key} is not null`);
   else if(value.startsWith('eq.')){values.push(value.slice(3));where.push(`${key}=$${values.length}`);}
   else if(value.startsWith('in.')){
    const match=/^in\.\(([A-Za-z0-9_-]{1,200}(?:,[A-Za-z0-9_-]{1,200}){0,99})\)$/.exec(value);
    if(table!=='pa_gmail_message_index'||key!=='gmail_message_id'||(options.method||'GET')!=='GET'||!match)throw Error('Invalid fixture message ID filter');
    const ids=match[1].split(',');
    if(new Set(ids).size!==ids.length)throw Error('Invalid fixture message ID filter');
    values.push(ids);where.push(`${key}=ANY($${values.length}::text[])`);
   }else throw Error('Unexpected fixture filter '+key);
  }
  const suffix=where.length?' where '+where.join(' and '):'';
  try {
   if((options.method||'GET')==='GET') {const selected=u.searchParams.get('select')||'*';if(!/^[a-z0-9_*,]+$/.test(selected))throw Error('Invalid select');const order=u.searchParams.get('order')?.split(',').map(s=>{const [k,d]=s.split('.');ident(k);if(!['asc','desc'].includes(d))throw Error('order');return `${k} ${d}`;}).join(',');return json((await db.query(`select ${selected} from public.${table}${suffix}${order?' order by '+order:''} limit ${Number(u.searchParams.get('limit')||1000)}`,values)).rows.map(row=>Object.fromEntries(Object.entries(row).map(([k,v])=>[k,v instanceof Date ? (/(_date|_on)$/.test(k)?v.toISOString().slice(0,10):v.toISOString()):v]))));}
   const keys=Object.keys(input).map(ident);const args=Object.values(input).map(v=>v&&typeof v==='object'&&!Array.isArray(v)?JSON.stringify(v):Array.isArray(v)?JSON.stringify(v):v);
   if(options.method==='PATCH')return json((await db.query(`update public.${table} set ${keys.map((k,i)=>`${k}=$${values.length+i+1}`).join(',')}${suffix} returning *`,[...values,...args])).rows);
   const conflict=u.searchParams.get('on_conflict');let extra='';
   if(conflict){conflict.split(',').forEach(ident);extra=` on conflict(${conflict}) `+(String(options.headers?.prefer||'').includes('merge-duplicates')?'do update set '+keys.map(k=>`${k}=excluded.${k}`).join(','):'do nothing');}
   return json((await db.query(`insert into public.${table}(${keys}) values(${keys.map((_,i)=>'$'+(i+1))})${extra} returning *`,args)).rows);
  }catch(e){return json({message:e.message},400);}
 }
 const raw=(id,thread='thread_1',from='customer@example.invalid',body='施工相談の原文。希望日未定、来月まで。')=>({id,threadId:thread,labelIds:['INBOX'],snippet:body.slice(0,25),internalDate:String(Date.now()-10000),payload:{mimeType:'text/plain',headers:[{name:'From',value:from},{name:'To',value:'aratechsound@gmail.com'},{name:'Subject',value:'設備施工のご相談'},{name:'Message-ID',value:`<${id}@example.invalid>`}],body:{data:Buffer.from(body).toString('base64url')}}});
 return {db,state,actor,fetchImpl,raw,migrations};
}
module.exports={createFixture,actor,migrations};
