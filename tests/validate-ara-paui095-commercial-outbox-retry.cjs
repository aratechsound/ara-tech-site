const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { setup } = require('./validate-pam-025-direct-confirmation.cjs');
const { createService } = require('../api/_pa-commercial.cjs');

const directory = path.join(__dirname, '../supabase/operations');
const operation = name => fs.readFileSync(path.join(directory, 'paui095-commercial-outbox-retry-guard' + name + '.sql'), 'utf8');
const claim = (f, id, lease = randomUUID()) => f.db.query('select public.pa_v5_outbox_claim($1,$2,$3)', [f.actorId, id, lease]);
const saved = async (f, id) => (await f.db.query('select * from public.pa_commercial_outbox where id=$1', [id])).rows[0];
const requiresReview = async (f, id) => (await f.service.snapshot(f.inquiryId)).outbox.find(job => job.id === id).requires_reconciliation;
const seedEstimate = async f => (await f.createEstimate('LEGACY')).outbox_id;
const replayRejected = /outbox_unknown_requires_reconciliation/;

async function run(check) {
  const f = await setup();
  try {
    await f.db.exec(operation(''));
    await check(f);
  } finally {
    await f.db.close();
  }
}

async function verifyUnknown(f, responseStatus, invalidateRecord = false) {
  const id = await seedEstimate(f);
  const modified = createService({fetchImpl: async (url, options) => {
    const endpoint = new URL(url);
    if (invalidateRecord && /\/pa_v5_outbox_finish(?:_v2)?$/u.test(endpoint.pathname)) {
      return new Response('{}', {status:503});
    }
    const response = await f.fetchImpl(url, options);
    if (endpoint.hostname==='gmail.googleapis.com' && endpoint.pathname.endsWith('/messages/send')) {
      return new Response('{}', {status:responseStatus});
    }
    return response;
  }});
  await assert.rejects(() => modified.dispatch({job_id:id},f.actor), /mail_outcome_unknown/);
  let row = await saved(f,id);
  assert.equal(f.state.sendCount,1);
  if (invalidateRecord) {
    assert.equal(row.state,'processing');
    assert.equal(await requiresReview(f,id),false);
    await assert.rejects(() => claim(f,id), /outbox_busy/);
    await f.db.query("update public.pa_commercial_outbox set lease_expires_at=now()-interval '1 minute' where id=$1", [id]);
    row = await saved(f,id);
    await assert.rejects(() => claim(f,id,row.lease_id), replayRejected);
  } else {
    assert.equal(row.state,'unknown');
    assert.equal(row.delivery_state,'unknown_after_provider_start');
    assert.equal(row.provider_http_status,responseStatus);
  }
  assert.equal(await requiresReview(f,id),true);
  await assert.rejects(() => f.service.dispatch({job_id:id},f.actor), replayRejected);
  assert.deepEqual(await saved(f,id),row);
  assert.equal(f.state.sendCount,1);
}

async function verifyHistorical(f) {
  const id = await seedEstimate(f);
  const lease = randomUUID();
  await claim(f,id,lease);
  await f.db.query(`select public.pa_v5_outbox_finish_v2(
    $1,$2,$3,'failed',null,null,'gmail_send_503','failed_after_provider_response',
    'gmail_api_response','gmail_send_503','Fixture legacy classification',true,true,503)`, [f.actorId,id,lease]);
  const old = await saved(f,id);
  assert.equal(await requiresReview(f,id),true);
  await assert.rejects(() => claim(f,id), replayRejected);
  await assert.rejects(() => f.db.exec(operation('-rollback')), replayRejected);
  await f.db.exec('rollback');
  assert.deepEqual(await saved(f,id),old);
  assert.equal(f.state.sendCount,0);
}

async function verifyFailureWithoutDiagnostics(f) {
  const id = await seedEstimate(f);
  const lease = randomUUID();
  await claim(f,id,lease);
  await f.db.query(`select public.pa_v5_outbox_finish(
    $1,$2,$3,'failed',null,null,'legacy_fixture_failure')`, [f.actorId,id,lease]);
  const legacy = await saved(f,id);
  assert.equal(legacy.state,'failed');
  assert.equal(await requiresReview(f,id),true);
  await assert.rejects(() => claim(f,id), replayRejected);
  assert.deepEqual(await saved(f,id),legacy);
}

async function verifyDefiniteFailure(f) {
  const id = await seedEstimate(f);
  const beforeProvider = createService({fetchImpl: async (url, options) => {
    if (new URL(url).hostname==='oauth2.googleapis.com') return new Response('{}',{status:503});
    return f.fetchImpl(url,options);
  }});
  await assert.rejects(() => beforeProvider.dispatch({job_id:id},f.actor),/gmail_oauth_503/);
  assert.equal((await saved(f,id)).delivery_state,'failed_before_provider');
  assert.equal(await requiresReview(f,id),false);
  assert.equal(f.state.sendCount,0);
  f.state.transport='fail';
  await assert.rejects(() => f.service.dispatch({job_id:id},f.actor),/gmail_send_400/);
  assert.equal((await saved(f,id)).delivery_state,'failed_after_provider_response');
  assert.equal(await requiresReview(f,id),false);
  f.state.transport='ok';
  assert.equal((await f.service.dispatch({job_id:id},f.actor)).state,'sent');
  assert.equal((await f.service.dispatch({job_id:id},f.actor)).already_committed,true);
  assert.equal(f.state.sendCount,2);
  const final = await saved(f,id);
  assert.equal(await requiresReview(f,id),false);
  await f.db.exec(operation('-rollback'));
  assert.deepEqual(await saved(f,id),final);
}

async function main() {
  global.fetch = async () => { throw Error('LIVE_NETWORK_FORBIDDEN'); };
  await run(f => verifyUnknown(f,503));
  await run(f => verifyUnknown(f,200));
  await run(f => verifyUnknown(f,503,true));
  await run(verifyHistorical);
  await run(verifyFailureWithoutDiagnostics);
  await run(verifyDefiniteFailure);
  console.log('PASS commercial outbox: ambiguous 503 and malformed 200 stay UNKNOWN, failed diagnostic writes and historical ambiguous attempts cannot replay, definite pre-provider and 400 failures can retry, rollback refuses unresolved attempts, real Gmail 0');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
