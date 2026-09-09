const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");
const stagePlots = require("../api/_pa-stage-plots.cjs");
const portalHandler = require("../api/pa-portal.js");

const root = path.join(__dirname, "..");
const migrationPath = path.join(root, "supabase", "migrations", "20260909123000_pa_stage_plot_persistence.sql");
const migration = fs.readFileSync(migrationPath, "utf8");
const portalApi = fs.readFileSync(path.join(root, "api", "pa-portal.js"), "utf8");
const actor = "10000000-0000-4000-8000-000000000001";
const outsider = "10000000-0000-4000-8000-000000000002";
const caseA = "20000000-0000-4000-8000-000000000001";
const caseB = "20000000-0000-4000-8000-000000000002";

const state = (performerName, marker, durationMinutes = 35) => ({
    schemaVersion: 1,
    metadata: { performerName, performanceOrder: "3番目", performanceTime: "14:15〜14:50", durationMinutes },
    objects: [{ id: marker, type: "performer", x: 600, y: 420, rotation: 0, scale: 1 }],
    notes: marker
});

const rpc = async (db, name, args) => {
    const placeholders = args.map((_, index) => `$${index + 1}`).join(",");
    return (await db.query(`select public.${name}(${placeholders}) result`, args)).rows[0].result;
};

const expectReject = async (promise, expression) => assert.rejects(promise, expression);

