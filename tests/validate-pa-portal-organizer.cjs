const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");
const organizer = require("../api/_pa-portal-organizer.cjs");

const migrationA = fs.readFileSync(path.join(__dirname, "..", "supabase", "migrations", "20260908143000_pa_portal_document_management.sql"), "utf8");
const migrationB = fs.readFileSync(path.join(__dirname, "..", "supabase", "migrations", "20260908213000_pa_portal_organizer_access.sql"), "utf8");
const actor = "10000000-0000-4000-8000-000000000001";
const caseA = "20000000-0000-4000-8000-000000000001";
const caseB = "20000000-0000-4000-8000-000000000002";
const uuid = () => crypto.randomUUID();
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const queryResult = async (db, sql, params = []) => (await db.query(sql, params)).rows[0].result;

async function main() {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create schema auth; create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      create table public.work_admins(user_id uuid primary key references auth.users(id));
      create function public.is_work_admin() returns boolean language sql stable security definer set search_path='' as $$select exists(select 1 from public.work_admins where user_id=auth.uid())$$;
      create table public.pa_inquiries(id uuid primary key,deleted_at timestamptz,event_name text,event_date date,event_time text,venue text);
      create table public.pa_gmail_message_index(gmail_message_id text primary key,gmail_thread_id text not null,inquiry_id uuid not null references public.pa_inquiries(id),message_source text,direction text not null,subject text not null default '',sent_at timestamptz,received_at timestamptz,indexed_at timestamptz not null default now(),attachment_metadata jsonb not null default '[]');
      insert into auth.users values('${actor}');insert into public.work_admins values('${actor}');
      insert into public.pa_inquiries values('${caseA}',null,'共同ポータル検証','2026-10-18','10:00〜15:30','検証会場'),('${caseB}',null,'別案件','2026-11-01','09:00〜10:00','別会場');
      insert into public.pa_gmail_message_index values
      ('in_a','thread_a','${caseA}','gmail_received','inbound','主催者資料',now(),null,now(),'[{"id":"tt","filename":"タイムテーブル.pdf","mime_type":"application/pdf"},{"id":"layout","filename":"会場図.pdf","mime_type":"application/pdf"},{"id":"photo","filename":"主催者写真.jpg","mime_type":"image/jpeg"}]'),
      ('out_a','thread_a','${caseA}','pa_case_manager','outbound','ARA共有',now(),null,now(),'[{"id":"power","filename":"音響電源配置図.pdf","mime_type":"application/pdf"},{"id":"ara-photo","filename":"ARA写真.jpg","mime_type":"image/jpeg"}]'),
      ('in_b','thread_b','${caseB}','gmail_received','inbound','別案件',now(),null,now(),'[{"id":"other","filename":"別資料.pdf","mime_type":"application/pdf"}]');
      select set_config('request.jwt.claim.sub','${actor}',false);
    `);
    await db.exec(migrationA); await db.exec(migrationB);
    const identity = await db.query("select count(*) n,count(distinct public_ref) d from pa_portal_document_cards");
    assert.equal(identity.rows[0].n, identity.rows[0].d);
    await db.exec(migrationB);
    assert.equal(Number((await db.query("select count(*) n from pa_portal_access_links")).rows[0].n), 0);

    const raw = organizer.randomSecret();
    assert.match(raw, /^[a-f0-9]{64}$/); assert.equal(Buffer.from(raw, "hex").length, 32);
    const created = await queryResult(db, "select public.pa_portal_manage_link($1,'create',$2,null) result", [caseA, hash(raw)]);
    assert.equal(created.active, true);
    assert.equal((await db.query("select token_hash from pa_portal_access_links")).rows[0].token_hash, hash(raw));
    assert.equal(JSON.stringify((await db.query("select * from pa_portal_access_links")).rows).includes(raw), false);

    const session = organizer.randomSecret();
    const exchanged = await queryResult(db, "select public.pa_portal_exchange($1,$2,now()+interval '12 hours') result", [hash(raw), hash(session)]);
    assert.equal(exchanged.ok, true);
    assert.equal((await queryResult(db, "select public.pa_portal_exchange($1,$2,now()+interval '12 hours') result", [hash("f".repeat(64)), hash(organizer.randomSecret())])).ok, false);
    let model = await queryResult(db, "select public.pa_portal_organizer_read($1) result", [hash(session)]);
    assert.equal(model.ok, true); const serialized = JSON.stringify(model.portal);
    for (const forbidden of ["case_id", "source_ref", "source_key", "gmail_message_id", "attachment_id", "submitted_by", "audit", actor, caseA]) assert.equal(serialized.includes(forbidden), false, forbidden);
    assert.equal(model.portal.event.event_time, "10:00〜15:30");

    const cards = model.portal.cards; const timetable = cards.find((c) => c.category === "timetable"); const script = cards.find((c) => c.category === "script"); const araCard = cards.find((c) => c.owner_kind === "ara_tech");
    const portalRef = (await db.query("select public_ref from pa_portals where case_id=$1", [caseA])).rows[0].public_ref;
    const payload = (cardRef, marker, filename = "新版.pdf") => ({ card_ref: cardRef, source_type: "portal_upload", source_key: `storage:${marker}`, source_ref: { storage_path: `organizer/${portalRef}/${uuid()}/${filename}`, sha256: marker.repeat(64).slice(0, 64), size: 12 }, display_filename: filename, mime_type: "application/pdf", version_label: "v2" });
    let result = await queryResult(db, "select public.pa_portal_organizer_apply($1,'add_version',$2::jsonb,$3) result", [hash(session), JSON.stringify(payload(timetable.ref, "a")), uuid()]);
    assert.equal(result.ok, true);
    result = await queryResult(db, "select public.pa_portal_organizer_apply($1,'add_version',$2::jsonb,$3) result", [hash(session), JSON.stringify(payload(script.ref, "9", "台本初版.pdf")), uuid()]);
    assert.equal(result.ok, true);
    const ownLayout = payload(null, "b", "主催者配置図.pdf"); delete ownLayout.card_ref; ownLayout.new_card = { category: "layout", title: "主催者配置図", owner_kind: "organizer" };
    result = await queryResult(db, "select public.pa_portal_organizer_apply($1,'add_version',$2::jsonb,$3) result", [hash(session), JSON.stringify(ownLayout), uuid()]);
    assert.equal(result.ok, true);
    const deniedPreflight = await queryResult(db, "select public.pa_portal_organizer_authorize($1,'add_version',$2::jsonb) result", [hash(session), JSON.stringify({ card_ref: araCard.ref })]);
    assert.equal(deniedPreflight.ok, false);
    assert(Number((await db.query("select count(*) n from pa_portal_collaboration_audit where success=false and action='add_version' and failure_code='not_permitted'")).rows[0].n) >= 1);
    const deniedAra = await queryResult(db, "select public.pa_portal_organizer_apply($1,'add_version',$2::jsonb,$3) result", [hash(session), JSON.stringify(payload(araCard.ref, "c")), uuid()]);
    assert.equal(deniedAra.ok, false);
    const araSwitchDenied = await queryResult(db, "select public.pa_portal_organizer_apply($1,'switch_current',$2::jsonb,$3) result", [hash(session), JSON.stringify({ card_ref: araCard.ref, version_ref: araCard.current_version_ref }), uuid()]);
    assert.equal(araSwitchDenied.ok, false);
    const araArchiveDenied = await queryResult(db, "select public.pa_portal_organizer_apply($1,'archive_card',$2::jsonb,$3) result", [hash(session), JSON.stringify({ card_ref: araCard.ref }), uuid()]);
    assert.equal(araArchiveDenied.ok, false);
    for (const forbiddenSource of ["gmail_attachment", "pa_attachment"]) {
      const sourceDenied = await queryResult(db, "select public.pa_portal_organizer_apply($1,'add_version',$2::jsonb,$3) result", [hash(session), JSON.stringify({ ...payload(timetable.ref, "7"), source_type: forbiddenSource }), uuid()]);
      assert.equal(sourceDenied.ok, false, forbiddenSource);
    }
    const otherCard = (await queryResult(db, "select public.pa_portal_organizer_read($1) result", [hash(session)])).portal.cards.find((c) => c.title === "主催者配置図");
    const switched = await queryResult(db, "select public.pa_portal_organizer_apply($1,'switch_current',$2::jsonb,$3) result", [hash(session), JSON.stringify({ card_ref: timetable.ref, version_ref: timetable.versions[0].ref }), uuid()]);
    assert.equal(switched.ok, true);
    const archived = await queryResult(db, "select public.pa_portal_organizer_apply($1,'archive_card',$2::jsonb,$3) result", [hash(session), JSON.stringify({ card_ref: otherCard.ref }), uuid()]);
    assert.equal(archived.ok, true);
    const fixedArchive = await queryResult(db, "select public.pa_portal_organizer_apply($1,'archive_card',$2::jsonb,$3) result", [hash(session), JSON.stringify({ card_ref: timetable.ref }), uuid()]);
    assert.equal(fixedArchive.ok, false);

    const crossCard = (await db.query("select c.public_ref from pa_portal_document_cards c join pa_portals p on p.id=c.portal_id where p.case_id=$1 limit 1", [caseB])).rows[0].public_ref;
    const cross = await queryResult(db, "select public.pa_portal_organizer_apply($1,'add_version',$2::jsonb,$3) result", [hash(session), JSON.stringify(payload(crossCard, "d")), uuid()]);
    assert.equal(cross.ok, false);
    const ownerEscalation = await queryResult(db, "select public.pa_portal_organizer_apply($1,'add_version',$2::jsonb,$3) result", [hash(session), JSON.stringify({ ...payload(timetable.ref, "e"), owner_kind: "ara_tech" }), uuid()]);
    assert.equal(ownerEscalation.ok, false);

    const photoPayload = { source_type: "portal_upload", source_key: "storage:photo", source_ref: { storage_path: `organizer/${portalRef}/${uuid()}/photo.jpg`, sha256: "8".repeat(64), size: 12 }, display_filename: "追加写真.jpg", mime_type: "image/jpeg", caption: "主催者追加" };
    const photoAdded = await queryResult(db, "select public.pa_portal_organizer_apply($1,'add_photo',$2::jsonb,$3) result", [hash(session), JSON.stringify(photoPayload), uuid()]); assert.equal(photoAdded.ok, true);
    const photoArchived = await queryResult(db, "select public.pa_portal_organizer_apply($1,'archive_photo',$2::jsonb,$3) result", [hash(session), JSON.stringify({ photo_ref: photoAdded.result.photo_ref }), uuid()]); assert.equal(photoArchived.ok, true);
    const araPhoto = (await queryResult(db, "select public.pa_portal_organizer_read($1) result", [hash(session)])).portal.photos.find((p) => p.owner_kind === "ara_tech");
    const araPhotoDenied = await queryResult(db, "select public.pa_portal_organizer_apply($1,'archive_photo',$2::jsonb,$3) result", [hash(session), JSON.stringify({ photo_ref: araPhoto.ref }), uuid()]); assert.equal(araPhotoDenied.ok, false);
    assert(Number((await db.query("select count(*) n from pa_portal_collaboration_audit where success=false and action in ('add_version','archive_card','archive_photo')")).rows[0].n) >= 3);

    const revoked = await queryResult(db, "select public.pa_portal_manage_link($1,'revoke',null,null) result", [caseA]); assert.equal(revoked.active, false);
    assert.equal((await queryResult(db, "select public.pa_portal_organizer_read($1) result", [hash(session)])).ok, false);
    const secondRaw = organizer.randomSecret(); await queryResult(db, "select public.pa_portal_manage_link($1,'create',$2,null) result", [caseA, hash(secondRaw)]);
    const thirdRaw = organizer.randomSecret(); await queryResult(db, "select public.pa_portal_manage_link($1,'rotate',$2,null) result", [caseA, hash(thirdRaw)]);
    assert.equal((await queryResult(db, "select public.pa_portal_exchange($1,$2,now()+interval '12 hours') result", [hash(secondRaw), hash(organizer.randomSecret())])).ok, false);
    await queryResult(db, "select public.pa_portal_manage_link($1,'revoke',null,null) result", [caseA]);
    const expiredHash = hash(organizer.randomSecret());
    await db.query("insert into pa_portal_access_links(portal_id,token_hash,created_by,created_at,expires_at) select id,$1,$2,now()-interval '2 days',now()-interval '1 day' from pa_portals where case_id=$3", [expiredHash, actor, caseA]);
    assert.equal((await queryResult(db, "select public.pa_portal_exchange($1,$2,now()+interval '12 hours') result", [expiredHash, hash(organizer.randomSecret())])).ok, false);

    assert.equal((await db.query("select has_function_privilege('authenticated','public.pa_portal_organizer_read(text)','execute') allowed")).rows[0].allowed, false);
    await db.exec("set role anon"); await assert.rejects(db.query("select * from pa_portal_access_links"), /permission denied/); await db.exec("reset role");
    process.env.SUPABASE_URL = "https://supabase.example.invalid"; process.env.SUPABASE_SERVICE_ROLE_KEY = "fixture-service-role";
    const upload = { filename: "主催者新版.pdf", mime_type: "application/pdf", data_base64: Buffer.from("%PDF-1.7\n%%EOF").toString("base64") };
    const serviceSession = organizer.randomSecret(); const calls = [];
    const fetchFixture = async (url, options = {}) => {
      calls.push({ url: String(url), method: options.method, body: typeof options.body === "string" ? options.body : "binary" });
      if (String(url).includes("pa_portal_organizer_authorize")) return new Response(JSON.stringify({ ok: true, portal_ref: "a".repeat(36) }), { status: 200, headers: { "content-type": "application/json" } });
      if (String(url).includes("/storage/v1/object/")) return new Response("{}", { status: 200 });
      if (String(url).includes("pa_portal_organizer_apply")) return new Response(JSON.stringify({ ok: true, result: { version_ref: "b".repeat(36) } }), { status: 200, headers: { "content-type": "application/json" } });
      throw new Error(`unexpected ${url}`);
    };
    await organizer.mutate({ session: serviceSession, operation: "add_version", payload: { card_ref: "c".repeat(36), upload }, idempotencyKey: uuid() }, fetchFixture);
    assert(calls.some((call) => call.url.includes("pa_portal_organizer_authorize")) && calls.some((call) => call.url.includes("/storage/v1/object/")) && calls.some((call) => call.url.includes("pa_portal_organizer_apply")));
    assert.equal(JSON.stringify(calls).includes(serviceSession), false, "raw session must never leave the server helper");
    await assert.rejects(organizer.mutate({ session: serviceSession, operation: "add_version", payload: { card_ref: "c".repeat(36), upload: { ...upload, mime_type: "text/html" } }, idempotencyKey: uuid() }, fetchFixture), /invalid_upload/);
    await assert.rejects(organizer.mutate({ session: serviceSession, operation: "add_version", payload: { card_ref: "c".repeat(36), upload: { ...upload, data_base64: Buffer.from("not-a-pdf").toString("base64") } }, idempotencyKey: uuid() }, fetchFixture), /invalid_upload/);
    await assert.rejects(organizer.mutate({ session: serviceSession, operation: "add_version", payload: { card_ref: "c".repeat(36), upload: { ...upload, data_base64: Buffer.alloc(3 * 1024 * 1024 + 1, 65).toString("base64") } }, idempotencyKey: uuid() }, fetchFixture), /upload_too_large/);
    await assert.rejects(organizer.mutate({ session: serviceSession, operation: "candidates", payload: {}, idempotencyKey: uuid() }, fetchFixture), /invalid_operation/);
    const publicApi = fs.readFileSync(path.join(__dirname, "..", "api", "_pa-portal-organizer-handler.cjs"), "utf8");
    const organizerService = fs.readFileSync(path.join(__dirname, "..", "api", "_pa-portal-organizer.cjs"), "utf8");
    const portalApi = fs.readFileSync(path.join(__dirname, "..", "api", "pa-portal.js"), "utf8");
    const vercel = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "vercel.json"), "utf8"));
    const clientSource = fs.readFileSync(path.join(__dirname, "..", "js", "pa-case-portal.js"), "utf8");
    const source = [publicApi, organizerService, clientSource].join("\n");
    assert.doesNotMatch(source, /localStorage|sessionStorage|console\.log\([^)]*token|analytics/u);
    assert.doesNotMatch([publicApi, organizerService].join("\n"), /portalDocuments|\bcandidates\b/u);
    assert.match(portalApi, /request\.query\?\.surface === "organizer"/u);
    assert(vercel.rewrites.some((route) => route.source === "/api/event-portal" && route.destination === "/api/pa-portal?surface=organizer"));
    assert.equal(fs.existsSync(path.join(__dirname, "..", "api", "event-portal.js")), false);
    assert.equal(fs.readdirSync(path.join(__dirname, "..", "api")).filter((name) => name.endsWith(".js")).length, 12, "Vercel Function inventory must remain at the Production limit");
    assert.match(source, /HttpOnly; Secure; SameSite=Strict/u);
    assert.match(source, /history\.replaceState\(null, "", "\/event-portal"\)/u);
    assert.doesNotMatch(clientSource, /^import .*https:\/\/cdn\.jsdelivr\.net/mu);
    assert(clientSource.indexOf('history.replaceState(null, "", "/event-portal")') < clientSource.indexOf("await loadBrowserDependencies(false)"), "clean secret URL before third-party dependency loading");
    assert.match(source, /organizerMode \? \[\["organizer"/u);
    console.log("PA portal organizer validation: PASS (256-bit hash-only links, sessions, sanitized read, owner/crossover/revoke/expiry/RLS)");
  } finally { await db.close(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
