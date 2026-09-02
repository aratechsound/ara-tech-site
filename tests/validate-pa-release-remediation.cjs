const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const fixture = require('./helpers/pa-estimate-fixture.cjs');
const gmail = require('../api/_pa-gmail.cjs');
const security = require('../api/_request-security.cjs');
const root = path.resolve(__dirname, '..');
const client = fs.readFileSync(path.join(root, 'js/pa-admin.js'), 'utf8');
const routeCode = fs.readFileSync(path.join(root, 'api/pa-gmail.js'), 'utf8');
const { inquiryId, otherId, actorId, sentAt } = fixture;
const environment = {
    SUPABASE_URL: 'https://fixture.invalid', SUPABASE_SERVICE_ROLE_KEY: 'fixture-service-key',
    RATE_LIMIT_HASH_SECRET: 'fixture-only-secret', ALLOWED_ORIGINS: 'https://fixture.invalid'
};
Object.assign(process.env, environment);
global.fetch = async () => { throw Error('LIVE_NETWORK_FORBIDDEN'); };
let count = 0;
async function test(name, fn) { await fn(); count++; console.log(`PASS ${name}`); }
const extract = (name) => {
    const match = client.match(new RegExp(`^const ${name} = [\\s\\S]*?^};`, 'm'));
    assert(match, name);
    return match[0];
};
const response = () => ({
    headers: {}, setHeader(name, value) { this.headers[name] = value; }, getHeader(name) { return this.headers[name]; },
    status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; }
});
function makeRoute(db) {
    const stats = { rateCalls: 0, handlerCalls: 0, unavailable: false, buckets: [] };
    const rateFetch = async (url, options) => {
        assert.equal(new URL(url).pathname, '/rest/v1/rpc/consume_rate_limit');
        const input = JSON.parse(options.body);
        assert.equal(input.p_limit, 20);
        assert.equal(input.p_window_ms, 600000);
        stats.buckets.push(input.p_bucket_key);
        if (stats.unavailable) return { ok: false, status: 503 };
        stats.rateCalls++;
        return { ok: true, json: async () => ({ allowed: stats.rateCalls <= 20, remaining: Math.max(0, 20 - stats.rateCalls), retry_after_seconds: stats.rateCalls > 20 ? 600 : 0, limit: 20 }) };
    };
    const box = { module: { exports: {} }, Buffer, console: { error() {} }, require(name) {
        if (name === './_pa-mail.cjs') return { verifyAdmin: async (token) => { assert.equal(token, 'fixture-user-jwt'); return { id: actorId }; } };
        if (name === './_request-security.cjs') return { ...security, checkRateLimit: (args) => security.checkRateLimit({ ...args, environment, fetchImpl: rateFetch }) };
        if (name === './_pa-gmail.cjs') return { ...gmail, reconcileEstimateSubmission: async (args) => {
            stats.handlerCalls++;
            return gmail.reconcileEstimateSubmission(args, fixture.rpcFetch(db));
        } };
        throw Error('unexpected_import');
    } };
    vm.runInNewContext(routeCode, box);
    return { stats, async call(payload) {
        const res = response();
        await box.module.exports({ method: 'POST', headers: { authorization: 'Bearer fixture-user-jwt', origin: 'https://fixture.invalid' }, body: payload }, res);
        return res;
    } };
}
async function inputFor(db) {
    return { action: 'reconcile_estimate_submission', inquiry_id: inquiryId, gmail_message_id: 'direct_sent_001', gmail_thread_id: 'thread_123', expected: await fixture.expectedFor(db) };
}
async function rollback(db, fn) {
    await db.exec('begin');
    try { await fn(); } finally { await db.exec('rollback'); }
}