async function main() {
    assert.match(migration, /create table if not exists public\.pa_stage_plots/u);
    assert.match(migration, /create table if not exists public\.pa_stage_plot_revisions/u);
    assert.match(migration, /case_id uuid not null references public\.pa_inquiries\(id\) on delete restrict/u);
    assert.match(migration, /state jsonb not null/u);
    assert.match(migration, /unique \(stage_plot_id, revision_no\)/u);
    assert.match(migration, /security definer/gu);
    assert.match(migration, /public\.is_work_admin\(\)/u);
    assert.match(migration, /stage_plot_case_mismatch/u);
    assert.doesNotMatch(migration, /pa_portal_document_versions|pa_portal_document_cards/u);
    for (const action of ["create", "get", "list", "save", "revision_list", "revision_get"]) {
        assert.match(portalApi, new RegExp(`stage_plot_${action}`, "u"));
    }
    assert.match(portalApi, /verifyAdmin\(token\)/u);
    const functionFiles = fs.readdirSync(path.join(root, "api")).filter((name) => name.endsWith(".js"));
    assert.equal(functionFiles.length, 12, "Phase 1A must not add a Vercel Function");
    const unauthenticatedResponse = {
        headers: {}, statusCode: null,
        setHeader(name, value) { this.headers[name] = value; },
        status(code) { this.statusCode = code; return this; },
        json(value) { this.body = value; return value; }
    };
    await portalHandler({ query: {}, method: "POST", headers: {}, body: { action: "stage_plot_list", inquiry_id: caseA } }, unauthenticatedResponse);
    assert.equal(unauthenticatedResponse.statusCode, 401);
    assert.equal(unauthenticatedResponse.body.code, "not_authorized");

    const db = new PGlite();
    try {
        await db.exec(`
          create role anon;
          create role authenticated;
          create schema auth;
          create table auth.users(id uuid primary key);
          create function auth.uid() returns uuid language sql stable
            as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
          create table public.work_admins(user_id uuid primary key references auth.users(id));
          create function public.is_work_admin() returns boolean language sql stable security definer set search_path=''
            as $$select exists(select 1 from public.work_admins where user_id=auth.uid())$$;
          create table public.pa_inquiries(id uuid primary key, deleted_at timestamptz);
          grant select on public.pa_inquiries to authenticated;
          insert into auth.users values('${actor}'),('${outsider}');
          insert into public.work_admins values('${actor}');
          insert into public.pa_inquiries values('${caseA}',null),('${caseB}',null);
          select set_config('request.jwt.claim.sub','${actor}',false);
        `);

        await db.exec(migration);
        await db.exec(migration);

        const columns = (await db.query(`
          select table_name,column_name,data_type
          from information_schema.columns
          where table_schema='public' and table_name in ('pa_stage_plots','pa_stage_plot_revisions')
        `)).rows;
        const column = (table, name) => columns.find((item) => item.table_name === table && item.column_name === name);
        assert.equal(column("pa_stage_plots", "id").data_type, "uuid");
        assert.equal(column("pa_stage_plots", "case_id").data_type, "uuid");
        assert.equal(column("pa_stage_plots", "state").data_type, "jsonb");
        assert.equal(column("pa_stage_plots", "schema_version").data_type, "integer");
        assert.equal(column("pa_stage_plot_revisions", "state").data_type, "jsonb");

        const plotA = await rpc(db, "pa_stage_plot_create", [caseA, JSON.stringify(state("Plot A", "a1"))]);
        const plotB = await rpc(db, "pa_stage_plot_create", [caseA, JSON.stringify(state("Plot B", "b1", 20))]);
        assert.equal(plotA.current_revision, 1);
        assert.equal(plotB.current_revision, 1);
        assert.notEqual(plotA.id, plotB.id);

        const ownGet = await rpc(db, "pa_stage_plot_get", [caseA, plotA.id]);
        assert.equal(ownGet.state.notes, "a1");
        const list = await rpc(db, "pa_stage_plot_list", [caseA]);
        assert.equal(list.length, 2);
        assert(list.every((item) => item.state === undefined), "list is summary-only");

        const saved2 = await rpc(db, "pa_stage_plot_save", [caseA, plotA.id, JSON.stringify(state("Plot A", "a2"))]);
        const saved3 = await rpc(db, "pa_stage_plot_save", [caseA, plotA.id, JSON.stringify(state("Plot A", "a3"))]);
        assert.equal(saved2.current_revision, 2);
        assert.equal(saved3.current_revision, 3);
        const currentA = await rpc(db, "pa_stage_plot_get", [caseA, plotA.id]);
        const currentB = await rpc(db, "pa_stage_plot_get", [caseA, plotB.id]);
        assert.equal(currentA.state.notes, "a3");
        assert.equal(currentA.duration_minutes, 35);
        assert.equal(currentB.state.notes, "b1", "saving Plot A must not mutate Plot B");

        const history = await rpc(db, "pa_stage_plot_revision_list", [caseA, plotA.id]);
        assert.deepEqual(history.map((item) => item.revision_no), [3, 2, 1]);
        const revisions = await Promise.all([1, 2, 3].map((revision) => rpc(db, "pa_stage_plot_revision_get", [caseA, plotA.id, revision])));
        assert.deepEqual(revisions.map((item) => item.state.notes), ["a1", "a2", "a3"]);
        await expectReject(db.query("update public.pa_stage_plot_revisions set state=state where stage_plot_id=$1 and revision_no=1", [plotA.id]), /stage_plot_revision_immutable/);

        await expectReject(rpc(db, "pa_stage_plot_get", [caseB, plotA.id]), /stage_plot_case_mismatch/);
        await expectReject(rpc(db, "pa_stage_plot_save", [caseB, plotA.id, JSON.stringify(state("Plot A", "cross"))]), /stage_plot_case_mismatch/);
        await expectReject(rpc(db, "pa_stage_plot_revision_list", [caseB, plotA.id]), /stage_plot_case_mismatch/);
        await expectReject(rpc(db, "pa_stage_plot_revision_get", [caseB, plotA.id, 1]), /stage_plot_case_mismatch/);

        await db.exec(`
          create function public.phase1a_fail_revision_four() returns trigger language plpgsql set search_path=pg_catalog as $$
          begin if new.revision_no=4 then raise exception 'phase1a_forced_revision_failure'; end if; return new; end $$;
          create trigger phase1a_fail_revision_four before insert on public.pa_stage_plot_revisions
          for each row execute function public.phase1a_fail_revision_four();
        `);
        await expectReject(rpc(db, "pa_stage_plot_save", [caseA, plotA.id, JSON.stringify(state("Plot A", "must-rollback"))]), /phase1a_forced_revision_failure/);
        const afterRollback = await rpc(db, "pa_stage_plot_get", [caseA, plotA.id]);
        assert.equal(afterRollback.current_revision, 3);
        assert.equal(afterRollback.state.notes, "a3", "failed revision insert must roll back current row update");

        await db.exec("set role authenticated");
        const adminVisible = await db.query("select count(*) count from public.pa_stage_plots");
        assert.equal(Number(adminVisible.rows[0].count), 2, "admin RLS select must remain usable");
        await expectReject(db.query("insert into public.pa_stage_plots(case_id,schema_version,state) values($1,1,$2::jsonb)", [caseA, JSON.stringify(state("Direct", "denied"))]), /permission denied/);
        await db.exec("reset role");

        await db.exec(`select set_config('request.jwt.claim.sub','${outsider}',false)`);
        await expectReject(rpc(db, "pa_stage_plot_list", [caseA]), /not_authorized/);
        await db.exec(`select set_config('request.jwt.claim.sub','',false); set role authenticated`);
        await expectReject(db.query("select public.pa_stage_plot_list($1)", [caseA]), /not_authorized/);
        await db.exec("reset role; set role anon");
        await expectReject(db.query("select * from public.pa_stage_plots"), /permission denied/);
        await expectReject(db.query("select * from public.pa_stage_plot_revisions"), /permission denied/);
        await db.exec("reset role");

        const calls = [];
        process.env.SUPABASE_URL = "https://supabase.example.invalid";
        process.env.SUPABASE_SERVICE_ROLE_KEY = "fixture-service-role";
        const fetchImpl = async (url, options) => {
            calls.push({ url: String(url), body: JSON.parse(options.body) });
            return new Response(JSON.stringify({ id: crypto.randomUUID() }), { status: 200, headers: { "content-type": "application/json" } });
        };
        await stagePlots.create({ caseId: caseA, accessToken: "admin-token", state: state("API", "api") }, fetchImpl);
        await stagePlots.get({ caseId: caseA, plotId: plotA.id, accessToken: "admin-token" }, fetchImpl);
        await stagePlots.list({ caseId: caseA, accessToken: "admin-token" }, fetchImpl);
        await stagePlots.save({ caseId: caseA, plotId: plotA.id, accessToken: "admin-token", state: state("API", "save") }, fetchImpl);
        await stagePlots.revisionList({ caseId: caseA, plotId: plotA.id, accessToken: "admin-token" }, fetchImpl);
        await stagePlots.revisionGet({ caseId: caseA, plotId: plotA.id, revisionNo: 1, accessToken: "admin-token" }, fetchImpl);
        assert.deepEqual(calls.map((call) => call.url.match(/rpc\/([^?]+)/u)[1]), [
            "pa_stage_plot_create", "pa_stage_plot_get", "pa_stage_plot_list", "pa_stage_plot_save",
            "pa_stage_plot_revision_list", "pa_stage_plot_revision_get"
        ]);
        assert.equal(calls[0].body.p_state.schemaVersion, 1);
        assert.throws(() => stagePlots.validateState({}), /invalid_stage_plot_state/);
        assert.throws(() => stagePlots.get({ caseId: caseA, plotId: "wrong", accessToken: "x" }), /invalid_stage_plot_id/);

        console.log("Stage Plot Phase 1A validation: PASS (schema, RLS, CRUD, revisions, atomicity, isolation, API, function count)");
    } finally {
        await db.close();
    }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
