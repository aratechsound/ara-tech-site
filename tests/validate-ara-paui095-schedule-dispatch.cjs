const assert = require('node:assert/strict');
const {randomBytes,randomUUID} = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {createFixture} = require('./helpers/ara-case-fixture.cjs');
const {createScheduleDelivery,retryDelivery,normalizeCustomerBody} = require('../api/_pa-mail.cjs');

const urlFor = secret => 'https://ara-tech.cc/pa-schedule-confirm.html?token='+secret;
const operation = filename => fs.readFileSync(path.resolve(__dirname,'../supabase/operations',filename),'utf8');

async function main() {
  const {db,actor,state,fetchImpl} = await createFixture();
  const row = async (sql, params=[]) => (await db.query(sql,params)).rows[0];
  const guardCommand = async (input,version,action,secret=null) => (await row(
    "select public.pa_manage_schedule_token_v2($1,$2,$3,$4,$5,case when $5::text is null then null else now()+interval '1 day' end) result",
    [input.inquiry.id,version.updated_at,version.token_id,action,secret]
  )).result;
  const currentVersion = id => row("select updated_at::text, null as token_id from pa_inquiries where id=$1",[id]);
  const makeInvite = async () => {
    const inquiry = await row("insert into pa_inquiries(customer_name,email,event_name,event_date,venue,public_conditions,case_type,status) values ('Fixture','fixture@example.invalid','Synthetic event','2027-01-01','Fixture hall','Fixture terms','PA_EVENT','schedule_coordination') returning *");
    const secret = randomBytes(32).toString('base64url');
    const input = {inquiry,actorUserId:actor,operationKey:randomUUID(),scheduleUrl:urlFor(secret),
      subject:'Fixture '+inquiry.inquiry_number,body:'Synthetic invitation\n'+urlFor(secret)};
    const issued = await guardCommand(input,await currentVersion(inquiry.id),'issue',secret);
    assert.equal(issued.state,'issued');
    return {input,issued,secret};
  };

  try {
    await db.exec("grant execute on function public.issue_pa_schedule_token(uuid,text,timestamptz),public.revoke_pa_schedule_token(uuid) to anon,authenticated,service_role");
    await db.exec(operation('paui095-guard-schedule-token.sql'));
    const historical = await makeInvite();
    const old = historical.input;
    await assert.rejects(()=>createScheduleDelivery(old,fetchImpl),/supabase_400/);
    assert.equal(state.sendCount,0,'missing claim RPC must stop before Gmail');
    const historicalDelivery = await row(
      "insert into public.pa_email_deliveries(inquiry_id,message_type,dedupe_key,recipient,subject,body,status,sent_at,gmail_message_id,created_by) values ($1,'schedule_request',$2,$3,$4,$5,'sent',now(),'historical-fixture',$6) returning id,status",
      [old.inquiry.id,'schedule:'+old.inquiry.id+':'+old.operationKey,old.inquiry.email,old.subject,normalizeCustomerBody(old.body),actor]
    );
    await db.exec(operation('paui095-guard-schedule-dispatch.sql'));
    const grants = await row(`select
      has_function_privilege('anon','public.pa_claim_schedule_invitation(jsonb)','execute') anon_allowed,
      has_function_privilege('authenticated','public.pa_claim_schedule_invitation(jsonb)','execute') authenticated_allowed,
      has_function_privilege('service_role','public.pa_claim_schedule_invitation(jsonb)','execute') service_allowed`);
    assert.deepEqual(grants,{anon_allowed:false,authenticated_allowed:false,service_allowed:true});
    const historicalAgain = await createScheduleDelivery(historical.input,fetchImpl);
    assert.equal(historicalAgain.id,historicalDelivery.id);
    await assert.rejects(()=>createScheduleDelivery({...historical.input,operationKey:randomUUID()},fetchImpl),/schedule_delivery_exists/);

    const selected = await makeInvite();
    let beginOAuth, unblockOAuth;
    const entered = new Promise(resolve=>{ beginOAuth=resolve; });
    const continuation = new Promise(resolve=>{ unblockOAuth=resolve; });
    let validAtDispatch = false;
    const delayedOAuth = async (url, options) => {
      const endpoint = new URL(url);
      if (endpoint.origin==='https://oauth2.googleapis.com') {
        beginOAuth();
        await continuation;
      }
      if (endpoint.pathname.endsWith('/messages/send')) {
        validAtDispatch = (await row('select access_state from get_pa_schedule_case($1)',[selected.secret])).access_state==='valid';
      }
      return fetchImpl(url,options);
    };
    const sending = createScheduleDelivery(selected.input,delayedOAuth);
    try {
      await Promise.race([entered,sending.then(()=>{ throw Error('Delivery did not wait at OAuth'); })]);
      for (const action of ['issue','revoke']) {
        const replacement = action==='issue' ? randomBytes(32).toString('base64url') : null;
        assert.deepEqual(await guardCommand(selected.input,selected.issued,action,replacement),{state:'busy'});
      }
      await assert.rejects(()=>createScheduleDelivery({...selected.input,operationKey:randomUUID()},fetchImpl),/schedule_delivery_exists/);
      await assert.rejects(()=>db.exec(operation('paui095-guard-schedule-dispatch-rollback.sql')),/schedule_delivery_busy/);
      await db.exec('rollback');
      const replay = await createScheduleDelivery(selected.input,fetchImpl);
      assert.equal(replay.status,'sending');
      assert.equal(state.sendCount,0);
    } finally {
      unblockOAuth();
      await sending;
    }
    assert.equal((await sending).status,'sent');
    assert.equal(validAtDispatch,true);
    assert.equal((await guardCommand(selected.input,selected.issued,'revoke')).state,'revoked');
    assert.equal(state.sendCount,1);

    const uncertain = await makeInvite();
    const lost = async (url,options) => {
      const response = await fetchImpl(url,options);
      if (new URL(url).pathname.endsWith('/messages/send')) throw Error('fixture lost provider reply');
      return response;
    };
    assert.equal((await createScheduleDelivery(uncertain.input,lost)).status,'unknown');
    await assert.rejects(()=>createScheduleDelivery({...uncertain.input,operationKey:randomUUID()},fetchImpl),/schedule_delivery_exists/);
    assert.equal(state.sendCount,2);

    const badResponse = await makeInvite();
    let providerRequests = 0;
    const ambiguous = await createScheduleDelivery(badResponse.input,(url,options)=>{
      if (!new URL(url).pathname.endsWith('/messages/send')) return fetchImpl(url,options);
      providerRequests++;
      return new Response('{}',{status:400});
    });
    assert.equal(ambiguous.status,'unknown');
    await assert.rejects(()=>retryDelivery({deliveryId:ambiguous.id,inquiry:badResponse.input.inquiry,actorUserId:actor},fetchImpl),/retry_not_allowed/);
    assert.equal(providerRequests,1);

    const retry = await makeInvite();
    const rejected = await createScheduleDelivery(retry.input,(url,options)=>new URL(url).origin==='https://oauth2.googleapis.com'
      ? new Response('{}',{status:503}) : fetchImpl(url,options));
    assert.equal(rejected.status,'failed');
    const retried = await retryDelivery({deliveryId:rejected.id,inquiry:retry.input.inquiry,actorUserId:actor,
      expected:{recipient:rejected.recipient,subject:rejected.subject,body:rejected.body}},fetchImpl);
    assert.equal(retried.status,'sent');
    assert.equal(retried.attempt_number,2);
    assert.equal(state.sendCount,3);

    const unaffected = await makeInvite();
    await db.exec(operation('paui095-guard-schedule-dispatch-rollback.sql'));
    assert.equal((await row("select count(*)::int n from pg_trigger where tgname in ('pa_schedule_invitation_insert_guard','pa_schedule_invitation_revocation_guard')")).n,0);
    assert.equal((await row('select status from pa_email_deliveries where id=$1',[historicalDelivery.id])).status,'sent');
    await assert.rejects(()=>createScheduleDelivery(unaffected.input,fetchImpl),/supabase_400/);
    assert.equal(state.sendCount,3);
    console.log('PASS isolated schedule dispatch guards: historical and unknown token dedupe, revoke/reissue blocked during dispatch, safe retry and rollback; simulated Gmail 3, real Gmail 0');
  } finally { await db.close(); }
}

main().catch(error=>{ console.error(error); process.exitCode=1; });
