const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");
const candidateService = require("../api/_pa-portal-candidates.cjs");

const root = path.resolve(__dirname, "..");
const portalMigration = fs.readFileSync(path.join(root, "supabase", "migrations", "20260908143000_pa_portal_document_management.sql"), "utf8");
const candidateMigration = fs.readFileSync(path.join(root, "supabase", "migrations", "20260909060000_pa_portal_document_candidates.sql"), "utf8");
const remediationMigration = fs.readFileSync(path.join(root, "supabase", "migrations", "20260909093000_pa_portal_candidate_canonical_identity.sql"), "utf8");
const variantMigration = fs.readFileSync(path.join(root, "supabase", "migrations", "20260909110000_pa_portal_candidate_variant_reconcile.sql"), "utf8");
const actor = "10000000-0000-4000-8000-000000000011";
const outsider = "10000000-0000-4000-8000-000000000012";
const caseId = "20000000-0000-4000-8000-000000000011";

async function main() {
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
          insert into public.pa_inquiries values('${caseId}',null,'Canonical identity event','2026-10-18','Test venue');
          select set_config('request.jwt.claim.sub','${actor}',false);
        `);
        await db.exec(portalMigration);
        const portalId = (await db.query("select id from public.pa_portals where case_id=$1", [caseId])).rows[0].id;
        const registeredPhotoId = (await db.query("insert into public.pa_portal_photo_items(portal_id,source_type,source_key,source_ref,display_filename,mime_type,contributor_kind) values($1,'gmail_attachment','mail_variant:historical_opaque',$2::jsonb,'ステージ写真（参考）.JPG','image/jpeg','organizer') returning id", [portalId, JSON.stringify({ gmail_message_id: "mail_variant", gmail_attachment_id: "historical_opaque" })])).rows[0].id;
        const candidateAttachment = { id: "candidate_opaque", gmail_attachment_id: "candidate_opaque", part_id: "2.1", filename: "ステージ写真（参考）.JPG", mime_type: "image/jpeg", size: 8000, content_disposition: "attachment" };
        const currentAttachment = { ...candidateAttachment, id: "current_opaque", gmail_attachment_id: "current_opaque" };
        await db.query("insert into public.pa_gmail_thread_links(inquiry_id,gmail_thread_id) values($1,'thread_variant')", [caseId]);
        await db.query("insert into public.pa_gmail_message_index(gmail_message_id,gmail_thread_id,inquiry_id,message_source,direction,from_address,subject,received_at,attachment_metadata) values('mail_variant','thread_variant',$1,'gmail_received','inbound','organizer@example.test','音響・電源・会場資料',now(),$2::jsonb)", [caseId, JSON.stringify([candidateAttachment])]);
        await db.exec(candidateMigration);
        const candidateProposal = candidateService.buildProposals([{ id: "mail_variant", direction: "inbound", subject: "音響・電源・会場資料", attachments: [candidateAttachment] }], []).proposals[0];
        const legacyProposal = { ...candidateProposal, suggested_category: "layout", suggested_action: "create_new_card", suggested_title: "ステージ写真(参考)", confidence: "high", suggestion_basis: "legacy combined filename and subject rule" };
        delete legacyProposal.gmail_part_id;
        delete legacyProposal.canonical_attachment_key;
        await db.query("select public.pa_portal_candidate_detect($1,$2,$3::jsonb)", [caseId, actor, JSON.stringify([legacyProposal])]);
        const duplicateId = (await db.query("select id from public.pa_portal_document_candidates where gmail_attachment_id='candidate_opaque'")).rows[0].id;
        await db.query("update public.pa_gmail_message_index set attachment_metadata=$1::jsonb where gmail_message_id='mail_variant'", [JSON.stringify([currentAttachment])]);
        const proposal = candidateService.buildProposals([{ id: "mail_variant", direction: "inbound", subject: "音響・電源・会場資料", attachments: [currentAttachment] }], []).proposals[0];
        await db.query(`insert into public.pa_portal_document_candidates(portal_id,case_id,source_type,source_direction,gmail_message_id,gmail_attachment_id,display_filename,mime_type,suggested_category,suggested_action,suggested_title,confidence,suggestion_basis,status)
          values($1,$2,'gmail_attachment','inbound','accepted_mail','accepted_id','accepted.pdf','application/pdf','other','create_new_card','accepted','low','fixture','accepted'),
                ($1,$2,'gmail_attachment','inbound','ignored_mail','ignored_id','ignored.pdf','application/pdf','other','create_new_card','ignored','low','fixture','ignored'),
                ($1,$2,'gmail_attachment','inbound','unmatched_mail','unmatched_id','unmatched.pdf','application/pdf','other','create_new_card','unmatched','low','fixture','pending')`, [portalId, caseId]);
        const portalBefore = (await db.query("select count(*) versions,(select count(*) from public.pa_portal_photo_items) photos,(select count(*) from public.pa_portal_document_cards where current_version_id is not null) current_count from public.pa_portal_document_versions")).rows[0];
        await db.exec(remediationMigration);
        await db.exec(variantMigration);

        const initialMappings = await candidateService.buildIdentityMappings({
            caseId,
            proposals: [proposal],
            registered: [{ asset_kind: "photo", asset_id: registeredPhotoId, source_type: "gmail_attachment", source_ref: { gmail_message_id: "mail_variant", gmail_attachment_id: "historical_opaque" }, display_filename: "ステージ写真（参考）.JPG", mime_type: "image/jpeg", canonical_attachment_key: null }],
            attachmentVariantLoader: async ({ gmailAttachmentId }) => {
                if (!["historical_opaque", "current_opaque"].includes(gmailAttachmentId)) throw new Error("unexpected_fixture_reference");
                const bytes = Buffer.alloc(8000, 1);
                return { bytes, size: bytes.length };
            }
        });
        assert.equal(initialMappings.mappings.length, 1);
        const initialReconciliation = (await db.query("select public.pa_portal_candidate_reconcile($1,$2,$3::jsonb) result", [caseId, actor, JSON.stringify(initialMappings.mappings)])).rows[0].result;
        assert.equal(Number(initialReconciliation.reconciled), 0, "an unproved third candidate variant must remain pending");
        assert.equal((await db.query("select status from public.pa_portal_document_candidates where id=$1", [duplicateId])).rows[0].status, "pending");
        const registeredCanonical = (await db.query("select source_ref,gmail_part_id,canonical_attachment_key,source_content_sha256,source_byte_size from public.pa_portal_photo_items where id=$1", [registeredPhotoId])).rows[0];
        const mappings = await candidateService.buildIdentityMappings({
            caseId,
            proposals: [proposal],
            registered: [{ asset_kind: "photo", asset_id: registeredPhotoId, source_type: "gmail_attachment", source_ref: registeredCanonical.source_ref, display_filename: "ステージ写真（参考）.JPG", mime_type: "image/jpeg", ...registeredCanonical }],
            pendingCandidates: [{ id: duplicateId, status: "pending", gmail_message_id: "mail_variant", gmail_attachment_id: "candidate_opaque", display_filename: "ステージ写真（参考）.JPG", mime_type: "image/jpeg", canonical_attachment_key: null }],
            attachmentVariantLoader: async ({ gmailAttachmentId }) => {
                if (!["candidate_opaque", "current_opaque"].includes(gmailAttachmentId)) throw new Error("unexpected_fixture_reference");
                const bytes = Buffer.alloc(8000, 1);
                return { bytes, size: bytes.length };
            }
        });
        assert.equal(mappings.mappings[0].proof_type, "registered_canonical_identity");
        assert.deepEqual(mappings.mappings[0].candidate_matches.map((match) => [match.candidate_id, match.proof_type]), [[duplicateId, "same_message_content_sha256"]], "third attachment-ID variant must require an exact content-hash proof");
        const forgedMappings = structuredClone(mappings.mappings);
        forgedMappings[0].candidate_matches[0].content_sha256 = "0".repeat(64);
        await assert.rejects(db.query("select public.pa_portal_candidate_reconcile($1,$2,$3::jsonb)", [caseId, actor, JSON.stringify(forgedMappings)]), /identity_candidate_variant_mismatch/, "service input cannot reconcile a candidate variant without the exact hash proof");
        const reconciliation = (await db.query("select public.pa_portal_candidate_reconcile($1,$2,$3::jsonb) result", [caseId, actor, JSON.stringify(mappings.mappings)])).rows[0].result;
        assert.deepEqual([Number(reconciliation.reconciled), Number(reconciliation.suggestions_recalculated)], [1, 1]);
        const registeredAfter = (await db.query("select source_ref,gmail_part_id,canonical_attachment_key,source_content_sha256,source_byte_size from public.pa_portal_photo_items where id=$1", [registeredPhotoId])).rows[0];
        assert.deepEqual(registeredAfter.source_ref, { gmail_message_id: "mail_variant", gmail_attachment_id: "historical_opaque" }, "historical source_ref must remain byte-for-byte compatible");
        assert.equal(registeredAfter.gmail_part_id, "2.1");
        assert.equal(registeredAfter.canonical_attachment_key, candidateService.canonicalAssetKey("mail_variant", "2.1"));
        assert.match(registeredAfter.source_content_sha256, /^[a-f0-9]{64}$/u);
        assert.equal(Number(registeredAfter.source_byte_size), 8000);
        const duplicateAfter = (await db.query("select status,suggested_category,confidence,gmail_part_id,canonical_attachment_key from public.pa_portal_document_candidates where id=$1", [duplicateId])).rows[0];
        assert.deepEqual([duplicateAfter.status, duplicateAfter.suggested_category, duplicateAfter.confidence, duplicateAfter.gmail_part_id], ["dismissed", "photo", "medium", "2.1"]);
        assert.equal(duplicateAfter.canonical_attachment_key, registeredAfter.canonical_attachment_key);
        assert.deepEqual((await db.query("select status from public.pa_portal_document_candidates where gmail_attachment_id in ('accepted_id','ignored_id','unmatched_id') order by gmail_attachment_id")).rows.map((row) => row.status), ["accepted", "ignored", "pending"]);
        const auditActions = (await db.query("select action from public.pa_portal_candidate_system_audit where candidate_id=$1 order by action", [duplicateId])).rows.map((row) => row.action);
        assert.deepEqual(auditActions, ["RECONCILED_DUPLICATE_REGISTERED_ASSET", "SUGGESTION_RECALCULATED"]);
        assert.deepEqual((await db.query("select count(*) versions,(select count(*) from public.pa_portal_photo_items) photos,(select count(*) from public.pa_portal_document_cards where current_version_id is not null) current_count from public.pa_portal_document_versions")).rows[0], portalBefore, "reconciliation must not mutate formal portal assets or current pointers");

        const firstRepeat = (await db.query("select public.pa_portal_candidate_detect($1,$2,$3::jsonb) result", [caseId, actor, JSON.stringify([proposal])])).rows[0].result;
        const secondRepeat = (await db.query("select public.pa_portal_candidate_detect($1,$2,$3::jsonb) result", [caseId, actor, JSON.stringify([proposal])])).rows[0].result;
        assert.deepEqual([Number(firstRepeat.detected), Number(secondRepeat.detected)], [0, 0], "sync twice must not regenerate a reconciled duplicate");
        assert.equal(Number((await db.query("select count(*) n from public.pa_portal_document_candidates where gmail_message_id='mail_variant'")).rows[0].n), 1);
        assert.equal(Number((await db.query("select count(*) n from public.pa_portal_candidate_system_audit where candidate_id=$1", [duplicateId])).rows[0].n), 2, "repeat sync must not grow reconciliation audit");

        await assert.rejects(db.query("insert into public.pa_portal_document_versions(card_id,source_type,source_key,source_ref,display_filename,mime_type,contributor_kind) select c.id,'gmail_attachment','mail_variant:current_opaque',$1::jsonb,'ステージ写真（参考）.JPG','image/jpeg','organizer' from public.pa_portal_document_cards c where c.portal_id=$2 and c.category='timetable' limit 1", [JSON.stringify({ gmail_message_id: "mail_variant", gmail_attachment_id: "current_opaque" }), portalId]), /portal_source_already_used/, "canonical identity must block document/photo crossover duplicates");
        await db.exec("set role anon");
        await assert.rejects(db.query("select * from public.pa_portal_candidate_system_audit"), /permission denied/);
        await db.exec("reset role");
        await db.exec(remediationMigration);
        await db.exec(variantMigration);
        assert.equal(Number((await db.query("select count(*) n from public.pa_portal_candidate_system_audit")).rows[0].n), 2, "migration replay must be additive and audit append-only");
        console.log("PA portal candidate remediation validation: PASS (canonical identity, bounded hash proof, reconcile, classification calibration, idempotency, no formal mutation)");
    } finally {
        await db.close();
    }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
