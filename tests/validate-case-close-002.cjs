const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { pathToFileURL } = require("node:url");
const { PGlite } = require("@electric-sql/pglite");
const root = path.resolve(__dirname, "..");
const read = name => fs.readFileSync(path.join(root, name), "utf8");

(async () => {
    const ui = await import(pathToFileURL(path.join(root, "js/pa-owner-paid-completion.mjs")));
    assert.equal(ui.caseEditorStatus({ status: "closed" }, { close_reason: "other_closed" }), "closed");
    assert.equal(ui.caseEditorStatus({ status: "closed" }, { close_reason: "payment_received" }), ui.ownerPaidCompletionStatus);
    assert.equal(ui.caseEditorStatus({ status: "schedule_confirmed" }, {}), "schedule_confirmed");
    let request;
    await ui.recordOwnerPaidCompletion({ rpc: async (...args) => { request = args; return { data: {} }; } }, "fixture-id");
    assert.equal(request[0], "update_pa_case_progress");
    assert.deepEqual(request[1].p_progress, { close_reason: "payment_received" });
    assert.doesNotMatch(JSON.stringify(request[1]), /payment_date|payment_method|amount/);

    const admin = read("js/pa-admin.js");
    const saveSource = admin.slice(admin.indexOf("const saveCase = async () => {"), admin.indexOf("const randomToken ="));
    let paidSaves = 0;
    const context = vm.createContext({
        $: () => ({ value: ui.ownerPaidCompletionStatus }),
        ownerPaidCompletionStatus: ui.ownerPaidCompletionStatus,
        saveOwnerPaidCompletion: async () => { paidSaves++; }
    });
    await vm.runInContext(saveSource + "\nsaveCase();", context);
    assert.equal(paidSaves, 1); // Ordinary inquiry PATCH/payload validation is not entered.
    const html = read("pa-admin.html");
    assert.match(html.match(/<select id="case-status"[\s\S]*?<\/select>/)[0], /value="owner_payment_completed"[^>]*>入金確認済みで完了/);
    assert.equal((html.match(/id="owner-paid-completion-option"/g) || []).length, 1);
    assert.doesNotMatch(html.match(/<select id="case-status-filter"[\s\S]*?<\/select>/)[0], /owner_payment_completed/);
    const paidSaveSource = admin.slice(admin.indexOf("const saveOwnerPaidCompletion = async () => {"), admin.indexOf("const saveCase = async () => {"));
    const runSave = async (confirmed, error = null) => {
        let rpcCalls = 0, navigations = 0;
        const button = { disabled: false };
        const messages = [];
        const scope = vm.createContext({
            currentCase: { id: "isolated-id", status: "schedule_confirmed" }, caseSelectionSerial: 1,
            isPaCase: () => true, clearMessage: () => {}, caseStatusMessage: {},
            $: () => button, window: { confirm: () => confirmed }, supabase: {},
            recordOwnerPaidCompletion: async () => { rpcCalls++; return { error, data: {} }; },
            setMessage: (...args) => messages.push(args), eventYearForCase: () => 2026,
            loadCases: async () => { navigations++; }, openCase: async () => { navigations++; }
        });
        await vm.runInContext(paidSaveSource + "\nsaveOwnerPaidCompletion();", scope);
        assert.equal(button.disabled, false);
        return { rpcCalls, navigations, messages };
    };
    assert.deepEqual(await runSave(false), { rpcCalls: 0, navigations: 0, messages: [] });
    const failedSave = await runSave(true, { message: "unsupported progress field" });
    assert.equal(failedSave.rpcCalls, 1);
    assert.equal(failedSave.navigations, 0);
    assert.equal(failedSave.messages[0][2], "error");
    const successfulSave = await runSave(true);
    assert.equal(successfulSave.rpcCalls, 1);
    assert.equal(successfulSave.navigations, 2);

    const db = new PGlite();
    try {
        await db.exec(`
            create role anon; create role authenticated;
            create schema auth;
            create table auth.users(id uuid primary key);
            create function auth.uid() returns uuid language sql stable as $$
                select nullif(current_setting('test.actor',true),'')::uuid $$;
            create function auth.jwt() returns jsonb language sql stable as $$
                select '{"email":"isolated-admin@example.invalid"}'::jsonb $$;
            create function public.is_work_admin() returns boolean language sql stable as $$
                select coalesce(current_setting('test.admin',true),'false')='true' $$;
            create function public.initial_pa_workflow_step(text) returns smallint language sql immutable as $$
                select (case when $1='closed' then 14 when $1='schedule_confirmed' then 6 else 1 end)::smallint $$;
            create table public.pa_inquiries(
                id uuid primary key, status text not null, case_type text, deleted_at timestamptz,
                schedule_state text, event_date date, created_at timestamptz default now(), updated_at timestamptz default now()
            );
            create table public.pa_inquiry_audit(
                id uuid primary key default gen_random_uuid(), inquiry_id uuid,
                actor_user_id uuid, action text, details jsonb, created_at timestamptz default now()
            );
            insert into auth.users values ('00000000-0000-0000-0000-000000000001');
            select set_config('test.actor','00000000-0000-0000-0000-000000000001',false);
            select set_config('test.admin','true',false);
        `);
        const base = read("supabase/migrations/2026-07-24-pa-case-progress.sql");
        const forward = read("supabase/migrations/20261007040000_case_close_002_owner_payment_completion.sql");
        const oldRpc = base.slice(base.indexOf("create or replace function public.update_pa_case_progress("), base.indexOf("create or replace function public.confirm_pa_payment_and_close("));
        assert.equal(forward.slice(forward.indexOf("  select key"), forward.lastIndexOf("commit;")).trim(), oldRpc.slice(oldRpc.indexOf("  select key")).trim());
        await db.exec(base);
        const fixture = n => `10000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
        const insert = async (n, status = "schedule_confirmed", type = "PA_EVENT", trashed = false) => {
            await db.query("insert into pa_inquiries(id,status,case_type,deleted_at) values($1,$2,$3,case when $4 then now() end)", [fixture(n), status, type, trashed]);
        };
        for (let n = 1; n <= 6; n++) await insert(n);
        await insert(7, "closed");
        await insert(8, "cancelled");
        await insert(9, "schedule_confirmed", "OTHER");
        await insert(10, "schedule_confirmed", "PA_EVENT", true);
        const beforeRows = (await db.query("select * from pa_case_progress order by inquiry_id")).rows;
        await db.exec(forward);
        assert.deepEqual((await db.query("select * from pa_case_progress order by inquiry_id")).rows, beforeRows);
        const complete = id => db.query("select (update_pa_case_progress($1::uuid,$2::jsonb,$3)).*", [id, JSON.stringify({ close_reason: "payment_received" }), "Owner confirmed completed payment; no accounting metadata"]);
        await db.exec("set role authenticated");
        await complete(fixture(1)); // Actual privileged RPC execution as the granted role.
        await db.exec("reset role");
        let result = (await db.query("select i.status,p.* from pa_inquiries i join pa_case_progress p on p.inquiry_id=i.id where i.id=$1", [fixture(1)])).rows[0];
        assert.equal(result.status, "closed");
        assert.equal(result.close_reason, "payment_received");
        assert.equal(result.current_step, 14);
        assert.equal(result.closed_from_step, 6);
        assert.ok(result.closed_at);
        assert.equal(result.invoice_amount, null);
        assert.equal(result.estimate_created_on, null);
        assert.equal((await db.query("select count(*)::int n from pa_payment_records")).rows[0].n, 0);
        const audit = (await db.query("select * from pa_inquiry_audit where action='owner_payment_completion_confirmed' and inquiry_id=$1", [fixture(1)])).rows;
        assert.equal(audit.length, 1);
        assert.equal(audit[0].actor_user_id, "00000000-0000-0000-0000-000000000001");
        assert.equal(audit[0].details.confirmation_source, "owner_attestation");
        assert.equal(audit[0].details.payment_metadata_recorded, false);
        await complete(fixture(1));
        assert.equal((await db.query("select count(*)::int n from pa_inquiry_audit where action='owner_payment_completion_confirmed'")).rows[0].n, 1);
        await db.exec("select set_config('test.admin','false',false)");
        await assert.rejects(complete(fixture(2)), /not authorized/);
        await db.exec("select set_config('test.admin','true',false)");
        await assert.rejects(db.query("select update_pa_case_progress($1::uuid,$2::jsonb,null)", [fixture(3), '{"close_reason":"payment_received","invoice_amount":0}']), /invalid completion attestation/);
        for (const n of [7, 8]) await assert.rejects(complete(fixture(n)), /closed case cannot be reclassified/);
        for (const n of [9, 10]) await assert.rejects(complete(fixture(n)), /PA case unavailable/);
        await assert.rejects(db.query("select update_pa_case_progress($1::uuid,$2::jsonb,null)", [fixture(4), '{"unsupported":true}']), /unsupported progress field/);
        await db.query("select update_pa_case_progress($1::uuid,$2::jsonb,null)", [fixture(5), '{"estimate_created_on":"2026-01-01"}']);
        assert.equal((await db.query("select current_step from pa_case_progress where inquiry_id=$1", [fixture(5)])).rows[0].current_step, 7);
        await assert.rejects(db.query("select confirm_pa_payment_and_close($1::uuid,current_date,1,'cash',null,false)", [fixture(6)]), /case is not ready/);
        assert.equal((await db.query("select close_reason from pa_case_progress where inquiry_id=$1", [fixture(7)])).rows[0].close_reason, "other_closed");
        // A failure during audit insertion must roll back both closure writes.
        await db.exec(`create function fail_close_audit() returns trigger language plpgsql as $$ begin
            if new.action='owner_payment_completion_confirmed' then raise exception 'fixture audit failure'; end if;
            return new; end $$;
            create trigger fixture_fail_audit before insert on pa_inquiry_audit for each row execute function fail_close_audit();`);
        await assert.rejects(complete(fixture(6)), /fixture audit failure/);
        assert.equal((await db.query("select status from pa_inquiries where id=$1", [fixture(6)])).rows[0].status, "schedule_confirmed");
        assert.equal((await db.query("select close_reason from pa_case_progress where inquiry_id=$1", [fixture(6)])).rows[0].close_reason, null);
        console.log("PASS CASE-CLOSE-002: UI dispatch, real isolated SQL/RPC, no invented payment records, persistent audit, idempotence, authorization, rollback, existing progress/payment guards unchanged.");
    } finally {
        await db.close();
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
