const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { setup, MODE } = require('./validate-pam-025-direct-confirmation.cjs');
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
    await check(f);
  } finally {
    await f.db.close();
  }
}

async function verifyUnknown(f, responseStatus, { invalidateRecord = false, responseBody = {} } = {}) {
  const id = await seedEstimate(f);
  const modified = createService({fetchImpl: async (url, options) => {
    const endpoint = new URL(url);
    if (invalidateRecord && /\/pa_v5_outbox_finish(?:_v2)?$/u.test(endpoint.pathname)) {
      return new Response('{}', {status:503});
    }
    const response = await f.fetchImpl(url, options);
    if (endpoint.hostname==='gmail.googleapis.com' && endpoint.pathname.endsWith('/messages/send')) {
      if (responseStatus === null) throw new DOMException('Fixture provider response timed out', 'TimeoutError');
      return Response.json(responseBody, {status:responseStatus});
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
    assert.equal(row.provider_message_id,null);
    assert.equal(row.provider_thread_id,null);
  }
  assert.equal(await requiresReview(f,id),true);
  await assert.rejects(() => f.service.dispatch({job_id:id},f.actor), replayRejected);
  assert.deepEqual(await saved(f,id),row);
  assert.equal(f.state.sendCount,1);
}

async function verifyLostFinish(f, committed) {
  const id = await seedEstimate(f);
  const service = createService({fetchImpl: async (url, options) => {
    const endpoint = new URL(url);
    if (/\/pa_v5_outbox_finish(?:_v2)?$/u.test(endpoint.pathname)) {
      if (committed && endpoint.pathname.endsWith('_v2')) await f.fetchImpl(url, options);
      return new Response('{}', {status:503});
    }
    return f.fetchImpl(url, options);
  }});
  if (committed) {
    const result = await service.dispatch({job_id:id}, f.actor);
    assert.equal(result.finish_response_recovered, true);
    assert.equal((await saved(f, id)).state, 'sent');
    assert.equal((await service.dispatch({job_id:id}, f.actor)).already_committed, true);
  } else {
    await assert.rejects(() => service.dispatch({job_id:id}, f.actor), /mail_outcome_unknown/);
    assert.equal((await saved(f, id)).state, 'processing');
    await f.db.query("update public.pa_commercial_outbox set lease_expires_at=now()-interval '1 minute' where id=$1", [id]);
    await assert.rejects(() => service.dispatch({job_id:id}, f.actor), replayRejected);
  }
  assert.equal(f.state.sendCount, 1);
}

async function verifyReplacementGuard(f) {
  const allKinds = ['estimate', 'confirmation', 'confirmation_reminder', 'invoice', 'change_proposal', 'accept_receipt'];
  for (const jobKind of allKinds) {
    const aggregate = randomUUID();
    const insert = (state, delivery, started, response, status, evidence) => f.db.query(`
      insert into public.pa_commercial_outbox
      (id,inquiry_id,operation_id,job_kind,aggregate_id,state,delivery_state,recipient,subject,body_text,
       reply_binding,provider_request_started,provider_response_received,provider_http_status,provider_message_id)
      values($1,$2,$3,$4,$5,$6,$7,'fixture@example.invalid','Fixture','Fixture','{}',$8,$9,$10,$11)
    `, [randomUUID(), f.inquiryId, randomUUID(), jobKind, aggregate, state, delivery, started, response, status, evidence]);
    // The old dispatcher could preserve failed with apparently retryable diagnostics.
    // A provider ID overrides that classification for both retry and new operation IDs.
    await insert('failed', 'failed_after_provider_response', true, true, 400, 'provider_evidence');
    const jobs = (await f.service.snapshot(f.inquiryId)).outbox;
    const previous = jobs.find(job => job.aggregate_id === aggregate);
    assert.equal(previous.requires_reconciliation, true, jobKind);
    await assert.rejects(() => insert('queued', null, false, false, null, null), replayRejected);
    assert.equal((await saved(f, previous.id)).provider_message_id, 'provider_evidence');
  }
  assert.equal(f.state.sendCount, 0);
  console.log('PASS unresolved provider evidence prevents replacement job insertion for every commercial job kind');
}

async function verifyAcceptedReplyEvidence(f, { failure, matchingThread = true }) {
  const id = await seedEstimate(f);
  const service = createService({ fetchImpl: async (url, options) => {
    const endpoint = new URL(url);
    const sending = endpoint.hostname === 'gmail.googleapis.com' && endpoint.pathname.endsWith('/messages/send');
    if (f.state.sendCount && failure === 'audit' &&
      endpoint.pathname === '/rest/v1/pa_inquiry_audit' && options?.method === 'POST') {
      return new Response('{}', {status: 503});
    }
    const response = await f.fetchImpl(url, options);
    if (sending && !matchingThread) {
      return Response.json({ id: 'sent_contract_1', threadId: 'other_thread' });
    }
    return response;
  }});
  if (failure === 'sync') {
    f.state.failPostSendRead = true;
    f.state.failPostSendReadAfter = 0;
  }

  await assert.rejects(() => service.dispatch({ job_id: id }, f.actor), /mail_outcome_unknown/);
  const row = await saved(f, id);
  assert.equal(row.state, 'unknown');
  assert.equal(row.delivery_state, 'unknown_after_provider_start');
  assert.equal(row.provider_response_received, true);
  assert.equal(row.provider_http_status, 200);
  assert.equal(row.provider_message_id, matchingThread ? 'sent_contract_1' : null);
  assert.equal(row.provider_thread_id, matchingThread ? 'thread_123' : null);
  assert.equal(await requiresReview(f, id), true);
  const snapshot = await f.service.snapshot(f.inquiryId);
  assert.equal(snapshot.estimates[0].delivery.state, 'unknown');
  await assert.rejects(() => f.service.dispatch({ job_id: id }, f.actor), replayRejected);
  assert.deepEqual(await saved(f, id), row);
  assert.equal(f.state.sendCount, 1);

  if (failure === 'audit' && matchingThread) {
    await f.db.exec(operation('-rollback'));
    await assert.rejects(() => claim(f, id), replayRejected);
    assert.deepEqual(await saved(f, id), row);
    assert.equal(f.state.sendCount, 1);
  }
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

async function verifyDirectConfirmationRace(f) {
  const id = await seedEstimate(f);
  const input = { case_id:f.inquiryId, confirmation_mode:MODE };
  const preview = await f.service.confirmationPreview(input,f.actor);
  const service = createService({fetchImpl: async (url, options) => {
    if (new URL(url).pathname.endsWith('/pa_v5_issue_confirmation')) {
      const lease = randomUUID();
      await claim(f,id,lease);
      await f.fetchImpl('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
        method:'POST', body:JSON.stringify({raw:'Zml4dHVyZQ',threadId:'thread_123'})
      });
      await f.db.query(`select public.pa_v5_outbox_finish(
        $1,$2,$3,'failed',null,null,'legacy_fixture_failure')`, [f.actorId,id,lease]);
    }
    return f.fetchImpl(url,options);
  }});
  await assert.rejects(() => service.issueDirectConfirmationAndSend({
    ...input, preview_fingerprint:preview.fingerprint, operation_id:randomUUID()
  }, f.actor), replayRejected);
  const snapshot = await f.service.snapshot(f.inquiryId);
  assert.equal(snapshot.confirmation_preflight.delivery_outcome_unresolved,true);
  assert.equal(snapshot.offers.length,0);
  assert.equal(snapshot.outbox.length,1);
  assert.equal((await saved(f,id)).state,'failed');
  await assert.rejects(() => f.service.confirmationPreview(input,f.actor),/delivery_outcome_unresolved/);
  assert.equal(f.state.sendCount,1);
}

async function verifyDirectConfirmationAfterRejection(f) {
  const id = await seedEstimate(f);
  f.state.transport = 'fail';
  await assert.rejects(() => f.service.dispatch({job_id:id},f.actor),/gmail_send_400/);
  f.state.transport = 'ok';
  const input = { case_id:f.inquiryId, confirmation_mode:MODE };
  const preview = await f.service.confirmationPreview(input,f.actor);
  const sent = await f.service.issueDirectConfirmationAndSend({
    ...input, preview_fingerprint:preview.fingerprint, operation_id:randomUUID()
  }, f.actor);
  assert.equal(sent.state,'sent');
  assert.equal((await saved(f,id)).state,'cancelled');
  assert.equal(f.state.sendCount,2);
}

async function verifyMixedVersion() {
  const f = await setup({ retryGuard: false });
  try {
    const id = await seedEstimate(f);
    const initial = await saved(f, id);
    await assert.rejects(() => f.service.dispatch({ job_id: id }, f.actor), /outbox_retry_guard_unavailable/);
    assert.deepEqual(await saved(f, id), initial);

    const preview = await f.service.confirmationPreview({ case_id: f.inquiryId, confirmation_mode: MODE }, f.actor);
    await assert.rejects(() => f.service.issueDirectConfirmationAndSend({
      case_id: f.inquiryId, confirmation_mode: MODE, preview_fingerprint: preview.fingerprint, operation_id: randomUUID()
    }, f.actor), /outbox_retry_guard_unavailable/);
    assert.equal((await f.service.snapshot(f.inquiryId)).offers.length, 0);

    const lease = randomUUID();
    await claim(f, id, lease);
    await f.db.query("update public.pa_commercial_outbox set lease_expires_at=now()-interval '1 minute' where id=$1", [id]);
    const expired = await saved(f, id);
    await assert.rejects(() => f.service.dispatch({ job_id: id }, f.actor), /outbox_retry_guard_unavailable/);
    assert.deepEqual(await saved(f, id), expired);
    await f.db.query(`select public.pa_v5_outbox_finish_v2(
      $1,$2,$3,'failed',null,null,'gmail_send_503','failed_after_provider_response',
      'gmail_api_response','gmail_send_503','Fixture legacy classification',true,true,503)`, [f.actorId, id, lease]);
    const ambiguous = await saved(f, id);
    await assert.rejects(() => f.service.dispatch({ job_id: id }, f.actor), /outbox_retry_guard_unavailable/);
    assert.deepEqual(await saved(f, id), ambiguous);
    assert.equal(f.state.sendCount, 0);

    await f.db.exec(operation(''));
    await assert.rejects(() => claim(f, id), replayRejected);
    await assert.rejects(() => f.service.dispatch({ job_id: id }, f.actor), replayRejected);
    assert.deepEqual(await saved(f, id), ambiguous);
    console.log('PASS mixed versions stop dispatch with missing guard and block legacy claims after install, mock sends 0');
  } finally {
    await f.db.close();
  }
}

async function verifyLegacyUnknownRollback() {
  const f = await setup({ retryGuard: false });
  try {
    const id = randomUUID();
    await f.db.query(`insert into public.pa_commercial_outbox
      (id,inquiry_id,operation_id,job_kind,aggregate_id,state,delivery_state,recipient,subject,body_text,reply_binding,
        last_error_code,attempt_count)
      values($1,$2,$3,'confirmation',$4,'unknown',null,'fixture@example.invalid','Fixture','Fixture','{}','mail_outcome_unknown',1)`,
    [id, f.inquiryId, randomUUID(), randomUUID()]);
    const before = await saved(f, id);
    await assert.rejects(() => claim(f, id), replayRejected);
    await f.db.exec(operation(''));
    await assert.rejects(() => f.db.query('select public.pa_v5_claim_guarded_outbox($1,$2,$3)', [f.actorId, id, randomUUID()]), replayRejected);
    await assert.rejects(() => claim(f, id), replayRejected);
    assert.deepEqual(await saved(f, id), before);
    assert.equal(await requiresReview(f, id), true);
    const { rows: [access] } = await f.db.query(`select
      has_function_privilege('anon','public.pa_v5_claim_guarded_outbox(uuid,uuid,uuid)','execute') as anon,
      has_function_privilege('authenticated','public.pa_v5_claim_guarded_outbox(uuid,uuid,uuid)','execute') as authenticated,
      has_function_privilege('service_role','public.pa_v5_claim_guarded_outbox(uuid,uuid,uuid)','execute') as service`);
    assert.deepEqual(access, {anon:false,authenticated:false,service:true});
    await f.db.exec('alter table public.pa_commercial_outbox disable trigger pa_commercial_outbox_retry_guard');
    await assert.rejects(() => f.db.query('select public.pa_v5_claim_guarded_outbox($1,$2,$3)', [f.actorId, id, randomUUID()]), /outbox_retry_guard_unavailable/);
    await f.db.exec('alter table public.pa_commercial_outbox enable trigger pa_commercial_outbox_retry_guard');
    await f.db.exec('alter table public.pa_commercial_outbox disable trigger pa_commercial_outbox_retry_insert_guard');
    await assert.rejects(() => f.db.query('select public.pa_v5_assert_outbox_retry_guard()'), /outbox_retry_guard_unavailable/);
    await f.db.exec('alter table public.pa_commercial_outbox enable trigger pa_commercial_outbox_retry_insert_guard');
    await f.db.exec(operation('-rollback'));
    await assert.rejects(() => claim(f, id), replayRejected);
    assert.deepEqual(await saved(f, id), before);
    assert.equal(f.state.sendCount, 0);
    console.log('PASS preexisting confirmation UNKNOWN, with null diagnostic state, survives apply and rollback unchanged');
  } finally {
    await f.db.close();
  }
}

async function main() {
  global.fetch = async () => { throw Error('LIVE_NETWORK_FORBIDDEN'); };
  await verifyMixedVersion();
  await verifyLegacyUnknownRollback();
  await run(f => verifyAcceptedReplyEvidence(f, { failure: 'audit' }));
  await run(f => verifyAcceptedReplyEvidence(f, { failure: 'sync' }));
  await run(f => verifyAcceptedReplyEvidence(f, { failure: 'audit', matchingThread: false }));
  await run(f => verifyUnknown(f,503));
  await run(f => verifyUnknown(f,200));
  await run(f => verifyUnknown(f,200,{responseBody:{id:1234,threadId:'thread_123'}}));
  await run(f => verifyUnknown(f,null));
  await run(f => verifyUnknown(f,503,{invalidateRecord:true}));
  await run(f => verifyLostFinish(f, true));
  await run(f => verifyLostFinish(f, false));
  await run(verifyHistorical);
  await run(verifyFailureWithoutDiagnostics);
  await run(verifyReplacementGuard);
  await run(verifyDefiniteFailure);
  await run(verifyDirectConfirmationRace);
  await run(verifyDirectConfirmationAfterRejection);
  console.log('PASS commercial outbox: accepted matching IDs survive audit and sync failures while UNKNOWN prevents replay, mismatched and malformed responses log no IDs, historical ambiguous attempts and interrupted leases cannot replay, definite failures can retry, rollback refuses unresolved attempts, real Gmail 0');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
