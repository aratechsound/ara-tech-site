const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createFixture } = require('./helpers/ara-case-fixture.cjs');

const operations = name => fs.readFileSync(path.join(__dirname, '../supabase/operations', name), 'utf8');
const legacy = [
  'public.issue_pa_schedule_token(uuid,text,timestamptz)',
  'public.revoke_pa_schedule_token(uuid)'
];

async function main() {
  const { db, actor, state } = await createFixture();
  const row = async (sql, args = []) => (await db.query(sql, args)).rows[0];
  const withRole = async (role, callback) => {
    await db.exec('set role ' + role);
    try { return await callback(); } finally { await db.exec('reset role'); }
  };
  const query = 'select public.pa_manage_schedule_token_v2($1,$2,$3,$4,$5,now()+interval \'1 day\') result';
  const command = async (version, id, action, secret = null, role = 'authenticated') => (
    await withRole(role, () => row(action === 'issue' ? query :
      'select public.pa_manage_schedule_token_v2($1,$2,$3,$4) result',
    action === 'issue' ? [version.id, version.updated_at, id, action, secret] :
      [version.id, version.updated_at, id, action]))
  ).result;
  const read = id => row('select id, updated_at::text from pa_inquiries where id=$1', [id]);
  const publicState = secret => withRole('anon', () =>
    row('select access_state from public.get_pa_schedule_case($1)', [secret]));
  const privileges = async () => (await db.query(
    "select oid::regprocedure::text as name, prosrc, "
    + "has_function_privilege('anon',oid,'execute') as anon, "
    + "has_function_privilege('authenticated',oid,'execute') as authenticated, "
    + "has_function_privilege('service_role',oid,'execute') as service_role "
    + "from pg_proc where oid in ($1::regprocedure,$2::regprocedure) order by name", legacy)).rows;
  const snapshot = async id => (await row(
    'select (select to_jsonb(i) from pa_inquiries i where id=$1) inquiry, '
    + '(select jsonb_agg(t order by t.id) from pa_schedule_tokens t where inquiry_id=$1) tokens, '
    + '(select count(*)::int from pa_inquiry_audit where inquiry_id=$1) audits', [id]));
  try {
    const legacyList = legacy.join(',');
    const setup = 'revoke all on function '+legacyList+' from anon,authenticated,service_role; ';
    await db.exec(setup+'grant execute on function '+legacyList+' to anon,authenticated,service_role');
    const baseline = await privileges();
    assert.equal(baseline.length, 2);
    await db.exec(operations('paui095-guard-schedule-token.sql'));
    assert.deepEqual(await privileges(), baseline.map(item => ({...item, anon:false, authenticated:false})));

    const initial = await row("insert into pa_inquiries "
      + "(customer_name,email,event_name,event_date,venue,public_conditions,case_type,status) values "
      + "('Fixture','schedule@example.invalid','Synthetic event','2027-01-01','Fixture hall','Fixture terms',"
      + "'PA_EVENT','schedule_coordination') returning id,updated_at::text");
    const firstSecret = randomBytes(32).toString('base64url');
    const secondSecret = randomBytes(32).toString('base64url');
    for (const role of ['anon','service_role']) {
      await assert.rejects(() => command(initial, null, 'issue', firstSecret, role), {code:'42501'});
    }
    await withRole('authenticated', () => assert.rejects(
      () => row('select public.revoke_pa_schedule_token($1)', [initial.id]), {code:'42501'}));
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", ['123e4567-e89b-42d3-a456-426614174099']);
    await assert.rejects(() => command(initial, null, 'issue', firstSecret), {code:'42501'});
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [actor]);

    const first = await command(initial, null, 'issue', firstSecret);
    assert.equal(first.state, 'issued');
    assert(first.token_id && first.issued_at && first.expires_at && first.updated_at);
    assert(!JSON.stringify(first).includes(firstSecret));
    const firstVersion = {id:initial.id, updated_at:first.updated_at};
    const firstSnapshot = await snapshot(initial.id);
    assert.deepEqual(await command(initial, null, 'issue', firstSecret), {state:'stale'});
    assert.deepEqual(await snapshot(initial.id), firstSnapshot);

    const second = await command(firstVersion, first.token_id, 'issue', secondSecret);
    assert.equal(second.state, 'issued');
    assert.notEqual(first.token_id, second.token_id);
    assert.equal((await publicState(firstSecret)).access_state, 'invalid');
    assert.equal((await publicState(secondSecret)).access_state, 'valid');
    const secondVersion = {id:initial.id, updated_at:second.updated_at};
    const secondSnapshot = await snapshot(initial.id);
    assert.equal(secondSnapshot.tokens.length, 2);
    assert(!JSON.stringify(secondSnapshot).includes(firstSecret));
    assert(!JSON.stringify(secondSnapshot).includes(secondSecret));
    assert.deepEqual(await command(firstVersion, first.token_id, 'revoke'), {state:'stale'});
    assert.deepEqual(await command(secondVersion, first.token_id, 'revoke'), {state:'stale'});
    assert.deepEqual(await command(firstVersion, second.token_id, 'revoke'), {state:'stale'});
    assert.deepEqual(await snapshot(initial.id), secondSnapshot);
    assert.equal((await publicState(secondSecret)).access_state, 'valid');

    await db.query("update pa_case_progress set is_on_hold=true where inquiry_id=$1", [initial.id]);
    const heldVersion = await read(initial.id);
    const heldSnapshot = await snapshot(initial.id);
    assert.deepEqual(await command(heldVersion, second.token_id, 'revoke'), {state:'unavailable'});
    assert.deepEqual(await snapshot(initial.id), heldSnapshot);
    await db.query("update pa_case_progress set is_on_hold=false where inquiry_id=$1", [initial.id]);

    const revoked = await command(await read(initial.id), second.token_id, 'revoke');
    assert.equal(revoked.state, 'revoked');
    assert(revoked.revoked_at);
    assert.equal((await publicState(secondSecret)).access_state, 'invalid');
    assert.deepEqual(await command(secondVersion, second.token_id, 'revoke'), {state:'stale'});
    assert.equal(state.sendCount, 0);
    assert.deepEqual(state.network, []);
    await db.exec(operations('paui095-guard-schedule-token-rollback.sql'));
    assert.deepEqual(await privileges(), baseline);
    assert.equal((await row("select to_regprocedure('public.pa_manage_schedule_token_v2(uuid,timestamptz,uuid,text,text,timestamptz)') removed")).removed, null);
    await db.exec(operations('paui095-guard-schedule-token.sql'));
    assert.deepEqual(await privileges(), baseline.map(item => ({...item, anon:false, authenticated:false})));
    await db.exec(operations('paui095-guard-schedule-token-rollback.sql'));
    assert.deepEqual(await privileges(), baseline);
    console.log('PASS isolated schedule token guard: stale token and case version rejected, HOLD and roles preserved, rollback verified, Gmail calls 0');
  } finally {
    await db.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
