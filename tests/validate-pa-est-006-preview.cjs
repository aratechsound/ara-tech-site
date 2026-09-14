const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { PDFArray, PDFDocument, decodePDFRawStream } = require('pdf-lib');
const { createFixture } = require('./helpers/pa-contract-fixture.cjs');
const { read } = require('./helpers/pa-estimate-fixture.cjs');
const { createService } = require('../api/_pa-commercial.cjs');
const { issuanceTermsV4 } = require('../api/_pa-contract-terms.cjs');
const { sha } = require('../api/_pa-contract-pdf.cjs');

Object.assign(process.env, {
    ALLOWED_ORIGINS: 'http://127.0.0.1:8766',
    PA_COMMERCIAL_OUTBOX_KEY: '66'.repeat(32),
    PA_PUBLIC_ORIGIN: 'https://ara-tech.cc'
});

async function counts(db, inquiryId) {
    const one = async (sql, values = []) => Number((await db.query(sql, values)).rows[0].n);
    return {
        offers: await one('select count(*) n from public.pa_contract_offers where inquiry_id=$1', [inquiryId]),
        tokens: await one('select count(*) n from public.pa_contract_tokens t join public.pa_contract_offers o on o.id=t.offer_id where o.inquiry_id=$1', [inquiryId]),
        contracts: await one('select count(*) n from public.pa_contracts where inquiry_id=$1', [inquiryId]),
        outbox: await one('select count(*) n from public.pa_commercial_outbox where inquiry_id=$1', [inquiryId]),
        issueAudit: await one("select count(*) n from public.pa_inquiry_audit where inquiry_id=$1 and action='formal_contract_issued'", [inquiryId]),
        revision: await one('select revision n from public.pa_case_commercial_state where inquiry_id=$1', [inquiryId])
    };
}

