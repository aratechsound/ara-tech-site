const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");
const candidateService = require("../api/_pa-portal-candidates.cjs");
const gmailService = require("../api/_pa-gmail.cjs");

const root = path.resolve(__dirname, "..");
const portalMigration = fs.readFileSync(path.join(root, "supabase", "migrations", "20260908143000_pa_portal_document_management.sql"), "utf8");
const candidateMigration = fs.readFileSync(path.join(root, "supabase", "migrations", "20260909060000_pa_portal_document_candidates.sql"), "utf8");
const remediationMigration = fs.readFileSync(path.join(root, "supabase", "migrations", "20260909093000_pa_portal_candidate_canonical_identity.sql"), "utf8");
const variantMigration = fs.readFileSync(path.join(root, "supabase", "migrations", "20260909110000_pa_portal_candidate_variant_reconcile.sql"), "utf8");
const actor = "10000000-0000-4000-8000-000000000001";
const outsider = "10000000-0000-4000-8000-000000000002";
const caseA = "20000000-0000-4000-8000-000000000001";
const caseB = "20000000-0000-4000-8000-000000000002";
const uuid = () => crypto.randomUUID();
const attachment = (id, filename, mime = "application/pdf", extra = {}) => ({ id, gmail_attachment_id: id, part_id: `part-${id}`, filename, mime_type: mime, size: 25_000, ...extra });
const message = (id, direction, subject, attachments) => ({ id, direction, subject, attachments });
const detect = async (db, proposals) => (await db.query("select public.pa_portal_candidate_detect($1,$2,$3::jsonb) result", [caseA, actor, JSON.stringify(proposals)])).rows[0].result;
const review = async (db, candidateId, decision, target, key = uuid(), caseId = caseA) => (await db.query("select public.pa_portal_candidate_apply($1,$2,$3,$4::jsonb,$5) result", [caseId, candidateId, decision, JSON.stringify(target), key])).rows[0].result;

