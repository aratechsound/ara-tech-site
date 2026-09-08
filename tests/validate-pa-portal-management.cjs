const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");
const portalService = require("../api/_pa-portal.cjs");

const migration = fs.readFileSync(path.join(__dirname, "..", "supabase", "migrations", "20260908143000_pa_portal_document_management.sql"), "utf8");
const actor = "10000000-0000-4000-8000-000000000001";
const outsider = "10000000-0000-4000-8000-000000000002";
const caseA = "20000000-0000-4000-8000-000000000001";
const caseB = "20000000-0000-4000-8000-000000000002";
const uuid = () => crypto.randomUUID();
const apply = async (db, operation, payload, key = uuid(), caseId = caseA) => (await db.query(
    "select public.pa_portal_apply($1,$2,$3::jsonb,$4) result", [caseId, operation, JSON.stringify(payload), key]
)).rows[0].result;
const source = (message, attachment, filename, mime = "application/pdf", sourceType = "gmail_attachment") => ({
    source_type: sourceType, source_key: `${message}:${attachment}`,
    source_ref: { gmail_message_id: message, gmail_attachment_id: attachment }, display_filename: filename,
    mime_type: mime, contributor_kind: sourceType === "pa_attachment" ? "ara_tech" : "organizer"
});
const uploadSource = (filename, marker) => ({ source_type: "portal_upload", source_key: `storage:${marker}`, source_ref: { storage_path: `cases/${caseA}/${uuid()}/${filename}`, sha256: marker.repeat(64).slice(0, 64), size: 12 }, display_filename: filename, mime_type: "application/pdf", contributor_kind: "ara_tech" });

