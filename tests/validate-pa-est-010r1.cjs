const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createFixture } = require('./helpers/pa-contract-fixture.cjs');
const { read } = require('./helpers/pa-estimate-fixture.cjs');
const { createService } = require('../api/_pa-commercial.cjs');
const { sha } = require('../api/_pa-contract-pdf.cjs');

async function main() {
    const root = path.resolve(__dirname, '..');
    const selection = await import(pathToFileURL(path.join(root, 'js', 'pa-admin-selection.mjs')));
    const active = 'cae57d4c-0b19-4fc0-b1d9-b7bb75284ce3';
    const archived = '21073084-a71f-4892-b97d-7717aeda0672';
    assert.deepEqual(selection.resolveRequestedCase({ requestedCaseId: archived, activeCaseIds: [active], archivedCaseIds: [archived] }), { state: 'archived', id: archived });
    assert.deepEqual(selection.resolveRequestedCase({ requestedCaseId: active, activeCaseIds: [active], archivedCaseIds: [archived] }), { state: 'active', id: active });
    assert.equal(new URL(selection.withoutRequestedCase(`https://ara-tech.cc/pa-admin.html?case=${archived}`)).searchParams.has('case'), false);

    let legacyFixture;
    try {
        legacyFixture = await createFixture();
        await legacyFixture.db.exec(read('20260913110000_pa_case_management_v5.sql') + '\n'
            + read('20260913130000_pa_case_management_v5_r1.sql') + '\n'
            + read('20260913190000_pa_estimate_recovery_ux.sql') + '\n'
            + read('20260914100000_pa_est_005a_confirmation_snapshot_compat.sql'));
        process.env.PA_COMMERCIAL_OUTBOX_KEY = '77'.repeat(32);
        process.env.PA_PUBLIC_ORIGIN = 'https://example.invalid';
        const legacyService = createService({ fetchImpl: legacyFixture.fetchImpl,
            sendTransport: async (job) => ({ gmail_message_id: `fake-${job.id}`, gmail_thread_id: 'thread_123' }) });
        const legacyActor = { id: legacyFixture.actorId };
        const legacyEstimate = await legacyService.issueEstimate({
            case_id: legacyFixture.inquiryId, expected_revision: 0, expected_current: null,
            operation_id: crypto.randomUUID(), document_id: crypto.randomUUID(), filename: 'same-estimate.pdf',
            content_base64: legacyFixture.quote.toString('base64'), sha256: sha(legacyFixture.quote), amount_minor: 198550,
            currency: 'JPY', tax_basis: 'tax_included', conditions: {}, source_kind: 'managed_send',
            source_sent_at: '2026-09-11T03:54:00Z', body: '見積書を送付します。', cc_addresses: []
        }, legacyActor);
        await legacyService.dispatch({ job_id: legacyEstimate.outbox_id }, legacyActor);
        const legacyPreview = await legacyService.confirmationPreview({ case_id: legacyFixture.inquiryId }, legacyActor);
        const legacyOffer = await legacyService.issueConfirmation({ case_id: legacyFixture.inquiryId,
            preview_fingerprint: legacyPreview.fingerprint, operation_id: crypto.randomUUID() }, legacyActor);
        await legacyService.revoke({ case_id: legacyFixture.inquiryId, offer_id: legacyOffer.id,
            operation_id: crypto.randomUUID(), reason: 'pre-migration same estimate proof' }, legacyActor);
        const blockedPreview = await legacyService.confirmationPreview({ case_id: legacyFixture.inquiryId }, legacyActor);
        await assert.rejects(legacyService.issueConfirmation({ case_id: legacyFixture.inquiryId,
            preview_fingerprint: blockedPreview.fingerprint, operation_id: crypto.randomUUID() }, legacyActor),
        /service_unavailable/u, 'pre-migration all-history index must reproduce same-estimate reissue failure');
    } finally {
        if (legacyFixture) await legacyFixture.db.close();
    }

    let fixture;
    try {
        fixture = await createFixture();
        const r7 = read('20260914213000_pa_est_007r3_delivery_recovery.sql');
        const r7Cut = r7.search(/\r?\ndo \$\$\r?\ndeclare\r?\n  c_case constant/u);
        assert(r7Cut > 0);
        await fixture.db.exec(read('20260913110000_pa_case_management_v5.sql') + '\n'
            + read('20260913130000_pa_case_management_v5_r1.sql') + '\n'
            + read('20260913190000_pa_estimate_recovery_ux.sql') + '\n'
            + read('20260914100000_pa_est_005a_confirmation_snapshot_compat.sql') + '\n'
            + read('20260914170000_pa_est_007r1_production_e2e.sql') + '\n'
            + r7.slice(0, r7Cut) + '\ncommit;\n'
            + read('20260915093000_pa_est_010r1_safe_confirmation_reissue.sql'));
        process.env.PA_COMMERCIAL_OUTBOX_KEY = '77'.repeat(32);
        process.env.PA_PUBLIC_ORIGIN = 'https://example.invalid';
        let transportCalls = 0;
        const service = createService({ fetchImpl: fixture.fetchImpl, sendTransport: async (job) => { transportCalls += 1; return { gmail_message_id: `fake-${job.id}`, gmail_thread_id: 'thread_123' }; } });
        const actor = { id: fixture.actorId };
        const estimate = await service.issueEstimate({
            case_id: fixture.inquiryId, expected_revision: 0, expected_current: null, operation_id: crypto.randomUUID(),
            document_id: crypto.randomUUID(), filename: '見積書 2026.09.11 龍姫湖まつり（改訂）.pdf',
            content_base64: fixture.quote.toString('base64'), sha256: sha(fixture.quote), amount_minor: 198550,
            currency: 'JPY', tax_basis: 'tax_included', conditions: { source: 'pa-est-010r1' }, source_kind: 'managed_send',
            source_sent_at: '2026-09-11T03:54:00Z', body: '見積書を送付します。', cc_addresses: []
        }, actor);
        await service.dispatch({ job_id: estimate.outbox_id }, actor);
        assert.equal(transportCalls, 1);

        const preview = await service.confirmationPreview({ case_id: fixture.inquiryId }, actor);
        const issued = await service.issueConfirmation({ case_id: fixture.inquiryId, preview_fingerprint: preview.fingerprint, operation_id: crypto.randomUUID() }, actor);
        assert.equal(issued.version, 1);
        assert.equal(transportCalls, 1, 'issuing a confirmation must not dispatch Gmail');

        await assert.rejects(fixture.db.query('select public.pa_v5_outbox_claim($1,$2,$3)',
            [fixture.actorId, issued.outbox_id, crypto.randomUUID()]), /confirmation_send_owner_approval_required/u);
        assert.equal(transportCalls, 1, 'worker cannot claim a confirmation before Owner approval');

        await fixture.db.query("update public.pa_commercial_outbox set state='unknown' where id=$1", [issued.outbox_id]);
        const replacementPreview = await service.confirmationPreview({ case_id: fixture.inquiryId, replace_offer_id: issued.id }, actor);
        assert.equal(replacementPreview.preview_kind, 'replacement_not_sent');
        assert.equal(replacementPreview.replacement_offer_id, issued.id);
        const replaceOperation = crypto.randomUUID();
        const replacement = await service.replaceConfirmation({
            case_id: fixture.inquiryId, old_offer_id: issued.id, expected_old_version: 1,
            preview_fingerprint: replacementPreview.fingerprint, operation_id: replaceOperation,
            reason: 'Owner判断による旧確認終了・同一見積で再発行'
        }, actor);
        assert.equal(replacement.version, 2);
        assert.equal(transportCalls, 1, 'atomic replacement prepares but does not send');
        const replay = await service.replaceConfirmation({
            case_id: fixture.inquiryId, old_offer_id: issued.id, expected_old_version: 1,
            preview_fingerprint: replacementPreview.fingerprint, operation_id: replaceOperation,
            reason: 'Owner判断による旧確認終了・同一見積で再発行'
        }, actor);
        assert.equal(replay.id, replacement.id); assert.equal(replay.already_committed, true);
        const afterReplace = await service.snapshot(fixture.inquiryId);
        assert.equal(afterReplace.offers.find((item) => item.id === issued.id).state, 'revoked');
        assert.equal(afterReplace.outbox.find((item) => item.id === issued.outbox_id).state, 'unknown');
        assert.equal(afterReplace.offers.find((item) => item.id === replacement.id).state, 'active');
        assert.equal(afterReplace.offers.filter((item) => item.state === 'active').length, 1);
        assert.equal(afterReplace.offers.length, 2);
        assert.equal(afterReplace.offers.every((item) => item.estimate_revision_id === estimate.id), true);

        const sendPreview = await service.confirmationSendPreview({ case_id: fixture.inquiryId, offer_id: replacement.id }, actor);
        assert.equal(sendPreview.confirmation_version, 2);
        assert.equal(sendPreview.customer_url_ready, true);
        assert.equal(sendPreview.recipient.to, 'customer@example.invalid');
        assert.equal(sendPreview.estimate.amount_minor, 198550);
        assert.equal(sendPreview.estimate.sha256, sha(fixture.quote));
        const receipt = await service.confirmationSendReceiptPreview({ case_id: fixture.inquiryId, offer_id: replacement.id, preview_fingerprint: sendPreview.fingerprint }, actor);
        assert(receipt.bytes.length > fixture.quote.length);

        await fixture.db.query('select public.pa_v5_authorize_confirmation_send($1,$2,$3,$4,$5)',
            [fixture.actorId, fixture.inquiryId, replacement.id, replacement.outbox_id, sendPreview.fingerprint]);
        await fixture.db.exec(`begin; select set_config('ara_tech.pa_confirmation_authorize_job','${replacement.outbox_id}',true);
            update public.pa_commercial_outbox set confirmation_send_authorized_at=now()-interval '11 minutes' where id='${replacement.outbox_id}'; commit;`);
        await assert.rejects(fixture.db.query('select public.pa_v5_outbox_claim($1,$2,$3)',
            [fixture.actorId, replacement.outbox_id, crypto.randomUUID()]), /confirmation_send_owner_approval_required/u);
        assert.equal(transportCalls, 1, 'expired internal send authority remains rejected');

        const delivery = await service.dispatch({ case_id: fixture.inquiryId, offer_id: replacement.id,
            job_id: replacement.outbox_id, preview_fingerprint: sendPreview.fingerprint }, actor);
        assert.equal(delivery.state, 'sent');
        assert.equal(transportCalls, 2, 'fresh Owner confirmation authorizes exactly one fake-provider claim');
        const duplicate = await service.dispatch({ job_id: replacement.outbox_id }, actor);
        assert.equal(duplicate.state, 'sent'); assert.equal(duplicate.already_committed, true);
        assert.equal(transportCalls, 2, 'double operation does not send twice');
        assert.equal(fixture.state.sendCount, 0, 'real Gmail adapter was never invoked');

        const oldIndex = await fixture.db.query("select count(*)::int n from pg_indexes where schemaname='public' and indexname='pa_contract_offers_one_active_estimate'");
        assert.equal(oldIndex.rows[0].n, 0);
        const replacementIndex = await fixture.db.query("select indexdef from pg_indexes where schemaname='public' and indexname='pa_contract_offers_estimate_history'");
        assert.match(replacementIndex.rows[0].indexdef, /estimate_revision_id, version/u);
        await fixture.db.exec('set role service_role');
        await assert.rejects(fixture.db.query('insert into public.pa_contract_tokens(offer_id,token_hash) values($1,$2)', [replacement.id, 'f'.repeat(64)]), /permission denied/u);
        await fixture.db.exec('reset role');
        assert.equal(Number((await fixture.db.query('select count(*) n from public.pa_contracts where inquiry_id=$1', [fixture.inquiryId])).rows[0].n), 0);

        const admin = fs.readFileSync(path.join(root, 'js', 'pa-commercial-admin.js'), 'utf8');
        const adminShell = fs.readFileSync(path.join(root, 'js', 'pa-admin.js'), 'utf8');
        assert.match(admin, /正式受注確認を発行する（送信しない）/u);
        assert.match(admin, /activeDelivery\?\.state === "queued"/u);
        assert.match(admin, /confirmation_send_preview/u);
        assert.match(admin, /この確認を失効して再発行準備/u);
        assert.match(admin, /replace_confirmation/u);
        assert.match(admin, /preview_fingerprint: model\.fingerprint/u);
        assert.doesNotMatch(admin, /issue_confirmation"[^\n]+dispatch_outbox/u);
        assert.match(adminShell, /caseResult\.error \|\| trashResult\.error \|\| progressResult\.error[\s\S]+PA案件一覧を読み込めませんでした/u);
        assert.doesNotMatch(adminShell, /if \(error \|\| !item\) \{\s*setMessage\(listStatus/u);
        console.log(JSON.stringify({ pass: true, stale_archive_reference: 'cleared',
            atomic_same_estimate_reissue: 'PASS', old_delivery_evidence: 'unknown_preserved',
            old_token: 'revoked', new_token: 'active', prepared_without_send: true,
            expired_authority_rejected: true, fresh_owner_authority_fake_dispatch: 1,
            duplicate_dispatch_provider_calls: 0, gmail_adapter_calls: 0, contract_count: 0 }));
    } finally {
        if (fixture) await fixture.db.close();
    }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
