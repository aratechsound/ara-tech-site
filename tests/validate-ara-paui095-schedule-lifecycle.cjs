'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createFixture } = require('./helpers/ara-case-fixture.cjs');
const { createScheduleDelivery, retryDelivery, submitScheduleResponseAndNotify } = require('../api/_pa-mail.cjs');
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
        "insert into pa_inquiries(customer_name,email,event_name,public_event_name,internal_memo,case_type,status) values ('Fixture','customer@example.invalid','Private fixture','Public fixture','DO_NOT_EXPOSE','PA_EVENT',$1) returning *",[status]
    );
    const issue = async (inquiry, expiry='1 day') => {
        const token=crypto.randomBytes(32).toString('base64url');
        const issued=await withRole('authenticated',()=>row(
            'select * from issue_pa_schedule_token($1,$2,now()+$3::interval)',[inquiry.id,token,expiry]
        ));
        return {token,id:issued.token_id};
    };
    const revoke = inquiry => withRole('authenticated',()=>row(
        'select revoke_pa_schedule_token($1) as revoked',[inquiry.id]
    ));
    const lookup = token => withRole('anon',()=>row('select * from get_pa_schedule_case($1)',[token]));
    const readInquiry = inquiry => row('select * from pa_inquiries where id=$1',[inquiry.id]);
    const prepare = (inquiry, token, key=crypto.randomUUID(), extra='') => ({
        inquiry, operationKey:key, actorUserId:actor, subject:'日程案内 '+inquiry.inquiry_number,
        scheduleUrl:urlFor(token),body:'ご確認ください。\n'+urlFor(token)+'\n'+extra
    });
    const counts = () => row('select (select count(*)::int from pa_email_deliveries) deliveries, (select count(*)::int from pa_schedule_responses) responses');
    const requestSchedule = async input => {
        const response = {
            statusCode:200, setHeader(){}, status(code){this.statusCode=code;return this;},
            json(payload){this.payload=payload;return this;}
        };
        const savedFetch=global.fetch;
        try {
            global.fetch=fetchImpl;
            await mailHandler({
                method:'POST',url:'/api/pa-mail',body:input,
                headers:{origin:'https://ara-tech.cc',host:'ara-tech.cc',authorization:'Bearer fixture-admin','x-forwarded-for':'192.0.2.31'}
            },response);
            return response;
        } finally { global.fetch=savedFetch; }
    };
    try {
        const fresh = await makeCase('new');
        await assert.rejects(()=>issue(fresh),/schedule form is not allowed/);
        const target=await makeCase('schedule_coordination');
        const other=await makeCase('schedule_coordination');
        const expiring=await makeCase('schedule_coordination');
        const expired=await issue(expiring,'1 microsecond');
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
        await assert.rejects(()=>retryDelivery({deliveryId:failed.id,inquiry:{...latestOther,email:'changed@example.invalid'},actorUserId:actor},fetchImpl),/retry_not_allowed/);
        await revoke(other);
        const beforeRetry=await counts();
        const revokedOther=await readInquiry(other);
        await assert.rejects(()=>retryDelivery({deliveryId:failed.id,inquiry:revokedOther,actorUserId:actor},fetchImpl),/schedule_token_not_available/);
        assert.deepEqual(await counts(),beforeRetry);
        assert.equal(state.sendCount,3);
        console.log('PASS isolated schedule lifecycle: hash-only, public fields, reissue/revoke, exact-case send and retry, single response and delivery dedupe; simulated Gmail 3, real sends 0');
    } finally {
        await db.close();
    }
})().catch(error=>{console.error(error);process.exitCode=1;});
