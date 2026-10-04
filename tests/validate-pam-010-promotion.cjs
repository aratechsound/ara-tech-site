const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'), evidence=path.resolve(process.argv[2]||path.join(root,'../../outputs/PAM-009-audit'));
const read=n=>fs.readFileSync(path.join(evidence,n),'utf8');
const cat=JSON.parse(read('SUPABASE_PRODUCTION_READBACK.json'));
const preview=JSON.parse(read('SUPABASE_CLASSIFICATION_PREVIEW.json'));
const diff=JSON.parse(read('COMMON_CASE_MIGRATION_DIFF.json'));
const manifest=JSON.parse(fs.readFileSync(path.join(root,'plans/PAM-010/promotion.json'),'utf8'));
const checks=[];
const tableNames=new Set(cat.tables.map(t=>t.name));
const columns=new Set(cat.columns.map(c=>c.table_name+'.'+c.column_name));
const functions=new Set(cat.functions.map(f=>f.name));
const order=['20261005145900_ara_classification_archive_guard.sql','20261005150000_ara_case_common_mail.sql','20261005160000_ara_case_r2_intake_coverage.sql'];
assert.deepEqual(manifest.migrations.map(m=>m.file),order);
const texts=order.map((file,index)=>{
 const bytes=fs.readFileSync(path.join(root,'supabase/migrations',file));
 const hash=crypto.createHash('sha256').update(bytes).digest('hex');
 assert.ok([manifest.migrations[index].sha256,manifest.migrations[index].git_blob_sha256].includes(hash));
 const accepted=fs.readFileSync(path.join(evidence,'candidate-migrations',file));
 assert.equal(crypto.createHash('sha256').update(accepted).digest('hex'),manifest.migrations[index].sha256);
 assert.equal(bytes.toString('utf8').replace(/\r\n/g,'\n'),accepted.toString('utf8').replace(/\r\n/g,'\n'));
 return bytes.toString('utf8');
});
checks.push('exact order and raw hashes; PAM-009 SQL identical after CRLF normalization; whitelist only three migrations');
const newTables=new Set(['ara_unlinked_mail','ara_mail_sync_state']);
for(const sql of texts){
 for(const match of sql.matchAll(/(?:alter table|on|from|into|join|references)\s+(?:public\.)?(pa_[a-z_]+)/gi))assert.ok(tableNames.has(match[1]),match[1]);
 for(const array of sql.matchAll(/foreach tab in array array\[(.*?)\]/gs))
  for(const match of array[1].matchAll(/'(pa_[a-z_]+)'/g))assert.ok(tableNames.has(match[1]),match[1]);
}
for(const t of newTables)assert.ok(!tableNames.has(t));
for(const c of ['case_type','case_subject','desired_period','next_action','intake_fingerprint'])assert.ok(!columns.has('pa_inquiries.'+c));
for(const c of ['id','submission_source','submission_key','first_form_data','status','schedule_state','deleted_at','deleted_by','delete_reason','updated_at','event_date','event_name'])assert.ok(columns.has('pa_inquiries.'+c));
for(const c of ['inquiry_id','message_type','dedupe_key','recipient','subject','body','status'])assert.ok(columns.has('pa_email_deliveries.'+c));
for(const f of ['guard_pa_inquiry_soft_delete','sync_pa_case_progress_from_inquiry','is_work_admin'])assert.ok(functions.has(f));
assert.ok(cat.triggers.some(t=>t.table==='pa_inquiries'&&t.name==='pa_inquiries_sync_case_progress'));
assert.ok(cat.constraints.some(c=>c.table==='pa_email_deliveries'&&c.name==='pa_email_deliveries_status_check'));
assert.ok(cat.indexes.some(i=>i.tablename==='pa_inquiries'&&/UNIQUE.*submission_key/i.test(i.indexdef)));
assert.ok(!cat.migrations.some(m=>order.some(f=>f.startsWith(m.version+'_'))));
const replacements=[...texts.join('\n').matchAll(/create or replace function public\.([a-z_]+)/gi)].map(m=>m[1]);
assert.deepEqual(replacements,['guard_pa_inquiry_soft_delete','ara_require_pa_child']);
assert.ok(!texts.join('\n').includes('create or replace function public.is_work_admin'));
checks.push('captured actual Production PA tables/columns/functions/constraints/triggers and submission-key uniqueness satisfy transition prerequisites');
assert.equal(preview.total,11);assert.equal(preview.r1_provenance_eligible,6);assert.equal(preview.final_pa_event_eligible,11);assert.equal(preview.remain_unclassified,0);
assert.equal(diff.columns.candidate_only.length,25);
checks.push('backfill preview: migration2 six; migration3 remaining five; sync-state backfill zero (new empty table)');
const routes=fs.readdirSync(path.join(root,'api')).filter(n=>n.endsWith('.js')).sort();assert.equal(routes.length,12);
assert.ok(routes.includes('pa-gmail.js'));assert.equal(routes.includes('mailbox-profile.js'),false);
assert.equal(manifest.initial_environment.ARA_GENERAL_INQUIRY_ENABLED,'false');
assert.equal(manifest.future_common_policy.notification_recipient,'aratechsound@gmail.com');
assert.equal(manifest.future_common_policy.receipt_enabled,false);
assert.equal(manifest.future_common_policy.spam_adapter,'turnstile');
assert.equal(manifest.future_common_policy.captcha_hostname,'ara-tech.cc');
assert.equal(manifest.turnstile_action,'general-inquiry');
assert.equal(manifest.future_common_policy.verified,false);
assert.equal(manifest.future_common_policy.captcha_site_key,null);
assert.equal(manifest.activation_authorized,false);
checks.push('twelve existing routes; explicit LEGACY rollout and unverified/disabled future COMMON policy');
console.log(JSON.stringify({result:'PASS',checks,routes,production_catalog_observed_at:cat.observed_at,
 catalog_sha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(evidence,'SUPABASE_PRODUCTION_READBACK.json'))).digest('hex'),
 snapshot_prerequisites:'PASS',live_preapply_readback:'NOT_EXECUTED; execute separate read-only preflight before future authorization',
 migrations:manifest.migrations,backfill:{migration2:6,migration3:5,total:11,sync_state:0,actually_applied:0}},null,2));
