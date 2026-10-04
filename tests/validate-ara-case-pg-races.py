from pathlib import Path
import subprocess,os,json,uuid,time,concurrent.futures,datetime
root=Path(__file__).resolve().parents[1];audit=root.parent.parent/'outputs/ARA-CASE-001R2-audit'
psql=root.parent/'r2-runtime/pgsql/bin/psql.exe'
env={**os.environ,'PGCLIENTENCODING':'UTF8'}
actor='123e4567-e89b-42d3-a456-426614174001'
def query(s,check=True):
 p=subprocess.run([str(psql),'-h','127.0.0.1','-p','55437','-U','fixture_admin','-d','ara_case_r2_verify','-v','ON_ERROR_STOP=1','-At'],input=s,text=True,encoding='utf8',capture_output=True,env=env)
 if check and p.returncode:raise RuntimeError(p.stderr)
 return p
def q(s):return "'"+str(s).replace("'","''")+"'"
def case():return query(f"insert into pa_inquiries(created_by,status,customer_name,email,case_type) values('{actor}','new_inquiry','race fixture','race@example.invalid','OTHER') returning id;").stdout.splitlines()[0]
def candidate():
 m='race_'+uuid.uuid4().hex
 query(f"insert into ara_unlinked_mail(gmail_message_id,gmail_thread_id,from_address,subject,snippet,received_at) values('{m}','{m}_thread','race@example.invalid','race fixture','fake',now());")
 return m
def decision(m,action,c=None):return f"select ara_decide_mail('{actor}','{m}','{action}',{q(c) if c else 'null'},'fixture','race@example.invalid','OTHER','fixture body');"
records=[]
def race(name,a,b):
 tag=uuid.uuid4().hex[:8];app_a='ara_race_A_'+tag;app_b='ara_race_B_'+tag
 def activity():
  p=query(f"select coalesce(json_agg(json_build_object('pid',pid,'application',application_name,'wait',wait_event,'state',state)),'[]') from pg_stat_activity where application_name in ('{app_a}','{app_b}');")
  return json.loads(p.stdout)
 with concurrent.futures.ThreadPoolExecutor() as pool:
  first=pool.submit(query,f"set application_name='{app_a}';begin;{a}select pg_sleep(1.5);commit;",False)
  for _ in range(100):
   seen=activity()
   if any(r['wait']=='PgSleep' for r in seen):break
   if first.done():raise RuntimeError('first failed before barrier: '+first.result().stderr)
   time.sleep(.01)
  else:raise RuntimeError('barrier timeout')
  second=pool.submit(query,f"set application_name='{app_b}';begin;{b}select pg_sleep(0.8);commit;",False)
  time.sleep(.12);snapshot=activity()
  ra,rb=first.result(),second.result()
 assert len({r['pid'] for r in snapshot})==2,(name,snapshot)
 assert ra.returncode==0,(name,ra.stderr)
 records.append({'name':name,'independent_sessions':snapshot,'first_exit':ra.returncode,'second_exit':rb.returncode,'first_stdout':ra.stdout,'second_stdout':rb.stdout,'second_stderr':rb.stderr,'barrier':'first function completed inside held transaction (PgSleep), then second session dispatched','result':'PASS'})
 return rb
# Same intake identity creates one root + one queued notification, even across sessions.
key=str(uuid.uuid4());body=json.dumps({'case_type':'OTHER','customer_name':'race','email':'race@example.invalid','subject':'race','body':'fixture'})
notif=json.dumps([{'message_type':'internal_new_inquiry','recipient':'aratechsound@gmail.com','subject':'race {number}','body':'fake'}])
intake=f"select ara_register_general('{key}','{'a'*64}',{q(body)}::jsonb,{q(notif)}::jsonb);"
assert race('submit vs submit',intake,intake).returncode==0
assert query(f"select count(*) from pa_inquiries where submission_key='{key}';").stdout.strip()=='1'
assert query(f"select count(*) from pa_email_deliveries where inquiry_id=(select id from pa_inquiries where submission_key='{key}');").stdout.strip()=='1'
for order in ('create-create','create-link','link-create','link-link'):
 m=candidate();c1,c2=case(),case()
 a,b=order.split('-');r=race(order,decision(m,a,c1 if a=='link' else None),decision(m,b,c2 if b=='link' else None))
 assert (r.returncode!=0)==(order in ('create-link','link-link')),(order,r.stderr)
 assert query(f"select count(*) from pa_gmail_thread_links where gmail_thread_id='{m}_thread';").stdout.strip()=='1'
# Synchronization and decision share a candidate, with both commit orders.
query("insert into ara_mail_sync_state(window_start,window_end,page_token) values(now()-interval '1 minute',now(),'') on conflict(mailbox) do nothing;")
for reverse in (False,True):
 m=candidate();c=case();state=query('select json_build_object(\'version\',cursor_version) from ara_mail_sync_state;').stdout.strip();version=json.loads(state)['version']
 sync=f"select ara_commit_mail_page_v2('{actor}',now()-interval '1 minute',now(),{version},'','[]');"
 a,b=(decision(m,'link',c),sync) if reverse else (sync,decision(m,'link',c))
 assert race('decision/sync '+str(reverse),a,b).returncode==0
 assert query(f"select decision from ara_unlinked_mail where gmail_message_id='{m}';").stdout.strip()=='linked'
for reverse in (False,True):
 m=candidate();c=case();archive=f"select set_config('request.jwt.claim.sub','{actor}',true);select * from trash_pa_case('{c}','test_case','{actor}');"
 a,b=(archive,decision(m,'link',c)) if reverse else (decision(m,'link',c),archive)
 r=race('archive/link '+str(reverse),a,b)
 assert (r.returncode!=0)==reverse,(reverse,r.stderr)
 assert query(f"select deleted_at is not null from pa_inquiries where id='{c}';").stdout.strip()=='t'
(audit/'INDEPENDENT_PG_RACES.json').write_text(json.dumps({'recorded_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'scope':'real PostgreSQL independent backend PIDs / actual functions and triggers / explicit transaction barrier; no production','tests':records},ensure_ascii=False,indent=2),encoding='utf8')
print('Independent PostgreSQL races',len(records),'PASS')