async function main() {
    const fixture = await createFixture();
    try {
        await fixture.db.exec(read('20260913110000_pa_case_management_v5.sql') + '\n' + read('20260913130000_pa_case_management_v5_r1.sql') + '\n' + read('20260913190000_pa_estimate_recovery_ux.sql') + '\n' + read('20260914100000_pa_est_005a_confirmation_snapshot_compat.sql'));
        let termsMutation = '';
        const service = createService({
            fetchImpl: fixture.fetchImpl,
            termsForIssue: (date) => ({ ...issuanceTermsV4(date), payment_consult_terms: issuanceTermsV4(date).payment_consult_terms + termsMutation }),
            sendTransport: async (job) => ({ gmail_message_id: `fake-${job.id}`, gmail_thread_id: 'thread_123' })
        });
        const actor = { id: fixture.actorId };
        const estimate = await service.issueEstimate({
            case_id: fixture.inquiryId, expected_revision: 0, expected_current: null,
            operation_id: crypto.randomUUID(), document_id: crypto.randomUUID(), filename: '正式見積原本.pdf',
            content_base64: fixture.quote.toString('base64'), sha256: sha(fixture.quote), amount_minor: 110000,
            currency: 'JPY', tax_basis: 'tax_included', conditions: { source: 'PA-EST-006 fixture' },
            source_kind: 'managed_send', source_sent_at: null, body: '見積原本を送付します。', cc_addresses: ['venue@example.invalid']
        }, actor);
        await service.dispatch({ job_id: estimate.outbox_id }, actor);

        const before = await counts(fixture.db, fixture.inquiryId);
        const previews = [];
        for (let index = 0; index < 5; index += 1) previews.push(await service.confirmationPreview({ case_id: fixture.inquiryId }, actor));
        assert(previews.every((item) => item.fingerprint === previews[0].fingerprint));
        assert(previews.every((item) => !JSON.stringify(item).includes('confirmation_token')));
        assert(previews.every((item) => !JSON.stringify(item).includes('secret_url')));
        assert.equal(previews[0].email.html.includes('発行時に正式URLが入ります'), true);
        assert.equal(previews[0].email.body.includes('発行時に正式URLが入ります'), true);
        assert.equal(previews[0].versions.customer, 'PA-CUSTOMER-WEB-V3.2');
        assert.equal(previews[0].versions.receipt, 'PA-RECEIPT-V4.1');
        assert.equal(previews[0].estimate.sha256, sha(fixture.quote));
        const receipt = await service.confirmationReceiptPreview({ case_id: fixture.inquiryId, preview_fingerprint: previews[0].fingerprint }, actor);
        const merged = await PDFDocument.load(receipt.bytes), source = await PDFDocument.load(fixture.quote);
        assert.equal(merged.getPageCount(), 2 + source.getPageCount());
        const streamBytes = (document, page) => { const raw = page.node.Contents(), values = raw instanceof PDFArray ? raw.asArray() : [raw]; return values.map((reference) => Buffer.from(decodePDFRawStream(document.context.lookup(reference)).decode()).toString('hex')).join(':'); };
        assert.equal(streamBytes(merged, merged.getPages()[2]), streamBytes(source, source.getPages()[0]), 'Page 3 preserves the exact current-estimate content stream');
        assert.deepEqual(merged.getPages()[2].getSize(), source.getPages()[0].getSize(), 'Page 3 preserves the current-estimate page dimensions');
        if (process.env.PA_EST_006_RECEIPT_OUTPUT) { fs.mkdirSync(path.dirname(process.env.PA_EST_006_RECEIPT_OUTPUT), { recursive: true }); fs.writeFileSync(process.env.PA_EST_006_RECEIPT_OUTPUT, receipt.bytes); }
        assert.equal(await counts(fixture.db, fixture.inquiryId).then((value) => JSON.stringify(value)), JSON.stringify(before));

        async function stale(label, mutate, restore) {
            const preview = await service.confirmationPreview({ case_id: fixture.inquiryId }, actor);
            await mutate();
            await assert.rejects(service.issueConfirmation({ case_id: fixture.inquiryId, preview_fingerprint: preview.fingerprint, operation_id: crypto.randomUUID() }, actor), /stale_confirmation_preview/, label);
            await restore();
        }
        const updateImmutable = async (table, sql, values) => {
            await fixture.db.exec(`alter table public.${table} disable trigger user`);
            try { await fixture.db.query(sql, values); }
            finally { await fixture.db.exec(`alter table public.${table} enable trigger user`); }
        };
        const estimateRow = (await fixture.db.query('select * from public.pa_estimate_revisions where id=$1', [estimate.id])).rows[0];
        await stale('estimate revision', () => updateImmutable('pa_estimate_revisions', 'update public.pa_estimate_revisions set revision_number=revision_number+1 where id=$1', [estimate.id]), () => updateImmutable('pa_estimate_revisions', 'update public.pa_estimate_revisions set revision_number=$2 where id=$1', [estimate.id, estimateRow.revision_number]));
        await stale('amount', () => updateImmutable('pa_estimate_revisions', 'update public.pa_estimate_revisions set amount_minor=amount_minor+1 where id=$1', [estimate.id]), () => updateImmutable('pa_estimate_revisions', 'update public.pa_estimate_revisions set amount_minor=$2 where id=$1', [estimate.id, estimateRow.amount_minor]));
        await stale('event time', () => fixture.db.query("update public.pa_inquiries set event_time='11:00〜16:00' where id=$1", [fixture.inquiryId]), () => fixture.db.query("update public.pa_inquiries set event_time='10:00〜15:00' where id=$1", [fixture.inquiryId]));
        await stale('recipient', () => fixture.db.query("update public.pa_inquiries set email='CUSTOMER@example.invalid' where id=$1", [fixture.inquiryId]), () => fixture.db.query("update public.pa_inquiries set email='customer@example.invalid' where id=$1", [fixture.inquiryId]));
        await stale('terms', async () => { termsMutation = '（変更）'; }, async () => { termsMutation = ''; });
        const document = (await fixture.db.query('select content,sha256 from public.pa_commercial_documents where id=$1', [estimateRow.document_id])).rows[0];
        const changedPdf = await PDFDocument.create(); changedPdf.addPage([595, 842]); const changedBytes = Buffer.from(await changedPdf.save());
        await stale('PDF SHA', () => updateImmutable('pa_commercial_documents', 'update public.pa_commercial_documents set content=$2,sha256=$3 where id=$1', [estimateRow.document_id, changedBytes, sha(changedBytes)]), () => updateImmutable('pa_commercial_documents', 'update public.pa_commercial_documents set content=$2,sha256=$3 where id=$1', [estimateRow.document_id, document.content, document.sha256]));
        assert.deepEqual(await counts(fixture.db, fixture.inquiryId), before, 'preview and stale rejects never mutate commercial state');

        const current = await service.confirmationPreview({ case_id: fixture.inquiryId }, actor);
        const operationId = crypto.randomUUID();
        const [first, second] = await Promise.all([
            service.issueConfirmation({ case_id: fixture.inquiryId, preview_fingerprint: current.fingerprint, operation_id: operationId }, actor),
            service.issueConfirmation({ case_id: fixture.inquiryId, preview_fingerprint: current.fingerprint, operation_id: operationId }, actor)
        ]);
        assert.equal(first.id, second.id);
        const after = await counts(fixture.db, fixture.inquiryId);
        assert.equal(after.offers, 1); assert.equal(after.tokens, 1); assert.equal(after.issueAudit, 1);
        assert.equal(after.outbox, before.outbox + 1);
        console.log('PASS PA-EST-006 pre-issue preview: 5x read-only, no token/secret, same customer/email/receipt generators, 6 stale fingerprints rejected, unchanged issue and double-click converge to one offer/token/audit/outbox');
    } finally { await fixture.db.close(); }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
