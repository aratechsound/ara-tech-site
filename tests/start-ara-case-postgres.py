from pathlib import Path
import subprocess, socket, os, json, datetime, sys, hashlib
root=Path(__file__).resolve().parents[1];task=root.parent.parent
ci_mode='--ci' in sys.argv
if ci_mode and (sys.platform=='win32' or os.environ.get('ARA_CI_FIXTURE')!='isolated-container'):
 raise RuntimeError('CI fixture requires the isolated Linux container runner')
rt=Path('/tmp/ara-ci-fixture') if ci_mode else root.parent/'r2-runtime';bin=Path('/usr/bin') if ci_mode else rt/'pgsql/bin';data=rt/'pg-data'
rt.mkdir(parents=True,exist_ok=True)
def executable(name):return name if ci_mode else bin/(name+'.exe')
legacy='--legacy' in sys.argv;database='ara_case_r2_legacy' if legacy else 'ara_case_r2';rest_port=55439 if legacy else 55438
guards='--guards' in sys.argv
final='--final' in sys.argv or guards
if final:database='ara_case_r2_verify';rest_port=55442
if guards:database='ara_case_r2_guards';rest_port=55443
r3='--r3' in sys.argv
if r3:database='ara_case_r3_verify';rest_port=55444;final=True
env=os.environ.copy();env['PGCLIENTENCODING']='UTF8'
env['PATH']=str(bin)+os.pathsep+env.get('PATH','')
def run(args,sql=None):
 print('RUN',str(args[0]),flush=True)
 p=subprocess.run([str(a) for a in args],input=sql,encoding='utf8',errors='replace',capture_output=True,env=env)
 if p.returncode:raise RuntimeError(p.stdout+p.stderr)
 return p.stdout
if not ci_mode and not data.exists():run([bin/'initdb.exe','-D',data,'-U','fixture_admin','-A','trust','--encoding=UTF8','--locale=C'])
with socket.socket() as s:
 running=s.connect_ex(('127.0.0.1',55437))==0
if not running and ci_mode:raise RuntimeError('Isolated PostgreSQL fixture is not running')
if not running:
 with (rt/'pg-start.log').open('ab') as log:
  subprocess.run([str(bin/'pg_ctl.exe'),'-D',str(data),'-l',str(rt/'postgres.log'),'-o','-h 127.0.0.1 -p 55437','-w','start'],stdout=log,stderr=log,check=True)
psql=[executable('psql'),'--no-psqlrc','-h','127.0.0.1','-p','55437','-U','fixture_admin','-d','postgres','-v','ON_ERROR_STOP=1']
names=run(psql, f"select datname from pg_database where datname='{database}';")
if database not in names:run(psql,f'create database {database};')
psql[psql.index('postgres')]=database
prelude="""do $$begin
if not exists(select 1 from pg_roles where rolname='anon') then create role anon;create role authenticated;create role service_role bypassrls;create role authenticator login noinherit;end if;
end $$;
grant anon,authenticated,service_role to authenticator;
alter default privileges grant all on tables to service_role;
alter default privileges grant all on sequences to service_role;
"""+(root/'tests/fixtures/pa-est-007r1-postgres-prelude.sql').read_text(encoding='utf8')+"""
create or replace function auth.uid() returns uuid language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claim.sub',true),''),nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid $$;
create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,jsonb_build_object('sub',auth.uid())) $$;
grant usage on schema auth to anon,authenticated,service_role;
"""
from re import findall
fixture=(root/'tests/helpers/ara-case-fixture.cjs').read_text(encoding='utf8')
migrations=findall(r"'([^']+\.sql)'",fixture.split('const migrations = ')[1].split(';')[0])
common_migrations=['20261005145900_ara_classification_archive_guard.sql','20261005150000_ara_case_common_mail.sql','20261005160000_ara_case_r2_intake_coverage.sql']
pa_migrations=[m for m in migrations if m not in common_migrations]+['20260914170000_pa_est_007r1_production_e2e.sql','20260914213000_pa_est_007r3_delivery_recovery.sql','20260915093000_pa_est_010r1_safe_confirmation_reissue.sql']
migrations=pa_migrations+([] if legacy else common_migrations)
def validate_migration_plan(plan,pa_order,legacy_mode):
 if len(plan)!=len(set(plan)):raise RuntimeError('HOLD: duplicate fixture migration')
 if [m for m in plan if m not in common_migrations]!=pa_order:raise RuntimeError('HOLD: PA fixture migration order changed')
 if [m for m in plan if m in common_migrations]!=([] if legacy_mode else common_migrations):raise RuntimeError('HOLD: COMMON fixture migration order/count changed')
 if not legacy_mode and plan[-3:]!=common_migrations:raise RuntimeError('HOLD: COMMON fixture migrations must follow PA dependencies')