async function main() {
    const candidateSource = fs.readFileSync(path.join(root, "api", "_pa-portal-candidates.cjs"), "utf8");
    const portalApiSource = fs.readFileSync(path.join(root, "api", "pa-portal.js"), "utf8");
    const organizerSource = fs.readFileSync(path.join(root, "api", "_pa-portal-organizer.cjs"), "utf8");
    assert.doesNotMatch(candidateSource, /openai|anthropic|gemini|vertex|bedrock/iu, "classification is deterministic and must not call an undeclared external AI provider");
    assert.match(portalApiSource, /verifyAdmin\(token\)[\s\S]*candidate_list/u);
    assert.match(portalApiSource, /candidate_download/u); assert.match(portalApiSource, /candidate_accept/u); assert.match(portalApiSource, /candidate_ignore/u);
    assert.doesNotMatch(organizerSource, /candidate_(?:list|download|accept|ignore|backfill)/u, "organizer service must not expose candidate operations");
    assert.equal(fs.readdirSync(path.join(root, "api")).filter((name) => name.endsWith(".js")).length, 12);
    const isolatedFailure = await gmailService.detectCandidatesFailIsolated({ inquiryId: caseA, actorId: actor, messages: [] }, async () => { throw new Error("network must not run"); }, async () => { throw new Error("candidate store unavailable"); });
    assert.deepEqual(isolatedFailure, { status: "unavailable" }, "candidate persistence failure must not fail Gmail synchronization");
    const isolatedSuccess = await gmailService.detectCandidatesFailIsolated({ inquiryId: caseA, actorId: actor, messages: [] }, async () => { throw new Error("network must not run"); }, async () => ({ detected: 2, pending: 3 }));
    assert.deepEqual(isolatedSuccess, { status: "complete", detected: 2, pending: 3 });
    const normalizedInline = gmailService.normalizeMessage({ id: "inline_mail", threadId: "inline_thread", internalDate: "1788900000000", payload: { headers: [{ name: "From", value: "customer@example.test" }], parts: [{ filename: "mail_signature_logo.png", mimeType: "image/png", headers: [{ name: "Content-ID", value: "<logo>" }, { name: "Content-Disposition", value: "inline" }], body: { attachmentId: "inline_logo", size: 12000 } }] } });
    assert.deepEqual({ inline: normalizedInline.attachments[0].inline, content_id: normalizedInline.attachments[0].content_id, content_disposition: normalizedInline.attachments[0].content_disposition }, { inline: true, content_id: "<logo>", content_disposition: "inline" });
    const identityV1 = gmailService.normalizeMessage({ id: "variant_mail", threadId: "variant_thread", payload: { headers: [], parts: [{ partId: "2.1", filename: "stage_photo.jpg", mimeType: "image/jpeg", body: { attachmentId: "opaque_v1", size: 100 } }] } }).attachments[0];
    const identityV2 = gmailService.normalizeMessage({ id: "variant_mail", threadId: "variant_thread", payload: { headers: [], parts: [{ partId: "2.1", filename: "stage_photo.jpg", mimeType: "image/jpeg", body: { attachmentId: "opaque_v2", size: 100 } }] } }).attachments[0];
    assert.deepEqual([identityV1.id, identityV1.gmail_attachment_id, identityV1.part_id], ["opaque_v1", "opaque_v1", "2.1"]);
    assert.equal(candidateService.canonicalAssetKey("variant_mail", identityV1.part_id), candidateService.canonicalAssetKey("variant_mail", identityV2.part_id), "opaque Gmail attachment-ID variants must share the stable message + MIME-part identity");
    assert.notEqual(identityV1.id, identityV2.id, "fixture must exercise a changed Gmail attachment ID");

    const stagePhoto = candidateService.suggestionFor({ filename: "ステージ写真（参考）.JPG", mime_type: "image/jpeg", subject: "音響・電源・会場資料" });
    assert.deepEqual([stagePhoto.suggested_category, stagePhoto.confidence], ["photo", "medium"], "photo filename wins over a conflicting subject without unjustified HIGH");
    const genericProductionPhoto = candidateService.suggestionFor({ filename: "R0012986.JPG", mime_type: "image/jpeg", subject: "音響・電源・会場資料" });
    assert.deepEqual([genericProductionPhoto.suggested_category, genericProductionPhoto.confidence], ["photo", "low"], "generic image remains PHOTO but subject-only conflict lowers confidence");
    assert.deepEqual([candidateService.suggestionFor({ filename: "venue_photo.jpg", mime_type: "image/jpeg", subject: "" }).suggested_category, candidateService.suggestionFor({ filename: "venue_photo.jpg", mime_type: "image/jpeg", subject: "" }).confidence], ["photo", "high"]);
    assert.deepEqual([candidateService.suggestionFor({ filename: "会場配置図.jpg", mime_type: "image/jpeg", subject: "" }).suggested_category, candidateService.suggestionFor({ filename: "会場配置図.jpg", mime_type: "image/jpeg", subject: "" }).confidence], ["layout", "high"]);
    assert.deepEqual([candidateService.suggestionFor({ filename: "配置図.pdf", mime_type: "application/pdf", subject: "" }).suggested_category, candidateService.suggestionFor({ filename: "配置図.pdf", mime_type: "application/pdf", subject: "" }).confidence], ["layout", "high"]);
    assert.deepEqual([candidateService.suggestionFor({ filename: "タイムテーブル.pdf", mime_type: "application/pdf", subject: "" }).suggested_category, candidateService.suggestionFor({ filename: "タイムテーブル.pdf", mime_type: "application/pdf", subject: "" }).confidence], ["timetable", "high"]);
    assert.notEqual(candidateService.suggestionFor({ filename: "stage_photo.pdf", mime_type: "application/pdf", subject: "" }).confidence, "high", "strong filename with conflicting MIME must not be HIGH");
    assert.deepEqual([candidateService.suggestionFor({ filename: "IMG_0001.JPG", mime_type: "image/jpeg", subject: "" }).suggested_category, candidateService.suggestionFor({ filename: "IMG_0001.JPG", mime_type: "image/jpeg", subject: "" }).confidence], ["photo", "medium"]);
    assert.notEqual(candidateService.suggestionFor({ filename: "会場配置図.jpg", mime_type: "image/jpeg", subject: "ステージ写真" }).confidence, "high", "conflicting filename and subject must not be HIGH");
    assert.notEqual(candidateService.suggestionFor({ filename: "document.pdf", mime_type: "application/pdf", subject: "タイムテーブル" }).confidence, "high", "subject-only evidence must not be HIGH");
    const sameNameBuilt = candidateService.buildProposals([message("same_message", "inbound", "", [
        attachment("current_a", "same-name.pdf", "application/pdf", { part_id: "2", size: 4 }),
        attachment("current_b", "same-name.pdf", "application/pdf", { part_id: "3", size: 4 })
    ])], []);
    const variantBytes = new Map([["historical_b", Buffer.from("BBBB")], ["current_a", Buffer.from("AAAA")], ["current_b", Buffer.from("BBBB")]]);
    const preparedMappings = await candidateService.buildIdentityMappings({
        caseId: caseA,
        proposals: sameNameBuilt.proposals,
        registered: [{ asset_kind: "version", asset_id: "30000000-0000-4000-8000-000000000001", source_type: "gmail_attachment", source_ref: { gmail_message_id: "same_message", gmail_attachment_id: "historical_b" }, display_filename: "same-name.pdf", mime_type: "application/pdf", canonical_attachment_key: null }],
        attachmentVariantLoader: async ({ gmailAttachmentId }) => {
            const bytes = variantBytes.get(gmailAttachmentId);
            if (!bytes) throw new Error("fixture_attachment_missing");
            return { bytes, size: bytes.length };
        }
    });
    assert.equal(preparedMappings.mappings.length, 1, "same message and same filename still require one exact content-hash match");
    assert.equal(preparedMappings.mappings[0].current_attachment_id, "current_b", "same-size different attachment must not be reconciled");
    assert.equal(preparedMappings.mappings[0].gmail_part_id, "3", "canonical identity uses the stable MIME part, not the opaque attachment variant");
    assert.match(preparedMappings.mappings[0].content_sha256, /^[a-f0-9]{64}$/u);
    const unmatchedMappings = await candidateService.buildIdentityMappings({
        caseId: caseA,
        proposals: sameNameBuilt.proposals,
        registered: [{ asset_kind: "version", asset_id: "30000000-0000-4000-8000-000000000002", source_type: "gmail_attachment", source_ref: { gmail_message_id: "same_message", gmail_attachment_id: "historical_missing" }, display_filename: "same-name.pdf", mime_type: "application/pdf", canonical_attachment_key: null }],
        attachmentVariantLoader: async ({ gmailAttachmentId }) => ({ bytes: Buffer.from(gmailAttachmentId === "historical_missing" ? "CCCC" : gmailAttachmentId === "current_a" ? "AAAA" : "BBBB"), size: 4 })
    });
    assert.deepEqual([unmatchedMappings.mappings.length, unmatchedMappings.unresolved.length], [0, 1], "unmatched historical asset remains unresolved instead of being guessed by filename or size");
    const db = new PGlite();
    try {
        await db.exec(`
          create role anon; create role authenticated; create role service_role;
          create schema auth; create table auth.users(id uuid primary key);
          create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
          create table public.work_admins(user_id uuid primary key references auth.users(id));
          create function public.is_work_admin() returns boolean language sql stable security definer set search_path='' as $$select exists(select 1 from public.work_admins where user_id=auth.uid())$$;
          create table public.pa_inquiries(id uuid primary key,deleted_at timestamptz,event_name text,event_date date,venue text);
          create table public.pa_gmail_thread_links(id uuid primary key default gen_random_uuid(),inquiry_id uuid not null references public.pa_inquiries(id),gmail_thread_id text not null unique);
          create table public.pa_gmail_message_index(gmail_message_id text primary key,gmail_thread_id text not null,inquiry_id uuid not null references public.pa_inquiries(id),message_source text,direction text not null,from_address text not null,to_addresses jsonb not null default '[]',cc_addresses jsonb not null default '[]',subject text not null default '',sent_at timestamptz,received_at timestamptz,indexed_at timestamptz not null default now(),attachment_metadata jsonb not null default '[]');
          insert into auth.users values('${actor}'),('${outsider}'); insert into public.work_admins values('${actor}');
          insert into public.pa_inquiries values('${caseA}',null,'候補検証イベント','2026-10-18','検証会場'),('${caseB}',null,'別案件','2026-11-01','別会場');
          select set_config('request.jwt.claim.sub','${actor}',false);
        `);
        await db.exec(portalMigration);
        const portals = (await db.query("select case_id,id from public.pa_portals order by case_id")).rows;
        const portalA = portals.find((row) => row.case_id === caseA).id;
        const portalB = portals.find((row) => row.case_id === caseB).id;
        await db.query("insert into public.pa_portal_document_cards(portal_id,category,title,card_kind,owner_kind,sort_order) values($1,'layout','メイン会場図','collection','shared',30),($2,'other','別案件カード','collection','shared',50)", [portalA, portalB]);

        const inboundAttachments = [
            attachment("tt", "タイムテーブル確定版.pdf"), attachment("script", "進行台本.pdf"), attachment("layout_existing", "メイン会場図_v2.pdf"),
            attachment("layout_new", "搬入導線図.pdf"), attachment("photo", "stage_02.jpg", "image/jpeg"), attachment("other", "運営連絡事項.pdf"),
            attachment("low", "document.pdf"), attachment("quote", "正式見積書.pdf"), attachment("contract", "契約書.pdf"), attachment("invoice", "請求書.pdf"),
            attachment("signature", "mail_signature_logo.png", "image/png", { inline: true, content_id: "<logo>", size: 12_000 }),
            attachment("pixel", "pixel.png", "image/png", { size: 512 }), attachment("already", "既に登録済み.pdf"),
            attachment("legacy", "legacy-reference.pdf", "application/octet-stream", { inline: "not-a-boolean" })
        ];
        const outboundAttachments = [attachment("out_script", "運営台本_改訂版.pdf")];
        const unboundAttachments = [attachment("unbound", "未紐付資料.pdf")];
        const crossAttachments = [attachment("cross", "別案件資料.pdf")];
        await db.query("insert into public.pa_gmail_thread_links(inquiry_id,gmail_thread_id) values($1,'thread_a'),($2,'thread_b')", [caseA, caseB]);
        await db.query(`insert into public.pa_gmail_message_index(gmail_message_id,gmail_thread_id,inquiry_id,message_source,direction,from_address,subject,received_at,sent_at,attachment_metadata) values
          ('mail_in','thread_a',$1,'gmail_received','inbound','organizer@example.test','イベント運営資料','2026-09-09T00:00:00Z',null,$2::jsonb),
          ('mail_out','thread_a',$1,'pa_case_manager','outbound','aratechsound@gmail.com','見積とイベント資料',null,'2026-09-09T01:00:00Z',$3::jsonb),
          ('mail_unbound','thread_unbound',$1,'gmail_received','inbound','other@example.test','未紐付',now(),null,$4::jsonb),
          ('mail_cross','thread_b',$5,'gmail_received','inbound','cross@example.test','別案件',now(),null,$6::jsonb)`, [caseA, JSON.stringify(inboundAttachments), JSON.stringify(outboundAttachments), JSON.stringify(unboundAttachments), caseB, JSON.stringify(crossAttachments)]);
        const layoutCard = (await db.query("select id from public.pa_portal_document_cards where portal_id=$1 and title='メイン会場図'", [portalA])).rows[0].id;
        const otherCard = (await db.query("select id from public.pa_portal_document_cards where portal_id=$1 and category='other' limit 1", [portalA])).rows[0]?.id || (await db.query("insert into public.pa_portal_document_cards(portal_id,category,title,card_kind,owner_kind,sort_order) values($1,'other','登録済み','collection','shared',50) returning id", [portalA])).rows[0].id;
        await db.query("insert into public.pa_portal_document_versions(card_id,source_type,source_key,source_ref,display_filename,mime_type,contributor_kind) values($1,'gmail_attachment','mail_in:already',$2::jsonb,'既に登録済み.pdf','application/pdf','organizer')", [otherCard, JSON.stringify({ gmail_message_id: "mail_in", gmail_attachment_id: "already" })]);
        await db.exec(candidateMigration);
        await db.exec(remediationMigration);
        await db.exec(variantMigration);

        const cards = (await db.query("select id,category,title,card_kind,archived_at from public.pa_portal_document_cards where portal_id=$1", [portalA])).rows;
        const messages = [message("mail_in", "inbound", "イベント運営資料", inboundAttachments), message("mail_out", "outbound", "見積とイベント資料", outboundAttachments), message("mail_unbound", "inbound", "未紐付", unboundAttachments), message("mail_cross", "inbound", "別案件", crossAttachments)];
        const built = candidateService.buildProposals(messages, cards);
        assert.equal(built.businessExcluded, 3); assert.equal(built.signatureExcluded, 2);
        const byAttachment = Object.fromEntries(built.proposals.map((item) => [item.gmail_attachment_id, item]));
        assert.deepEqual([byAttachment.tt.suggested_category, byAttachment.tt.suggested_action, byAttachment.tt.confidence], ["timetable", "add_new_version", "high"]);
        assert.equal(byAttachment.script.suggested_category, "script");
        assert.deepEqual([byAttachment.layout_existing.suggested_category, byAttachment.layout_existing.suggested_action, byAttachment.layout_existing.suggested_card_id], ["layout", "add_new_version", layoutCard]);
        assert.deepEqual([byAttachment.layout_new.suggested_category, byAttachment.layout_new.suggested_action], ["layout", "create_new_card"]);
        assert.equal(candidateService.suggestionFor({ filename: "メイン会場図修正版.pdf", mime_type: "application/pdf", subject: "" }, cards).suggested_action, "add_new_version");
        assert.deepEqual([byAttachment.photo.suggested_category, byAttachment.photo.suggested_action], ["photo", "add_photo"]);
        assert.deepEqual([byAttachment.low.suggested_category, byAttachment.low.confidence], ["other", "low"]);
        assert.equal(candidateService.suggestionFor({ filename: "出演者A_ステージ図.pdf", mime_type: "application/pdf", subject: "" }, cards).suggested_action, "hold_performer");

        const first = await detect(db, built.proposals);
        assert.equal(Number(first.detected), 9, "only exactly linked, unregistered, non-business, non-signature attachments become candidates");
        assert.equal(Number((await db.query("select count(*) n from public.pa_portal_document_versions")).rows[0].n), 1, "detection must not auto-register a document version");
        assert.equal(Number((await db.query("select count(*) n from public.pa_portal_photo_items")).rows[0].n), 0, "detection must not auto-register a photo");
        assert.equal(Number((await db.query("select count(*) n from public.pa_portal_document_cards where current_version_id is not null")).rows[0].n), 0, "detection must not promote any current version");
        assert.equal(Number((await detect(db, built.proposals)).detected), 0, "repeat detection must be idempotent");
        assert.equal(Number((await db.query("select count(*) n from public.pa_portal_document_candidates")).rows[0].n), 9);
        assert.equal(Number((await db.query("select count(*) n from public.pa_portal_document_candidates where gmail_attachment_id in ('unbound','cross','already','quote','contract','invoice','signature','pixel')")).rows[0].n), 0);
        assert.equal(Number((await db.query("select count(*) n from public.pa_portal_candidate_audit where action in ('DETECTED','SUGGESTED')")).rows[0].n), 18);

        const candidates = (await db.query("select * from public.pa_portal_document_candidates order by gmail_attachment_id")).rows;
        const candidate = (id) => candidates.find((item) => item.gmail_attachment_id === id);
        assert.deepEqual([candidate("tt").source_direction, candidate("tt").source_type], ["inbound", "gmail_attachment"]);
        assert.deepEqual([candidate("out_script").source_direction, candidate("out_script").source_type], ["outbound", "pa_attachment"]);
        const timetableCard = cards.find((item) => item.category === "timetable");
        const noCurrent = await review(db, candidate("tt").id, "accept", { action: "add_new_version", category: "timetable", card_id: timetableCard.id, title: "タイムテーブル", owner_kind: "shared", version_label: "確定版", note: "", make_current: false });
        assert.equal(noCurrent.current_changed, false);
        assert.equal((await db.query("select current_version_id from public.pa_portal_document_cards where id=$1", [timetableCard.id])).rows[0].current_version_id, null, "arrival or acceptance without explicit current approval must not promote");

        const scriptCard = cards.find((item) => item.category === "script");
        const promoted = await review(db, candidate("out_script").id, "accept", { action: "add_new_version", category: "script", card_id: scriptCard.id, title: "台本", owner_kind: "shared", version_label: "改訂版", note: "", make_current: true });
        assert.equal((await db.query("select current_version_id from public.pa_portal_document_cards where id=$1", [scriptCard.id])).rows[0].current_version_id, promoted.version_id);

        const changed = await review(db, candidate("layout_new").id, "accept", { action: "create_new_card", category: "other", card_id: null, title: "搬入要領", owner_kind: "ara_tech", version_label: "v1", note: "確認済み", make_current: true });
        assert(changed.card_id && changed.version_id);
        assert.equal(Number((await db.query("select count(*) n from public.pa_portal_candidate_audit where candidate_id=$1 and action='TARGET_CHANGED'", [candidate("layout_new").id])).rows[0].n), 1);

        const layoutVersion = await review(db, candidate("layout_existing").id, "accept", { action: "add_new_version", category: "layout", card_id: layoutCard, title: "メイン会場図", owner_kind: "shared", version_label: "v2", note: "", make_current: true });
        assert.equal((await db.query("select current_version_id from public.pa_portal_document_cards where id=$1", [layoutCard])).rows[0].current_version_id, layoutVersion.version_id);
        const photo = await review(db, candidate("photo").id, "accept", { action: "add_photo", category: "photo", card_id: null, title: "stage_02", owner_kind: "shared", version_label: "", note: "現場写真", make_current: false });
        assert(photo.photo_id);
        const acceptedSources = (await db.query("select source_type,source_ref from public.pa_portal_document_versions where id in ($1,$2,$3) union all select source_type,source_ref from public.pa_portal_photo_items where id=$4", [noCurrent.version_id, promoted.version_id, changed.version_id, photo.photo_id])).rows;
        assert(acceptedSources.every((item) => ["gmail_attachment", "pa_attachment"].includes(item.source_type) && item.source_ref.gmail_message_id && !item.source_ref.storage_path), "accepted candidates must retain canonical Gmail references without copied bytes");

        await review(db, candidate("low").id, "ignore", {});
        assert.equal((await db.query("select status from public.pa_portal_document_candidates where id=$1", [candidate("low").id])).rows[0].status, "ignored");
        await detect(db, built.proposals);
        assert.equal(Number((await db.query("select count(*) n from public.pa_portal_document_candidates where gmail_attachment_id='low'")).rows[0].n), 1, "ignored candidate must not reappear");

        const pendingOther = candidate("other");
        const beforeVersions = Number((await db.query("select count(*) n from public.pa_portal_document_versions")).rows[0].n);
        const foreignCard = (await db.query("select id from public.pa_portal_document_cards where portal_id=$1 and category='other' limit 1", [portalB])).rows[0].id;
        await assert.rejects(review(db, pendingOther.id, "accept", { action: "add_new_version", category: "other", card_id: foreignCard, title: "運営連絡事項", owner_kind: "shared", version_label: "", note: "", make_current: true }), /candidate_card_mismatch/);
        assert.equal((await db.query("select status from public.pa_portal_document_candidates where id=$1", [pendingOther.id])).rows[0].status, "pending");
        assert.equal(Number((await db.query("select count(*) n from public.pa_portal_document_versions")).rows[0].n), beforeVersions, "failed acceptance must roll back every portal mutation");
        await assert.rejects(db.query("select public.pa_portal_candidate_asset($1,$2)", [caseB, pendingOther.id]), /candidate_case_mismatch/);
        await assert.rejects(review(db, pendingOther.id, "accept", { action: "create_new_card", category: "other", card_id: null, title: "別案件へ移動", owner_kind: "shared", version_label: "", note: "", make_current: true }, uuid(), caseB), /candidate_case_mismatch/);
        const pendingScript = candidate("script");
        await db.query("update public.pa_portal_document_candidates set gmail_message_id='mail_cross',gmail_attachment_id='cross' where id=$1", [pendingScript.id]);
        await assert.rejects(review(db, pendingScript.id, "accept", { action: "add_new_version", category: "script", card_id: scriptCard.id, title: "台本", owner_kind: "shared", version_label: "", note: "", make_current: true }), /candidate_attachment_mismatch/);
        assert.equal((await db.query("select status from public.pa_portal_document_candidates where id=$1", [pendingScript.id])).rows[0].status, "pending");

        const legacy = await review(db, candidate("legacy").id, "accept", { action: "create_new_card", category: "other", card_id: null, title: "Legacy reference", owner_kind: "shared", version_label: "", note: "", make_current: true });
        assert(legacy.version_id, "extension-derived MIME must pass the same canonical attachment validation during acceptance");

        await db.exec(`select set_config('request.jwt.claim.sub','${outsider}',false)`);
        await assert.rejects(db.query("select public.pa_portal_candidate_read($1)", [caseA]), /not_authorized/);
        await assert.rejects(db.query("select public.pa_portal_candidate_detect($1,$2,'[]'::jsonb)", [caseA, outsider]), /not_authorized/);
        await db.exec(`select set_config('request.jwt.claim.sub','${actor}',false); set role anon`);
        await assert.rejects(db.query("select * from public.pa_portal_document_candidates"), /permission denied/);
        await assert.rejects(db.query("select * from public.pa_portal_candidate_audit"), /permission denied/);
        await db.exec("reset role");
        await db.exec(candidateMigration);
        await db.exec(remediationMigration);
        await db.exec(variantMigration);
        assert.equal(Number((await db.query("select count(*) n from public.pa_portal_document_candidates")).rows[0].n), 9, "migration replay must be additive and idempotent");
        console.log("PA portal candidate validation: PASS (detection, classification, idempotency, exclusions, atomic review, no auto-current, canonical Gmail refs, RLS/crossover)");
    } finally { await db.close(); }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
