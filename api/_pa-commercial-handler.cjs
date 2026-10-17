const { createService, SAFE } = require('./_pa-commercial.cjs');
const { verifyAdmin } = require('./_pa-mail.cjs');
const { streamAttachmentResponse } = require('./_pa-gmail.cjs');
const { applyOriginPolicy, checkRateLimit } = require('./_request-security.cjs');

const ACTIONS = new Set([
  'sent_quote_preview','sent_quote_adopt','sent_quote_status',
  'reply_document_list','reply_document_verify','reply_document_review','reply_document_adopt',
  'quote_monitor_list','quote_monitor_status','quote_monitor_check','quote_monitor_decision','quote_monitor_document','quote_monitor_history',
  'change_evidence_contract_pdf','change_evidence_candidates','change_evidence_preview','change_evidence_append','change_evidence_document','change_evidence_mail_pdf',
  'issue_direct_confirmation_and_send',
  'original_index', 'snapshot', 'document', 'confirmation_preview', 'confirmation_receipt_preview', 'confirmation_send_preview', 'confirmation_send_receipt_preview', 'begin_revision', 'issue_estimate', 'issue_confirmation', 'replace_confirmation', 'revoke_confirmation',
  'confirm_settlement', 'create_billing', 'record_payment', 'record_prepayment', 'adjust_payment',
  'close_case', 'reopen_case', 'dispatch_outbox', 'recovery_candidates', 'recovery_preview', 'recover_estimate',
  'correct_estimate', 'remind_confirmation', 'create_change_proposal', 'record_change_agreement', 'composer_preview', 'estimate_send_preview',
  'create_production_e2e_clone', 'arm_production_e2e_failpoint', 'reconcile_production_e2e_unknown',
  'production_e2e_recovery_preview', 'recover_production_e2e_delivery', 'archive_production_e2e_case'
]);