async function main() {
    const db = new PGlite();
    try {
        await db.exec(`
          create role anon; create role authenticated;
          create schema auth; create table auth.users(id uuid primary key);
          create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
          create table public.work_admins(user_id uuid primary key references auth.users(id));
          create function public.is_work_admin() returns boolean language sql stable security definer set search_path='' as $$select exists(select 1 from public.work_admins where user_id=auth.uid())$$;
          create table public.pa_inquiries(id uuid primary key,deleted_at timestamptz,event_name text,event_date date,venue text);
          create table public.pa_gmail_message_index(
            gmail_message_id text primary key,gmail_thread_id text not null,inquiry_id uuid not null references public.pa_inquiries(id),message_source text,
            direction text not null,subject text not null default '',sent_at timestamptz,received_at timestamptz,indexed_at timestamptz not null default now(),attachment_metadata jsonb not null default '[]'
          );
          insert into auth.users values('${actor}'),('${outsider}'); insert into public.work_admins values('${actor}');
          insert into public.pa_inquiries values('${caseA}',null,'2026龍姫湖まつり','2026-10-18','検証会場'),('${caseB}',null,'別案件','2026-11-01','別会場');
          insert into public.pa_gmail_message_index values
            ('mail_a','thread_a','${caseA}','gmail_received','inbound','資料','2026-09-01T00:00:00Z',null,now(),'[{"id":"tt1","filename":"タイムテーブル（予定）.pdf","mime_type":"application/pdf"},{"id":"layout1","filename":"メイン会場図.pdf","mime_type":"application/pdf"},{"id":"photo1","filename":"ステージ写真.jpg","mime_type":"image/jpeg"}]'),
            ('mail_b','thread_a','${caseA}','pa_case_manager','outbound','共有資料','2026-09-02T00:00:00Z',null,now(),'[{"id":"tt2","filename":"タイムテーブル確定版.pdf","mime_type":"application/pdf"},{"id":"layout2","filename":"音響電源配置図.pdf","mime_type":"application/pdf"},{"id":"other1","filename":"注意事項.pdf","mime_type":"application/pdf"},{"id":"quote1","filename":"正式見積書.pdf","mime_type":"application/pdf"}]'),
            ('mail_x','thread_x','${caseB}','gmail_received','inbound','別案件','2026-09-03T00:00:00Z',null,now(),'[{"id":"secret","filename":"別案件.pdf","mime_type":"application/pdf"}]');
          select set_config('request.jwt.claim.sub','${actor}',false);
        `);
        await db.exec(migration);
        const initial = (await db.query("select (select count(*) from pa_portals) portals,(select count(*) from pa_portal_document_cards) cards,(select count(*) from pa_portal_document_versions) versions,(select count(*) from pa_portal_photo_items) photos")).rows[0];
        assert.equal(Number(initial.portals), 2); assert.equal(Number(initial.versions), 6); assert.equal(Number(initial.photos), 1);
        await db.exec(migration);
        const replay = (await db.query("select (select count(*) from pa_portals) portals,(select count(*) from pa_portal_document_cards) cards,(select count(*) from pa_portal_document_versions) versions,(select count(*) from pa_portal_photo_items) photos")).rows[0];
        assert.deepEqual(replay, initial, "backfill replay must not duplicate portal data");

        let model = (await db.query("select public.pa_portal_read($1) result", [caseA])).rows[0].result;
        assert(model.cards.flatMap((card) => card.versions).some((version) => version.source_type === "gmail_attachment"));
        assert(model.cards.flatMap((card) => card.versions).some((version) => version.source_type === "pa_attachment"));
        assert.equal(model.cards.flatMap((card) => card.versions).some((version) => /見積|契約|請求/u.test(version.display_filename)), false);
        const timetable = model.cards.find((card) => card.category === "timetable");
        const oldTimetable = timetable.current_version_id;
        const timetableResult = await apply(db, "add_version", { card_id: timetable.id, ...uploadSource("タイムテーブル最終版.pdf", "c"), version_label: "確定版" });
        model = (await db.query("select public.pa_portal_read($1) result", [caseA])).rows[0].result;
        const updatedTimetable = model.cards.find((card) => card.id === timetable.id);
        assert.equal(updatedTimetable.current_version_id, timetableResult.version_id); assert(updatedTimetable.versions.some((item) => item.id === oldTimetable));

        const script = model.cards.find((card) => card.category === "script");
        const firstScript = await apply(db, "add_version", { card_id: script.id, ...uploadSource("台本初版.pdf", "a"), version_label: "v1" });
        const secondScript = await apply(db, "add_version", { card_id: script.id, ...uploadSource("台本第二版.pdf", "b"), version_label: "v2" });
        assert.notEqual(firstScript.version_id, secondScript.version_id);

        const layout = await apply(db, "add_version", { new_card: { category: "layout", title: "音響・電源配置図", owner_kind: "ara_tech", sort_order: 30 }, ...source("mail_b", "layout2", "音響電源配置図.pdf", "application/pdf", "pa_attachment"), version_label: "v1" });
        const other = await apply(db, "add_version", { new_card: { category: "other", title: "搬入注意事項", owner_kind: "shared", sort_order: 50 }, ...source("mail_b", "other1", "注意事項.pdf", "application/pdf", "pa_attachment"), version_label: "初版" });
        assert(layout.card_id && other.card_id);

        const photoOne = await apply(db, "add_photo", { source_type: "portal_upload", source_key: "storage:one", source_ref: { storage_path: `cases/${caseA}/${uuid()}/one.jpg`, sha256: "1".repeat(64), size: 4 }, display_filename: "現調1.jpg", mime_type: "image/jpeg", contributor_kind: "ara_tech" });
        const photoTwo = await apply(db, "add_photo", { source_type: "portal_upload", source_key: "storage:two", source_ref: { storage_path: `cases/${caseA}/${uuid()}/two.png`, sha256: "2".repeat(64), size: 8 }, display_filename: "現調2.png", mime_type: "image/png", contributor_kind: "shared" });
        assert(photoOne.photo_id && photoTwo.photo_id);

        await apply(db, "switch_current", { card_id: timetable.id, version_id: oldTimetable });
        model = (await db.query("select public.pa_portal_read($1) result", [caseA])).rows[0].result;
        assert.equal(model.cards.find((card) => card.id === timetable.id).current_version_id, oldTimetable);
        await apply(db, "archive_version", { version_id: timetableResult.version_id });
        await apply(db, "archive_photo", { photo_id: photoTwo.photo_id });
        await apply(db, "archive_card", { card_id: other.card_id });

        const idempotencyKey = uuid();
        const repeatedA = await apply(db, "switch_current", { card_id: timetable.id, version_id: oldTimetable }, idempotencyKey);
        const repeatedB = await apply(db, "switch_current", { card_id: timetable.id, version_id: oldTimetable }, idempotencyKey);
        assert.deepEqual(repeatedB, repeatedA);
        await assert.rejects(apply(db, "archive_card", { card_id: timetable.id }, idempotencyKey), /idempotency_key_mismatch/);
        await assert.rejects(apply(db, "add_version", { card_id: timetable.id, ...source("mail_x", "secret", "別案件.pdf") }), /attachment_case_mismatch/);
        await assert.rejects(apply(db, "switch_current", { card_id: timetable.id, version_id: secondScript.version_id }), /version_case_mismatch/);
        await assert.rejects(apply(db, "archive_card", { card_id: timetable.id }), /cannot_archive_fixed/);

        await db.exec(`select set_config('request.jwt.claim.sub','${outsider}',false)`);
        await assert.rejects(db.query("select public.pa_portal_read($1)", [caseA]), /not_authorized/);
        await db.exec(`select set_config('request.jwt.claim.sub','${actor}',false); set role anon`);
        await assert.rejects(db.query("select * from public.pa_portals"), /permission denied/);
        await db.exec("reset role");

        assert.throws(() => portalService.safeFilename("payload.exe"), /invalid_upload_filename/);
        assert.throws(() => portalService.decodeUpload({ filename: "bad.pdf", mime_type: "application/pdf", data_base64: Buffer.from("not pdf").toString("base64") }), /invalid_upload/);
        const pdf = portalService.decodeUpload({ filename: "資料.pdf", mime_type: "application/pdf", data_base64: Buffer.from("%PDF-1.7\n%%EOF").toString("base64") });
        assert.equal(pdf.mime, "application/pdf");
        process.env.SUPABASE_URL = "https://supabase.example.invalid";
        process.env.SUPABASE_SERVICE_ROLE_KEY = "fixture-service-role";
        const upload = { filename: "新版.pdf", mime_type: "application/pdf", data_base64: Buffer.from("%PDF-1.7\n%%EOF").toString("base64") };
        const calls = [];
        const okFetch = async (url, options = {}) => {
            calls.push({ url: String(url), method: options.method, body: options.body });
            if (String(url).includes("/storage/v1/object/")) return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
            if (String(url).includes("/rest/v1/rpc/pa_portal_apply")) return new Response(JSON.stringify({ version_id: uuid() }), { status: 200, headers: { "content-type": "application/json" } });
            throw new Error(`unexpected fetch ${url}`);
        };
        await portalService.mutate({ caseId: caseA, accessToken: "actor-token", operation: "add_version", payload: { card_id: timetable.id, contributor_kind: "ara_tech", upload }, idempotencyKey: uuid() }, okFetch);
        assert(calls.some((call) => call.url.includes(`/storage/v1/object/${portalService.BUCKET}/cases/${caseA}/`) && call.method === "POST"));
        const rpcCall = calls.find((call) => call.url.includes("pa_portal_apply"));
        assert.equal(JSON.parse(rpcCall.body).p_payload.source_type, "portal_upload");

        const cleanupCalls = [];
        const failingFetch = async (url, options = {}) => {
            cleanupCalls.push({ url: String(url), method: options.method });
            if (String(url).includes("/storage/v1/object/")) return new Response("{}", { status: 200 });
            return new Response("{}", { status: 400, headers: { "content-type": "application/json" } });
        };
        await assert.rejects(portalService.mutate({ caseId: caseA, accessToken: "actor-token", operation: "add_version", payload: { card_id: timetable.id, contributor_kind: "ara_tech", upload }, idempotencyKey: uuid() }, failingFetch), /supabase_400/);
        assert(cleanupCalls.some((call) => call.method === "DELETE"), "failed metadata transaction must clean up its uploaded object");
        console.log("PA portal management validation: PASS (logical cards, versions, backfill, switching, archive, RLS, crossover, upload validation)");
    } finally { await db.close(); }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
