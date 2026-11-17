"""Exercise PAUI-095 using separate psql processes and a disposable PostgreSQL DB."""
import csv
import io
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import time
import uuid


ROOT = Path(__file__).resolve().parents[1]
ACTOR = "123e4567-e89b-42d3-a456-426614174001"
IN_CI = os.environ.get("ARA_CI_FIXTURE") == "isolated-container"
if IN_CI:
    if sys.platform != "linux" or not Path("/tmp/ara-ci-fixture/pg-data/postmaster.pid").is_file():
        raise RuntimeError("Expected the isolated CI PostgreSQL fixture")
    PORT, PSQL = "55437", "psql"
else:
    PORT = os.environ["PAUI095_SCHEDULE_RACE_DISPOSABLE_PORT"]
    PSQL = os.environ["PAUI095_SCHEDULE_RACE_PSQL"]
    if not PORT.isdecimal() or not 1024 <= int(PORT) <= 65535:
        raise RuntimeError("Invalid disposable cluster port")

DATABASE = "paui095_schedule_race_" + secrets.token_hex(5)
ENV = {name: value for name, value in os.environ.items() if not name.upper().startswith("PG")}
ENV.update(PGCLIENTENCODING="UTF8", PGCONNECT_TIMEOUT="3")
STEPS = (
    "2026-07-23-pa-inquiry-management.sql",
    "2026-07-23-pa-public-inquiry-registration.sql",
    "2026-07-23-pa-gmail-delivery.sql",
    "2026-07-24-pa-schedule-response-workflow.sql",
    "2026-07-24-pa-case-progress.sql",
    "2026-07-26-pa-case-trash.sql",
    "2026-07-24-pa-api-security-hardening.sql",
    "20260901153000_pa_content_hearing_follow_up.sql",
)
LEGACY = "public.issue_pa_schedule_token(uuid,text,timestamptz), public.revoke_pa_schedule_token(uuid)"
RESPONSE = {
    "respondent_name": "Schedule Fixture",
    "confirmation_name": "Schedule Fixture",
    "email": "schedule@example.invalid",
    "phone": "010-0000-0000",
    "relationship": "organizer",
    "authority": "yes",
    "decision": "agree",
    "agreements": ["not-secured", "adjustment-starts", "completion-notice", "schedule-fee",
                   "cancellation-fee", "no-fee-if-unsecured", "authorized"],
}


def lit(value):
    return "'" + str(value).replace("'", "''") + "'"


def argv(database, label):
    return [PSQL, "-X", "-q", "-A", "-t", "--csv", "-w", "-v", "ON_ERROR_STOP=1",
            "-d", f"postgresql://fixture_admin@127.0.0.1:{PORT}/{database}?application_name={label}"]


def sql(statement, database=DATABASE, label="schedule-observer"):
    result = subprocess.run(argv(database, label), input=statement, text=True,
                            encoding="utf-8", env=ENV, capture_output=True, timeout=15, check=False)
    if result.returncode:
        raise RuntimeError(f"{label} exited {result.returncode}: {result.stderr.strip()}")
    return list(csv.reader(io.StringIO(result.stdout)))


def scalar(statement, database=DATABASE, label="schedule-observer"):
    return sql(statement, database, label)[-1][0]


def open_session(label):
    return subprocess.Popen(argv(DATABASE, label), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, encoding="utf-8", text=True, env=ENV)


def send(session, statement):
    session.stdin.write(statement + "\n")
    session.stdin.flush()


def finish(session):
    try:
        output, error = session.communicate(timeout=12)
    except subprocess.TimeoutExpired:
        session.kill()
        session.communicate()
        raise
    if session.returncode:
        raise RuntimeError(error.strip())
    return list(csv.reader(io.StringIO(output)))


def wait_for(label, expected):
    handoff = time.monotonic() + 8
    while time.monotonic() < handoff:
        rows = sql(f"select pid from pg_stat_activity where application_name={lit(label)} and {expected};")
        if rows:
            return int(rows[0][0])
        time.sleep(0.05)
    raise RuntimeError(f"{label} did not reach the expected PostgreSQL state")


def initialize():
    server = sql("select current_user,host(inet_server_addr()),current_setting('cluster_name');", "postgres")
    if len(server) != 1 or server[0][:2] != ["fixture_admin", "127.0.0.1"]:
        raise RuntimeError("Unexpected PostgreSQL bootstrap identity")
    if not IN_CI and server[0][2] != "paui095-disposable":
        raise RuntimeError("Refusing a cluster without the schedule fixture name")
    sql("""do $roles$
      begin
        if not exists(select from pg_roles where rolname='postgres') then create role postgres nologin; end if;
        if not exists(select from pg_roles where rolname='anon') then create role anon; end if;
        if not exists(select from pg_roles where rolname='authenticated') then create role authenticated; end if;
        if not exists(select from pg_roles where rolname='service_role') then create role service_role bypassrls; end if;
      end $roles$;
    """, "postgres")
    sql(f"create database {DATABASE} owner postgres;", "postgres")


