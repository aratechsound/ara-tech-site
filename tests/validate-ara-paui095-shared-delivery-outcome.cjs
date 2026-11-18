const assert = require('node:assert/strict');
const {randomBytes,randomUUID} = require('node:crypto');
const {createFixture} = require('./helpers/ara-case-fixture.cjs');
const {sendScheduleResultAndFinalize,sendContentHearingAndFinalize,sendAutomaticInquiryEmails,retryDelivery} = require('../api/_pa-mail.cjs');

async function main() {
  const {db,actor,state,fetchImpl} = await createFixture();
  const providerPath = '/gmail/v1/users/me/messages/send';
  const row = async (sql,args=[]) => (await db.query(sql,args)).rows[0];
  const makeCase = status => row("insert into pa_inquiries(customer_name,email,event_name,status,case_type) values ('Fixture','fixture@example.invalid','Synthetic event',$1,'PA_EVENT') returning *",[status]);
  const retry = (delivery,inquiry,adapter=fetchImpl) => retryDelivery({deliveryId:delivery.id,inquiry,actorUserId:actor},adapter);
  const loseProviderReply = async (url,options) => {
    const response = await fetchImpl(url,options);
    if (new URL(url).pathname===providerPath) {
      assert.equal(response.ok,true);
      throw Error('Fixture acknowledgement lost after acceptance');
    }
    return response;
  };
  const rejectProvider = (url,options) => new URL(url).pathname===providerPath
    ? new Response('{}',{status:400}) : fetchImpl(url,options);
  const loseStorageReply = async (url,options) => {
    const response = await fetchImpl(url,options);
    if (new URL(url).pathname==='/rest/v1/pa_email_deliveries' && options.method==='PATCH'
        && JSON.parse(options.body).status==='sent') throw Error('Fixture database acknowledgement lost after commit');
    return response;
  };
  const confirmNoRetry = (delivery,inquiry) => assert.rejects(()=>retry(delivery,inquiry),/retry_not_allowed/);
  const answer = {respondent_name:'Fixture',confirmation_name:'Fixture',email:'fixture@example.invalid',
    phone:'010-0000-0000',relationship:'organizer',authority:'yes',decision:'agree',
    agreements:['not-secured','adjustment-starts','completion-notice','schedule-fee','cancellation-fee','no-fee-if-unsecured','authorized']};

  const makeResult = async () => {
    const scheduled = await makeCase('schedule_coordination');
    const token = randomBytes(32).toString('base64url');
    await row("select * from issue_pa_schedule_token($1,$2,now()+interval '1 day')",[scheduled.id,token]);
    assert.equal((await row('select result from submit_pa_schedule_response($1,$2,$3)',[token,JSON.stringify(answer),randomUUID()])).result,'accepted');
    const inquiry = await row('select * from pa_inquiries where id=$1',[scheduled.id]);
    return {inquiry,result:'confirmed',actorUserId:actor,
      subject:'Fixture '+inquiry.inquiry_number,body:inquiry.inquiry_number+'\n見積・契約・正式予約のご案内'};
  };
  try {
    const resultInput = await makeResult();
    const {inquiry} = resultInput;
    const first = await sendScheduleResultAndFinalize(resultInput,loseProviderReply);
    assert.equal(first.delivery.status,'unknown');
    assert.equal(first.delivery.error_summary,'mail_outcome_unknown');
    assert.equal(first.caseState,null);
    assert.equal((await row('select status from pa_inquiries where id=$1',[inquiry.id])).status,'schedule_adjusting');
    await confirmNoRetry(first.delivery,inquiry);
    assert.equal((await sendScheduleResultAndFinalize(resultInput,fetchImpl)).delivery.id,first.delivery.id);
    assert.equal(state.sendCount,1);

    const intake = await makeCase('new_inquiry');
    const hearingInput = {inquiry:intake,subject:'Fixture hearing',body:'ご希望をお知らせください。',actorUserId:actor};
    const explicit = await sendContentHearingAndFinalize(hearingInput,rejectProvider);
    assert.equal(explicit.delivery.status,'failed');
    assert.equal(explicit.delivery.error_summary,'gmail_send_400');
    const uncertain = await retry(explicit.delivery,intake,loseProviderReply);
    assert.equal(uncertain.status,'unknown');
    assert.equal(uncertain.attempt_number,2);
    await confirmNoRetry(uncertain,intake);
    await confirmNoRetry(explicit.delivery,intake);
    assert.equal((await row('select status from pa_inquiries where id=$1',[intake.id])).status,'new_inquiry');
    assert.equal(state.sendCount,2);

    const laterFailure = await row(`insert into pa_email_deliveries
      (inquiry_id,message_type,dedupe_key,attempt_number,is_retry,retry_of,recipient,subject,body,status,failed_at,error_summary)
      select inquiry_id,message_type,dedupe_key,3,true,id,recipient,subject,body,'failed',now(),'gmail_send_400'
      from pa_email_deliveries where id=$1 returning id`,[uncertain.id]);
    await assert.rejects(()=>retry(laterFailure,intake),/mail_outcome_unknown/);
    assert.equal(state.sendCount,2,'a newer explicit failure cannot bypass an older unknown row');

    const historical = await makeCase('new_inquiry');
    const old = await sendContentHearingAndFinalize({...hearingInput,inquiry:historical},rejectProvider);
    await db.query("update pa_email_deliveries set error_summary='mail_delivery_failed' where id=$1",[old.delivery.id]);
    await assert.rejects(()=>retry(old.delivery,historical),/mail_outcome_unknown/);

    const automatic = await makeCase('new_inquiry');
    const ambiguous = await sendAutomaticInquiryEmails(automatic,loseStorageReply);
    assert.equal(ambiguous.length,2);
    assert(ambiguous.every(delivery=>delivery.status==='unknown' && delivery.error_summary==='mail_outcome_unknown'));
    const saved = await sendAutomaticInquiryEmails(automatic,fetchImpl);
    assert(saved.every(delivery=>delivery.status==='sent' && delivery.gmail_message_id));
    assert.equal(state.sendCount,4,'readback of committed acknowledgements does not dispatch again');
    const changedResult = await makeResult();
    const rejectedResult = await sendScheduleResultAndFinalize(changedResult,rejectProvider);
    assert.equal(rejectedResult.delivery.status,'failed');
    const duringOAuth = async (url,options) => {
      if (new URL(url).origin==='https://oauth2.googleapis.com') {
        await db.query('update pa_case_progress set is_on_hold=true where inquiry_id=$1',[changedResult.inquiry.id]);
      }
      return fetchImpl(url,options);
    };
    const canceled = await retry(rejectedResult.delivery,changedResult.inquiry,duringOAuth);
    assert.equal(canceled.status,'failed');
    assert.equal(canceled.error_summary,'mail_before_dispatch_failed');
    assert.equal(state.sendCount,4,'a hold reached during OAuth stops schedule dispatch');
    assert.equal((await row('select status from pa_inquiries where id=$1',[changedResult.inquiry.id])).status,'schedule_adjusting');
    await assert.rejects(()=>retry(canceled,changedResult.inquiry),/retry_not_allowed/);
    console.log('PASS shared mail delivery acknowledgement: result and hearing, safe retry, historical ambiguity, automatic readback, HOLD during OAuth; simulated Gmail 4, real Gmail 0');
  } finally { await db.close(); }
}

main().catch(error=>{ console.error(error); process.exitCode=1; });
