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

    let fixture;
    try {
        fixture = await createFixture();
        await fixture.db.exec(read('20260913110000_pa_case_management_v5.sql') + '\n' + read('20260913130000_pa_case_management_v5_r1.sql') + '\n' + read('20260913190000_pa_estimate_recovery_ux.sql') + '\n' + read('20260914100000_pa_est_005a_confirmation_snapshot_compat.sql'));
        process.env.PA_COMMERCIAL_OUTBOX_KEY = '77'.repeat(32);
        process.env.PA_PUBLIC_ORIGIN = 'https://example.invalid';
        let transportCalls = 0;
        const service = createService({ fetchImpl: fixture.fetchImpl, sendTransport: async (job) => { transportCalls += 1; return { gmail_message_id: `fake-${job.id}`, gmail_thread_id: 'thread_123' }; } });
        const actor = { id: fixture.actorId };
        const estimate = await service.issueEstimate({
            case_id: fixture.inquiryId, expected_revision: 0, expected_current: null, operation_id: crypto.randomUUID(),
            document_id: crypto.randomUUID(), filename: '見積書 2026.09.11 龍姫湖まつり（改訂）.pdf',
            content_base64: fixture.quote.toString('base64'), sha256: sha(fixture.quote), amount_minor: 198550,
            currency: 'JPY', tax_basis: 'tax_included', conditions: { source: 'pa-est-009' }, source_kind: 'managed_send',
            source_sent_at: '2026-09-11T03:54:00Z', body: '見積書を送付します。', cc_addresses: []
        }, actor);
        await service.dispatch({ job_id: estimate.outbox_id }, actor);
        assert.equal(transportCalls, 1);

        const preview = await service.confirmationPreview({ case_id: fixture.inquiryId }, actor);
        const issued = await service.issueConfirmation({ case_id: fixture.inquiryId, preview_fingerprint: preview.fingerprint, operation_id: crypto.randomUUID() }, actor);
        assert.equal(issued.version, 1);
        assert.equal(transportCalls, 1, 'issuing a confirmation must not dispatch Gmail');

        const sendPreview = await service.confirmationSendPreview({ case_id: fixture.inquiryId, offer_id: issued.id }, actor);
        assert.equal(sendPreview.confirmation_version, 1);
        assert.equal(sendPreview.customer_url_ready, true);
        assert.equal(sendPreview.recipient.to, 'customer@example.invalid');
        assert.equal(sendPreview.estimate.revision_number, 1);
        assert.equal(sendPreview.estimate.amount_minor, 198550);
        assert.equal(sendPreview.estimate.sha256, sha(fixture.quote));
        const receipt = await service.confirmationSendReceiptPreview({ case_id: fixture.inquiryId, offer_id: issued.id, preview_fingerprint: sendPreview.fingerprint }, actor);
        assert(receipt.bytes.length > fixture.quote.length);

        assert.equal(fixture.state.sendCount, 0, 'issue and issued preview must not call Gmail');
        process.env.PA_MAIL_ADAPTER = 'gmail';
        const adapterService = createService({ fetchImpl: fixture.fetchImpl });
        const delivery = await adapterService.dispatch({ job_id: issued.outbox_id }, actor);
        assert.equal(delivery.state, 'sent');
        assert.equal(fixture.state.sendCount, 1, 'explicit dispatch sends exactly once with a fresh preview authorization');

        await service.revoke({ case_id: fixture.inquiryId, offer_id: issued.id, operation_id: crypto.randomUUID(), reason: '配送失敗した旧確認を終了' }, actor);
        const afterRevoke = await service.snapshot(fixture.inquiryId);
        assert.equal(afterRevoke.offers.find((item) => item.id === issued.id).state, 'revoked');
        assert.equal(afterRevoke.outbox.find((item) => item.id === issued.outbox_id).state, 'sent');
        assert.equal(afterRevoke.offers.filter((item) => item.state === 'accepted').length, 0);

        const secondPreview = await service.confirmationPreview({ case_id: fixture.inquiryId }, actor);
        await assert.rejects(
            service.issueConfirmation({ case_id: fixture.inquiryId, preview_fingerprint: secondPreview.fingerprint, operation_id: crypto.randomUUID() }, actor),
            /service_unavailable/u,
            'the current schema must fail closed instead of silently bypassing the same-estimate unique index'
        );
        const index = await fixture.db.query("select indexdef from pg_indexes where schemaname='public' and indexname='pa_contract_offers_one_active_estimate'");
        assert.match(index.rows[0].indexdef, /WHERE \(estimate_revision_id IS NOT NULL\)/u);

        const admin = fs.readFileSync(path.join(root, 'js', 'pa-commercial-admin.js'), 'utf8');
        const adminShell = fs.readFileSync(path.join(root, 'js', 'pa-admin.js'), 'utf8');
        assert.match(admin, /正式受注確認を発行する（送信しない）/u);
        assert.match(admin, /activeDelivery\?\.state === "queued"/u);
        assert.match(admin, /confirmation_send_preview/u);
        assert.doesNotMatch(admin, /issue_confirmation"[^\n]+dispatch_outbox/u);
        assert.match(adminShell, /caseResult\.error \|\| trashResult\.error \|\| progressResult\.error[\s\S]+PA案件一覧を読み込めませんでした/u);
        assert.doesNotMatch(adminShell, /if \(error \|\| !item\) \{\s*setMessage\(listStatus/u);
        console.log(JSON.stringify({ pass: true, stale_archive_reference: 'cleared', two_stage_issue: 'active_queued_without_gmail', explicit_fake_dispatch: 1, same_estimate_reissue: 'BLOCKED_BY_UNIQUE_INDEX', gmail_sent_by_issue: 0, contract_count: 0 }));
    } finally {
        if (fixture) await fixture.db.close();
    }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
