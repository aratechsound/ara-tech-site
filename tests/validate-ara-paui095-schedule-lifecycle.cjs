'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createFixture } = require('./helpers/ara-case-fixture.cjs');
const { createScheduleDelivery, retryDelivery, submitScheduleResponseAndNotify, buildCustomerHtml, normalizeCustomerBody } = require('../api/_pa-mail.cjs');
const mailHandler = require('../api/pa-mail.js');

const answer = {
    respondent_name:'合成担当者', confirmation_name:'合成担当者',
    email:'respondent@example.invalid', phone:'012-000-0000', relationship:'organizer',
    authority:'yes', decision:'agree', agreements:[
        'not-secured','adjustment-starts','completion-notice','schedule-fee',
        'cancellation-fee','no-fee-if-unsecured','authorized'
    ]
};
const urlFor = token => 'https://ara-tech.cc/pa-schedule-confirm.html?token=' + token;

(async () => {
    const f = await createFixture();
    const { db, actor, state, fetchImpl } = f;
    const row = async (sql, args = []) => (await db.query(sql,args)).rows[0];
    const withRole = async (role, action) => {
        await db.exec('set role ' + role);
        try { return await action(); } finally { await db.exec('reset role'); }
    };
    const makeCase = async status => row(
        "insert into pa_inquiries(customer_name,email,event_name,public_event_name,internal_memo,event_date,venue,public_conditions,case_type,status) values ('Fixture','customer@example.invalid','Private fixture','Public fixture','DO_NOT_EXPOSE','2027-01-01','Fixture hall','Fixture terms','PA_EVENT',$1) returning *",[status]
    );
    const ownerCommand = async (inquiry, action, token=null) => {
        const version = await row("select updated_at::text,(select id from pa_schedule_tokens where inquiry_id=$1 and revoked_at is null and answered_at is null) token_id from pa_inquiries where id=$1",[inquiry.id]);
        const result = await withRole('authenticated',()=>row(
            "select public.pa_manage_schedule_token_v2($1,$2,$3,$4,$5,case when $5::text is null then null else now()+interval '1 day' end) result",
            [inquiry.id,version.updated_at,version.token_id,action,token]
        ));
        return result.result;
    };
    const issue = async (inquiry) => {
        const token=crypto.randomBytes(32).toString('base64url');
        const issued=await ownerCommand(inquiry,'issue',token);
        assert.equal(issued.state,'issued');
        return {token,id:issued.token_id};
    };
    const revoke = async inquiry => ({revoked:(await ownerCommand(inquiry,'revoke')).state==='revoked'});
    const lookup = token => withRole('anon',()=>row('select * from get_pa_schedule_case($1)',[token]));
    const readInquiry = inquiry => row('select * from pa_inquiries where id=$1',[inquiry.id]);
    const prepare = (inquiry, token, key=crypto.randomUUID(), extra='') => ({
        inquiry, operationKey:key, actorUserId:actor, subject:'日程案内 '+inquiry.inquiry_number,
        scheduleUrl:urlFor(token),body:'ご確認ください。\n'+urlFor(token)+'\n'+extra
    });
    const counts = () => row('select (select count(*)::int from pa_email_deliveries) deliveries, (select count(*)::int from pa_schedule_responses) responses');
    const requestSchedule = async (input, credential='fixture-admin') => {
        const response = {
            statusCode:200, setHeader(){}, status(code){this.statusCode=code;return this;},
            json(payload){this.payload=payload;return this;}
        };
        const savedFetch=global.fetch;
        try {
            global.fetch=fetchImpl;
            await mailHandler({
                method:'POST',url:'/api/pa-mail',body:input,
                headers:{origin:'https://ara-tech.cc',host:'ara-tech.cc',authorization:'Bearer '+credential,'x-forwarded-for':'192.0.2.31'}
            },response);
            return response;
        } finally { global.fetch=savedFetch; }
    };
    try {
        await db.exec("grant execute on function public.issue_pa_schedule_token(uuid,text,timestamptz),public.revoke_pa_schedule_token(uuid) to anon,authenticated,service_role");
        for (const file of ['paui095-guard-schedule-token.sql','paui095-guard-schedule-dispatch.sql']) {
            await db.exec(fs.readFileSync(path.resolve(__dirname,'../supabase/operations',file),'utf8'));
        }
        const fresh = await makeCase('new');
        assert.deepEqual(await ownerCommand(fresh,'issue',crypto.randomBytes(32).toString('base64url')),{state:'unavailable'});
        const target=await makeCase('schedule_coordination');
        const other=await makeCase('schedule_coordination');
        const expiring=await makeCase('schedule_coordination');
        const expired=await issue(expiring);
        await db.query("update pa_schedule_tokens set issued_at=now()-interval '2 days',expires_at=now()-interval '1 day' where id=$1",[expired.id]);
        const previous=await issue(target);
        const now=await issue(target);
        const foreign=await issue(other);
        assert.equal((await lookup(previous.token)).access_state,'invalid');
        assert.equal((await lookup(expired.token)).access_state,'expired');
        await assert.rejects(()=>createScheduleDelivery(prepare(expiring,expired.token),fetchImpl),/schedule_token_not_available/);
        const publicForm=await lookup(now.token);
        assert.equal(publicForm.access_state,'valid');
        assert.equal(publicForm.event_name,'Public fixture');
        assert.doesNotMatch(JSON.stringify(publicForm),/DO_NOT_EXPOSE|Private fixture|token_hash/);
        const stored=await row('select token_hash from pa_schedule_tokens where id=$1',[now.id]);
        assert.deepEqual(Buffer.from(stored.token_hash),crypto.createHash('sha256').update(now.token).digest());
        const current=await readInquiry(target);

        const before=await counts();
        for(const invalid of [previous.token,foreign.token,crypto.randomBytes(32).toString('base64url')]){
            await assert.rejects(()=>createScheduleDelivery(prepare(current,invalid),fetchImpl),/schedule_token_not_available/);
            assert.deepEqual(await counts(),before);
            assert.equal(state.sendCount,0);
        }
        const crossCase=prepare(current,foreign.token);
        const refused=await requestSchedule({action:'send_schedule',inquiry_id:current.id,
            subject:crossCase.subject,body:crossCase.body,schedule_url:crossCase.scheduleUrl,operation_key:crossCase.operationKey});
        assert.equal(refused.statusCode,409);
        assert.deepEqual(refused.payload,{ok:false,code:'schedule_token_not_available'});
        assert.deepEqual(await counts(),before);
        await assert.rejects(()=>createScheduleDelivery(prepare(current,now.token,undefined,urlFor(foreign.token)),fetchImpl),/invalid_schedule_message/);
        assert.equal(state.sendCount,0);
        const send=prepare(current,now.token);
        const previewInput={action:'preview_schedule',kind:'invitation',inquiry_id:current.id,
            expected_recipient:current.email,subject:send.subject,body:send.body,schedule_url:send.scheduleUrl};
        const beforePreview=await counts();
        const readsBeforePreview=state.network.length;
        const preview=await requestSchedule(previewInput);
        assert.equal(preview.statusCode,200);
        assert.equal(preview.payload.html,buildCustomerHtml(normalizeCustomerBody(send.body)));
        assert.deepEqual(await counts(),beforePreview);
        assert(state.network.slice(readsBeforePreview).every(request=>request.method==='GET'));
        assert.equal((await requestSchedule({...previewInput,expected_recipient:'outside@example.invalid'})).statusCode,409);
        assert.equal((await requestSchedule(previewInput,'foreign-fixture')).statusCode,401);
        const changedRecipient=await requestSchedule({...previewInput,action:'send_schedule',operation_key:send.operationKey,expected_recipient:'outside@example.invalid'});
        assert.equal(changedRecipient.statusCode,409);
        assert.deepEqual(await counts(),beforePreview);
        assert.equal(state.sendCount,0);
        assert.equal((await createScheduleDelivery(send,fetchImpl)).status,'sent');
        assert.equal((await createScheduleDelivery(send,fetchImpl)).status,'sent');
        assert.equal(state.sendCount,1);

        const submissionKey=crypto.randomUUID();
        const submit=(token,key=submissionKey)=>submitScheduleResponseAndNotify({token,response:answer,submissionKey:key},fetchImpl);
        assert.equal((await submit(now.token)).result,'accepted');
        assert.equal((await submit(now.token)).result,'accepted');
        assert.equal((await submit(now.token,crypto.randomUUID())).result,'already_answered');
        assert.equal(state.sendCount,3,'one invitation and two response notifications');
        assert.equal((await lookup(now.token)).access_state,'answered');
        assert.equal((await readInquiry(target)).status,'schedule_adjusting');
        assert.equal((await counts()).responses,1);
        const answered=await readInquiry(target);
        const resultBody=answered.inquiry_number+'\n見積・契約・正式予約をご案内します。';
        const beforeResultPreview=await counts();
        const resultPreview=await requestSchedule({action:'preview_schedule',kind:'result',result:'confirmed',
            inquiry_id:answered.id,expected_recipient:answered.email,
            subject:'日程確定 '+answered.inquiry_number,body:resultBody});
        assert.equal(resultPreview.statusCode,200);
        assert.equal(resultPreview.payload.html,buildCustomerHtml(normalizeCustomerBody(resultBody)));
        assert.deepEqual(await counts(),beforeResultPreview);
        assert.equal(state.sendCount,3);

        assert.equal((await createScheduleDelivery({...send,inquiry:answered},fetchImpl)).status,'sent');
        assert.equal(state.sendCount,3);
        await assert.rejects(()=>createScheduleDelivery(prepare(answered,now.token),fetchImpl),/schedule_token_not_available/);
        assert.equal((await revoke(target)).revoked,false,'an answered link cannot be revoked');
        assert.equal((await revoke(other)).revoked,true);
        assert.equal((await lookup(foreign.token)).access_state,'invalid');
        assert.equal((await submit(foreign.token,crypto.randomUUID())).result,'invalid');
        const retryToken=await issue(other);
        const latestOther=await readInquiry(other);
        const simulateGmailFailure=(url,options)=>new URL(url).pathname.endsWith('/messages/send')
            ? new Response('{}',{status:400}) : fetchImpl(url,options);
        const failed=await createScheduleDelivery(prepare(latestOther,retryToken.token),simulateGmailFailure);
        assert.equal(failed.status,'failed');
        const snapshot = crypto.createHash('sha256').update(JSON.stringify([
            failed.inquiry_id,failed.id,failed.message_type,failed.attempt_number,failed.recipient,failed.subject,failed.body
        ])).digest('hex');
        const retryPreview={action:'preview_schedule_retry',inquiry_id:latestOther.id,
            delivery_id:failed.id,expected_recipient:latestOther.email,expected_snapshot:snapshot};
        const beforeRetryPreview=await counts();
        const previewReadStart=state.network.length;
        const retryDraft=await requestSchedule(retryPreview);
        assert.equal(retryDraft.statusCode,200);
        assert.deepEqual(retryDraft.payload,{ok:true,html:buildCustomerHtml(failed.body),delivery_snapshot:snapshot});
        assert(state.network.slice(previewReadStart).every(request=>request.method==='GET'));
        assert.equal((await requestSchedule({...retryPreview,action:'retry',expected_snapshot:'0'.repeat(64)})).statusCode,409);
        assert.equal((await requestSchedule({...retryPreview,expected_snapshot:'0'.repeat(64)})).statusCode,409);
        const foreignPreview=await requestSchedule({...retryPreview,inquiry_id:current.id,expected_recipient:current.email});
        assert.equal(foreignPreview.statusCode,400);
        assert.deepEqual(foreignPreview.payload,{ok:false,code:'retry_not_allowed'});
        assert.deepEqual(await counts(),beforeRetryPreview);
        assert.equal(state.sendCount,3);
        await assert.rejects(()=>retryDelivery({deliveryId:failed.id,inquiry:{...latestOther,email:'changed@example.invalid'},actorUserId:actor},fetchImpl),/retry_not_allowed/);
        await revoke(other);
        const beforeRetry=await counts();
        const revokedOther=await readInquiry(other);
        await assert.rejects(()=>retryDelivery({deliveryId:failed.id,inquiry:revokedOther,actorUserId:actor},fetchImpl),/schedule_token_not_available/);
        assert.deepEqual(await counts(),beforeRetry);
        assert.equal(state.sendCount,3);
        const newAttempt = async () => {
            const inquiry = await makeCase('schedule_coordination');
            const {token} = await issue(inquiry);
            return prepare(await readInquiry(inquiry),token);
        };
        const providerPath = '/gmail/v1/users/me/messages/send';
        const deliveryPath = '/rest/v1/pa_email_deliveries';
        const loseGmailReply = async (url,options) => {
            const result = await fetchImpl(url,options);
            if (new URL(url).pathname === providerPath) {
                assert.equal(result.ok,true);
                throw Error('fixture lost the provider acknowledgement');
            }
            return result;
        };
        const accepted = await newAttempt();
        const unknown = await createScheduleDelivery(accepted,loseGmailReply);
        assert.equal(unknown.status,'unknown');
        assert.equal(unknown.error_summary,'mail_outcome_unknown');
        assert.equal(unknown.failed_at,null);
        const unknownReadback = await row('select status from pa_email_deliveries where id=$1',[unknown.id]);
        assert.equal(unknownReadback.status,'unknown');
        await assert.rejects(()=>retryDelivery({deliveryId:unknown.id,inquiry:accepted.inquiry,actorUserId:actor},fetchImpl),/retry_not_allowed/);
        assert.equal((await createScheduleDelivery(accepted,fetchImpl)).id,unknown.id);
        assert.equal(state.sendCount,4,'one dispatch even if its response was lost');

        for (const response of [new Response('{}',{status:503}), new Response('{}',{status:200})]) {
            const input = await newAttempt();
            const delivery = await createScheduleDelivery(input,(url,options) => new URL(url).pathname===providerPath
                ? response : fetchImpl(url,options));
            assert.equal(delivery.status,'unknown');
            assert.equal(delivery.error_summary,'mail_outcome_unknown');
            await assert.rejects(()=>retryDelivery({deliveryId:delivery.id,inquiry:input.inquiry,actorUserId:actor},fetchImpl),/retry_not_allowed/);
        }

        const oauthFailed = await newAttempt();
        const beforeProvider = await createScheduleDelivery(oauthFailed,(url,options) => {
            if (new URL(url).origin==='https://oauth2.googleapis.com') throw Error('fixture OAuth unavailable');
            return fetchImpl(url,options);
        });
        assert.equal(beforeProvider.status,'failed');
        assert.equal(beforeProvider.error_summary,'mail_before_dispatch_failed');
        const retried = await retryDelivery({deliveryId:beforeProvider.id,inquiry:oauthFailed.inquiry,actorUserId:actor},fetchImpl);
        assert.equal(retried.status,'sent');

        const saved = await newAttempt();
        const loseWriteReply = async (url,options) => {
            const result = await fetchImpl(url,options);
            if (new URL(url).pathname===deliveryPath && options?.method==='PATCH'
                && JSON.parse(options.body).status==='sent') throw Error('fixture lost the committed DB acknowledgement');
            return result;
        };
        await assert.rejects(()=>createScheduleDelivery(saved,loseWriteReply),/mail_outcome_unknown/);
        const sentReadback = await createScheduleDelivery(saved,fetchImpl);
        assert.equal(sentReadback.status,'sent');
        assert.equal(state.sendCount,6);

        const recovered = await newAttempt();
        const rejected = await createScheduleDelivery(recovered,simulateGmailFailure);
        const lostRetry = await retryDelivery({deliveryId:rejected.id,inquiry:recovered.inquiry,actorUserId:actor},loseGmailReply);
        assert.equal(lostRetry.status,'unknown');
        assert.equal(lostRetry.attempt_number,2);
        await assert.rejects(()=>retryDelivery({deliveryId:rejected.id,inquiry:recovered.inquiry,actorUserId:actor},fetchImpl),/retry_not_allowed/);
        assert.equal(state.sendCount,7,'the older failed attempt cannot bypass a newer unknown retry');
        const historical = await newAttempt();
        const oldFailure = await createScheduleDelivery(historical,simulateGmailFailure);
        await db.query("update pa_email_deliveries set error_summary='mail_delivery_failed' where id=$1",[oldFailure.id]);
        await assert.rejects(()=>retryDelivery({deliveryId:oldFailure.id,inquiry:historical.inquiry,actorUserId:actor},fetchImpl),/mail_outcome_unknown/);
        const rejectedOverHttp = await requestSchedule({
            action:'retry',inquiry_id:historical.inquiry.id,delivery_id:oldFailure.id
        });
        assert.equal(rejectedOverHttp.statusCode,409);
        assert.deepEqual(rejectedOverHttp.payload,{ok:false,code:'mail_outcome_unknown'});
        assert.equal(state.sendCount,7,'ambiguous historical failure must not dispatch');
        console.log('PASS isolated schedule lifecycle: hash-only, public fields, reissue/revoke, exact-case send and retry, single response and delivery dedupe; ambiguous delivery retry refused, simulated Gmail 7, real sends 0');
    } finally {
        await db.close();
    }
})().catch(error=>{console.error(error);process.exitCode=1;});