function createHandler({ service = createService(), admin = verifyAdmin, rate = checkRateLimit } = {}) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const json = (status, data) => res.status(status).json(data);
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return json(405, { ok: false, code: 'method_not_allowed' });
    }
    if (!applyOriginPolicy(req, res)) return json(403, { ok: false, code: 'invalid_origin' });
    try {
      const input = typeof req.body === 'object' && !Buffer.isBuffer(req.body) ? req.body : JSON.parse(String(req.body || ''));
      if (!input || Array.isArray(input) || !ACTIONS.has(input.action) || Buffer.byteLength(JSON.stringify(input)) > 8_000_000) {
        throw Error('invalid_commercial_request');
      }
      const bearer = String(req.headers?.authorization || '').match(/^Bearer (\S+)$/u)?.[1];
      const actor = await admin(bearer);
      const limit = await rate({ request: req, policyName: 'PA_COMMERCIAL_ADMIN', scope: actor.id });
      if (!limit.allowed) {
        res.setHeader('Retry-After', String(limit.retryAfter || 60));
        return json(429, { ok: false, code: 'rate_limited' });
      }
      let result;
      switch (input.action) {
        case 'sent_quote_preview': result = await service.sentQuotePreview(input, actor); break;
        case 'sent_quote_adopt': result = await service.sentQuoteAdopt(input, actor); break;
        case 'sent_quote_status': result = await service.sentQuoteStatus(input, actor); break;
        case 'reply_document_list': result = await service.replyDocumentList(input, actor); break;
        case 'reply_document_verify': result = await service.replyDocumentVerify(input, actor); break;
        case 'reply_document_review': result = await service.replyDocumentReview(input, actor); break;
        case 'reply_document_adopt': result = await service.replyDocumentAdopt(input, actor); break;
        case 'quote_monitor_list': result = await service.quoteMonitorList(input, actor); break;
        case 'quote_monitor_status': result = await service.quoteMonitorStatus(input, actor); break;
        case 'quote_monitor_history': result = await service.quoteMonitorHistory(input, actor); break;
        case 'quote_monitor_check': result = await service.quoteMonitorCheck(input, actor); break;
        case 'quote_monitor_decision': result = await service.quoteMonitorDecision(input, actor); break;
        case 'quote_monitor_document': return streamAttachmentResponse(res, await service.quoteMonitorDocument(input, actor));
        case 'change_evidence_contract_pdf': return streamAttachmentResponse(res, await service.changeEvidenceContractPdf(input, actor));
        case 'change_evidence_candidates': result = await service.changeEvidenceCandidates(input, actor); break;
        case 'change_evidence_preview': result = await service.changeEvidencePreview(input, actor); break;
        case 'change_evidence_append': result = await service.changeEvidenceAppend(input, actor); break;
        case 'change_evidence_document': return streamAttachmentResponse(res, await service.changeEvidenceDocument(input, actor));
        case 'change_evidence_mail_pdf': return streamAttachmentResponse(res, await service.changeEvidenceMailPdf(input, actor));
        case 'original_index': result = await service.originalIndex(input.case_id); break;
        case 'snapshot': result = await service.snapshot(input.case_id); break;
        case 'document': return streamAttachmentResponse(res, await service.document(input.case_id, input.document_id));
        case 'confirmation_preview': result = await service.confirmationPreview(input, actor); break;
        case 'confirmation_receipt_preview': return streamAttachmentResponse(res, await service.confirmationReceiptPreview(input, actor));
        case 'confirmation_send_preview': result = await service.confirmationSendPreview(input, actor); break;
        case 'confirmation_send_receipt_preview': return streamAttachmentResponse(res, await service.confirmationSendReceiptPreview(input, actor));
        case 'begin_revision': result = await service.beginRevision(input, actor); break;
        case 'issue_estimate': result = await service.issueEstimate(input, actor); break;
        case 'issue_confirmation': result = await service.issueConfirmation(input, actor); break;
        case 'issue_direct_confirmation_and_send': result = await service.issueDirectConfirmationAndSend(input, actor); break;
        case 'replace_confirmation': result = await service.replaceConfirmation(input, actor); break;
        case 'revoke_confirmation': result = await service.revoke(input, actor); break;
        case 'confirm_settlement': result = await service.settle(input, actor); break;
        case 'create_billing': result = await service.createBilling(input, actor); break;
        case 'record_payment': result = await service.recordPayment(input, actor); break;
        case 'record_prepayment': result = await service.recordPrepayment(input, actor); break;
        case 'adjust_payment': result = await service.adjustPayment(input, actor); break;
        case 'close_case': result = await service.close(input, actor); break;
        case 'reopen_case': result = await service.reopen(input, actor); break;
        case 'dispatch_outbox': result = await service.dispatch(input, actor); break;
        case 'recovery_candidates': result = await service.recoveryCandidates(input.case_id); break;
        case 'recovery_preview': result = await service.recoveryPreview(input); break;
        case 'recover_estimate': result = await service.recoverEstimate(input, actor); break;
        case 'correct_estimate': result = await service.correctEstimate(input, actor); break;
        case 'remind_confirmation': result = await service.remindConfirmation(input, actor); break;
        case 'create_change_proposal': result = await service.createChangeProposal(input, actor); break;
        case 'record_change_agreement': result = await service.recordChangeAgreement(input, actor); break;
        case 'composer_preview': result = await service.composerPreview(input, actor); break;
        case 'estimate_send_preview': result = await service.estimateSendPreview(input, actor); break;
        case 'create_production_e2e_clone': result = await service.createProductionE2eClone(input, actor); break;
        case 'arm_production_e2e_failpoint': result = await service.armProductionE2eFailpoint(input, actor); break;
        case 'reconcile_production_e2e_unknown': result = await service.reconcileProductionE2eUnknown(input, actor); break;
        case 'production_e2e_recovery_preview': result = await service.productionE2eRecoveryPreview(input, actor); break;
        case 'recover_production_e2e_delivery': result = await service.recoverProductionE2eDelivery(input, actor); break;
        case 'archive_production_e2e_case': result = await service.archiveProductionE2eCase(input, actor); break;
      }
      return json(200, { ok: true, result });
    } catch (error) {
      const code = String(error?.message || '');
      const allowed = SAFE.has(code);
      return json(code === 'not_authorized' ? 401 : code === 'stale_confirmation_preview' ? 409 : allowed ? 400 : 503, { ok: false, code: allowed ? code : 'service_unavailable' });
    }
  };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