validate_migration_plan(migrations,pa_migrations,legacy)
check=run(psql,"select case when count(*)=0 then 'PAM033_FRESH_EMPTY_FIXTURE' else 'PAM033_EXISTING_FIXTURE_HOLD' end from information_schema.tables where table_schema in ('public','auth');")
results=[]
if 'PAM033_FRESH_EMPTY_FIXTURE' in check:
 run(psql,prelude)
 for name in migrations:
  if final and name=='20261005150000_ara_case_common_mail.sql':
   run(psql,"""
   insert into pa_inquiries(created_by,status,customer_name,email,event_name,event_date) values('123e4567-e89b-42d3-a456-426614174001','new_inquiry','CLASS_MANUAL_PA','pa@example.invalid','Manual PA','2026-11-01');
   insert into pa_inquiries(created_by,status,customer_name,email) values('123e4567-e89b-42d3-a456-426614174001','new_inquiry','CLASS_UNKNOWN','unknown@example.invalid');
   insert into pa_inquiries(created_by,status,customer_name,email,submission_source,submission_key,first_form_data) values('123e4567-e89b-42d3-a456-426614174001','new_inquiry','CLASS_PUBLIC_PA','pa@example.invalid','public_form',gen_random_uuid(),'{"form_source":"contact","confirmation_consent":true,"requested_services":["PA・音響"],"event_overview":"PA fixture"}');
   insert into pa_inquiries(created_by,status,customer_name,email) values('123e4567-e89b-42d3-a456-426614174001','new_inquiry','CLASS_OFFER_PA','offer@example.invalid');
   insert into pa_contract_offers(id,inquiry_id,version,expires_at,issued_by,snapshot,snapshot_sha256,quote_pdf,quote_sha256) select gen_random_uuid(),id,1,now()+interval '7 days','123e4567-e89b-42d3-a456-426614174001','{}',repeat('a',64),convert_to(repeat('x',20),'UTF8'),encode(sha256(convert_to(repeat('x',20),'UTF8')),'hex') from pa_inquiries where customer_name='CLASS_OFFER_PA';
   insert into pa_inquiries(created_by,status,customer_name,email,event_name,event_date) values('123e4567-e89b-42d3-a456-426614174001','new_inquiry','CLASS_ARCHIVED_PA','pa@example.invalid','Archived PA','2026-11-01');
   insert into pa_inquiries(created_by,status,customer_name,email) values('123e4567-e89b-42d3-a456-426614174001','new_inquiry','CLASS_STAGE_PA','stage@example.invalid'),('123e4567-e89b-42d3-a456-426614174001','new_inquiry','CLASS_INDIRECT_NON_PA','stage@example.invalid');
   insert into pa_stage_plots(case_id,schema_version,state,created_by,updated_by) select id,1,'{"schemaVersion":1}',created_by,created_by from pa_inquiries where customer_name in ('CLASS_STAGE_PA','CLASS_INDIRECT_NON_PA');
   select * from trash_pa_case((select id from pa_inquiries where customer_name='CLASS_ARCHIVED_PA'),'test_case','123e4567-e89b-42d3-a456-426614174001');
   """)
  if guards and name=='20261005150000_ara_case_common_mail.sql':run(psql,(root/'tests/fixtures/ara-case-indirect-parent-seed.sql').read_text(encoding='utf8'))
  if final and name=='20261005160000_ara_case_r2_intake_coverage.sql':run(psql,"update pa_inquiries set case_type='OTHER' where customer_name='CLASS_INDIRECT_NON_PA';")
  run(psql,(root/'supabase/migrations'/name).read_text(encoding='utf8'));results.append(dict(migration=name,result='APPLIED'))
else:
 raise RuntimeError('HOLD: existing or incomplete fixture requires independently verified source/plan/state identity; automatic legacy tail resume is forbidden')
run(psql,'grant usage on schema public to anon,authenticated,service_role;grant all on all tables in schema public to service_role;grant all on all sequences in schema public to service_role;')
run(psql,"alter table public.work_admins enable row level security;drop policy if exists fixture_admin_self_read on public.work_admins;create policy fixture_admin_self_read on public.work_admins for select to authenticated using(user_id=auth.uid());grant select on public.work_admins to authenticated;")
config=rt/('postgrest-r3.conf' if r3 else 'postgrest-guards.conf' if guards else 'postgrest-final.conf' if final else 'postgrest-legacy.conf' if legacy else 'postgrest.conf')
config.write_text(f'db-uri = "postgresql://authenticator@127.0.0.1:55437/{database}"\ndb-schemas = "public"\ndb-anon-role = "anon"\nserver-host = "127.0.0.1"\nserver-port = {rest_port}\njwt-secret = "ara-case-r2-fixture-secret-at-least-32-characters"\n',encoding='utf8')
with socket.socket() as s:rest=s.connect_ex(('127.0.0.1',rest_port))==0
if not rest and not ci_mode:
 log=(rt/'postgrest.log').open('ab');subprocess.Popen([str(rt/'postgrest.exe'),str(config)],stdout=log,stderr=log,env=env,creationflags=subprocess.CREATE_NO_WINDOW)
out=task/'outputs/ARA-CASE-001R2-audit';out.mkdir(exist_ok=True,parents=True)
(out/('R3_MIGRATION_APPLICATION.json' if r3 else 'GUARD_MIGRATION_APPLICATION.json' if guards else 'FINAL_MIGRATION_APPLICATION.json' if final else 'LEGACY_MIGRATION_APPLICATION.json' if legacy else 'MIGRATION_APPLICATION.json')).write_text(json.dumps({'recorded_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'postgres_port':55437,'postgrest_port':rest_port,'database':database,'scope':'isolated localhost PostgreSQL; real PA migrations; Supabase platform roles/auth prelude','migrations':migrations,'migration_sha256':{m:hashlib.sha256((root/'supabase/migrations'/m).read_bytes()).hexdigest() for m in migrations},'application':results,'postgres_version':run([executable('postgres'),'--version']),'postgrest_version':run(['postgrest' if ci_mode else rt/'postgrest.exe','--version'])},indent=2),encoding='utf8')
print('Real PostgreSQL/PostgREST fixture ready')
