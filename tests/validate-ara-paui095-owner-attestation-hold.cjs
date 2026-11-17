'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createFixture, actor } = require('./helpers/ara-case-fixture.cjs');

const read = file => fs.readFileSync(path.join(__dirname, file), 'utf8');
// PAUI-086's hosted definition includes guards absent from the historical migration.
const preimage = read('fixtures/paui095-pa-progress-hosted-preimage.sql').replaceAll('\r\n', '\n');
const candidate = read('../supabase/operations/paui095-owner-attestation-hold.sql');
const rollback = read('../supabase/operations/paui095-owner-attestation-hold-rollback.sql');
const target = "'public.update_pa_case_progress(uuid,jsonb,text)'::regprocedure";
const digest = text => crypto.createHash('sha256').update(text).digest('hex');
const holdBy = ['progress', 'status'];

(async () => {
    const fixture = await createFixture();
    const db = fixture.db;
    const meta = async () => (await db.query(
        'select pg_get_functiondef(oid) as ddl,prosrc as body,proacl::text as acl from pg_proc where oid=' + target
    )).rows[0];
    const save = async id => {
        await db.exec('set role authenticated');
        try {
            return await db.query("select update_pa_case_progress($1,'{\"close_reason\":\"payment_received\"}',null)", [id]);
        } finally {
            await db.exec('reset role');
        }
    };
    const createCase = async (hold, ordered = true) => {
        const { rows: [row] } = await db.query(
            "insert into pa_inquiries(customer_name,email,event_name,case_type,status) values('Synthetic','fixture@example.invalid','Synthetic event','PA_EVENT',$1) returning id",
            [hold === 'status' ? 'on_hold' : 'waiting_customer_reply']
        );
        await db.query(
            "update pa_case_progress set is_on_hold=$1,booking_confirmed_on=case when $2 then date '2026-10-01' end where inquiry_id=$3",
            [hold === 'progress', ordered, row.id]
        );
        return row.id;
    };
    const state = async id => (await db.query(
        "select i.status,p.is_on_hold,p.closed_at,(select count(*)::int from pa_inquiry_audit where inquiry_id=$1 and action='owner_payment_completion_confirmed') as attestations,(select count(*)::int from pa_payment_records where inquiry_id=$1) as payments from pa_inquiries i join pa_case_progress p on p.inquiry_id=i.id where i.id=$1",
        [id]
    )).rows[0];
    const assertTransactionRejected = async (sql, message) => {
        await assert.rejects(() => db.exec(sql), message);
        await db.exec('rollback');
    };
    try {
        await db.exec(preimage);
        await db.exec('revoke all on function public.update_pa_case_progress(uuid,jsonb,text) from public,anon; grant execute on function public.update_pa_case_progress(uuid,jsonb,text) to authenticated,service_role;');
        const before = await meta();
        assert.equal(digest(before.ddl), '0fe6fc8aef99710def93077b6ad7352084a06268aed24887b9e41fe762a71d7b');
        await assertTransactionRejected(rollback, /rollback baseline mismatch/);
        for (const mode of holdBy) {
            const id = await createCase(mode);
            await save(id);
            assert.equal((await state(id)).status, 'closed');
            assert.equal((await state(id)).is_on_hold, false);
        }
        await db.exec(candidate);
        const after = await meta();
        assert.equal(after.acl, before.acl);
        assert.equal(after.body.replace(/    if v_inquiry.status = 'on_hold' or v_before\.is_on_hold then\n      raise exception 'held case cannot be completed';\n    end if;\n/, ''), before.body);
        for (const mode of holdBy) {
            const id = await createCase(mode);
            const saved = await state(id);
            await assert.rejects(() => save(id), /held case cannot be completed/);
            assert.deepEqual(await state(id), saved);
        }
        const open = await createCase(null);
        await save(open);
        const closed = await state(open);
        assert.equal(closed.status, 'closed');
        assert.equal(closed.attestations, 1);
        assert.equal(closed.payments, 0);
        await save(open);
        assert.deepEqual(await state(open), closed);
        const unbooked = await createCase(null, false);
        await assert.rejects(() => save(unbooked), /use commercial payment completion/);
        const earlierUnknown = await createCase(null);
        await db.query(
            "insert into pa_commercial_outbox(id,inquiry_id,operation_id,job_kind,aggregate_id,state,recipient,subject,body_text,reply_binding) values(gen_random_uuid(),$1,gen_random_uuid(),'confirmation',gen_random_uuid(),'unknown','fixture@example.invalid','Synthetic','Synthetic body','{}')",
            [earlierUnknown]
        );
        await save(earlierUnknown);
        assert.equal((await state(earlierUnknown)).status, 'closed');
        assert.equal((await db.query('select state from pa_commercial_outbox where inquiry_id=$1', [earlierUnknown])).rows[0].state, 'unknown');
        const unauthorized = await createCase(null);
        await db.query("select set_config('request.jwt.claim.sub', $1, false)", [crypto.randomUUID()]);
        await assert.rejects(() => save(unauthorized), /not authorized/);
        assert.equal((await state(unauthorized)).attestations, 0);
        await db.query("select set_config('request.jwt.claim.sub', $1, false)", [actor]);
        await assertTransactionRejected(candidate, /baseline mismatch/);
        assert.equal((await meta()).ddl, after.ddl);
        await db.exec(rollback);
        assert.deepEqual(await meta(), before);
        assert.deepEqual(await state(open), closed);
        assert.equal(fixture.state.sendCount, 0);
        console.log(JSON.stringify({
            baseline: digest(before.ddl), candidate: digest(after.ddl), acl_unchanged: true,
            held_modes_preserved: holdBy, ordinary_and_idempotent: true, unbooked_denied: true,
            earlier_unknown_preserved: true, non_admin_denied: true, stale_apply_and_rollback_denied: true,
            exact_rollback: true, real_mail: 0, production_mutations: 0
        }));
    } finally {
        await db.close();
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