def apply_schema():
    schema = (ROOT / "tests/fixtures/pa-est-007r1-postgres-prelude.sql").read_text(encoding="utf-8")
    for filename in STEPS:
        schema += "\n" + (ROOT / "supabase/migrations" / filename).read_text(encoding="utf-8")
    # Apply historical definitions as the disposable hosted owner, then mirror the hosted execute grants.
    schema += f"\ngrant execute on function {LEGACY} to anon,authenticated,service_role;\n"
    schema += "grant execute on function public.submit_pa_schedule_response(text,jsonb,uuid) to service_role;\n"
    schema += (ROOT / "supabase/operations/paui095-guard-schedule-token.sql").read_text(encoding="utf-8")
    sql("set role postgres;\n" + schema)
    sql("""create function public.fixture_schedule_answer_gate() returns trigger language plpgsql as $$
      begin perform pg_advisory_xact_lock(95084,1); return new; end;
      $$;
      create trigger fixture_schedule_answer_gate before insert on public.pa_schedule_responses
        for each row execute function public.fixture_schedule_answer_gate();
    """)


def command(case, version, token_id, action, secret=None):
    target = lit(token_id) if token_id else "null"
    tail = f",{lit(secret)},now()+interval '1 day'" if secret else ""
    return f"""set statement_timeout='5s';
      select set_config('request.jwt.claim.sub',{lit(ACTOR)},false);
      set role authenticated;
      select public.pa_manage_schedule_token_v2({lit(case)},{lit(version)},{target},{lit(action)}{tail});"""


def seed():
    case = uuid.uuid4()
    secret = secrets.token_urlsafe(32)
    version = scalar(f"""insert into public.pa_inquiries(id, customer_name, email, event_name,
      event_date, venue, public_conditions, status) values
      ({lit(case)},'Schedule Fixture','fixture@example.invalid','Event fixture','2027-01-01',
      'Fixture venue','Fixture conditions','schedule_coordination') returning updated_at;""")
    issued = json.loads(scalar(command(case, version, None, "issue", secret)))
    assert issued["state"] == "issued"
    return case, secret, issued


def snapshot(case):
    return sql(f"""select i.status, i.updated_at,
       (select count(*) from pa_schedule_tokens t where t.inquiry_id=i.id),
       (select count(*) from pa_schedule_tokens t where t.inquiry_id=i.id and t.revoked_at is not null),
       (select count(*) from pa_schedule_tokens t where t.inquiry_id=i.id and t.answered_at is not null),
       (select count(*) from pa_schedule_responses r where r.inquiry_id=i.id),
       (select count(*) from pa_inquiry_audit a where a.inquiry_id=i.id and a.action='second_form_token_revoked')
       from pa_inquiries i where id={lit(case)};""")[0]


def response_race():
    case, secret, issued = seed()
    initial = snapshot(case)
    gate = open_session("schedule-trigger-gate")
    customer = open_session("schedule-customer")
    try:
        send(gate, "begin; select pg_advisory_xact_lock(95084,1);")
        gate_pid = wait_for("schedule-trigger-gate", "state='idle in transaction'")
        # The real RPC acquires the token row before reaching the fixture INSERT trigger.
        send(customer, f"""set statement_timeout='10s'; set role service_role;
          select result from public.submit_pa_schedule_response({lit(secret)},
          {lit(json.dumps(RESPONSE))}::jsonb,{lit(uuid.uuid4())});""")
        customer_pid = wait_for("schedule-customer", f"""wait_event='advisory'
            and {gate_pid} = any(pg_blocking_pids(pid))""")
        retry_secret = secrets.token_urlsafe(32)
        for action, new_secret in (("revoke", None), ("issue", retry_secret)):
            attempt = command(case, issued["updated_at"], issued["token_id"], action, new_secret)
            rows = sql(attempt + "\nselect pg_backend_pid();", label="schedule-owner")
            assert json.loads(rows[-2][0]) == {"state": "busy"}
            assert int(rows[-1][0]) not in (gate_pid, customer_pid)
            assert snapshot(case) == initial
        send(gate, "commit;")
        finish(gate)
        assert finish(customer)[-1] == ["accepted"]
        for action, new_secret in (("revoke", None), ("issue", retry_secret)):
            assert json.loads(scalar(command(case, issued["updated_at"], issued["token_id"],
                                             action, new_secret))) == {"state": "stale"}
        assert snapshot(case)[2:] == ["1", "0", "1", "1", "0"]
        print("PASS concurrent customer response: competing revoke and reissue returned busy, then stale")
    finally:
        for process in (customer, gate):
            if process.poll() is None:
                process.kill()
                process.communicate()


def replacement_race():
    case, _, issued = seed()
    initial = snapshot(case)
    owner_a = open_session("schedule-owner-replacement")
    try:
        send(owner_a, "begin;\n" + command(case, issued["updated_at"], issued["token_id"],
                                          "issue", secrets.token_urlsafe(32)))
        owner_a_pid = wait_for("schedule-owner-replacement", "state='idle in transaction'")
        stale_revoke = command(case, issued["updated_at"], issued["token_id"], "revoke")
        rows = sql(stale_revoke + "\nselect pg_backend_pid();", label="schedule-owner-stale")
        assert int(rows[-1][0]) != owner_a_pid
        assert json.loads(rows[-2][0]) == {"state": "busy"}
        assert snapshot(case) == initial
        send(owner_a, "commit;")
        assert json.loads(finish(owner_a)[-1][0])["state"] == "issued"
        assert json.loads(scalar(stale_revoke)) == {"state": "stale"}
        assert snapshot(case)[2:] == ["2", "1", "0", "0", "0"]
        print("PASS concurrent replacement: old view could not revoke the newly issued URL")
    finally:
        if owner_a.poll() is None:
            owner_a.kill()
            owner_a.communicate()


if __name__ == "__main__":
    initialize()
    try:
        apply_schema()
        response_race()
        replacement_race()
    finally:
        sql(f"drop database {DATABASE} with (force);", "postgres")