async function databaseTests() {
    const db = await fixture.createDatabase({ migrate: false });
    try {
        await test('B4 old RPC rejects rough_estimate even after PAM-003/PAM-004', async () => {
            await assert.rejects(db.query('select public.update_pa_case_progress($1,$2::jsonb)', [inquiryId, '{"estimate_sent_on":"2026-09-01"}']), /case is not ready/);
        });
        const beforeMigration = await fixture.state(db);
        await db.query("insert into public.pa_estimate_submission_reconciliations(inquiry_id,gmail_message_id,reconciled_by) values ($1,'other_case_message',$2)", [otherId, actorId]);
        const legacyBefore = (await fixture.state(db, otherId)).reconciliations[0];
        const acl = (await db.query("select proacl::text acl from pg_proc where oid='public.update_pa_case_progress(uuid,jsonb,text)'::regprocedure")).rows[0];
        await test('B4 replacement changes only readiness guard and preserves signature/ACL/data', async () => {
            const getFunction = (text) => text.replace(/\r\n/g, '\n').match(/create or replace function public\.update_pa_case_progress\([\s\S]*?\n\$\$;/)[0];
            assert.equal(getFunction(fixture.read(fixture.migrationName)), getFunction(fixture.read('2026-07-24-pa-case-progress.sql')).replace("if v_inquiry.status <> 'schedule_confirmed' then", "if v_inquiry.status not in ('rough_estimate', 'schedule_confirmed') then"));
            await db.exec(fixture.read(fixture.migrationName));
            assert.deepEqual(await fixture.state(db), beforeMigration);
            const legacyAfter = (await fixture.state(db, otherId)).reconciliations[0];
            assert.equal(legacyAfter.submitted_at, null);
            delete legacyAfter.submitted_at;
            assert.deepEqual(legacyAfter, legacyBefore, 'preexisting reconciliation data is preserved exactly');
            assert.deepEqual((await db.query("select proacl::text acl from pg_proc where oid='public.update_pa_case_progress(uuid,jsonb,text)'::regprocedure")).rows[0], acl);
        });
        await test('B4 migration replay is idempotent and admin RPC ACL is restricted', async () => {
            await db.exec(fixture.read(fixture.migrationName));
            assert.deepEqual(await fixture.state(db), beforeMigration);
            const access = (await db.query("select has_function_privilege('anon','public.reconcile_pa_estimate_submission(uuid,text,text,jsonb)','execute') anon, has_function_privilege('authenticated','public.reconcile_pa_estimate_submission(uuid,text,text,jsonb)','execute') admin_role")).rows[0];
            assert.deepEqual(access, { anon: false, admin_role: true });
        });
        await test('B4 both allowed statuses retain canonical progress validation', async () => {
            for (const id of [inquiryId, otherId]) {
                await rollback(db, async () => {
                    const result = (await db.query('select to_jsonb(public.update_pa_case_progress($1,$2::jsonb)) result', [id, '{"estimate_sent_on":"2026-09-01","estimate_adjusting":true}'])).rows[0].result;
                    assert.equal(result.current_step, 7);
                    assert.equal(result.estimate_sent_on, '2026-09-01');
                });
            }
            await rollback(db, async () => {
                await assert.rejects(db.query('select public.update_pa_case_progress($1,$2::jsonb)', [inquiryId, '{"not_a_field":true}']), /unsupported progress field/);
            });
        });
        await test('B4 unsupported and closed statuses retain the baseline rejection', async () => {
            for (const status of ['new_inquiry', 'on_hold', 'closed', 'schedule_unavailable']) {
                await rollback(db, async () => {
                    await db.query('update public.pa_inquiries set status=$2 where id=$1', [inquiryId, status]);
                    await assert.rejects(db.query('select public.update_pa_case_progress($1,$2::jsonb)', [inquiryId, '{"estimate_sent_on":"2026-09-01"}']), /case is not ready|closed case cannot/);
                });
            }
        });
        const payload = await inputFor(db);
        const otherBefore = await fixture.state(db, otherId);
        const route = makeRoute(db);
        await test('B1 real route + canonical limiter reaches atomic handler normally (200)', async () => {
            const res = await route.call(payload);
            assert.equal(res.statusCode, 200);
            assert.equal(res.body.result.already_reconciled, false);
            assert.equal(route.stats.handlerCalls, 1);
            assert.equal(res.body.result.progress.estimate_sent_on, '2026-09-01');
        });
        const committed = await fixture.state(db);
        await test('B1 exact limit allows request 20 and rejects request 21 as 429', async () => {
            for (let i = 2; i <= 20; i++) assert.equal((await route.call(payload)).statusCode, 200);
            const denied = await route.call(payload);
            assert.equal(denied.statusCode, 429);
            assert.equal(denied.body.code, 'rate_limited');
            assert.equal(denied.headers['Retry-After'], '600');
            assert.equal(route.stats.handlerCalls, 20);
            assert.equal(new Set(route.stats.buckets).size, 1);
            assert.match(route.stats.buckets[0], /^pa-api:v1:pa-gmail-reconcile-estimate:[a-f0-9]{64}$/);
            assert(!route.stats.buckets[0].includes(actorId));
        });
        await test('B1 limiter outage remains 503 and never masquerades as 429', async () => {
            route.stats.unavailable = true;
            const res = await route.call(payload);
            assert.equal(res.statusCode, 503);
            assert.equal(res.body.code, 'service_unavailable');
            assert.equal(route.stats.handlerCalls, 20);
            assert.deepEqual(await fixture.state(db), committed);
        });
        await test('B3 repeated/queued replays preserve entire date/progress/audit state', async () => {
            const replies = await Promise.all(Array.from({ length: 6 }, () => fixture.invoke(db, { expected: payload.expected })));
            assert(replies.every((r) => r.already_reconciled));
            assert.deepEqual(await fixture.state(db), committed);
            assert.equal(committed.reconciliations.length, 1);
            assert.equal(committed.audit.filter((a) => a.action === 'case_progress_updated').length, 1);
            assert.equal(committed.audit.filter((a) => a.action === 'gmail_direct_estimate_submission_reconciled').length, 1);
            assert.deepEqual(await fixture.state(db, otherId), otherBefore);
        });
        await test('B3 replay never reopens an approved/later stage', async () => {
            await db.query('select public.update_pa_case_progress($1,$2::jsonb)', [inquiryId, '{"estimate_adjusting":false,"estimate_approved_on":"2026-09-02"}']);
            const later = await fixture.state(db);
            assert.equal(later.progress.current_step, 9);
            await fixture.invoke(db, { expected: payload.expected });
            assert.deepEqual(await fixture.state(db), later);
        });
        await test('B2 case/message/thread crossover is rejected without any write', async () => {
            const before = await fixture.state(db);
            for (const input of [
                { inquiry: otherId, message: 'direct_sent_001', thread: 'thread_123', expected: payload.expected },
                { message: 'other_case_message', expected: payload.expected },
                { thread: 'thread_other', expected: payload.expected },
                { message: 'missing_message', expected: payload.expected }
            ]) await assert.rejects(fixture.invoke(db, input), /not linked|not indexed/);
            assert.deepEqual(await fixture.state(db), before);
            assert.deepEqual(await fixture.state(db, otherId), otherBefore);
        });
        await test('B2 missing/deleted/changed targets fail closed', async () => {
            for (const sql of [
                "update public.pa_inquiries set deleted_at=now() where id=$1",
                "update public.pa_gmail_message_index set message_source='gmail_received' where inquiry_id=$1",
                "update public.pa_gmail_message_index set sent_at=sent_at+interval '1 day' where inquiry_id=$1",
                "delete from public.pa_case_progress where inquiry_id=$1",
                "delete from public.pa_gmail_thread_links where inquiry_id=$1"
            ]) await rollback(db, async () => {
                await db.query(sql, [inquiryId]);
                await assert.rejects(fixture.invoke(db, { expected: payload.expected }), /not found|not indexed|not linked|target changed/);
            });
        });
        await test('B2 unauthenticated/non-admin calls cannot mutate via SECURITY DEFINER', async () => {
            for (const claims of ['{}', '{"sub":"323e4567-e89b-42d3-a456-426614174000"}']) {
                await rollback(db, async () => {
                    await db.query("select set_config('request.jwt.claims',$1,true)", [claims]);
                    await assert.rejects(fixture.invoke(db, { expected: payload.expected }), /not authorized/);
                });
            }
        });
        await test('B4 unknown RPC body aborts migration before any row/schema rewrite', async () => {
            const canonical = fixture.read(fixture.migrationName).match(/create or replace function public\.update_pa_case_progress\([\s\S]*?\n\$\$;/)[0];
            await db.exec(canonical.replace('declare', 'declare\n  -- synthetic unreviewed DDL drift'));
            const before = await fixture.state(db);
            await assert.rejects(db.exec(fixture.read(fixture.migrationName)), /unexpected update_pa_case_progress DDL/);
            await db.exec('rollback');
            assert.deepEqual(await fixture.state(db), before);
            const body = (await db.query("select prosrc from pg_proc where oid='public.update_pa_case_progress(uuid,jsonb,text)'::regprocedure")).rows[0].prosrc;
            assert.match(body, /synthetic unreviewed DDL drift/, 'unknown DDL was not overwritten');
            await db.exec(canonical);
        });
        await test('B4 migration refuses missing PAM-003 projection prerequisite', async () => {
            await db.exec(fixture.read('20260902103000_pam001_workflow_projection.sql'));
            const before = await fixture.state(db);
            await assert.rejects(db.exec(fixture.read(fixture.migrationName)), /requires PAM-003, PAM-004/);
            await db.exec('rollback');
            assert.deepEqual(await fixture.state(db), before);
            await db.exec(fixture.read('20260902170000_pam003_estimate_submission_projection.sql'));
        });
    } finally { await db.close(); }

    const fresh = await fixture.createDatabase();
    try {
        const expected = await fixture.expectedFor(fresh);
        await test('B2 optimistic case/progress/creation snapshots reject stale first requests', async () => {
            for (const patch of [
                { case_updated_at: '2000-01-01T00:00:00Z' }, { progress_updated_at: '2000-01-01T00:00:00Z' },
                { estimate_created_on: '2000-01-01' }, { status: 'schedule_confirmed' }, { sent_at: null }
            ]) {
                const before = await fixture.state(fresh);
                await assert.rejects(fixture.invoke(fresh, { expected: { ...expected, ...patch } }), /target changed/);
                assert.deepEqual(await fixture.state(fresh), before);
            }
        });
        await test('B3 failure after progress update rolls back reconciliation, dates and both audits', async () => {
            await fresh.exec(`create function public.fixture_fail_audit() returns trigger language plpgsql as $$ begin
                if new.action='gmail_direct_estimate_submission_reconciled' then raise exception 'fixture audit failure'; end if; return new; end; $$;
                create trigger fixture_fail_audit before insert on public.pa_inquiry_audit for each row execute function public.fixture_fail_audit();`);
            const before = await fixture.state(fresh);
            await assert.rejects(fixture.invoke(fresh, { expected }), /fixture audit failure/);
            assert.deepEqual(await fixture.state(fresh), before);
            await fresh.exec('drop trigger fixture_fail_audit on public.pa_inquiry_audit; drop function public.fixture_fail_audit();');
        });
        await test('B3 legacy record without atomic marker is preserved and requires review', async () => {
            await rollback(fresh, async () => {
                await fresh.query("insert into public.pa_estimate_submission_reconciliations(inquiry_id,gmail_message_id) values ($1,'direct_sent_001')", [inquiryId]);
                await assert.rejects(fixture.invoke(fresh, { expected }), /legacy reconciliation requires review/);
            });
        });
        await test('B3 simultaneous first attempts produce one immutable record and one stage audit', async () => {
            const responses = await Promise.all(Array.from({ length: 4 }, () => fixture.invoke(fresh, { expected })));
            assert.equal(responses.filter((r) => !r.already_reconciled).length, 1);
            const after = await fixture.state(fresh);
            assert.equal(after.reconciliations.length, 1);
            assert.equal(after.audit.length, 2);
        });
        await test('B3 a different canonical message appends its own submission history', async () => {
            await fresh.query(`insert into public.pa_gmail_message_index(gmail_message_id,gmail_thread_id,inquiry_id,direction,from_address,message_source,sent_at)
                values ('direct_sent_002','thread_123',$1,'outbound','sender@example.invalid','gmail_direct','2026-09-02T12:00:00Z')`, [inquiryId]);
            const before = await fixture.state(fresh);
            await fixture.invoke(fresh, { message: 'direct_sent_002' });
            const after = await fixture.state(fresh);
            assert.deepEqual(after.reconciliations[0], before.reconciliations[0]);
            assert.equal(after.reconciliations.length, 2);
            assert.equal(after.audit.length, 4);
            assert.equal(after.progress.estimate_sent_on, '2026-09-02');
            await fixture.invoke(fresh, { expected });
            assert.deepEqual(await fixture.state(fresh), after, 'replaying an older message cannot overwrite a newer submission');
        });
    } finally { await fresh.close(); }
}

async function uiTests() {
    const db = await fixture.createDatabase();
    try {
        const stateA = await fixture.state(db);
        const stateB = await fixture.state(db, otherId);
        const message = { id: 'direct_sent_001', thread_id: 'thread_123', occurred_at: sentAt };
        let release;
        const pending = new Promise((resolve) => { release = resolve; });
        const requests = [], refreshes = [], renders = [];
        const ui = {
            currentCase: structuredClone(stateA.case), currentProgress: structuredClone(stateA.progress),
            window: { confirm: () => true }, gmailSyncState: {},
            gmailErrorMessage: (code) => code, setMessage: () => renders.push('error'),
            renderOverview: () => renders.push('overview'), populateProgressManagement: () => renders.push('form'),
            supabase: { rpc: () => { throw Error('CLIENT_PROGRESS_WRITE_FORBIDDEN'); } },
            syncGmail: async (args) => { refreshes.push(args); },
            callGmailApi: async (args) => {
                assert(Object.isFrozen(args.expected));
                requests.push(structuredClone(args));
                await pending;
                return { result: await gmail.reconcileEstimateSubmission({
                    inquiryId: args.inquiry_id, gmailMessageId: args.gmail_message_id, gmailThreadId: args.gmail_thread_id,
                    expected: args.expected, accessToken: 'fixture-user-jwt'
                }, fixture.rpcFetch(db)) };
            }
        };
        vm.createContext(ui);
        vm.runInContext(`${extract('reconcileDirectEstimateSubmission')}\nthis.run = reconcileDirectEstimateSubmission;`, ui);
        await test('B2 A starts -> B selected -> A succeeds: B fully unchanged, cross-case writes=0', async () => {
            const button = { disabled: false, textContent: 'record' };
            const run = ui.run(message, button);
            ui.currentCase = structuredClone(stateB.case);
            ui.currentProgress = structuredClone(stateB.progress);
            message.id = 'other_case_message';
            message.thread_id = 'thread_other';
            const viewBefore = structuredClone({ item: ui.currentCase, progress: ui.currentProgress });
            release();
            await run;
            assert.equal(requests[0].inquiry_id, inquiryId);
            assert.equal(requests[0].gmail_message_id, 'direct_sent_001');
            assert.equal(requests[0].gmail_thread_id, 'thread_123');
            assert.equal((await fixture.state(db)).progress.estimate_sent_on, '2026-09-01');
            assert.deepEqual(await fixture.state(db, otherId), stateB);
            assert.deepEqual({ item: ui.currentCase, progress: ui.currentProgress }, viewBefore);
            assert.equal(refreshes.length, 0);
            assert.equal(renders.length, 0);
        });
        await test('B3 UI same-day / next-day / repeated reconciliation leaves first date and history immutable', async () => {
            const before = await fixture.state(db);
            ui.currentCase = structuredClone(stateA.case);
            ui.currentProgress = structuredClone(before.progress);
            for (const day of ['2026-09-01T15:00:00Z', '2026-09-02T15:00:00Z', '2026-09-03T15:00:00Z', '2026-10-01T15:00:00Z']) {
                ui.Date = class extends Date { constructor(...args) { super(...(args.length ? args : [day])); } };
                await ui.run({ id: 'direct_sent_001', thread_id: 'thread_123', occurred_at: sentAt }, {});
                assert.deepEqual(await fixture.state(db), before, day);
                assert.deepEqual(await fixture.state(db, otherId), stateB);
            }
            assert(refreshes.every((r) => r.inquiryId === inquiryId));
        });
        await test('B2 mismatched API response cannot update or refresh selected case', async () => {
            const before = ui.currentProgress;
            const refreshCount = refreshes.length;
            ui.callGmailApi = async () => ({ result: { inquiry_id: otherId, gmail_message_id: 'direct_sent_001', gmail_thread_id: 'thread_123', progress: stateB.progress } });
            await ui.run({ id: 'direct_sent_001', thread_id: 'thread_123', occurred_at: sentAt }, {});
            assert.equal(ui.currentProgress, before);
            assert.equal(refreshes.length, refreshCount);
        });
        for (const failure of [false, true]) {
            await test(`B2 refresh A pending -> B selected: ${failure ? 'failure' : 'success'} cannot modify B view`, async () => {
                let done;
                const button = { disabled: false };
                const sync = {
                    currentCase: structuredClone(stateA.case), currentGmailTimeline: ['A'], currentMailAttention: 'A',
                    gmailSyncState: {}, $: () => button, applyGmailSyncResult: () => { throw Error('CROSS_CASE_RENDER'); },
                    setMessage: () => { throw Error('CROSS_CASE_ERROR'); },
                    callGmailApi: (args) => { assert.equal(args.inquiry_id, inquiryId); return new Promise((resolve, reject) => { done = () => failure ? reject(Error('fixture')) : resolve({ result: {} }); }); }
                };
                vm.createContext(sync);
                vm.runInContext(`${extract('syncGmail')}\nthis.run = syncGmail;`, sync);
                const run = sync.run({ inquiryId });
                sync.currentCase = structuredClone(stateB.case);
                sync.currentGmailTimeline = ['B'];
                sync.currentMailAttention = 'B';
                sync.gmailSyncState = { textContent: 'B' };
                done(); await run;
                assert.deepEqual(sync.currentGmailTimeline, ['B']);
                assert.equal(sync.currentMailAttention, 'B');
                assert.equal(sync.gmailSyncState.textContent, 'B');
            });
        }
        await test('B5 canonical PAM-001 labels and estimate projection behavior both survive', async () => {
            const labels = client.match(/const workflowSteps = (\[[\s\S]*?\]);/)[1];
            const parsed = vm.runInNewContext(labels);
            assert.deepEqual(Array.from(parsed).slice(5, 8), ['正式見積', '発注確認', '予約確定']);
            const box = { progressForCase: (item) => item.progress, isCompletedStatus: () => false, initialWorkflowStep: () => 3 };
            vm.createContext(box);
            vm.runInContext(`${extract('workflowStepForCase')}\nthis.run = workflowStepForCase;`, box);
            assert.equal(box.run({ status: 'rough_estimate', progress: {} }), 3);
            assert.equal(box.run({ status: 'rough_estimate', progress: { estimate_created_on: '2026-09-01' } }), 7);
            assert.equal(box.run({ status: 'rough_estimate', progress: { estimate_created_on: '2026-09-01', estimate_sent_on: '2026-09-01', estimate_adjusting: true } }), 7);
            assert.equal(box.run({ status: 'rough_estimate', progress: { estimate_created_on: '2026-09-01', estimate_sent_on: '2026-09-01', estimate_adjusting: false } }), 8);
        });
    } finally { await db.close(); }
}

async function regressionTests() {
    await test('attachment / message / case crossover rejects before Gmail provider calls', async () => {
        let providerCalls = 0;
        const fetchFixture = async (target) => {
            const url = new URL(target);
            if (url.pathname === '/rest/v1/pa_gmail_message_index') {
                const rows = url.searchParams.get('inquiry_id') === `eq.${inquiryId}` && url.searchParams.get('gmail_message_id') === 'eq.message_A'
                    ? [{ gmail_message_id: 'message_A', attachment_metadata: [{ id: 'attachment_A', filename: 'a.pdf' }] }] : [];
                return { ok: true, status: 200, json: async () => rows };
            }
            providerCalls++; throw Error('unexpected_provider_request');
        };
        for (const args of [
            { inquiryId, gmailMessageId: 'message_A', gmailAttachmentId: 'attachment_B' },
            { inquiryId, gmailMessageId: 'message_B', gmailAttachmentId: 'attachment_A' },
            { inquiryId: otherId, gmailMessageId: 'message_A', gmailAttachmentId: 'attachment_A' }
        ]) await assert.rejects(gmail.getAttachment(args, fetchFixture), /gmail_attachment_not_indexed/);
        assert.equal(providerCalls, 0);
    });
    await test('failed Gmail estimate send preserves stage, draft and attachments', async () => {
        const elements = new Map();
        const $ = (key) => {
            if (!elements.has(key)) elements.set(key, { value: key === '#gmail-reply-body' ? 'estimate body' : '', disabled: false });
            return elements.get(key);
        };
        let progressWrites = 0;
        const ui = {
            $, currentCase: { id: inquiryId }, gmailReplyPreview: { recipient: 'customer@example.invalid', confirmation_token: 'fixture' },
            gmailReplyAttachments: ['fixture.pdf'], gmailReplyMode: 'estimate_submission',
            window: { confirm: () => true }, gmailReplyAttachmentPayload: async () => ['fixture.pdf'], isEstimateSubmissionMode: () => true,
            callGmailApi: async () => { throw Error('gmail_send_503'); },
            recordEstimateSubmissionProgress: async () => { progressWrites++; },
            gmailErrorMessage: (message) => message, setMessage() {}
        };
        vm.createContext(ui);
        vm.runInContext(`${extract('sendGmailReply')}\nthis.run = sendGmailReply;`, ui);
        await ui.run();
        assert.equal(progressWrites, 0);
        assert.equal(ui.gmailReplyPreview.confirmation_token, 'fixture');
        assert.deepEqual(ui.gmailReplyAttachments, ['fixture.pdf']);
        assert.equal($('#gmail-reply-body').value, 'estimate body');
    });
}

(async () => {
    await databaseTests();
    await uiTests();
    await regressionTests();
    console.log(`PA release remediation: ${count}/${count} PASS; live network disabled; SQL is local PGlite only`);
})().catch((error) => { console.error(error.stack); process.exitCode = 1; });
